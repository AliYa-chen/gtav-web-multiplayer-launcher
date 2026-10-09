import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as presentation from '../src/view-state.js';
import * as internationalization from '../src/i18n.js';

const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const caFingerprint = 'AB:'.repeat(31) + 'CD';
async function launcher(desktop = true, options = {}) {
  const calls = [], values = new Map(), events = new Map(), intervals = [], held = new Map(), failures = new Set(), copied = [], requests = [], timers = new Map();
  let timerId = 0, frameId = 0;
  const frames = new Map(), observers = [];
  let clients = options.clients || (options.urls || []).map((url, index) => ({ id: index + 1, number: index + 1, primary: index === 0, running_url: url, invitation_url: options.invitationUrls?.[index] || '' }));
  let lastClientId = Math.max(0, ...clients.map((client) => client.id));
  let layout = { detailsHeight: 170, addressTop: 24, cardHeight: 60, rowGap: 7, ...options.layout };
  let lan = { settings: { port: 8443, http_port: 8442 }, addresses: ['192.168.31.225'], running_url: null, guide_url: null, host_address: null, ca_fingerprint: null, ...options.lan };
  let caSystemStatus = options.caSystemStatus || { installed: false, trusted: false, fingerprint: null, message: '' };
  let language = options.language || { preference: 'system', resolved: 'zh-CN', revision: 0 };
  let remoteFailure = false;
  let resources = options.resources === undefined ? { manifest_file_count: 5814 } : options.resources;
  let remote = { config: { oltitle: 'https://gtav.2t.hk', latest_version: '0.2.5', downloads: { windows_x64: { url: 'https://oss.2t.hk/launcher.exe', sha256: 'a'.repeat(64) } }, announcements: [{ title: '<img>', body: '<script>unsafe</script>' }] }, source: 'remote' };
  const status = () => ({ language, selected_directory: options.selected === undefined ? '/游戏资源' : options.selected, resources, clients,
    running_urls: clients.map((client) => client.running_url), invitation_urls: clients.map((client) => client.invitation_url), lan, version: '0.2.5', platform: 'windows_x64', remote_configuration: remote });
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
  const details = { get clientHeight() { return layout.detailsHeight; }, scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }) };
  const addresses = { get clientWidth() { return layout.width || 400; }, getBoundingClientRect: () => ({ top: 100 + layout.addressTop }),
    querySelectorAll: () => [...app.innerHTML.matchAll(/data-client-id="([^"]+)"/g)].map((match) => ({ dataset: { clientId: match[1] },
      getBoundingClientRect: () => ({ height: clients.find((client) => String(client.id) === match[1])?.primary ? layout.primaryHeight ?? layout.cardHeight : layout.cardHeight }) })) };
  const document = { activeElement: null, documentElement: { style: { setProperty() {} } }, querySelector(selector) {
    if (selector === '#app') return app;
    if (selector === '.launch-details') return details;
    if (selector === '.addresses') return app.innerHTML.includes('class="addresses"') ? addresses : null;
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
    ...presentation, ...internationalization, html: presentation.escapeHtml, metadata: { version: '0.2.5' }, backgrounds: [{ id: 'sunglasses', labelKey: 'background.sunglasses', image: '/sunglasses.webp' }, { id: 'beach', labelKey: 'background.beach', image: '/beach.webp' }],
    document, localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) }, isTauri: () => desktop,
    navigator: { language: options.browserLanguage || 'zh-CN', languages: [options.browserLanguage || 'zh-CN'], ...(options.clipboard === false ? {} : { clipboard: { writeText: async (text) => { copied.push(text); } } }) },
    listen: async (name, callback) => { events.set(`tauri:${name}`, callback); return () => {}; }, invoke: async (command, args) => {
      calls.push({ command, args });
      if (failures.has(command)) throw options.commandErrors?.[command] || new Error(`${command} failed`);
      if (held.has(command)) return await held.get(command).promise;
      if (command === 'set_language') { language = { preference: args.language, resolved: args.language === 'system' ? options.browserLanguage || 'zh-CN' : args.language, revision: language.revision + 1 }; events.get('tauri:language-change')?.({ payload: language }); }
      if (command === 'install_lan_ca') return 'BinGo Root CA 已安装并信任，请重启浏览器后访问 HTTPS 游戏。';
      if (command === 'check_lan_ca_status') return caSystemStatus;
      if (command === 'save_lan_ca_certificate') return options.caSaveResult === undefined ? '/证书/BinGo Root CA.crt' : options.caSaveResult;
      if (command === 'choose_game_directory') return '/新资源';
      if (command === 'prepare_game') resources = { manifest_file_count: 5814 };
      if (command === 'start_game') {
        if (!args.additional && clients.some((client) => client.primary)) return status();
        if (clients.length >= 8) throw new Error('最多同时开启 8 个客户端。');
        const address = lan.settings.address || '192.168.31.225', offset = lastClientId * 2, id = ++lastClientId;
        clients = [...clients, { id, number: id, primary: !args.additional,
          running_url: `https://${address}:${lan.settings.port + offset}/`, invitation_url: `http://${address}:${lan.settings.http_port + offset}/` }];
        const primary = clients.find((client) => client.primary);
        lan = { ...lan, host_address: address, running_url: primary?.running_url || null, guide_url: primary?.invitation_url || null, ca_fingerprint: 'AB:'.repeat(31) + 'CD' };
      }
      if (command === 'stop_game_client') {
        clients = clients.filter((client) => client.id !== args.id);
        const primary = clients.find((client) => client.primary);
        lan = { ...lan, running_url: primary?.running_url || null, guide_url: primary?.invitation_url || null, host_address: clients.length ? lan.host_address : null };
      }
      if (command === 'stop_game') { clients = []; lan = { ...lan, running_url: null, guide_url: null, host_address: null }; }
      if (command === 'save_lan_settings') lan = { ...lan, settings: { port: args.port, http_port: args.httpPort, address: args.address } };
      if (command === 'remote_configuration') { if (remoteFailure) throw new Error('failed request'); return remote; }
      return status();
    },
    fetch: (...args) => { requests.push(args); throw new Error('The launcher must use native CA status'); },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; },
    requestAnimationFrame: (callback) => { const id = ++frameId; frames.set(id, callback); return id; },
    ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } disconnect() {} observe() {} },
    getComputedStyle: () => ({ rowGap: String(layout.rowGap) }),
  });
  const flushFrames = () => {
    for (let count = 0; frames.size && count < 10; count++) {
      const scheduled = [...frames]; frames.clear();
      for (const [, callback] of scheduled) callback();
    }
    assert.equal(frames.size, 0, 'layout measurement should settle without a render loop');
  };
  vm.runInContext(source, context);
  await tick();
  flushFrames();
  return { calls, app, values, events, intervals, document, status, copied, requests, timers,
    renderCount: () => renderCount,
    resize(value) { layout = { ...layout, ...value }; observers.forEach((observer) => observer.callback()); flushFrames(); },
    setCaSystemStatus(value) { caSystemStatus = value; },
    async runTimer(delay) { const entries = [...timers].filter(([, timer]) => timer.delay === delay); const entry = entries.at(-1); assert.ok(entry, `missing ${delay}ms timer`); timers.delete(entry[0]); entry[1].callback(); await tick(); },
    setRemote(value) { remote = value; remoteFailure = false; }, failRemote() { remoteFailure = true; },
    failCommand(command, failed = true) { failed ? failures.add(command) : failures.delete(command); },
    hold(command) { let resolve; const promise = new Promise((accept) => { resolve = accept; }); held.set(command, { promise }); return (value = status()) => { held.delete(command); resolve(value); }; },
    async changeLanguage(value) { await events.get('app:change')({ target: { id: 'launcher-language', value } }); flushFrames(); },
    input(field, value) { events.get('app:input')({ target: { dataset: { lanField: field }, value } }); },
    async click(id, dataset = {}) { const button = { id, dataset, disabled: false }; await events.get('app:click')({ target: { closest: () => button } }); flushFrames(); } };
}

