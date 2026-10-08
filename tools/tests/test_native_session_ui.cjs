#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../client/multiplayer/native-session-ui.js'), 'utf8');
const summary = (changes = {}) => ({ online: true, name: '玩家一', player_count: 2, connected: true,
  phase: 'active', game_mode: 'public_freeroam', ...changes });
class BrowserTextDecoder extends TextDecoder {
  decode(value, options) {
    if (value?.buffer instanceof SharedArrayBuffer) throw new TypeError('浏览器拒绝共享内存视图');
    return super.decode(value, options);
  }
}
function harness(shared = false) {
  const memory = { buffer: shared ? new SharedArrayBuffer(8192) : new ArrayBuffer(8192) }, calls = [], methods = [];
  let open = true, ready = true, begins = true, contentBegins = true, parameterFailure = false, current;
  let panel = 'MENU_UNIQUE_ID_MAP', panelPointer = 4096n, panelId = 0;
  const read = pointer => {
    const bytes = new Uint8Array(memory.buffer), start = Number(pointer);
    let end = start; while (bytes[end]) end++;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
  };
  const ex = {
    mpAlloc(size) { calls.push(['alloc', size]); return 256n; },
    mpFree(pointer) { calls.push(['free', pointer]); },
    mpPauseMenuActive() { calls.push(['pause']); return open ? 1 : 0; },
    mpFrontendReady() { calls.push(['ready']); return ready ? 1 : 0; },
    mpBeginPauseHeader(pointer) { calls.push(['begin', read(pointer)]); if (!begins) return 0;
      current = { method: read(pointer), parameters: [] }; return 1; },
    mpGetPausePanel(pointer) { calls.push(['panel']); new DataView(memory.buffer).setInt32(Number(pointer), panelId, true); },
    mpPausePanelName(pointer) {
      assert.ok(pointer >= 256n && pointer < 256n + 2720n);
      const start = Number(panelPointer);
      if (start > 0 && start < memory.buffer.byteLength) {
        const bytes = new Uint8Array(memory.buffer); bytes.fill(0, start, Math.min(start + 128, bytes.length));
        bytes.set(new TextEncoder().encode(panel), start);
      }
      return panelPointer;
    },
    mpBeginPauseContent(pointer) { calls.push(['content_begin', read(pointer)]); if (!contentBegins) return 0;
      current = { method: read(pointer), parameters: [] }; return 1; },
    mpScaleformString(pointer) { assert.equal(typeof pointer, 'bigint'); if (parameterFailure) throw Error('not ready');
      assert.ok(current); current.parameters.push(read(pointer)); },
    mpScaleformBool(value) { assert.equal(typeof value, 'number'); assert.ok(current); current.parameters.push(Boolean(value)); },
    mpScaleformInt(value) { assert.equal(typeof value, 'number'); assert.ok(current); current.parameters.push(value); },
    mpEndScaleform() { assert.ok(current); methods.push(current); current = null; calls.push(['end']); },
  };
  const self = {}, context = vm.createContext({ self, TextEncoder, TextDecoder: BrowserTextDecoder, Uint8Array, BigInt });
  vm.runInContext(source, context);
  const ui = self.createNativeSessionUI({ ex, memory });
  return { ui, calls, methods, memory, ex, factory: self.createNativeSessionUI,
    setOpen: value => { open = value; }, setReady: value => { ready = value; },
    setBegin: value => { begins = value; }, setParameterFailure: value => { parameterFailure = value; },
    setPanel: value => { panel = value; }, setPanelPointer: value => { panelPointer = value; },
    setPanelId: value => { panelId = value; }, setContentBegin: value => { contentBegins = value; } };
}

