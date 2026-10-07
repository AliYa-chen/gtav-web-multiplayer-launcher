#!/usr/bin/env node
'use strict';
// 执行真实桥脚本与受控 native 替身；不实例化 WASM，也不读取游戏资源。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const engineSource = fs.readFileSync(path.join(root, 'client/multiplayer/engine-bridge.js'), 'utf8');
const adapterSource = fs.readFileSync(path.join(root, 'client/multiplayer/game-adapter.js'), 'utf8');
const manifestPath = path.join(root, 'archive/cache/native-replica.json');
// 缓存清理后也能执行：只导入构建器的接口常量，不解析或运行游戏二进制。
const builderManifest = fs.existsSync(manifestPath) ? null : spawnSync(process.env.PYTHON || 'python3', ['-B', '-c',
  'import json,sys; sys.path.insert(0,"tools"); from build_native_probe import export_map; print(json.dumps({"additional_exports":[{"export_name":name} for name in export_map(True)]}))'],
{ cwd: root, encoding: 'utf8' });
if (builderManifest && builderManifest.status !== 0) throw new Error(builderManifest.stderr || '不能读取 native 接口定义');
const nativeManifest = JSON.parse(builderManifest ? builderManifest.stdout : fs.readFileSync(manifestPath, 'utf8'));
const MAGIC = 0x4d505442;
const peerState = (changes = {}) => ({ position: [710, -1080, 22], model: 0x705e61f2, heading: 120, health: 200,
  weapon: 0x1b06d571, shooting: false, ...changes });
const packet = (changes = {}) => ({ connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }, { id: 'REMOTE' }],
  peers: [{ player_id: 'REMOTE', state: peerState() }], shots: [], ...changes });

function engine(options = {}) {
  const memory = { buffer: new SharedArrayBuffer(512 * 1024) };
  const calls = [];
  const messages = [];
  const alive = new Set([7]), blips = new Map();
  let now = 100, allocated = 4096, nextPed = 100, localPosition = [711.5, -1088, 22.41];
  let localPed = 7, localModel = options.localModel ?? 0x705e61f2;
  const state = { active: 11n, handler: 12n };
  const vector = (pointer, values) => values.forEach((value, index) => new DataView(memory.buffer).setFloat32(Number(pointer) + 8 * index, value, true));
  const implementations = {
    mpGetActiveThread: () => { if (options.throwActive) throw new Error('活动线程读取失败'); return state.active; },
    mpGetCurrentHandler: () => { if (options.throwHandler) throw new Error('handler 读取失败'); return state.handler; },
    mpGetPlayerPed: () => localPed,
    mpAlloc: (size) => { const pointer = allocated; allocated += Number(size); return BigInt(pointer); },
    mpGetEntityCoords: (pointer) => vector(pointer, localPosition),
    mpGetModel: () => localModel,
    mpPlayerId: () => 0,
    mpSetPlayerModel: (_player, model) => { localModel = model >>> 0; alive.delete(localPed); localPed = 8; alive.add(localPed); },
    mpDefaultVariation: () => {},
    mpHeading: () => 180,
    mpGetHealth: () => 200,
    mpIsShooting: () => false,
    mpSelectedWeapon: () => 0,
    mpHasModel: () => true,
    mpRequestModel: () => {},
    mpCreatePed: () => { alive.add(++nextPed); return nextPed; },
    mpExists: (ped) => alive.has(ped) ? 1 : 0,
    mpDeletePed: (pointer) => {
      const data = new DataView(memory.buffer), ped = data.getInt32(Number(pointer), true);
      alive.delete(ped); data.setInt32(Number(pointer), 0, true);
    },
    mpSetCoordsNoOffset: (ped, pointer) => { if (ped === localPed) localPosition = [0, 8, 16].map((offset) => new DataView(memory.buffer).getFloat32(Number(pointer) + offset, true)); },
    mpBlockEvents: () => {}, mpFreeze: () => {}, mpSetHeading: () => {}, mpGiveWeapon: () => {},
    mpSetCurrentWeapon: () => {}, mpTaskShootAtCoord: () => {}, mpSetHealth: () => {}, mpIsDead: () => 0,
    mpCamCoords: (pointer) => vector(pointer, [700, -1000, 25]), mpCamRot: (pointer) => vector(pointer, [0, 0, 0]),
    mpAddBlipForEntity: (ped) => { const blip = 1000 + ped; blips.set(blip, ped); return blip; },
    mpSetBlipColour: () => {}, mpSetBlipSprite: () => {}, mpSetBlipScale: () => {}, mpSetBlipAsShortRange: () => {},
    mpRemoveBlip: (pointer) => {
      const data = new DataView(memory.buffer); blips.delete(data.getInt32(Number(pointer), true));
      data.setInt32(Number(pointer), 0, true);
    },
    mpBeginSetBlipName: () => {}, mpAddTextPlayerSubstring: () => {}, mpEndSetBlipName: () => {},
  };
  const ex = {};
  for (const [name, implementation] of Object.entries(implementations)) ex[name] = (...arguments_) => {
    calls.push({ name, arguments: arguments_ });
    return implementation(...arguments_);
  };
  const self = { postMessage(value) { if (options.throwPost) throw new Error('页面已关闭'); messages.push(value); } };
  const context = vm.createContext({ self, performance: { now: () => now }, TextDecoder, TextEncoder, Atomics,
    Int32Array, Uint8Array, DataView, BigInt, SharedArrayBuffer });
  vm.runInContext(engineSource, context, { filename: 'engine-bridge.js' });
  const imports = { env: { memory, wasm_module_int_js: () => 0 } };
  self.prepareMultiplayerBridge(imports)({ exports: ex });
  const tick = (at = now + 100, thread = 11n) => { now = at; return imports.env.wasm_module_int_js(thread, MAGIC); };
  const setup = () => {
    tick(100);
    const message = messages.find((value) => value.multiplayer?.type === 'memory')?.multiplayer;
    assert.ok(message, '首次有效 tick 应分配共享快照');
    return message;
  };
  const publish = (value, odd = false) => {
    const shared = messages.find((entry) => entry.multiplayer?.type === 'memory')?.multiplayer;
    assert.ok(shared);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const header = new Int32Array(memory.buffer, shared.block, 4);
    const previous = Atomics.load(header, 0) & ~1;
    Atomics.store(header, 0, previous + 1);
    new Uint8Array(memory.buffer, shared.block + 16, shared.capacity).set(bytes);
    Atomics.store(header, 1, bytes.length);
    if (!odd) Atomics.store(header, 0, previous + 2);
  };
  return { memory, calls, messages, state, tick, setup, publish, alive, blips };
}

