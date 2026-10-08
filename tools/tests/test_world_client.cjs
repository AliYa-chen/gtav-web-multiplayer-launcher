#!/usr/bin/env node
'use strict';
// 世界快照、增量与所有权客户端回归：无引擎实例、无网络、无游戏资源。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = (name) => fs.readFileSync(path.join(root, 'client/multiplayer', name), 'utf8');
const dataUrl = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const modulePromise = import(dataUrl(read('world-state.js').replace("'./appearance.js'", JSON.stringify(dataUrl(read('appearance.js'))))));
const copy = (value) => JSON.parse(JSON.stringify(value));
const actions = { aiming: false, reloading: false, jumping: false, ducking: false, sprinting: false };
const transform = (x = 711.5) => ({ position: [x, -1088.1, 22.4], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angular_velocity: [0, 0, 0] });
const ped = (changes = {}) => ({ entity_id: 'w:epochA:1', kind: 'ped', player_id: 'LOCAL', model: 0x705e61f2,
  revision: 1, generation: 1, owner_id: 'LOCAL', owner_epoch: 1, lease_until_tick: 5000, last_input_seq: -1, ownership: 'active',
  combat_revision: 1, components: { transform: transform(), ped: { weapon: 0x1b06d571, shooting: false, actions: { ...actions } },
    combat: { health: 200, max_health: 200, alive: true, kills: 0, deaths: 0, respawn_at_tick: 0 } }, ...changes });
const vehicle = (changes = {}) => ({ entity_id: 'w:epochA:2', kind: 'vehicle', player_id: null, model: 0xeb70965f,
  revision: 1, generation: 1, owner_id: null, owner_epoch: 1, lease_until_tick: 0, last_input_seq: -1, ownership: 'unowned',
  components: { transform: transform(715.5), vehicle: { engine_health: 1000, body_health: 1000,
    seats: { driver: null, 'passenger:0': null }, engine_on: false, lights_on: false } }, ...changes });
const begin = (changes = {}) => ({ type: 'snapshot_begin', schema_version: 2, world_epoch: 'epochA', snapshot_id: 'snapshot1', cut_revision: 5, world_tick: 100, stream_seq: 0, ...changes });
const chunk = (entities, changes = {}) => ({ type: 'snapshot_chunk', schema_version: 2, world_epoch: 'epochA', snapshot_id: 'snapshot1', cut_revision: 5,
  index: 0, entities, tombstones: [], ...changes });
const end = (changes = {}) => ({ type: 'snapshot_end', schema_version: 2, world_epoch: 'epochA', snapshot_id: 'snapshot1', cut_revision: 5, world_tick: 100, stream_seq: 0, ...changes });
const delta = (changes = {}) => ({ type: 'world_delta', schema_version: 2, world_epoch: 'epochA', world_revision: 6,
  world_tick: 110, stream_seq: 1, entities: [], tombstones: [], scope_leave: [], ...changes });
const baseline = (world, entities = [ped(), vehicle()]) => { world.receive(begin()); world.receive(chunk(entities)); return world.receive(end()); };

test('分块快照仅在同 epoch、snapshot、cut 的 end 到达后原子生效，旧基线始终不会出现半块实体', async () => {
  const { createWorldState } = await modulePromise;
  const world = createWorldState();
  world.receive(begin()); world.receive(chunk([ped()]));
  assert.equal(world.state().ready, false); assert.equal(world.state().entities.length, 0);
  world.receive(chunk([vehicle()], { index: 1 })); world.receive(end());
  assert.equal(world.state().ready, true); assert.equal(world.state().entities.length, 2);
  world.receive(begin({ snapshot_id: 'snapshot2', cut_revision: 10, stream_seq: 2 }));
  world.receive(chunk([ped({ revision: 3 })], { snapshot_id: 'snapshot2', cut_revision: 10 }));
  assert.equal(world.state().ready, false); assert.equal(world.entity(ped().entity_id).revision, 1);
  assert.equal(world.state().entities.length, 2, '完成前不能先删除旧车辆');
  assert.equal(world.receive(end({ snapshot_id: 'snapshot2', cut_revision: 9, stream_seq: 2 })).needsSnapshot, true);
  assert.equal(world.entity(ped().entity_id).revision, 1);
  world.receive(end({ snapshot_id: 'snapshot2', cut_revision: 10, stream_seq: 2 }));
  assert.equal(world.state().ready, true); assert.equal(world.entity(ped().entity_id).revision, 3);
  assert.equal(world.state().entities.length, 1);
});