function newerSnapshot(overrides = {}) {
  return { source: 'remote', stale: false, config: { latest_version: '0.2.6', release_notes: '必须更新\n修复连接。',
    downloads: { windows_x64: { url: 'https://oss.2t.hk/launcher-new.exe', sha256: 'b'.repeat(64) } }, ...overrides } };
}
function publish(ui, snapshot) {
  ui.setRemote(snapshot);
  ui.events.get('tauri:launcher-remote-config')({ payload: snapshot });
}
function clientIds(ui) {
  return [...ui.app.innerHTML.matchAll(/data-client-id="(\d+)"/g)].map((match) => Number(match[1]));
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
    ['prepare_game', '{"selected":"/新资源"}'], ['start_game', '{"additional":false}'], ['open_game', '{"id":1,"trusted":false}'],
  ]);
  const beforeAdditional = ui.calls.length; await ui.click('additional');
  assert.deepEqual(ui.calls.slice(beforeAdditional).map(call => call.command), ['start_game']);
  assert.match(ui.app.innerHTML, /客户端 1 · 本机/);
  assert.doesNotMatch(ui.app.innerHTML, /data-copy-client="1"/);
  await ui.click('', { copyClient: '2' });
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
  assert.match(ui.app.innerHTML, /aria-label="选择背景：海风与阳光"/);
  assert.match(ui.app.innerHTML, /aria-label="选择背景：日落海滩"/);
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
  const clientIndices = () => clientIds(ui);
  assert.deepEqual(clientIndices(), [5]);
  assert.match(ui.app.innerHTML, /客户端 5 · 朋友/);
  assert.match(ui.app.innerHTML, /http:\/\/192\.168\.31\.225:8450\//);
  const before = ui.calls.length;
  await ui.click('', { open: '5' });
  assert.deepEqual(ui.calls.slice(before).map((call) => [call.command, JSON.stringify(call.args)]), [['open_game', '{"id":5,"trusted":false}']]);
  await ui.click('', { copyClient: '5' }); assert.equal(ui.copied.at(-1), 'http://192.168.31.225:8450/');
  await ui.click('clients-next');
  assert.deepEqual(clientIndices(), [1, 2, 3, 4]);
  assert.doesNotMatch(ui.app.innerHTML, /data-open="1"/);
});