function adapter() {
  const channels = [], timers = new Map();
  let nextTimer = 1;
  class Channel {
    constructor(name) { this.name = name; this.posts = []; channels.push(this); }
    postMessage(value) { this.posts.push(value); }
    close() {}
  }
  const context = vm.createContext({ BroadcastChannel: Channel, TextEncoder, TextDecoder, Atomics, Int32Array,
    Uint8Array, DataView, SharedArrayBuffer, document: { getElementById: () => null }, addEventListener() {},
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(adapterSource.replace('export function installGameAdapter', 'function installGameAdapter') +
    '\nglobalThis.installAdapter = installGameAdapter;', context, { filename: 'game-adapter.js' });
  const api = context.installAdapter({});
  const memory = { buffer: new SharedArrayBuffer(8192) }, block = 256, capacity = 4096;
  api.onWorkerMessage({ multiplayer: { type: 'memory', memory, block, capacity } });
  const receive = (data) => channels[0].onmessage({ data });
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); };
  const read = () => {
    const header = new Int32Array(memory.buffer, block, 4);
    assert.equal(Atomics.load(header, 0) & 1, 0, '快照发布后序号必须为偶数');
    return JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, block + 16, Atomics.load(header, 1))));
  };
  return { api, receive, flush, read, channels };
}

test('native 上下文与错误通知异常都被吸收，允许 WASM 执行 TLS 清理', () => {
  for (const options of [{ throwActive: true }, { throwHandler: true }, { throwActive: true, throwPost: true }]) {
    const bridge = engine(options);
    assert.doesNotThrow(() => bridge.tick());
    assert.equal(bridge.calls.filter((call) => call.name === 'mpGetPlayerPed').length, 0);
  }
});

test('桥调用的 native 名称与实际构建器导出 manifest 一致', () => {
  const exports = new Set(nativeManifest.additional_exports.map((entry) => entry.export_name));
  for (const match of engineSource.matchAll(/\bex\.([A-Za-z_]\w*)/g)) {
    assert.ok(exports.has(match[1]), `缺少真实 WASM 导出 ${match[1]}`);
  }
});

test('无 handler 的线程不会消耗有效线程的节流窗口', () => {
  const bridge = engine();
  bridge.state.handler = 0n;
  bridge.tick(100);
  bridge.state.handler = 12n;
  bridge.tick(101);
  assert.ok(bridge.messages.some((value) => value.multiplayer?.type === 'memory'));
});

test('非法位置与写入中的序列锁快照不会创建或移动实体', () => {
  const bridge = engine(); bridge.setup();
  bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ position: [17000, 0, 0] }) }] }));
  bridge.tick(200);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] !== 7).length, 0);
  bridge.publish(packet(), true); bridge.tick(300);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 0);
});