test('切面之后的增量缓存到快照完成再应用，stream_seq 独立于不连续的 world_revision', async () => {
  const { createWorldState } = await modulePromise;
  const world = createWorldState(); world.receive(begin()); world.receive(chunk([ped()]));
  world.receive(delta({ world_revision: 20, entities: [ped({ revision: 2, components: { ...ped().components, transform: transform(712) } })] }));
  assert.equal(world.state().entities.length, 0); world.receive(end());
  assert.equal(world.state().world_revision, 20); assert.equal(world.state().stream_seq, 1);
  assert.equal(world.entity(ped().entity_id).components.transform.position[0], 712);
  world.receive(delta({ world_revision: 99, stream_seq: 2, entities: [ped({ revision: 3 })] }));
  assert.equal(world.state().world_revision, 99); assert.equal(world.state().ready, true);
  const gap = world.receive(delta({ world_revision: 100, stream_seq: 4 }));
  assert.equal(gap.needsSnapshot, true); assert.equal(world.state().ready, false);
  assert.equal(world.state().world_revision, 99, '分发缺口后不继续假定世界已经连续');
});

test('实体 revision/generation、删除墓碑与退休 epoch 阻止旧结果重新创建对象', async () => {
  const { createWorldState } = await modulePromise;
  const world = createWorldState(); baseline(world);
  world.receive(delta({ entities: [ped({ revision: 3, generation: 2 })] }));
  world.receive(delta({ world_revision: 7, stream_seq: 2, entities: [ped({ revision: 4, generation: 1 })] }));
  assert.equal(world.entity(ped().entity_id).generation, 2);
  world.receive(delta({ world_revision: 8, stream_seq: 3, tombstones: [{ entity_id: ped().entity_id, revision: 4, generation: 2, world_revision: 8 }] }));
  assert.equal(world.entity(ped().entity_id), null);
  world.receive(delta({ world_revision: 9, stream_seq: 4, entities: [ped({ revision: 3, generation: 2 })] }));
  assert.equal(world.entity(ped().entity_id), null);
  world.receive(begin({ world_epoch: 'epochB', snapshot_id: 'snapshotB', cut_revision: 1 }));
  world.receive(chunk([ped({ entity_id: 'w:epochB:1' })], { world_epoch: 'epochB', snapshot_id: 'snapshotB', cut_revision: 1 }));
  world.receive(end({ world_epoch: 'epochB', snapshot_id: 'snapshotB', cut_revision: 1 }));
  assert.equal(world.state().world_epoch, 'epochB');
  world.receive(begin({ cut_revision: 999 })); world.receive(chunk([ped({ revision: 999 })], { cut_revision: 999 }));
  world.receive(end({ cut_revision: 999 }));
  assert.equal(world.state().world_epoch, 'epochB');
});

test('兴趣范围离开只卸载实体，返回同版本仍可进入；正式删除保持墓碑', async () => {
  const { createWorldState } = await modulePromise; const world = createWorldState(); baseline(world);
  world.receive(delta({ scope_leave: [vehicle().entity_id] }));
  assert.equal(world.entity(vehicle().entity_id), null); assert.equal(world.state().tombstones.length, 0);
  world.receive(delta({ world_revision: 7, stream_seq: 2, entities: [vehicle()] }));
  assert.ok(world.entity(vehicle().entity_id));
  world.receive(delta({ world_revision: 8, stream_seq: 3,
    tombstones: [{ entity_id: vehicle().entity_id, revision: 2, generation: 1, world_revision: 8 }] }));
  assert.equal(world.state().tombstones.length, 1); assert.equal(world.entity(vehicle().entity_id), null);
});

test('组件严格校验，非法四元数、座位、动作、健康和未支持字段不能进入引擎快照', async () => {
  const { cleanWorldEntity, cleanWorldTransform, createWorldState } = await modulePromise;
  assert.equal(cleanWorldTransform({ ...transform(), rotation: [0, 0, 0, 0] }), null);
  assert.equal(cleanWorldTransform({ ...transform(), velocity: [301, 0, 0] }), null);
  for (const malformed of [ped({ generation: 0 }), ped({ revision: -1 }),
    ped({ components: { ...ped().components, lifecycle: 'respawn' } }),
    ped({ components: { ...ped().components, ped: { weapon: 1, shooting: true, actions: { aiming: true } } } }),
    ped({ components: { ...ped().components, combat: { ...ped().components.combat, health: 0, alive: true } } }),
    vehicle({ components: { ...vehicle().components, vehicle: { ...vehicle().components.vehicle, seats: { driver: 'same', 'passenger:0': 'same' } } } })]) {
    assert.equal(cleanWorldEntity(malformed), null);
  }
  const world = createWorldState(); baseline(world);
  const old = world.state();
  const failed = world.receive(delta({ entities: [ped({ revision: 2, components: { ...ped().components, transform: { ...transform(), position: [17000, 0, 0] } } })] }));
  assert.equal(failed.needsSnapshot, true); assert.deepEqual(world.state().entities, old.entities);
  const output = world.state(); output.entities[0].components.combat.health = 0;
  assert.equal(world.entity(ped().entity_id).components.combat.health, 200);
});

