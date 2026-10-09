import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

// Install PHP-WASM outside the repository, then supply its CLI path. Native PHP
// also works through PHP_BIN. Every mutation fixture lives in an isolated tmpdir.
const wasm = process.env.PHP_WASM_CLI;
const phpBinary = process.env.PHP_BIN;
const available = Boolean(wasm || phpBinary);
const sourceFile = new URL('../index.php', import.meta.url);
const command = wasm ? process.execPath : phpBinary;
const baseArgs = wasm ? [wasm] : [];
const phpEnvironment = { ...process.env, PHP: process.env.GTA_PHP_VERSION || '7.4' };
function runPhp(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...baseArgs, ...args], { cwd, env: phpEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (bytes) => { stdout += bytes; });
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`PHP exited ${code}: ${stderr}${stdout}`)));
  });
}
async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function httpsUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:'); assert.equal(url.username, ''); assert.equal(url.password, '');
}

test('PHP syntax, bilingual output, HTTP/CORS contract and unsafe configuration rejection', { skip: !available, timeout: 30000 }, async (t) => {
  const source = await readFile(sourceFile, 'utf8');
  const originalDigest = createHash('sha256').update(source).digest('hex');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'gta-remote-config-php-')));
  let server;
  try {
    await writeFile(path.join(directory, 'index.php'), source);
    const lint = await runPhp(['-l', path.join(directory, 'index.php')], directory);
    assert.match(lint.stdout, /No syntax errors/);
    const variants = {
      'unsafe-site': source.replace(/\$site = '[^']+';/, "$site = 'javascript:alert(1)';"),
      'unsafe-download': source.replace(/('url' => ')https:(\/\/oss\.2t\.hk\/gtav\/[^']+')/, '$1http:$2'),
      'unsafe-download-hash': source.replace(/('sha256' => ')[a-f0-9]{64}(')/i, `$1${'0'.repeat(64)}$2`),
      'unsafe-translation-url': source.replace(/'oltitle' => \$site/g, "'oltitle' => 'https://user:password@example.com/'"),
      'unsafe-translation-script': source.replace(/'oltitle' => \$site/g, "'oltitle' => 'javascript:alert(1)'"),
      'plain-translation-title': source.replace(/'oltitle' => \$site/g, "'oltitle' => 'Public Session'"),
      'unsafe-translation-text': source.replace(/('release_notes' => )'Launcher[^']*'/, '$1"bad\\x00text"'),
      'duplicate-server': source.replace("'id' => 'experimental'", "'id' => 'main'"),
      'empty-downloads': source.replace(/\$downloadCandidates = \[[\s\S]*?\n\];\n\/\/ ── 配置内容结束/, '$downloadCandidates = [];\n// ── 配置内容结束'),
      'origin-whitelist': source.replace("    '*', //", "    'https://trusted.example', //"),
    };
    for (const [name, value] of Object.entries(variants)) {
      assert.notEqual(value, source, `${name} fixture must mutate the isolated copy`);
      await writeFile(path.join(directory, `${name}.php`), value);
    }
    const port = await freePort();
    server = spawn(command, [...baseArgs, '-d', 'opcache.enable=0', '-d', 'opcache.enable_cli=0', '-S', `127.0.0.1:${port}`, '-t', directory], {
      cwd: directory, env: phpEnvironment, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let serverErrors = '';
    server.stderr.on('data', (bytes) => { serverErrors += bytes; });
    const origin = `http://127.0.0.1:${port}`;
    async function request(route = '/', options = {}) {
      const response = await fetch(origin + route, { ...options, signal: AbortSignal.timeout(5000) });
      const body = await response.text();
      return { response, body, value: body ? JSON.parse(body) : null };
    }
    let initial;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { initial = await request(); break; } catch (error) {
        if (server.exitCode !== null || attempt === 49) throw new Error(`PHP server unavailable: ${serverErrors}`, { cause: error });
        await pause(50);
      }
    }
    const config = initial.value;
    function standardHeaders(response) {
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('allow'), 'GET, HEAD, POST, OPTIONS');
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(response.headers.get('access-control-allow-methods'), 'GET, HEAD, POST, OPTIONS');
      assert.equal(response.headers.get('access-control-allow-headers'), 'Accept, Authorization, Content-Type, X-Requested-With');
      assert.equal(response.headers.get('access-control-allow-credentials'), null);
      assert.equal(response.headers.get('vary'), 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    }
    await t.test('GET emits complete Chinese/English configuration and HTTPS downloads as an object', () => {
      assert.equal(initial.response.status, 200); standardHeaders(initial.response);
      assert.equal(Number(initial.response.headers.get('content-length')), Buffer.byteLength(initial.body));
      assert.ok(Buffer.byteLength(initial.body) <= 256 * 1024);
      assert.equal(config.schema_version, 1); httpsUrl(config.oltitle); httpsUrl(config.website);
      if (process.env.GTA_EXPECT_VERSION) assert.equal(config.update.latest_version, process.env.GTA_EXPECT_VERSION);
      assert.deepEqual(config.server, config.servers);
      assert.ok(config.servers.length >= 1 && config.servers.length <= 32);
      assert.deepEqual(Object.keys(config.i18n).sort(), ['en', 'zh-CN']);
      assert.equal(config.i18n['zh-CN'].release_notes, config.update.release_notes);
      assert.deepEqual(config.i18n['zh-CN'].announcements, config.announcements);
      for (const locale of ['zh-CN', 'en']) {
        const translation = config.i18n[locale]; httpsUrl(translation.oltitle);
        assert.ok(translation.release_notes.length > 20);
        assert.equal(translation.announcements.length, config.announcements.length);
        for (const item of translation.announcements) {
          assert.ok(item.title && item.body && item.date); httpsUrl(item.url);
          if (locale === 'en') assert.doesNotMatch(item.title + item.body, /[\p{Script=Han}]/u);
        }
        for (const item of config.servers) {
          assert.ok(item.i18n[locale].name && item.i18n[locale].role); httpsUrl(item.health_url);
          if (locale === 'en') assert.doesNotMatch(item.i18n[locale].name + item.i18n[locale].role, /[\p{Script=Han}]/u);
        }
      }
      assert.ok(config.update.downloads && typeof config.update.downloads === 'object' && !Array.isArray(config.update.downloads));
      for (const download of Object.values(config.update.downloads)) { httpsUrl(download.url); assert.match(download.sha256, /^[a-f0-9]{64}$/); assert.notEqual(download.sha256, '0'.repeat(64)); }
    });
    await t.test('HEAD preserves GET headers and content length without a response body', async () => {
      const result = await request('/', { method: 'HEAD', headers: { Origin: 'https://any.example' } });
      assert.equal(result.response.status, 200); standardHeaders(result.response); assert.equal(result.body, '');
      assert.equal(result.response.headers.get('content-length'), initial.response.headers.get('content-length'));
    });
    await t.test('POST body and query parameters cannot override the read-only configuration', async () => {
      const result = await request('/?latest_version=99.99.99&language=unsafe', { method: 'POST', headers: { Origin: 'https://any.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ update: { latest_version: '99.99.99' }, server: 'wss://attacker.example', i18n: {} }) });
      assert.equal(result.response.status, 200); standardHeaders(result.response); assert.deepEqual(result.value, config);
    });
    for (const requestedMethod of ['GET', 'HEAD', 'POST']) await t.test(`OPTIONS accepts the supported ${requestedMethod} preflight and returns no body`, async () => {
      const result = await request('/', { method: 'OPTIONS', headers: { Origin: 'https://any.example', 'Access-Control-Request-Method': requestedMethod, 'Access-Control-Request-Headers': 'Accept, Authorization, Content-Type, X-Requested-With' } });
      assert.equal(result.response.status, 204); standardHeaders(result.response); assert.equal(result.body, ''); assert.equal(result.response.headers.get('content-length'), '0');
    });
    for (const method of ['PUT', 'DELETE', 'PATCH']) await t.test(`${method} cannot modify configuration`, async () => {
      const result = await request('/', { method }); assert.equal(result.response.status, 405); assert.equal(result.value.code, 'method_not_allowed');
    });
    await t.test('OPTIONS rejects unsafe methods and unsupported headers', async () => {
      const method = await request('/', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } });
      assert.equal(method.response.status, 405); assert.equal(method.value.code, 'preflight_method_not_allowed');
      const headers = await request('/', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-Unsafe-Header' } });
      assert.equal(headers.response.status, 400); assert.equal(headers.value.code, 'preflight_header_not_allowed');
    });
    for (const name of ['unsafe-site', 'unsafe-download', 'unsafe-download-hash', 'unsafe-translation-url', 'unsafe-translation-script', 'unsafe-translation-text', 'duplicate-server']) await t.test(`${name} is rejected without exposing validation details`, async () => {
      const result = await request(`/${name}.php`); assert.equal(result.response.status, 500); assert.equal(result.value.code, 'config_invalid');
      assert.doesNotMatch(result.body, /password|javascript:|alert\(1\)|Invalid configuration|bad\\x00text/);
    });
    await t.test('translated titles accept plain display text without changing the website or endpoints', async () => {
      const result=await request('/plain-translation-title.php');assert.equal(result.response.status,200);
      assert.equal(result.value.i18n.en.oltitle,'Public Session');
      assert.equal(result.value.website,config.website);assert.deepEqual(result.value.servers,config.servers);
    });
    await t.test('an empty published download catalog stays a JSON object', async () => {
      const result = await request('/empty-downloads.php'); assert.equal(result.response.status, 200); assert.deepEqual(result.value.update.downloads, {}); assert.ok(!Array.isArray(result.value.update.downloads));
    });
    await t.test('an optional origin whitelist permits native clients and rejects unlisted browser origins', async () => {
      const native = await request('/origin-whitelist.php'); assert.equal(native.response.status, 200); assert.equal(native.response.headers.get('access-control-allow-origin'), null);
      const allowed = await request('/origin-whitelist.php', { headers: { Origin: 'https://trusted.example' } }); assert.equal(allowed.response.status, 200); assert.equal(allowed.response.headers.get('access-control-allow-origin'), 'https://trusted.example');
      const rejected = await request('/origin-whitelist.php', { headers: { Origin: 'https://untrusted.example' } }); assert.equal(rejected.response.status, 403); assert.equal(rejected.value.code, 'origin_not_allowed');
    });
    if (process.env.GTA_RELEASES_DIR) await t.test('download SHA-256 values match the built client artifacts', async () => {
      for (const download of Object.values(config.update.downloads)) {
        const filename = path.basename(new URL(download.url).pathname);
        const bytes = await readFile(path.join(process.env.GTA_RELEASES_DIR, filename));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), download.sha256, filename);
      }
    });
  } finally {
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
    await rm(directory, { recursive: true, force: true });
    assert.equal(createHash('sha256').update(await readFile(sourceFile)).digest('hex'), originalDigest, 'Original PHP source must remain unchanged');
  }
});
