#!/usr/bin/env node
'use strict';
// 使用轻量 DOM 和存储替身执行真实加入面板；不依赖浏览器、游戏资源或第三方库。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const addressPromise = import('data:text/javascript;base64,' + Buffer.from(
  fs.readFileSync(path.join(root, 'client/multiplayer/server-address.js'), 'utf8')).toString('base64'));
const source = fs.readFileSync(path.join(root, 'client/multiplayer/join-modal.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '');
const copy = (value) => JSON.parse(JSON.stringify(value));
const panelKey = 'gta5.public.preferences', sessionKey = 'gta5.public.session', pendingKey = 'gta5.public.pending-join';
const preferences = (extras = {}) => ({ name: '玩家甲', server: '183.66.27.21:47485', preset: 'npc_male', ...extras });

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

async function harness(options = {}) {
  const address = await addressPromise;
  const localStorage = options.localStorage || storage(), sessionStorage = options.sessionStorage || storage();
  const joined = [], timers = new Map();
  let timerId = 0;
  class Event {
    constructor(type, fields = {}) { this.type = type; this.defaultPrevented = false; Object.assign(this, fields); }
    preventDefault() { this.defaultPrevented = true; }
  }
  class Element {
    constructor() { this.listeners = new Map(); this.value = ''; this.hidden = false; this.isConnected = true; }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }
    dispatchEvent(event) {
      event.target ||= this;
      for (const callback of this.listeners.get(event.type) || []) callback(event);
      return !event.defaultPrevented;
    }
    focus() { document.activeElement = this; }
    select() { this.selected = true; }
  }
  const fields = { nickname: new Element(), server: new Element(), preset: new Element() };
  const form = new Element(), message = new Element(), close = new Element(), submit = new Element();
  form.elements = { namedItem: (name) => fields[name] };
  const overlay = new Element();
  overlay.querySelector = (selector) => ({ form, '.online-join__message': message, '.online-join__close': close,
    '.online-join__submit': submit })[selector];
  overlay.querySelectorAll = () => [close, fields.nickname, fields.server, fields.preset, submit];
  const document = { activeElement: null, body: { append: (element) => assert.equal(element, overlay) },
    createElement: () => overlay, exitPointerLock: () => {} };
  const href = options.href || 'http://localhost:8010/';
  const context = vm.createContext({ ...address, document, Event, URL, URLSearchParams,
    location: { href, search: new URL(href).search }, localStorage, sessionStorage, AbortController,
    crypto: { getRandomValues: (array) => { array[0] = 123456; return array; } }, Uint32Array,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: options.fetch || (async () => ({ ok: true, json: async () => options.config || null })),
  });
  if (options.localStorageDenied) {
    vm.runInContext("Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError'); } });", context);
  }
  vm.runInContext(source + '\nglobalThis.module = { readPublicPreferences, readPanelPreferences, savePanelPreferences, consumePublicEntryIntent, installJoinModal };',
    context, { filename: 'join-modal.js' });
  const api = context.module;
  const modal = options.install === false ? null : api.installJoinModal({ onJoin: (value) => joined.push(copy(value)) });
  async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
  await settle();
  return { api, context, modal, overlay, fields, form, message, submitButton: submit, localStorage, sessionStorage, joined, settle,
    input: (name, value) => { fields[name].value = value; fields[name].dispatchEvent(new Event(name === 'preset' ? 'change' : 'input')); },
    blur: () => fields.server.dispatchEvent(new Event('blur')),
    submit: () => form.dispatchEvent(new Event('submit')) };
}

test('启动器明确报告缺少多人副本时阻止加入并给出构建及重启说明', async () => {
  const page = await harness({ config: { multiplayer_ready: false, multiplayer_server: '183.66.27.21:47485' } });
  assert.equal(page.submitButton.disabled, true);
  page.modal.open();
  page.submit();
  assert.equal(page.joined.length, 0);
  assert.equal(page.sessionStorage.values.size, 0, '不可为缺少运行副本的加入写入会话与新加入标记');
  assert.match(page.message.textContent, /build_multiplayer_client\.py/);
  assert.match(page.message.textContent, /重启 serve_local\.py/);
});

test('配置请求尚未完成时阻止提交，确认副本可用后才允许加入', async () => {
  let resolveConfig;
  const response = new Promise((resolve) => { resolveConfig = resolve; });
  const page = await harness({ fetch: () => response });
  assert.equal(page.submitButton.disabled, true);
  page.modal.open();
  page.submit();
  assert.equal(page.joined.length, 0);
  assert.equal(page.sessionStorage.values.size, 0);
  assert.match(page.message.textContent, /正在检查/);
  resolveConfig({ ok: true, json: async () => ({ multiplayer_ready: true }) });
  await page.settle();
  assert.equal(page.submitButton.disabled, false);
  assert.equal(page.message.textContent, '');
  assert.equal(page.joined.length, 0, '检查完成不能自动消费检查期间的提交');
  page.submit();
  assert.equal(page.joined.length, 1);
});

test('延迟配置报告缺少副本时始终拒绝加入，不因请求完成解除限制', async () => {
  let resolveConfig;
  const response = new Promise((resolve) => { resolveConfig = resolve; });
  const page = await harness({ fetch: () => response });
  page.submit();
  resolveConfig({ ok: true, json: async () => ({ multiplayer_ready: false }) });
  await page.settle();
  page.submit();
  assert.equal(page.submitButton.disabled, true);
  assert.equal(page.joined.length, 0);
  assert.equal(page.sessionStorage.values.size, 0);
  assert.match(page.message.textContent, /多人运行副本尚未就绪/);
});

test('没有 local-config 接口或旧配置未提供 readiness 时仍允许已有部署加入', async () => {
  for (const options of [
    { fetch: async () => ({ ok: false, json: async () => { throw new Error('404 不应读取 JSON'); } }) },
    { fetch: async () => { throw new Error('接口不可用'); } },
    { config: { instance_name: '旧启动器玩家' } },
  ]) {
    const page = await harness(options);
    assert.equal(page.submitButton.disabled, false);
    page.submit();
    assert.equal(page.joined.length, 1);
  }
});

test('服务器地址只显示主机和有效端口，支持 IPv4、IPv6 和标准端口', async () => {
  const { normalizeServerAddress, displayServerAddress } = await addressPromise;
  for (const [input, shown, normalized] of [
    ['183.66.27.21', '183.66.27.21:47485', 'ws://183.66.27.21:47485/ws'],
    ['ws://example.com:80/ws', 'example.com:80', 'ws://example.com/ws'],
    ['wss://example.com:443/ws', 'example.com:443', 'wss://example.com/ws'],
    ['wss://example.com:47485/custom', 'example.com:47485', 'wss://example.com:47485/custom'],
    ['::1', '[::1]:47485', 'ws://[::1]:47485/ws'],
    ['[2001:db8::1]:47485', '[2001:db8::1]:47485', 'ws://[2001:db8::1]:47485/ws'],
  ]) {
    assert.equal(displayServerAddress(input), shown);
    assert.equal(normalizeServerAddress(input), normalized);
    assert.equal(normalizeServerAddress(normalized), normalized, '规范化后再次读取不能改变端口');
  }
  assert.equal(displayServerAddress('example.com', 'https://game.example/'), 'example.com:47485');
  assert.throws(() => displayServerAddress('ws://example.com', 'https://game.example/'), /wss/);
});

test('面板偏好保存在 localStorage，昵称修剪、角色和安全地址均可重新读取', async () => {
  const page = await harness({ install: false });
  assert.equal(page.api.savePanelPreferences(preferences({ name: '  玩家甲  ', server: 'wss://game.example:443/custom' })), true);
  assert.deepEqual(copy(page.api.readPanelPreferences()),
    preferences({ server: 'wss://game.example/custom' }));
  assert.equal(page.sessionStorage.values.size, 0, '面板设置不能提前创建游戏会话');
  assert.equal(Object.hasOwn(JSON.parse(page.localStorage.getItem(panelKey)), 'seed'), false);
});

test('无效和损坏的缓存不进入加入面板，昵称长度按 Unicode 字符判断', async () => {
  const page = await harness({ install: false });
  for (const value of ['{', 'null', '[]', JSON.stringify({}),
    JSON.stringify(preferences({ name: '' })), JSON.stringify(preferences({ name: '😀'.repeat(25) })),
    JSON.stringify(preferences({ preset: 'unknown' })), JSON.stringify(preferences({ server: '/ws' }))]) {
    page.localStorage.setItem(panelKey, value);
    assert.equal(page.api.readPanelPreferences(), null, value);
  }
  assert.equal(page.api.savePanelPreferences(preferences({ name: '😀'.repeat(24) })), true);
  assert.equal(page.api.readPanelPreferences().name, '😀'.repeat(24));
  for (const value of [preferences({ name: '' }), preferences({ name: '😀'.repeat(25) }),
    preferences({ preset: 'unknown' }), preferences({ server: '/ws' })]) {
    assert.equal(page.api.savePanelPreferences(value), false);
  }
});

test('浏览器拒绝 localStorage 读取或写入时可继续加入，不抛出存储异常', async () => {
  const denied = await harness({ localStorageDenied: true });
  assert.equal(denied.api.readPanelPreferences(), null);
  assert.equal(denied.api.savePanelPreferences(preferences()), false);
  assert.doesNotThrow(() => denied.submit());
  assert.equal(denied.joined.length, 1);
  const rejected = await harness({ localStorage: {
    getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); },
  } });
  assert.equal(rejected.api.readPanelPreferences(), null);
  assert.equal(rejected.api.savePanelPreferences(preferences()), false);
  assert.doesNotThrow(() => rejected.submit());
  assert.equal(rejected.joined.length, 1);
});