test('正常实体创建使用 NoOffset；断线清理的是复制角色，不删除本地角色', () => {
  const bridge = engine(); bridge.setup(); bridge.publish(packet()); bridge.tick(200);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
  const replica = bridge.calls.find((call) => call.name === 'mpFreeze').arguments[0];
  assert.ok(bridge.alive.has(replica));
  bridge.publish(packet({ connected: false, members: [], peers: [] })); bridge.tick(300);
  assert.ok(!bridge.alive.has(replica)); assert.ok(bridge.alive.has(7));
  assert.equal(bridge.blips.size, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpDeletePed').length, 1);
});

test('中文昵称标记使用独立 NUL 终止 UTF-8 缓冲，不覆盖位置与删除句柄', () => {
  const bridge = engine(); bridge.setup();
  const nickname = '远端中文玩家';
  bridge.publish(packet({ members: [{ id: 'LOCAL', name: '本地' }, { id: 'REMOTE', name: nickname }] })); bridge.tick(200);
  assert.ok(!bridge.messages.some((message) => message.multiplayer?.type === 'bridge_error'));
  const label = bridge.calls.find((call) => call.name === 'mpBeginSetBlipName');
  const text = bridge.calls.find((call) => call.name === 'mpAddTextPlayerSubstring');
  const readString = (pointer) => {
    const bytes = new Uint8Array(bridge.memory.buffer, Number(pointer), 128);
    return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
  };
  assert.equal(readString(label.arguments[0]), 'STRING');
  assert.equal(readString(text.arguments[0]), nickname);
  assert.equal(Number(text.arguments[0]) - Number(label.arguments[0]), 32);
});

test('两名玩家在无远端状态时也出生在固定测试区，并且后续不被拉回', () => {
  const bridge = engine(); bridge.setup();
  const members = [{ id: 'REMOTE' }, { id: 'LOCAL' }];
  bridge.publish(packet({ members, peers: [] })); bridge.tick(200);
  const localMoves = bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === 7);
  assert.equal(localMoves.length, 1);
  const sample = bridge.messages.find((message) => message.multiplayer?.type === 'local_state').multiplayer.state;
  assert.ok(Math.abs(sample.position[0] - 713.5) < .001);
  assert.ok(Math.abs(sample.position[1] + 1088.1) < .001);
  assert.ok(Math.abs(sample.position[2] - 22.4) < .001);
  bridge.publish(packet({ members })); bridge.tick(300);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === 7).length, 1);
  const first = engine(); first.setup(); first.publish(packet({ peers: [] })); first.tick(200);
  const initial = first.messages.find((message) => message.multiplayer?.type === 'local_state').multiplayer.state;
  assert.ok(Math.abs(initial.position[0] - 711.5) < .001);
});

test('在线模型替换使用真实 PlayerId，换模后更新角色句柄并初始化衣服', () => {
  const bridge = engine({ localModel: 0x0d7114c9 }); bridge.setup();
  bridge.publish(packet({ peers: [], members: [{ id: 'LOCAL' }] })); bridge.tick(200);
  const change = bridge.calls.find((call) => call.name === 'mpSetPlayerModel');
  assert.deepEqual(change.arguments, [0, 0x705e61f2 | 0]);
  assert.ok(bridge.calls.some((call) => call.name === 'mpDefaultVariation' && call.arguments[0] === 8));
  assert.ok(bridge.calls.some((call) => call.name === 'mpGetEntityCoords' && call.arguments[1] === 8));
});

test('适配器保留未确认射击，后续状态快照不会覆盖丢失；确认后清理', () => {
  const page = adapter();
  page.receive({ type: 'session', connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }, { id: 'REMOTE' }], peers: [] });
  page.receive({ type: 'shot_event', player_id: 'REMOTE', event: { seq: 1, target: [1, 2, 3], origin: [0, 0, 0], weapon: 10 } });
  page.flush(); const shotId = page.read().shots[0].id;
  page.receive({ type: 'player_state', player_id: 'REMOTE', state: peerState() }); page.flush();
  assert.equal(page.read().shots[0].id, shotId);
  page.api.onWorkerMessage({ multiplayer: { type: 'shot_ack', ids: [shotId] } }); page.flush();
  assert.equal(page.read().shots.length, 0);
});

test('新序号快照重复包含同一射击时只调用一次 native，并再次确认', () => {
  const bridge = engine(); bridge.setup();
  const value = packet({ shots: [{ id: 1, player_id: 'REMOTE', event: { target: [715, -1080, 22], weapon: 0x1b06d571 } }] });
  bridge.publish(value); bridge.tick(200); bridge.publish(value); bridge.tick(300);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpTaskShootAtCoord').length, 1);
  assert.equal(bridge.messages.filter((message) => message.multiplayer?.type === 'shot_ack').length, 2);
});
