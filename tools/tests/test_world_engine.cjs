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
const ai = (changes = {}) => ({ revision: 1, entity_id: 'n1', generation: 1, owner_epoch: 1, action: 'wander',
  reason: 'ambient', target_entity_id: null, target_generation: null, target_position: null, destination: null,
  speed: 1, vehicle_entity_id: null, expires_at_tick: 0, ...changes });
const player = (changes = {}) => ({ entity_id: 'p1', kind: 'ped', player_id: 'LOCAL', model: 0x705e61f2,
  revision: 1, generation: 1, owner_epoch: 1, owner_id: 'LOCAL', ownership: 'active',
  components: { transform: pose(711), combat: life(200), ped: { weapon: 0xa2719263, shooting: false, actions: idle() } }, ...changes });
const car = (changes = {}) => ({ entity_id: 'v1', kind: 'vehicle', player_id: null, model: 0xeb70965f,
  revision: 1, generation: 1, owner_epoch: 1, owner_id: 'LOCAL', ownership: 'offered',
  components: { transform: pose(715), vehicle: { engine_health: 1000, body_health: 1000, engine_on: false,
    lights_on: false, seats: { driver: null, 'passenger:0': null } } }, ...changes });
const npc = (changes = {}) => ({ entity_id: 'n1', kind: 'ped', player_id: null, model: 0xc99f21c4,
  revision: 1, generation: 1, owner_epoch: 1, owner_id: 'LOCAL', ownership: 'offered', simulation_task: 'wander', ai_task: ai(),
  components: { transform: pose(720), combat: life(200), ped: { weapon: 0xa2719263, shooting: false, actions: idle() } }, ...changes });
