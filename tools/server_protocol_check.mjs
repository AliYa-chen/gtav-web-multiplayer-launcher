import assert from 'node:assert/strict';

// Node's normal trust store verifies both HTTPS and WSS certificates.
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'TLS verification must remain enabled');
const [origin, expectedVersion, mode = 'full'] = process.argv.slice(2);
const url = new URL(origin);
assert.equal(url.protocol, 'https:');
assert.equal(url.username + url.password + url.search + url.hash, '');
const healthUrl = `${origin}/health`;
async function health() {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.server_version, expectedVersion);
  assert.equal(typeof value.players, 'number');
  assert.equal(typeof value.clients, 'number');
  assert.ok(Number.isInteger(value.players) && value.players >= 0);
  assert.ok(Number.isInteger(value.clients) && value.clients >= 0);
  return value;
}
const before = await health();
const report = { server_version: before.server_version, tls_verified: true,
  players: before.players, clients: before.clients };
if (mode === 'full') {
  const state = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace(/^https:/, 'wss:')}/ws`);
    const state = { chunks: 0, entities: new Set() };
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'leave_room' }));
      socket.close();
      if (error) reject(error); else resolve({ welcome: state.welcome, profile: state.profile,
        snapshot: state.snapshot, snapshot_chunks: state.chunks, snapshot_entities: state.entities.size,
        epoch: state.epoch, heartbeat: state.heartbeat, connection_cleaned: state.left });
    };
    const timer = setTimeout(() => finish(new Error('WSS snapshot/heartbeat deadline exceeded')), 20000);
    socket.addEventListener('error', () => finish(new Error('Certificate-verified WSS transport failed')));
    socket.addEventListener('close', () => { if (!settled) finish(new Error('WSS closed before snapshot/heartbeat')); });
    socket.addEventListener('message', event => {
      try {
        const value = JSON.parse(event.data);
        if (value.type === 'error') throw new Error('WSS server rejected protocol verification');
        if (value.type === 'welcome') {
          assert.equal(value.server_version, expectedVersion);
          state.welcome = true;
          socket.send(JSON.stringify({ type: 'hello', name: 'Release health check', capabilities: [
            'combat', 'actions', 'combat_feedback', 'weapon_rules', 'world_v2', 'entity_batch',
            'melee_events', 'world_environment', 'shared_law', 'server_ai', 'projectiles',
            'action_queue', 'session_policy', 'physics_queries'] }));
        } else if (value.type === 'profile') {
          assert.equal(typeof value.entity_id, 'string');
          assert.equal(typeof value.client_id, 'string');
          state.profile = true;
          state.playerEntity = value.entity_id;
          state.playerId = value.client_id;
        } else if (value.type === 'snapshot_begin') {
          assert.equal(state.snapshotId, undefined);
          assert.equal(value.schema_version, 2);
          assert.equal(typeof value.snapshot_id, 'string');
          assert.ok(Number.isSafeInteger(value.cut_revision) && value.cut_revision >= 0);
          assert.ok(Number.isSafeInteger(value.stream_seq) && value.stream_seq >= 0);
          state.epoch = value.world_epoch;
          state.snapshotId = value.snapshot_id;
          state.revision = value.cut_revision;
          state.stream = value.stream_seq;
        } else if (value.type === 'snapshot_chunk') {
          assert.equal(value.schema_version, 2);
          assert.equal(value.world_epoch, state.epoch);
          assert.equal(value.snapshot_id, state.snapshotId);
          assert.equal(value.cut_revision, state.revision);
          assert.equal(value.index, state.chunks++);
          assert.ok(Array.isArray(value.entities) && Array.isArray(value.tombstones));
          for (const entity of value.entities) {
            assert.equal(typeof entity.entity_id, 'string');
            assert.ok(!state.entities.has(entity.entity_id));
            state.entities.add(entity.entity_id);
          }
        }
        else if (value.type === 'snapshot_end') {
          assert.ok(Object.hasOwn(state, 'epoch'));
          assert.equal(value.schema_version, 2);
          assert.equal(value.world_epoch, state.epoch);
          assert.equal(value.snapshot_id, state.snapshotId);
          assert.equal(value.cut_revision, state.revision);
          assert.equal(value.stream_seq, state.stream);
          assert.ok(state.chunks > 0 && state.entities.has(state.playerEntity));
          state.snapshot = true;
          socket.send(JSON.stringify({ type: 'ping', nonce: 4242 }));
        } else if (value.type === 'pong') {
          assert.equal(value.nonce, 4242);
          assert.equal(state.welcome && state.profile && state.snapshot, true);
          state.heartbeat = true;
          socket.send(JSON.stringify({ type: 'leave_room' }));
        } else if (value.type === 'room_state' && state.heartbeat) {
          assert.ok(Array.isArray(value.room?.members));
          if (!value.room.members.some(member => member.id === state.playerId)) {
            state.left = true;
            finish();
          }
        }
      } catch (error) { finish(error); }
    });
  });
  Object.assign(report, state);
  // A room-state acknowledgement proves our identity left; unrelated joins
  // must not turn a successful verification into a false deployment failure.
  await health();
  assert.equal(report.connection_cleaned, true);
} else assert.equal(mode, 'health');
console.log(JSON.stringify(report));
