#!/usr/bin/env node
'use strict';
// 执行真实连接模块和受控 WebSocket / 时钟，不依赖游戏数据或 Java 运行环境。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const i18nUrl = 'data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(root, 'client/i18n.js'), 'utf8')).toString('base64');
const appearanceUrl = 'data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(root, 'client/multiplayer/appearance.js'), 'utf8')).toString('base64');
const loadModule = (relative) => import('data:text/javascript;base64,' + Buffer.from(
  fs.readFileSync(path.join(root, relative), 'utf8').replace("'../i18n.js'", JSON.stringify(i18nUrl))).toString('base64'));
const dependencies = Promise.all([
  import(i18nUrl),
  loadModule('client/multiplayer/server-address.js'),
  loadModule('client/multiplayer/appearance.js'),
  import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(root, 'client/multiplayer/world-state.js'), 'utf8')
    .replace("'./appearance.js'", JSON.stringify(appearanceUrl))).toString('base64')),
]);
const source = fs.readFileSync(path.join(root, 'client/multiplayer/public-session.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace('export async function startPublicSession', 'async function startPublicSession');
const capabilities = ['public_session', 'player_state', 'shoot_events', 'appearance', 'combat', 'resume', 'heartbeat', 'snapshot', 'actions', 'combat_feedback'];
const preferences = (name = '玩家甲') => ({ server: '183.66.27.21:47485', name, preset: 'npc_male', seed: 73 });
const playerState = (seq = 1) => ({ seq, position: [711.5, -1088.1, 22.4], heading: 90,
  model: 0x705e61f2, health: 200, weapon: 0x1b06d571, shooting: false });
const room = (id = 'LOCAL', extras = []) => ({ id: 'PUBLIC', map: 'gta5', phase: 'launched', host_id: null,
  members: [{ id, name: '玩家甲', connected: true }, ...extras] });
const copy = (value) => JSON.parse(JSON.stringify(value));
const actionState = (changes = {}) => ({ aiming: false, reloading: false, jumping: false, ducking: false, sprinting: false, ...changes });
const shotEvent = (weapon = playerState().weapon) => ({ origin: [711, -1088, 24], target: [720, -1088, 24], weapon });

async function harness(options = {}) {
  const [i18nModule, addressModule, appearanceModule, worldModule] = await dependencies;
  i18nModule.setLanguage(options.language || 'zh-CN');
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
    constructor(address) { this.address = address; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; this.sentTimes = []; sockets.push(this); }
    send(value) {
      assert.equal(this.readyState, Socket.OPEN);
      const parsed = JSON.parse(value);
      if (this.failSendType === parsed.type) throw new Error('受控连接发送失败');
      this.sent.push(parsed);
      this.sentTimes.push({ type: parsed.type, at: now });
    }
    close() { this.readyState = 3; this.onclose?.({}); }
    welcome(features = capabilities, id = 'TEMP') {
      this.readyState = Socket.OPEN;
      this.receive({ type: 'welcome', protocol: 1, client_id: id, capabilities: features,
        ...(Object.hasOwn(options, 'sessionPolicy') ? { session_policy: options.sessionPolicy } : {}),
        ...(Object.hasOwn(options, 'weaponRules') ? { weapon_rules: options.weaponRules } : {}) });
    }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    messages(type) { return this.sent.filter((value) => value.type === type); }
  }
  const context = vm.createContext({ ...i18nModule, ...addressModule, ...appearanceModule, ...worldModule, WebSocket: Socket,
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
  return { api, context, i18nModule, enter, advance, sockets, statuses, storage, timers, logs, document, identityKey,
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

test('从远程线路取得的 WSS 代理路径在建连和自动重连时保持完整', async () => {
  const [, addresses] = await dependencies;
  const server = addresses.normalizeRemoteServerAddress({ address: 'gtaserver.2t.hk:47485',
    health_url: 'https://gtaserver.2t.hk:47485/47485/health' });
  const page = await harness({ preferences: { ...preferences(), server } });
  const first = page.enter(); await page.api.ready;
  assert.equal(first.address, 'wss://gtaserver.2t.hk:47485/47485/ws');
  first.close(); page.advance(2500);
  assert.ok(page.sockets.length > 1);
  assert.ok(page.sockets.every((socket) => socket.address === server));
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
  first.api.onWorkerMessage({ type: 'local_shot', event: { origin: [711, -1088, 24], target: [720, -1088, 24], weapon: playerState().weapon } });
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
  page.api.onWorkerMessage({ type: 'local_shot', event: { origin: [711, -1088, 24], target: [720, -1088, 24], weapon: playerState().weapon } });
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

test('行为状态与瞄准点只在服务端支持时传送，合法完整字段保持一致', async () => {
  const page = await harness(); const socket = page.enter();
  assert.ok(socket.messages('hello')[0].capabilities.includes('actions'));
  assert.ok(socket.messages('hello')[0].capabilities.includes('combat_feedback'));
  const state = { ...playerState(), actions: actionState({ aiming: true, sprinting: true }), aim_target: [750, -1075, 24] };
  page.api.onWorkerMessage({ type: 'local_state', state });
  assert.deepEqual(socket.messages('player_state')[0].actions, state.actions);
  assert.deepEqual(socket.messages('player_state')[0].aim_target, state.aim_target);
  socket.receive({ type: 'room_state', room: room('LOCAL', [{ id: 'REMOTE', name: '玩家乙' }]) });
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [{ player_id: 'REMOTE', state }] });
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  assert.deepEqual(packets[0].peers[0].state.actions, state.actions);
  assert.deepEqual(packets[0].peers[0].state.aim_target, state.aim_target);
  page.api.close();
  const legacy = await harness(); const oldSocket = legacy.enter(undefined, 'LOCAL', {}, capabilities.filter((feature) => !['actions', 'combat_feedback'].includes(feature)));
  legacy.api.onWorkerMessage({ type: 'local_state', state });
  assert.ok(!Object.hasOwn(oldSocket.messages('player_state')[0], 'actions'));
  assert.ok(!Object.hasOwn(oldSocket.messages('player_state')[0], 'aim_target'));
  assert.ok(!oldSocket.messages('hello')[0].capabilities.includes('combat_feedback')); legacy.api.close();
});

test('行为固定布尔键与瞄准坐标严格校验，非法本地快照不会上传或触发断线', async () => {
  const page = await harness(); const socket = page.enter();
  const invalid = [
    { actions: { aiming: true } }, { actions: { ...actionState(), sprinting: 1 } },
    { actions: { ...actionState(), custom: false } }, { actions: [] }, { actions: null },
    { aim_target: [17000, 1, 1] }, { aim_target: ['1', 1, 1] }, { aim_target: [1, 2] }, { aim_target: null },
  ];
  for (const fields of invalid) {
    page.api.onWorkerMessage({ type: 'local_state', state: { ...playerState(), ...fields } });
    page.advance(50);
  }
  assert.equal(socket.messages('player_state').length, 0); assert.equal(page.sockets.length, 1);
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() });
  assert.equal(socket.messages('player_state').length, 1, '旧版没有行为字段的状态仍可上报'); page.api.close();
});

test('快换枪时强制提前发送待同步的新武器状态，状态始终排在射击事件前', async () => {
  const page = await harness(); const socket = page.enter();
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() }); page.advance(40);
  const weapon = 0x83bf0278, next = { ...playerState(), weapon, actions: actionState({ aiming: true }), aim_target: [750, -1075, 24] };
  page.api.onWorkerMessage({ type: 'local_state', state: next });
  assert.equal(socket.messages('player_state').length, 1, '普通状态仍有50毫秒节流');
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(weapon) });
  assert.deepEqual(socket.sent.slice(-2).map((message) => message.type), ['player_state', 'shot_event']);
  assert.equal(socket.sent.at(-2).weapon, weapon); assert.equal(socket.sent.at(-1).weapon, weapon);
  assert.equal(socket.messages('player_state').length, 2); page.advance(10);
  assert.equal(socket.messages('player_state').length, 2, '原延迟计时器必须取消，不能再重复上报'); page.api.close();
});

test('射击携带的同帧完整状态优先于旧待发快照，并避免重复发送刚成功的同一状态', async () => {
  const page = await harness(); const socket = page.enter();
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() }); page.advance(40);
  page.api.onWorkerMessage({ type: 'local_state', state: { ...playerState(), weapon: 0x83bf0278 } });
  const shotState = { ...playerState(), position: [712, -1087, 22.4], weapon: 0xbfefff6d, shooting: true,
    actions: actionState({ aiming: true }), aim_target: [725, -1080, 24] };
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(shotState.weapon), state: shotState });
  assert.equal(socket.sent.at(-2).weapon, shotState.weapon);
  assert.deepEqual(socket.sent.at(-2).position, shotState.position); assert.equal(socket.sent.at(-1).type, 'shot_event');
  page.advance(50); const count = socket.messages('player_state').length;
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(shotState.weapon), state: shotState });
  assert.equal(socket.messages('player_state').length, count); assert.equal(socket.messages('shot_event').length, 2);
  page.api.close();
});

test('发送失败、背压、无状态和不同武器状态均不能越过状态步骤单独发送射击', async () => {
  const page = await harness(); const socket = page.enter();
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent() });
  assert.equal(socket.messages('shot_event').length, 0, '没有本地状态不能让服务器猜测玩家武器');
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() }); page.advance(50);
  const next = { ...playerState(), weapon: 0x83bf0278 };
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(next.weapon), state: playerState() });
  assert.equal(socket.messages('shot_event').length, 0, '射击与快照武器不一致不能发送');
  socket.bufferedAmount = 65537;
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(next.weapon), state: next });
  assert.equal(socket.messages('shot_event').length, 0);
  socket.bufferedAmount = 0; socket.failSendType = 'player_state';
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(next.weapon), state: next });
  assert.equal(socket.messages('shot_event').length, 0, '状态 send 抛错不能紧接着发送射击');
  socket.failSendType = null; page.advance(50);
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(next.weapon), state: next });
  assert.equal(socket.sent.at(-1).type, 'shot_event'); assert.equal(socket.messages('player_state').at(-1).seq, 2,
    '发送失败不能推进已经确认发送的状态序号'); page.api.close();
});

