import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as presentation from '../src/view-state.js';

const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function launcher(desktop = true, options = {}) {
  const calls = [], values = new Map(), events = new Map(), intervals = [], held = new Map(), failures = new Set(), copied = [], requests = [], timers = new Map();
  let timerId = 0, fetchHandler = options.fetch || (async () => { throw new TypeError('TLS not trusted'); });
  let urls = options.urls || [], invitationUrls = options.invitationUrls || [];
  let lan = { settings: { port: 8443, http_port: 8442 }, addresses: ['192.168.31.225'], running_url: null, guide_url: null, host_address: null, ca_fingerprint: null, ...options.lan };
  let remoteFailure = false;
  let resources = options.resources === undefined ? { manifest_file_count: 5814 } : options.resources;
  let remote = { config: { oltitle: 'https://gtav.2t.hk', latest_version: '0.2.5', downloads: { windows_x64: { url: 'https://oss.2t.hk/launcher.exe', sha256: 'a'.repeat(64) } }, announcements: [{ title: '<img>', body: '<script>unsafe</script>' }] }, source: 'remote' };
  const status = () => ({ selected_directory: options.selected === undefined ? '/游戏资源' : options.selected, resources, running_urls: urls, invitation_urls: invitationUrls, lan, version: '0.2.5', platform: 'windows_x64', remote_configuration: remote });
  let renderCount = 0, rendered = '';
  const app = { get innerHTML() { return rendered; }, set innerHTML(value) { rendered = value; renderCount++; }, addEventListener(name, callback) { events.set(`app:${name}`, callback); } };
  const nodes = new Map();
  const button = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, focus() { document.activeElement = this; } });
    return nodes.get(id);
  };
  const updateButtons = () => [...app.innerHTML.matchAll(/<button id="(mandatory-update-[^"]+)"[^>]*>/g)]
    .filter((match) => !/\bdisabled\b/.test(match[0])).map((match) => button(match[1]));
  const updateDialog = { focus() { document.activeElement = this; }, querySelectorAll: updateButtons, contains: (node) => node === updateDialog || updateButtons().includes(node) };
  const lanControls = () => [...app.innerHTML.slice(app.innerHTML.indexOf('class="lan-overlay"')).matchAll(/<(?:button|input|select) id="(lan-[^"]+)"[^>]*>/g)]
    .filter((match) => !/\bdisabled\b/.test(match[0])).map((match) => button(match[1]));
  const lanDialog = { focus() { document.activeElement = this; }, querySelectorAll: lanControls, contains: (node) => node === lanDialog || lanControls().includes(node) };
  const document = { activeElement: null, documentElement: { style: { setProperty() {} } }, querySelector(selector) {
    if (selector === '#app') return app;
    if (selector === '.lan-overlay') return app.innerHTML.includes('class="lan-overlay"') ? lanDialog : null;
    const field = /^#(lan-[^:]+)$/.exec(selector)?.[1];
    if (field) return app.innerHTML.includes(`id="${field}"`) ? button(field) : null;
    if (!app.innerHTML.includes('class="mandatory-update"')) return null;
    if (selector === '.mandatory-update') return updateDialog;
    if (selector === '.mandatory-update button:not(:disabled)') return updateButtons()[0] || null;
    const id = /^#(mandatory-update-[^:]+):not\(:disabled\)$/.exec(selector)?.[1];
    return id ? updateButtons().find((node) => node.id === id) || null : null;
  }, addEventListener(name, callback) { events.set(`document:${name}`, callback); } };
  const context = vm.createContext({
    ...presentation, html: presentation.escapeHtml, metadata: { version: '0.2.5' }, backgrounds: [{ id: 'sunglasses', label: '海风', image: '/sunglasses.webp' }, { id: 'beach', label: '海滩', image: '/beach.webp' }],
    document, localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) }, isTauri: () => desktop,
    navigator: options.clipboard === false ? {} : { clipboard: { writeText: async (text) => { copied.push(text); } } },
    listen: async (name, callback) => { events.set(`tauri:${name}`, callback); return () => {}; }, invoke: async (command, args) => {
      calls.push({ command, args });
      if (failures.has(command)) throw new Error(`${command} failed`);
      if (held.has(command)) return await held.get(command).promise;
      if (command === 'install_lan_ca') return 'BinGo Root CA 已安装并信任，请重启浏览器后访问 HTTPS 游戏。';
      if (command === 'save_lan_ca_certificate') return options.caSaveResult === undefined ? '/证书/BinGo Root CA.crt' : options.caSaveResult;
      if (command === 'choose_game_directory') return '/新资源';
      if (command === 'prepare_game') resources = { manifest_file_count: 5814 };
      if (command === 'start_game') {
        const address = lan.settings.address || '192.168.31.225', offset = urls.length * 2;
        urls = [...urls, `https://${address}:${lan.settings.port + offset}/`];
        invitationUrls = [...invitationUrls, `http://${address}:${lan.settings.http_port + offset}/`];
        lan = { ...lan, host_address: address, running_url: urls[0], guide_url: invitationUrls[0], ca_fingerprint: 'AB:'.repeat(31) + 'CD' };
      }
      if (command === 'stop_game') { urls = []; invitationUrls = []; lan = { ...lan, running_url: null, guide_url: null, host_address: null }; }
      if (command === 'save_lan_settings') lan = { ...lan, settings: { port: args.port, http_port: args.httpPort, address: args.address } };
      if (command === 'remote_configuration') { if (remoteFailure) throw new Error('failed request'); return remote; }
      return status();
    },
    AbortController, URL, fetch: (...args) => { requests.push(args); return fetchHandler(...args); },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; },
  });
  vm.runInContext(source, context);
  await tick();
  return { calls, app, values, events, intervals, document, status, copied, requests, timers,
    renderCount: () => renderCount,
    setFetch(handler) { fetchHandler = handler; },
    async runTimer(delay) { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, `missing ${delay}ms timer`); timers.delete(entry[0]); entry[1].callback(); await tick(); },
    setRemote(value) { remote = value; remoteFailure = false; }, failRemote() { remoteFailure = true; },
    failCommand(command, failed = true) { failed ? failures.add(command) : failures.delete(command); },
    hold(command) { let resolve; const promise = new Promise((accept) => { resolve = accept; }); held.set(command, { promise }); return (value = status()) => { held.delete(command); resolve(value); }; },
    input(field, value) { events.get('app:input')({ target: { dataset: { lanField: field }, value } }); },
    async click(id, dataset = {}) { const button = { id, dataset, disabled: false }; await events.get('app:click')({ target: { closest: () => button } }); } };
}

