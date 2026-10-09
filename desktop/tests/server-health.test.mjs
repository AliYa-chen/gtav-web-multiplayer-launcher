import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBrowserServer, checkBrowserServers, validHealth } from '../src/server-health.js';
import { launchServerOptions } from '../src/view-state.js';

const health = { protocol: 1, public_session: true, map: 'gta5', state_transport: true,
  server_version: '0.4.2', capabilities: ['public_session', 'world_v2'] };
const option = { address: 'example.com:47485', server: 'wss://example.com:47485/47485/ws', health_url: 'https://example.com:47485/47485/health' };
const response = (value = health) => new Response(JSON.stringify(value), { status: 200 });

test('browser health uses the exact catalog HTTPS URL, CORS and no credentials, measuring the complete response', async () => {
  let request, now = 20;
  const result = await checkBrowserServer(option, { now: () => now, fetch: async (url, args) => {
    request = { url, ...args }; now = 83; return response();
  } });
  assert.deepEqual(result, { address: option.address, available: true, latency_ms: 63 });
  assert.equal(request.url, option.health_url); assert.equal(request.method, 'GET');
  assert.equal(request.mode, 'cors'); assert.equal(request.credentials, 'omit');
  assert.equal(request.cache, 'no-store'); assert.equal(request.redirect, 'error');
  assert.equal(request.signal.aborted, true, 'completion cleans up the fetch signal');
});

test('health protocol requires a public GTA V state transport and the declared capabilities', async () => {
  assert.equal(validHealth(health), true);
  for (const changed of [{ protocol: 2 }, { protocol: '1' }, { public_session: false }, { map: 'gta6' },
    { state_transport: false }, { server_version: '' }, { server_version: 'x'.repeat(81) },
    { capabilities: ['public_session'] }, { capabilities: ['world_v2'] }, { capabilities: null }]) {
    const result = await checkBrowserServer(option, { fetch: async () => response({ ...health, ...changed }) });
    assert.equal(result.available, false); assert.equal(result.error, 'invalid_health');
  }
});

test('missing, insecure, credentialed, fragmented or different-host health URLs never cause a request', async () => {
  let calls = 0;
  for (const health_url of ['', 'http://example.com:47485/health', 'https://name:password@example.com:47485/health',
    'https://attacker.example:47485/health', 'https://example.com:47486/health', 'https://example.com:47485/health#fragment']) {
    const result = await checkBrowserServer({ ...option, health_url }, { fetch: async () => { calls++; return response(); } });
    assert.equal(result.available, false);
  }
  assert.equal(calls, 0);
  const known = launchServerOptions({ source: 'remote', config: { servers: [{ address: option.address, health_url: option.health_url }] } });
  assert.equal(known[0].health_url, option.health_url);
  const unsafe = launchServerOptions({ source: 'remote', config: { servers: [{ address: option.address, health_url: 'https://attacker.example/health' }] } });
  assert.equal(unsafe[0].health_url, '');
});

test('HTTP failure, CORS/network rejection, invalid JSON and redirects stay unavailable', async () => {
  const fetches = [
    async () => new Response('no', { status: 503 }),
    async () => { throw new TypeError('CORS failure'); },
    async () => new Response('invalid-json', { status: 200 }),
    async () => ({ ok: true, redirected: true, body: null }),
    async () => ({ ok: true, type: 'opaque', body: null }),
  ];
  for (const fetch of fetches) {
    const result = await checkBrowserServer(option, { fetch });
    assert.equal(result.available, false); assert.equal(result.latency_ms, null);
  }
});

test('health checks time out and abort both an unresponsive fetch and a stalled body read', async () => {
  let signal;
  const timeout = await checkBrowserServer(option, { timeoutMs: 15, fetch: async (_url, args) => { signal = args.signal; return new Promise(() => {}); } });
  assert.equal(timeout.error, 'health_timeout'); assert.equal(signal.aborted, true);
  const stalled = await checkBrowserServer(option, { timeoutMs: 15, fetch: async (_url, args) => {
    signal = args.signal;
    return new Response(new ReadableStream({ start() {} }));
  } });
  assert.equal(stalled.error, 'health_timeout'); assert.equal(signal.aborted, true);
});

test('declared and chunked responses larger than 64 KiB are rejected with bounded reads', async () => {
  const declared = await checkBrowserServer(option, { fetch: async () => new Response('{}', { headers: { 'content-length': '65537' } }) });
  assert.equal(declared.error, 'health_too_large');
  let cancelled = false, pulls = 0;
  const chunked = await checkBrowserServer(option, { fetch: async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(16384)); },
    cancel() { cancelled = true; },
  })) });
  assert.equal(chunked.error, 'health_too_large'); assert.equal(cancelled, true);
  assert.ok(pulls <= 7, 'the checker cancels instead of consuming an unbounded body');
});

test('parallel checks remain bounded to 32 catalog routes', async () => {
  let calls = 0;
  const values = await checkBrowserServers(Array.from({ length: 100 }, () => option), { fetch: async () => { calls++; return response(); } });
  assert.equal(values.length, 32); assert.equal(calls, 32); assert.ok(values.every(item => item.available));
});