test('强制射击状态仍遵守30Hz预算，射击事件不超过20Hz', async () => {
  const page = await harness(); const socket = page.enter();
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() }); page.advance(10);
  const next = { ...playerState(), position: [712, -1087, 22.4] };
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: next });
  assert.equal(socket.messages('player_state').length, 1); assert.equal(socket.messages('shot_event').length, 0);
  page.advance(29); assert.equal(socket.messages('shot_event').length, 0);
  page.advance(1);
  assert.equal(socket.messages('shot_event').length, 1);
  assert.ok(socket.sentTimes.filter((entry) => entry.type === 'player_state')[1].at >= 1000 / 30);
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: next });
  page.advance(49);
  assert.equal(socket.messages('shot_event').length, 1); page.advance(1);
  assert.equal(socket.messages('shot_event').length, 2);
  const shots = socket.sentTimes.filter((entry) => entry.type === 'shot_event');
  assert.ok(shots[1].at - shots[0].at >= 50); page.api.close();
});

test('短暂背压解除后自动发送最新一条单发，先发送对应新武器状态，不要求再次扣动扳机', async () => {
  const page = await harness(); const socket = page.enter();
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() }); page.advance(50);
  socket.bufferedAmount = 70000;
  const state = { ...playerState(), weapon: 0x83bf0278 };
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(state.weapon), state });
  page.advance(50);
  const latest = { ...shotEvent(state.weapon), target: [727, -1086, 24] };
  page.api.onWorkerMessage({ type: 'local_shot', event: latest, state });
  assert.equal(socket.messages('shot_event').length, 0);
  socket.bufferedAmount = 0; page.advance(10);
  assert.deepEqual(socket.sent.slice(-2).map((message) => message.type), ['player_state', 'shot_event']);
  assert.equal(socket.sent.at(-2).weapon, state.weapon); assert.deepEqual(socket.sent.at(-1).target, latest.target);
  page.advance(500); assert.equal(socket.messages('shot_event').length, 1, '队列只能保留最新一条，不补发过时的连续射线');
  page.api.close();
});

test('状态发送暂时失败后自动补上同一次射击，状态与射击各只成功发送一次', async () => {
  const page = await harness(); const socket = page.enter();
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() }); page.advance(50);
  const state = { ...playerState(), weapon: 0x83bf0278 };
  socket.failSendType = 'player_state';
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(state.weapon), state });
  page.advance(30); assert.equal(socket.messages('shot_event').length, 0);
  socket.failSendType = null; page.advance(20);
  assert.deepEqual(socket.sent.slice(-2).map((message) => message.type), ['player_state', 'shot_event']);
  assert.equal(socket.messages('player_state').at(-1).seq, 2); assert.equal(socket.messages('shot_event')[0].seq, 1);
  page.advance(200); assert.equal(socket.messages('shot_event').length, 1); page.api.close();
});

test('超过250毫秒的待发射击、换枪后的旧射击和断线前射击均清除，不重放过期动作', async () => {
  const expired = await harness(); const expiredSocket = expired.enter();
  expiredSocket.bufferedAmount = 70000;
  expired.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: playerState() });
  expired.advance(251); expiredSocket.bufferedAmount = 0; expired.advance(50);
  assert.equal(expiredSocket.messages('shot_event').length, 0); expired.api.close();
  const swapped = await harness(); const swappedSocket = swapped.enter();
  swappedSocket.bufferedAmount = 70000;
  swapped.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: playerState() });
  swapped.api.onWorkerMessage({ type: 'local_state', state: { ...playerState(), weapon: 0x83bf0278 } });
  swappedSocket.bufferedAmount = 0; swapped.advance(100);
  assert.equal(swappedSocket.messages('shot_event').length, 0); swapped.api.close();
  const disconnected = await harness(); const first = disconnected.enter(); first.bufferedAmount = 70000;
  disconnected.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: playerState() });
  first.close(); disconnected.advance(500); const second = disconnected.enter(undefined, 'LOCAL');
  disconnected.advance(100); assert.equal(second.messages('shot_event').length, 0);
  disconnected.api.close(); assert.equal(disconnected.timers.size, 0, '关闭时必须清理射击和状态重试计时器');
  const closed = await harness(); const closingSocket = closed.enter(); closingSocket.bufferedAmount = 70000;
  closed.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: playerState() });
  closed.api.close(); assert.equal(closed.timers.size, 0);
  closingSocket.bufferedAmount = 0; closed.advance(1000);
  assert.equal(closingSocket.messages('shot_event').length, 0, '关闭战局后待发事件不能通过旧计时器继续上传');
});

test('旧版没有同帧射击快照仍使用待同步状态，旧服务器剥离动作后同帧比较不重复发送状态', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, capabilities.filter((feature) => feature !== 'actions'));
  const state = { ...playerState(), actions: actionState({ aiming: true }), aim_target: [720, -1088, 24] };
  page.api.onWorkerMessage({ type: 'local_state', state });
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state });
  assert.equal(socket.messages('player_state').length, 1); assert.equal(socket.messages('shot_event').length, 1);
  page.advance(10);
  const next = { ...state, weapon: 0x83bf0278 };
  page.api.onWorkerMessage({ type: 'local_state', state: next });
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(next.weapon) });
  assert.equal(socket.messages('shot_event').length, 1);
  page.advance(40); assert.equal(socket.messages('shot_event').length, 2);
  assert.equal(socket.messages('player_state').at(-1).weapon, next.weapon);
  assert.ok(socket.messages('player_state').every((message) => !Object.hasOwn(message, 'actions')));
  page.api.close();
});

test('服务端命中和拒绝反馈不注销玩家身份，日志区分结果且不包含坐标或恢复凭据', async () => {
  const page = await harness(); const socket = page.enter();
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  const results = [
    { seq: 1, weapon: 0x83bf0278, accepted: true, hit: false },
    { seq: 2, weapon: 0x83bf0278, accepted: true, hit: true, victim_id: 'REMOTE', damage: 40, health: 160, revision: 2 },
    { seq: 3, weapon: 0xb1ca77b1, accepted: false, hit: false, reason: 'unsupported_weapon' },
    { seq: 4, weapon: 0x83bf0278, accepted: false, hit: false, reason: 'weapon_mismatch' },
  ];
  for (const result of results) socket.receive({ type: 'shot_result', ...result });
  assert.deepEqual(packets.filter((value) => value.type === 'combat_feedback'), results.map((result) => ({ type: 'combat_feedback', ...result })));
  const logs = page.logs.filter((line) => line.startsWith('[public-combat] ')).map((line) => JSON.parse(line.slice('[public-combat] '.length)));
  assert.equal(logs.length, 4); assert.equal(logs[0].hit, false); assert.equal(logs[1].hit, true);
  assert.equal(logs[2].reason, 'unsupported_weapon'); assert.equal(logs[2].accepted, false);
  assert.ok(logs.every((value) => value.stage === 'result'
    && Object.keys(value).every((key) => ['stage', 'client_id', 'seq', 'weapon', 'accepted', 'hit', 'reason', 'victim_id', 'damage', 'health', 'revision'].includes(key))));
  assert.equal(logs[1].client_id, 'LOCAL'); assert.equal(logs[1].victim_id, 'REMOTE'); assert.equal(logs[1].revision, 2);
  assert.equal(logs[1].damage, 40); assert.equal(logs[1].health, 160);
  assert.ok(page.logs.every((line) => !line.includes('private-resume-token')));
  assert.equal(socket.readyState, 1); assert.equal(page.sockets.length, 1); page.api.close();
});

test('实际服务器省略 hit 的拒绝反馈仍记录结果并提示，成功结果缺少 hit 则忽略', async () => {
  const page = await harness(); const socket = page.enter(), packets = [];
  page.api.setReceiver((value) => packets.push(copy(value)));
  socket.receive({ type: 'shot_result', seq: 1, weapon: 0xb1ca77b1, accepted: false,
    reason: 'unsupported_weapon', message: '暂不支持此武器' });
  assert.deepEqual(packets.filter((value) => value.type === 'combat_feedback'), [{
    type: 'combat_feedback', seq: 1, weapon: 0xb1ca77b1, accepted: false, hit: false, reason: 'unsupported_weapon' }]);
  const results = page.logs.filter((line) => line.startsWith('[public-combat] ')).map((line) => JSON.parse(line.slice('[public-combat] '.length)));
  assert.deepEqual(results, [{ stage: 'result', client_id: 'LOCAL', seq: 1, weapon: 0xb1ca77b1, accepted: false, hit: false, reason: 'unsupported_weapon' }]);
  socket.receive({ type: 'shot_result', seq: 2, weapon: 1, accepted: true });
  socket.receive({ type: 'shot_result', seq: 2, weapon: 1, accepted: false, hit: true, reason: 'invalid_shot' });
  socket.receive({ type: 'shot_result', seq: 2, weapon: 1, accepted: false, hit: null, reason: 'invalid_shot' });
  assert.equal(packets.filter((value) => value.type === 'combat_feedback').length, 1);
  assert.equal(socket.readyState, 1); page.api.close();
});

test('射击成功发送才记录 sent 阶段，等待、失败、过期不制造日志且不包含坐标昵称或凭据', async () => {
  const page = await harness(); const socket = page.enter();
  const combatLogs = () => page.logs.filter((line) => line.startsWith('[public-combat] ')).map((line) => JSON.parse(line.slice('[public-combat] '.length)));
  socket.failSendType = 'shot_event';
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: playerState() });
  page.advance(30); assert.deepEqual(combatLogs(), []);
  socket.failSendType = null; page.advance(10);
  assert.deepEqual(combatLogs(), [{ stage: 'sent', client_id: 'LOCAL', seq: 1, weapon: playerState().weapon }]);
  socket.receive({ type: 'shot_result', seq: 1, weapon: playerState().weapon, accepted: true, hit: false });
  assert.deepEqual(combatLogs().map((value) => value.stage), ['sent', 'result']);
  socket.bufferedAmount = 70000;
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: playerState() });
  page.advance(300); assert.equal(combatLogs().length, 2);
  const sent = combatLogs()[0]; assert.deepEqual(Object.keys(sent).sort(), ['client_id', 'seq', 'stage', 'weapon']);
  assert.ok(combatLogs().every((value) => !['position', 'origin', 'target', 'name', 'resume_token'].some((key) => Object.hasOwn(value, key))));
  page.api.close();
});

