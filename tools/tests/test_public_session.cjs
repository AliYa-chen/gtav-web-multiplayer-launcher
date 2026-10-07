#!/usr/bin/env node
'use strict';
// 执行真实连接模块和受控 WebSocket / 时钟，不依赖游戏数据或 Java 运行环境。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const loadModule = (relative) => import('data:text/javascript;base64,' + Buffer.from(
  fs.readFileSync(path.join(root, relative), 'utf8')).toString('base64'));
const dependencies = Promise.all([
  loadModule('client/multiplayer/server-address.js'),
  loadModule('client/multiplayer/appearance.js'),
]);
const source = fs.readFileSync(path.join(root, 'client/multiplayer/public-session.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace('export async function startPublicSession', 'async function startPublicSession');
const capabilities = ['public_session', 'player_state', 'shoot_events', 'appearance', 'combat', 'resume', 'heartbeat', 'snapshot'];
const preferences = (name = '玩家甲') => ({ server: '183.66.27.21:47485', name, preset: 'npc_male', seed: 73 });
const playerState = (seq = 1) => ({ seq, position: [711.5, -1088.1, 22.4], heading: 90,
  model: 0x705e61f2, health: 200, weapon: 0x1b06d571, shooting: false });
const room = (id = 'LOCAL', extras = []) => ({ id: 'PUBLIC', map: 'gta5', phase: 'launched', host_id: null,
  members: [{ id, name: '玩家甲', connected: true }, ...extras] });
const copy = (value) => JSON.parse(JSON.stringify(value));

async function harness(options = {}) {
  const [addressModule, appearanceModule] = await dependencies;
  const storage = options.storage || new Map(), timers = new Map(), events = new Map(), sockets = [], statuses = [], logs = [];
  let now = 0, timerId = 0;
  const setTimeout = (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; };
  const clearTimeout = (id) => timers.delete(id);
  const listeners = (type) => events.get(type) || new Set();
  const addEventListener = (type, callback) => { const callbacks = listeners(type); callbacks.add(callback); events.set(type, callbacks); };
  const removeEventListener = (type, callback) => { listeners(type).delete(callback); };
  const document = { visibilityState: 'visible', addEventListener, removeEventListener };
  class Socket {
    static OPEN = 1;
    constructor(address) { this.address = address; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(value) { assert.equal(this.readyState, Socket.OPEN); this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.({}); }
    welcome(features = capabilities, id = 'TEMP') {
      this.readyState = Socket.OPEN;
      this.receive({ type: 'welcome', protocol: 1, client_id: id, capabilities: features });
    }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    messages(type) { return this.sent.filter((value) => value.type === type); }
  }
  const context = vm.createContext({ ...addressModule, ...appearanceModule, WebSocket: Socket,
    BroadcastChannel: class { constructor() { throw new Error('公共连接禁止跨标签页广播'); } },
    location: { href: 'http://localhost:8010/play/' }, performance: { now: () => now }, document,
    navigator: options.navigator || {},
    sessionStorage: { getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    fetch: (_url, request) => { logs.push(request.body); return Promise.resolve({ ok: true }); },
    setTimeout, clearTimeout, addEventListener, removeEventListener,
  });
  vm.runInContext(source + '\nglobalThis.startSession = startPublicSession;', context, { filename: 'public-session.js' });
  const profile = options.preferences || preferences();
  const identityKey = 'gta5.public.identity:ws://183.66.27.21:47485/ws:' + profile.name;
  if (options.identity) storage.set(identityKey, JSON.stringify(options.identity));
  const api = await context.startSession(profile, (value) => statuses.push(copy(value)), options.intent);
  api.ready.catch(() => {});
  function advance(milliseconds) {
    const end = now + milliseconds;
    let remaining = 10000;
    while (true) {
      const next = [...timers].filter(([_id, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(remaining--, '计时器不应无限递归');
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = end;
  }
  function enter(socket = sockets.at(-1), id = 'LOCAL', fields = {}, features = capabilities) {
    if (!socket.messages('hello').length) socket.welcome(features);
    socket.receive({ type: 'profile', client_id: id, name: profile.name, spawn: [711.5, -1088.1, 22.4],
      resume_token: 'private-resume-token', last_state_seq: 0, last_shot_seq: 0, ...fields });
    socket.receive({ type: 'room_state', room: room(id) });
    return socket;
  }
  return { api, context, enter, advance, sockets, statuses, storage, timers, logs, document, identityKey,
    event: (type) => { for (const callback of [...listeners(type)]) callback(); },
    jump: (milliseconds) => { now += milliseconds; }, active: () => sockets.filter((socket) => socket.readyState !== 3) };
}

test('远程连接由游戏页持有，首次接入就交付完整快照与独立状态通道', async () => {
  const page = await harness(); const socket = page.enter(); await page.api.ready;
  assert.equal(socket.address, 'ws://183.66.27.21:47485/ws');
  socket.receive({ type: 'room_state', room: room('LOCAL', [{ id: 'REMOTE', name: '玩家乙', connected: true }]) });
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [{ player_id: 'REMOTE', state: playerState() }] });
  socket.receive({ type: 'combat_state', players: [{ id: 'LOCAL', health: 200, alive: true, revision: 1 }] });
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  assert.equal(packets[0].type, 'session'); assert.equal(packets[0].client_id, 'LOCAL');
  assert.equal(packets[0].peers[0].player_id, 'REMOTE'); assert.equal(packets[0].combat[0].health, 200);
  assert.equal(packets[1].type, 'network_status'); assert.equal(packets[1].connected, true);
  assert.ok(page.logs.every((line) => !line.includes('private-resume-token')));
  page.api.close();
});

function fakeLocks() {
  const held = new Map(), requests = [];
  const manager = { request(name, options, callback) {
    assert.equal(options.ifAvailable, true); requests.push(name);
    if (held.has(name)) return Promise.resolve().then(() => callback(null));
    const owner = {}; held.set(name, owner);
    return Promise.resolve().then(() => callback({ name })).finally(() => {
      if (held.get(name) === owner) held.delete(name);
    });
  } };
  return { manager, held, requests };
}
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

test('恢复自己的后续 player_state 更新完整恢复快照，远端上报不会全量重发', async () => {
  const page = await harness({ identity: { client_id: 'SAME', resume_token: 'valid-token' }, intent: { reconnect: true } });
  const socket = page.enter(undefined, 'SAME');
  socket.receive({ type: 'room_state', room: room('SAME', [{ id: 'REMOTE', name: '玩家乙', connected: true }]) });
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [{ player_id: 'SAME', state: playerState(3) }] });
  await page.api.ready;
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  const count = packets.filter((value) => value.type === 'session').length;
  socket.receive({ type: 'player_state', room_id: 'PUBLIC', player_id: 'REMOTE', state: playerState(4) });
  assert.equal(packets.filter((value) => value.type === 'session').length, count);
  const updated = { ...playerState(5), position: [725, -1055, 24] };
  socket.receive({ type: 'player_state', room_id: 'PUBLIC', player_id: 'SAME', state: updated });
  const snapshot = packets.filter((value) => value.type === 'session').at(-1);
  assert.deepEqual(snapshot.resume_state, updated); assert.deepEqual(snapshot.resume_position, updated.position);
  page.api.close();
});

test('恢复已确认身份但未收到 world_state 时握手仍超时重试，首次 ready 限制不会悬挂', async () => {
  const page = await harness({ identity: { client_id: 'SAME', resume_token: 'valid-token' }, intent: { reconnect: true } });
  const socket = page.enter(undefined, 'SAME');
  const rejection = assert.rejects(page.api.ready, /连接超时/);
  page.advance(10000); assert.equal(socket.readyState, 3); assert.equal(page.statuses.at(-1).phase, 'reconnecting');
  page.advance(500); assert.equal(page.sockets.length, 2);
  page.advance(1500); await rejection;
  page.api.close(); assert.equal(page.timers.size, 0);
});

test('复制游戏页存储的新标签不能抢占已持锁身份，关闭原页面后刷新可恢复同一身份', async () => {
  const locks = fakeLocks(), storage = new Map();
  const first = await harness({ storage, navigator: { locks: locks.manager } });
  first.enter(undefined, 'ORIGINAL'); await first.api.ready; await settle();
  assert.equal(locks.held.size, 1);
  const duplicatedStorage = new Map(storage);
  const copied = await harness({ storage: duplicatedStorage, navigator: { locks: locks.manager }, intent: { reconnect: true } });
  const copiedSocket = copied.sockets[0]; copiedSocket.welcome();
  assert.ok(!Object.hasOwn(copiedSocket.messages('hello')[0], 'resume_token'));
  assert.equal(JSON.parse(storage.get(first.identityKey)).client_id, 'ORIGINAL', '新标签不能删除原标签恢复凭据');
  copied.enter(copiedSocket, 'COPY'); await copied.api.ready; await settle();
  assert.equal(locks.held.size, 2); assert.equal(JSON.parse(duplicatedStorage.get(copied.identityKey)).client_id, 'COPY');
  const originalSocket = first.sockets[0]; originalSocket.close();
  assert.equal(locks.held.size, 2, '网络断线必须继续保护原玩家身份');
  first.api.close(); await settle(); assert.equal(locks.held.size, 1);
  const refreshed = await harness({ storage, navigator: { locks: locks.manager }, intent: { reconnect: true } });
  const restoredSocket = refreshed.sockets[0]; restoredSocket.welcome();
  assert.equal(restoredSocket.messages('hello')[0].client_id, 'ORIGINAL');
  refreshed.enter(restoredSocket, 'ORIGINAL');
  restoredSocket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [] });
  await refreshed.api.ready; await settle(); assert.equal(locks.held.size, 2);
  copied.api.close(); refreshed.api.close(); await settle(); assert.equal(locks.held.size, 0);
});

test('锁申请尚未完成就关闭页面不会泄漏锁或额外创建连接', async () => {
  const locks = fakeLocks();
  const page = await harness({ navigator: { locks: locks.manager } });
  page.enter(undefined, 'LOCAL');
  page.api.close(); await settle();
  assert.equal(locks.held.size, 0); assert.equal(page.timers.size, 0); assert.equal(page.sockets.length, 1);
});

test('Web Locks 不可用时仍兼容身份恢复，恢复拒绝后的新 profile 释放旧锁', async () => {
  const disabled = await harness({ navigator: { locks: { request() { throw new Error('浏览器未启用锁'); } } },
    identity: { client_id: 'SAME', resume_token: 'valid-token' }, intent: { reconnect: true } });
  const disabledSocket = disabled.enter(undefined, 'SAME');
  assert.equal(disabledSocket.messages('hello')[0].client_id, 'SAME');
  disabledSocket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [] }); await disabled.api.ready; disabled.api.close();
  const locks = fakeLocks();
  const page = await harness({ navigator: { locks: locks.manager }, identity: { client_id: 'OLD', resume_token: 'expired' }, intent: { reconnect: true } });
  const socket = page.sockets[0]; socket.welcome();
  socket.receive({ type: 'error', code: 'resume_denied', message: '恢复已到期' }); page.enter(socket, 'NEW');
  await page.api.ready; await settle();
  assert.equal(locks.held.size, 1); assert.ok([...locks.held.keys()][0].endsWith(':NEW'));
  page.api.close(); await settle(); assert.equal(locks.held.size, 0);
});

