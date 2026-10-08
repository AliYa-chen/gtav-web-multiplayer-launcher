import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, canLaunch, progressValue, displayDirectory, readBackground, saveBackground, backgroundPreferenceKey, remotePresentation, launcherActions, isNewerVersion } from '../src/view-state.js';
test('用户目录内容只作为文字显示，不能注入HTML', () => { assert.equal(escapeHtml('D:/<script>&"\''), 'D:/&lt;script&gt;&amp;&quot;&#39;'); });
test('选目录且桌面后端可用才允许启动，准备期间禁止重入', () => {
  assert.equal(canLaunch({ selected: '/游戏', desktop: true, busy: false }), true);
  for (const field of [{ selected: '' }, { desktop: false }, { busy: true }]) assert.equal(canLaunch({ selected: '/游戏', desktop: true, busy: false, ...field }), false);
});
test('进度阶段按后端步骤呈现，未知阶段不伪造完成', () => { assert.equal(progressValue('ready'), 100); assert.equal(progressValue('unknown'), 0); assert.equal(displayDirectory(''), '尚未选择游戏资源目录'); });
test('背景选择跨启动保留，旧值与被禁用的存储回退到明亮背景', () => {
  const entries = new Map(), allowed = ['sunglasses', 'beach'];
  const storage = { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  assert.equal(readBackground(storage, allowed), 'sunglasses');
  assert.equal(saveBackground(storage, 'beach', allowed), true);
  assert.equal(readBackground(storage, allowed), 'beach');
  assert.equal(saveBackground(storage, 'file:///private.png', allowed), false);
  assert.equal(readBackground(storage, allowed), 'beach');
  entries.set(backgroundPreferenceKey, 'retired');
  assert.equal(readBackground(storage, allowed), 'sunglasses');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readBackground(blocked, allowed), 'sunglasses');
  assert.equal(saveBackground(blocked, 'beach', allowed), false);
});
test('仅 oltitle 的现有配置不伪造更新或公告，预览缺失配置也可显示', () => {
  const remote = remotePresentation({ config: { oltitle: 'https://gtav.2t.hk' }, source: 'remote' }, '0.1.2', 'macos_arm64');
  assert.equal(remote.title, 'https://gtav.2t.hk');
  assert.equal(remote.websiteAvailable, true);
  assert.equal(remote.versionText, '暂无版本信息');
  assert.equal(remote.downloadAvailable, false);
  assert.deepEqual(remote.announcements, []);
  assert.equal(remotePresentation(null, '0.1.2').versionText, '暂无版本信息');
});
test('更新仅向本机平台提供可用下载，断网仍呈现缓存公告，内容作为文字转义', () => {
  const config = { latest_version: '0.2.0', announcements: [{ title: '<img onerror="bad">', body: '<script>bad</script>', date: '2026-10-08' }], downloads: { windows_x64: { url: 'https://oss.2t.hk/new.exe', sha256: 'a'.repeat(64) } } };
  const mac = remotePresentation({ config, source: 'cache', stale: true }, '0.1.2', 'macos_arm64');
  assert.equal(mac.versionText, '新版本 0.2.0');
  assert.equal(mac.downloadAvailable, false);
  assert.equal(mac.sourceText, '离线缓存');
  assert.equal(escapeHtml(mac.announcements[0].body), '&lt;script&gt;bad&lt;/script&gt;');
  const windows = remotePresentation({ config, source: 'remote' }, '0.1.2', 'windows_x64');
  assert.equal(windows.downloadAvailable, true);
  assert.equal(remotePresentation({ config }, '0.2.0', 'windows_x64').downloadAvailable, false);
  delete config.downloads.windows_x64.sha256;
  assert.equal(remotePresentation({ config }, '0.1.2', 'windows_x64').downloadAvailable, false);
});
test('版本比较区分数字、正式版本与预发行版本，无效版本不会启动下载', () => {
  assert.equal(isNewerVersion('0.10.0', '0.9.1'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0-rc.9'), true);
  assert.equal(isNewerVersion('1.0.0-rc.10', '1.0.0-rc.9'), true);
  assert.equal(isNewerVersion('1.0.0-beta', '1.0.0'), false);
  assert.equal(isNewerVersion('1.1.0+build.3', '1.0.0+build.9'), true);
  assert.equal(isNewerVersion('1.0.0+build.3', '1.0.0+build.9'), false);
  assert.equal(isNewerVersion('hello', '0.1.2'), false);
});
test('运行中仅禁止更换目录，准备中禁用启动操作但不阻止背景或远程信息', () => {
  const current = { selected: '/资源包', desktop: true, busy: false, urls: ['http://127.0.0.1:61120/'] };
  assert.deepEqual(launcherActions(current), { choose: false, launch: true, additional: true, stop: true, refresh: true });
  assert.deepEqual(launcherActions({ ...current, busy: true }, true), { choose: false, launch: false, additional: false, stop: false, refresh: false });
  assert.deepEqual(launcherActions({ ...current, desktop: false }), { choose: false, launch: false, additional: false, stop: false, refresh: false });
});