test('重复、非法和未协商的射击反馈被忽略，旧版普通武器错误也不会触发重连', async () => {
  const page = await harness(); const socket = page.enter(), packets = [];
  page.api.setReceiver((value) => packets.push(copy(value)));
  socket.receive({ type: 'shot_result', seq: 5, weapon: 1, accepted: true, hit: false });
  socket.receive({ type: 'shot_result', seq: 5, weapon: 1, accepted: true, hit: false });
  for (const invalid of [{ seq: -1 }, { hit: 'yes' }, { accepted: false, hit: true }, { damage: 1000 },
    { health: -1 }, { victim_id: {} }, { reason: 'untrusted message' }]) {
    socket.receive({ type: 'shot_result', seq: 6, weapon: 1, accepted: true, hit: false, ...invalid });
  }
  assert.equal(packets.filter((value) => value.type === 'combat_feedback').length, 1); assert.equal(socket.readyState, 1);
  page.api.close();
  const legacy = await harness(); const oldSocket = legacy.enter(undefined, 'LOCAL', {}, capabilities.filter((feature) => feature !== 'combat_feedback'));
  const oldPackets = []; legacy.api.setReceiver((value) => oldPackets.push(copy(value)));
  oldSocket.receive({ type: 'shot_result', seq: 1, weapon: 1, accepted: true, hit: false });
  assert.equal(oldPackets.filter((value) => value.type === 'combat_feedback').length, 0);
  oldSocket.receive({ type: 'error', code: 'unsupported_weapon', message: 'unsupported weapon' });
  assert.equal(legacy.statuses.at(-1).connected, true); assert.ok(legacy.statuses.at(-1).text.includes('武器目录'));
  assert.equal(oldSocket.readyState, 1); legacy.api.close();
});

test('战斗反馈的原生通知明确说明武器不支持，命中限频，普通未命中不刷屏', () => {
  const source = fs.readFileSync(path.join(root, 'client/multiplayer/game-adapter.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace('export function installGameAdapter', 'function installGameAdapter');
  let now = 0, receiver = null;
  const hud = { textContent: '', style: {} }, memory = { buffer: new SharedArrayBuffer(8192) }, block = 256, capacity = 4096;
  const callbacks = new Map(); let nextTimer = 0;
  const context = vm.createContext({ getLanguage: () => 'zh-CN', onLanguageChange: () => () => {}, translateText: value => value, TextEncoder, Atomics, Int32Array, Uint8Array,
    BroadcastChannel: class { close() {} }, addEventListener() {}, document: { getElementById: () => hud },
    performance: { now: () => now }, fetch: () => Promise.resolve({ ok: true }),
    setTimeout: (callback) => { callbacks.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => callbacks.delete(id) });
  vm.runInContext(source + '\nglobalThis.installAdapter=installGameAdapter;', context);
  const adapter = context.installAdapter({}, { setReceiver: (value) => { receiver = value; }, onWorkerMessage() {} });
  adapter.onWorkerMessage({ multiplayer: { type: 'memory', memory, block, capacity } });
  const read = () => {
    for (const callback of [...callbacks.values()]) callback(); callbacks.clear();
    return JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, block + 16, Atomics.load(new Int32Array(memory.buffer, block, 4), 1))));
  };
  receiver({ type: 'combat_feedback', accepted: true, hit: false }); assert.equal(read().notices.length, 0);
  receiver({ type: 'combat_feedback', accepted: false, hit: false, reason: 'unsupported_weapon' });
  assert.ok(hud.textContent.includes('普通枪械')); assert.ok(read().notices[0].text.includes('一般槍械'));
  receiver({ type: 'combat_feedback', accepted: false, hit: false, reason: 'unsupported_weapon' });
  assert.equal(read().notices.length, 1, '相同拒绝不能每个射击 tick 盖满原生通知');
  receiver({ type: 'combat_feedback', accepted: true, hit: true, damage: 40, health: 160 });
  assert.equal(read().notices.length, 2); assert.ok(read().notices.at(-1).text.includes('傷害 40'));
  receiver({ type: 'combat_feedback', accepted: true, hit: true, damage: 40, health: 120 }); assert.equal(read().notices.length, 2);
  now = 1501; receiver({ type: 'combat_feedback', accepted: true, hit: true, damage: 40, health: 80 }); assert.equal(read().notices.length, 3);
});

test('战斗快照按每名玩家独立保持 revision 单调，周期完整快照不会把已重生角色改回尸体', async () => {
  const page = await harness(); const socket = page.enter();
  socket.receive({ type: 'room_state', room: room('LOCAL', [{ id: 'REMOTE', name: '玩家乙' }]) });
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  socket.receive({ type: 'combat_state', room_id: 'PUBLIC', players: [
    { id: 'LOCAL', health: 175, alive: true, revision: 9 },
    { id: 'REMOTE', health: 200, alive: true, revision: 5, kills: 2, deaths: 1, spawn: [711.5, -1088.1, 22.4] }] });
  socket.receive({ type: 'combat_state', room_id: 'PUBLIC', players: [
    { id: 'LOCAL', health: 100, alive: true, revision: 10 },
    { id: 'REMOTE', health: 0, alive: false, revision: 4, deaths: 1 }] });
  const merged = packets.filter((value) => value.type === 'combat_state').at(-1).players;
  assert.equal(merged.find((player) => player.id === 'LOCAL').revision, 10);
  assert.equal(merged.find((player) => player.id === 'REMOTE').health, 200);
  socket.receive({ type: 'room_state', room: room('LOCAL', [{ id: 'REMOTE', name: '玩家乙' }]) });
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [] });
  const snapshot = packets.filter((value) => value.type === 'session').at(-1);
  assert.equal(snapshot.combat.find((player) => player.id === 'REMOTE').alive, true);
  assert.equal(snapshot.combat.find((player) => player.id === 'REMOTE').revision, 5);
  page.api.close();
});

test('伤害死亡重生立即合并权威版本，先发布新状态再发控制，并阻止旧事件重新杀死已重生玩家', async () => {
  const page = await harness(); const socket = page.enter();
  socket.receive({ type: 'room_state', room: room('LOCAL', [{ id: 'REMOTE', name: '玩家乙' }]) });
  socket.receive({ type: 'combat_state', players: [{ id: 'REMOTE', health: 200, alive: true, revision: 1, deaths: 0 }] });
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  socket.receive({ type: 'damage', victim_id: 'REMOTE', attacker_id: 'LOCAL', health: 0, damage: 40, revision: 2 });
  assert.equal(packets.at(-2).type, 'session'); assert.equal(packets.at(-1).type, 'damage');
  assert.equal(packets.at(-2).combat.find((player) => player.id === 'REMOTE').alive, false);
  socket.receive({ type: 'death', player_id: 'REMOTE', killer_id: 'LOCAL', deaths: 1, revision: 2 });
  assert.equal(packets.at(-2).combat.find((player) => player.id === 'REMOTE').deaths, 1,
    'damage 与 death 共用 revision，等版本 death 仍须补齐阵亡计数');
  socket.receive({ type: 'respawn', player_id: 'REMOTE', health: 200, position: [711.5, -1088.1, 22.4], revision: 3 });
  const revived = packets.at(-2).combat.find((player) => player.id === 'REMOTE');
  assert.equal(revived.alive, true); assert.equal(revived.health, 200); assert.equal(revived.revision, 3);
  assert.deepEqual(revived.spawn, [711.5, -1088.1, 22.4]);
  const count = packets.length;
  socket.receive({ type: 'death', player_id: 'REMOTE', revision: 2 });
  socket.receive({ type: 'damage', victim_id: 'REMOTE', health: 0, damage: 40, revision: 2 });
  assert.equal(packets.length, count, '旧控制事件不能再交给引擎或产生第二条死亡提示');
  socket.receive({ type: 'combat_state', players: [{ id: 'REMOTE', health: 0, alive: false, revision: 2 }] });
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [] });
  const current = packets.filter((value) => value.type === 'session').at(-1).combat.find((player) => player.id === 'REMOTE');
  assert.equal(current.revision, 3); assert.equal(current.alive, true); assert.equal(current.health, 200);
  page.api.close();
});

test('移动序号只拒绝严格旧序号，同序号的服务器伤害和重生仍更新生命及出生位置', async () => {
  const page = await harness(); const socket = page.enter();
  socket.receive({ type: 'room_state', room: room('LOCAL', [{ id: 'REMOTE', name: '玩家乙' }]) });
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  socket.receive({ type: 'player_state', room_id: 'PUBLIC', player_id: 'REMOTE', state: playerState(20) });
  const before = packets.filter((value) => value.type === 'player_state').length;
  socket.receive({ type: 'player_state', room_id: 'PUBLIC', player_id: 'REMOTE', state: { ...playerState(19), position: [100, 100, 20] } });
  assert.equal(packets.filter((value) => value.type === 'player_state').length, before);
  socket.receive({ type: 'player_state', room_id: 'PUBLIC', player_id: 'REMOTE', state: { ...playerState(20), health: 0, shooting: false } });
  assert.equal(packets.filter((value) => value.type === 'player_state').at(-1).state.health, 0);
  const spawn = [713.5, -1088.1, 22.4];
  socket.receive({ type: 'player_state', room_id: 'PUBLIC', player_id: 'REMOTE', state: { ...playerState(20), position: spawn, health: 200 } });
  assert.deepEqual(packets.filter((value) => value.type === 'player_state').at(-1).state.position, spawn);
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [{ player_id: 'REMOTE', state: { ...playerState(19), position: [100, 100, 20] } }] });
  let snapshot = packets.filter((value) => value.type === 'session').at(-1);
  assert.deepEqual(snapshot.peers[0].state.position, spawn); assert.equal(snapshot.peers[0].state.health, 200);
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [] });
  snapshot = packets.filter((value) => value.type === 'session').at(-1);
  assert.equal(snapshot.peers.length, 1, '瞬时缺少状态条目不删除仍在公共战局的玩家');
  socket.receive({ type: 'room_state', room: room('LOCAL') });
  assert.equal(packets.filter((value) => value.type === 'session').at(-1).peers.length, 0,
    '正式移除成员时才清除其旧角色状态'); page.api.close();
});

