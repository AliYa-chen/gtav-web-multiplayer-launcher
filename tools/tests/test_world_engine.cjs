#!/usr/bin/env node
'use strict';
// 执行真实统一实体适配器与受控 native 替身；不启动游戏。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../client/multiplayer/world-engine-bridge.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const pose = x => ({ position: [x, -1088, 22.4], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angular_velocity: [0, 0, 0] });
const life = health => ({ health, alive: health > 0, max_health: 200, kills: 0, deaths: 0, respawn_at_tick: 0 });
const idle = () => ({ aiming: false, reloading: false, jumping: false, ducking: false, sprinting: false });
const player = (changes = {}) => ({ entity_id: 'p1', kind: 'ped', player_id: 'LOCAL', model: 0x705e61f2,
  revision: 1, generation: 1, owner_epoch: 1, owner_id: 'LOCAL', ownership: 'active',
  components: { transform: pose(711), combat: life(200), ped: { weapon: 0xa2719263, shooting: false, actions: idle() } }, ...changes });
const car = (changes = {}) => ({ entity_id: 'v1', kind: 'vehicle', player_id: null, model: 0xeb70965f,
  revision: 1, generation: 1, owner_epoch: 1, owner_id: 'LOCAL', ownership: 'offered',
  components: { transform: pose(715), vehicle: { engine_health: 1000, body_health: 1000, engine_on: false,
    lights_on: false, seats: { driver: null, 'passenger:0': null } } }, ...changes });
const npc = (changes = {}) => ({ entity_id: 'n1', kind: 'ped', player_id: null, model: 0xc99f21c4,
  revision: 1, generation: 1, owner_epoch: 1, owner_id: 'LOCAL', ownership: 'offered', simulation_task: 'wander',
  components: { transform: pose(720), combat: life(200), ped: { weapon: 0xa2719263, shooting: false, actions: idle() } }, ...changes });