test('两个同来源游戏页的外观、角色状态与射击只进入各自的服务端连接', async () => {
  const first = await harness({ preferences: { ...preferences('玩家甲'), seed: 10 } });
  const second = await harness({ preferences: { ...preferences('玩家乙'), seed: 20 } });
  const firstSocket = first.enter(undefined, 'FIRST'), secondSocket = second.enter(undefined, 'SECOND');
  const firstPackets = [], secondPackets = [];
  first.api.setReceiver((value) => firstPackets.push(copy(value)));
  second.api.setReceiver((value) => secondPackets.push(copy(value)));
  first.api.onWorkerMessage({ type: 'local_state', state: playerState() });
  first.api.onWorkerMessage({ type: 'local_shot', event: { origin: [711, -1088, 24], target: [720, -1088, 24], weapon: 1 } });
  assert.equal(firstSocket.messages('player_state').length, 1); assert.equal(firstSocket.messages('shot_event').length, 1);
  assert.equal(secondSocket.messages('player_state').length, 0); assert.equal(secondSocket.messages('shot_event').length, 0);
  assert.equal(firstPackets[0].seed, 10); assert.equal(secondPackets[0].seed, 20);
  first.api.close(); second.api.close();
});

test('断线后以指数退避重连，恢复相同身份与服务端序号，不重复创建连接', async () => {
  const page = await harness(); const first = page.enter();
  first.close(); assert.equal(page.statuses.at(-1).phase, 'reconnecting');
  page.advance(499); assert.equal(page.sockets.length, 1);
  page.advance(1); const next = page.sockets.at(-1); next.welcome();
  assert.equal(next.messages('hello')[0].client_id, 'LOCAL');
  assert.equal(next.messages('hello')[0].resume_token, 'private-resume-token');
  page.enter(next, 'LOCAL', { last_state_seq: 40, last_shot_seq: 60 });
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() });
  page.api.onWorkerMessage({ type: 'local_shot', event: { origin: [711, -1088, 24], target: [720, -1088, 24], weapon: 1 } });
  assert.equal(next.messages('player_state')[0].seq, 41); assert.equal(next.messages('shot_event')[0].seq, 61);
  assert.equal(page.active().length, 1);
  page.api.close();
});

