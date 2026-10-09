const MAX_HEALTH_BYTES = 64 * 1024;

export function validHealth(value) {
  return value && value.protocol === 1 && value.public_session === true && value.map === 'gta5'
    && value.state_transport === true && typeof value.server_version === 'string'
    && value.server_version.trim().length > 0 && value.server_version.length <= 80
    && Array.isArray(value.capabilities) && value.capabilities.includes('public_session')
    && value.capabilities.includes('world_v2');
}
function trustedHealthUrl(option) {
  const health = new URL(option.health_url), endpoint = new URL(option.server);
  if (health.protocol !== 'https:' || health.username || health.password || health.hash
    || health.hostname !== endpoint.hostname || (health.port || '443') !== (endpoint.port || '443')
    || option.health_url.length > 2048) throw new Error('invalid_health_url');
  return health.href;
}
async function readBoundedJson(response) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_HEALTH_BYTES)) throw new Error('health_too_large');
  if (!response.body?.getReader) throw new Error('invalid_health');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_HEALTH_BYTES) throw new Error('health_too_large');
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Use the webview's real HTTPS/CORS/TLS stack. Native HTTP checks can differ from
// the browser that will open the game and must not decide route availability.
export async function checkBrowserServer(option, { fetch: request = globalThis.fetch,
  now = () => globalThis.performance.now(), timeoutMs = 3000 } = {}) {
  const result = { address: option.address, available: false, latency_ms: null };
  const controller = new AbortController();
  let timer;
  const started = now();
  try {
    const url = trustedHealthUrl(option);
    await Promise.race([
      (async () => {
        const response = await request(url, { method: 'GET', mode: 'cors', credentials: 'omit',
          cache: 'no-store', redirect: 'error', signal: controller.signal });
        if (!response.ok || response.type === 'opaque' || response.redirected) throw new Error('health_http_failed');
        if (!validHealth(await readBoundedJson(response))) throw new Error('invalid_health');
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('health_timeout')); }, timeoutMs); }),
    ]);
    return { ...result, available: true, latency_ms: Math.max(0, Math.round(now() - started)) };
  } catch (error) {
    return { ...result, error: ['health_timeout', 'health_http_failed', 'invalid_health', 'invalid_health_url', 'health_too_large'].includes(error?.message) ? error.message : 'health_network_failed' };
  } finally { clearTimeout(timer); controller.abort(); }
}
export function checkBrowserServers(options, dependencies) {
  return Promise.all(options.slice(0, 32).map(option => checkBrowserServer(option, dependencies)));
}