const packet = entities => ({ connected: true, client_id: 'LOCAL', world: { ready: true, world_epoch: 'epoch1', entities, tombstones: [] } });
function harness() {
  const memory = { buffer: new SharedArrayBuffer(8192) }, entities = new Map(), calls = [], messages = [];
  const local = { position: [711, -1088, 22.4], health: 200, arrested: false, dead: false, vehicle: 0 };
  entities.set(7, local); entities.set(8, { position: [713, -1088, 22.4], health: 200 });
  let allocated = 256, next = 100, loaded = true, melee = false, meleeTarget = 8, trying = 0;
  const v = () => new DataView(memory.buffer);
  const writeVector = (pointer, values) => values.forEach((value, index) => v().setFloat32(Number(pointer) + 8 * index, value, true));
  const readVector = pointer => [0, 8, 16].map(index => v().getFloat32(Number(pointer) + index, true));
  const create = position => { const id = ++next; entities.set(id, { position: readVector(position), health: 200,
    quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], engine: 1000, body: 1000, vehicle: 0 }); return id; };
  const implementation = {
    mpAlloc: size => { const pointer = allocated; allocated += Number(size); return BigInt(pointer); },
    mpExists: id => entities.has(id) ? 1 : 0, mpHasModel: () => loaded ? 1 : 0, mpRequestModel() {},
    mpCreateVehicle: (_model, pointer) => { const id = create(pointer); entities.get(id).kind = 'vehicle'; return id; },
    mpCreatePed: (_type, _model, pointer) => { const id = create(pointer); entities.get(id).kind = 'ped'; return id; },
    mpDeleteVehicle: pointer => entities.delete(v().getInt32(Number(pointer), true)),
    mpDeletePed: pointer => entities.delete(v().getInt32(Number(pointer), true)),
    mpGetEntityCoords: (pointer, handle) => writeVector(pointer, entities.get(handle).position),
    mpSetCoordsNoOffset: (handle, pointer) => { entities.get(handle).position = readVector(pointer); },
    mpSetQuaternion: (handle, ...values) => { entities.get(handle).quaternion = values; },
    mpGetQuaternion: (handle, ...pointers) => pointers.forEach((pointer, index) => v().setFloat32(Number(pointer), entities.get(handle).quaternion?.[index] ?? (index === 3 ? 1 : 0), true)),
    mpGetVelocity: (pointer, handle) => writeVector(pointer, entities.get(handle).velocity || [0, 0, 0]),
    mpSetVelocity: (handle, pointer) => { entities.get(handle).velocity = readVector(pointer); },
    mpGetAngularVelocity: (pointer, handle) => writeVector(pointer, entities.get(handle).angular || [0, 0, 0]),
    mpSetAngularVelocity: (handle, pointer) => { entities.get(handle).angular = readVector(pointer); },
    mpGetHealth: handle => entities.get(handle).health,
    mpSetHealth: (handle, health) => { entities.get(handle).health = health; entities.get(handle).dead = health <= 0; },
    mpIsDead: handle => entities.get(handle).dead ? 1 : 0,
    mpResurrect: handle => { entities.get(handle).dead = false; }, mpRevive() {},
    mpFreeze: (handle, enabled) => { entities.get(handle).frozen = Boolean(enabled); },
    mpSetInvincible: (handle, enabled) => { entities.get(handle).invincible = Boolean(enabled); },
    mpSetCanRagdoll() {},
    mpDefaultVariation() {}, mpBlockEvents() {}, mpSetEngineHealth() {}, mpSetBodyHealth() {}, mpSetEngineOn() {},
    mpEngineRunning: () => 1, mpEngineHealth: handle => entities.get(handle).engine, mpBodyHealth: handle => entities.get(handle).body,
    mpIsShooting: () => 0, mpTaskWander() {}, mpDriveWander() {},
    mpGetVehiclePedIsIn: handle => entities.get(handle).vehicle || 0,
    mpSetPedIntoVehicle: (handle, vehicle) => { entities.get(handle).vehicle = vehicle; },
    mpLeaveVehicle: handle => { entities.get(handle).vehicle = 0; },
    mpPlayerId: () => 0, mpIsArrested: () => local.arrested ? 1 : 0,
    mpMeleeAction: () => melee ? 1 : 0, mpMeleeTarget: () => meleeTarget,
    mpTryingVehicle: () => trying, mpTryingSeat: () => -1, mpClearTasksImmediately() {},
    mpFadeAfterDeath() {}, mpFadeAfterArrest() {}, mpFadeAfterRestart() {},
    mpPedDensity() {}, mpScenarioDensity() {}, mpVehicleDensity() {}, mpRandomVehicleDensity() {}, mpParkedVehicleDensity() {},
    mpPopulationType: handle => entities.get(handle).population || 0,
    mpAllVehicles: pointer => {
      const found = [...entities].filter(([_id, value]) => value.kind === 'vehicle').map(([id]) => id).slice(0, 64);
      found.forEach((id, index) => v().setInt32(Number(pointer) + 8 + index * 8, id, true)); return found.length;
    },
    mpNearbyPeds: (_local, pointer) => {
      const found = [...entities].filter(([_id, value]) => value.kind !== 'vehicle').map(([id]) => id).slice(0, 64);
      found.forEach((id, index) => v().setInt32(Number(pointer) + 8 + index * 8, id, true)); return found.length;
    },
  };
  const ex = Object.fromEntries(Object.entries(implementation).map(([name, callback]) => [name, (...arguments_) => {
    calls.push({ name, arguments: arguments_ }); return callback(...arguments_);
  }]));
  const self = {}, context = vm.createContext({ self, DataView, Uint8Array, BigInt });
  vm.runInContext(source, context);
  const bridge = self.createWorldEntityBridge({ ex, memory, post: value => messages.push(copy(value)), playerReplica: id => id === 'REMOTE' ? 8 : 0 });
  return { bridge, entities, calls, messages, local, setLoaded: value => { loaded = value; },
    setMelee: (value, target = 8) => { melee = value; meleeTarget = target; }, setTrying: value => { trying = value; } };
}
test('模型加载完成前不创建或确认，offered只就绪，active才模拟和上报', () => {
  const h = harness(), state = packet([player(), car()]); h.setLoaded(false); h.bridge.update(state, 100, 7);
  assert.equal(h.bridge.entityHandle('v1'), 0); assert.equal(h.messages.filter(m => m.type === 'entity_ready').length, 0);
  h.setLoaded(true); h.bridge.update(state, 200, 7);
  const handle = h.bridge.entityHandle('v1'); assert.ok(handle); assert.ok(h.entities.get(handle).frozen);
  assert.equal(h.messages.filter(m => m.type === 'entity_ready').length, 1);
  assert.equal(h.messages.filter(m => m.type === 'entity_input').length, 0);
  state.world.entities[1].ownership = 'active'; h.bridge.update(state, 300, 7);
  assert.equal(h.entities.get(handle).frozen, false);
  assert.equal(h.messages.filter(m => m.type === 'entity_input').length, 1);
});
test('真实四元数、速度上报且非所有者应用服务器姿态；epoch重建不会复用旧句柄', () => {
  const h = harness(), state = packet([player(), car({ ownership: 'active' })]); h.bridge.update(state, 100, 7);
  const handle = h.bridge.entityHandle('v1'); h.entities.get(handle).position = [717, -1088, 22.4];
  h.entities.get(handle).quaternion = [0, 0, .70710678, .70710678]; h.entities.get(handle).velocity = [3, 0, 0];
  h.entities.get(handle).angular = [0, 0, .5];
  h.bridge.update(state, 300, 7);
  const input = h.messages.filter(m => m.type === 'entity_input').at(-1);
  assert.equal(input.transform.position[0], 717); assert.ok(Math.abs(Math.hypot(...input.transform.rotation) - 1) < .001);
  assert.deepEqual(input.transform.velocity, [3, 0, 0]);
  assert.deepEqual(input.transform.angular_velocity, [0, 0, .5]);
  state.world.entities[1].owner_id = 'REMOTE'; state.world.entities[1].revision++;
  h.bridge.update(state, 400, 7); assert.equal(h.entities.get(handle).position[0], 715);
  state.world.world_epoch = 'epoch2'; h.bridge.update(state, 500, 7);
  assert.ok(!h.entities.has(handle)); assert.notEqual(h.bridge.entityHandle('v1'), handle);
});
test('附件经实体ID解析到本机句柄；未经批准入车只请求服务器，退出也先确认', () => {
  const h = harness(), state = packet([player(), car()]); h.bridge.update(state, 100, 7);
  const vehicle = h.bridge.entityHandle('v1'); h.setTrying(vehicle); h.bridge.update(state, 1500, 7);
  const enter = h.messages.find(m => m.type === 'interaction_request'); assert.equal(enter.action, 'enter_vehicle');
  assert.equal(h.local.vehicle, 0);
  h.setTrying(0); state.world.entities[0].components.attachment = { entity_id: 'v1', seat: 'driver' };
  h.bridge.update(state, 1700, 7); assert.equal(h.local.vehicle, vehicle);
  h.bridge.update(state, 1800, 7); h.local.vehicle = 0; h.bridge.update(state, 2900, 7);
  assert.ok(h.messages.some(m => m.action === 'leave_vehicle')); assert.equal(h.local.vehicle, 0);
});
test('服务器人口唯一生成，获租约NPC才运行wander，迁移和范围卸载释放副本', () => {
  const h = harness(), state = packet([player(), npc()]); h.bridge.update(state, 100, 7);
  const handle = h.bridge.entityHandle('n1'); assert.ok(handle);
  assert.equal(h.calls.filter(c => c.name === 'mpTaskWander').length, 0);
  state.world.entities[1].ownership = 'active'; h.bridge.update(state, 200, 7); h.bridge.update(state, 400, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpTaskWander').length, 1);
  state.world.entities[1].owner_id = 'REMOTE'; state.world.entities[1].owner_epoch++;
  h.bridge.update(state, 500, 7); assert.ok(h.entities.get(handle).frozen);
  state.world.entities.pop(); h.bridge.update(state, 600, 7); assert.ok(!h.entities.has(handle));
});
test('环境伤害、死亡和逮捕只提交候选，等待服务器，不在适配器里宣布重生', () => {
  const h = harness(), state = packet([player()]); h.local.health = 175;
  let status = h.bridge.update(state, 100, 7); assert.equal(status.awaitingLife, true);
  assert.deepEqual(h.messages.find(m => m.type === 'simulation_result'), { type: 'simulation_result', kind: 'life_report', reason: 'environmental', health: 150,
    entity_id: 'p1', owner_epoch: 1, generation: 1 });
  h.local.health = 0; h.local.dead = true; h.bridge.update(state, 700, 7);
  assert.ok(h.messages.some(m => m.reason === 'dead')); assert.equal(h.local.dead, true);
  h.local.arrested = true; h.bridge.update(state, 1300, 7); assert.ok(h.messages.some(m => m.reason === 'arrest'));
  state.world.entities[0].components.combat = life(0); status = h.bridge.update(state, 1400, 7);
  assert.equal(status.awaitingLife, false);
});

test('首次加载和换模期间的暂时死亡值不作为生命候选，角色就绪后才上报', () => {
  const h = harness(), state = packet([player()]); h.local.health = 0; h.local.dead = true;
  h.bridge.update(state, 100, 7, { localReady: false });
  assert.equal(h.messages.filter(m => m.type === 'simulation_result').length, 0);
  h.bridge.update(state, 200, 7, { localReady: true });
  assert.equal(h.messages.filter(m => m.type === 'simulation_result').length, 1);
});

test('服务器重生换代时不把尚未恢复的旧尸体再次上报为新生命死亡', () => {
  const h = harness(), state = packet([player()]); h.bridge.update(state, 100, 7);
  h.local.dead = true; h.local.health = 0; h.bridge.update(state, 700, 7);
  const before = h.messages.filter(m => m.type === 'simulation_result').length;
  state.world.entities[0].generation = 2; state.world.entities[0].owner_epoch = 2;
  const status = h.bridge.update(state, 1300, 7);
  assert.equal(status.lifeTransition, true);
  assert.equal(h.messages.filter(m => m.type === 'simulation_result').length, before);
  h.local.dead = false; h.local.health = 200; h.bridge.update(state, 1400, 7);
  assert.equal(h.messages.filter(m => m.type === 'simulation_result').length, before);
});
test('近战只上报统一实体目标，不调用本地伤害命令，持续同动作不重复发送', () => {
  const h = harness(), target = player({ entity_id: 'p2', player_id: 'REMOTE' });
  const state = packet([player(), target]); h.setMelee(true); h.bridge.update(state, 600, 7); h.bridge.update(state, 1200, 7);
  const melee = h.messages.filter(m => m.action === 'melee'); assert.equal(melee.length, 1); assert.equal(melee[0].entity_id, 'p2');
  assert.equal(h.entities.get(8).health, 200);
});
test('密度限制只在统一世界已就绪时应用，断线冻结并清理世界副本', () => {
  const h = harness(), state = packet([player(), car()]); state.world.ready = false;
  h.bridge.suppressPopulation(state); assert.equal(h.calls.length, 0);
  state.world.ready = true; h.bridge.suppressPopulation(state);
  assert.equal(h.calls.filter(c => /Density$/.test(c.name)).length, 5);
  h.bridge.update(state, 100, 7); const handle = h.bridge.entityHandle('v1');
  state.connected = false; h.bridge.update(state, 300, 7); assert.ok(!h.entities.has(handle));
});

test('统一人口只清理未登记随机实体，保护玩家、登记车与任务对象', () => {
  const h = harness(), remote = player({ entity_id: 'p2', player_id: 'REMOTE' });
  const state = packet([player(), remote, car(), npc()]); h.bridge.update(state, 100, 7);
  const vehicle = h.bridge.entityHandle('v1'), ped = h.bridge.entityHandle('n1');
  for (const handle of [7, 8, vehicle, ped]) h.entities.get(handle).population = 5;
  h.entities.set(201, { kind: 'vehicle', position: [712, -1088, 22], population: 1 });
  h.entities.set(202, { kind: 'ped', position: [712, -1088, 22], population: 5 });
  h.entities.set(203, { kind: 'vehicle', position: [712, -1088, 22], population: 7 });
  h.bridge.update(state, 1200, 7);
  assert.ok(!h.entities.has(201)); assert.ok(!h.entities.has(202)); assert.ok(h.entities.has(203));
  for (const handle of [7, 8, vehicle, ped]) assert.ok(h.entities.has(handle));
});
