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

test('道路不可达AI使用原有idle任务结构，世界快照无需升级schema', async () => {
  const {cleanWorldEntity,createWorldState}=await modulePromise;
  const actor=ped({player_id:null,simulation_task:'wander'});
  actor.ai_task={revision:1,entity_id:actor.entity_id,generation:actor.generation,owner_epoch:actor.owner_epoch,
    action:'idle',reason:'road_unavailable',target_entity_id:null,target_generation:null,target_position:null,
    destination:null,speed:0,vehicle_entity_id:null,expires_at_tick:0};
  assert.deepEqual(cleanWorldEntity(actor).ai_task,actor.ai_task);
  const world=createWorldState();baseline(world,[actor]);assert.equal(world.state().ready,true);
  assert.equal(world.entity(actor.entity_id).ai_task.reason,'road_unavailable');
  assert.equal(world.state().schema_version,2);
});

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

function adapterHarness() {
  const timers = new Map(), hud = { style: {}, textContent: '' }; let receiver, timer = 0;
  const context = vm.createContext({ TextEncoder, Atomics, Int32Array, Uint8Array,
    BroadcastChannel: class { close() {} }, document: { getElementById: () => hud }, addEventListener() {},
    fetch: () => Promise.resolve({ ok: true }), performance: { now: () => 100 },
    setTimeout: (callback) => { timers.set(++timer, callback); return timer; }, clearTimeout: (id) => timers.delete(id) });
  vm.runInContext(read('game-adapter.js').replace('export function installGameAdapter', 'function installGameAdapter') + '\nglobalThis.install=installGameAdapter;', context);
  const api = context.install({}, { setReceiver: (callback) => { receiver = callback; }, onWorkerMessage() {} });
  const memory = { buffer: new SharedArrayBuffer(262144) }, block = 128, capacity = 128 * 1024;
  api.onWorkerMessage({ multiplayer: { type: 'memory', memory, block, capacity } });
  const packet = () => {
    const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback();
    return JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, block + 16, Atomics.load(new Int32Array(memory.buffer, block, 4), 1))));
  };
  const world = (changes = {}) => receiver({ type: 'world_state_v2', schema_version: 2, world_epoch: 'epochA', world_revision: 5,
    world_tick: 100, stream_seq: 0, ready: true, entities: [ped(), vehicle()], tombstones: [], ...changes });
  const session = (changes = {}) => receiver({ type: 'session', connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }],
    peers: [], world_v2: true, melee_events: true, ...changes });
  return { api, receive: (value) => receiver(value), world, session, packet, hud };
}

test('可靠近战事件队列跨世界快照和会话更新保留，成功确认只移除匹配事件，重复广播不重新入队', () => {
  const page = adapterHarness(); page.session(); page.world();
  const event = { type: 'melee_event', schema_version: 2, world_epoch: 'epochA', event_id: 'm:epochA:1', request_id: 'punch1',
    attacker_entity_id: ped().entity_id, attacker_generation: 1, target_entity_id: null, target_generation: null,
    action: 'punch', accepted: true, hit: false, damage: 0, health: null, revision: 1, world_tick: 120 };
  page.receive(event); page.receive(event);
  let packet = page.packet(); assert.equal(packet.world_events.length, 1);
  const first = packet.world_events[0].id;
  page.receive({ ...event, event_id: 'm:epochA:2', request_id: 'punch2' });
  page.world({ ready: false }); page.session(); page.world({ world_revision: 7, stream_seq: 2 });
  packet = page.packet(); assert.equal(packet.world_events.length, 2); assert.equal(packet.world_events[0].id, first);
  page.api.onWorkerMessage({ multiplayer: { type: 'world_event_ack', ids: [first] } });
  packet = page.packet(); assert.equal(packet.world_events.length, 1);
  assert.equal(packet.world_events[0].event.event_id, 'm:epochA:2');
  page.api.onWorkerMessage({ multiplayer: { type: 'world_event_ack', ids: [first] } });
  assert.equal(page.packet().world_events.length, 1);
  page.receive(event); assert.equal(page.packet().world_events.length, 1, '已确认动作不能在服务器重发后重复播放');
  page.world({ world_epoch: 'epochB' }); assert.equal(page.packet().world_events.length, 0, '新的世界不能继承旧动作');
});

test('未确认世界事件不能因后续高频快照静默丢弃，老服务器仅提示能力缺失不改目标地址', () => {
  const page = adapterHarness(); page.session(); page.world();
  for (let index = 0; index < 70; index++) page.receive({ type: 'melee_event', world_epoch: 'epochA',
    event_id: 'm:epochA:' + index, request_id: 'p' + index, action: 'punch' });
  assert.equal(page.packet().world_events.length, 70, '待确认可靠动作不能用shift丢弃旧事件');
  page.session({ connected: false, client_id: null }); assert.equal(page.packet().world_events.length, 0);
  const legacy = adapterHarness(); legacy.session({ world_v2: false, melee_events: false });
  let packet = legacy.packet(); assert.equal(packet.notices.filter((notice) => notice.text.includes('不支援近戰')).length, 1);
  assert.ok(!packet.notices.some((notice) => /47486/.test(notice.text)));
  legacy.session({ world_v2: false, melee_events: false });
  packet = legacy.packet(); assert.equal(packet.notices.filter((notice) => notice.text.includes('不支援近戰')).length, 1);
});

const environment = (changes = {}) => ({ revision: 1, weather: { type: 'CLEAR', rain: 0, wind: .2, transition_ms: 30000, anchor_tick: 100 },
  clock: { hour: 12, minute: 0, second: 0, paused: false, rate: 30, anchor_tick: 100 }, ...changes });