test('服务端拒绝过期恢复凭据后在当前连接重新 hello，清除失效凭据', async () => {
  for (const code of ['resume_denied', 'invalid_resume', 'resume_expired']) {
    const page = await harness({ identity: { client_id: 'EXPIRED', resume_token: 'expired-secret' }, intent: { reconnect: true } });
    const socket = page.sockets[0]; socket.welcome();
    assert.equal(socket.messages('hello')[0].client_id, 'EXPIRED');
    socket.receive({ type: 'error', code, message: '恢复信息已到期' });
    assert.equal(page.sockets.length, 1); assert.equal(socket.readyState, 1);
    assert.equal(socket.messages('hello').length, 2);
    assert.ok(!Object.hasOwn(socket.messages('hello')[1], 'resume_token'));
    assert.equal(page.storage.has(page.identityKey), false);
    page.enter(socket, 'NEW'); await page.api.ready;
    assert.equal(page.statuses.at(-1).connected, true);
    const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
    assert.equal(packets[0].resumed, false); assert.equal(packets[0].resume_state, null);
    page.api.close();
  }
});

test('握手失败和连续连接错误逐步退避至五秒，旧连接事件不产生额外连接', async () => {
  const page = await harness();
  const delays = [500, 1000, 2000, 4000, 5000, 5000];
  for (const delay of delays) {
    const current = page.sockets.at(-1), staleError = current.onerror, staleClose = current.onclose;
    current.onerror(); staleError(); staleClose();
    const count = page.sockets.length;
    page.advance(delay - 1); assert.equal(page.sockets.length, count);
    page.advance(1); assert.equal(page.sockets.length, count + 1);
    assert.equal(page.active().length, 1);
  }
  page.api.close(); assert.equal(page.timers.size, 0);
});