test('恢复位置不被旧移动序号倒退，成员移除和重新连接的新身份清空旧战斗版本', async () => {
  const page = await harness({ identity: { client_id: 'LOCAL', resume_token: 'valid' }, intent: { reconnect: true } });
  const socket = page.enter();
  const position = [732, -1080, 23];
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [{ player_id: 'LOCAL', state: { ...playerState(50), position } }] });
  await page.api.ready;
  socket.receive({ type: 'combat_state', players: [{ id: 'LOCAL', health: 200, alive: true, revision: 9 }] });
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  socket.receive({ type: 'player_state', room_id: 'PUBLIC', player_id: 'LOCAL', state: playerState(49) });
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [{ player_id: 'LOCAL', state: playerState(49) }] });
  assert.deepEqual(packets.filter((value) => value.type === 'session').at(-1).resume_position, position);
  socket.close(); page.advance(500); const next = page.sockets.at(-1); next.welcome();
  next.receive({ type: 'error', code: 'resume_denied' }); page.enter(next, 'NEW');
  next.receive({ type: 'combat_state', players: [{ id: 'NEW', health: 150, alive: true, revision: 1 }] });
  next.receive({ type: 'world_state', room_id: 'PUBLIC', states: [] });
  const newSession = packets.filter((value) => value.type === 'session').at(-1);
  assert.equal(newSession.client_id, 'NEW'); assert.equal(newSession.combat.length, 1);
  assert.equal(newSession.combat[0].revision, 1); assert.equal(newSession.combat[0].health, 150);
  page.api.close();
});

test('旧协议缺少 combat revision 时仍按零版本同步，非法版本与跨房间事件不污染缓存', async () => {
  const page = await harness(); const socket = page.enter(), packets = [];
  page.api.setReceiver((value) => packets.push(copy(value)));
  socket.receive({ type: 'combat_state', players: [{ id: 'LOCAL', health: 175, alive: true }] });
  assert.equal(packets.at(-1).players[0].revision, 0);
  socket.receive({ type: 'damage', victim_id: 'LOCAL', health: 150 });
  assert.equal(packets.at(-2).combat[0].health, 150);
  socket.receive({ type: 'combat_state', room_id: 'WRONG', players: [{ id: 'LOCAL', health: 0, alive: false, revision: 99 }] });
  socket.receive({ type: 'combat_state', players: [{ id: 'LOCAL', health: 0, alive: false, revision: -1 }] });
  socket.receive({ type: 'death', room_id: 'WRONG', player_id: 'LOCAL', revision: 99 });
  socket.receive({ type: 'death', player_id: 'UNKNOWN', revision: 99 });
  socket.receive({ type: 'death', player_id: 'LOCAL', revision: '99' });
  socket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [] });
  const current = packets.filter((value) => value.type === 'session').at(-1).combat[0];
  assert.equal(current.health, 150); assert.equal(current.alive, true); assert.equal(current.revision, 0);
  page.api.close();
});

test('服务器武器规则交给引擎且防接收器修改，长冷却单发自动等到合法时刻发送', async () => {
  const weapon = playerState().weapon;
  const rules = [{ weapon, cooldown_ms: 500, damage: 28 }, { weapon: 0x83bf0278, cooldown_ms: 100, damage: 26 }];
  const page = await harness({ weaponRules: rules }); const socket = page.enter();
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  assert.deepEqual(packets[0].weapon_rules, rules);
  page.api.setReceiver((value) => { if (value.weapon_rules?.length) value.weapon_rules[0].cooldown_ms = 1; });
  page.api.setReceiver((value) => packets.push(copy(value)));
  assert.equal(packets.filter((value) => value.type === 'session').at(-1).weapon_rules[0].cooldown_ms, 500);
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: playerState() });
  assert.equal(socket.messages('shot_event').length, 1);
  page.advance(1); page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: playerState() });
  page.advance(513); assert.equal(socket.messages('shot_event').length, 1);
  page.advance(1); assert.equal(socket.messages('shot_event').length, 2,
    '500毫秒武器冷却不能被原250毫秒队列寿命错误丢弃');
  const times = socket.sentTimes.filter((entry) => entry.type === 'shot_event');
  assert.equal(times[1].at - times[0].at, 515);
  page.api.close(); assert.equal(page.timers.size, 0);
});

test('不同枪械依据当前武器规则发送，旧服务器没有规则时仍使用50毫秒间隔', async () => {
  const pistol = playerState().weapon, rifle = 0x83bf0278;
  const page = await harness({ weaponRules: [{ weapon: pistol, cooldown_ms: 500, damage: 28 }, { weapon: rifle, cooldown_ms: 100, damage: 26 }] });
  const socket = page.enter();
  page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(pistol), state: playerState() });
  page.advance(1); page.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(rifle), state: { ...playerState(), weapon: rifle } });
  page.advance(113); assert.equal(socket.messages('shot_event').length, 1);
  page.advance(1); assert.equal(socket.messages('shot_event').length, 2); assert.equal(socket.messages('shot_event')[1].weapon, rifle);
  assert.equal(socket.sentTimes.filter((entry) => entry.type === 'shot_event')[1].at, 115);
  page.api.close();
  const legacy = await harness(); const oldSocket = legacy.enter();
  legacy.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: playerState() });
  legacy.advance(1); legacy.api.onWorkerMessage({ type: 'local_shot', event: shotEvent(), state: playerState() });
  legacy.advance(48); assert.equal(oldSocket.messages('shot_event').length, 1);
  legacy.advance(1); assert.equal(oldSocket.messages('shot_event').length, 2);
  legacy.api.close();
});

test('武器规则严格拒绝重复哈希、非法冷却和伤害，反馈 revision 仅接收非负安全整数', async () => {
  const valid = { weapon: 1, cooldown_ms: 100, damage: 20 };
  for (const weaponRules of [[valid, valid], [{ ...valid, cooldown_ms: 0 }], [{ ...valid, cooldown_ms: 10001 }],
    [{ ...valid, damage: 201 }], [{ ...valid, weapon: -1 }], [{ ...valid, extra: 1 }]]) {
    const page = await harness({ weaponRules }); const socket = page.sockets[0]; socket.welcome();
    assert.equal(socket.readyState, 3); assert.equal(page.statuses.at(-1).phase, 'reconnecting'); page.api.close();
  }
  const page = await harness(); const socket = page.enter(), packets = [];
  page.api.setReceiver((value) => packets.push(copy(value)));
  for (const revision of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    socket.receive({ type: 'shot_result', seq: 1, weapon: 1, accepted: true, hit: true, revision });
  }
  assert.equal(packets.filter((value) => value.type === 'combat_feedback').length, 0);
  socket.receive({ type: 'shot_result', seq: 1, weapon: 1, accepted: true, hit: true, victim_id: 'REMOTE', damage: 40, health: 0, revision: 3 });
  assert.equal(packets.filter((value) => value.type === 'combat_feedback')[0].revision, 3);
  page.api.close();
});

const worldTransform = (position = [711.5, -1088.1, 22.4]) => ({ position, rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angular_velocity: [0, 0, 0] });
const worldPed = (id = 'LOCAL', changes = {}) => ({ entity_id: 'w:epochA:' + id, kind: 'ped', model: 0x705e61f2, player_id: id,
  revision: 1, generation: 1, owner_id: id, owner_epoch: 1, ownership: 'active', lease_until_tick: 5000, last_input_seq: -1,
  components: { transform: worldTransform(), ped: { weapon: playerState().weapon, shooting: false, actions: actionState() },
    combat: { health: 200, max_health: 200, alive: true, kills: 0, deaths: 0, respawn_at_tick: 0 } }, ...changes });
const worldVehicle = (changes = {}) => ({ entity_id: 'w:epochA:vehicle', kind: 'vehicle', model: 0xeb70965f, player_id: null,
  revision: 1, generation: 1, owner_id: null, owner_epoch: 1, ownership: 'unowned', lease_until_tick: 0, last_input_seq: -1,
  components: { transform: worldTransform([715.5, -1088.1, 22.4]), vehicle: { engine_health: 1000, body_health: 1000,
    seats: { driver: null, 'passenger:0': null }, engine_on: false, lights_on: false } }, ...changes });
const worldSnapshot = (socket, entities = [worldPed(), worldVehicle()], fields = {}) => {
  const shared = { schema_version: 2, world_epoch: 'epochA', snapshot_id: 'snapshotA', cut_revision: 5, ...fields };
  socket.receive({ type: 'snapshot_begin', ...shared, world_tick: 100, stream_seq: 0 });
  socket.receive({ type: 'snapshot_chunk', ...shared, index: 0, entities, tombstones: [] });
  socket.receive({ type: 'snapshot_end', ...shared, world_tick: 100, stream_seq: 0 });
};
const worldDelta = (socket, entities, changes = {}) => socket.receive({ type: 'world_delta', schema_version: 2,
  world_epoch: 'epochA', world_revision: 6, world_tick: 110, stream_seq: 1, entities, tombstones: [], scope_leave: [], ...changes });

test('world_v2 仅协商后启用，首次 ready 等完整快照再启动，分块中不发布半个世界', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2']);
  assert.ok(socket.messages('hello')[0].capabilities.includes('world_v2'));
  let ready = false; page.api.ready.then(() => { ready = true; }); await Promise.resolve(); assert.equal(ready, false);
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  socket.receive({ type: 'snapshot_begin', schema_version: 2, world_epoch: 'epochA', snapshot_id: 'snapshotA', cut_revision: 5, world_tick: 100, stream_seq: 0 });
  socket.receive({ type: 'snapshot_chunk', schema_version: 2, world_epoch: 'epochA', snapshot_id: 'snapshotA', cut_revision: 5,
    index: 0, entities: [worldPed(), worldVehicle()], tombstones: [] });
  assert.equal(packets.filter((value) => value.type === 'world_state_v2').at(-1).ready, false);
  assert.equal(packets.filter((value) => value.type === 'world_state_v2').at(-1).entities.length, 0);
  socket.receive({ type: 'snapshot_end', schema_version: 2, world_epoch: 'epochA', snapshot_id: 'snapshotA', cut_revision: 5, world_tick: 100, stream_seq: 0 });
  await page.api.ready; assert.equal(ready, true);
  assert.equal(packets.filter((value) => value.type === 'world_state_v2').at(-1).entities.length, 2);
  page.api.close();
  const old = await harness(); const oldSocket = old.enter(); await old.api.ready;
  const oldPackets = []; old.api.setReceiver((value) => oldPackets.push(copy(value))); worldSnapshot(oldSocket);
  assert.equal(oldPackets.filter((value) => value.type === 'world_state_v2').length, 0);
  assert.equal(oldSocket.readyState, 1); old.api.close();
});

