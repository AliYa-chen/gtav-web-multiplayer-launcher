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