test('应用心跳保持连接，周期快照补发，不受本地玩家帧上报影响', async () => {
  const page = await harness(); const socket = page.enter();
  for (let index = 0; index < 10; index++) {
    page.advance(5000);
    const ping = socket.messages('ping').at(-1);
    assert.ok(Number.isSafeInteger(ping.nonce));
    socket.receive({ type: 'pong', nonce: ping.nonce });
  }
  assert.equal(socket.messages('ping').length, 10); assert.equal(socket.messages('sync').length, 5);
  assert.equal(page.sockets.length, 1); page.api.close();
});

test('已连接但无服务器响应超过 25 秒会主动重连，单向上报不掩盖失联', async () => {
  const page = await harness(); const socket = page.enter();
  for (let index = 0; index < 5; index++) {
    page.api.onWorkerMessage({ type: 'local_state', state: playerState() }); page.advance(5000);
  }
  assert.equal(socket.readyState, 3); assert.equal(page.statuses.at(-1).phase, 'reconnecting');
  page.advance(500); assert.equal(page.sockets.length, 2); assert.equal(page.active().length, 1);
  assert.equal(socket.messages('ping').length, 4);
  page.api.close();
});

test('网络恢复或重回可见页面立即重连，并清除旧重连计时器', async () => {
  const page = await harness(); const first = page.enter(); first.close();
  page.event('online'); assert.equal(page.sockets.length, 2);
  page.advance(500); assert.equal(page.sockets.length, 2);
  const second = page.enter(); page.jump(26000);
  page.document.visibilityState = 'visible'; page.event('visibilitychange');
  assert.equal(second.readyState, 3); assert.equal(page.sockets.length, 3);
  page.api.close(); page.event('online'); page.event('visibilitychange'); page.advance(50000);
  assert.equal(page.sockets.length, 3); assert.equal(page.timers.size, 0);
});