test('统一世界 delta 连续序号缺口请求新快照并禁止所有者输入，过期 owner/generation 不可提交', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2']);
  const active = worldVehicle({ owner_id: 'LOCAL', owner_epoch: 2, ownership: 'active', lease_until_tick: 5000 });
  worldSnapshot(socket, [worldPed(), active]); await page.api.ready;
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, owner_epoch: 1, transform: worldTransform() });
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, owner_epoch: 2, generation: 0, transform: worldTransform() });
  assert.equal(socket.messages('entity_input').length, 0);
  worldDelta(socket, [active], { stream_seq: 2 });
  assert.equal(socket.messages('world_sync').length, 1);
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, transform: worldTransform() });
  assert.equal(socket.messages('entity_input').length, 0, '缺少完整基线时不能继续提议动态结果');
  assert.equal(socket.readyState, 1, '只恢复世界基线，不把普通分发缺口误判成退出战局'); page.api.close();
});

test('所有者邀请资源就绪仅确认一次，激活后只发送受限车辆姿态且沿用最后输入序号', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2']);
  const offered = worldVehicle({ owner_id: 'LOCAL', owner_epoch: 2, ownership: 'offered', lease_until_tick: 5000 });
  worldSnapshot(socket, [worldPed(), offered]); await page.api.ready;
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: offered.entity_id, transform: worldTransform() });
  assert.equal(socket.messages('entity_input').length, 0);
  page.api.onWorkerMessage({ type: 'entity_ready', entity_id: offered.entity_id, owner_epoch: 1 });
  page.api.onWorkerMessage({ type: 'entity_ready', entity_id: offered.entity_id, owner_epoch: 2 });
  page.api.onWorkerMessage({ type: 'entity_ready', entity_id: offered.entity_id, owner_epoch: 2 });
  assert.deepEqual(socket.messages('entity_ready'), [{ type: 'entity_ready', world_epoch: 'epochA', entity_id: offered.entity_id, owner_epoch: 2 }]);
  const active = { ...offered, ownership: 'active', revision: 2, last_input_seq: 12 };
  worldDelta(socket, [active]);
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, owner_epoch: 2, transform: worldTransform(),
    view: { engine_on: true, lights_on: false } });
  assert.equal(socket.messages('entity_input')[0].input_seq, 13); assert.equal(socket.messages('entity_input')[0].based_on_revision, 2);
  assert.equal(socket.messages('entity_input')[0].world_epoch, 'epochA');
  for (const forbidden of [{ combat: { health: 0 } }, { owner_id: 'REMOTE' }, { lifecycle: 'delete' }, { input_seq: 999 }]) {
    page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, transform: worldTransform(), ...forbidden });
  }
  assert.equal(socket.messages('entity_input').length, 1);
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: worldPed().entity_id, transform: worldTransform() });
  assert.equal(socket.messages('entity_input').length, 1, '玩家移动保留 v1 校验入口，不产生另一套生命权威');
  page.api.close();
});

test('交互身份由网络绑定，离车自动解析当前车辆，生命候选不能声明其他玩家或恢复健康', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2']);
  const local = worldPed('LOCAL', { components: { ...worldPed().components, attachment: { entity_id: worldVehicle().entity_id, seat: 'driver' } } });
  const active = worldVehicle({ owner_id: 'LOCAL', owner_epoch: 2, ownership: 'active', lease_until_tick: 5000, revision: 4,
    components: { ...worldVehicle().components, vehicle: { ...worldVehicle().components.vehicle, seats: { driver: local.entity_id, 'passenger:0': null } } } });
  worldSnapshot(socket, [local, worldPed('REMOTE'), active]); await page.api.ready;
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'leave_vehicle', entity_id: local.entity_id, expected_revision: local.revision });
  const leave = socket.messages('interaction_request')[0];
  assert.equal(leave.entity_id, active.entity_id); assert.equal(leave.expected_revision, 4); assert.ok(leave.request_id);
  assert.ok(!Object.hasOwn(leave, 'actor_id'));
  page.api.onWorkerMessage({ type: 'simulation_result', kind: 'life_report', reason: 'environmental', health: 180 });
  assert.equal(socket.messages('simulation_result')[0].entity_id, local.entity_id);
  page.api.onWorkerMessage({ type: 'simulation_result', entity_id: worldPed('REMOTE').entity_id, kind: 'life_report', reason: 'dead', health: 0 });
  page.api.onWorkerMessage({ type: 'simulation_result', kind: 'life_report', reason: 'dead', health: 0, owner_id: 'REMOTE' });
  assert.equal(socket.messages('simulation_result').length, 1);
  page.api.onWorkerMessage({ type: 'simulation_result', entity_id: active.entity_id, kind: 'vehicle_damage', engine_health: 800, body_health: 900 });
  assert.equal(socket.messages('simulation_result').length, 2);
  page.api.onWorkerMessage({ type: 'simulation_result', entity_id: active.entity_id, kind: 'vehicle_damage', engine_health: 1001, body_health: 1000 });
  assert.equal(socket.messages('simulation_result').length, 2);
  page.api.close();
});

test('世界 NPC 仅授权后允许固定行为和生命候选，输入不能写外观或任务生命周期', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2']);
  const npc = worldPed('NPC', { player_id: null, owner_id: 'LOCAL', entity_id: 'w:epochA:npc', ownership: 'active', simulation_task: 'wander' });
  worldSnapshot(socket, [worldPed(), npc]); await page.api.ready;
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: npc.entity_id, owner_epoch: 1, transform: worldTransform(),
    view: { weapon: playerState().weapon, shooting: false, actions: actionState({ sprinting: true }) } });
  assert.equal(socket.messages('entity_input').length, 1); assert.equal(socket.messages('entity_input')[0].view.actions.sprinting, true);
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: npc.entity_id, transform: worldTransform(),
    view: { weapon: 0, shooting: false, actions: actionState(), appearance: {} } });
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: npc.entity_id, transform: worldTransform(), lifecycle: 'death' });
  assert.equal(socket.messages('entity_input').length, 1);
  page.api.onWorkerMessage({ type: 'simulation_result', entity_id: npc.entity_id, kind: 'entity_health', health: 175 });
  assert.equal(socket.messages('simulation_result').length, 1); page.api.close();
});

test('多实体输入每100毫秒合成一条消息，只保留最新姿态并在发送时采用最新基线版本', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'entity_batch']);
  assert.ok(socket.messages('hello')[0].capabilities.includes('entity_batch'));
  const active = worldVehicle({ owner_id: 'LOCAL', owner_epoch: 2, ownership: 'active', lease_until_tick: 5000 });
  const npcs = Array.from({ length: 3 }, (_, index) => worldPed('NPC' + index, { player_id: null, owner_id: 'LOCAL',
    entity_id: 'w:epochA:npc' + index, ownership: 'active' }));
  worldSnapshot(socket, [worldPed(), active, ...npcs]); await page.api.ready;
  for (let step = 0; step < 10; step++) {
    for (const entity of [active, ...npcs]) page.api.onWorkerMessage({ type: 'entity_input', entity_id: entity.entity_id,
      owner_epoch: entity.owner_epoch, transform: worldTransform([711.5 + step * .1, -1088.1, 22.4]) });
    page.advance(10);
  }
  assert.equal(socket.messages('entity_input').length, 0); assert.equal(socket.messages('entity_batch').length, 1);
  let batch = socket.messages('entity_batch')[0]; assert.equal(batch.updates.length, 4);
  assert.equal(batch.updates[0].entity_id, active.entity_id, '车辆在共享预算中优先');
  assert.ok(batch.updates.every((value) => Math.abs(value.transform.position[0] - 712.4) < .001));
  assert.ok(batch.updates.every((value) => value.input_seq === 1));
  for (const entity of [active, ...npcs]) page.api.onWorkerMessage({ type: 'entity_input', entity_id: entity.entity_id,
    transform: worldTransform([713, -1088, 22.4]) });
  worldDelta(socket, [active, ...npcs].map((entity) => ({ ...entity, revision: 3, last_input_seq: 1 })));
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, based_on_revision: 1,
    transform: worldTransform([714, -1088, 22.4]) });
  page.advance(100); assert.equal(socket.messages('entity_batch').length, 2);
  batch = socket.messages('entity_batch')[1];
  assert.ok(batch.updates.every((value) => value.input_seq === 2 && value.based_on_revision === 3));
  assert.equal(batch.updates.find((value) => value.entity_id === active.entity_id).transform.position[0], 714,
    '工作线程旧基线的有效模拟结果可排队，发送时采用服务端已确认的新基线');
  const times = socket.sentTimes.filter((entry) => entry.type === 'entity_batch');
  assert.ok(times[1].at - times[0].at >= 100);
  page.api.close();
});

test('实体批次背压保留最新姿态，超过250毫秒过期、所有权或代际改变后不再上传', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'entity_batch']);
  const active = worldVehicle({ owner_id: 'LOCAL', owner_epoch: 2, ownership: 'active', lease_until_tick: 5000 });
  worldSnapshot(socket, [worldPed(), active]); await page.api.ready;
  socket.bufferedAmount = 70000;
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, transform: worldTransform() });
  page.advance(100); assert.equal(socket.messages('entity_batch').length, 0);
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, transform: worldTransform([713, -1088, 22.4]) });
  socket.bufferedAmount = 0; page.advance(100);
  assert.equal(socket.messages('entity_batch').length, 1);
  assert.equal(socket.messages('entity_batch')[0].updates[0].transform.position[0], 713);
  socket.bufferedAmount = 70000;
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, transform: worldTransform([714, -1088, 22.4]) });
  page.advance(300); socket.bufferedAmount = 0; page.advance(100);
  assert.equal(socket.messages('entity_batch').length, 1);
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, transform: worldTransform([715, -1088, 22.4]) });
  worldDelta(socket, [{ ...active, revision: 2, owner_id: 'REMOTE', owner_epoch: 3 }]);
  page.advance(100); assert.equal(socket.messages('entity_batch').length, 1);
  worldDelta(socket, [{ ...active, revision: 3, generation: 2 }], { stream_seq: 2, world_revision: 7 });
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, generation: 2, transform: worldTransform() });
  worldDelta(socket, [{ ...active, revision: 4, generation: 3 }], { stream_seq: 3, world_revision: 8 });
  page.advance(100); assert.equal(socket.messages('entity_batch').length, 1, '排队的旧代际姿态不得变成新实体输入');
  page.api.close(); assert.equal(page.timers.size, 0);
});

