#!/usr/bin/env node
'use strict';
// 使用轻量 DOM 和存储替身执行真实加入面板；不依赖浏览器、游戏资源或第三方库。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const i18nUrl = 'data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(root, 'client/i18n.js'), 'utf8')).toString('base64');
const i18nPromise = import(i18nUrl);
const addressPromise = import('data:text/javascript;base64,' + Buffer.from(
  fs.readFileSync(path.join(root, 'client/multiplayer/server-address.js'), 'utf8').replace("'../i18n.js'", JSON.stringify(i18nUrl))).toString('base64'));
const source = fs.readFileSync(path.join(root, 'client/multiplayer/join-modal.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '');
const copy = (value) => JSON.parse(JSON.stringify(value));
const panelKey = 'gta5.public.preferences', sessionKey = 'gta5.public.session', pendingKey = 'gta5.public.pending-join';
const preferences = (extras = {}) => ({ name: '玩家甲', server: '183.66.27.21:47485', preset: 'npc_male', ...extras });
const remoteSnapshot = (servers) => ({ config: { servers }, source: 'remote', stale: false });
const remoteLines = () => [
  { id: 'experimental', name: '实验战局', role: '实验线路', address: '183.66.27.21:47486' },
  { id: 'main', name: '公共战局', role: '主线路', address: 'wss://main.example:443/public' },
];

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

async function harness(options = {}) {
  const [address, i18n] = await Promise.all([addressPromise, i18nPromise]);
  i18n.setLanguage(options.language || 'zh-CN');
  const localStorage = options.localStorage || storage(), sessionStorage = options.sessionStorage || storage();
  const joined = [], timers = new Map();
  let timerId = 0;
  class Event {
    constructor(type, fields = {}) { this.type = type; this.defaultPrevented = false; Object.assign(this, fields); }
    preventDefault() { this.defaultPrevented = true; }
  }
  class Element {
    constructor() { this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.children = []; this.value = ''; this.textContent = ''; this.hidden = false; this.isConnected = true; }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }
    dispatchEvent(event) {
      event.target ||= this;
      for (const callback of this.listeners.get(event.type) || []) callback(event);
      return !event.defaultPrevented;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    focus() { document.activeElement = this; }
    select() { this.selected = true; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = [...children]; }
  }
  const fields = { nickname: new Element(), server: new Element(), preset: new Element() };
  const form = new Element(), message = new Element(), close = new Element(), submit = new Element();
  const serverList = new Element(), serverHint = new Element();
  form.elements = { namedItem: (name) => fields[name] };
  const overlay = new Element();
  overlay.querySelector = (selector) => ({ form, '.online-join__message': message, '.online-join__close': close,
    '.online-join__submit': submit, '#online-join-server-options': serverList,
    '#online-join-server-hint': serverHint })[selector];
  const translatedElements = ['join.eyebrow', 'join.title', 'join.nickname', 'join.server', 'join.preset', 'join.npc_male', 'join.npc_female', 'join.freemode_male', 'join.freemode_female', 'join.hint'].map((key) => { const element = new Element(); element.dataset.i18n = key; return element; });
  overlay.querySelectorAll = (selector) => selector === '[data-i18n]' ? translatedElements : [close, fields.nickname, fields.server, fields.preset, submit];
  const document = { activeElement: null, body: { append: (element) => assert.equal(element, overlay) },
    createElement: (tag) => tag === 'div' ? overlay : new Element(), exitPointerLock: () => {} };
  const href = options.href || 'http://localhost:8010/';
  const context = vm.createContext({ ...address, ...i18n, document, Event, URL, URLSearchParams,
    location: { href, search: new URL(href).search }, localStorage, sessionStorage, AbortController,
    crypto: { getRandomValues: (array) => { array[0] = 123456; return array; } }, Uint32Array,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: options.fetch || (async (url) => ({ ok: true, json: async () => url.startsWith('/api/remote-config')
      ? options.remoteConfig || null : options.config || null })),
  });
  if (options.localStorageDenied) {
    vm.runInContext("Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError'); } });", context);
  }
  vm.runInContext(source + '\nglobalThis.module = { cleanJoinServerOptions, readPublicPreferences, readPanelPreferences, savePanelPreferences, consumePublicEntryIntent, installJoinModal };',
    context, { filename: 'join-modal.js' });
  const api = context.module;
  const modal = options.install === false ? null : api.installJoinModal({ onJoin: (value) => joined.push(copy(value)) });
  async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
  await settle();
  return { api, context, modal, overlay, fields, i18n, translatedElements, closeButton: close, form, message, serverList, serverHint, submitButton: submit, localStorage, sessionStorage, joined, settle,
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
  page.input('server', '183.66.27.21:47485');
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
    page.input('server', '183.66.27.21:47485');
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

test('远程 HTTPS 健康地址保留 WSS 和完整代理路径，不随 localhost 页面降为 WS', async () => {
  const { normalizeRemoteServerAddress } = await addressPromise;
  const line = { id: 'main', name: '主线路', address: 'gtaserver.2t.hk:47485',
    health_url: 'https://gtaserver.2t.hk:47485/47485/health' };
  assert.equal(normalizeRemoteServerAddress(line), 'wss://gtaserver.2t.hk:47485/47485/ws');
  assert.equal(normalizeRemoteServerAddress({ address: 'gtaserver.2t.hk', health_url: 'https://gtaserver.2t.hk/health/' }),
    'wss://gtaserver.2t.hk/ws');
  assert.equal(normalizeRemoteServerAddress({ address: '183.66.27.21:47485' }), 'ws://183.66.27.21:47485/ws');
  assert.equal(normalizeRemoteServerAddress({ ...line, websocket_url: 'wss://gtaserver.2t.hk:47485/custom/ws' }),
    'wss://gtaserver.2t.hk:47485/custom/ws');
  assert.equal(normalizeRemoteServerAddress({ ...line, address: 'wss://gtaserver.2t.hk:47485/explicit' }),
    'wss://gtaserver.2t.hk:47485/explicit');
  assert.equal(normalizeRemoteServerAddress({ ...line, health_url: 'https://different.example:47485/health' }),
    'ws://gtaserver.2t.hk:47485/ws');
  assert.equal(normalizeRemoteServerAddress({ ...line, health_url: 'https://gtaserver.2t.hk:443/47485/health' }),
    'ws://gtaserver.2t.hk:47485/ws');
  for (const value of ['https://gtaserver.2t.hk/ws', 'wss://user:secret@gtaserver.2t.hk/ws', 'javascript:alert(1)']) {
    assert.throws(() => normalizeRemoteServerAddress({ ...line, websocket_url: value }));
  }
  const page = await harness({ remoteConfig: remoteSnapshot([line]) });
  page.modal.open(); await page.settle();
  assert.equal(page.fields.server.value, 'gtaserver.2t.hk:47485');
  page.input('nickname', '玩家WSS'); page.blur(); page.submit();
  assert.equal(page.joined[0].server, 'wss://gtaserver.2t.hk:47485/47485/ws');
  assert.equal(page.api.readPublicPreferences().server, 'wss://gtaserver.2t.hk:47485/47485/ws');
  page.modal.close(); page.modal.open(); await page.settle(); page.submit();
  assert.equal(page.joined.at(-1).server, 'wss://gtaserver.2t.hk:47485/47485/ws');
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
  denied.input('server', '183.66.27.21:47485');
  assert.doesNotThrow(() => denied.submit());
  assert.equal(denied.joined.length, 1);
  const rejected = await harness({ localStorage: {
    getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); },
  } });
  assert.equal(rejected.api.readPanelPreferences(), null);
  assert.equal(rejected.api.savePanelPreferences(preferences()), false);
  rejected.input('server', '183.66.27.21:47485');
  assert.doesNotThrow(() => rejected.submit());
  assert.equal(rejected.joined.length, 1);
});

test('重新打开主页仅恢复昵称和角色，服务器等待本次远程配置', async () => {
  const cached = preferences({ server: 'wss://room.example:443/ws', preset: 'npc_female' });
  const page = await harness({ localStorage: storage({ [panelKey]: JSON.stringify(cached) }),
    config: { instance_name: '本机玩家', multiplayer_server: '127.0.0.1:8787' } });
  assert.equal(page.fields.nickname.value, '玩家甲');
  assert.equal(page.fields.server.value, '');
  assert.equal(page.fields.preset.value, 'npc_female');
  assert.ok(page.overlay.innerHTML.includes('服务器 IP:端口'));
  assert.ok(!page.fields.server.value.includes('://'));
});

test('URL 昵称优先于缓存，URL 与本机地址均不作为线路默认值', async () => {
  const cached = preferences({ server: 'wss://saved.example:47485/ws', preset: 'freemode_female' });
  const page = await harness({ localStorage: storage({ [panelKey]: JSON.stringify(cached) }),
    href: 'http://localhost:8010/?name=%E7%8E%A9%E5%AE%B6%E4%B9%99&server=192.168.1.2%3A47485',
    config: { instance_name: '启动昵称', multiplayer_server: 'another.example:47485' } });
  assert.equal(page.fields.nickname.value, '玩家乙');
  assert.equal(page.fields.server.value, '');
  assert.equal(page.fields.preset.value, 'freemode_female');
});

test('手动输入持久化昵称和角色，刷新后线路仍重新请求远程配置', async () => {
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
  assert.equal(refreshed.fields.server.value, '');
  assert.equal(refreshed.fields.preset.value, 'freemode_male');
});

test('显示为 IP:端口的安全连接在昵称变更、失焦和提交后仍保留 WSS 与自定义路径', async () => {
  const page = await harness({ remoteConfig: remoteSnapshot([
    { id: 'main', address: 'wss://secure.example:443/custom' },
  ]) });
  page.modal.open();await page.settle();
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
  page.input('server', '183.66.27.21:47485');
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
  page.input('server', '183.66.27.21:47485');
  page.submit();
  assert.equal(page.joined.length, 0);
  assert.ok(page.message.textContent.includes('会话存储'));
});

test('模态框主动加入只创建一次新加入标记，首次导航后刷新按重连恢复', async () => {
  const page = await harness();
  page.input('server', '183.66.27.21:47485');
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

test('打开加入面板读取两条远程线路并优先主线路，选择后保留安全连接与路径', async () => {
  const requests = [];
  const page = await harness({ fetch: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => url.startsWith('/api/remote-config') ? remoteSnapshot(remoteLines()) : { multiplayer_ready: true } };
  } });
  assert.equal(requests.filter((item) => item.url.startsWith('/api/remote-config')).length, 0, '未打开面板不额外请求线路');
  page.modal.open();await page.settle();
  assert.match(page.overlay.innerHTML, /list="online-join-server-options"/);
  assert.equal(page.serverList.children.length, 2);
  assert.equal(page.serverList.children[0].label, '实验战局 · 实验线路 · 183.66.27.21:47486');
  assert.equal(page.fields.server.value, 'main.example:443');
  const remoteRequest = requests.find((item) => item.url.startsWith('/api/remote-config'));
  assert.equal(remoteRequest.url, '/api/remote-config?refresh=1');
  assert.equal(remoteRequest.options.cache, 'no-store');
  page.input('server', '183.66.27.21:47486');page.submit();
  assert.equal(page.joined[0].server, 'ws://183.66.27.21:47486/ws');
  page.input('server', 'main.example:443');page.blur();page.submit();
  assert.equal(page.joined[1].server, 'wss://main.example/public');
  assert.equal(page.localStorage.getItem('gta5.remote.config'), null, '远程线路不保存为本地配置');
});

test('本次远程主线路覆盖历史面板、游戏会话和 URL 中的地址默认值', async () => {
  for (const options of [
    { localStorage: storage({ [panelKey]: JSON.stringify(preferences({ server: 'wss://saved.example/custom' })) }) },
    { localStorage: storage({ [panelKey]: JSON.stringify(preferences({ server: '127.0.0.1:47485' })) }) },
    { sessionStorage: storage({ [sessionKey]: JSON.stringify({ ...preferences({ server: '192.168.31.2:48888' }), seed: 1 }) }) },
    { href: 'http://localhost:8010/?server=192.168.31.3%3A48888' },
  ]) {
    const page = await harness({ ...options, remoteConfig: remoteSnapshot(remoteLines()) });
    assert.equal(page.fields.server.value, '');
    page.modal.open();await page.settle();
    assert.equal(page.serverList.children.length, 2);
    assert.equal(page.fields.server.value, 'main.example:443');
  }
});

test('远程响应晚到不能覆盖用户正在输入的手动服务器', async () => {
  let finish;
  const delayed = new Promise((resolve) => { finish = resolve; });
  const page = await harness({ fetch: (url) => url.startsWith('/api/remote-config') ? delayed
    : Promise.resolve({ ok: true, json: async () => ({ multiplayer_ready: true }) }) });
  page.modal.open();
  page.input('server', '192.168.31.20:49999');
  finish({ ok: true, json: async () => remoteSnapshot(remoteLines()) });await page.settle();
  assert.equal(page.serverList.children.length, 2);
  assert.equal(page.fields.server.value, '192.168.31.20:49999');
  page.submit();assert.equal(page.joined[0].server, 'ws://192.168.31.20:49999/ws');
});

test('线路未加载或失败时空地址不可提交，也不隐式选择 localhost', async () => {
  let finish;
  const page = await harness({ fetch: (url) => url.startsWith('/api/remote-config')
    ? new Promise((resolve) => { finish = resolve; })
    : Promise.resolve({ ok: true, json: async () => ({ multiplayer_server: '127.0.0.1:47485' }) }) });
  assert.equal(page.fields.server.value, '');
  page.input('nickname', '玩家乙');
  page.input('preset', 'npc_female');
  assert.equal(page.localStorage.getItem(panelKey), null, '空地址不能因其他字段变化而持久化为 localhost');
  page.modal.open();
  page.submit();
  assert.equal(page.joined.length, 0);
  assert.equal(page.sessionStorage.values.size, 0);
  assert.equal(page.fields.server.value, '');
  assert.match(page.message.textContent, /服务器|线路|地址/);
  finish({ ok: false });await page.settle();
  assert.equal(page.serverHint.textContent, '-');
  page.input('server', '   ');page.blur();page.submit();
  assert.equal(page.joined.length, 0);
  assert.equal(page.sessionStorage.values.size, 0);
  assert.equal(page.localStorage.getItem(panelKey), null);
});

test('晚到的本机配置不能覆盖远程主线路，旧本地面板地址也不参与选择', async () => {
  let finishLocal;
  const page = await harness({ localStorage: storage({ [panelKey]: JSON.stringify(preferences({ server: '127.0.0.1:47485' })) }),
    fetch: (url) => url.startsWith('/api/remote-config')
      ? Promise.resolve({ ok: true, json: async () => remoteSnapshot(remoteLines()) })
      : new Promise((resolve) => { finishLocal = resolve; }) });
  assert.equal(page.fields.server.value, '');
  page.modal.open();await page.settle();
  assert.equal(page.fields.server.value, 'main.example:443');
  finishLocal({ ok: true, json: async () => ({ multiplayer_ready: true, multiplayer_server: '127.0.0.1:47485' }) });
  await page.settle();
  assert.equal(page.fields.server.value, 'main.example:443');
  page.submit();assert.equal(page.joined[0].server, 'wss://main.example/public');
});

test('每次重开读取当前线路，未手动修改的默认地址随远程响应更新', async () => {
  const pending = [];
  const page = await harness({ fetch: (url) => url.startsWith('/api/remote-config')
    ? new Promise((resolve) => pending.push(resolve))
    : Promise.resolve({ ok: true, json: async () => ({ multiplayer_ready: true }) }) });
  page.modal.open();
  pending[0]({ ok: true, json: async () => remoteSnapshot([{ id: 'main', address: 'old.example:48888' }]) });
  await page.settle();assert.equal(page.fields.server.value, 'old.example:48888');
  page.modal.close();page.modal.open();
  assert.equal(page.fields.server.value, '', '本次读取前不展示上一轮默认地址');
  pending[1]({ ok: true, json: async () => remoteSnapshot([{ id: 'main', address: 'new.example:49999' }]) });
  await page.settle();assert.equal(page.fields.server.value, 'new.example:49999');
  page.submit();assert.equal(page.joined[0].server, 'ws://new.example:49999/ws');
});

test('没有 main 时选择首条有效远程线路，拒绝静态或陈旧线路作为默认值', async () => {
  for (const snapshot of [null, { source: 'cache', stale: false, config: { servers: remoteLines() } },
    { source: 'remote', stale: true, config: { servers: remoteLines() } }]) {
    const page = await harness({ remoteConfig: snapshot });
    page.modal.open();await page.settle();
    assert.equal(page.fields.server.value, '');
    assert.equal(page.serverHint.textContent, '-');
  }
  const page = await harness({ remoteConfig: remoteSnapshot([
    { id: 'invalid', address: '/ws' }, { id: 'other', address: 'first.example:49999' },
    { id: 'another', address: 'second.example:48888' },
  ]) });
  page.modal.open();await page.settle();
  assert.equal(page.fields.server.value, 'first.example:49999');
});

test('手动完整 WSS 地址跨关闭重开保留，远程线路更新不能改变输入', async () => {
  const page = await harness({ remoteConfig: remoteSnapshot(remoteLines()) });
  page.modal.open();await page.settle();
  page.input('server', 'wss://manual.example:443/custom');page.blur();
  assert.equal(page.fields.server.value, 'manual.example:443');
  page.modal.close();page.modal.open();await page.settle();
  assert.equal(page.fields.server.value, 'manual.example:443');
  page.submit();assert.equal(page.joined[0].server, 'wss://manual.example/custom');
});

test('加入面板等待远程默认值时游戏会话仍保留完整重连地址与身份', async () => {
  const stored = { ...preferences({ server: 'wss://session.example:443/room', preset: 'freemode_male' }), seed: 321 };
  const page = await harness({ sessionStorage: storage({ [sessionKey]: JSON.stringify(stored) }),
    remoteConfig: remoteSnapshot(remoteLines()) });
  assert.equal(page.fields.server.value, '');
  assert.deepEqual(copy(page.api.readPublicPreferences()), { ...stored, server: 'wss://session.example/room' });
  page.modal.open();await page.settle();
  assert.equal(page.fields.server.value, 'main.example:443');
  assert.deepEqual(JSON.parse(page.sessionStorage.getItem(sessionKey)), stored, '读取线路不得篡改现有重连会话');
  assert.equal(page.fields.nickname.value, stored.name);
  assert.equal(page.fields.preset.value, stored.preset);
});

test('线路请求失败清空旧选项，重新打开重新联网，失败不阻止手动加入', async () => {
  let calls = 0;
  const page = await harness({ fetch: async (url) => {
    if (!url.startsWith('/api/remote-config')) return { ok: true, json: async () => ({ multiplayer_ready: true }) };
    if (++calls === 2) throw new Error('网络不可用');
    return { ok: true, json: async () => remoteSnapshot(remoteLines()) };
  } });
  page.modal.open();await page.settle();assert.equal(page.serverList.children.length, 2);
  page.modal.close();assert.equal(page.serverList.children.length, 0);
  page.modal.open();await page.settle();
  assert.equal(page.serverList.children.length, 0);assert.equal(page.serverHint.textContent, '-');
  assert.equal(page.fields.server.value, '', '失败时不保留上次自动选择的线路');
  page.submit();assert.equal(page.joined.length, 0);
  page.input('server', '192.168.31.30:49999');page.submit();
  assert.equal(page.joined[0].server, 'ws://192.168.31.30:49999/ws');
  page.modal.close();page.modal.open();await page.settle();
  assert.equal(page.serverList.children.length, 2);assert.equal(calls, 3);
  assert.equal(page.fields.server.value, '192.168.31.30:49999', '重试成功仍保留手动服务器');
});

test('关闭后旧请求晚到不能替换新打开面板的线路与当前服务器', async () => {
  const finishes = [];
  const page = await harness({ fetch: (url) => url.startsWith('/api/remote-config')
    ? new Promise((resolve) => finishes.push(resolve)) : Promise.resolve({ ok: true, json: async () => ({}) }) });
  page.modal.open();page.modal.close();page.modal.open();
  finishes[1]({ ok: true, json: async () => remoteSnapshot([{ id: 'main', name: '新线路', address: 'new.example:49999' }]) });
  await page.settle();assert.equal(page.fields.server.value, 'new.example:49999');
  finishes[0]({ ok: true, json: async () => remoteSnapshot([{ id: 'main', name: '旧线路', address: 'old.example:49999' }]) });
  await page.settle();
  assert.equal(page.serverList.children.length, 1);
  assert.equal(page.serverList.children[0].label, '新线路 · new.example:49999');
  assert.equal(page.fields.server.value, 'new.example:49999');
});

test('线路兼容对象和数组，拒绝缓存、无效地址和多余线路；名称按文本显示', async () => {
  const page = await harness({ install: false });
  const clean = (snapshot) => copy(page.api.cleanJoinServerOptions(snapshot, 'http://localhost:8010/'));
  for (const server of [{ address: '183.66.27.21:47485' }, [{ address: '183.66.27.21:47485' }]])
    assert.equal(clean({ source: 'remote', stale: false, config: { server } }).length, 1);
  for (const snapshot of [null, { source: 'cache', stale: false, config: { servers: remoteLines() } },
    { source: 'remote', stale: true, config: { servers: remoteLines() } }]) assert.deepEqual(clean(snapshot), []);
  const safe = clean(remoteSnapshot([null, {}, { address: '' }, { address: 'javascript:alert(1)' },
    { address: 'ws://user:secret@example.com' }, { address: 'valid.example:49999', name: '<img src=x onerror=alert(1)>', role: '主线路' },
    { address: 'valid.example:49999', name: '重复线路' }]));
  assert.equal(safe.length, 1);
  const realPage = await harness({ remoteConfig: remoteSnapshot([{
    address: 'valid.example:49999', name: '<img src=x onerror=alert(1)>', role: '主线路',
  }]) });
  realPage.modal.open();await realPage.settle();
  assert.equal(realPage.serverList.children[0].textContent, '<img src=x onerror=alert(1)> · 主线路 · valid.example:49999');
  assert.equal(realPage.serverList.children[0].innerHTML, undefined, '远程内容没有作为 HTML 写入');
  assert.equal(clean(remoteSnapshot(Array.from({ length: 40 }, (_, index) => ({ address: `room${index}.example:49999` })))).length, 32);
});


test('语言切换即时更新表单、错误、线路与可访问名称，保留用户已编辑昵称', async () => {
  const page = await harness({ remoteConfig: remoteSnapshot(remoteLines()) });
  page.modal.open(); await page.settle();
  page.input('nickname', 'Custom Player'); page.input('server', ''); page.submit();
  assert.match(page.message.textContent, /请选择/);
  page.i18n.setLanguage({ preference: 'en', resolved: 'en', revision: 2 });
  assert.equal(page.fields.nickname.value, 'Custom Player');
  assert.equal(page.fields.nickname.placeholder, 'Enter your nickname');
  assert.equal(page.closeButton.attributes['aria-label'], 'Close session dialog');
  assert.equal(page.submitButton.textContent, 'Join Session');
  assert.equal(page.translatedElements.find(element => element.dataset.i18n === 'join.npc_female').textContent, 'Random female NPC');
  assert.equal(page.message.textContent, 'Choose a server or enter its IP:port.');
  assert.match(page.serverList.children[1].label, /Public Session · Main server/);
  page.i18n.setLanguage('zh-CN');
  assert.match(page.message.textContent, /请选择/);
});


test('远程线路显式语言配置热切换覆盖默认名字，昵称与连接端点保留', async () => {
  const page = await harness({ remoteConfig: remoteSnapshot([{ id:'main', name:'自定义线路', role:'主线路', address:'wss://custom.example/public',
    i18n:{ en:{ name:'Custom Session',role:'Primary' },'zh-CN':{ name:'共同城市', role:'公共线路' } } }]) });
  page.modal.open(); await page.settle();
  assert.match(page.serverList.children[0].label, /共同城市 · 公共线路/);
  const address = page.fields.server.value; page.i18n.setLanguage('en');
  assert.match(page.serverList.children[0].label, /Custom Session · Primary/);
  assert.equal(page.fields.server.value, address);
  page.i18n.setLanguage('zh-CN');
});