test('重新打开主页使用保存的面板字段，不会被本机启动配置覆盖', async () => {
  const cached = preferences({ server: 'wss://room.example:443/ws', preset: 'npc_female' });
  const page = await harness({ localStorage: storage({ [panelKey]: JSON.stringify(cached) }),
    config: { instance_name: '本机玩家', multiplayer_server: '127.0.0.1:8787' } });
  assert.equal(page.fields.nickname.value, '玩家甲');
  assert.equal(page.fields.server.value, 'room.example:443');
  assert.equal(page.fields.preset.value, 'npc_female');
  assert.ok(page.overlay.innerHTML.includes('服务器 IP:端口'));
  assert.ok(!page.fields.server.value.includes('://'));
});

test('URL 参数优先于缓存，角色仍使用已保存的选择', async () => {
  const cached = preferences({ server: 'wss://saved.example:47485/ws', preset: 'freemode_female' });
  const page = await harness({ localStorage: storage({ [panelKey]: JSON.stringify(cached) }),
    href: 'http://localhost:8010/?name=%E7%8E%A9%E5%AE%B6%E4%B9%99&server=192.168.1.2%3A47485',
    config: { instance_name: '启动昵称', multiplayer_server: 'another.example:47485' } });
  assert.equal(page.fields.nickname.value, '玩家乙');
  assert.equal(page.fields.server.value, '192.168.1.2:47485');
  assert.equal(page.fields.preset.value, 'freemode_female');
});

