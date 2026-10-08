import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as presentation from '../src/view-state.js';

const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function launcher(desktop = true) {
  const calls = [], values = new Map(), events = new Map(), intervals = [];
  let urls = [];
  let remoteFailure = false;
  let remote = { config: { oltitle: 'https://gtav.2t.hk', latest_version: '0.2.0', downloads: { windows_x64: { url: 'https://oss.2t.hk/launcher.exe', sha256: 'a'.repeat(64) } }, announcements: [{ title: '<img>', body: '<script>unsafe</script>' }] }, source: 'remote' };
  const status = () => ({ selected_directory: '/游戏资源', resources: { manifest_file_count: 5814 }, running_urls: urls, version: '0.1.2', platform: 'windows_x64', remote_configuration: remote });
  const app = { innerHTML: '', addEventListener(name, callback) { events.set(`app:${name}`, callback); } };
  const document = { activeElement: null, documentElement: { style: { setProperty() {} } }, querySelector(selector) { return selector === '#app' ? app : null; }, addEventListener(name, callback) { events.set(`document:${name}`, callback); } };
  const context = vm.createContext({
    ...presentation, html: presentation.escapeHtml, metadata: { version: '0.1.2' }, backgrounds: [{ id: 'sunglasses', label: '海风', image: '/sunglasses.webp' }, { id: 'beach', label: '海滩', image: '/beach.webp' }],
    document, localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) }, isTauri: () => desktop,
    listen: async (name, callback) => { events.set(`tauri:${name}`, callback); return () => {}; }, invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'choose_game_directory') return '/新资源';
      if (command === 'start_game') urls = [...urls, `http://127.0.0.1:${61000 + urls.length}/`];
      if (command === 'stop_game') urls = [];
      if (command === 'remote_configuration') { if (remoteFailure) throw new Error('failed request'); return remote; }
      return status();
    },
    setInterval: (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; },
  });
  vm.runInContext(source, context);
  await tick();
  return { calls, app, values, events, intervals, setRemote(value) { remote = value; remoteFailure = false; }, failRemote() { remoteFailure = true; }, async click(id, dataset = {}) { const button = { id, dataset, disabled: false }; await events.get('app:click')({ target: { closest: () => button } }); } };
}

test('实际启动界面仅通过后端读取远程配置，并从目录选择完成校验、启动、多开和停止', async () => {
  const ui = await launcher();
  assert.equal(ui.calls.find((call) => call.command === 'remote_configuration').args.forceRefresh, false);
  assert.match(ui.app.innerHTML, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  await ui.click('choose');
  await ui.click('launch');
  assert.deepEqual(ui.calls.filter((call) => ['prepare_game', 'start_game', 'open_game'].includes(call.command)).map((call) => [call.command, JSON.stringify(call.args)]), [
    ['prepare_game', '{"selected":"/新资源"}'], ['start_game', '{"additional":false}'], ['open_game', '{"index":0}'],
  ]);
  await ui.click('additional');
  assert.equal(ui.calls.at(-1).args.index, 1);
  assert.match(ui.app.innerHTML, /2 个客户端已启动/);
  await ui.click('stop');
  assert.match(ui.app.innerHTML, /游戏服务已停止/);
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
  await ui.click('update-download');
  assert.equal(ui.calls.at(-1).command, 'open_update_download');
  assert.equal(ui.calls.at(-1).args, undefined);
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

test('超过四个客户端时分页保留全局编号，最后一页打开正确客户端', async () => {
  const ui = await launcher();
  await ui.click('launch');
  for (let count = 1; count < 5; count++) await ui.click('additional');
  const clientIndices = () => [...ui.app.innerHTML.matchAll(/data-open="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(clientIndices(), [0, 1, 2, 3]);
  await ui.click('clients-next');
  assert.deepEqual(clientIndices(), [4]);
  assert.match(ui.app.innerHTML, /客户端 5<code>http:\/\/127\.0\.0\.1:61004\//);
  const before = ui.calls.length;
  await ui.click('', { open: '4' });
  assert.deepEqual(ui.calls.slice(before).map((call) => [call.command, JSON.stringify(call.args)]), [['open_game', '{"index":4}']]);
  await ui.click('clients-next');
  assert.deepEqual(clientIndices(), [0, 1, 2, 3]);
});