test('本机仅显示 HTTPS 服务地址和停止服务，朋友保留邀请操作，重建本机后继续禁止复制', async () => {
  const ui = await launcher();
  await ui.click('launch');
  assert.match(ui.app.innerHTML, /data-client-id="1"/);
  assert.match(ui.app.innerHTML, /<code title="https:\/\/192\.168\.31\.225:8443\/">https:\/\/192\.168\.31\.225:8443\/<\/code>/);
  assert.doesNotMatch(ui.app.innerHTML, /data-copy-client|data-open|client-address__actions|复制后发给朋友/);
  await ui.click('', { copyClient: '1' }); assert.equal(ui.copied.length, 0);
  await ui.click('additional');
  assert.match(ui.app.innerHTML, /data-open="2"/);
  assert.match(ui.app.innerHTML, /data-copy-client="2"/);
  assert.match(ui.app.innerHTML, /复制后发给朋友/);
  await ui.click('', { copyClient: '2' }); assert.equal(ui.copied.at(-1), 'http://192.168.31.225:8444/');
  await ui.click('', { stopClient: '1' }); await ui.click('launch');
  assert.match(ui.app.innerHTML, /客户端 3 · 本机/);
  assert.doesNotMatch(ui.app.innerHTML, /data-copy-client="3"|data-open="3"/);
  const copied = ui.copied.length;
  await ui.click('', { copyClient: '3' }); assert.equal(ui.copied.length, copied);
});

test('仅本机卡片较矮时，末页和重开本机不会导致容量来回变化', async () => {
  const ui = await launcher(true, { layout: { primaryHeight: 30, detailsHeight: 170 } });
  await ui.click('launch');
  for (let count = 1; count < 5; count++) await ui.click('additional');
  await ui.click('', { stopClient: '1' });
  await ui.click('launch');
  // Four friend cards use two rows; the shorter local card can occupy the next page.
  assert.deepEqual(clientIds(ui), [2, 3, 4, 5]);
  await ui.click('clients-next');
  assert.deepEqual(clientIds(ui), [6]);
  assert.match(ui.app.innerHTML, /id="clients-next"[^>]*>2 \/ 2/);
  ui.resize({ detailsHeight: 180 });
  assert.deepEqual(clientIds(ui), [6]);
  assert.doesNotMatch(ui.app.innerHTML, /data-copy-client="6"/);
});