test('批次发送失败不消耗输入序号，生命候选与姿态批次共享单调序号且关闭清空全部队列', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'entity_batch']);
  const active = worldVehicle({ owner_id: 'LOCAL', owner_epoch: 2, ownership: 'active', lease_until_tick: 5000, last_input_seq: 8 });
  worldSnapshot(socket, [worldPed(), active]); await page.api.ready;
  socket.failSendType = 'entity_batch';
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, transform: worldTransform() });
  page.advance(100); assert.equal(socket.messages('entity_batch').length, 0);
  page.api.onWorkerMessage({ type: 'simulation_result', entity_id: active.entity_id, kind: 'vehicle_damage', engine_health: 900, body_health: 900 });
  assert.equal(socket.messages('simulation_result')[0].input_seq, 9);
  socket.failSendType = null; page.advance(100);
  assert.equal(socket.messages('entity_batch')[0].updates[0].input_seq, 10);
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, transform: worldTransform([713, -1088, 22.4]) });
  page.api.close(); page.advance(1000); assert.equal(socket.messages('entity_batch').length, 1);
  assert.equal(page.timers.size, 0);
});

test('世界序号缺口与快照重建都会清空批输入，旧世界姿态不会在恢复后继续发送', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'entity_batch']);
  const active = worldVehicle({ owner_id: 'LOCAL', owner_epoch: 2, ownership: 'active', lease_until_tick: 5000 });
  worldSnapshot(socket, [worldPed(), active]); await page.api.ready;
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, transform: worldTransform() });
  worldDelta(socket, [], { stream_seq: 2 });
  page.advance(100); assert.equal(socket.messages('entity_batch').length, 0);
  worldSnapshot(socket, [worldPed(), active], { snapshot_id: 'snapshotB', cut_revision: 8 });
  page.advance(100); assert.equal(socket.messages('entity_batch').length, 0);
  page.api.onWorkerMessage({ type: 'entity_input', entity_id: active.entity_id, transform: worldTransform() });
  const other = { ...active, entity_id: 'w:epochB:vehicle' };
  worldSnapshot(socket, [other], { world_epoch: 'epochB', snapshot_id: 'snapshotC', cut_revision: 1 });
  page.advance(100); assert.equal(socket.messages('entity_batch').length, 0); page.api.close();
});

test('大量实体每批最多24条，最新姿态合并后每秒批消息不超过10且不超过玩家总消息预算', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'entity_batch']);
  const entities = Array.from({ length: 30 }, (_, index) => worldPed('N' + index, { entity_id: 'w:epochA:n' + index,
    player_id: null, owner_id: 'LOCAL', ownership: 'active' }));
  worldSnapshot(socket, [worldPed(), ...entities]); await page.api.ready;
  for (let step = 0; step < 20; step++) {
    page.api.onWorkerMessage({ type: 'local_state', state: playerState() });
    for (const entity of entities) page.api.onWorkerMessage({ type: 'entity_input', entity_id: entity.entity_id, transform: worldTransform() });
    page.advance(50);
  }
  assert.equal(socket.messages('entity_batch').length, 10);
  assert.ok(socket.messages('entity_batch').every((batch) => batch.updates.length <= 24));
  assert.equal(socket.messages('player_state').length, 20);
  assert.equal(socket.messages('entity_batch').length + socket.messages('player_state').length, 30);
  page.api.close();
});

test('交互允许同代际的旧基线并携带目标 generation，旧角色生命不能被重写成新目标攻击', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2']);
  const remote = worldPed('REMOTE', { revision: 6, generation: 2 });
  const car = worldVehicle({ revision: 4, generation: 3 });
  worldSnapshot(socket, [worldPed(), remote, car], { cut_revision: 10 }); await page.api.ready;
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() });
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', entity_id: remote.entity_id,
    expected_revision: 3, target_generation: 2 });
  assert.equal(socket.messages('interaction_request').length, 1);
  assert.equal(socket.messages('interaction_request')[0].expected_revision, 3);
  assert.equal(socket.messages('interaction_request')[0].target_generation, 2);
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', entity_id: remote.entity_id,
    expected_revision: 3, target_generation: 1 });
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', entity_id: remote.entity_id,
    expected_revision: 7, target_generation: 2 });
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', entity_id: remote.entity_id,
    expected_revision: -1, target_generation: 2 });
  assert.equal(socket.messages('interaction_request').length, 1, '显式旧代际或未来/非法版本必须拒绝，不能帮它升级目标');
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'enter_vehicle', entity_id: car.entity_id,
    expected_revision: 2, seat: 'driver', target_generation: 3 });
  const enter = socket.messages('interaction_request').at(-1);
  assert.equal(enter.target_generation, 3); assert.equal(enter.expected_revision, 2);
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'enter_vehicle', entity_id: car.entity_id,
    expected_revision: 2, seat: 'driver' });
  assert.equal(socket.messages('interaction_request').at(-1).target_generation, 3, '旧worker未带generation时由当前逻辑目标补齐');
  page.api.close();
});

test('从本地玩家解析离车目标使用车辆代际，不能误用玩家重生代际或替旧请求升级', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2']);
  const car = worldVehicle({ revision: 8, generation: 3 });
  const self = worldPed('LOCAL', { generation: 5, components: { ...worldPed().components,
    attachment: { entity_id: car.entity_id, seat: 'driver' } } });
  worldSnapshot(socket, [self, car], { cut_revision: 10 }); await page.api.ready;
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'leave_vehicle', entity_id: self.entity_id,
    expected_revision: self.revision, target_generation: 5 });
  assert.equal(socket.messages('interaction_request').length, 0, '玩家generation不得作为车辆generation通过校验');
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'leave_vehicle', entity_id: self.entity_id,
    expected_revision: self.revision, target_generation: 3 });
  const leave = socket.messages('interaction_request')[0];
  assert.equal(leave.entity_id, car.entity_id); assert.equal(leave.target_generation, 3); assert.equal(leave.expected_revision, 8);
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'leave_vehicle' });
  assert.equal(socket.messages('interaction_request').at(-1).target_generation, 3);
  page.api.close();
});

const meleeEvent = (changes = {}) => ({ type: 'melee_event', schema_version: 2, world_epoch: 'epochA',
  event_id: 'm:epochA:1', request_id: 'melee1', action: 'punch', attacker_entity_id: worldPed().entity_id,
  attacker_id: 'LOCAL', attacker_generation: 1, target_entity_id: worldPed('REMOTE').entity_id,
  target_generation: 1, accepted: true, hit: true, damage: 20, health: 180, revision: 2, world_tick: 120, ...changes });

test('近战发送前强制刷新最新位置朝向，低于状态预算时自动等待，不丢挥空动作意图', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'melee_events']);
  worldSnapshot(socket, [worldPed(), worldPed('REMOTE')]); await page.api.ready;
  assert.ok(socket.messages('hello')[0].capabilities.includes('melee_events'));
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() }); page.advance(10);
  const next = { ...playerState(), position: [713, -1088, 22.4], heading: 175 };
  page.api.onWorkerMessage({ type: 'local_state', state: next });
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', request_id: 'punch1', attacker_generation: 1 });
  assert.equal(socket.messages('interaction_request').length, 0);
  page.advance(30);
  assert.deepEqual(socket.sent.slice(-2).map((value) => value.type), ['player_state', 'interaction_request']);
  assert.equal(socket.sent.at(-2).heading, 175); assert.deepEqual(socket.sent.at(-2).position, next.position);
  const request = socket.sent.at(-1); assert.equal(request.action, 'melee'); assert.match(request.request_id, /^p[A-Za-z0-9]+:[a-z0-9]+$/);
  assert.ok(!Object.hasOwn(request, 'entity_id')); assert.ok(!Object.hasOwn(request, 'target_generation'));
  const sent = page.logs.filter((line) => line.startsWith('[public-melee] ')).map((line) => JSON.parse(line.slice('[public-melee] '.length)));
  assert.equal(sent[0].stage, 'sent'); assert.equal(sent[0].attacker_entity_id, worldPed().entity_id);
  assert.equal(sent[0].target_entity_id, null); assert.ok(!JSON.stringify(sent).includes('position'));
  page.api.close();
});

test('近战输入同帧 native 完整状态覆盖旧缓存，先同步最新方向且不把本地 state 字段发到协议', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'melee_events']);
  worldSnapshot(socket, [worldPed(), worldPed('REMOTE')]); await page.api.ready;
  page.api.onWorkerMessage({ type: 'local_state', state: { ...playerState(), heading: 0 } }); page.advance(10);
  const fresh = { ...playerState(), heading: 270, position: [713, -1088, 22.4], actions: actionState() };
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', actor_generation: 1,
    request_id: 'native-fresh', state: fresh });
  assert.equal(socket.messages('interaction_request').length, 0);
  page.advance(30);
  assert.deepEqual(socket.sent.slice(-2).map((value) => value.type), ['player_state', 'interaction_request']);
  assert.equal(socket.sent.at(-2).heading, 270); assert.deepEqual(socket.sent.at(-2).position, fresh.position);
  const request = socket.sent.at(-1); assert.match(request.request_id, /^p[A-Za-z0-9]+:[a-z0-9]+$/);
  assert.ok(!Object.hasOwn(request, 'state')); assert.ok(!Object.hasOwn(request, 'actor_generation'));
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', actor_generation: 0, state: fresh });
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', actor_generation: 1,
    state: { ...fresh, actions: { aiming: true } } });
  page.advance(100); assert.equal(socket.messages('interaction_request').length, 1,
    '非法同帧状态或旧本地代际不能触发挥击，也不能覆盖有效缓存');
  page.api.close();
});