test('普通射击拒绝、服务端修正与接收器异常均不注销在线身份', async () => {
  const page = await harness(); const socket = page.enter();
  page.api.setReceiver(() => { throw new Error('受控渲染失败'); });
  for (const code of ['rate_limited', 'stale_seq', 'invalid_shot', 'invalid_movement', 'not_ready', 'player_dead']) {
    socket.receive({ type: 'error', code, message: '本次操作未被接受' });
    assert.equal(page.statuses.at(-1).connected, true);
  }
  socket.receive({ type: 'correction', player_id: 'LOCAL', position: [711.5, -1088.1, 22.4] });
  assert.equal(page.sockets.length, 1); assert.equal(socket.readyState, 1); page.api.close();
});

test('游戏仍在加载时缓存复活命令，挂接接收器先发完整状态再回放，不重复回放', async () => {
  const page = await harness(); const socket = page.enter();
  socket.receive({ type: 'respawn', player_id: 'LOCAL', revision: 3, position: [711.5, -1088.1, 22.4] });
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  assert.equal(packets[0].type, 'session'); assert.equal(packets[0].connected, true);
  assert.equal(packets.at(-1).type, 'respawn');
  page.api.onWorkerMessage({ type: 'bridge_ready' });
  page.api.setReceiver((value) => packets.push(copy(value)));
  assert.equal(packets.filter((packet) => packet.type === 'respawn').length, 1);
  page.api.close();
});

test('服务端未声明能力时不发送新增 ping 或 sync，关闭清理全部计时器', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'TEMP', {}, ['public_session', 'player_state', 'shoot_events']);
  page.advance(10000); assert.equal(socket.messages('ping').length, 0); assert.equal(socket.messages('sync').length, 0);
  page.api.close(); assert.equal(page.timers.size, 0); page.advance(100000); assert.equal(page.sockets.length, 1);
});