function newerSnapshot(overrides = {}) {
  return { source: 'remote', stale: false, config: { latest_version: '0.2.6', release_notes: '必须更新\n修复连接。',
    downloads: { windows_x64: { url: 'https://oss.2t.hk/launcher-new.exe', sha256: 'b'.repeat(64) } }, ...overrides } };
}
function publish(ui, snapshot) {
  ui.setRemote(snapshot);
  ui.events.get('tauri:launcher-remote-config')({ payload: snapshot });
}

test('新版本强制全屏更新，阻止所有后台操作且 Esc 和点击遮罩无法关闭', async () => {
  const ui = await launcher();
  await ui.click('settings-toggle');
  assert.match(ui.app.innerHTML, /id="background-picker"/);
  publish(ui, newerSnapshot());
  assert.match(ui.app.innerHTML, /class="shell" inert aria-hidden="true"/);
  assert.match(ui.app.innerHTML, /class="mandatory-update" role="alertdialog" aria-modal="true"/);
  assert.match(ui.app.innerHTML, /最新版本 <strong>0\.2\.6<\/strong>/);
  assert.doesNotMatch(ui.app.innerHTML, /id="background-picker"|class="reader-overlay"|id="mandatory-update-(?:close|dismiss)"/);
  const before = ui.calls.length;
  for (const [id, dataset] of [['choose'], ['verify'], ['launch'], ['additional'], ['stop'], ['settings-toggle'], ['get-game-resources'], ['website'], ['update-download'], ['check-updates'], ['', { open: '0' }], ['', { read: 'release' }], ['', { background: 'beach' }], ['mandatory-update-dismiss']]) {
    await ui.click(id, dataset);
  }
  let prevented = false, stopped = false;
  ui.events.get('document:keydown')({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  ui.events.get('document:click')({ target: { closest: () => null } });
  assert.equal(prevented, true); assert.equal(stopped, true);
  assert.deepEqual(ui.calls.slice(before), []);
  assert.equal(ui.values.get(presentation.backgroundPreferenceKey), undefined);
  assert.match(ui.app.innerHTML, /class="mandatory-update"/);
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.mandatory-update\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
});

test('强制更新关闭已打开的详情，并把键盘焦点限制在更新操作内', async () => {
  const ui = await launcher();
  await ui.click('', { read: 'announcement' });
  assert.match(ui.app.innerHTML, /class="reader-overlay"/);
  publish(ui, newerSnapshot());
  assert.doesNotMatch(ui.app.innerHTML, /class="reader-overlay"/);
  assert.equal(ui.document.activeElement.id, 'mandatory-update-download');
  let prevented = 0;
  ui.events.get('document:keydown')({ key: 'Tab', shiftKey: true, preventDefault() { prevented++; } });
  assert.equal(ui.document.activeElement.id, 'mandatory-update-check');
  ui.events.get('document:keydown')({ key: 'Tab', shiftKey: false, preventDefault() { prevented++; } });
  assert.equal(ui.document.activeElement.id, 'mandatory-update-download');
  ui.document.activeElement = { id: 'launch' };
  ui.events.get('document:keydown')({ key: 'Tab', preventDefault() { prevented++; } });
  assert.equal(ui.document.activeElement.id, 'mandatory-update-download');
  assert.equal(prevented, 3);
});

test('更新失败清空远程内容但保持强制锁，只有新鲜的相同或较旧版本能恢复', async () => {
  for (const latest of ['0.2.5', '0.2.4']) {
    const ui = await launcher();
    publish(ui, newerSnapshot());
    ui.failRemote(); await ui.click('mandatory-update-check');
    assert.match(ui.app.innerHTML, /class="mandatory-update"/);
    assert.match(ui.app.innerHTML, /最新版本 <strong>-<\/strong>/);
    assert.doesNotMatch(ui.app.innerHTML, /修复连接|id="mandatory-update-download"/);
    assert.match(ui.app.innerHTML, /远程配置暂时无法加载/);
    const before = ui.calls.length;
    await ui.click('launch'); assert.equal(ui.calls.length, before);
    ui.setRemote({ source: 'remote', stale: false, config: { latest_version: latest } });
    await ui.click('mandatory-update-check');
    assert.doesNotMatch(ui.app.innerHTML, /class="mandatory-update"|class="shell" inert/);
    await ui.click('launch');
    assert.ok(ui.calls.slice(before).some((call) => call.command === 'start_game'));
  }
});

test('缺少当前平台下载地址仍要求更新，下载错误允许重新下载和重新检查', async () => {
  const ui = await launcher();
  publish(ui, newerSnapshot({ downloads: { macos_arm64: { url: 'https://oss.2t.hk/mac.zip', sha256: 'c'.repeat(64) } } }));
  assert.match(ui.app.innerHTML, /class="mandatory-update"/);
  assert.match(ui.app.innerHTML, /当前系统的下载地址暂不可用/);
  assert.doesNotMatch(ui.app.innerHTML, /id="mandatory-update-download"/);
  publish(ui, newerSnapshot());
  ui.failCommand('open_update_download'); await ui.click('mandatory-update-download');
  assert.match(ui.app.innerHTML, /class="mandatory-update"/);
  assert.match(ui.app.innerHTML, /暂时没有适用于当前系统的下载/);
  ui.failCommand('open_update_download', false); await ui.click('mandatory-update-download');
  assert.equal(ui.calls.filter((call) => call.command === 'open_update_download').length, 2);
  assert.match(ui.app.innerHTML, /class="mandatory-update"/);
  await ui.click('mandatory-update-check');
  assert.equal(ui.calls.at(-1).command, 'remote_configuration');
});

test('资源准备过程中收到强制更新后，不继续启动或打开游戏', async () => {
  const ui = await launcher(true, { resources: null });
  const finish = ui.hold('prepare_game');
  const preparing = ui.click('launch');
  await tick();
  assert.equal(ui.calls.at(-1).command, 'prepare_game');
  publish(ui, newerSnapshot());
  const result = ui.status(); delete result.remote_configuration;
  finish(result); await preparing;
  assert.match(ui.app.innerHTML, /class="mandatory-update"/);
  assert.equal(ui.calls.some((call) => ['start_game', 'open_game'].includes(call.command)), false);
});

test('准备命令报告后端更新锁时，不使用此前已安装快照解除锁', async () => {
  const ui = await launcher(true, { resources: null });
  const finish = ui.hold('prepare_game');
  const preparing = ui.click('launch');
  await tick();
  const result = { ...ui.status(), update_required: true };
  publish(ui, newerSnapshot());
  finish(result); await preparing;
  assert.match(ui.app.innerHTML, /class="mandatory-update"/);
  assert.equal(ui.calls.some((call) => ['start_game', 'open_game'].includes(call.command)), false);
});

test('实际启动界面仅通过后端读取远程配置，并从目录选择完成校验、启动、多开和停止', async () => {
  const ui = await launcher();
  assert.equal(ui.calls.find((call) => call.command === 'remote_configuration').args.forceRefresh, false);
  assert.match(ui.app.innerHTML, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  await ui.click('choose');
  await ui.click('launch');
  assert.deepEqual(ui.calls.filter((call) => ['prepare_game', 'start_game', 'open_game'].includes(call.command)).map((call) => [call.command, JSON.stringify(call.args)]), [
    ['prepare_game', '{"selected":"/新资源"}'], ['start_game', '{"additional":false}'], ['open_game', '{"index":0,"trusted":false}'],
  ]);
  const beforeAdditional = ui.calls.length; await ui.click('additional');
  assert.deepEqual(ui.calls.slice(beforeAdditional).map(call => call.command), ['start_game']);
  await ui.click('', { copyClient: '1' });
  assert.equal(ui.copied.at(-1), 'http://192.168.31.225:8444/');
  assert.match(ui.app.innerHTML, /2 个客户端已启动/);
  await ui.click('stop');
  assert.match(ui.app.innerHTML, /游戏与局域网共享已停止/);
});

test('实际设置点击持久化背景，检查更新与下载始终交给受限的后端命令', async () => {
  const ui = await launcher();
  await ui.click('settings-toggle');
  assert.match(ui.app.innerHTML, /id="background-picker"/);
  await ui.click('', { background: 'beach' });
  assert.equal(ui.values.get(presentation.backgroundPreferenceKey), 'beach');
  await ui.click('check-updates');
  assert.equal(ui.calls.at(-1).command, 'remote_configuration');
  assert.equal(ui.calls.at(-1).args.forceRefresh, true);
  ui.setRemote(newerSnapshot()); await ui.click('check-updates');
  await ui.click('mandatory-update-download');
  assert.equal(ui.calls.at(-1).command, 'open_update_download');
  assert.equal(ui.calls.at(-1).args, undefined);
  ui.setRemote({ source: 'remote', config: { latest_version: '0.2.5', website: 'https://gtav.2t.hk' } });
  await ui.click('mandatory-update-check');
  await ui.click('website');
  assert.equal(ui.calls.at(-1).command, 'open_project_website');
});

test('后台远程配置刷新事件立即更新公告，文字不会变为HTML', async () => {
  const ui = await launcher();
  ui.events.get('tauri:launcher-remote-config')({ payload: { config: { announcements: [{ title: '新公告', body: '<a href="bad">公告</a>' }] }, source: 'remote' } });
  assert.match(ui.app.innerHTML, /新公告/);
  assert.match(ui.app.innerHTML, /&lt;a href=&quot;bad&quot;&gt;公告&lt;\/a&gt;/);
});

test('网页预览不调用桌面或网络命令，背景设置保持可用', async () => {
  const ui = await launcher(false);
  assert.deepEqual(ui.calls, []);
  assert.match(ui.app.innerHTML, /class="update-state ">-</);
  await ui.click('', { background: 'beach' });
  await ui.click('check-updates');
  assert.equal(ui.values.get(presentation.backgroundPreferenceKey), 'beach');
  assert.deepEqual(ui.calls, []);
  assert.equal(ui.intervals.length, 0);
});
test('运行中的启动器每五分钟后台刷新公告配置，不重启游戏', async () => {
  const ui = await launcher();
  assert.equal(ui.intervals[0].delay, 300000);
  const before = ui.calls.length; await ui.intervals[0].callback();
  assert.deepEqual(ui.calls.slice(before).map(call => call.command), ['remote_configuration']);
  assert.equal(ui.calls.at(-1).args.forceRefresh, true);
});
test('真实接口数据展示两条线路和新公告，失败后清空旧数据，再次请求能恢复', async () => {
  const ui = await launcher();
  const config = JSON.parse(await readFile(new URL('../../tools/tests/fixtures/remote-launcher-server-array.json', import.meta.url), 'utf8'));
  // The backend normalizes release metadata before passing the snapshot to the view.
  const snapshot = { source: 'remote', stale: false, config: { ...config, ...config.update } };
  ui.setRemote(snapshot); await ui.click('check-updates');
  assert.match(ui.app.innerHTML, /欢迎来到 GTA V 公共战局/);
  assert.match(ui.app.innerHTML, /183\.66\.27\.21:47485/);
  assert.match(ui.app.innerHTML, /183\.66\.27\.21:47486/);
  assert.match(ui.app.innerHTML, /主线路|实验线路/);
  await ui.click('announcement-next');
  assert.match(ui.app.innerHTML, /实验功能说明/);
  await ui.click('', { read: 'announcement' });
  ui.failRemote(); await ui.click('check-updates');
  assert.doesNotMatch(ui.app.innerHTML, /欢迎来到 GTA V 公共战局|实验功能说明|183\.66\.27\.21|class="reader-overlay"|离线缓存|已缓存/);
  assert.match(ui.app.innerHTML, /class="empty-note">-</);
  assert.match(ui.app.innerHTML, /class="update-state ">-</);
  assert.doesNotMatch(ui.app.innerHTML, /id="website"|id="update-download"/);
  ui.setRemote(snapshot); await ui.click('check-updates');
  assert.match(ui.app.innerHTML, /欢迎来到 GTA V 公共战局/);
  assert.match(ui.app.innerHTML, /183\.66\.27\.21:47486/);
});
test('后台请求失败的通知清空之前的成功快照，即使失败载荷残留旧版本也不显示', async () => {
  const ui = await launcher();
  const event = ui.events.get('tauri:launcher-remote-config');
  event({ payload: { config: { latest_version: '99.0.0', announcements: [{ title: '不可显示的旧公告' }] }, source: 'unavailable', stale: true, error: '远程配置 JSON 格式或字段类型无效。' } });
  assert.doesNotMatch(ui.app.innerHTML, /不可显示的旧公告|99\.0\.0|&lt;script&gt;unsafe/);
  assert.match(ui.app.innerHTML, /class="update-state ">-</);
  assert.match(ui.app.innerHTML, /远程配置 JSON 格式或字段类型无效/);
});

function readerPage(ui) {
  const text = /<div class="reader-text">([\s\S]*?)<\/div>/.exec(ui.app.innerHTML);
  const position = /第 (\d+) \/ (\d+) 页/.exec(ui.app.innerHTML);
  assert.ok(text && position, '详情面板应包含正文和页码');
  return { text: text[1], index: Number(position[1]), count: Number(position[2]) };
}
async function readEveryPage(ui) {
  const first = readerPage(ui), pages = [first.text];
  assert.equal(first.index, 1);
  for (let index = 2; index <= first.count; index++) {
    await ui.click('reader-next');
    const page = readerPage(ui);
    assert.equal(page.index, index);
    assert.equal(page.count, first.count);
    pages.push(page.text);
  }
  assert.match(ui.app.innerHTML, /id="reader-next" disabled/);
  return pages.join('');
}

test('多条公告逐条切换，详情分页完整保留正文与日期且不请求后端', async () => {
  const ui = await launcher();
  const body = '<script>alert("公告")</script>\n' + ('长公告 e\u0301 👨‍👩‍👧‍👦 和中文。\n\n'.repeat(35));
  ui.events.get('tauri:launcher-remote-config')({ payload: { source: 'remote', config: { announcements: [
    { title: '第一条公告', body: '仅在第一条显示' },
    { title: '第二条公告', date: '2026-10-08', body },
    { title: '第三条公告', body: '仅在第三条显示' },
  ] } } });
  const before = ui.calls.length;
  assert.match(ui.app.innerHTML, /第一条公告/);
  assert.doesNotMatch(ui.app.innerHTML, /第二条公告|第三条公告/);
  assert.match(ui.app.innerHTML, /id="announcement-prev"[^>]* disabled/);
  await ui.click('announcement-next');
  assert.match(ui.app.innerHTML, /第二条公告/);
  assert.doesNotMatch(ui.app.innerHTML, /第一条公告|第三条公告/);
  await ui.click('announcement-prev');
  assert.match(ui.app.innerHTML, /仅在第一条显示/);
  await ui.click('announcement-next');
  await ui.click('', { read: 'announcement' });
  assert.match(ui.app.innerHTML, /id="reader-title">第二条公告/);
  assert.ok(readerPage(ui).count > 2);
  assert.equal(await readEveryPage(ui), presentation.escapeHtml(`2026-10-08\n\n${body}`));
  assert.doesNotMatch(ui.app.innerHTML, /<script>/);
  await ui.click('reader-prev');
  assert.equal(readerPage(ui).index, readerPage(ui).count - 1);
  await ui.click('reader-close');
  assert.doesNotMatch(ui.app.innerHTML, /class="reader-overlay"/);
  await ui.click('announcement-next');
  assert.match(ui.app.innerHTML, /仅在第三条显示/);
  assert.match(ui.app.innerHTML, /id="announcement-next"[^>]* disabled/);
  assert.deepEqual(ui.calls.slice(before), []);
});

test('长版本说明使用本地详情分页，关闭和重新打开从第一页显示', async () => {
  const ui = await launcher();
  const notes = '更新内容\r\n\r\n' + ('Z'.repeat(600)) + '\n' + ('<img src=x onerror="bad"> 🇨🇳\n'.repeat(30));
  ui.events.get('tauri:launcher-remote-config')({ payload: { source: 'remote', config: { release_notes: notes } } });
  const before = ui.calls.length;
  await ui.click('', { read: 'release' });
  assert.match(ui.app.innerHTML, /id="reader-title">版本说明/);
  assert.equal(await readEveryPage(ui), presentation.escapeHtml(notes));
  assert.doesNotMatch(ui.app.innerHTML, /<img src=x/);
  await ui.click('reader-dismiss');
  assert.doesNotMatch(ui.app.innerHTML, /class="reader-overlay"/);
  await ui.click('', { read: 'release' });
  assert.equal(readerPage(ui).index, 1);
  ui.events.get('document:keydown')({ key: 'Escape' });
  assert.doesNotMatch(ui.app.innerHTML, /class="reader-overlay"/);
  assert.deepEqual(ui.calls.slice(before), []);
});

test('背景设置保留所有可选场景，关闭按钮与背景遮罩均可关闭', async () => {
  const ui = await launcher();
  const before = ui.calls.length;
  await ui.click('settings-toggle');
  assert.deepEqual([...ui.app.innerHTML.matchAll(/data-background="([^"]+)"/g)].map((match) => match[1]), ['sunglasses', 'beach']);
  assert.match(ui.app.innerHTML, /aria-label="选择背景：海风"/);
  assert.match(ui.app.innerHTML, /aria-label="选择背景：海滩"/);
  await ui.click('picker-close');
  assert.doesNotMatch(ui.app.innerHTML, /id="background-picker"/);
  await ui.click('settings-toggle');
  await ui.click('picker-dismiss');
  assert.doesNotMatch(ui.app.innerHTML, /id="background-picker"/);
  assert.deepEqual(ui.calls.slice(before), []);
});

test('新增客户端自动展示邀请地址，分页保留全局编号并打开正确客户端', async () => {
  const ui = await launcher();
  await ui.click('launch');
  for (let count = 1; count < 5; count++) await ui.click('additional');
  const clientIndices = () => [...ui.app.innerHTML.matchAll(/data-open="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(clientIndices(), [4]);
  assert.match(ui.app.innerHTML, /客户端 5 · 朋友/);
  assert.match(ui.app.innerHTML, /http:\/\/192\.168\.31\.225:8450\//);
  const before = ui.calls.length;
  await ui.click('', { open: '4' });
  assert.deepEqual(ui.calls.slice(before).map((call) => [call.command, JSON.stringify(call.args)]), [['open_game', '{"index":4,"trusted":false}']]);
  await ui.click('', { copyClient: '4' }); assert.equal(ui.copied.at(-1), 'http://192.168.31.225:8450/');
  await ui.click('clients-next');
  assert.deepEqual(clientIndices(), [0, 1, 2, 3]);
});

test('共享设置默认自动检测 IP，仅保存设置，没有独立开启或停止共享入口', async () => {
  const ui = await launcher();
  await ui.click('lan-setup');
  assert.match(ui.app.innerHTML, /class="shell" inert aria-hidden="true"/);
  assert.match(ui.app.innerHTML, /id="lan-address"[^>]*list="lan-ip-options"[^>]*value=""[^>]*placeholder="自动检测：192\.168\.31\.225/);
  assert.match(ui.app.innerHTML, /id="lan-http-port"[^>]*value="8442"/);
  assert.match(ui.app.innerHTML, /id="lan-port"[^>]*value="8443"/);
  assert.match(ui.app.innerHTML, /所有客户端共用 BinGo Root CA，朋友信任一次即可/);
  assert.doesNotMatch(ui.app.innerHTML, /type="file"|certificate_path|private_key_path|id="lan-(?:start|stop|modal-stop)"/);
  ui.events.get('document:click')({ target: { closest: () => null } });
  assert.match(ui.app.innerHTML, /class="lan-overlay"/);
  await ui.click('lan-close');
  assert.doesNotMatch(ui.app.innerHTML, /class="lan-overlay"/);
});

test('设置只提交 IP 和双端口，启动默认共享，朋友客户端不自动打开本机', async () => {
  const ui = await launcher(true, { resources: null });
  await ui.click('lan-setup');
  ui.input('address', '192.168.1.8'); ui.input('httpPort', '8445'); ui.input('port', '8444');
  const before = ui.calls.length;
  await ui.click('lan-save');
  assert.deepEqual(ui.calls.slice(before).map((call) => [call.command, JSON.stringify(call.args)]), [
    ['save_lan_settings', '{"port":8444,"httpPort":8445,"address":"192.168.1.8"}'],
  ]);
  assert.doesNotMatch(ui.app.innerHTML, /class="lan-overlay"/);
  await ui.click('launch');
  assert.match(ui.app.innerHTML, /http:\/\/192\.168\.1\.8:8445\//);
  await ui.click('', { copyClient: '0' }); assert.equal(ui.copied.at(-1), 'http://192.168.1.8:8445/');
  const opening = ui.calls.filter(call => call.command === 'open_game').length;
  await ui.click('additional');
  assert.equal(ui.calls.filter(call => call.command === 'open_game').length, opening);
  assert.match(ui.app.innerHTML, /http:\/\/192\.168\.1\.8:8447\//);
  await ui.click('', { copyClient: '1' }); assert.equal(ui.copied.at(-1), 'http://192.168.1.8:8447/');
  assert.equal([...ui.app.innerHTML.matchAll(/id="stop"/g)].length, 1);
  assert.doesNotMatch(ui.app.innerHTML, /id="lan-(?:start|stop|modal-stop)"/);
  await ui.click('stop');
  assert.equal(ui.calls.at(-1).command, 'stop_game');
  assert.doesNotMatch(ui.app.innerHTML, /class="client-address"/);
  assert.equal(ui.timers.size, 0);
});

test('保存失败保持输入以便修复重试，剪贴板失败不误报成功', async () => {
  const ui = await launcher(true, { clipboard: false });
  await ui.click('lan-setup'); ui.input('address', '192.168.1.8');
  ui.failCommand('save_lan_settings'); await ui.click('lan-save');
  assert.match(ui.app.innerHTML, /class="lan-overlay"/);
  assert.match(ui.app.innerHTML, /save_lan_settings failed/);
  assert.match(ui.app.innerHTML, /id="lan-address"[^>]*value="192\.168\.1\.8"/);
  ui.failCommand('save_lan_settings', false); await ui.click('lan-save');
  await ui.click('launch'); await ui.click('', { copyClient: '0' });
  assert.match(ui.app.innerHTML, /无法访问剪贴板，请手动复制/);
  assert.doesNotMatch(ui.app.innerHTML, /邀请地址已复制/);
});

test('保存拒绝重复端口，空 IP 保存自动检测，强制更新阻止变更设置', async () => {
  const ui = await launcher(); await ui.click('lan-setup');
  const before = ui.calls.length;
  ui.input('httpPort', '8443'); await ui.click('lan-save');
  assert.equal(ui.calls.length, before);
  assert.match(ui.app.innerHTML, /游戏 HTTPS 端口和安装引导 HTTP 端口不能相同/);
  publish(ui, newerSnapshot());
  assert.doesNotMatch(ui.app.innerHTML, /class="lan-overlay"/);
  await ui.click('lan-save'); assert.equal(ui.calls.length, before);
  const missing = await launcher(true, { lan: { addresses: [] } });
  await missing.click('lan-setup'); await missing.click('lan-save');
  assert.equal(missing.calls.at(-1).command, 'save_lan_settings');
  assert.equal(missing.calls.at(-1).args.address, null);
});

test('保存中 Esc 不退出，运行时设置只读且不另放停止按钮', async () => {
  const ui = await launcher(); await ui.click('lan-setup');
  const finish = ui.hold('save_lan_settings'), saving = ui.click('lan-save');
  await tick();
  let prevented = false;
  ui.events.get('document:keydown')({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.match(ui.app.innerHTML, /class="lan-overlay"/);
  const count = ui.calls.length; ui.input('port', '9999'); await ui.click('lan-save'); assert.equal(ui.calls.length, count);
  finish(); await saving; await ui.click('launch'); await ui.click('lan-setup');
  assert.match(ui.app.innerHTML, /请先停止游戏，再修改 IP 或端口/);
  assert.match(ui.app.innerHTML, /id="lan-address"[^>]*disabled/);
  assert.match(ui.app.innerHTML, /id="lan-save"[^>]*disabled/);
  assert.doesNotMatch(ui.app.innerHTML.slice(ui.app.innerHTML.indexOf('class="lan-overlay"')), /id="stop"|停止局域网共享/);
  const before = ui.calls.length; await ui.click('lan-save'); assert.equal(ui.calls.length, before);
  ui.events.get('document:keydown')({ key: 'Escape', preventDefault() {} });
  assert.doesNotMatch(ui.app.innerHTML, /class="lan-overlay"/);
  assert.match(ui.app.innerHTML, /class="client-address"/);
});


test('本机 CA 安装独立于游戏目录，调用系统授权命令并显示后端结果', async () => {
  const ui = await launcher(true, { selected: '', resources: null });
  assert.match(ui.app.innerHTML, /id="ca-install" class="secondary" >安装并信任 CA/);
  assert.match(ui.app.innerHTML, /id="ca-save" class="text-button" >下载 CA 证书/);
  const before = ui.calls.length;
  await ui.click('ca-install');
  assert.deepEqual(ui.calls.slice(before).map((call) => call.command), ['install_lan_ca']);
  assert.match(ui.app.innerHTML, /BinGo Root CA 已安装并信任，请重启浏览器后访问 HTTPS 游戏/);
  assert.doesNotMatch(ui.app.innerHTML, /ca-trust-fallback/);
});

test('系统 CA 安装失败显示原因与手动入口，保存公共证书后不声称已安装', async () => {
  const ui = await launcher();
  ui.failCommand('install_lan_ca'); await ui.click('ca-install');
  assert.match(ui.app.innerHTML, /install_lan_ca failed/);
  assert.match(ui.app.innerHTML, /自动安装未完成/);
  assert.match(ui.app.innerHTML, /id="ca-save" class="text-button" >下载 CA 证书/);
  await ui.click('ca-save');
  assert.equal(ui.calls.at(-1).command, 'save_lan_ca_certificate');
  assert.match(ui.app.innerHTML, /已保存 CA 证书：\/证书\/BinGo Root CA\.crt/);
  assert.match(ui.app.innerHTML, /请按系统说明安装并信任/);
  assert.doesNotMatch(ui.app.innerHTML, /已安装并信任/);
});

test('取消 CA 证书保存不会提示保存或信任成功', async () => {
  const ui = await launcher(true, { caSaveResult: null }); await ui.click('ca-save');
  assert.equal(ui.calls.at(-1).command, 'save_lan_ca_certificate');
  assert.match(ui.app.innerHTML, /已取消保存 CA 证书/);
  assert.doesNotMatch(ui.app.innerHTML, /已保存 CA 证书|已安装并信任/);
});

test('CA 操作禁止忙时重入、网页预览与强制更新时的原生命令', async () => {
  const ui = await launcher(); const finish = ui.hold('install_lan_ca');
  const installing = ui.click('ca-install'); await tick();
  assert.match(ui.app.innerHTML, /正在请求安装并信任 CA，请完成系统授权/);
  assert.match(ui.app.innerHTML, /id="ca-install"[^>]*disabled/);
  assert.match(ui.app.innerHTML, /id="ca-save"[^>]*disabled/);
  const count = ui.calls.length; await ui.click('ca-save'); await ui.click('ca-install');
  assert.equal(ui.calls.length, count);
  finish('BinGo Root CA 安装完成。'); await installing;
  publish(ui, newerSnapshot()); const locked = ui.calls.length;
  await ui.click('ca-install'); await ui.click('ca-save'); assert.equal(ui.calls.length, locked);
  const preview = await launcher(false);
  assert.match(preview.app.innerHTML, /id="ca-install"[^>]*disabled/);
  assert.match(preview.app.innerHTML, /id="ca-save"[^>]*disabled/);
  await preview.click('ca-install'); await preview.click('ca-save'); assert.equal(preview.calls.length, 0);
});

const caFingerprint = 'AB:'.repeat(31) + 'CD';
const readyResponse = (body = { ready: true, fingerprint: caFingerprint }, properties = {}) => ({ ok: true, type: 'cors', json: async () => body, ...properties });

test('本机证书通过实际主客户端 HTTPS 与 CA 指纹验证，首次启动直接打开 HTTPS 并隐藏 CA 入口', async () => {
  const ui = await launcher(true, { fetch: async () => readyResponse() });
  await ui.click('launch');
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0][0], 'https://192.168.31.225:8443/api/lan/ready');
  for (const [key, value] of [['mode', 'cors'], ['credentials', 'omit'], ['cache', 'no-store'], ['redirect', 'error']]) assert.equal(ui.requests[0][1][key], value);
  assert.equal(ui.calls.at(-1).command, 'open_game');
  assert.equal(ui.calls.at(-1).args.trusted, true);
  assert.doesNotMatch(ui.app.innerHTML, /id="ca-install"|id="ca-save"|ca-trust-fallback/);
  assert.equal(ui.timers.size, 0);
  await ui.click('additional');
  assert.equal(ui.requests.length, 1);
  await ui.click('launch'); assert.equal(ui.calls.at(-1).args.trusted, true);
  await ui.click('stop'); assert.doesNotMatch(ui.app.innerHTML, /id="ca-install"|id="ca-save"/);
});

test('系统安装返回成功不会代替 HTTPS 检测，每四秒重试并在信任生效后隐藏失败说明', async () => {
  const ui = await launcher(); await ui.click('launch');
  assert.equal(ui.calls.at(-1).args.trusted, false);
  assert.match(ui.app.innerHTML, /id="ca-install"|id="ca-save"/);
  await ui.click('ca-install'); await tick();
  assert.equal(ui.requests.length, 2);
  assert.match(ui.app.innerHTML, /id="ca-install"/);
  ui.failCommand('install_lan_ca'); await ui.click('ca-install'); await tick();
  assert.match(ui.app.innerHTML, /自动安装未完成/);
  ui.setFetch(async () => readyResponse()); await ui.runTimer(4000);
  assert.doesNotMatch(ui.app.innerHTML, /id="ca-install"|id="ca-save"|自动安装未完成|install_lan_ca failed/);
  assert.equal(ui.timers.size, 0);
});

test('不匹配指纹、未就绪、不透明响应、HTTP 错误和无效 JSON 都保留 CA 入口并重试', async () => {
  for (const reply of [
    readyResponse({ ready: true, fingerprint: 'OTHER' }),
    readyResponse({ ready: false, fingerprint: caFingerprint }),
    readyResponse(undefined, { type: 'opaque' }),
    readyResponse(undefined, { ok: false }),
    readyResponse(undefined, { json: async () => { throw new Error('invalid JSON'); } }),
  ]) {
    const ui = await launcher(true, { fetch: async () => reply }); await ui.click('launch');
    assert.equal(ui.calls.at(-1).args.trusted, false);
    assert.match(ui.app.innerHTML, /id="ca-install"|id="ca-save"/);
    assert.equal([...ui.timers.values()].filter(timer => timer.delay === 4000).length, 1);
  }
});

test('HTTPS 探测及 JSON 解析共用六秒超时，一次只发一个请求，超时可重新检测', async () => {
  let finish;
  const ui = await launcher(true, { fetch: async () => readyResponse(undefined, { json: () => new Promise(resolve => { finish = resolve; }) }) });
  const launching = ui.click('launch'); await tick();
  assert.equal(ui.requests.length, 1);
  const count = ui.calls.length; await ui.click('launch'); await ui.click('ca-install'); assert.equal(ui.calls.length, count);
  await ui.runTimer(6000); await launching;
  assert.equal(ui.requests[0][1].signal.aborted, true);
  assert.equal(ui.calls.at(-1).args.trusted, false);
  finish({ ready: true, fingerprint: caFingerprint }); await tick();
  assert.match(ui.app.innerHTML, /id="ca-install"/);
  ui.setFetch(async () => readyResponse()); await ui.runTimer(4000);
  assert.equal(ui.requests.length, 2);
  assert.doesNotMatch(ui.app.innerHTML, /id="ca-install"|id="ca-save"/);
});

test('停止会取消探测与重试，旧请求即使迟到成功也不能标记为已信任', async () => {
  let finish;
  const ui = await launcher(); await ui.click('launch');
  ui.setFetch(() => new Promise(resolve => { finish = resolve; })); await ui.runTimer(4000);
  const pending = ui.requests.at(-1)[1].signal;
  await ui.click('stop'); assert.equal(pending.aborted, true); assert.equal(ui.timers.size, 0);
  finish(readyResponse()); await tick();
  assert.match(ui.app.innerHTML, /id="ca-install"|id="ca-save"/);
  assert.equal(ui.timers.size, 0);
});

test('更换运行 IP 重新验证，旧会话响应不能覆盖新会话证书状态', async () => {
  let finish;
  const ui = await launcher(); await ui.click('launch');
  ui.setFetch(() => new Promise(resolve => { finish = resolve; })); await ui.runTimer(4000);
  await ui.click('stop');
  await ui.click('lan-setup'); ui.input('address', '10.0.0.7'); await ui.click('lan-save');
  ui.setFetch(async () => { throw new TypeError('not trusted'); }); await ui.click('launch');
  assert.equal(ui.requests.at(-1)[0], 'https://10.0.0.7:8443/api/lan/ready');
  finish(readyResponse()); await tick();
  assert.match(ui.app.innerHTML, /id="ca-install"/);
  assert.equal(ui.calls.at(-1).args.trusted, false);
  ui.setFetch(async () => readyResponse()); await ui.runTimer(4000);
  assert.doesNotMatch(ui.app.innerHTML, /id="ca-install"/);
});

test('探测成功不重绘正在打开的设置面板，关闭后隐藏 CA 入口', async () => {
  const ui = await launcher(); await ui.click('launch'); await ui.click('lan-setup');
  const before = ui.renderCount();
  ui.setFetch(async () => readyResponse()); await ui.runTimer(4000);
  assert.equal(ui.renderCount(), before);
  assert.match(ui.app.innerHTML, /class="lan-overlay"/);
  await ui.click('lan-close');
  assert.doesNotMatch(ui.app.innerHTML, /id="ca-install"|id="ca-save"/);
});

test('信任成功只清理 CA 安装错误，保留后来出现的剪贴板错误', async () => {
  const ui = await launcher(true, { clipboard: false }); await ui.click('launch');
  ui.failCommand('install_lan_ca'); await ui.click('ca-install'); await tick();
  await ui.click('', { copyClient: '0' });
  ui.setFetch(async () => readyResponse()); await ui.runTimer(4000);
  assert.match(ui.app.innerHTML, /无法访问剪贴板，请手动复制/);
  assert.doesNotMatch(ui.app.innerHTML, /id="ca-install"|id="ca-save"|自动安装未完成/);
});