test('近战候选等待期间目标新代际出现即丢弃，不把旧请求升级到新生命并且结果日志保留拒绝原因', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'melee_events']);
  worldSnapshot(socket, [worldPed(), worldPed('REMOTE')]); await page.api.ready;
  page.api.onWorkerMessage({ type: 'local_state', state: playerState() }); page.advance(10);
  page.api.onWorkerMessage({ type: 'local_state', state: { ...playerState(), heading: 180 } });
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', entity_id: worldPed('REMOTE').entity_id,
    target_generation: 1, expected_revision: 1, request_id: 'old-life' });
  worldDelta(socket, [worldPed('REMOTE', { revision: 2, generation: 2 })]);
  page.advance(100); assert.equal(socket.messages('interaction_request').length, 0);
  page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', entity_id: worldPed('REMOTE').entity_id,
    target_generation: 2, expected_revision: 2, request_id: 'new-life' });
  assert.equal(socket.messages('interaction_request').length, 1);
  socket.receive({ type: 'interaction_result', request_id: socket.messages('interaction_request')[0].request_id, accepted: false, reason: 'not_facing' });
  socket.receive({ type: 'error', code: 'not_facing', message: '角色前方没有该目标' });
  const logs = page.logs.filter((line) => line.startsWith('[public-melee] ')).map((line) => JSON.parse(line.slice('[public-melee] '.length)));
  assert.deepEqual(logs.map((value) => value.stage), ['sent', 'result']);
  assert.equal(logs[1].reason, 'not_facing'); assert.equal(logs[1].accepted, false);
  assert.ok(page.statuses.at(-1).connected); assert.equal(socket.readyState, 1); page.api.close();
});

test('近战广播严格验证世界、实体和代际，重复 event_id 仅发一次，挥空仍为合法动作', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'melee_events']);
  worldSnapshot(socket, [worldPed(), worldPed('REMOTE')]); await page.api.ready;
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  socket.receive(meleeEvent()); socket.receive(meleeEvent());
  assert.equal(packets.filter((value) => value.type === 'melee_event').length, 1);
  for (const invalid of [{ world_epoch: 'wrong' }, { attacker_generation: 2 }, { target_generation: 2 },
    { attacker_id: 'OTHER' }, { target_entity_id: 'missing' }, { damage: 99 }, { action: 'shoot' }, { hit: 'yes' }]) {
    socket.receive(meleeEvent({ event_id: 'm:epochA:bad', ...invalid }));
  }
  assert.equal(packets.filter((value) => value.type === 'melee_event').length, 1);
  socket.receive(meleeEvent({ event_id: 'm:epochA:2', request_id: 'swing2', target_entity_id: null, target_generation: null,
    hit: false, damage: 0, health: null, revision: 1 }));
  assert.equal(packets.filter((value) => value.type === 'melee_event').length, 2);
  const logs = page.logs.filter((line) => line.startsWith('[public-melee] ')).map((line) => JSON.parse(line.slice('[public-melee] '.length)));
  assert.equal(logs.length, 2); assert.ok(logs.every((value) => value.stage === 'event'));
  assert.ok(logs.every((value) => !Object.hasOwn(value, 'origin') && !Object.hasOwn(value, 'resume_token')));
  assert.equal(socket.readyState, 1); page.api.close();
});

test('引擎尚未挂接时保留已确认近战广播，旧服务不支持通知仅提示更新不改变服务器地址', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'melee_events']);
  worldSnapshot(socket, [worldPed(), worldPed('REMOTE')]); await page.api.ready;
  socket.receive(meleeEvent());
  const packets = []; page.api.setReceiver((value) => packets.push(copy(value)));
  assert.equal(packets.filter((value) => value.type === 'melee_event').length, 1); page.api.close();
  const legacy = await harness(); const oldSocket = legacy.enter();
  oldSocket.receive(meleeEvent()); assert.equal(oldSocket.readyState, 1); legacy.api.close();
});

test('刷新恢复同一玩家时请求 namespace 更新，同页重复请求和自动重连保持同一幂等键', async () => {
  const storage = new Map(); const first = await harness({ storage });
  const firstSocket = first.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'melee_events']);
  worldSnapshot(firstSocket); await first.api.ready;
  first.api.onWorkerMessage({ type: 'local_state', state: playerState() });
  const intent = { type: 'interaction_request', action: 'melee', request_id: 'engine:1', actor_generation: 1, state: playerState() };
  first.api.onWorkerMessage(intent); const firstId = firstSocket.messages('interaction_request')[0].request_id;
  first.api.onWorkerMessage(intent);
  assert.equal(firstSocket.messages('interaction_request')[1].request_id, firstId);
  firstSocket.close(); first.advance(500); const resumedSocket = first.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'melee_events']);
  resumedSocket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [] }); worldSnapshot(resumedSocket);
  first.api.onWorkerMessage(intent);
  assert.equal(resumedSocket.messages('interaction_request')[0].request_id, firstId, '自动重连不能改变同页请求幂等键');
  first.api.close();
  const refreshed = await harness({ storage, intent: { reconnect: true } });
  const refreshSocket = refreshed.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'melee_events']);
  refreshSocket.receive({ type: 'world_state', room_id: 'PUBLIC', states: [] }); worldSnapshot(refreshSocket); await refreshed.api.ready;
  refreshed.api.onWorkerMessage(intent);
  const secondId = refreshSocket.messages('interaction_request')[0].request_id;
  assert.notEqual(secondId, firstId, '新页面不能命中服务端保留的 engine:1 旧请求结果');
  assert.ok(secondId.length <= 64); refreshed.api.close();
});

test('不同完整长请求 ID 映射为不同短键，重发任一长 ID 仍使用原键', async () => {
  const page = await harness(); const socket = page.enter(undefined, 'LOCAL', {}, [...capabilities, 'world_v2', 'melee_events']);
  worldSnapshot(socket); await page.api.ready;
  const first = 'x'.repeat(63) + 'a', second = 'x'.repeat(63) + 'b';
  const send = (request_id) => page.api.onWorkerMessage({ type: 'interaction_request', action: 'melee', request_id, state: playerState() });
  send(first); send(second); send(first);
  const ids = socket.messages('interaction_request').map((request) => request.request_id);
  assert.notEqual(ids[0], ids[1]); assert.equal(ids[0], ids[2]); assert.ok(ids.every((id) => id.length <= 64));
  page.api.close();
});

test('共同世界协商明确声明环境与执法策略，新旧服务器能力不会混淆', async () => {
 const page=await harness();const socket=page.enter(undefined,'LOCAL',{},[...capabilities,'world_v2','world_environment','shared_law']);
 const hello=socket.messages('hello')[0];assert.ok(hello.capabilities.includes('world_environment'));assert.ok(hello.capabilities.includes('shared_law'));
 page.api.close();
 const old=await harness();const oldSocket=old.enter(undefined,'LOCAL',{},[...capabilities,'world_v2']);
 assert.ok(!oldSocket.messages('hello')[0].capabilities.includes('shared_law'));old.api.close();
});

test('完整武器目录保留类型和效果规则，投射物基线可在晚挂接时恢复，黏弹引爆不带客户端伤害', async () => {
  const weapon=0x2c3731d9;
  const rules=[{weapon,name:'WEAPON_STICKYBOMB',mode:'projectile',damage:100,cooldown_ms:500,range:100,pellets:1,spread:0,
    speed:15,gravity:1,fuse_ms:0,lifetime_ms:60000,detonation:'remote',blast_radius:6,effect_duration_ms:0,
    effect_interval_ms:0,melee_damage:35,melee_range:2,asset_damage:100,asset_fire_type:'PROJECTILE',damage_type:'EXPLOSIVE',collision_model:'ped_capsules_aim_terminal'}];
  const page=await harness({weaponRules:rules});const socket=page.enter(undefined,'LOCAL',{},[...capabilities,'world_v2']);
  worldSnapshot(socket);await page.api.ready;
  const event={type:'projectile_event',room_id:'PUBLIC',world_epoch:'epochA',projectile_id:'proj:1',player_id:'LOCAL',shot_seq:1,weapon,
    phase:'flight',origin:[711,-1088,24],target:[730,-1088,24],position:[715,-1088,25],created_at:100,flight_ms:1000,
    gravity:1,fuse_ms:0,detonation:'remote',expires_at:60100,world_tick:200};
  socket.receive(event);const packets=[];page.api.setReceiver(value=>packets.push(copy(value)));
  assert.deepEqual(packets.find(p=>p.type==='session').weapon_rules,rules);
  assert.equal(packets.find(p=>p.type==='projectile_state').effects[0].projectile_id,'proj:1');
  page.api.onWorkerMessage({type:'interaction_request',action:'detonate',request_id:'detonate:1'});
  assert.deepEqual(Object.keys(socket.messages('interaction_request').at(-1)).sort(),['action','request_id','type','world_epoch']);
  socket.receive({...event,projectile_id:'wrong',world_epoch:'old'});
  assert.equal(packets.filter(p=>p.type==='projectile_event').length,0);
  socket.receive({...event,phase:'landed'});assert.equal(packets.filter(p=>p.type==='projectile_event').length,1);
  socket.receive({type:'explosion_event',room_id:'PUBLIC',world_epoch:'epochA',projectile_id:'proj:1',player_id:'LOCAL',shot_seq:1,weapon,
    position:[730,-1088,24],radius:6,damage_type:'EXPLOSIVE',effect_duration_ms:0,world_tick:1200});
  assert.equal(packets.filter(p=>p.type==='explosion_event').length,1);assert.equal(socket.readyState,1);page.api.close();
});
test('高频竞争拒绝不刷通知且真实协议错误仍保持可见', async () => {
  const page=await harness();const socket=page.enter();const count=page.statuses.length;
  for(const code of ['rate_limited','cooldown','stale_seq','stale_input','stale_generation','invalid_revision','seat_unavailable'])
    socket.receive({type:'error',code,message:'temporary conflict'});
  assert.equal(page.statuses.length,count);assert.equal(socket.readyState,1);
  socket.receive({type:'error',code:'invalid_component',message:'invalid component'});
  assert.equal(page.statuses.at(-1).text,'invalid component');page.api.close();
});

