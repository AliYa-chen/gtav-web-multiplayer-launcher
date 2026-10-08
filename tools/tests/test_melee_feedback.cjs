#!/usr/bin/env node
'use strict';
// 运行实际页面桥，验证服务器确认的拳击结果进入原生通知队列，不加载游戏资源。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.resolve(__dirname, '../../client/multiplayer/game-adapter.js'), 'utf8');

function page(id) {
  const timers = new Map(); let timerId = 0, receive;
  const memory = { buffer: new SharedArrayBuffer(32768) }, block = 256, capacity = 16384;
  const hud = { style: {}, textContent: '' };
  const context = vm.createContext({ BroadcastChannel: class { close() {} },
    TextEncoder, TextDecoder, SharedArrayBuffer, Int32Array, Uint8Array, Atomics,
    performance: { now: () => 1000 }, document: { getElementById: () => hud }, addEventListener() {},
    fetch: () => Promise.resolve({ ok: true }),
    setTimeout: (callback) => { const key = ++timerId; timers.set(key, callback); return key; },
    clearTimeout: (key) => timers.delete(key) });
  vm.runInContext(source.replace('export function installGameAdapter', 'function installGameAdapter')
    + '\nglobalThis.install = installGameAdapter;', context);
  const api = context.install({}, { setReceiver: (callback) => { receive = callback; }, onWorkerMessage() {} });
  api.onWorkerMessage({ multiplayer: { type: 'memory', memory, block, capacity } });
  receive({ type: 'session', connected: true, client_id: id, members: [{ id: 'A' }, { id: 'B' }] });
  receive({ type: 'world_state_v2', world_epoch: 'WORLD', ready: true, entities: [
    { entity_id: 'ped:A', player_id: 'A', generation: 1 }, { entity_id: 'ped:B', player_id: 'B', generation: 1 },
  ] });
  const packet = () => {
    const jobs = [...timers.values()]; timers.clear(); for (const callback of jobs) callback();
    const header = new Int32Array(memory.buffer, block, 4);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, block + 16, Atomics.load(header, 1))));
  };
  return { receive: (value) => receive(value), packet, api, hud };
}
const hit = (changes = {}) => ({ type: 'melee_event', world_epoch: 'WORLD', event_id: 'MELEE:1',
  attacker_id: 'A', attacker_entity_id: 'ped:A', attacker_generation: 1,
  target_entity_id: 'ped:B', target_generation: 1, accepted: true, hit: true, damage: 20, health: 180, ...changes });

test('拳击命中和受伤分别进入两端原生通知，数值来自服务器事件', () => {
  const attacker = page('A'), victim = page('B');
  attacker.receive(hit()); victim.receive(hit());
  assert.ok(attacker.packet().notices.some((value) => value.text === '拳擊命中 · 傷害 20'));
  assert.ok(victim.packet().notices.some((value) => value.text === '受到拳擊 · 傷害 20 · 生命 180/200'));
  assert.equal(victim.hud.textContent, '受到拳击 · 生命 180/200');
  victim.api.onWorkerMessage({ multiplayer: { type: 'native_hud', available: true } });
  assert.equal(victim.hud.textContent, '', '原生通知可用时隐藏页面文字');
});

test('重复命中、未命中、旧世界和旧目标代次不能伪造受伤通知', () => {
  const victim = page('B'); victim.receive(hit()); victim.receive(hit());
  const count = victim.packet().notices.length;
  victim.receive(hit({ event_id: 'MISS', hit: false, damage: 0, health: null, target_entity_id: null, target_generation: null }));
  victim.receive(hit({ event_id: 'OLD_WORLD', world_epoch: 'PREVIOUS' }));
  victim.receive(hit({ event_id: 'OLD_GENERATION', target_generation: 2 }));
  assert.equal(victim.packet().notices.length, count);
});

test('服务器确认拳击致死，提示等待服务器重生', () => {
  const victim = page('B'); victim.receive(hit({ health: 0 }));
  assert.ok(victim.packet().notices.some((value) => value.text === '拳擊致死，等待伺服器重生'));
});
