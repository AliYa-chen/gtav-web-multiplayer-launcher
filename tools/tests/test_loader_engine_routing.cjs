#!/usr/bin/env node
'use strict';
// 执行真实加载器，验证流式编译失败回落与 locateFile 均不会访问旧游戏 WASM URL。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../client/loader.js'), 'utf8');

async function load(multiplayer) {
  const workers = [], imported = [], requested = [], progress = [];
  const self = { location: { origin: 'http://localhost:8000' }, prepareMultiplayerBridge: () => () => {} };
  class Worker {
    constructor(url) { this.url = url; workers.push(this); }
    postMessage() {}
  }
  class BroadcastChannel { postMessage(value) { progress.push(value); } }
  const context = vm.createContext({ self, Worker, BroadcastChannel, URLSearchParams, Uint8Array, navigator: { language: 'en-US' },
    console: { log() {}, warn() {}, error() {} }, setTimeout, importScripts: (...urls) => imported.push(...urls),
    fetch: async (url) => {
      requested.push(url);
      return new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { headers: { 'Content-Length': '8' } });
    },
    WebAssembly: {
      instantiateStreaming: async () => { throw new Error('受控流式编译失败'); },
      instantiate: async () => ({ instance: { exports: {} }, module: {} }),
    },
  });
  vm.runInContext(source, context, { filename: 'loader.js' });
  self.onmessage({ data: { multiplayer, base: '/b/8b0b5899ed', args: [] } });
  workers.forEach((worker) => worker.onmessage({ data: { loaded: true } }));
  await new Promise((resolve) => self.Module.instantiateWasm({ env: {} }, resolve));
  return { self, imported, requested, progress };
}

for (const online of [false, true]) test((online ? '在线' : '离线') + '流式及缓冲回落只加载client运行副本，locateFile不回退旧引擎', async () => {
  const h = await load(online);
  const expected = online ? '/engine/online/game.wasm?v=public-radar-12' : '/engine/offline/game.wasm';
  assert.deepEqual(h.requested, [expected, expected]);
  assert.equal(h.self.Module.locateFile('game.wasm'), expected);
  assert.equal(h.self.Module.locateFile('audio-worklet.js'), '/b/8b0b5899ed/audio-worklet.js');
  assert.equal(h.imported.includes('/multiplayer/native-session-ui.js'), online);
  assert.ok(h.imported.includes('/b/8b0b5899ed/game.js'));
  assert.ok(h.progress.some((value) => value.pct === 22));
});