test('只在显式公共在线身份且原暂停菜单就绪时调用，原生参数顺序与已核对ABI一致', () => {
  const h = harness();
  assert.equal(h.ui.tick(0, summary({ online: false })).reason, 'inactive');
  assert.equal(h.ui.tick(0, summary({ online: undefined })).reason, 'inactive');
  assert.equal(h.calls.length, 0);
  h.setOpen(false); assert.equal(h.ui.tick(0, summary()).reason, 'menu_closed');
  h.setOpen(true); h.setReady(false); assert.equal(h.ui.tick(20, summary()).reason, 'menu_closed');
  assert.equal(h.calls.filter(call => call[0] === 'alloc').length, 0);
  h.setReady(true); assert.equal(h.ui.tick(40, summary()).applied, true);
  assert.deepEqual(h.methods, [
    { method: 'SET_HEADER_TITLE', parameters: ['GTA V · 公共在線戰局'] },
    { method: 'SET_HEADING_DETAILS', parameters: ['玩家一', '在線玩家：2', '已連接公共戰局', false, '公共戰局 · GTA V 自由模式'] },
  ]);
});

test('菜单打开立即更新，状态变化限频，原菜单重建后低频恢复，重新打开无需等待', () => {
  const h = harness(); h.ui.tick(0, summary());
  assert.equal(h.ui.tick(40, summary({ connected: false, phase: 'reconnecting' })).reason, 'throttled');
  assert.equal(h.ui.tick(250, summary({ connected: false, phase: 'reconnecting' })).applied, true);
  assert.equal(h.methods[3].parameters[2], '正在重新連線');
  assert.equal(h.ui.tick(900, summary({ connected: false, phase: 'reconnecting' })).reason, 'throttled');
  assert.equal(h.ui.tick(1000, summary({ connected: false, phase: 'reconnecting' })).applied, true);
  h.setOpen(false); h.ui.tick(1010, summary());
  h.setOpen(true); assert.equal(h.ui.tick(1020, summary()).applied, true);
  assert.equal(h.calls.filter(call => call[0] === 'alloc').length, 1);
});

test('昵称过滤游戏格式、HTML及控制符，UTF8独立槽不会越界或截断多字节字符', () => {
  const h = harness(); new Uint8Array(h.memory.buffer).fill(0xa5);
  h.ui.tick(0, summary({ name: '~r~<b>甲&乙</b>\u0000\u001b\u202e' + '😀'.repeat(1000), player_count: -3 }));
  const name = h.methods[1].parameters[0];
  assert.ok(!/[~<>&\u0000-\u001f\u202e]/.test(name));
  assert.equal(Array.from(name).length, 32);
  assert.equal(h.methods[1].parameters[1], '在線玩家：0');
  assert.equal(new Uint8Array(h.memory.buffer)[255], 0xa5);
  assert.equal(new Uint8Array(h.memory.buffer)[256 + 2720], 0xa5);
});

test('Begin失败不能添加参数或End，失败后可重试而不停止世界调用', () => {
  const h = harness(); h.setBegin(false);
  assert.equal(h.ui.tick(0, summary()).reason, 'header_pending');
  assert.equal(h.methods.length, 0);
  assert.equal(h.calls.filter(call => call[0] === 'end').length, 0);
  h.setBegin(true); assert.equal(h.ui.tick(250, summary()).applied, true);
  h.setParameterFailure(true);
  assert.equal(h.ui.tick(1000, summary()).reason, 'native_failure');
  assert.equal(h.calls.filter(call => call[0] === 'end').length, 3);
  h.setParameterFailure(false); assert.equal(h.ui.tick(1250, summary()).applied, true);
});

test('内存增长后重取视图，重置重用缓冲，释放只执行一次', () => {
  const h = harness(); h.ui.tick(0, summary());
  h.memory.buffer = new ArrayBuffer(16384);
  h.ui.reset(); assert.equal(h.ui.tick(1, summary()).applied, true);
  assert.equal(h.methods[3].parameters[0], '玩家一');
  assert.equal(h.calls.filter(call => call[0] === 'alloc').length, 1);
  h.ui.dispose(); h.ui.dispose();
  assert.equal(h.calls.filter(call => call[0] === 'free').length, 1);
  assert.equal(h.ui.tick(2, summary()).reason, 'disposed');
});

