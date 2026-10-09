'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../client/multiplayer/world-collision.js'), 'utf8');
const segment = (from = [0, 0, 0], to = [20, 0, 0], radius = 0) => ({ from, to, radius });
const query = (changes = {}) => ({ type: 'collision_query', schema_version: 2, world_epoch: 'epoch',
  query_id: 'q1', observer_id: 'local', purpose: 'shot', issued_at: 10, expires_at: 1010,
  segments: [segment()], ...changes });
function harness() {
  const memory = { buffer: new SharedArrayBuffer(2048) }, messages = [], calls = [], pending = new Map();
  let next = 10, loaded = true;
  const data = () => new DataView(memory.buffer);
  const vector = pointer => [0, 8, 16].map(i => data().getFloat32(Number(pointer) + i, true));
  const ex = { mpAlloc: () => 128n, mpCollisionLoadedAroundEntity: () => loaded, mpWaitingForWorldCollision: () => false,
    mpGetEntityCoords: ptr => [0, 0, 0].forEach((n, i) => data().setFloat32(Number(ptr) + i * 8, n, true)),
    mpStartShapeTestLOS: (from, to, flags, ignored, option) => {
      calls.push({ type: 'ray', from: vector(from), to: vector(to), flags, ignored, option });
      pending.set(++next, { status: 1 }); return next;
    },
    mpStartShapeTestSweptSphere: (from, to, radius, flags, ignored, option) => {
      calls.push({ type: 'sphere', from: vector(from), to: vector(to), radius, flags, ignored, option });
      pending.set(++next, { status: 1 }); return next;
    },
    mpShapeTestResultMaterial: (handle, hit, pos, normal, material, entity) => {
      const value = pending.get(handle); assert.ok(value, 'consumed native handles are never reused');
      if (value.status !== 1) pending.delete(handle);
      if (value.status === 2) {
        data().setInt32(Number(hit), value.hit ? 1 : 0, true);
        if (value.hit) {
          [...(value.position || [10, 0, 0]), 123456].forEach((n, i) => data().setFloat32(Number(pos) + i * 4, n, true));
          [...(value.normal || [-1, 0, 0]), 123456].forEach((n, i) => data().setFloat32(Number(normal) + i * 4, n, true));
          data().setUint32(Number(material), 0xffffffff, true); data().setInt32(Number(entity), 1234, true);
        }
      }
      return value.status;
    } };
  const context = { self: {}, Map, Set, Number, Math, Array, DataView, Uint8Array, BigInt };
  vm.runInNewContext(source, context);
  const bridge = context.self.createWorldCollisionBridge({ ex, memory, post: m => messages.push(JSON.parse(JSON.stringify(m))) });
  const packet = { connected: true, client_id: 'local', world: { ready: true, world_epoch: 'epoch' }, collision_queries: [] };
  return { bridge, ex, packet, calls, messages, pending, loaded(value) { loaded = value; },
    tick(now = 0) { bridge.tick(packet, now, 1); }, submit(q = query()) { packet.collision_queries.push(q); },
    complete(value) { for (const handle of pending.keys()) pending.set(handle, value); } };
}
test('async queries use the verified scrVector/Vector3 layouts and return only collision facts', () => {
  const h = harness(); h.submit(query({ segments: [segment([1, 2, 3], [21, 2, 3], 0.02)] })); h.tick();
  assert.equal(h.messages.length, 0); assert.deepEqual(h.calls[0].from, [1, 2, 3]);
  assert.equal(h.calls[0].flags, 273); assert.equal(h.calls[0].type, 'sphere');
  h.tick(10); assert.equal(h.messages.length, 0);
  h.complete({ status: 2, hit: true }); h.tick(20); h.tick(30);
  assert.deepEqual(h.messages, [{ type: 'collision_result', schema_version: 2, world_epoch: 'epoch', query_id: 'q1',
    hits: [{ position: [10, 0, 0], normal: [-1, 0, 0], material: 0xffffffff }], complete: true }]);
  assert.equal(h.calls.length, 1);
});
test('a completed no-hit query is distinct from unavailable collision', () => {
  const h = harness(); h.submit(); h.tick(); h.complete({ status: 2, hit: false }); h.tick(10);
  assert.deepEqual(h.messages[0].hits, [null]); assert.equal(h.messages[0].complete, true);
  const unavailable = harness(); unavailable.loaded(false); unavailable.submit(); unavailable.tick();
  assert.equal(unavailable.calls.length, 0); assert.equal(unavailable.messages[0].complete, false);
});
test('wrong observer and world cannot cause a native query', () => {
  const h = harness(); h.submit(query({ observer_id: 'other' })); h.submit(query({ world_epoch: 'other' })); h.tick();
  assert.equal(h.calls.length, 0); assert.equal(h.messages.length, 0);
});
test('out of streaming range is rejected rather than treated as a clear ray', () => {
  const h = harness(); h.submit(query({ segments: [segment([0, 0, 0], [181, 0, 0])] })); h.tick();
  assert.equal(h.calls.length, 0); assert.equal(h.messages[0].complete, false);
  assert.equal(h.messages[0].reason, 'outside_streaming_range');
});
test('pending queries time out and native handles are still drained', () => {
  const h = harness(); h.submit(); h.tick(); h.tick(1001);
  assert.equal(h.messages[0].complete, false); assert.equal(h.messages[0].reason, 'query_timeout');
  h.complete({ status: 2, hit: true }); h.tick(1100); assert.equal(h.pending.size, 0); assert.equal(h.messages.length, 1);
});
test('new session drains old native handles without publishing old results', () => {
  const h = harness(); h.submit(); h.tick(); h.packet.connected = false;
  h.complete({ status: 2, hit: true }); h.tick(10);
  assert.equal(h.pending.size, 0); assert.equal(h.messages.length, 0);
});
test('per-frame and total native query budgets stay bounded', () => {
  const h = harness(); h.submit(query({ segments: Array.from({ length: 16 }, () => segment()) }));
  h.tick(); assert.equal(h.calls.length, 4); h.tick(1); assert.equal(h.calls.length, 8);
  h.tick(2); assert.equal(h.calls.length, 8);
});
test('native invalid status and invalid vectors fail closed', () => {
  for (const result of [{ status: 0 }, { status: 2, hit: true, normal: [0, 0, 0] },
    { status: 2, hit: true, position: [NaN, 0, 0] }]) {
    const h = harness(); h.submit(); h.tick(); h.complete(result); h.tick(10);
    assert.equal(h.messages[0].complete, false); assert.deepEqual(h.messages[0].hits, []);
  }
});