test('实际Java95条武器publicRules完整握手通过，保留2800ms电击枪与兼容来源-1', async () => {
  const os=require('node:os'), {execFileSync}=require('node:child_process');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gta-weapon-handshake-'));
  const program=`import offline.multiplayer.WeaponCatalog;import java.util.*;
    public class CatalogJson {static String json(Object v){if(v instanceof Map<?,?> m){var a=new ArrayList<String>();for(var e:m.entrySet())a.add(json(e.getKey())+":"+json(e.getValue()));return "{"+String.join(",",a)+"}";}
    if(v instanceof Collection<?> c){var a=new ArrayList<String>();for(var e:c)a.add(json(e));return "["+String.join(",",a)+"]";}
    if(v instanceof String s)return "\\\""+s+"\\\"";return String.valueOf(v);}public static void main(String[] args){System.out.print(json(WeaponCatalog.publicRules()));}}`;
  try {
    fs.writeFileSync(path.join(directory,'CatalogJson.java'),program);
    execFileSync(process.env.JAVAC||'javac',['-d',directory,path.join(root,'server/src/main/java/offline/multiplayer/WeaponCatalog.java'),path.join(directory,'CatalogJson.java')]);
    const rules=JSON.parse(execFileSync(process.env.JAVA||'java',['-cp',directory,'CatalogJson'],{encoding:'utf8'}));
    assert.equal(rules.length,95);assert.ok(rules.some(r=>r.cooldown_ms===2800));assert.ok(rules.some(r=>r.asset_damage===-1));
    const page=await harness({weaponRules:rules});const socket=page.enter();await page.api.ready;
    const packets=[];page.api.setReceiver(p=>packets.push(copy(p)));
    assert.equal(socket.readyState,1);assert.deepEqual(packets.find(p=>p.type==='session').weapon_rules,rules);page.api.close();
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
test('射击成功不清除待发送近战、实体批次和投射物基线', async () => {
  const page=await harness();const socket=page.enter(undefined,'LOCAL',{},[...capabilities,'world_v2','melee_events','entity_batch']);
  worldSnapshot(socket);await page.api.ready;
  socket.receive({type:'projectile_event',room_id:'PUBLIC',world_epoch:'epochA',projectile_id:'proj:keep',player_id:'LOCAL',shot_seq:1,weapon:0x2c3731d9,
    phase:'landed',origin:[711,-1088,24],target:[720,-1088,24],position:[720,-1088,24],created_at:100,flight_ms:500,gravity:1,fuse_ms:0,
    detonation:'remote',expires_at:60100,world_tick:200});
  page.api.onWorkerMessage({type:'local_state',state:playerState()});
  page.api.onWorkerMessage({type:'local_shot',event:shotEvent(),state:playerState()});
  page.advance(1);page.api.onWorkerMessage({type:'interaction_request',action:'melee',request_id:'retain'});
  page.advance(1);page.api.onWorkerMessage({type:'local_shot',event:shotEvent(),state:playerState()});
  page.advance(500);assert.equal(socket.messages('interaction_request').length,1);
  const packets=[];page.api.setReceiver(p=>packets.push(copy(p)));
  assert.equal(packets.find(p=>p.type==='projectile_state').effects[0].projectile_id,'proj:keep');page.api.close();
});

test('握手声明session_policy并把服务端禁用剧情策略传给共享世界', async () => {
  const policy={revision:1,story_enabled:false,local_script_mode:'suspend_after_ready',allowed_scripts:[],mission_events:'server_only'};
  const page=await harness({sessionPolicy:policy});const socket=page.enter(undefined,'LOCAL',{},[...capabilities,'world_v2','session_policy']);
  assert.ok(socket.messages('hello')[0].capabilities.includes('session_policy'));
  worldSnapshot(socket,[worldPed(),worldVehicle()],{session_policy:policy});await page.api.ready;
  const packets=[];page.api.setReceiver(p=>packets.push(copy(p)));
  assert.deepEqual(packets.find(p=>p.type==='session').session_policy,policy);
  assert.deepEqual(packets.find(p=>p.type==='world_state_v2'&&p.ready).session_policy,policy);
  page.api.close();
});

test('地图碰撞只接受分配给自己的当前世界查询，结果白名单不含客户端伤害', async () => {
  const page=await harness();const socket=page.enter(undefined,'LOCAL',{},[...capabilities,'world_v2','physics_queries']);
  assert.ok(socket.messages('hello')[0].capabilities.includes('physics_queries'));
  worldSnapshot(socket);await page.api.ready;
  const packets=[];page.api.setReceiver(p=>packets.push(copy(p)));
  const query={type:'collision_query',schema_version:2,world_epoch:'epochA',query_id:'query:1',observer_id:'LOCAL',
    purpose:'shot',issued_at:100,expires_at:1000,segments:[{from:[711,-1088,24],to:[730,-1088,24],radius:0.02}]};
  socket.receive({...query,observer_id:'OTHER'});socket.receive({...query,world_epoch:'old'});
  socket.receive(query);socket.receive(query);
  assert.equal(packets.filter(p=>p.type==='collision_query').length,1);
  page.api.onWorkerMessage({type:'collision_result',world_epoch:'old',query_id:query.query_id,complete:true,hits:[null]});
  assert.equal(socket.messages('collision_result').length,0);
  page.api.onWorkerMessage({type:'collision_result',world_epoch:'epochA',query_id:query.query_id,complete:true,hits:[null],damage:200});
  assert.deepEqual(socket.messages('collision_result'),[{type:'collision_result',schema_version:2,world_epoch:'epochA',query_id:'query:1',complete:true,hits:[null]}]);
  page.api.onWorkerMessage({type:'collision_result',world_epoch:'epochA',query_id:query.query_id,complete:true,hits:[null]});
  assert.equal(socket.messages('collision_result').length,1);page.api.close();
});

test('碰撞查询超时或矢量格式无效不能制造成功结果，失败保留原因', async () => {
  const page=await harness();const socket=page.enter(undefined,'LOCAL',{},[...capabilities,'world_v2','physics_queries']);
  worldSnapshot(socket);await page.api.ready;page.api.setReceiver(()=>{});
  const query={type:'collision_query',schema_version:2,world_epoch:'epochA',query_id:'query:1',observer_id:'LOCAL',
    purpose:'projectile',issued_at:100,expires_at:1000,segments:[{from:[711,-1088,24],to:[730,-1088,24],radius:0.02}]};
  socket.receive(query);page.advance(901);
  page.api.onWorkerMessage({type:'collision_result',world_epoch:'epochA',query_id:'query:1',complete:true,hits:[null]});
  assert.equal(socket.messages('collision_result').length,0);
  socket.receive({...query,query_id:'query:2'});
  page.api.onWorkerMessage({type:'collision_result',world_epoch:'epochA',query_id:'query:2',complete:false,hits:[],reason:'collision_not_loaded'});
  assert.equal(socket.messages('collision_result')[0].complete,false);
  assert.equal(socket.messages('collision_result')[0].reason,'collision_not_loaded');page.api.close();
});

test('真实弹道快照保留服务器运动段，拒绝缺失或非法速度和锚点', async () => {
  const page=await harness();const socket=page.enter(undefined,'LOCAL',{},[...capabilities,'world_v2']);
  worldSnapshot(socket);await page.api.ready;const packets=[];page.api.setReceiver(p=>packets.push(copy(p)));
  const projectile={type:'projectile_event',room_id:'PUBLIC',world_epoch:'epochA',projectile_id:'proj:ballistic',player_id:'LOCAL',shot_seq:1,weapon:0x2c3731d9,
    phase:'flight',origin:[711,-1088,24],target:[730,-1088,24],position:[715,-1088,25],created_at:100,flight_ms:1000,
    gravity:1,fuse_ms:0,detonation:'remote',expires_at:60100,world_tick:200,physics:'ballistic',velocity:[10,0,5],motion_origin:[715,-1088,25],motion_at:200};
  socket.receive(projectile);assert.deepEqual(packets.filter(p=>p.type==='projectile_event').at(-1).velocity,[10,0,5]);
  const baseline=[];page.api.setReceiver(p=>baseline.push(copy(p)));
  assert.deepEqual(baseline.find(p=>p.type==='projectile_state').effects[0].motion_origin,[715,-1088,25]);
  socket.receive({...projectile,velocity:[0,0,Infinity]});assert.equal(socket.readyState,3);page.api.close();
});

test('过期碰撞回复保持静默，异常碰撞仅提示一次且不注销公共战局', async () => {
  const page=await harness();const socket=page.enter();await page.api.ready;
  const before=page.statuses.length;
  socket.receive({type:'error',code:'stale_collision',message:'expired'});
  socket.receive({type:'error',code:'stale_collision',message:'old observer'});
  assert.equal(page.statuses.length,before);assert.equal(socket.readyState,1);
  socket.receive({type:'error',code:'invalid_collision',message:'bad normal'});
  assert.equal(page.statuses.length,before+1);assert.equal(page.statuses.at(-1).phase,'notice');
  page.api.onWorkerMessage({type:'local_state',state:playerState()});page.advance(100);
  socket.receive({type:'error',code:'invalid_collision',message:'bad point'});
  assert.equal(page.statuses.length,before+1);assert.equal(socket.readyState,1);
  assert.equal(socket.messages('hello').length,1);assert.equal(page.sockets.length,1);page.api.close();
});


test('公共战局语言热切换只更新界面和本地桥数据，不重连、不更改线上协议', async () => {
  const page = await harness(); const socket = page.enter(); await page.api.ready;
  const packets = []; page.api.setReceiver(value => packets.push(copy(value)));
  const before = socket.sent.length;
  page.i18nModule.setLanguage({ preference: 'en', resolved: 'en', revision: 1 });
  assert.equal(page.sockets.length, 1); assert.equal(socket.sent.length, before);
  assert.equal(packets.findLast(value => value.type === 'session').language, 'en');
  assert.equal(page.statuses.at(-1).text, 'Joined Public Session');
  socket.close();
  assert.equal(page.statuses.at(-1).text, 'The session connection was interrupted. Reconnecting…');
  page.i18nModule.setLanguage('zh-CN');
  assert.equal(page.statuses.at(-1).text, '战局连接已中断。 正在重新连接…');
  page.api.close();
});
