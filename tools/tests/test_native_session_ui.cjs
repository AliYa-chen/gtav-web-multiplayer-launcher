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
function harness() {
  const memory = { buffer: new ArrayBuffer(8192) }, calls = [], methods = [];
  let open = true, ready = true, begins = true, parameterFailure = false, current;
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
    mpScaleformString(pointer) { assert.equal(typeof pointer, 'bigint'); if (parameterFailure) throw Error('not ready');
      assert.ok(current); current.parameters.push(read(pointer)); },
    mpScaleformBool(value) { assert.equal(typeof value, 'number'); assert.ok(current); current.parameters.push(Boolean(value)); },
    mpEndScaleform() { assert.ok(current); methods.push(current); current = null; calls.push(['end']); },
  };
  const self = {}, context = vm.createContext({ self, TextEncoder, Uint8Array, BigInt });
  vm.runInContext(source, context);
  const ui = self.createNativeSessionUI({ ex, memory });
  return { ui, calls, methods, memory, ex, factory: self.createNativeSessionUI,
    setOpen: value => { open = value; }, setReady: value => { ready = value; },
    setBegin: value => { begins = value; }, setParameterFailure: value => { parameterFailure = value; } };
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
  assert.equal(new Uint8Array(h.memory.buffer)[256 + 1280], 0xa5);
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
