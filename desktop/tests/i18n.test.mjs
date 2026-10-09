import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator, dictionaries, normalizeLanguageConfig, resolveLanguage, translateMessage, message } from '../src/i18n.js';
import { displayDirectory, remotePresentation, lanRequest } from '../src/view-state.js';

test('system language follows the first OS language and explicit choices override it', () => {
  assert.equal(resolveLanguage('system', ['zh-TW', 'en-US']), 'zh-CN');
  assert.equal(resolveLanguage('system', ['en-GB', 'zh-CN']), 'en');
  assert.equal(resolveLanguage('system', ['fr-FR']), 'en');
  assert.equal(resolveLanguage('en', ['zh-CN']), 'en');
  assert.equal(resolveLanguage('zh-CN', ['en-US']), 'zh-CN');
  assert.deepEqual(normalizeLanguageConfig({ preference: 'system', resolved: 'en', revision: 8 }, ['zh-CN']), { preference: 'system', resolved: 'en', revision: 8 });
  assert.deepEqual(normalizeLanguageConfig({ preference: 'invalid', resolved: 'other', revision: -4 }, ['zh-CN']), { preference: 'system', resolved: 'zh-CN', revision: 0 });
});

test('both locales contain complete matching keys and interpolation fields', () => {
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries['zh-CN']).sort());
  for (const key of Object.keys(dictionaries.en)) {
    assert.ok(dictionaries.en[key] && dictionaries['zh-CN'][key], key);
    const fields = (value) => [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((item) => item[1]).sort();
    assert.deepEqual(fields(dictionaries.en[key]), fields(dictionaries['zh-CN'][key]), key);
  }
});

test('completed messages and native diagnostics translate without changing paths or markup', () => {
  assert.equal(translateMessage(message('message.caSaved', { path: '/Users/中文/<game>/ca.crt' }), 'en'), 'CA certificate saved: /Users/中文/<game>/ca.crt. Install and trust it using your system’s instructions. The LAN HTTP guide includes browser setup steps.');
  assert.equal(translateMessage('识别资源目录并校验引擎版本…', 'en'), 'Detecting the resources folder and verifying the engine version…');
  assert.equal(translateMessage('最多同时开启 8 个客户端。', 'en'), 'Up to 8 clients can run at the same time.');
  assert.equal(translateMessage('无法打开所选目录：permission denied: /游戏', 'en'), 'Unable to open the selected folder: permission denied: /游戏');
  assert.equal(translateMessage('unknown diagnostic <img>', 'en'), 'unknown diagnostic <img>');
  assert.equal(createTranslator('en')('clients.stopLabel', { number: 3 }), 'Stop the game and sharing service for client 3');
});

test('English directory, port validation and remote presentation use the selected language', () => {
  assert.equal(displayDirectory('', 'en'), 'No game resources folder selected');
  assert.throws(() => lanRequest({ port: 8443, httpPort: 8443 }, 'en'), /must be different/);
  const config = { latest_version: '0.2.12', server: [{ name: '公共战局', role: '主线路', address: 'example.com:1234' }],
    announcements: [{ body: '<b>原文公告</b>' }], release_notes: '原文说明',
    i18n: { en: { announcements: [{ title: 'Welcome', body: '<b>Shared world</b>' }], release_notes: 'Language support' } } };
  const view = remotePresentation({ source: 'remote', config }, '0.2.11', '', 'en');
  assert.equal(view.versionText, 'New version 0.2.12');
  assert.equal(view.sourceText, 'Updated');
  assert.equal(view.servers[0].name, 'Public session');
  assert.equal(view.servers[0].role, 'Main route');
  assert.equal(view.announcements[0].body, '<b>Shared world</b>');
  assert.equal(view.releaseNotes, 'Language support');
  assert.equal(remotePresentation({ source: 'remote', config: { announcements: [{ body: '自由公告' }] } }, '0.2.11', '', 'en').announcements[0].body, '自由公告');
});