test('旧 stream 包、旧 cut 快照和乱序缺块不会倒退基线', async () => {
  const { createWorldState } = await modulePromise; const world = createWorldState(); baseline(world);
  world.receive(delta({ entities: [ped({ revision: 2 })] }));
  world.receive(delta({ entities: [ped({ revision: 99 })] }));
  assert.equal(world.entity(ped().entity_id).revision, 2);
  world.receive(begin({ cut_revision: 5, stream_seq: 0 }));
  assert.equal(world.state().ready, true); assert.equal(world.state().world_revision, 6);
  world.receive(begin({ snapshot_id: 'new', cut_revision: 7, stream_seq: 2 }));
  world.receive(chunk([ped({ revision: 3 })], { snapshot_id: 'new', cut_revision: 7, index: 1 }));
  assert.equal(world.receive(end({ snapshot_id: 'new', cut_revision: 7, stream_seq: 2 })).needsSnapshot, true);
  assert.equal(world.entity(ped().entity_id).revision, 2);
});

test('适配器将完整 world 基线交给引擎并保持 v1 信息，游戏输入只送到本页网络会话', () => {
  const messages = [], timers = new Map(), hud = { style: {}, textContent: '' }; let receiver;
  const network = { setReceiver: (callback) => { receiver = callback; }, onWorkerMessage: (value) => messages.push(copy(value)) };
  const context = vm.createContext({ TextEncoder, Atomics, Int32Array, Uint8Array,
    BroadcastChannel: class { close() {} }, document: { getElementById: () => hud }, addEventListener() {},
    fetch: () => Promise.resolve({ ok: true }), performance: { now: () => 100 },
    setTimeout: (callback) => { timers.set(timers.size + 1, callback); return timers.size; }, clearTimeout: (id) => timers.delete(id) });
  vm.runInContext(read('game-adapter.js').replace('export function installGameAdapter', 'function installGameAdapter') + '\nglobalThis.install=installGameAdapter;', context);
  const adapter = context.install({}, network), memory = { buffer: new SharedArrayBuffer(16384) }, block = 128, capacity = 8192;
  adapter.onWorkerMessage({ multiplayer: { type: 'memory', memory, block, capacity } });
  receiver({ type: 'session', connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }], peers: [], world_v2: true });
  receiver({ type: 'world_state_v2', schema_version: 2, world_epoch: 'epochA', world_revision: 5,
    world_tick: 100, stream_seq: 0, ready: true, entities: [ped(), vehicle()], tombstones: [] });
  for (const callback of timers.values()) callback(); timers.clear();
  const packet = JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, block + 16, Atomics.load(new Int32Array(memory.buffer, block, 4), 1))));
  assert.equal(packet.client_id, 'LOCAL'); assert.equal(packet.world.ready, true); assert.equal(packet.world.entities[1].kind, 'vehicle');
  adapter.onWorkerMessage({ multiplayer: { type: 'entity_ready', entity_id: vehicle().entity_id, owner_epoch: 2 } });
  adapter.onWorkerMessage({ multiplayer: { type: 'entity_input', entity_id: vehicle().entity_id, transform: transform() } });
  adapter.onWorkerMessage({ multiplayer: { type: 'interaction_request', action: 'enter_vehicle', entity_id: vehicle().entity_id, seat: 'driver' } });
  adapter.onWorkerMessage({ multiplayer: { type: 'simulation_result', kind: 'life_report', health: 0, reason: 'dead' } });
  assert.equal(messages.filter((message) => message.type === 'entity_ready').length, 1);
  assert.equal(messages.filter((message) => message.type === 'simulation_result').length, 1);
  receiver({ type: 'session', connected: false, client_id: null, members: [], peers: [] });
  for (const callback of timers.values()) callback();
  const disconnected = JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, block + 16, Atomics.load(new Int32Array(memory.buffer, block, 4), 1))));
  assert.equal(disconnected.world, null);
});
