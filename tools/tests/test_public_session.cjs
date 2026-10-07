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
  const storage = new Map(), timers = new Map(), events = new Map(), sockets = [], statuses = [], logs = [];
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
    sessionStorage: { getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    fetch: (_url, request) => { logs.push(request.body); return Promise.resolve({ ok: true }); },
    setTimeout, clearTimeout, addEventListener, removeEventListener,
  });
  vm.runInContext(source + '\nglobalThis.startSession = startPublicSession;', context, { filename: 'public-session.js' });
  const profile = options.preferences || preferences();
  const identityKey = 'gta5.public.identity:ws://183.66.27.21:47485/ws:' + profile.name;
  if (options.identity) storage.set(identityKey, JSON.stringify(options.identity));
  const api = await context.startSession(profile, (value) => statuses.push(copy(value)));
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
    const page = await harness({ identity: { client_id: 'EXPIRED', resume_token: 'expired-secret' } });
    const socket = page.sockets[0]; socket.welcome();
    assert.equal(socket.messages('hello')[0].client_id, 'EXPIRED');
    socket.receive({ type: 'error', code, message: '恢复信息已到期' });
    assert.equal(page.sockets.length, 1); assert.equal(socket.readyState, 1);
    assert.equal(socket.messages('hello').length, 2);
    assert.ok(!Object.hasOwn(socket.messages('hello')[1], 'resume_token'));
    assert.equal(page.storage.has(page.identityKey), false);
    page.enter(socket, 'NEW'); await page.api.ready;
    assert.equal(page.statuses.at(-1).connected, true);
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