test('共同环境跟随完整快照原子安装，实体没有变化也可应用独立环境版本', async () => {
  const { createWorldState } = await modulePromise; const world = createWorldState();
  world.receive(begin({ environment: environment() })); world.receive(chunk([ped()]));
  assert.equal(world.state().environment, null);
  world.receive(end({ environment: environment() }));
  assert.equal(world.state().environment.revision, 1); assert.equal(world.state().environment_server_tick, 100);
  const next = environment({ revision: 2 });
  assert.equal(world.receive(delta({ world_revision: 5, world_tick: 5100, environment: next })).changed, true);
  assert.equal(world.state().world_revision, 5); assert.equal(world.state().environment.revision, 2);
  assert.equal(world.state().environment_server_tick, 5100);
  world.receive(delta({ stream_seq: 2, world_revision: 6, world_tick: 5200, environment: environment() }));
  assert.equal(world.state().environment.revision, 2, '旧天气不能倒退');
  assert.equal(world.state().environment_server_tick, 5100, '实体运动消息不能重新计算环境时间锚点');
});
test('非法环境、快照环境切面不同及序号缺口触发重取，不沿用另一世界天气', async () => {
  const { createWorldState, cleanWorldEnvironment } = await modulePromise;
  assert.equal(cleanWorldEnvironment(environment({ clock: { ...environment().clock, rate: 9999 } })), null);
  const world = createWorldState();world.receive(begin({ environment: environment() }));world.receive(chunk([ped()]));
  assert.equal(world.receive(end({ environment: environment({ revision: 2 }) })).needsSnapshot, true);
  world.receive(end({ environment: environment() }));
  assert.equal(world.receive(delta({ stream_seq: 2, environment: environment({ revision: 2 }) })).needsSnapshot, true);
  assert.equal(world.state().ready, false);
});

test('执法规则独立版本更新NPC任务，不允许回滚实体姿态与生命', async () => {
 const {createWorldState}=await modulePromise,world=createWorldState();
 const law={revision:1,world_epoch:'epochA',players:[{player_id:'LOCAL',generation:1,stars:2,expires_at_tick:20000,last_crime_tick:100,revision:1}],dispatches:[]};
 const officer=ped({player_id:null,task_revision:1,law_response:{response_id:'law:epochA:1',role:'officer',target_player_id:'LOCAL',target_entity_id:'w:epochA:9',target_generation:1,target_position:[711,-1088,22],owner_id:'LOCAL',phase:'active'}});
 world.receive(begin({law}));world.receive(chunk([officer]));world.receive(end({law}));
 const updated={...officer,task_revision:2,law_response:{...officer.law_response,target_position:[713,-1088,22]},components:{...officer.components,transform:transform(700)}};
 assert.equal(world.receive(delta({world_revision:5,law:{...law,revision:2},entities:[updated]})).changed,true);
 assert.equal(world.entity(officer.entity_id).task_revision,2);assert.equal(world.entity(officer.entity_id).components.transform.position[0],711.5);
 assert.equal(world.entity(officer.entity_id).law_response.target_position[0],713);
});

test('AI命令验证对象代际和owner epoch，空目标双null且禁止未知命令字段', async () => {
  const {cleanWorldEntity}=await modulePromise;
  const entity=ped({player_id:null});
  const task={revision:1,entity_id:entity.entity_id,generation:1,owner_epoch:1,action:'wander',reason:'ambient',
    target_entity_id:null,target_generation:null,target_position:null,destination:null,speed:1,vehicle_entity_id:null,expires_at_tick:0};
  assert.ok(cleanWorldEntity({...entity,ai_task:task}));
  for(const change of [{owner_epoch:2},{generation:2},{target_generation:0},{action:'run_script'},{speed:81},{extra:'native'}]){
    assert.equal(cleanWorldEntity({...entity,ai_task:{...task,...change}}),null);
  }
  assert.equal(cleanWorldEntity({...entity,ai_task:{...task,action:'combat'}}),null);
  assert.equal(cleanWorldEntity({...entity,ai_task:{...task,action:'drive'}}),null);
  assert.ok(cleanWorldEntity({...entity,ai_task:{...task,action:'combat',target_entity_id:'target',target_generation:2}}));
});

test('战局脚本策略严格白名单且随快照原子安装，旧版本不能恢复剧情VM', async () => {
  const {cleanSessionPolicy,createWorldState}=await modulePromise;
  const policy={revision:1,story_enabled:false,local_script_mode:'suspend_after_ready',allowed_scripts:[],mission_events:'server_only'};
  assert.deepEqual(cleanSessionPolicy(policy),policy);
  for(const change of [{story_enabled:true},{local_script_mode:'local'},{allowed_scripts:['bad script']},
    {allowed_scripts:['same','same']},{mission_events:'client'},{extra:1}])assert.equal(cleanSessionPolicy({...policy,...change}),null);
  const world=createWorldState();world.receive(begin({session_policy:policy}));world.receive(chunk([ped()]));
  assert.equal(world.state().session_policy,null);world.receive(end({session_policy:policy}));assert.deepEqual(world.state().session_policy,policy);
  world.receive(delta({session_policy:{...policy,revision:2,allowed_scripts:['server_loader']}}));
  assert.equal(world.state().session_policy.revision,2);
  world.receive(delta({stream_seq:2,world_revision:7,session_policy:policy}));
  assert.equal(world.state().session_policy.revision,2);
});
