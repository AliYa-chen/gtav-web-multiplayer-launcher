'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../client/i18n.js'), 'utf8').replace(/^export /gm, '');

function harness({ language = 'en-US', responses = [] } = {}) {
  const timers = new Map(), events = new Map(), requests = [], changes = [];
  let timerId = 0;
  const addEventListener = (type, callback) => { const listeners = events.get(type) || []; listeners.push(callback); events.set(type, listeners); };
  class CustomEvent { constructor(type, { detail }) { this.type = type; this.detail = detail; } }
  const document = { documentElement: { lang: '' }, visibilityState: 'visible', addEventListener,
    dispatchEvent: event => { changes.push(event.detail); for (const callback of events.get(event.type) || []) callback(event); } };
  const context = vm.createContext({ document, CustomEvent, AbortController, navigator: { language },
    // A query preference must never supersede the launcher's global selection.
    location: { search: '?language=zh-CN' }, addEventListener,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      requests.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response();
      return { ok: response != null, json: async () => response };
    } });
  vm.runInContext(source + '\nglobalThis.api = { t, getLanguage, resolveLanguage, setLanguage, translateText, localizeServerError, onLanguageChange, initLanguage };', context);
  const fire = (type, value = {}) => { for (const callback of events.get(type) || []) callback(value); };
  const poll = async () => {
    const entry = [...timers].find(([, timer]) => timer.delay === 2000);
    assert.ok(entry, 'language polling should remain scheduled'); timers.delete(entry[0]); await entry[1].callback();
  };
  return { api: context.api, document, timers, changes, requests, fire, poll };
}

test('launcher language overrides browser and URL, translations preserve parameters and diagnostics', async () => {
  const page = harness({ responses: [{ preference: 'en', resolved: 'en', revision: 11 }] });
  await page.api.initLanguage();
  assert.equal(page.api.getLanguage(), 'en'); assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(page.api.t('page.data', { mb: 125, speed: '' }), 'Game data: 125 MB');
  assert.equal(page.api.translateText('正在初始化图形'), 'Starting graphics');
  assert.equal(page.api.translateText('Downloading the engine (23 MB)'), 'Downloading the engine (23 MB)');
  assert.equal(page.api.translateText('原始诊断与未知内容'), '原始诊断与未知内容');
  assert.equal(page.requests[0].url, '/api/language'); assert.equal(page.requests[0].options.cache, 'no-store');
  page.fire('pagehide'); assert.equal(page.timers.size, 0);
});

test('active pages poll launcher shared configuration and retain selection when offline', async () => {
  const page = harness({ responses: [
    { preference: 'zh-CN', resolved: 'zh-CN', revision: 20 },
    { preference: 'en', resolved: 'en', revision: 21 }, new Error('offline'),
    { preference: 'system', resolved: 'zh-CN', revision: 22 },
  ] });
  const callbacks = []; const stop = page.api.onLanguageChange(value => callbacks.push(value.language));
  await page.api.initLanguage(); await page.poll();
  assert.equal(page.api.getLanguage(), 'en'); assert.equal(page.api.t('join.submit'), 'Join Session');
  await page.poll(); assert.equal(page.api.getLanguage(), 'en', 'offline cannot revert to navigator language');
  await page.poll(); assert.equal(page.api.getLanguage(), 'zh-CN'); assert.equal(page.api.t('join.submit'), '加入战局');
  assert.deepEqual(callbacks, ['zh-CN', 'en', 'zh-CN']);
  stop(); page.fire('pagehide');
});

test('hidden pages pause requests and visibility resumes immediately; stale replies cannot overwrite new selection', async () => {
  let finishOld;
  const page = harness({ responses: [
    { preference: 'en', resolved: 'en', revision: 1 },
    () => new Promise(resolve => { finishOld = resolve; }),
    { preference: 'zh-CN', resolved: 'zh-CN', revision: 3 },
  ] });
  await page.api.initLanguage(); page.document.visibilityState = 'hidden'; await page.poll();
  assert.equal(page.requests.length, 1);
  page.document.visibilityState = 'visible'; page.fire('visibilitychange');
  await Promise.resolve(); page.fire('visibilitychange');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.api.getLanguage(), 'zh-CN');
  finishOld({ ok: true, json: async () => ({ preference: 'en', resolved: 'en', revision: 2 }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.api.getLanguage(), 'zh-CN'); page.fire('pagehide');
});

test('missing launcher endpoint follows navigator and invalid configuration cannot change language', async () => {
  const page = harness({ language: 'zh-Hant-TW', responses: [null] });
  await page.api.initLanguage(); assert.equal(page.api.getLanguage(), 'zh-CN');
  for (const value of ['fr', null, {}, { preference: 'en', resolved: 'fr', revision: 1 }, { preference: 'en', resolved: 'en', revision: -1 }, { preference: 'en', resolved: 'zh-CN', revision: 2 }]) {
    assert.equal(page.api.setLanguage(value), false); assert.equal(page.api.getLanguage(), 'zh-CN');
  }
  assert.equal(page.api.setLanguage({ preference: 'system', resolved: null, revision: 4 }), true);
  assert.equal(page.api.getLanguage(), 'zh-CN');
  assert.equal(page.api.translateText('The server is busy, retrying (4)'), '服务器繁忙，正在重试（第 4 次）');
  assert.equal(page.api.translateText('engine download failed: RuntimeError: unreachable'), '游戏引擎下载失败：运行时错误：执行到不可达指令');
  page.fire('pagehide');
});

test('launcher restart may reset revision without preventing a new authoritative language', async () => {
  const page = harness({ language: 'zh-CN', responses: [
    { preference: 'system', resolved: 'en', revision: 18 },
    { preference: 'zh-CN', resolved: 'zh-CN', revision: 1 },
  ] });
  await page.api.initLanguage();
  assert.equal(page.api.getLanguage(), 'en', 'launcher system resolution has priority over browser language');
  await page.poll(); assert.equal(page.api.getLanguage(), 'zh-CN');
  page.fire('pagehide');
  const noBrowserLocale = harness({ language: null, responses: [null] });
  await noBrowserLocale.api.initLanguage(); assert.equal(noBrowserLocale.api.getLanguage(), 'en');
  noBrowserLocale.fire('pagehide');
});

test('typed server errors localize code meanings and keep unknown diagnostics out of English UI', () => {
  const page = harness();
  assert.equal(page.api.localizeServerError({ code: 'too_far', message: '角色距离车辆过远' }, 'en'), 'Move closer to the target and try again.');
  for (const code of ['future_error', '__proto__', 'toString', '中文错误码', null]) {
    assert.equal(page.api.localizeServerError({ code, message: '中文原始诊断' }, 'en'), 'The server could not complete this action. Please try again.');
  }
  assert.equal(page.api.localizeServerError({ code: 'invalid_request', message: '同一请求ID不能复用为不同内容' }, 'zh-CN'), '同一请求ID不能复用为不同内容');
});