test('真实剩余空间容纳八项就完整显示，缩小后分页，尺寸变化保持正在阅读的客户端', async () => {
  const ui = await launcher(true, { layout: { detailsHeight: 285 } });
  await ui.click('launch');
  for (let count = 1; count < 8; count++) await ui.click('additional');
  assert.deepEqual(clientIds(ui), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.doesNotMatch(ui.app.innerHTML, /id="clients-next"/);
  assert.match(ui.app.innerHTML, /id="additional"[^>]*disabled/);
  const before = ui.calls.length;
  await ui.click('additional'); assert.equal(ui.calls.length, before);
  // The same cards fit only one row when the remaining height is reduced.
  ui.resize({ detailsHeight: 90 });
  assert.deepEqual(clientIds(ui), [1, 2]);
  await ui.click('clients-next'); assert.deepEqual(clientIds(ui), [3, 4]);
  await ui.click('clients-next'); assert.deepEqual(clientIds(ui), [5, 6]);
  ui.resize({ detailsHeight: 170 });
  assert.deepEqual(clientIds(ui), [5, 6, 7, 8]);
  assert.match(ui.app.innerHTML, /id="clients-next"[^>]*>2 \/ 2/);
  ui.resize({ detailsHeight: 285 });
  assert.deepEqual(clientIds(ui), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.doesNotMatch(ui.app.innerHTML, /id="clients-next"/);
});

test('新增在当前页时保持页码，单项停止调用稳定 ID，删除最后一页回退且不重编号', async () => {
  const ui = await launcher(true, { layout: { detailsHeight: 90 } });
  await ui.click('launch'); await ui.click('additional');
  assert.deepEqual(clientIds(ui), [1, 2]);
  await ui.click('additional'); assert.deepEqual(clientIds(ui), [3]);
  await ui.click('additional'); assert.deepEqual(clientIds(ui), [3, 4]);
  await ui.click('additional'); assert.deepEqual(clientIds(ui), [5]);
  const before = ui.calls.length;
  await ui.click('', { stopClient: '5' });
  assert.deepEqual(ui.calls.slice(before).map((call) => [call.command, JSON.stringify(call.args)]), [['stop_game_client', '{"id":5}']]);
  assert.deepEqual(clientIds(ui), [3, 4]);
  assert.match(ui.app.innerHTML, /客户端 5 的游戏与共享服务已停止/);
  await ui.click('', { stopClient: '3' });
  assert.deepEqual(clientIds(ui), [4]);
  assert.match(ui.app.innerHTML, /客户端 4 · 朋友/);
  await ui.click('', { copyClient: '4' }); assert.equal(ui.copied.at(-1), 'http://192.168.31.225:8448/');
  await ui.click('', { open: '4' }); assert.equal(ui.calls.at(-1).args.id, 4);
  await ui.click('', { stopClient: '4' });
  assert.deepEqual(clientIds(ui), [1, 2]);
});

test('停止本机客户端保留朋友角色，再次启动只重建本机；停止失败不移除卡片且阻止重入', async () => {
  const ui = await launcher();
  await ui.click('launch'); await ui.click('additional'); await ui.click('additional');
  assert.match(ui.app.innerHTML, /aria-label="停止客户端 1 的游戏与共享服务"/);
  await ui.click('', { stopClient: '1' });
  assert.deepEqual(clientIds(ui), [2, 3]);
  assert.match(ui.app.innerHTML, /客户端 2 · 朋友/);
  assert.doesNotMatch(ui.app.innerHTML, /客户端 \d+ · 本机/);
  assert.match(ui.app.innerHTML, /id="launch"[^>]*>启动游戏/);
  const before = ui.calls.length;
  await ui.click('launch');
  assert.deepEqual(ui.calls.slice(before).filter((call) => ['start_game', 'open_game'].includes(call.command)).map((call) => [call.command, JSON.stringify(call.args)]), [
    ['start_game', '{"additional":false}'], ['open_game', '{"id":4,"trusted":false}'],
  ]);
  assert.deepEqual(clientIds(ui), [2, 3, 4]);
  assert.match(ui.app.innerHTML, /客户端 4 · 本机/);
  ui.failCommand('stop_game_client'); await ui.click('', { stopClient: '2' });
  assert.deepEqual(clientIds(ui), [2, 3, 4]);
  assert.match(ui.app.innerHTML, /stop_game_client failed/);
  ui.failCommand('stop_game_client', false);
  const finish = ui.hold('stop_game_client'), stopping = ui.click('', { stopClient: '2' });
  await tick();
  assert.match(ui.app.innerHTML, /data-stop-client="3"[^>]*disabled/);
  const heldCalls = ui.calls.length;
  await ui.click('', { stopClient: '3' }); assert.equal(ui.calls.length, heldCalls);
  finish(); await stopping;
  const unchanged = ui.calls.length;
  await ui.click('', { stopClient: '999' }); await ui.click('', { open: '999' });
  assert.equal(ui.calls.length, unchanged);
});

test('启动器右键菜单被阻止，完成按钮关闭设置且不保存未提交输入', async () => {
  const ui = await launcher();
  let prevented = false;
  ui.events.get('document:contextmenu')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await ui.click('lan-setup'); ui.input('address', '10.0.0.9');
  assert.match(ui.app.innerHTML, /id="lan-done" class="secondary"/);
  const before = ui.calls.length;
  await ui.click('lan-done');
  assert.doesNotMatch(ui.app.innerHTML, /class="lan-overlay"/);
  assert.equal(ui.calls.length, before);
  await ui.click('lan-setup');
  assert.match(ui.app.innerHTML, /id="lan-address"[^>]*value=""/);
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
  assert.doesNotMatch(ui.app.innerHTML, /http:\/\/192\.168\.1\.8:8445\//);
  assert.match(ui.app.innerHTML, /https:\/\/192\.168\.1\.8:8444\//);
  assert.doesNotMatch(ui.app.innerHTML, /data-copy-client="1"/);
  const copiedBeforePrimary = ui.copied.length;
  await ui.click('', { copyClient: '1' }); assert.equal(ui.copied.length, copiedBeforePrimary);
  const opening = ui.calls.filter(call => call.command === 'open_game').length;
  await ui.click('additional');
  assert.equal(ui.calls.filter(call => call.command === 'open_game').length, opening);
  assert.match(ui.app.innerHTML, /http:\/\/192\.168\.1\.8:8447\//);
  await ui.click('', { copyClient: '2' }); assert.equal(ui.copied.at(-1), 'http://192.168.1.8:8447/');
  assert.equal([...ui.app.innerHTML.matchAll(/id="stop"/g)].length, 1);
  assert.doesNotMatch(ui.app.innerHTML, /id="lan-(?:start|stop|modal-stop)"/);
  await ui.click('stop');
  assert.equal(ui.calls.at(-1).command, 'stop_game');
  assert.doesNotMatch(ui.app.innerHTML, /class="client-address"/);
  assert.equal([...ui.timers.values()].filter(timer => timer.delay === 6000 || timer.delay === 4000).length, 1);
});

test('保存失败保持输入以便修复重试，剪贴板失败不误报成功', async () => {
  const ui = await launcher(true, { clipboard: false });
  await ui.click('lan-setup'); ui.input('address', '192.168.1.8');
  ui.failCommand('save_lan_settings'); await ui.click('lan-save');
  assert.match(ui.app.innerHTML, /class="lan-overlay"/);
  assert.match(ui.app.innerHTML, /save_lan_settings failed/);
  assert.match(ui.app.innerHTML, /id="lan-address"[^>]*value="192\.168\.1\.8"/);
  ui.failCommand('save_lan_settings', false); await ui.click('lan-save');
  await ui.click('launch'); await ui.click('additional'); await ui.click('', { copyClient: '2' });
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
  assert.deepEqual(ui.calls.slice(before).map((call) => call.command), ['install_lan_ca', 'check_lan_ca_status']);
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

test('启动器启动前后台识别系统 CA，已安装但未信任时保留手动入口并明确状态', async () => {
  const ui = await launcher(true, { caSystemStatus: { installed: true, trusted: false, fingerprint: caFingerprint, message: '' } });
  assert.ok(ui.calls.some((call) => call.command === 'check_lan_ca_status'));
  assert.match(ui.app.innerHTML, /系统已安装但未信任，请完成系统信任/);
  assert.match(ui.app.innerHTML, /id="ca-install"|id="ca-save"/);
});

test('系统查询失败只显示短状态，不阻止启动，且网页预览不调用系统查询', async () => {
  const ui = await launcher(); ui.failCommand('check_lan_ca_status');
  // Initial query already completed before the failure flag; the next retry exercises the error path.
  await ui.runTimer(4000);
  assert.match(ui.app.innerHTML, /系统证书状态暂不可用，可手动安装或下载 CA/);
  assert.match(ui.app.innerHTML, /id="ca-install"|id="ca-save"/);
  await ui.click('launch'); assert.equal(ui.calls.at(-1).command, 'open_game');
  assert.equal(ui.calls.at(-1).args.trusted, false);
  const preview = await launcher(false); assert.equal(preview.calls.length, 0);
});

test('系统确认安装并信任后隐藏整个 CA 区，本机所有客户端直接打开 HTTPS，无网络探测', async () => {
  const ui = await launcher(true, { caSystemStatus: { installed: true, trusted: true, fingerprint: caFingerprint } });
  assert.doesNotMatch(ui.app.innerHTML, /id="ca-install"|id="ca-save"/);
  assert.doesNotMatch(ui.app.innerHTML, /ca-trust-actions|ca-system-status/);
  await ui.click('launch');
  assert.equal(ui.calls.at(-1).command, 'open_game');
  assert.equal(ui.calls.at(-1).args.trusted, true);
  await ui.click('additional'); await ui.click('', { open: '2' });
  assert.equal(ui.calls.at(-1).args.trusted, true);
  assert.equal(ui.requests.length, 0);
});

test('安装后重新查询系统状态，确认已信任后立即隐藏安装下载区域并停止轮询', async () => {
  const ui = await launcher(true, { caSystemStatus: { installed: false, trusted: false, fingerprint: null } });
  ui.setCaSystemStatus({ installed: true, trusted: true, fingerprint: caFingerprint, message: '系统已信任' });
  await ui.click('ca-install');
  assert.ok(ui.calls.filter((call) => call.command === 'check_lan_ca_status').length >= 2);
  assert.doesNotMatch(ui.app.innerHTML, /ca-trust-actions|ca-system-status|id="ca-install"|id="ca-save"/);
  assert.equal(ui.timers.size, 0);
});

test('首次启动等待新的原生状态查询，系统诊断只作为文本显示', async () => {
  const ui = await launcher(true, { caSystemStatus: { installed: false, trusted: false, message: '<img src=x onerror=alert(1)>' } });
  assert.match(ui.app.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(ui.app.innerHTML, /<img src=x/);
  const finish = ui.hold('check_lan_ca_status');
  const launching = ui.click('launch'); await tick();
  assert.equal(ui.calls.some(call => call.command === 'open_game'), false);
  finish({ installed: true, trusted: true }); await launching;
  assert.equal(ui.calls.at(-1).command, 'open_game');
  assert.equal(ui.calls.at(-1).args.trusted, true);
});

test('系统信任生效清理安装错误，同时保留后来的其他错误', async () => {
  const ui = await launcher(true, { clipboard: false });
  ui.failCommand('install_lan_ca'); await ui.click('ca-install');
  ui.setCaSystemStatus({ installed: true, trusted: true, fingerprint: caFingerprint });
  await ui.runTimer(4000);
  assert.doesNotMatch(ui.app.innerHTML, /install_lan_ca failed|自动安装未完成/);
  const other = await launcher(true, { clipboard: false });
  other.failCommand('install_lan_ca'); await other.click('ca-install');
  await other.click('launch'); await other.click('additional'); await other.click('', { copyClient: '2' });
  other.setCaSystemStatus({ installed: true, trusted: true, fingerprint: caFingerprint });
  await other.runTimer(4000);
  assert.match(other.app.innerHTML, /无法访问剪贴板，请手动复制/);
});


test('后台原生信任查询不会重绘共享设置，安装字符串成功仍必须确认系统信任', async () => {
  const ui = await launcher(); await ui.click('ca-install');
  assert.match(ui.app.innerHTML, /id="ca-install"|id="ca-save"/);
  await ui.click('lan-setup'); ui.input('address', '10.0.0.7');
  const before = ui.renderCount();
  ui.setCaSystemStatus({ installed: true, trusted: true, fingerprint: caFingerprint });
  await ui.runTimer(4000);
  assert.equal(ui.renderCount(), before);
  await ui.click('lan-close');
  assert.doesNotMatch(ui.app.innerHTML, /ca-trust-actions|id="ca-install"|id="ca-save"/);
});

test('安装后等待旧查询完成再重新检查，系统已信任不保留旧安装失败提示', async () => {
  const ui = await launcher();
  const finish = ui.hold('check_lan_ca_status'); await ui.runTimer(4000);
  const queries = ui.calls.filter(call => call.command === 'check_lan_ca_status').length;
  ui.failCommand('install_lan_ca');
  const installing = ui.click('ca-install'); await tick();
  ui.setCaSystemStatus({ installed: true, trusted: true, fingerprint: caFingerprint });
  finish({ installed: false, trusted: false }); await installing;
  assert.equal(ui.calls.filter(call => call.command === 'check_lan_ca_status').length, queries + 1);
  assert.doesNotMatch(ui.app.innerHTML, /ca-trust-actions|id="ca-install"|id="ca-save"|install_lan_ca failed|自动安装未完成/);
});

test('启动器以持久语言为准，系统为英文仍能恢复中文；英文配置覆盖浏览器语言', async () => {
  const chinese = await launcher(true, { browserLanguage: 'en-US', language: { preference: 'zh-CN', resolved: 'zh-CN', revision: 3 } });
  assert.equal(chinese.document.documentElement.lang, 'zh-CN');
  assert.match(chinese.app.innerHTML, /选择游戏资源/);
  const english = await launcher(true, { browserLanguage: 'zh-CN', language: { preference: 'en', resolved: 'en', revision: 2 }, selected: '', resources: null });
  assert.equal(english.document.documentElement.lang, 'en');
  assert.equal(english.document.title, 'GTA V Public Sessions · Launcher');
  assert.match(english.app.innerHTML, /Select game resources|No game resources folder selected/);
  assert.match(english.app.innerHTML, /Install and trust CA|Download CA certificate/);
  assert.doesNotMatch(english.app.innerHTML, /选择游戏资源|尚未选择游戏资源目录|启动游戏/);
});

test('语言下拉立即翻译已启动客户端、完成消息、ARIA与共享设置，并交由后端持久化', async () => {
  const ui = await launcher(); await ui.click('launch'); await ui.click('additional');
  await ui.click('settings-toggle'); await ui.changeLanguage('en');
  assert.deepEqual(ui.calls.filter((call) => call.command === 'set_language').map((call) => JSON.stringify(call.args)), ['{"language":"en"}']);
  assert.match(ui.app.innerHTML, /value="en" selected/);
  assert.match(ui.app.innerHTML, /2 clients running|Client 1 · Local|Client 2 · Friend/);
  assert.match(ui.app.innerHTML, /aria-label="Stop the game and sharing service for client 2"/);
  assert.match(ui.app.innerHTML, /Friend client ready\. Copy its invitation/);
  assert.match(ui.app.innerHTML, /Choose background: Ocean breeze/);
  await ui.click('picker-close'); await ui.click('lan-setup');
  assert.match(ui.app.innerHTML, /LAN sharing settings|Setup guide HTTP port|Game HTTPS port/);
  assert.match(ui.app.innerHTML, /Stop the game before changing the IP or ports/);
  await ui.click('lan-close'); await ui.click('settings-toggle'); await ui.changeLanguage('zh-CN');
  assert.match(ui.app.innerHTML, /2 个客户端已启动|客户端 1 · 本机|朋友客户端已准备就绪/);
  assert.equal(ui.document.documentElement.lang, 'zh-CN');
});

test('后端语言事件刷新公告与错误详情，旧操作状态不能回退新的语言', async () => {
  const ui = await launcher(true, { resources: null });
  const oldStatus = ui.status();
  const finish = ui.hold('prepare_game'), preparing = ui.click('verify'); await tick();
  ui.events.get('tauri:language-change')({ payload: { preference: 'en', resolved: 'en', revision: 5 } });
  ui.events.get('tauri:launcher-progress')({ payload: { phase: 'engine', text: '准备启动器的离线与在线运行引擎…' } });
  assert.match(ui.app.innerHTML, /Preparing the launcher’s offline and online runtime engines/);
  finish(oldStatus); await preparing;
  assert.equal(ui.document.documentElement.lang, 'en');
  assert.match(ui.app.innerHTML, /Resources and runtime engine are ready/);
  ui.failCommand('start_game'); await ui.click('launch'); await ui.click('', { read: 'error' });
  assert.match(ui.app.innerHTML, /Launcher details|start_game failed|Page 1 \/ 1/);
  ui.events.get('tauri:language-change')({ payload: { preference: 'zh-CN', resolved: 'zh-CN', revision: 6 } });
  assert.match(ui.app.innerHTML, /启动信息|第 1 \/ 1 页/);
});

test('语言保存失败恢复原设置且未知值不调用后端，网页预览只更新本页', async () => {
  const ui = await launcher(); await ui.click('settings-toggle');
  const before = ui.calls.length; await ui.changeLanguage('de'); assert.equal(ui.calls.length, before);
  ui.failCommand('set_language'); await ui.changeLanguage('en');
  assert.equal(ui.document.documentElement.lang, 'zh-CN');
  assert.match(ui.app.innerHTML, /无法保存语言设置，请重试/);
  assert.match(ui.app.innerHTML, /value="system" selected/);
  const preview = await launcher(false, { browserLanguage: 'en-US' });
  assert.equal(preview.document.documentElement.lang, 'en');
  await preview.click('settings-toggle'); await preview.changeLanguage('zh-CN');
  assert.equal(preview.document.documentElement.lang, 'zh-CN');
  assert.deepEqual(preview.calls, []);
});

test('真实CA错误与系统状态、已打开CA详情在中英间热切，诊断与保存路径保持原样', async () => {
  const error = '无法请求钥匙串授权，请下载 CA 后手动安装并信任。系统错误：cancelled <err>';
  const ui = await launcher(true, { commandErrors: { install_lan_ca: error } });
  ui.failCommand('install_lan_ca'); await ui.click('ca-install'); await ui.click('', { read: 'error' });
  ui.events.get('tauri:language-change')({ payload: { preference: 'en', resolved: 'en', revision: 8 } });
  assert.match(ui.app.innerHTML, /Unable to request keychain authorization/);
  assert.match(ui.app.innerHTML, /System error: cancelled &lt;err&gt;/);
  assert.match(ui.app.innerHTML, /Automatic installation is incomplete|Launcher details/);
  ui.events.get('tauri:language-change')({ payload: { preference: 'zh-CN', resolved: 'zh-CN', revision: 9 } });
  assert.match(ui.app.innerHTML, /无法请求钥匙串授权/);
  await ui.click('reader-close'); await ui.click('ca-save');
  ui.events.get('tauri:language-change')({ payload: { preference: 'en', resolved: 'en', revision: 10 } });
  assert.match(ui.app.innerHTML, /CA certificate saved: \/证书\/BinGo Root CA.crt/);
  ui.setCaSystemStatus({ installed: true, trusted: false, message: 'BinGo Root CA 已安装，但尚未通过系统 SSL 信任验证：certificate denied' });
  await ui.runTimer(4000);
  assert.match(ui.app.innerHTML, /Installed but not trusted|has not passed system SSL trust verification: certificate denied/);
});

test('双语公告和版本详情已打开时随语言事件重译正文而不会丢失分页内容', async () => {
  const ui = await launcher();
  publish(ui, { source: 'remote', config: { latest_version: '0.2.5', announcements: [{ title: '中文公告', body: '中文正文' }], release_notes: '中文说明',
    i18n: { en: { announcements: [{ title: 'English announcement', body: 'English body' }], release_notes: 'English release notes' } } } });
  await ui.click('', { read: 'announcement' });
  ui.events.get('tauri:language-change')({ payload: { preference: 'en', resolved: 'en', revision: 3 } });
  assert.match(ui.app.innerHTML, /id="reader-title">English announcement/);
  assert.match(ui.app.innerHTML, /class="reader-text">English body/);
  await ui.click('reader-close'); await ui.click('', { read: 'release' });
  assert.match(ui.app.innerHTML, /class="reader-text">English release notes/);
  ui.events.get('tauri:language-change')({ payload: { preference: 'zh-CN', resolved: 'zh-CN', revision: 4 } });
  assert.match(ui.app.innerHTML, /id="reader-title">版本说明/);
  assert.match(ui.app.innerHTML, /class="reader-text">中文说明/);
});

test('语言保存期间的旧同revision状态不撤销即时选择，提交事件确认后采用新revision', async () => {
  const ui = await launcher(true, { resources: null }); await ui.click('settings-toggle');
  const original = ui.status();
  const finishLanguage = ui.hold('set_language'), selecting = ui.changeLanguage('en'); await tick();
  assert.equal(ui.document.documentElement.lang, 'en');
  assert.match(ui.app.innerHTML, /Saving language preference/);
  const finishPrepare = ui.hold('prepare_game'), preparing = ui.click('verify'); await tick();
  finishPrepare(original); await preparing;
  assert.equal(ui.document.documentElement.lang, 'en');
  const result = { ...original, language: { preference: 'en', resolved: 'en', revision: 1 } };
  ui.events.get('tauri:language-change')({ payload: result.language });
  finishLanguage(result); await selecting;
  assert.equal(ui.document.documentElement.lang, 'en');
  assert.match(ui.app.innerHTML, /value="en" selected/);
});