const packet = entities => ({ connected: true, client_id: 'LOCAL', world: { ready: true, world_epoch: 'epoch1', entities, tombstones: [] } });
function harness() {
  const memory = { buffer: new SharedArrayBuffer(8192) }, entities = new Map(), calls = [], messages = [], animationWindows = [];
  const local = { position: [711, -1088, 22.4], health: 200, arrested: false, dead: false, vehicle: 0 };
  entities.set(7, local); entities.set(8, { position: [713, -1088, 22.4], health: 200 });
  let allocated = 256, next = 100, loaded = true, melee = false, meleeTarget = 8, trying = 0;
  let attackInput = false, animationLoaded = true, animationFailure = false;
  const playing = new Map();
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
    mpIsShooting: handle => entities.get(handle).shooting ? 1 : 0, mpTaskWander() {}, mpDriveWander() {}, mpDriveToCoord() {},
    mpTaskGoStraight() {}, mpTaskStandStill() {}, mpSetProofs() {}, mpDrawSphere() {}, mpVisualExplosion() {},
    mpSetPedAsCop() {}, mpTaskCombatPed() {}, mpHasWeaponAsset: () => 1, mpRequestWeaponAsset() {}, mpGiveWeapon() {}, mpSetCurrentWeapon() {}, mpShootBullet() {},
    mpGetVehiclePedIsIn: handle => entities.get(handle).vehicle || 0,
    mpSetPedIntoVehicle: (handle, vehicle) => { entities.get(handle).vehicle = vehicle; },
    mpLeaveVehicle: handle => { entities.get(handle).vehicle = 0; },
    mpPlayerId: () => 0, mpIsArrested: () => local.arrested ? 1 : 0,
    mpMeleeAction: () => melee ? 1 : 0, mpMeleeTarget: () => meleeTarget,
    mpCachedMeleeInputs: (first, second) => { v().setUint8(Number(first), attackInput ? 1 : 0); v().setUint8(Number(second), 0); },
    mpHeading: handle => entities.get(handle).heading || 270,
    mpGetModel: () => 0x705e61f2, mpSelectedWeapon: () => 0xa2719263,
    mpAnimDictExists: () => 1, mpHasAnimDictLoaded: () => animationLoaded ? 1 : 0, mpRequestAnimDict() {},
    mpTaskPlayAnim: (handle, dict, clip) => { if (!animationFailure) playing.set(handle, { dict, clip }); },
    mpIsPlayingAnim: (handle, dict, clip) => playing.get(handle)?.dict === dict && playing.get(handle)?.clip === clip ? 1 : 0,
    mpAnimTime: () => .4,
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
    calls.push({ name, arguments: arguments_, ...(name === 'mpDrawSphere' ? { position: readVector(arguments_[0]) } : {}) }); return callback(...arguments_);
  }]));
  const self = {}, context = vm.createContext({ self, DataView, Uint8Array, BigInt, TextEncoder });
  vm.runInContext(source, context);
  const bridge = self.createWorldEntityBridge({ ex, memory, post: value => messages.push(copy(value)), playerReplica: id => id === 'REMOTE' ? 8 : 0,
    onPlayerAnimation: (...args) => animationWindows.push(args) });
  return { bridge, memory, entities, calls, messages, animationWindows, local, setLoaded: value => { loaded = value; },
    setMelee: (value, target = 8) => { melee = value; meleeTarget = target; }, setTrying: value => { trying = value; },
    setAttackInput: value => { attackInput = value; }, setAnimationLoaded: value => { animationLoaded = value; },
    setAnimationFailure: value => { animationFailure = value; }, playing };
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
test('死亡NPC固定在服务器确认位置，禁止本地尸体物理、任务和重复复活', () => {
  for (const ownership of ['active', 'unowned']) {
    const h = harness(), actor = npc({ ownership }), state = packet([player(), actor]);
    h.bridge.update(state, 100, 7); const handle = h.bridge.entityHandle('n1');
    h.entities.get(handle).position = [999, 0, 20];
    actor.revision++; actor.components.combat = life(0);
    actor.components.transform.velocity = [4, 0, -2];
    h.calls.length = 0; h.messages.length = 0; h.bridge.update(state, 200, 7);
    assert.ok(h.entities.get(handle).position.every((value, index) => Math.abs(value - actor.components.transform.position[index]) < .00001));
    assert.deepEqual(h.entities.get(handle).velocity, [0, 0, 0]);
    assert.equal(h.entities.get(handle).frozen, true);
    assert.equal(h.entities.get(handle).health, 0);
    assert.equal(h.entities.get(handle).invincible, true);
    assert.deepEqual(h.calls.filter(c => c.name === 'mpSetCanRagdoll').at(-1).arguments, [handle, 0]);
    assert.equal(h.calls.filter(c => c.name === 'mpClearTasksImmediately').length, 1);
    h.entities.get(handle).health = 200; h.entities.get(handle).dead = false;
    h.bridge.update(state, 700, 7);
    assert.equal(h.entities.get(handle).health, 0, '本机误恢复生命必须被服务端死亡状态覆盖');
    assert.equal(h.calls.filter(c => c.name === 'mpClearTasksImmediately').length, 1);
    assert.equal(h.calls.filter(c => ['mpTaskWander', 'mpTaskGoStraight', 'mpTaskStandStill', 'mpResurrect', 'mpRevive'].includes(c.name)).length, 0);
    assert.equal(h.messages.filter(m => m.type === 'entity_input' || m.kind === 'entity_health').length, 0);
  }
});
test('NPC新代次重建句柄，服务器删除尸体后不会在同一世界重新出现', () => {
  const h = harness(), actor = npc({ ownership: 'active' }), state = packet([player(), actor]);
  actor.components.combat = life(0); h.bridge.update(state, 100, 7);
  const corpse = h.bridge.entityHandle('n1');
  actor.generation = 2; actor.owner_epoch = 2; actor.revision = 2;
  actor.components.combat = life(200); actor.ai_task = ai({ generation: 2, owner_epoch: 2 });
  h.bridge.update(state, 200, 7); const replacement = h.bridge.entityHandle('n1');
  assert.notEqual(replacement, corpse); assert.equal(h.entities.has(corpse), false);
  assert.equal(h.entities.get(replacement).health, 200); assert.equal(h.entities.get(replacement).frozen, false);
  actor.components.combat = life(0); actor.revision++; h.bridge.update(state, 300, 7);
  state.world.entities.pop(); h.bridge.update(state, 400, 7); h.bridge.update(state, 600, 7);
  assert.equal(h.entities.has(replacement), false); assert.equal(h.bridge.entityHandle('n1'), 0);
  state.world.entities.push(npc({ entity_id: 'n2', ownership: 'active', ai_task: ai({ entity_id: 'n2' }) }));
  h.bridge.update(state, 700, 7);
  assert.ok(h.bridge.entityHandle('n2')); assert.equal(h.bridge.entityHandle('n1'), 0);
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
  const melee = h.messages.filter(m => m.action === 'melee'); assert.equal(melee.length, 1);
  assert.ok(!Object.hasOwn(melee[0], 'entity_id'), '服务器自行选择前方目标，不能依赖本机GUID');
  assert.equal(melee[0].state.heading, 270);
  assert.equal(h.entities.get(8).health, 200);
});

