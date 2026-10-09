'use strict';
// Real Java server + real network/shared-memory adapters; only native shape test is controlled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const importText = text => import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await delay(10); }
  assert.fail(message);
}

test('real latest JAR accepts negotiated native collision result through both client layers', { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gta-collision-integration-'));
  const jar = process.env.GTA_TEST_JAR || path.join(directory, 'server.jar');
  let server, api, victim, nativeTimer;
  const cleanup = [];
  try {
    if (!process.env.GTA_TEST_JAR) execFileSync(process.env.PYTHON || 'python3', ['-B', 'tools/build_multiplayer_server.py', '--output', jar], { cwd: root });
    server = spawn(process.env.JAVA || 'java', ['-jar', jar, '--host', '127.0.0.1', '--port', '0', '--world-data', 'none'], { cwd: root });
    let output = ''; server.stdout.on('data', bytes => { output += bytes; }); server.stderr.on('data', bytes => { output += bytes; });
    const port = await until(() => /http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1], 'Java server failed to start: ' + output);
    const address = `http://127.0.0.1:${port}`;
    const appearanceSource = read('client/multiplayer/appearance.js');
    const appearanceUrl = 'data:text/javascript;base64,' + Buffer.from(appearanceSource).toString('base64');
    const [addressModule, appearanceModule, worldModule] = await Promise.all([
      importText(read('client/multiplayer/server-address.js')),
      importText(appearanceSource),
      importText(read('client/multiplayer/world-state.js').replace("'./appearance.js'", JSON.stringify(appearanceUrl))),
    ]);
    const sessionSource = read('client/multiplayer/public-session.js').replace(/^import .*$/gm, '')
      .replace('export async function startPublicSession', 'async function startPublicSession');
    const realSetTimeout = (callback, timeout) => { const id = setTimeout(callback, timeout); cleanup.push(() => clearTimeout(id)); return id; };
    const messages = [], wireSent = [];
    class CapturedSocket extends WebSocket {
      send(value) { wireSent.push(JSON.parse(value)); return super.send(value); }
    }
    const context = vm.createContext({ ...addressModule, ...appearanceModule, ...worldModule,
      WebSocket: CapturedSocket, location: { href: address + '/play/' }, performance,
      navigator: {}, document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      setTimeout: realSetTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
      fetch: () => Promise.resolve({ ok: true }) });
    vm.runInContext(sessionSource + '\nglobalThis.start = startPublicSession;', context);
    api = await context.start({ server: `127.0.0.1:${port}`, name: 'physics-integration', preset: 'npc_male', seed: 73 });
    api.setReceiver(message => messages.push(message));
    await api.ready;
    assert.ok(wireSent.find(message => message.type === 'hello').capabilities.includes('physics_queries'));
    const session = messages.findLast(message => message.type === 'session');
    assert.ok(session.weapon_rules.length >= 91);
    const latestWorld = () => messages.findLast(message => message.type === 'world_state_v2' && message.ready);
    assert.ok(latestWorld());
    victim = await context.start({ server: `127.0.0.1:${port}`, name: 'physics-victim', preset: 'npc_male', seed: 73 });
    const victimMessages=[];victim.setReceiver(value=>victimMessages.push(value));await victim.ready;
    const victimSession=victimMessages.findLast(value=>value.type==='session');
    const victimPosition=[session.spawn[0]+10,session.spawn[1],session.spawn[2]];
    victim.onWorkerMessage({type:'local_state',state:{position:victimPosition,heading:270,model:victimSession.model,
      health:200,weapon:0x1b06d571,shooting:false}});
    const memory = { buffer: new SharedArrayBuffer(1024 * 1024) }, block = 256, capacity = 512 * 1024;
    const hud = { style: {}, textContent: '' }, adapterEvents = [];
    const adapterContext = vm.createContext({ Atomics, Int32Array, Uint8Array, DataView, TextEncoder, TextDecoder,
      performance, BroadcastChannel: class { close() {} }, document: { getElementById: () => hud },
      addEventListener() {}, setTimeout: realSetTimeout, clearTimeout, fetch: () => Promise.resolve({ ok: true }) });
    vm.runInContext(read('client/multiplayer/game-adapter.js').replace('export function installGameAdapter', 'function installGameAdapter')
      + '\nglobalThis.install = installGameAdapter;', adapterContext);
    const network = { setReceiver(receiver) { api.setReceiver(message => { messages.push(message); receiver(message); }); },
      onWorkerMessage(message) { adapterEvents.push(message); api.onWorkerMessage(message); } };
    const adapter = adapterContext.install({}, network);
    adapter.onWorkerMessage({ multiplayer: { type: 'memory', memory, block, capacity } });
    let shapeCalls = 0, next = 0, wallHit = true, transparentFence = true;
    const shapes = new Map();
    const dv = () => new DataView(memory.buffer);
    const readScr = p => [0, 8, 16].map(offset => dv().getFloat32(Number(p) + offset, true));
    const position = [...session.spawn];
    const start = (from, to) => { shapeCalls++; shapes.set(++next, { from: readScr(from), to: readScr(to), pending: true }); return next; };
    const ex = { mpAlloc: () => 800000n, mpGetEntityCoords: p => position.forEach((n, i) => dv().setFloat32(Number(p) + i * 8, n, true)),
      mpCollisionLoadedAroundEntity: () => 1, mpWaitingForWorldCollision: () => 0,
      mpStartShapeTestLOS: start, mpStartShapeTestSweptSphere: start,
      mpShapeTestResultMaterial(handle, hit, at, normal, material) {
        const shape = shapes.get(handle); assert.ok(shape);
        if (shape.pending) { shape.pending = false; return 1; }
        shapes.delete(handle); dv().setInt32(Number(hit), wallHit ? 1 : 0, true);
        const delta = shape.to.map((n, i) => n - shape.from[i]), length = Math.hypot(...delta);
        shape.from.map((n, i) => n + delta[i] * .5).forEach((n, i) => dv().setFloat32(Number(at) + i * 4, n, true));
        delta.map(n => -n / length).forEach((n, i) => dv().setFloat32(Number(normal) + i * 4, n, true));
        // First ray reaches SHOOT_THRU chainlink; server must issue another ticket to find the wall behind it.
        dv().setUint32(Number(material), wallHit && transparentFence ? 762193613 : 0, true);
        if(wallHit)transparentFence=false;return 2;
      } };
    const nativeContext = vm.createContext({ self: {}, DataView, Uint8Array, BigInt });
    vm.runInContext(read('client/multiplayer/world-collision.js'), nativeContext);
    const native = nativeContext.self.createWorldCollisionBridge({ ex, memory,
      post: message => adapter.onWorkerMessage({ multiplayer: message }) });
    let sharedPacket;
    nativeTimer = setInterval(() => {
      const size = Atomics.load(new Int32Array(memory.buffer, block, 4), 1);
      if (size) { sharedPacket=JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, block + 16, size)));
        native.tick(sharedPacket, performance.now(), 7); }
    }, 10);
    const state = { position, heading: 90, model: session.model, health: 200, weapon: 0x1b06d571, shooting: false };
    api.onWorkerMessage({ type: 'local_state', state });
    await delay(80);
    api.onWorkerMessage({ type: 'local_shot', state, event: { weapon: state.weapon,
      origin: [position[0], position[1], position[2] + 1], target: [position[0] + 30, position[1], position[2] + 1] } });
    try { await until(() => adapterEvents.some(message => message.type === 'collision_result' && message.complete),
      'No native collision result reached network adapter'); }
    catch (error) { throw new Error(error.message + JSON.stringify({ shapeCalls, nativeSupported:native.supported,
      sharedPacket:sharedPacket&&{connected:sharedPacket.connected,client_id:sharedPacket.client_id,world:sharedPacket.world&&{ready:sharedPacket.world.ready,world_epoch:sharedPacket.world.world_epoch},queries:sharedPacket.collision_queries},sent: wireSent.map(value=>value.type),
      events: adapterEvents, received: messages.filter(value => ['collision_query','combat_feedback','network_status'].includes(value.type)),
      health: await (await fetch(address + '/health')).json() })); }
    const health = await until(async () => {
      const value = await (await fetch(address + '/health')).json();
      return value.collision.completed_queries > 0 ? value : false;
    }, 'Server rejected collision result: ' + JSON.stringify(wireSent.filter(message => message.type === 'collision_result')));
    assert.match(health.server_version, /^0\.4\.1/);
    assert.equal(health.collision.rejected_queries, 0);
    assert.ok(shapeCalls >= 2);assert.ok(wireSent.filter(message => message.type === 'collision_result' && message.complete).length >= 2);
    await delay(100);
    assert.equal(victimMessages.filter(message=>message.type==='damage'&&message.victim_id===victimSession.client_id).length,0,
      'wall collision must block the server damage result');
    wallHit=false;
    await delay(150);
    api.onWorkerMessage({type:'local_shot',state,event:{weapon:state.weapon,
      origin:[position[0],position[1],position[2]+1],target:[position[0]+30,position[1],position[2]+1]}});
    const hit=await until(()=>victimMessages.find(message=>message.type==='damage'&&message.victim_id===victimSession.client_id),
      'clear native ray did not allow server damage');
    assert.equal(hit.health,175);assert.equal(hit.damage,25);
  } finally {
    clearInterval(nativeTimer);api?.close();victim?.close();for (const dispose of cleanup) dispose();
    if (server && server.exitCode === null) { server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(1000)]); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