test('输入昵称、服务器和更换角色立即持久化，刷新后恢复相同字段', async () => {
  const local = storage();
  const page = await harness({ localStorage: local });
  page.input('nickname', '  新玩家  ');
  page.input('server', '192.168.31.10:49494');
  page.input('preset', 'freemode_male');
  assert.deepEqual(copy(page.api.readPanelPreferences()), preferences({ name: '新玩家',
    server: 'ws://192.168.31.10:49494/ws', preset: 'freemode_male' }));
  assert.equal(page.sessionStorage.values.size, 0);
  const refreshed = await harness({ localStorage: local });
  assert.equal(refreshed.fields.nickname.value, '新玩家');
  assert.equal(refreshed.fields.server.value, '192.168.31.10:49494');
  assert.equal(refreshed.fields.preset.value, 'freemode_male');
});

test('显示为 IP:端口的安全连接在昵称变更、失焦和提交后仍保留 WSS 与自定义路径', async () => {
  const cached = preferences({ server: 'wss://secure.example:443/custom', preset: 'npc_female' });
  const page = await harness({ localStorage: storage({ [panelKey]: JSON.stringify(cached) }) });
  assert.equal(page.fields.server.value, 'secure.example:443');
  page.input('nickname', '玩家乙');
  page.input('preset', 'freemode_female');
  page.blur();
  page.submit();
  assert.equal(page.joined.length, 1);
  assert.deepEqual(page.joined[0], { name: '玩家乙', server: 'wss://secure.example/custom',
    preset: 'freemode_female', seed: 123456 });
  assert.deepEqual(JSON.parse(page.sessionStorage.getItem(sessionKey)), page.joined[0]);
  assert.equal(page.api.readPanelPreferences().server, 'wss://secure.example/custom');
  assert.equal(page.fields.server.value, 'secure.example:443');
});