test('缺少导出或无效分配时静默拒绝，未访问任何原会话flag或菜单激活API', () => {
  const h = harness(); delete h.ex.mpScaleformBool;
  const missing = h.factory({ ex: h.ex, memory: h.memory });
  assert.equal(missing.tick(0, summary()).reason, 'unsupported');
  assert.equal(h.calls.length, 0);
  const bad = harness(); bad.ex.mpAlloc = () => 8000n;
  assert.equal(bad.ui.tick(0, summary()).reason, 'allocation_failed');
  assert.equal(bad.methods.length, 0);
  assert.ok(!/ex\.(?:mpNetwork|mpActivate|mpPauseMenuContext)/.test(source));
});

test('只对真实线上脚本pane写正文，动态远程标题及连接人数沿原SHOW_WARNING_MESSAGE参数渲染', () => {
  const h = harness(); h.setPanel('MENU_UNIQUE_ID_MISSION_CREATOR');
  const result = h.ui.tick(0, summary({ remote_config: { oltitle: 'https://status.example.test' } }));
  assert.equal(result.content_applied, true);
  assert.equal(result.panel, 'MENU_UNIQUE_ID_MISSION_CREATOR');
  assert.deepEqual(h.methods[2], { method: 'SHOW_WARNING_MESSAGE', parameters: [true, 0, 3, 'GTA 線上模式',
    '線上模式伺服器狀態：https://status.example.test\n已連接公共戰局 · 在線玩家：2\n公共戰局 · GTA V 自由模式',
    430, '', '', 0, '', false] });
  h.ui.tick(250, summary({ connected: false, phase: 'reconnecting', player_count: 1,
    remote_config: { oltitle: 'https://gtav.2t.hk' } }));
  assert.match(h.methods[5].parameters[4], /https:\/\/gtav\.2t\.hk\n正在重新連線 · 在線玩家：1/);
});

test('其他原生面板及无效pane返回值不被覆盖，切换至线上页立即渲染', () => {
  const h = harness();
  for (const [now, panel] of [[0, 'MENU_UNIQUE_ID_MAP'], [1, 'MENU_UNIQUE_ID_SETTINGS'],
    [2, 'MENU_UNIQUE_ID_GAME_MP'], [3, 'MENU_UNIQUE_ID_HEADER_MY_MP']]) {
    h.setPanel(panel); assert.equal(h.ui.tick(now, summary()).content_applied, false);
  }
  assert.equal(h.calls.filter(call => call[0] === 'content_begin').length, 0);
  h.setPanel('MENU_UNIQUE_ID_MISSION_CREATOR');
  assert.equal(h.ui.tick(4, summary()).content_applied, true);
  h.setPanelId(-1); assert.equal(h.ui.tick(5, summary()).content_applied, false);
  h.setPanelId(42); h.setPanelPointer(999999n); assert.equal(h.ui.tick(6, summary()).content_applied, false);
});

test('不合法远程标题使用默认地址，原生内容Begin未就绪不Add/End且header仍可用', () => {
  const h = harness(); h.setPanel('MENU_UNIQUE_ID_MISSION_CREATOR');
  for (const [now, oltitle] of [[0, 'javascript:alert(1)'], [750, 'https://x.test/~r~'],
    [1500, 'https://x.test/<b>'], [2250, 'https://x.test/\u202e']]) {
    h.ui.tick(now, summary({ remote_config: { oltitle } }));
    assert.match(h.methods.at(-1).parameters[4], /^線上模式伺服器狀態：https:\/\/gtav\.2t\.hk\n/);
  }
  const before = h.methods.length;
  h.setContentBegin(false); const result = h.ui.tick(3000, summary());
  assert.equal(result.applied, true); assert.equal(result.content_applied, false);
  assert.equal(h.methods.length, before + 2);
  delete h.ex.mpGetPausePanel;
  const old = h.factory({ ex: h.ex, memory: h.memory });
  assert.equal(old.tick(0, summary()).applied, true);
});
test('浏览器共享内存中的真实pane名字先复制再解码，正文保持可用', () => {
  const h = harness(true); h.setPanel('MENU_UNIQUE_ID_MISSION_CREATOR');
  assert.equal(h.ui.tick(0, summary()).content_applied, true);
  assert.equal(h.methods.at(-1).parameters[4].split('\n')[0], '線上模式伺服器狀態：https://gtav.2t.hk');
});