test('刷新同一游戏页使用共享 sessionStorage 恢复身份，等待原位置和完整服装快照后再 ready', async () => {
  const storage = new Map();
  const first = await harness({ storage }); first.enter(undefined, 'SAME_PLAYER');
  await first.api.ready; first.api.close();
  const refreshed = await harness({ storage, intent: { reconnect: true } });
  const socket = refreshed.sockets[0]; socket.welcome();
  assert.equal(socket.messages('hello')[0].client_id, 'SAME_PLAYER');
  assert.equal(socket.messages('hello')[0].resume_token, 'private-resume-token');
  refreshed.enter(socket, 'SAME_PLAYER', { last_state_seq: 42, last_shot_seq: 30 });
  let ready = false; refreshed.api.ready.then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, false, 'room_state 不足以开始初始化恢复角色');
  const packets = []; refreshed.api.setReceiver((value) => packets.push(copy(value)));
  assert.equal(packets[0].resumed, true); assert.equal(packets[0].resume_state_ready, false);
  assert.equal(packets[0].resume_state, null);
  const state = { ...playerState(42), position: [824, -1262, 25], model: 0x23b88069,
    appearance: { components: Array.from({ length: 12 }, (_, index) => [index + 1, index % 3, index % 4]),
      props: Array.from({ length: 8 }, (_, index) => index % 2 ? [-1, -1] : [index + 1, index % 3]),
      overlays: Array.from({ length: 13 }, () => [255, 0, 0, 0, 0]), hair: [12, 3] } };
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [{ player_id: 'SAME_PLAYER', state }] });
  await refreshed.api.ready; assert.equal(ready, true);
  const restored = packets.filter((value) => value.type === 'session').at(-1);
  assert.equal(restored.resumed, true); assert.equal(restored.resume_state_ready, true);
  assert.deepEqual(restored.resume_position, state.position); assert.deepEqual(restored.resume_state, state);
  // 发给引擎的外观是副本，调用方修改不能污染后续服务端恢复快照。
  refreshed.api.setReceiver((value) => { if (value.resume_state) value.resume_state.appearance.components[0][0] = 999; });
  const verify = []; refreshed.api.setReceiver((value) => verify.push(copy(value)));
  assert.equal(verify[0].resume_state.appearance.components[0][0], 1);
  refreshed.api.onWorkerMessage({ type: 'local_state', state });
  assert.equal(socket.messages('player_state')[0].seq, 43);
  refreshed.api.close();
});

test('主动新加入不读取旧恢复凭据，选择的新模型和随机种子不会被旧外观覆盖', async () => {
  const storage = new Map();
  const previous = await harness({ storage }); previous.enter(undefined, 'OLD'); previous.api.close();
  const next = await harness({ storage, preferences: { ...preferences(), preset: 'npc_female', seed: 451 }, intent: { reconnect: false } });
  const socket = next.sockets[0]; socket.welcome();
  assert.ok(!Object.hasOwn(socket.messages('hello')[0], 'resume_token'));
  next.enter(socket, 'NEW'); await next.api.ready;
  const packets = []; next.api.setReceiver((value) => packets.push(copy(value)));
  assert.equal(packets[0].resumed, false); assert.equal(packets[0].preset, 'npc_female'); assert.equal(packets[0].seed, 451);
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [{ player_id: 'NEW', state: playerState() }] });
  const current = packets.filter((value) => value.type === 'session').at(-1);
  assert.equal(current.resume_state, null); assert.equal(current.resume_position, null);
  socket.close(); next.advance(500); const reconnected = next.sockets.at(-1); reconnected.welcome();
  assert.equal(reconnected.messages('hello')[0].client_id, 'NEW', '新加入完成后掉线仍恢复这次连接的身份');
  next.api.close();
});

test('恢复身份没有历史角色状态时，收到空 world_state 后允许正常出生，不永久等待', async () => {
  const page = await harness({ identity: { client_id: 'SAME', resume_token: 'valid-token' }, intent: { reconnect: true } });
  const socket = page.enter(undefined, 'SAME');
  let ready = false; page.api.ready.then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, false);
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [] });
  await page.api.ready; assert.equal(ready, true);
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  assert.equal(packets[0].resumed, true); assert.equal(packets[0].resume_state_ready, true);
  assert.equal(packets[0].resume_state, null); page.api.close();
});

test('仅发送过有效凭据且 profile 返回相同身份时才标记 resumed', async () => {
  const cases = [
    { identity: { client_id: 'OLD', resume_token: 'valid-token' }, id: 'DIFFERENT' },
    { identity: { client_id: 'OLD', resume_token: { bad: true } }, id: 'OLD' },
    { identity: { client_id: '', resume_token: 'valid-token' }, id: 'NEW' },
  ];
  for (const entry of cases) {
    const page = await harness({ identity: entry.identity, intent: { reconnect: true } });
    page.enter(undefined, entry.id); await page.api.ready;
    const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
    assert.equal(packets[0].resumed, false); assert.equal(packets[0].resume_state, null);
    page.api.close();
  }
});