test('输入完整安全地址失焦后仅显示主机和端口，提交仍连接安全端点', async () => {
  const page = await harness();
  page.input('server', 'wss://new.example:49494/ws');
  page.blur();
  assert.equal(page.fields.server.value, 'new.example:49494');
  page.submit();
  assert.equal(page.joined[0].server, 'wss://new.example:49494/ws');
});

test('不完整输入保留上次有效偏好，提交无效地址或昵称时不创建战局', async () => {
  const page = await harness();
  page.input('nickname', '玩家乙');
  const valid = page.localStorage.getItem(panelKey);
  page.input('server', 'ws://');
  assert.equal(page.localStorage.getItem(panelKey), valid);
  page.submit();
  assert.equal(page.joined.length, 0);
  assert.ok(page.message.textContent.includes('格式'));
  assert.equal(page.sessionStorage.values.size, 0);
  page.input('server', '183.66.27.21:47485');
  page.input('nickname', '😀'.repeat(25));
  page.submit();
  assert.equal(page.joined.length, 0);
  assert.ok(page.message.textContent.includes('24'));
});

test('禁用会话存储会显示错误并停止加入，永久偏好存储成功不能替代战局会话', async () => {
  const page = await harness({ sessionStorage: { getItem: () => null,
    setItem() { throw new Error('SecurityError'); } } });
  page.submit();
  assert.equal(page.joined.length, 0);
  assert.ok(page.message.textContent.includes('会话存储'));
});

test('模态框主动加入只创建一次新加入标记，首次导航后刷新按重连恢复', async () => {
  const page = await harness();
  page.submit();
  assert.equal(page.sessionStorage.getItem(pendingKey), '1');
  assert.equal(page.api.consumePublicEntryIntent('navigate'), false);
  assert.equal(page.sessionStorage.getItem(pendingKey), null);
  assert.equal(page.api.consumePublicEntryIntent('navigate'), true, '新加入标记只能使用一次');
  assert.equal(page.api.consumePublicEntryIntent('reload'), true);
  assert.equal(page.sessionStorage.getItem(sessionKey) !== null, true, '消费意图不能删除会话设置');
});

test('刷新、直接打开与浏览器前进后退优先恢复战局，标记不可使刷新创建新玩家', async () => {
  const page = await harness({ install: false });
  for (const navigation of ['navigate', 'back_forward', undefined]) {
    assert.equal(page.api.consumePublicEntryIntent(navigation), true);
  }
  page.sessionStorage.setItem(pendingKey, '1');
  assert.equal(page.api.consumePublicEntryIntent('reload'), true);
  assert.equal(page.sessionStorage.getItem(pendingKey), null);
  page.sessionStorage.setItem(pendingKey, '1');
  assert.equal(page.api.consumePublicEntryIntent('back_forward'), true, '历史导航不能消费残留标记成为新玩家');
  assert.equal(page.sessionStorage.getItem(pendingKey), null);
  page.sessionStorage.setItem(pendingKey, 'invalid');
  assert.equal(page.api.consumePublicEntryIntent('navigate'), true);
  assert.equal(page.sessionStorage.getItem(pendingKey), null);
});

test('无法读取或移除新加入标记时安全回落重连意图，不抛出浏览器存储错误', async () => {
  const page = await harness({ install: false });
  assert.equal(page.api.consumePublicEntryIntent('navigate', {
    getItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); },
  }), true);
  assert.equal(page.api.consumePublicEntryIntent('navigate', {
    getItem: () => '1', removeItem() { throw new Error('SecurityError'); },
  }), true);
});
