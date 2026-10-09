import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src-tauri/src/lan-probe.js', import.meta.url), 'utf8');
function fixture(fetch, extra = {}) {
  const context = vm.createContext({ AbortController, URL, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const redirects = [], statuses = [], requests = [];
  const probe = context.GTA5LanProbe.createProbe({
    httpsUrl: 'https://192.168.1.20:8443/', fingerprint: 'AA:BB:CC', timeoutMs: 100,
    fetch: (...args) => { requests.push(args); return fetch(...args); },
    redirect: url => redirects.push(url), status: text => statuses.push(text), ...extra,
  });
  return { probe, redirects, statuses, requests };
}
function response(body, properties = {}) {
  return { ok: true, type: 'cors', json: async () => body, ...properties };
}

test('trusted matching resource host enters HTTPS once using a real CORS response', async () => {
  const { probe, redirects, requests } = fixture(async () => response({ ready: true, fingerprint: 'AA:BB:CC' }));
  assert.equal(await probe.check(), true);
  assert.equal(await probe.check(), false);
  assert.deepEqual(redirects, ['https://192.168.1.20:8443/']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'https://192.168.1.20:8443/api/lan/ready');
  assert.equal(requests[0][1].mode, 'cors');
  assert.equal(requests[0][1].credentials, 'omit');
  assert.equal(requests[0][1].cache, 'no-store');
  assert.equal(requests[0][1].redirect, 'error');
});

test('untrusted TLS remains on the guide and can retry after trust changes', async () => {
  let trusted = false;
  const { probe, redirects, statuses } = fixture(async () => {
    if (!trusted) throw new TypeError('Failed to fetch');
    return response({ ready: true, fingerprint: 'AA:BB:CC' });
  });
  assert.equal(await probe.check(), false);
  assert.deepEqual(redirects, []);
  assert.match(statuses.at(-1), /安装并信任/);
  trusted = true;
  assert.equal(await probe.check(), true);
  assert.equal(redirects.length, 1);
});

test('wrong CA, false readiness, opaque responses, invalid JSON and HTTP failures cannot enter', async () => {
  for (const reply of [
    response({ ready: true, fingerprint: 'WRONG' }),
    response({ ready: false, fingerprint: 'AA:BB:CC' }),
    response({ ready: true, fingerprint: 'AA:BB:CC' }, { type: 'opaque' }),
    response({}, { ok: false }),
    response({}, { json: async () => { throw new Error('invalid JSON'); } }),
  ]) {
    const { probe, redirects } = fixture(async () => reply);
    assert.equal(await probe.check(), false);
    assert.deepEqual(redirects, []);
  }
});

test('one request is in flight and a timeout permits a fresh bounded retry', async () => {
  const signals = [];
  let finish;
  const { probe, redirects, requests } = fixture((_, options) => {
    signals.push(options.signal);
    return new Promise(resolve => { finish = resolve; });
  }, { timeoutMs: 15 });
  const first = probe.check();
  assert.equal(await probe.check(), false);
  assert.equal(requests.length, 1);
  assert.equal(await first, false);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(redirects, []);
  const retry = probe.check();
  assert.equal(requests.length, 2);
  finish(response({ ready: true, fingerprint: 'AA:BB:CC' }));
  assert.equal(await retry, true);
  assert.equal(redirects.length, 1);
});

test('readiness body parsing is covered by the same timeout', async () => {
  const { probe, redirects } = fixture(async () => response({}, { json: () => new Promise(() => {}) }), { timeoutMs: 15 });
  assert.equal(await probe.check(), false);
  assert.deepEqual(redirects, []);
});

test('status keys and optional translations preserve certificate checks and default Chinese behavior', async () => {
  let language = 'en', trusted = false;
  const statuses = [], translations = {
    'status.checking': ['检测中', 'Checking trust'],
    'status.untrusted': ['证书尚未信任', 'Certificate not trusted'],
    'status.verified': ['已验证', 'Verified'],
  };
  const { probe, redirects, requests } = fixture(async () => {
    if (!trusted) throw new TypeError('untrusted TLS');
    return response({ ready: true, fingerprint: 'AA:BB:CC' });
  }, {
    translate: key => translations[key][language === 'en' ? 1 : 0],
    status: (text, ready, key) => statuses.push({ text, ready, key }),
  });
  assert.equal(await probe.check(), false);
  assert.deepEqual(statuses.at(-1), { text: 'Certificate not trusted', ready: false, key: 'status.untrusted' });
  assert.deepEqual(redirects, []);
  language = 'zh-CN'; trusted = true;
  assert.equal(await probe.check(), true);
  assert.deepEqual(statuses.at(-1), { text: '已验证', ready: true, key: 'status.verified' });
  assert.equal(requests[1][0], 'https://192.168.1.20:8443/api/lan/ready');
  assert.deepEqual(redirects, ['https://192.168.1.20:8443/']);
  const fallback = fixture(async () => response({ ready: true, fingerprint: 'WRONG' }), {
    translate: () => { throw new Error('translation failed'); },
  });
  assert.equal(await fallback.probe.check(), false);
  assert.match(fallback.statuses.at(-1), /证书身份不一致/);
  assert.deepEqual(fallback.redirects, []);
});

test('LAN guide follows shared launcher language and updates status without changing host identity or links', async () => {
  const html = fs.readFileSync(new URL('../src-tauri/src/lan-guide.html', import.meta.url), 'utf8');
  const guideSource = fs.readFileSync(new URL('../src-tauri/src/lan-guide-i18n.js', import.meta.url), 'utf8');
  assert.match(html, /\/\*__LAN_SETTINGS__\*\//);
  assert.match(html, /href="\/ca\.cer" download="GTA5DATA-LAN-CA\.cer"/);
  assert.match(html, /type="module" src="\/lan-guide-i18n\.js"/);
  assert.ok(!guideSource.includes('innerHTML'));
  let language = 'en', listener, probeOptions, checks = 0;
  const elements = new Map(['fingerprint', 'enter', 'status', 'retry'].map(id => [id, { textContent: '', events: {},
    addEventListener(name, callback) { this.events[name] = callback; } }]));
  const translatedElements = [...html.matchAll(/data-lan-i18n="([^"]+)"/g)]
    .map(match => ({ dataset: { lanI18n: match[1] }, textContent: '' }));
  const document = { documentElement: { lang: '' }, getElementById: id => elements.get(id), querySelectorAll: () => translatedElements };
  const window = { LAN_SETTINGS: { fingerprint: 'AA:BB<script>CC', httpsUrl: 'https://192.168.1.20:8443/' },
    location: { replace() { throw new Error('untrusted guide must not redirect'); } },
    setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    GTA5LanProbe: { createProbe(options) { probeOptions = options; return {
      async check() { checks++; options.status(options.translate('status.untrusted'), false, 'status.untrusted'); return false; },
    }; } } };
  const context = vm.createContext({ document, window, getLanguage: () => language,
    initLanguage: async () => language, onLanguageChange: callback => { listener = callback; return () => {}; } });
  vm.runInContext(guideSource.replace(/^import[^\n]*\n/, '').replace(/\bexport /g, '').replace(/\ninstallLanGuide\(\);\s*$/, '')
    + '\nglobalThis.guideApi = { installLanGuide, guideMessages };', context);
  await context.guideApi.installLanGuide();
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(translatedElements.find(element => element.dataset.lanI18n === 'guide.retry').textContent, 'Check Again');
  assert.match(elements.get('status').textContent, /HTTPS verification has not passed/);
  assert.equal(elements.get('fingerprint').textContent, 'AA:BB<script>CC');
  assert.equal(elements.get('enter').href, window.LAN_SETTINGS.httpsUrl);
  assert.equal(probeOptions.httpsUrl, window.LAN_SETTINGS.httpsUrl);
  for (const element of translatedElements) {
    assert.ok(context.guideApi.guideMessages[element.dataset.lanI18n], 'every guide label must have both translations');
    assert.ok(!/[\u4e00-\u9fff]/.test(element.textContent), 'English guide must translate complete installation instructions');
  }
  const before = checks;
  language = 'zh-CN'; listener();
  assert.equal(checks, before, 'language updates only render; certificate verification is unchanged');
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.equal(translatedElements.find(element => element.dataset.lanI18n === 'guide.retry').textContent, '重新检测');
  assert.match(elements.get('status').textContent, /安装并信任资源主机 CA/);
  assert.equal(elements.get('fingerprint').textContent, 'AA:BB<script>CC');
  assert.equal(elements.get('enter').href, window.LAN_SETTINGS.httpsUrl);
});