test('本机近战目标为0仍上报意图，连续任务内新缓存输入可产生下一拳', () => {
  const h = harness(), target = player({ entity_id: 'p2', player_id: 'REMOTE' });
  const state = packet([player(), target]); h.setMelee(true, 0); h.bridge.update(state, 600, 7);
  const intents = () => h.messages.filter(m => m.action === 'melee');
  assert.equal(intents().length, 1);
  h.bridge.sampleMelee(state, 605, 7); assert.equal(intents().length, 1);
  h.setAttackInput(true); h.bridge.sampleMelee(state, 1400, 7); assert.equal(intents().length, 2);
  h.bridge.sampleMelee(state, 1405, 7); assert.equal(intents().length, 2);
  assert.equal(h.entities.get(8).health, 200);
});

const meleeEvent = (changes = {}) => ({ type: 'melee_event', schema_version: 2, world_epoch: 'epoch1', event_id: 'melee:1',
  attacker_entity_id: 'p2', attacker_generation: 1, target_entity_id: 'p1', target_generation: 1,
  request_id: 'request:1', action: 'punch', hit: true, damage: 20, health: 180, revision: 2, ...changes });
test('远端挥拳由服务器事件播放安全动画，成功确认后同ID不重放且不独立扣血', () => {
  const h = harness(), state = packet([player(), player({ entity_id: 'p2', player_id: 'REMOTE' })]);
  state.world_events = [{ id: 1, event: meleeEvent() }]; h.bridge.update(state, 100, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpTaskPlayAnim').length, 1);
  const animation = h.calls.find(c => c.name === 'mpTaskPlayAnim');
  assert.equal(animation.arguments[0], 8);
  assert.deepEqual(animation.arguments.slice(3), [8, -8, 700, 0, 0, 0, 0, 0]);
  assert.deepEqual(h.animationWindows, [['REMOTE', 100, 750]]);
  const clear = h.calls.findIndex(c => c.name === 'mpClearTasksImmediately' && c.arguments[0] === 8);
  assert.ok(clear >= 0 && clear < h.calls.findIndex(c => c.name === 'mpTaskPlayAnim'));
  const text = pointer => {
    const bytes = new Uint8Array(h.memory.buffer, Number(pointer), 64);
    const nul = bytes.indexOf(0); assert.ok(nul > 0);
    return new TextDecoder().decode(bytes.slice(0, nul));
  };
  assert.equal(text(animation.arguments[1]), 'melee@unarmed@streamed_core');
  assert.equal(text(animation.arguments[2]), 'heavy_punch_a');
  assert.ok(h.messages.some(m => m.type === 'world_event_ack' && m.ids.includes(1)));
  h.bridge.update(state, 500, 7); assert.equal(h.calls.filter(c => c.name === 'mpTaskPlayAnim').length, 1);
  assert.equal(h.local.health, 200); assert.equal(h.entities.get(8).health, 200);
});

test('动画资源未就绪时保留事件，载入后播放；自己与旧代际事件只确认不播放', () => {
  const h = harness(), state = packet([player(), player({ entity_id: 'p2', player_id: 'REMOTE' })]);
  state.world_events = [{ id: 1, event: meleeEvent() }]; h.setAnimationLoaded(false); h.bridge.update(state, 100, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpTaskPlayAnim').length, 0);
  assert.equal(h.messages.filter(m => m.type === 'world_event_ack').length, 0);
  assert.ok(h.calls.some(c => c.name === 'mpRequestAnimDict'));
  h.setAnimationLoaded(true); h.bridge.update(state, 500, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpTaskPlayAnim').length, 1);
  state.world_events = [{ id: 2, event: meleeEvent({ attacker_entity_id: 'p1' }) },
    { id: 3, event: meleeEvent({ attacker_generation: 0 }) }]; h.bridge.update(state, 600, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpTaskPlayAnim').length, 1);
  assert.ok(h.messages.some(m => m.type === 'world_event_ack' && m.ids.includes(2) && m.ids.includes(3)));
});

test('动画调用未实际开始会限频重试并软报告，不停止角色世界同步', () => {
  const h = harness(), state = packet([player(), player({ entity_id: 'p2', player_id: 'REMOTE' }), car()]);
  state.world_events = [{ id: 1, event: meleeEvent() }]; h.setAnimationFailure(true);
  for (const at of [100, 200, 500, 900, 2200]) h.bridge.update(state, at, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpTaskPlayAnim').length, 3);
  assert.ok(h.messages.some(m => m.phase === 'melee_animation_unavailable'));
  assert.ok(h.bridge.entityHandle('v1'));
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

test('共同警员仅模拟所有者执行服务器目标任务和上报射击，其他端不各自运行AI', () => {
 const h=harness();
 const response={response_id:'law:epoch1:1',role:'officer',target_player_id:'LOCAL',target_entity_id:'p1',target_generation:1,target_position:[711,-1088,22.4],owner_id:'LOCAL',phase:'active'};
 const cop=npc({simulation_task:'police_pursuit',law_response:response,ownership:'active',
   ai_task:ai({action:'combat',reason:'police',target_entity_id:'p1',target_generation:1,target_position:[711,-1088,22.4]})});
 const state=packet([player(),cop]);h.bridge.update(state,100,7);const handle=h.bridge.entityHandle('n1');
 assert.ok(h.calls.some(c=>c.name==='mpTaskCombatPed'&&c.arguments[0]===handle&&c.arguments[1]===7));
 h.entities.get(handle).shooting=true;h.bridge.update(state,200,7);
 assert.ok(h.messages.some(m=>m.kind==='npc_shot'&&m.entity_id==='n1'&&m.target_entity_id==='p1'&&m.target_generation===1));
 const count=h.messages.filter(m=>m.kind==='npc_shot').length;h.bridge.update(state,400,7);assert.equal(h.messages.filter(m=>m.kind==='npc_shot').length,count);
 cop.owner_id='REMOTE';cop.owner_epoch=2;h.bridge.update(state,600,7);
 const tasks=h.calls.filter(c=>c.name==='mpTaskCombatPed').length;h.bridge.update(state,4000,7);
 assert.equal(h.calls.filter(c=>c.name==='mpTaskCombatPed').length,tasks);assert.ok(h.entities.get(handle).frozen);
});

test('无ai_task不自行漫游，永久任务只在revision变化时执行，过期任务停止', () => {
  const h=harness(), actor=npc({ownership:'active',ai_task:null}), state=packet([player(),actor]); state.world.world_tick=100000;
  h.bridge.update(state,100,7); assert.equal(h.calls.filter(c=>c.name==='mpTaskWander').length,0);
  actor.ai_task=ai(); h.bridge.update(state,200,7); h.bridge.update(state,300,7);
  assert.equal(h.calls.filter(c=>c.name==='mpTaskWander').length,1,'expires=0是永久授权');
  actor.ai_task=ai({revision:2,action:'flee',reason:'threat',destination:[745,-1088,22.4],speed:3,expires_at_tick:100010});
  h.bridge.update(state,400,7); assert.equal(h.calls.filter(c=>c.name==='mpTaskGoStraight').length,1);
  state.world.world_tick=100011; h.bridge.update(state,500,7);
  assert.equal(h.calls.filter(c=>c.name==='mpTaskStandStill').length,2);
  assert.ok(h.calls.filter(c=>c.name==='mpBlockEvents').every(c=>c.arguments[1]===1));
});
test('已授权司机坐进确认车辆后才执行定点驾驶且迁移立即停止旧任务', () => {
  const h=harness(), vehicle=car({ownership:'active'}), driver=npc({ownership:'active'});
  driver.components.attachment={entity_id:'v1',seat:'driver'};
  driver.ai_task=ai({action:'drive',reason:'police',vehicle_entity_id:'v1',destination:[740,-1050,22],speed:25});
  const state=packet([player(),vehicle,driver]);h.bridge.update(state,100,7);
  const drive=h.calls.find(c=>c.name==='mpDriveToCoord');assert.ok(drive);assert.equal(drive.arguments[3],25);
  const handle=h.bridge.entityHandle('n1');assert.equal(h.entities.get(handle).vehicle,h.bridge.entityHandle('v1'));
  driver.owner_id='REMOTE';driver.owner_epoch++;h.bridge.update(state,200,7);
  assert.equal(h.calls.filter(c=>c.name==='mpDriveToCoord').length,1);assert.equal(h.entities.get(handle).frozen,true);
});
test('司机和车辆必须都由本端主动模拟，车辆失权立即停止旧驾驶任务', () => {
  const h = harness(), vehicle = car({ ownership: 'offered' }), driver = npc({ ownership: 'active' });
  driver.components.attachment = { entity_id: 'v1', seat: 'driver' };
  driver.ai_task = ai({ action: 'drive', vehicle_entity_id: 'v1', destination: [740, -1050, 22], speed: 15 });
  const state = packet([player(), vehicle, driver]); h.bridge.update(state, 100, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpDriveToCoord').length, 0);
  vehicle.ownership = 'active'; h.bridge.update(state, 200, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpDriveToCoord').length, 1);
  h.calls.length = 0; vehicle.owner_id = 'REMOTE'; vehicle.owner_epoch++; vehicle.revision++;
  h.bridge.update(state, 300, 7); h.bridge.update(state, 500, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpDriveToCoord').length, 0);
  const driverHandle = h.bridge.entityHandle('n1');
  assert.equal(h.calls.filter(c => c.name === 'mpClearTasksImmediately' && c.arguments[0] === driverHandle).length, 1);
  assert.ok(h.calls.some(c => c.name === 'mpTaskStandStill' && c.arguments[0] === driverHandle));
  vehicle.owner_id = 'LOCAL'; vehicle.owner_epoch++; vehicle.revision++;
  h.bridge.update(state, 600, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpDriveToCoord').length, 1);
});
test('服务器漫游逃跑和追逐路点持续执行，同revision不会在三秒后永久停止', () => {
  for (const action of ['wander', 'flee', 'pursue']) {
    const h = harness(), actor = npc({ ownership: 'active', ai_task: ai({ action, destination: [750, -1088, 22.4], speed: 2 }) });
    const state = packet([player(), actor]); h.bridge.update(state, 100, 7);
    assert.equal(h.calls.filter(c => c.name === 'mpTaskGoStraight').length, 1);
    assert.equal(h.calls.filter(c => c.name === 'mpTaskWander').length, 0, '有服务器路点时禁止引擎自行漫游');
    h.bridge.update(state, 500, 7); h.bridge.update(state, 2599, 7);
    assert.equal(h.calls.filter(c => c.name === 'mpTaskGoStraight').length, 1);
    h.bridge.update(state, 2600, 7); h.bridge.update(state, 3100, 7); h.bridge.update(state, 5100, 7);
    assert.equal(h.calls.filter(c => c.name === 'mpTaskGoStraight').length, 3);
    actor.components.transform.position = [750, -1088, 22.4]; h.bridge.update(state, 7600, 7);
    assert.equal(h.calls.filter(c => c.name === 'mpTaskGoStraight').length, 3, '已到确认路点不反复重发');
    actor.ai_task = ai({ action, revision: 2, destination: [775, -1088, 22.4], speed: 2 });
    h.bridge.update(state, 7700, 7);
    assert.equal(h.calls.filter(c => c.name === 'mpTaskGoStraight').length, 4, '新路点立即执行');
    actor.owner_id = 'REMOTE'; actor.owner_epoch++; h.bridge.update(state, 7800, 7); h.bridge.update(state, 11000, 7);
    assert.equal(h.calls.filter(c => c.name === 'mpTaskGoStraight').length, 4, '失去租约后不得续发旧路点');
  }
});
test('等待目标模型的AI重试最多每秒一次，目标就绪后能使用同一任务版本', () => {
  const h = harness(), actor = npc({ ownership: 'active', ai_task: ai({ action: 'combat', target_entity_id: 'p2', target_generation: 1 }) });
  const target = player({ entity_id: 'p2', player_id: 'NOT_READY' }), state = packet([player(), actor, target]);
  h.bridge.update(state, 100, 7); const handle = h.bridge.entityHandle('n1');
  h.bridge.update(state, 200, 7); h.bridge.update(state, 1000, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpClearTasksImmediately' && c.arguments[0] === handle).length, 1);
  assert.equal(h.calls.filter(c => c.name === 'mpTaskCombatPed').length, 0);
  target.player_id = 'REMOTE'; h.bridge.update(state, 1100, 7);
  assert.equal(h.calls.filter(c => c.name === 'mpTaskCombatPed').length, 1);
});
test('玩家及NPC对本机枪弹火焰爆炸和近战免疫，碰撞溺水继续走环境候选', () => {
  const h=harness(),state=packet([player(),npc({ownership:'active'})]);h.bridge.update(state,100,7);
  const protection=h.calls.filter(c=>c.name==='mpSetProofs');assert.equal(protection.length,2);
  for(const call of protection)assert.deepEqual(call.arguments.slice(1),[1,1,1,0,1,0,0,0]);
  h.local.health=175;h.bridge.update(state,700,7);
  assert.ok(h.messages.some(m=>m.kind==='life_report'&&m.reason==='environmental'&&m.health===150));
});
test('投射物只有渲染球，爆炸用noDamage且重复快照不会重播', () => {
  const h=harness(),state=packet([player()]);
  state.world_projectiles=[{world_epoch:'epoch1',projectile_id:'x',position:[711,-1088,24],origin:[711,-1088,24],target:[721,-1088,24],
    phase:'flight',created_at:1000,world_tick:1000,received_at:100,flight_ms:1000,gravity:1,expires_at:5000}];
  state.world_effects=[{id:1,event:{world_epoch:'epoch1',position:[715,-1088,24],damage_type:'EXPLOSIVE'}}];
  h.bridge.renderEffects(state,600);h.bridge.renderEffects(state,700);
  assert.equal(h.calls.filter(c=>c.name==='mpVisualExplosion').length,1);
  assert.deepEqual(h.calls.find(c=>c.name==='mpVisualExplosion').arguments.slice(1),[0,0,1,0,0,1]);
  assert.equal(h.calls.filter(c=>c.name==='mpDrawSphere').length,2);assert.equal(h.calls.filter(c=>c.name==='mpShootBullet').length,0);
  assert.equal(h.messages.filter(m=>m.type==='world_effect_ack').length,2);
});
test('服务器弹道运动段按速度和重力渲染，反弹更新锚点，不重画过期弹丸', () => {
  const h=harness(),state=packet([player()]);
  const projectile={world_epoch:'epoch1',projectile_id:'x',position:[711,-1088,24],origin:[711,-1088,24],target:[900,-1088,24],
    phase:'flight',physics:'ballistic',velocity:[10,0,5],motion_origin:[711,-1088,24],motion_at:1000,
    created_at:1000,world_tick:1000,received_at:100,flight_ms:1000,gravity:1,expires_at:5000};
  state.world_projectiles=[projectile];h.bridge.renderEffects(state,600);
  let draw=h.calls.filter(c=>c.name==='mpDrawSphere').at(-1);
  assert.equal(draw.position[0],716);assert.ok(Math.abs(draw.position[2]-(24+2.5-.5*9.81*.25))<1e-5);
  Object.assign(projectile,{motion_origin:[716,-1088,25],velocity:[-5,0,3],motion_at:1500,world_tick:1500,received_at:600});
  h.bridge.renderEffects(state,800);draw=h.calls.filter(c=>c.name==='mpDrawSphere').at(-1);
  assert.equal(draw.position[0],715);assert.ok(Math.abs(draw.position[2]-(25+.6-.5*9.81*.04))<1e-5);
  projectile.phase='expired';h.bridge.renderEffects(state,900);
  assert.equal(h.calls.filter(c=>c.name==='mpDrawSphere').length,2);
});
