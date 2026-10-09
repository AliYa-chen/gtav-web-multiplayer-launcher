#!/usr/bin/env node
'use strict';
// 执行真实桥脚本与受控 native 替身；不实例化 WASM，也不读取游戏资源。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const engineSource = fs.readFileSync(path.join(root, 'client/multiplayer/engine-bridge.js'), 'utf8');
const adapterSource = fs.readFileSync(path.join(root, 'client/multiplayer/game-adapter.js'), 'utf8');
const appearanceSource = fs.readFileSync(path.join(root, 'client/multiplayer/appearance.js'), 'utf8');
const worldSource = fs.readFileSync(path.join(root, 'client/multiplayer/world-engine-bridge.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'client/multiplayer/native-session-ui.js'), 'utf8');
const errorI18nContext = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'client/i18n.js'), 'utf8').replace(/^export /gm, '')
  + '\nglobalThis.errorTranslator = localizeServerError;', errorI18nContext);
const appearanceModule = import('data:text/javascript;base64,' + Buffer.from(appearanceSource).toString('base64'));
// 始终读取当前构建器定义，避免旧隔离探针缓存掩盖新增导出；无需游戏二进制。
const builderManifest = spawnSync(process.env.PYTHON || 'python3', ['-B', '-c',
  'import json,sys; sys.path.insert(0,"tools"); from build_native_probe import export_map; print(json.dumps({"additional_exports":[{"export_name":name} for name in export_map(True)]}))'],
{ cwd: root, encoding: 'utf8' });
if (builderManifest.status !== 0) throw new Error(builderManifest.stderr || '不能读取 native 接口定义');
const nativeManifest = JSON.parse(builderManifest.stdout);
// Node 原生 TextDecoder 接受共享视图，浏览器拒绝。模拟浏览器约束来验证桥复制后解码。
class BrowserTextDecoder extends TextDecoder {
  decode(input, options) {
    if (input instanceof SharedArrayBuffer || input?.buffer instanceof SharedArrayBuffer) {
      throw new TypeError('浏览器 TextDecoder 不允许 SharedArrayBuffer');
    }
    return super.decode(input, options);
  }
}
const captureFixture = () => ({
  components: Array.from({ length: 12 }, (_, index) => [index + 1, index % 3, index % 4]),
  props: Array.from({ length: 8 }, (_, index) => index % 2 ? [-1, -1] : [index + 1, index % 3]),
});
const MAGIC = 0x4d505442;
const peerState = (changes = {}) => ({ position: [710, -1080, 22], model: 0x705e61f2, heading: 120, health: 200,
  weapon: 0x1b06d571, shooting: false, ...changes });
const packet = (changes = {}) => ({ connected: true, engine_ready: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }, { id: 'REMOTE' }],
  peers: [{ player_id: 'REMOTE', state: peerState() }], shots: [], ...changes });

function engine(options = {}) {
  const memory = { buffer: new SharedArrayBuffer(2 * 1024 * 1024) };
  const calls = [];
  const messages = [];
  const alive = new Set([7]), blips = new Map();
  const blipStyles = new Map();
  const health = new Map([[7, options.localHealth ?? 200]]), invincible = new Set(), dead = new Set();
  const ragdoll = new Set(), ragdollAllowed = new Map();
  const remotePositions = new Map(), remoteHeadings = new Map(), frozen = new Map(), tasks = new Map(), animations = new Map();
  const occupiedVehicles = new Map();
  const uiCalls = [];
  let remoteRecoveryBlocked = false;
  let now = 100, allocated = 4096, nextPed = 100, localPosition = [...(options.localPosition || [711.5, -1088, 22.41])];
  let localPed = options.localPed ?? 7, localModel = options.localModel ?? 0x705e61f2;
  let localHeading = options.localHeading ?? 180, localWeapon = options.localWeapon ?? 0;
  let localShooting = false, localClip = 30, localAmmo = 30, detonatePressed = false, weaponReady = true, lastImpact = null;
  let localActions = { aiming: false, reloading: false, jumping: false, ducking: false, sprinting: false };
  let remoteEquipBlocked = false;
  const equippedWeapons = new Map();
  let setModelBlockedAttempts = options.setModelBlockedAttempts ?? 0, setModelNoEffect = options.setModelNoEffect ?? false;
  let setModelAsync = options.setModelAsync ?? false, pendingModel = null;
  let noticeResult = options.noticeResult ?? 101, noticeThrows = options.noticeThrows ?? false;
  const unavailableModels = new Set(options.unavailableModels || []), notifications = [];
  let currentNotification = null;
  let weaponAssetReady = options.weaponAssetReady ?? true;
  let blipReady = options.blipReady ?? true, nextBlip = 1000, shootThrows = false;
  const visualVectors = [];
  let localRecoveryBlocked = options.localRecoveryBlocked ?? false;
  const state = { active: 11n, handler: 12n, fadedOut: false, controlsEnabled: true,
    deathState: false, deathRestartPaused: false, gamePlaying: true,
    radar: { hidden: true, rendering: false, fog: true, backgroundHidden: true, prologue: true,
      hudPreference: true, radarPreference: true } };
  const vector = (pointer, values) => values.forEach((value, index) => new DataView(memory.buffer).setFloat32(Number(pointer) + 8 * index, value, true));
  const readNativeVector = (pointer) => [0, 8, 16].map((offset) => new DataView(memory.buffer).getFloat32(Number(pointer) + offset, true));
  const readString = (pointer) => {
    const start = Number(pointer), length = Math.min(8192, memory.buffer.byteLength - start);
    const bytes = new Uint8Array(memory.buffer, start, length).slice(), nul = bytes.indexOf(0);
    assert.ok(nul >= 0, 'native 字符串必须在内存范围内以 NUL 结尾');
    return { text: new TextDecoder().decode(bytes.subarray(0, nul)), bytes: [...bytes.subarray(0, nul)], pointer: start };
  };
  const changeModel = (model) => {
    localModel = model >>> 0; alive.delete(localPed); localPed = 8; alive.add(localPed); health.set(localPed, 200);
    localWeapon = 0;
  };
  const implementations = {
    mpGetActiveThread: () => { if (options.throwActive) throw new Error('活动线程读取失败'); return state.active; },
    mpGetCurrentHandler: () => { if (options.throwHandler) throw new Error('handler 读取失败'); return state.handler; },
    mpPedSyncTree: () => options.pedSyncTree || 0n,
    mpPlayerSyncTree: () => options.playerSyncTree || 0n,
    mpNetworkScriptHandler: () => options.networkScriptHandler || 0n,
    mpGetPlayerPed: () => localPed,
    mpAlloc: (size) => { const pointer = allocated; allocated += Number(size); return BigInt(pointer); },
    mpGetEntityCoords: (pointer, ped) => vector(pointer, ped === localPed ? localPosition : remotePositions.get(ped) || [0, 0, 0]),
    mpGetModel: () => localModel,
    mpPlayerId: () => 0,
    mpSetPlayerModel: (_player, model) => {
      if (setModelNoEffect) return;
      if (setModelBlockedAttempts > 0) { setModelBlockedAttempts--; return; }
      if (setModelAsync) { pendingModel = model; return; }
      changeModel(model);
    },
    mpDefaultVariation: () => {},
    mpRandomComponents: () => {}, mpRandomProps: () => {},
    mpGetDrawable: (_ped, index) => captureFixture().components[index][0],
    mpGetTexture: (_ped, index) => captureFixture().components[index][1],
    mpGetPalette: (_ped, index) => captureFixture().components[index][2],
    mpGetPropIndex: (_ped, index) => captureFixture().props[index][0],
    mpGetPropTextureIndex: (_ped, index) => captureFixture().props[index][1],
    mpSetComponent: () => {}, mpSetProp: () => {}, mpClearProp: () => {},
    mpDrawableCount: () => 100, mpTextureCount: () => 10,
    mpHeadOverlayCount: () => options.overlayCount ?? 10,
    mpSetHeadOverlay: () => {}, mpSetOverlayTint: () => {}, mpSetHairTint: () => {},
    mpHeading: (ped) => ped === localPed ? localHeading : remoteHeadings.get(ped) || 0,
    mpGetHealth: (ped) => health.get(ped) ?? 200,
    mpIsShooting: (ped) => ped === localPed ? localShooting : false,
    mpSelectedWeapon: (ped) => ped === localPed ? localWeapon : equippedWeapons.get(ped) || 0,
    mpGetCurrentPedWeapon: (ped, pointer) => {
      if (ped === localPed && !weaponReady) return 0;
      if (options.unarmedNoWeapon && (ped === localPed ? localWeapon : equippedWeapons.get(ped)) === 0xa2719263) return 0;
      new DataView(memory.buffer).setUint32(Number(pointer), ped === localPed ? localWeapon : equippedWeapons.get(ped) || 0, true);
      return 1;
    },
    mpGetAmmoInClip: (ped, _weapon, pointer) => {
      if (ped !== localPed || !weaponReady || options.noClip) return 0;
      new DataView(memory.buffer).setInt32(Number(pointer), localClip, true); return 1;
    },
    mpGetAmmo: () => localAmmo,
    mpControlJustPressed: (_group, control) => control === 47 && detonatePressed ? 1 : 0,
    mpLastWeaponImpact: (_ped, pointer) => {
      if (!lastImpact) return 0;
      lastImpact.forEach((value, index) => new DataView(memory.buffer).setFloat32(Number(pointer) + 4 * index, value, true));
      return 1;
    },
    mpIsAiming: () => localActions.aiming ? 1 : 0,
    mpIsReloading: (ped) => ped === localPed && localActions.reloading ? 1 : 0,
    mpIsJumping: () => localActions.jumping ? 1 : 0,
    mpIsDucking: () => localActions.ducking ? 1 : 0,
    mpIsSprinting: () => localActions.sprinting ? 1 : 0,
    mpTaskAimGunAtCoord: () => {}, mpTaskReloadWeapon: () => {}, mpTaskJump: () => {}, mpSetDucking: () => {},
    mpHasModel: (hash) => !unavailableModels.has(hash >>> 0),
    mpRequestModel: () => {},
    mpCreatePed: (_type, _model, pointer, heading) => {
      alive.add(++nextPed); health.set(nextPed, 200);
      remotePositions.set(nextPed, readNativeVector(pointer)); remoteHeadings.set(nextPed, heading); return nextPed;
    },
    mpExists: (ped) => alive.has(ped) ? 1 : 0,
    mpDeletePed: (pointer) => {
      const data = new DataView(memory.buffer), ped = data.getInt32(Number(pointer), true);
      alive.delete(ped); data.setInt32(Number(pointer), 0, true);
    },
    mpSetCoordsNoOffset: (ped, pointer) => {
      if (ped === localPed) localPosition = readNativeVector(pointer); else remotePositions.set(ped, readNativeVector(pointer));
    },
    mpBlockEvents: () => {}, mpFreeze: (ped, value) => frozen.set(ped, Boolean(value)),
    mpGetVehiclePedIsIn: (ped) => occupiedVehicles.get(ped) || 0,
    mpSetVelocity: () => {},
    mpTaskGoStraight: (ped, pointer, speed, timeout) => tasks.set(ped, { kind: 'move', target: readNativeVector(pointer), speed, timeout }),
    mpTaskStandStill: (ped, timeout) => tasks.set(ped, { kind: 'idle', timeout }),
    mpSetHeading: (ped, heading) => { if (ped === localPed) localHeading = heading; else remoteHeadings.set(ped, heading); },
    mpGiveWeapon: (ped, weapon) => {
      if (ped === localPed) localWeapon = weapon >>> 0;
      else if (!remoteEquipBlocked) equippedWeapons.set(ped, weapon >>> 0);
    },
    mpSetCurrentWeapon: (ped, weapon) => {
      if (ped === localPed) localWeapon = weapon >>> 0;
      else if (!remoteEquipBlocked) equippedWeapons.set(ped, weapon >>> 0);
    },
    mpTaskShootAtCoord: () => {},
    mpSetHealth: (ped, value) => {
      health.set(ped, value);
      if (value <= 0) {
        dead.add(ped);
        if (ped === localPed) state.deathState = true;
      }
    },
    mpIsDead: (ped) => dead.has(ped) ? 1 : 0,
    mpIsRagdoll: (ped) => ragdoll.has(ped) ? 1 : 0,
    mpSetCanRagdoll: (ped, enabled) => { ragdollAllowed.set(ped, Boolean(enabled)); if (!enabled) ragdoll.delete(ped); },
    mpSetInvincible: (ped, enabled) => { if (enabled) invincible.add(ped); else invincible.delete(ped); },
    mpShootBullet: (origin, target) => {
      if (shootThrows) throw new Error('视觉接口临时失败');
      visualVectors.push({ origin: readNativeVector(origin), target: readNativeVector(target) });
    }, mpHasWeaponAsset: () => weaponAssetReady ? 1 : 0, mpRequestWeaponAsset: () => {},
    mpResurrect: (ped) => { if (ped !== localPed && !remoteRecoveryBlocked) dead.delete(ped); },
    mpRevive: (ped) => { if (ped === localPed ? !localRecoveryBlocked : !remoteRecoveryBlocked) dead.delete(ped); },
    mpClearTasksImmediately: (ped) => { tasks.delete(ped); animations.delete(ped); },
    mpAnimDictExists: () => 1, mpHasAnimDictLoaded: () => 1, mpRequestAnimDict: () => {},
    mpTaskPlayAnim: (ped, dict, clip) => { animations.set(ped, { dict, clip }); tasks.set(ped, { kind: 'punch' }); },
    mpIsPlayingAnim: (ped, dict, clip) => animations.get(ped)?.dict === dict && animations.get(ped)?.clip === clip ? 1 : 0,
    mpAnimTime: () => .4,
    // PED 复活只能恢复实体；本地玩家复活还需要恢复玩家状态和摄像机。
    mpResurrectLocalPlayer: (pointer) => {
      if (localRecoveryBlocked) return;
      if (!localPed || options.resurrectionRecreatesPed) {
        alive.delete(localPed); localPed = ++nextPed; alive.add(localPed);
      }
      localPosition = readNativeVector(pointer);
      if (options.resurrectionModel !== undefined) localModel = options.resurrectionModel >>> 0;
      dead.delete(localPed); health.set(localPed, 200); state.deathState = false;
    },
    mpPauseDeathRestart: (enabled) => { state.deathRestartPaused = Boolean(enabled); },
    mpScreenFadeIn: () => { state.fadedOut = false; },
    mpIsScreenFadedOut: () => state.fadedOut ? 1 : 0,
    mpSetPlayerControl: (_player, enabled) => { state.controlsEnabled = Boolean(enabled); },
    mpForcePlaying: () => { state.gamePlaying = true; },
    mpCamCoords: (pointer) => vector(pointer, [700, -1000, 25]), mpCamRot: (pointer) => vector(pointer, [0, 0, 0]),
    mpAddBlipForEntity: (ped) => { if (!blipReady) return 0; const blip = ++nextBlip; blips.set(blip, ped); return blip; },
    mpDoesBlipExist: (blip) => blips.has(blip) ? 1 : 0,
    mpSetBlipDisplay: (blip, value) => { blipStyles.set(blip, { ...blipStyles.get(blip), display: value }); },
    mpSetBlipAlpha: (blip, value) => { blipStyles.set(blip, { ...blipStyles.get(blip), alpha: value }); },
    mpSetBlipColour: () => {}, mpSetBlipSprite: () => {}, mpSetBlipScale: () => {}, mpSetBlipAsShortRange: () => {},
    mpRemoveBlip: (pointer) => {
      const data = new DataView(memory.buffer); blips.delete(data.getInt32(Number(pointer), true));
      data.setInt32(Number(pointer), 0, true);
    },
    mpBeginSetBlipName: () => {}, mpEndSetBlipName: () => {},
    mpPauseMenuActive: () => state.pauseActive ? 1 : 0,
    mpDisplayHud: () => {},
    mpDisplayRadar: (enabled) => { state.radar.hidden = !enabled;
      state.radar.rendering = Boolean(enabled && state.radar.radarPreference && !state.radar.fog && !state.radar.backgroundHidden); },
    mpIsRadarHidden: () => state.radar.hidden ? 1 : 0,
    mpIsMinimapRendering: () => state.radar.rendering ? 1 : 0,
    mpHudPreference: () => state.radar.hudPreference ? 1 : 0,
    mpRadarPreference: () => state.radar.radarPreference ? 1 : 0,
    mpMinimapHideFog: (enabled) => { state.radar.fog = !enabled; },
    mpMinimapPrologue: (enabled) => { state.radar.prologue = Boolean(enabled); },
    mpUnlockMinimapAngle: () => {}, mpUnlockMinimapPosition: () => {},
    mpMinimapBackgroundInfo: (info) => {
      if (state.radar.throwBackground) throw new Error('minimap still loading');
      const data = new DataView(memory.buffer), address = Number(info);
      const args = Number(data.getBigUint64(address + 16, true));
      assert.equal(args, address + 32, 'wrapper必须使用独立的Info参数数组');
      assert.ok(address > 0 && args + 4 <= memory.buffer.byteLength);
      state.radar.backgroundHidden = Boolean(data.getInt32(args, true));
    },
    mpFrontendReady: () => state.pauseActive ? 1 : 0,
    mpBeginPauseHeader: (pointer) => { uiCalls.push({ method: readString(pointer).text, parameters: [] }); return 1; },
    mpScaleformString: (pointer) => uiCalls.at(-1).parameters.push(readString(pointer).text),
    mpScaleformBool: (value) => uiCalls.at(-1).parameters.push(Boolean(value)),
    mpEndScaleform: () => {},
    mpAddTextPlayerSubstring: (pointer) => {
      if (currentNotification) {
        if (noticeThrows) throw new Error('受控原生文字添加失败');
        currentNotification.parts.push(readString(pointer));
      }
    },
    mpBeginTheFeedPost: (pointer) => {
      if (noticeThrows) throw new Error('受控原生通知构造失败');
      currentNotification = { command: readString(pointer), parts: [], result: null };
    },
    mpEndTheFeedPostTicker: () => {
      if (noticeThrows) throw new Error('受控原生通知发送失败');
      if (currentNotification) {
        currentNotification.result = noticeResult; notifications.push(currentNotification); currentNotification = null;
      }
      return noticeResult;
    },
  };
  const ex = {};
  for (const [name, implementation] of Object.entries(implementations)) ex[name] = (...arguments_) => {
    calls.push({ name, arguments: arguments_ });
    return implementation(...arguments_);
  };
  if (options.muzzle) {
    ex.mpCurrentWeaponEntity = () => 500;
    alive.add(500);
    ex.mpEntityBoneCount = () => options.noWeaponSkeleton ? 0 : 4;
    ex.mpEntityBoneIndexByName = (...args) => { calls.push({ name: 'mpEntityBoneIndexByName', arguments: args }); return 2; };
    ex.mpWorldPositionOfEntityBone = (out) => vector(out, options.muzzle);
  }
  if (options.hand) ex.mpPedBoneCoords = (out) => vector(out, options.hand);
  if (options.noLocalPlayerResurrection) delete ex.mpResurrectLocalPlayer;
  if (options.noNativeNotices) { delete ex.mpBeginTheFeedPost; delete ex.mpEndTheFeedPostTicker; }
  const self = { postMessage(value) { if (options.throwPost) throw new Error('页面已关闭'); messages.push(value); } };
  const startupBridgeCalls = [];
  if (options.startupBridgeSpies) {
    self.createWorldEntityBridge = () => ({
      suppressPopulation() { startupBridgeCalls.push('population'); },
      renderEffects() { startupBridgeCalls.push('effects'); },
      sampleMelee() { startupBridgeCalls.push('melee'); },
      update() { startupBridgeCalls.push('entities'); return { active: false }; }, clear() {},
    });
    self.createWorldEnvironmentBridge = () => ({
      suppressLocalDispatch() { startupBridgeCalls.push('dispatch'); },
      update() { startupBridgeCalls.push('environment'); }, reset() {},
    });
  }
  const context = vm.createContext({ self, performance: { now: () => now }, TextDecoder: BrowserTextDecoder, TextEncoder, Atomics,
    Int32Array, Uint8Array, DataView, BigInt, SharedArrayBuffer });
  if (options.worldBridge) vm.runInContext(worldSource, context, { filename: 'world-engine-bridge.js' });
  else if (options.vehicleHandles) self.createWorldEntityBridge = () => ({ entityHandle: id => options.vehicleHandles.get(id) || 0,
    suppressPopulation() {}, sampleMelee() {}, update() { return { active: false }; }, clear() {} });
  if (options.sessionUI) vm.runInContext(uiSource, context, { filename: 'native-session-ui.js' });
  vm.runInContext(engineSource, context, { filename: 'engine-bridge.js' });
  const imports = { env: { memory, wasm_module_int_js: () => 0 } };
  self.prepareMultiplayerBridge(imports)({ exports: ex });
  const tick = (at = now + 100, thread = 11n) => { now = at; return imports.env.wasm_module_int_js(thread, MAGIC); };
  const setup = () => {
    tick(100);
    const message = messages.find((value) => value.multiplayer?.type === 'memory')?.multiplayer;
    assert.ok(message, '首次有效 tick 应分配共享快照');
    return message;
  };
  const publish = (value, odd = false) => {
    const shared = messages.find((entry) => entry.multiplayer?.type === 'memory')?.multiplayer;
    assert.ok(shared);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const header = new Int32Array(memory.buffer, shared.block, 4);
    const previous = Atomics.load(header, 0) & ~1;
    Atomics.store(header, 0, previous + 1);
    new Uint8Array(memory.buffer, shared.block + 16, shared.capacity).set(bytes);
    Atomics.store(header, 1, bytes.length);
    if (!odd) Atomics.store(header, 0, previous + 2);
  };
  const connect = (value = packet()) => {
    if (!messages.some((entry) => entry.multiplayer?.type === 'memory')) setup();
    publish(value);
    // 相同脚本和 handler 连续出现超过真实桥的 1200 ms 观察窗口。
    // 受控替身只能证明桥的选举分支；不证明实际游戏脚本的生命周期。
    for (let index = 0; index < 14; index++) tick();
  };
  return { memory, calls, messages, state, tick, setup, publish, connect, alive, blips, health, invincible, dead, ragdoll, ragdollAllowed, notifications, startupBridgeCalls,
    remotePositions, remoteHeadings, frozen, tasks, animations, uiCalls, occupiedVehicles, visualVectors, blipStyles,
    setBlipReady: (value) => { blipReady = value; }, setShootThrows: (value) => { shootThrows = value; },
    frontendTick: (at = now + 100) => { now = at; return imports.env.wasm_module_int_js(0n, 0x4d505549); },
    scriptGate: (name) => {
      new Uint8Array(memory.buffer, 11 + 428, 32).fill(0);
      new Uint8Array(memory.buffer, 11 + 428, 32).set(new TextEncoder().encode(name));
      return imports.env.wasm_module_int_js(11n, 0x4d505343);
    },
    now: () => now, setLocalModel: (model) => { localModel = model >>> 0; },
    localPed: () => localPed, position: () => [...localPosition],
    setLocalPed: (ped) => { alive.delete(localPed); localPed = ped; if (ped) alive.add(ped); },
    setPosition: (position) => { localPosition = [...position]; },
    setHeading: (heading) => { localHeading = heading; }, heading: () => localHeading,
    setWeapon: (weapon) => { localWeapon = weapon >>> 0; }, weapon: () => localWeapon,
    setShooting: (value) => { localShooting = value; },
    setClip: (value) => { localClip = value; },
    setAmmo: (value) => { localAmmo = value; }, setDetonate: (value) => { detonatePressed = value; },
    setWeaponReady: (value) => { weaponReady = value; },
    setActions: (value) => { localActions = { ...localActions, ...value }; },
    setLastImpact: (value) => { lastImpact = value; },
    setRemoteEquipBlocked: (value) => { remoteEquipBlocked = value; },
    setRemoteRecoveryBlocked: (value) => { remoteRecoveryBlocked = value; },
    equippedWeapons,
    setModelBlockedAttempts: (count) => { setModelBlockedAttempts = count; },
    setModelNoEffect: (value) => { setModelNoEffect = value; },
    setModelAsync: (value) => { setModelAsync = value; },
    completeModelChange: () => { if (pendingModel !== null) { changeModel(pendingModel); pendingModel = null; } },
    setModelAvailable: (hash, value) => { if (value) unavailableModels.delete(hash >>> 0); else unavailableModels.add(hash >>> 0); },
    setNoticeResult: (result) => { noticeResult = result; },
    setNoticeThrows: (value) => { noticeThrows = value; },
    setLocalRecoveryBlocked: (value) => { localRecoveryBlocked = value; },
    setWeaponAssetReady: (value) => { weaponAssetReady = value; },
    hit: (ped, damage) => {
      if (!invincible.has(ped)) { health.set(ped, Math.max(0, (health.get(ped) ?? 200) - damage)); if (health.get(ped) <= 0) dead.add(ped); }
    } };
}

function adapter(network = null, options = {}) {
  const channels = [], timers = new Map(), requests = [];
  const hud = { textContent: '', style: {} };
  let language = options.language || 'zh-CN', languageListener = null;
  let nextTimer = 1, now = 100, pagehide = null;
  class Channel {
    constructor(name) { this.name = name; this.posts = []; channels.push(this); }
    postMessage(value) { this.posts.push(value); }
    close() {}
  }
  const context = vm.createContext({ BroadcastChannel: Channel, TextEncoder, TextDecoder, Atomics, Int32Array,
    Uint8Array, DataView, SharedArrayBuffer, AbortController, performance: { now: () => now }, document: { getElementById: () => hud },
    addEventListener(name, callback) { if (name === 'pagehide') pagehide = callback; },
    getLanguage: () => language, translateText: value => value,
    localizeServerError: value => errorI18nContext.errorTranslator(value, language),
    onLanguageChange: callback => { languageListener = callback; return () => { languageListener = null; }; },
    fetch(url, request) { requests.push({ url, ...request }); return options.fetch ? options.fetch(url, request) : Promise.resolve({ ok: true }); },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(adapterSource.replace(/^import .* from '\.\.\/i18n\.js';\n/m, '').replace('export function installGameAdapter', 'function installGameAdapter') +
    '\nglobalThis.installAdapter = installGameAdapter;', context, { filename: 'game-adapter.js' });
  const api = context.installAdapter({}, network, options);
  const memory = { buffer: new SharedArrayBuffer(8192) }, block = 256, capacity = 4096;
  api.onWorkerMessage({ multiplayer: { type: 'memory', memory, block, capacity } });
  const receive = (data) => network ? network.receiver(data) : channels[0].onmessage({ data });
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); for (const { callback } of callbacks) callback(); };
  const read = () => {
    const header = new Int32Array(memory.buffer, block, 4);
    assert.equal(Atomics.load(header, 0) & 1, 0, '快照发布后序号必须为偶数');
    return JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, block + 16, Atomics.load(header, 1))));
  };
  return { api, receive, flush, read, channels, requests, hud,
    runTimer(delay) { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, `Missing ${delay} ms timer`); timers.delete(entry[0]); now += delay; entry[1].callback(); },
    setNow(value) { now = value; }, close() { pagehide?.(); },
    pendingTimers: () => [...timers.values()].map(timer => timer.delay),
    setLanguage: value => { language = value; languageListener?.({ language: value }); } };
}

function directNetwork() {
  return { receiver: null, messages: [],
    setReceiver(value) { this.receiver = value; },
    onWorkerMessage(value) { this.messages.push(value); } };
}

test('引擎就绪只来自页面确认，服务端就绪快照不能提前开启原生场景写入', () => {
  const network=directNetwork(),page=adapter(network);
  page.receive({type:'session',connected:true,client_id:'LOCAL',members:[{id:'LOCAL'}],engine_ready:true});
  page.receive({type:'world_state',ready:true,world_epoch:'scene-test',entities:[],tombstones:[]});
  page.flush();assert.equal(page.read().engine_ready,false);
  page.api.setEngineReady();page.flush();assert.equal(page.read().engine_ready,true);
  page.receive({type:'session',connected:false,client_id:null});page.flush();
  assert.equal(page.read().engine_ready,true,'断线不恢复本地加载或剧情');
  page.close();
});

test('页面早于共享内存收到真实场景确认时，新共享快照仍保留就绪状态', () => {
  const page=adapter(directNetwork());
  page.api.setEngineReady();page.api.setEngineReady();page.flush();
  assert.equal(page.read().engine_ready,true);
  page.close();page.api.setEngineReady();
});

test('同一来源的两个游戏页直接使用各自会话，不创建共享战局广播频道', () => {
  const a = directNetwork(), b = directNetwork();
  const first = adapter(a), second = adapter(b);
  assert.ok(!first.channels.some((channel) => channel.name === 'gta5-public-bridge-v1'));
  assert.ok(!second.channels.some((channel) => channel.name === 'gta5-public-bridge-v1'));
  first.receive({ type: 'session', connected: true, client_id: 'A', members: [{ id: 'A' }, { id: 'B' }],
    peers: [{ player_id: 'B', state: peerState() }] });
  second.receive({ type: 'session', connected: true, client_id: 'B', members: [{ id: 'A' }, { id: 'B' }],
    peers: [{ player_id: 'A', state: peerState({ model: 0x9c9effd8 }) }] });
  first.flush(); second.flush();
  assert.equal(first.read().client_id, 'A'); assert.equal(first.read().peers[0].player_id, 'B');
  assert.equal(second.read().client_id, 'B'); assert.equal(second.read().peers[0].player_id, 'A');
  first.api.onWorkerMessage({ multiplayer: { type: 'local_state', state: peerState() } });
  assert.equal(a.messages.filter((message) => message.type === 'local_state').length, 1);
  assert.equal(b.messages.filter((message) => message.type === 'local_state').length, 0);
});

test('重新收到完整战局快照后仍保留未确认控制消息，并只通过对应会话确认就绪', () => {
  const network = directNetwork(), page = adapter(network);
  assert.equal(network.messages.filter((message) => message.type === 'bridge_ready').length, 2);
  page.receive({ type: 'session', connected: true, client_id: 'A', members: [{ id: 'A' }], peers: [] });
  page.receive({ type: 'respawn', player_id: 'A', position: [711, -1088, 22], health: 200, revision: 3 });
  page.flush(); const id = page.read().controls[0].id;
  page.receive({ type: 'session', connected: true, client_id: 'A', members: [{ id: 'A' }], peers: [] });
  page.flush(); assert.equal(page.read().controls[0].id, id);
  page.api.onWorkerMessage({ multiplayer: { type: 'control_ack', ids: [id] } });
  page.flush(); assert.equal(page.read().controls.length, 0);
});

test('角色画面更新不能盖掉真实断线提示，网络恢复后显示服务器人数', () => {
  const page = adapter(directNetwork());
  page.receive({ type: 'network_status', connected: false, text: '服务器无响应，正在自动重连…' });
  page.api.onWorkerMessage({ multiplayer: { type: 'game_status', peer_count: 0, health: 200, alive: true } });
  assert.ok(page.hud.textContent.includes('正在自动重连'));
  assert.ok(page.hud.textContent.includes('已显示 0 位其他玩家'));
  page.receive({ type: 'network_status', connected: true, members: 2 });
  assert.ok(page.hud.textContent.includes('服务器在线 · 2 位玩家'));
  assert.ok(!page.hud.textContent.includes('自动重连'));
});

test('页面语言即时传入共享快照并翻译现有HUD与未确认通知，不重建会话', () => {
  const network = directNetwork(), page = adapter(network);
  page.receive({ type: 'session', connected: true, client_id: 'A', members: [{ id: 'A' }], peers: [] });
  page.receive({ type: 'network_status', connected: true, members: 2 });
  page.api.onWorkerMessage({ multiplayer: { type: 'game_status', peer_count: 1, health: 150, alive: true, kills: 2, deaths: 1 } });
  page.flush();
  const initial = page.read(), noticeIds = initial.notices.map(notice => notice.id), sent = network.messages.length;
  assert.equal(initial.language, 'zh-CN');
  assert.match(page.hud.textContent, /生命值 150/);
  page.setLanguage('en'); page.flush();
  const english = page.read();
  assert.equal(english.language, 'en');
  assert.equal(english.client_id, 'A');
  assert.equal(network.messages.length, sent, '切换语言不会发起重连或动作');
  assert.deepEqual(english.notices.map(notice => notice.id), noticeIds);
  assert.match(english.notices[0].text, /Connected to public session/);
  assert.match(page.hud.textContent, /Server online · 2 players/);
  assert.match(page.hud.textContent, /Health 150 · Kills 2 \/ Deaths 1/);
  page.receive({ type: 'combat_feedback', accepted: true, hit: true, victim_id: 'B', revision: 4, damage: 25, health: 50 });
  page.flush(); assert.match(page.read().notices.at(-1).text, /Player hit · Damage 25/);
  page.setLanguage('zh-CN'); page.flush();
  assert.match(page.hud.textContent, /命中玩家 · 伤害 25/);
  assert.match(page.read().notices.at(-1).text, /命中玩家 · 傷害 25/);
});

test('互动拒绝通知保存错误码供语言热切，但用户界面不显示技术枚举且普通距离拒绝保持安静', () => {
  const page = adapter(directNetwork(), { language: 'en' });
  page.receive({ type: 'interaction_result', accepted: false, reason: 'unsupported_interaction' });
  page.flush(); const initial = page.read().notices.at(-1);
  assert.equal(initial.text, 'This interaction is not currently available.');
  page.setLanguage('zh-CN'); page.flush();
  assert.equal(page.read().notices.at(-1).id, initial.id);
  assert.equal(page.read().notices.at(-1).text, '互動未完成，請稍後重試。');
  page.setLanguage('en'); page.flush();
  assert.equal(page.read().notices.at(-1).text, initial.text);
  const count = page.read().notices.length;
  page.receive({ type: 'interaction_result', accepted: false, reason: 'too_far' });
  page.flush(); assert.equal(page.read().notices.length, count);
  page.receive({ type: 'interaction_result', accepted: false, reason: 'future_interaction' });
  page.flush(); assert.equal(page.read().notices.at(-1).text, 'The server could not complete this action. Please try again.');
  assert.ok(!page.read().notices.at(-1).text.includes('future_interaction'));
});

test('原生子弹脉冲在重帧之间锁存，弹夹减少可补漏单发，附带同武器状态', () => {
  const bridge = engine({ localWeapon: 0x1b06d571 }); bridge.connect(packet({ peers: [] }));
  bridge.tick(); // 建立弹夹基线。
  const start = bridge.now();
  bridge.setShooting(true); bridge.setClip(29); bridge.tick(start + 5);
  bridge.setShooting(false); bridge.tick(start + 10);
  bridge.tick(start + 40);
  const shots = () => bridge.messages.filter((message) => message.multiplayer?.type === 'local_shot');
  assert.equal(shots().length, 1);
  assert.equal(shots()[0].multiplayer.event.weapon, 0x1b06d571);
  assert.equal(shots()[0].multiplayer.state.weapon, 0x1b06d571);
  bridge.setClip(28); bridge.tick(start + 200); // 无IsShooting脉冲也根据实际减弹补发。
  assert.equal(shots().length, 2);
  for (let index = 0; index < 5; index++) bridge.tick();
  assert.equal(shots().length, 2, '静止弹夹不能重复发枪');
});

test('换枪未装备和装填样本不吞掉随后有效脉冲，impact使用紧凑向量', () => {
  const bridge = engine({ localWeapon: 0x1b06d571 }); bridge.connect(packet({ peers: [] }));
  bridge.setWeaponReady(false); bridge.setShooting(true); bridge.tick();
  assert.equal(bridge.messages.filter((message) => message.multiplayer?.type === 'local_shot').length, 0);
  bridge.setWeaponReady(true); bridge.setLastImpact([710, -1000, 25]); bridge.tick();
  const shot = bridge.messages.find((message) => message.multiplayer?.type === 'local_shot').multiplayer;
  assert.deepEqual(JSON.parse(JSON.stringify(shot.event.target)), [710, -1000, 25]);
  bridge.setActions({ reloading: true }); bridge.setClip(30); bridge.setShooting(false); bridge.tick();
  bridge.setClip(29); bridge.tick();
  assert.equal(bridge.messages.filter((message) => message.multiplayer?.type === 'local_shot').length, 1);
});

test('同一发先有射击位随后才减弹不会重复上报，有限弹和无限弹持续开火可限频', () => {
  const bridge = engine({ localWeapon: 0x1b06d571 }); bridge.connect(packet({ peers: [] }));
  bridge.setShooting(true); bridge.tick();
  const shots = () => bridge.messages.filter((message) => message.multiplayer?.type === 'local_shot');
  assert.equal(shots().length, 1);
  bridge.setShooting(false); bridge.tick(); bridge.setClip(29); bridge.tick();
  assert.equal(shots().length, 1);
  bridge.setShooting(true);
  for (let index = 0; index < 10; index++) bridge.tick();
  assert.ok(shots().length > 1);
});

test('远端武器未就绪先请求，装备失败限频重试，任务收枪后再次恢复', () => {
  const bridge = engine({ weaponAssetReady: false }); bridge.connect();
  assert.ok(bridge.calls.some((call) => call.name === 'mpRequestWeaponAsset'));
  assert.equal(bridge.calls.filter((call) => call.name === 'mpGiveWeapon').length, 0);
  bridge.setWeaponAssetReady(true); bridge.setRemoteEquipBlocked(true);
  for (let index = 0; index < 8; index++) bridge.tick();
  const before = bridge.calls.filter((call) => call.name === 'mpGiveWeapon').length;
  assert.ok(before > 0);
  bridge.setRemoteEquipBlocked(false);
  for (let index = 0; index < 6; index++) bridge.tick();
  const ped = [...bridge.equippedWeapons.keys()][0];
  assert.equal(bridge.equippedWeapons.get(ped), 0x1b06d571);
  bridge.equippedWeapons.set(ped, 0);
  for (let index = 0; index < 6; index++) bridge.tick();
  assert.equal(bridge.equippedWeapons.get(ped), 0x1b06d571);
  assert.ok(bridge.calls.filter((call) => call.name === 'mpGiveWeapon').length > before);
});

test('服务器动作快照驱动远端瞄准、装填、跳跃和蹲下，边沿动作不重复', () => {
  const actions = { aiming: true, reloading: true, jumping: true, ducking: true, sprinting: true };
  const value = packet({ peers: [{ player_id: 'REMOTE', state: peerState({ actions, aim_target: [711, -1082, 23] }) }] });
  const bridge = engine(); bridge.connect(value);
  const ped = [...bridge.equippedWeapons.keys()][0];
  assert.equal(bridge.calls.filter((call) => call.name === 'mpTaskJump').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpTaskReloadWeapon').length, 1);
  assert.deepEqual(bridge.calls.find((call) => call.name === 'mpSetDucking').arguments, [ped, 1]);
  for (let index = 0; index < 5; index++) { bridge.publish(value); bridge.tick(); }
  assert.equal(bridge.calls.filter((call) => call.name === 'mpTaskJump').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpTaskReloadWeapon').length, 1);
  actions.reloading = false; actions.jumping = false; actions.ducking = false;
  bridge.publish(value); bridge.tick();
  assert.ok(bridge.calls.some((call) => call.name === 'mpTaskAimGunAtCoord'));
  assert.deepEqual(bridge.calls.filter((call) => call.name === 'mpSetDucking').at(-1).arguments, [ped, 0]);
  bridge.setActions(actions); bridge.tick();
  assert.deepEqual(lastSample(bridge).actions, actions);
  assert.ok(lastSample(bridge).aim_target.length === 3);
});

test('native 上下文与错误通知异常都被吸收，允许 WASM 执行 TLS 清理', () => {
  for (const options of [{ throwActive: true }, { throwHandler: true }, { throwActive: true, throwPost: true }]) {
    const bridge = engine(options);
    assert.doesNotThrow(() => bridge.tick());
    assert.equal(bridge.calls.filter((call) => call.name === 'mpGetPlayerPed').length, 0);
  }
});

test('桥调用的 native 名称与实际构建器导出 manifest 一致', () => {
  const exports = new Set(nativeManifest.additional_exports.map((entry) => entry.export_name));
  for (const match of engineSource.matchAll(/\bex\.([A-Za-z_]\w*)/g)) {
    assert.ok(exports.has(match[1]), `缺少真实 WASM 导出 ${match[1]}`);
  }
});

test('统一网络层就绪观测只报告初始化状态，不创建网络对象或公开原始指针', () => {
  for (const options of [{}, { pedSyncTree: 12000n, playerSyncTree: 14000n, networkScriptHandler: 16000n }]) {
    const bridge = engine(options); bridge.connect(packet({ peers: [] }));
    const reports = bridge.messages.filter((entry) => entry.multiplayer?.type === 'world_readiness');
    assert.equal(reports.length, 1);
    const value = reports[0].multiplayer;
    assert.equal(value.mode, 'read_only');
    assert.equal(value.ped_tree_initialized, Boolean(options.pedSyncTree));
    assert.equal(value.network_script_context, Boolean(options.networkScriptHandler));
    assert.ok(!JSON.stringify(value).includes('12000'));
    for (let index = 0; index < 60; index++) bridge.tick();
    assert.equal(bridge.messages.filter((entry) => entry.multiplayer?.type === 'world_readiness').length, 1);
  }
});

test('网络世界基线先到不抢跑引擎启动，真实场景就绪才应用环境、创建实体和换模', () => {
  const bridge = engine({ localModel: 0x9b22dbaf, startupBridgeSpies: true });
  bridge.setup();
  const policy = { revision: 1, story_enabled: false, local_script_mode: 'suspend_after_ready', allowed_scripts: [], mission_events: 'server_only' };
  const remote = { kind: 'ped', player_id: 'REMOTE', model: 0x705e61f2, revision: 1,
    components: { transform: { position: [710, -1080, 22], rotation: [0, 0, 0, 1] },
      ped: { weapon: 0, shooting: false }, combat: { health: 200, alive: true, revision: 1 } } };
  const value = packet({ engine_ready: false, world_v2: true, session_policy: policy,
    world: { ready: true, entities: [remote], world_epoch: 'STARTUP' },
    controls: [{ id: 9, event: { type: 'correction', player_id: 'LOCAL', position: [711, -1088, 22], revision: 1 } }] });
  for (const flag of [undefined, false, null, 1, 'true']) {
    bridge.publish({ ...value, engine_ready: flag });
    for (let index = 0; index < 14; index++) bridge.tick();
    for (const script of ['initial', 'main', 'main_persistent', 'player_controller']) assert.equal(bridge.scriptGate(script), 0);
  }
  assert.deepEqual(bridge.startupBridgeCalls, []);
  assert.equal(bridge.calls.filter(call => /^mp(?:Create|SetPlayerModel|SetCoords|SetHealth|PauseDeathRestart|ForcePlaying|ScreenFadeIn)/.test(call.name)).length, 0);
  assert.equal(bridge.messages.some(message => ['local_state', 'control_ack', 'world_readiness', 'lifecycle'].includes(message.multiplayer?.type)), false);
  assert.equal(bridge.state.controlsEnabled, false, '仅安全保持输入禁用，不冻结启动VM');
  assert.equal(bridge.calls.filter(call => call.name === 'mpSetPlayerControl').length, 1);
  bridge.connect({ ...value, engine_ready: true, controls: [] });
  assert.ok(bridge.startupBridgeCalls.includes('population'));
  assert.ok(bridge.startupBridgeCalls.includes('environment'));
  assert.ok(bridge.startupBridgeCalls.includes('entities'));
  assert.equal(bridge.calls.filter(call => call.name === 'mpSetPlayerModel').length, 1);
  assert.ok(bridge.calls.some(call => call.name === 'mpCreatePed'));
  assert.ok(bridge.messages.some(message => message.multiplayer?.type === 'local_state'));
  assert.equal(bridge.scriptGate('initial'), 1, '实际场景已加载、放置角色后才启用服务端脚本策略');
  assert.equal(bridge.state.controlsEnabled, true);
});

test('初始角色缺失时不调用控制native，加载后断线仍保持已启用的剧情禁止策略', () => {
  const policy = { revision: 1, story_enabled: false, local_script_mode: 'suspend_after_ready', allowed_scripts: [], mission_events: 'server_only' };
  const bridge = engine({ localPed: 0 }); bridge.setup();
  bridge.publish(packet({ engine_ready: false, world_v2: true, session_policy: policy, world: { ready: true, entities: [] } }));
  bridge.tick(); assert.equal(bridge.scriptGate('initial'), 0);
  assert.equal(bridge.calls.some(call => call.name === 'mpSetPlayerControl'), false);
  bridge.setLocalPed(7);
  bridge.connect(packet({ world_v2: true, session_policy: policy, world: { ready: true, entities: [] } }));
  assert.equal(bridge.scriptGate('initial'), 1);
  bridge.publish(packet({ connected: false, engine_ready: false, world_v2: false, world: null })); bridge.tick();
  assert.equal(bridge.scriptGate('initial'), 1, '就绪消息或网络消失不能重新放开本地剧情VM');
});

test('无 handler 的线程不会消耗有效线程的节流窗口', () => {
  const bridge = engine();
  bridge.state.handler = 0n;
  bridge.tick(100);
  bridge.state.handler = 12n;
  bridge.tick(101);
  assert.ok(bridge.messages.some((value) => value.multiplayer?.type === 'memory'));
});

test('非法位置与写入中的序列锁快照不会创建或移动实体', () => {
  const bridge = engine();
  bridge.connect(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ position: [17000, 0, 0] }) }] }));
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] !== 7).length, 0);
  bridge.publish(packet(), true); bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 0);
});

test('正常实体创建使用 NoOffset；断线清理的是复制角色，不删除本地角色', () => {
  const bridge = engine(); bridge.connect();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
  const replica = bridge.calls.find((call) => call.name === 'mpFreeze').arguments[0];
  assert.ok(bridge.alive.has(replica));
  bridge.publish(packet({ connected: false, members: [], peers: [] })); bridge.tick();
  assert.ok(!bridge.alive.has(replica)); assert.ok(bridge.alive.has(7));
  assert.equal(bridge.blips.size, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpDeletePed').length, 1);
});

test('中文昵称标记使用独立 NUL 终止 UTF-8 缓冲，不覆盖位置与删除句柄', () => {
  const bridge = engine();
  const nickname = '远端中文玩家';
  bridge.connect(packet({ members: [{ id: 'LOCAL', name: '本地' }, { id: 'REMOTE', name: nickname }] }));
  assert.ok(!bridge.messages.some((message) => message.multiplayer?.type === 'bridge_error'));
  const label = bridge.calls.find((call) => call.name === 'mpBeginSetBlipName');
  const text = bridge.calls.find((call) => call.name === 'mpAddTextPlayerSubstring');
  const readString = (pointer) => {
    const bytes = new Uint8Array(bridge.memory.buffer, Number(pointer), 128);
    return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
  };
  assert.equal(readString(label.arguments[0]), 'STRING');
  assert.equal(readString(text.arguments[0]), nickname);
  assert.equal(Number(text.arguments[0]) - Number(label.arguments[0]), 32);
});

test('两名玩家在无远端状态时也出生在固定测试区，并且后续不被拉回', () => {
  const bridge = engine();
  const members = [{ id: 'REMOTE' }, { id: 'LOCAL' }];
  bridge.connect(packet({ members, peers: [] }));
  const localMoves = bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === 7);
  assert.equal(localMoves.length, 1);
  const sample = bridge.messages.find((message) => message.multiplayer?.type === 'local_state').multiplayer.state;
  assert.ok(Math.abs(sample.position[0] - 713.5) < .001);
  assert.ok(Math.abs(sample.position[1] + 1088.1) < .001);
  assert.ok(Math.abs(sample.position[2] - 22.4) < .001);
  bridge.publish(packet({ members })); bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === 7).length, 1);
  const first = engine(); first.connect(packet({ peers: [] }));
  const initial = first.messages.find((message) => message.multiplayer?.type === 'local_state').multiplayer.state;
  assert.ok(Math.abs(initial.position[0] - 711.5) < .001);
});

test('在线模型替换使用真实 PlayerId，换模后更新角色句柄并初始化衣服', () => {
  const bridge = engine({ localModel: 0x0d7114c9 });
  bridge.connect(packet({ peers: [], members: [{ id: 'LOCAL' }] }));
  const change = bridge.calls.find((call) => call.name === 'mpSetPlayerModel');
  assert.deepEqual(change.arguments, [0, 0x705e61f2 | 0]);
  assert.ok(bridge.calls.some((call) => call.name === 'mpDefaultVariation' && call.arguments[0] === 8));
  assert.ok(bridge.calls.some((call) => call.name === 'mpGetEntityCoords' && call.arguments[1] === 8));
});

test('实体写入等待同一脚本和 handler 持续观察，锁定后其他上下文不能执行同步写入', () => {
  const bridge = engine({ localModel: 0x0d7114c9 }); bridge.setup(); bridge.publish(packet());
  for (let index = 0; index < 12; index++) bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').length, 0);
  bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').length, 1);

  bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ position: [712, -1080, 22] }) }] }));
  const before = bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset').length;
  // 相同线程地址但更换 handler，同样不能继承当前 owner 的实体写入权限。
  bridge.state.handler = 99n; bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset').length, before);
  bridge.state.handler = 12n; bridge.tick(bridge.now() + 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset').length, before + 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
});

test('持续轮换的短命脚本上下文不能通过总运行时长触发换模或创建实体', () => {
  const bridge = engine({ localModel: 0x0d7114c9 }); bridge.setup(); bridge.publish(packet());
  for (let index = 0; index < 30; index++) {
    bridge.state.active = BigInt(10000 + index);
    bridge.state.handler = BigInt(20000 + index);
    bridge.tick(bridge.now() + 100, bridge.state.active);
  }
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').length, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset').length, 0);
});

test('本地换模只初始化一次，短暂恢复主角模型不会反复换模或广播主角状态', () => {
  const bridge = engine({ localModel: 0x0d7114c9 });
  bridge.connect(packet({ peers: [] }));
  for (let index = 0; index < 8; index++) { bridge.publish(packet({ peers: [] })); bridge.tick(); }
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpDefaultVariation' && call.arguments[0] === 8).length, 1);
  const count = bridge.messages.filter((entry) => entry.multiplayer?.type === 'local_state').length;
  bridge.setLocalModel(0x0d7114c9);
  for (let index = 0; index < 8; index++) { bridge.publish(packet({ peers: [] })); bridge.tick(); }
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').length, 1);
  assert.equal(bridge.messages.filter((entry) => entry.multiplayer?.type === 'local_state').length, count);
  bridge.setLocalModel(0x705e61f2); bridge.tick();
  assert.equal(bridge.messages.filter((entry) => entry.multiplayer?.type === 'local_state').length, count + 1);
});

const modelCalls = (bridge) => bridge.calls.filter((call) => call.name === 'mpSetPlayerModel');
const advanceUntil = (bridge, check, limit = 8000) => {
  const end = bridge.now() + limit;
  while (!check() && bridge.now() < end) bridge.tick();
  assert.ok(check(), '有效脚本上下文中应在有限重试窗口内继续处理事务');
};
const lastSample = (bridge) => {
  const value = bridge.messages.filter((entry) => entry.multiplayer?.type === 'local_state').at(-1)?.multiplayer.state;
  return value && JSON.parse(JSON.stringify(value));
};
const recoveringMessages = (bridge) => bridge.messages.filter((entry) => entry.multiplayer?.type === 'game_status'
  && entry.multiplayer.role_recovering === true);
const assertNoBridgeError = (bridge) => assert.ok(!bridge.messages.some((entry) => entry.multiplayer?.type === 'bridge_error'));

test('稳定的脚本换模自动恢复原位置、朝向、武器、服饰与权威血量，不重新随机或出生', () => {
  const bridge = engine({ localModel: 0x0d7114c9 });
  const value = packet({ peers: [], combat: [{ id: 'LOCAL', health: 176, alive: true, revision: 1 }] });
  bridge.connect(value);
  bridge.setPosition([732, -1074, 23]); bridge.setHeading(137); bridge.setWeapon(0x1b06d571); bridge.tick();
  const previous = lastSample(bridge), changes = modelCalls(bridge).length;
  bridge.setLocalPed(19); bridge.setLocalModel(0x0d7114c9);
  bridge.setPosition([298, -584, 43]); bridge.setHeading(5); bridge.setWeapon(0);
  for (let index = 0; index < 10; index++) bridge.tick();
  assert.equal(modelCalls(bridge).length, changes, '不到一秒的替换观察期不能抢着再次换模');
  advanceUntil(bridge, () => modelCalls(bridge).length > changes);
  bridge.tick();
  assert.deepEqual(bridge.position(), previous.position); assert.equal(bridge.heading(), 137);
  assert.equal(bridge.weapon(), 0x1b06d571); assert.equal(bridge.health.get(bridge.localPed()), 188);
  assert.deepEqual(lastSample(bridge).appearance, previous.appearance);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomProps').length, 1);
  assert.ok(bridge.calls.some((call) => call.name === 'mpSetComponent' && call.arguments[0] === bridge.localPed()));
  assert.ok(recoveringMessages(bridge).length); assertNoBridgeError(bridge);
  assert.equal(modelCalls(bridge).length, changes + 1);
  for (let index = 0; index < 10; index++) bridge.tick();
  assert.equal(modelCalls(bridge).length, changes + 1, '成功恢复后不能按每帧反复初始化角色');
});

test('替换后的角色坐标归零仍可利用最后有效在线位置恢复；正常模型坐标无效时不发送伪造状态', () => {
  const recovering = engine(); recovering.connect(packet({ peers: [] }));
  recovering.setPosition([732, -1074, 23]); recovering.setHeading(137); recovering.tick();
  const good = lastSample(recovering), changes = modelCalls(recovering).length;
  recovering.setLocalPed(19); recovering.setLocalModel(0x0d7114c9); recovering.setPosition([0, 0, 0]);
  advanceUntil(recovering, () => modelCalls(recovering).length > changes);
  recovering.tick();
  assert.deepEqual(recovering.position(), good.position);
  assert.equal(lastSample(recovering).model, 0x705e61f2); assertNoBridgeError(recovering);
  const invalid = engine(); invalid.connect();
  const count = invalid.messages.filter((entry) => entry.multiplayer?.type === 'local_state').length;
  invalid.setPosition([0, 0, 0]);
  for (let index = 0; index < 20; index++) invalid.tick();
  assert.equal(invalid.messages.filter((entry) => entry.multiplayer?.type === 'local_state').length, count,
    '模型未被替换时不能把最后在线位置冒充新的本地采样持续发送');
  assert.equal(modelCalls(invalid).length, 0);
  assertNoBridgeError(invalid);
});

test('连续换模 native 无效果时保留三秒冷却，并在后续成功时恢复，不永久停止桥', () => {
  const bridge = engine(); bridge.connect();
  bridge.setModelNoEffect(true); bridge.setLocalModel(0x0d7114c9);
  const attempts = [], start = modelCalls(bridge).length;
  for (let index = 0; index < 160; index++) {
    const before = modelCalls(bridge).length; bridge.tick();
    if (modelCalls(bridge).length > before) attempts.push(bridge.now());
  }
  assert.ok(attempts.length >= 3, '失败后仍应有限频率继续尝试，不能锁死在第一次失败');
  assert.ok(attempts.every((time, index) => index === 0 || time - attempts[index - 1] >= 3000));
  assertNoBridgeError(bridge);
  const previousSamples = bridge.messages.filter((entry) => entry.multiplayer?.type === 'local_state').length;
  bridge.setModelNoEffect(false);
  advanceUntil(bridge, () => bridge.messages.filter((entry) => entry.multiplayer?.type === 'local_state').length > previousSamples);
  assert.ok(modelCalls(bridge).length > start); assert.equal(lastSample(bridge).model, 0x705e61f2);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 1);
  assertNoBridgeError(bridge);
});

test('异步换模完成后采用新句柄，恢复服装且继续上报，不重复调用 native', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [] }));
  const changes = modelCalls(bridge).length, appearance = lastSample(bridge).appearance;
  bridge.setModelAsync(true); bridge.setLocalModel(0x0d7114c9); bridge.setLocalPed(19);
  advanceUntil(bridge, () => modelCalls(bridge).length > changes);
  for (let index = 0; index < 8; index++) bridge.tick();
  assert.equal(modelCalls(bridge).length, changes + 1, '异步事务期间仍受三秒冷却限制');
  bridge.completeModelChange(); bridge.tick();
  assert.equal(lastSample(bridge).model, 0x705e61f2); assert.equal(bridge.localPed(), 8);
  assert.deepEqual(lastSample(bridge).appearance, appearance);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 1);
  assertNoBridgeError(bridge);
});

test('服务端宣布死亡时延后本地模型恢复，统一复活事务完成后才修复角色', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [], combat: [combatPlayer()] }));
  const count = modelCalls(bridge).length;
  bridge.setLocalModel(0x0d7114c9);
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ alive: false, health: 0, revision: 2 })] }));
  for (let index = 0; index < 60; index++) bridge.tick();
  assert.equal(modelCalls(bridge).length, count, '死亡倒计时不能提前换成存活角色或绕过服务器重生');
  assert.equal(bridge.health.get(bridge.localPed()), 0);
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [respawnControl()] }));
  advanceUntil(bridge, () => modelCalls(bridge).length > count);
  assertRecovered(bridge); assert.equal(lastSample(bridge).model, 0x705e61f2);
  assertNoBridgeError(bridge);
});

test('本地角色缺失、稳定换模或模型未加载均不阻塞远端移动与射击确认', () => {
  const setups = [
    { options: {}, prepare: (bridge) => bridge.setLocalPed(0) },
    { options: {}, prepare: (bridge) => { bridge.setLocalModel(0x0d7114c9); bridge.setModelNoEffect(true); } },
    { options: { localModel: 0x0d7114c9, unavailableModels: [0x705e61f2] }, prepare: () => {} },
  ];
  for (const fixture of setups) {
    const bridge = engine(fixture.options);
    const remote = peerState({ model: 0x9c9effd8, weapon: 0 });
    bridge.connect(packet({ peers: [{ player_id: 'REMOTE', state: remote }] }));
    fixture.prepare(bridge);
    const existing = bridge.calls.find((call) => call.name === 'mpCreatePed');
    const previousMoves = bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset').length;
    const moved = { ...remote, position: [713, -1078, 22] };
    bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: moved }], shots: [{ id: 27, player_id: 'REMOTE',
      event: { origin: [710, -1080, 23], target: [715, -1080, 23], weapon: 0x1b06d571 } }] }));
    bridge.tick();
    assert.ok(bridge.calls.some((call) => call.name === 'mpCreatePed'), '本地模型没载入也应创建远端角色');
    const remotePed = bridge.calls.find((call) => call.name === 'mpFreeze').arguments[0];
    assert.ok(bridge.calls.some((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === remotePed));
    assert.ok(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset').length > previousMoves,
      '本地同步等待期间必须继续消费新的远端移动状态');
    if (existing) assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
    assert.ok(bridge.messages.some((entry) => entry.multiplayer?.type === 'shot_ack' && entry.multiplayer.ids.includes(27)));
    assert.ok(bridge.calls.some((call) => call.name === 'mpShootBullet'));
    assertNoBridgeError(bridge);
  }
});

test('小范围移动保留同一实体并关闭瞬移，生命值不变时不会重复写入', () => {
  const bridge = engine(); bridge.connect();
  const ped = bridge.calls.find((call) => call.name === 'mpFreeze').arguments[0];
  const initialMove = bridge.calls.find((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === ped);
  assert.equal(initialMove.arguments[4], 1, '首次放置可以执行瞬移');
  for (let index = 1; index <= 8; index++) {
    bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ position: [710 + index * .2, -1080, 22] }) }] }));
    bridge.tick();
  }
  const moves = bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === ped).slice(1);
  assert.equal(moves.length, 8);
  assert.ok(moves.every((call) => call.arguments[4] === 0), '连续平滑位置更新不得执行完整瞬移');
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpDeletePed').length, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetHealth').length, 0);
  bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ health: 175 }) }] })); bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetHealth').length, 1);
  assert.deepEqual(bridge.calls.filter((call) => call.name === 'mpSetHealth').at(-1).arguments, [ped, 175, 0]);
  bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetHealth').length, 1);
});

test('远端主角模型和单帧自由模式模型抖动不会销毁已创建的角色', () => {
  const bridge = engine(); bridge.connect();
  for (const model of [0x0d7114c9, 0x9c9effd8, 0x705e61f2]) {
    bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ model }) }] })); bridge.tick();
  }
  for (let index = 0; index < 8; index++) bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpDeletePed').length, 0);
  assert.equal(bridge.blips.size, 1);
});

test('持续的自由模式角色变更在 600 ms 确认后只重建一次，并清理旧地图标记', () => {
  const bridge = engine(); bridge.connect();
  bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ model: 0x9c9effd8 }) }] }));
  for (let index = 0; index < 6; index++) bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpDeletePed').length, 0);
  bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 2);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpDeletePed').length, 1);
  assert.equal(bridge.blips.size, 1);
  for (let index = 0; index < 8; index++) bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 2);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpDeletePed').length, 1);
});

test('共享内存中的线程名先复制到普通缓冲区再按浏览器规则解码', () => {
  const bridge = engine();
  new Uint8Array(bridge.memory.buffer, Number(bridge.state.active) + 428, 32)
    .set(new TextEncoder().encode('sandbox'));
  bridge.connect();
  assert.ok(!bridge.messages.some((entry) => entry.multiplayer?.type === 'bridge_error'));
  assert.equal(bridge.messages.find((entry) => entry.multiplayer?.type === 'lifecycle').multiplayer.owner_script, 'sandbox');
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
});

test('目录中的八种在线模型都可稳定初始化和复制，后续状态不会再次随机换衣', async () => {
  const { MODEL_CATALOG, modelForPreset } = await appearanceModule;
  const entries = Object.entries(MODEL_CATALOG).flatMap(([preset, models]) => models.map((model) => ({ preset, ...model })));
  assert.equal(entries.length, 8);
  for (const { preset, hash, name } of entries) {
    let seed = 0;
    while (modelForPreset({ preset, seed }) !== hash && seed < 1000) seed++;
    assert.ok(seed < 1000, name + ' 应能被固定种子选中');
    const bridge = engine({ localModel: 0x0d7114c9 });
    const preferences = packet({ preset, seed, model: hash,
      peers: [{ player_id: 'REMOTE', state: peerState({ model: hash }) }] });
    bridge.connect(preferences);
    for (let index = 0; index < 8; index++) { bridge.publish(preferences); bridge.tick(); }
    assert.deepEqual(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').map((call) => call.arguments),
      [[0, hash | 0]], name + ' 本地只换模一次');
    assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1, name + ' 复制只创建一次');
    assert.equal(bridge.calls.find((call) => call.name === 'mpCreatePed').arguments[1], hash | 0);
    assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 1, name + ' 只随机一次衣服');
    assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomProps').length, 1, name + ' 只随机一次饰品');
    assert.equal(bridge.calls.filter((call) => call.name === 'mpGetDrawable').length, 12);
    assert.equal(bridge.calls.filter((call) => call.name === 'mpGetPropIndex').length, 8);
    assert.ok(!bridge.messages.some((entry) => entry.multiplayer?.type === 'bridge_error'));
  }
});

test('引擎采样的服装和饰品可在远端完整复现，相同外观的后续快照不重复调用 native', () => {
  const origin = engine(); origin.connect(packet({ peers: [] }));
  const sample = origin.messages.find((entry) => entry.multiplayer?.type === 'local_state').multiplayer.state;
  assert.deepEqual(JSON.parse(JSON.stringify(sample.appearance)), captureFixture());
  const replica = engine();
  replica.connect(packet({ peers: [{ player_id: 'REMOTE', state: sample }] }));
  const ped = replica.calls.find((call) => call.name === 'mpFreeze').arguments[0];
  const componentCalls = replica.calls.filter((call) => call.name === 'mpSetComponent' && call.arguments[0] === ped);
  assert.deepEqual(componentCalls.map((call) => call.arguments),
    captureFixture().components.map((parts, index) => [ped, index, ...parts]));
  const propCalls = replica.calls.filter((call) => call.name === 'mpSetProp' && call.arguments[0] === ped);
  assert.deepEqual(propCalls.map((call) => call.arguments), captureFixture().props.flatMap((parts, index) =>
    parts[0] < 0 ? [] : [[ped, index, ...parts, 1]]));
  assert.deepEqual(replica.calls.filter((call) => call.name === 'mpClearProp' && call.arguments[0] === ped)
    .map((call) => call.arguments), captureFixture().props.flatMap((parts, index) => parts[0] < 0 ? [[ped, index]] : []));
  for (let index = 0; index < 8; index++) {
    replica.publish(packet({ peers: [{ player_id: 'REMOTE', state: JSON.parse(JSON.stringify(sample)) }] })); replica.tick();
  }
  assert.equal(replica.calls.filter((call) => call.name === 'mpSetComponent' && call.arguments[0] === ped).length, 12);
  assert.equal(replica.calls.filter((call) => call.name === 'mpSetProp' && call.arguments[0] === ped).length, 4);
  assert.equal(replica.calls.filter((call) => call.name === 'mpClearProp' && call.arguments[0] === ped).length, 4);
  assert.equal(replica.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
});

test('自由模式妆容限制到 native 支持的变体数，采样结果与远端应用值一致', async () => {
  const { randomAppearance } = await appearanceModule;
  const sourceSpec = randomAppearance('freemode_female', 123);
  const origin = engine({ localModel: 0x0d7114c9, overlayCount: 3 });
  origin.connect(packet({ model: 0x9c9effd8, appearance_spec: sourceSpec, peers: [] }));
  const sample = origin.messages.find((entry) => entry.multiplayer?.type === 'local_state').multiplayer.state;
  const cosmetics = JSON.parse(JSON.stringify(sample.appearance));
  assert.equal(cosmetics.overlays.length, 13);
  assert.ok(cosmetics.overlays.every((parts) => parts[0] === 255 || parts[0] < 3));
  const replica = engine({ overlayCount: 3 });
  replica.connect(packet({ peers: [{ player_id: 'REMOTE', state: sample }] }));
  const ped = replica.calls.find((call) => call.name === 'mpFreeze').arguments[0];
  assert.deepEqual(replica.calls.filter((call) => call.name === 'mpSetHeadOverlay' && call.arguments[0] === ped)
    .map((call) => call.arguments), cosmetics.overlays.map((parts, index) => [ped, index, parts[0], parts[1]]));
  assert.deepEqual(replica.calls.filter((call) => call.name === 'mpSetOverlayTint' && call.arguments[0] === ped)
    .map((call) => call.arguments), cosmetics.overlays.map((parts, index) => [ped, index, ...parts.slice(2)]));
  assert.deepEqual(replica.calls.find((call) => call.name === 'mpSetHairTint' && call.arguments[0] === ped).arguments,
    [ped, ...cosmetics.hair]);
  for (let index = 0; index < 8; index++) { replica.publish(packet({ peers: [{ player_id: 'REMOTE', state: sample }] })); replica.tick(); }
  assert.equal(replica.calls.filter((call) => call.name === 'mpSetHeadOverlay' && call.arguments[0] === ped).length, 13);
});

test('普通 NPC 忽略自由模式妆容描述，既不调用头部妆容也不广播妆容片段', async () => {
  const { MODEL_CATALOG, randomAppearance } = await appearanceModule;
  const model = MODEL_CATALOG.npc_male[0].hash;
  const spec = randomAppearance('freemode_male', 10);
  const bridge = engine({ localModel: 0x0d7114c9 });
  bridge.connect(packet({ model, appearance_spec: spec,
    peers: [{ player_id: 'REMOTE', state: peerState({ model, appearance: { ...captureFixture(), ...spec } }) }] }));
  assert.equal(bridge.calls.filter((call) => ['mpSetHeadOverlay', 'mpSetOverlayTint', 'mpSetHairTint'].includes(call.name)).length, 0);
  const appearance = bridge.messages.find((entry) => entry.multiplayer?.type === 'local_state').multiplayer.state.appearance;
  assert.equal(appearance.overlays, undefined); assert.equal(appearance.hair, undefined);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetComponent').length, 12);
});

test('适配器保留未确认射击，后续状态快照不会覆盖丢失；确认后清理', () => {
  const page = adapter();
  page.receive({ type: 'session', connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }, { id: 'REMOTE' }], peers: [] });
  page.receive({ type: 'shot_event', player_id: 'REMOTE', event: { seq: 1, target: [1, 2, 3], origin: [0, 0, 0], weapon: 10 } });
  page.flush(); const shotId = page.read().shots[0].id;
  page.receive({ type: 'player_state', player_id: 'REMOTE', state: peerState() }); page.flush();
  assert.equal(page.read().shots[0].id, shotId);
  page.api.onWorkerMessage({ multiplayer: { type: 'shot_ack', ids: [shotId] } }); page.flush();
  assert.equal(page.read().shots.length, 0);
});

test('生命周期变化写入本地日志，重复诊断不反复请求也不写入网络状态通道', () => {
  const page = adapter();
  const value = { type: 'lifecycle', avatar_changes: 1, replica_creates: 1, replica_removals: 0,
    owner_script: 'sandbox', reason: 'create' };
  const before = page.requests.length;
  const postsBefore = page.channels[0].posts.length;
  page.api.onWorkerMessage({ multiplayer: value });
  page.api.onWorkerMessage({ multiplayer: value });
  assert.equal(page.requests.length, before, 'normal diagnostics wait for their batch');
  page.flush();
  assert.equal(page.requests.length, before + 1);
  assert.equal(page.requests.at(-1).url, '/log');
  const report = page.requests.at(-1).body.split('\n').map(line => JSON.parse(line.slice('[public-client] '.length))).find(report => report.phase === 'lifecycle');
  assert.equal(report.phase, 'lifecycle');
  assert.equal(report.replica_creates, 1);
  assert.equal(page.channels[0].posts.length, postsBefore);
});

test('新序号快照重复包含同一射击时只调用一次 native，并再次确认', () => {
  const bridge = engine();
  const value = packet({ shots: [{ id: 1, player_id: 'REMOTE', event: {
    origin: [710, -1080, 22], target: [715, -1080, 22], weapon: 0x1b06d571 } }] });
  bridge.connect(value); bridge.publish(value); bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpTaskShootAtCoord').length, 0, '视觉转播不得再次执行实弹开火任务');
  assert.equal(bridge.calls.filter((call) => call.name === 'mpTaskAimGunAtCoord').length, 1);
  assert.equal(bridge.messages.filter((message) => message.multiplayer?.type === 'shot_ack').length, 2);
});

test('远端复制角色先设置无敌，普通枪转播 native 的伤害值为零且同一事件只播放一次', () => {
  const bridge = engine();
  const value = packet({ shots: [{ id: 1, player_id: 'REMOTE', event: {
    origin: [710, -1080, 22], target: [715, -1080, 22], weapon: 0x1b06d571 } }] });
  bridge.connect(value);
  const ped = bridge.calls.find((call) => call.name === 'mpFreeze').arguments[0];
  assert.ok(bridge.invincible.has(ped));
  assert.deepEqual(bridge.calls.find((call) => call.name === 'mpSetInvincible' && call.arguments[0] === ped).arguments, [ped, 1]);
  bridge.hit(ped, 500); // 受控物理替身遵循引擎设置的无敌标志，不代表实机伤害测试。
  assert.equal(bridge.health.get(ped), 200);
  assert.ok(!bridge.dead.has(ped));
  const visual = bridge.calls.filter((call) => call.name === 'mpShootBullet');
  assert.equal(visual.length, 1);
  assert.deepEqual(visual[0].arguments.slice(2), [0, 1, 0x1b06d571 | 0, ped, 1, 0, -1]);
  bridge.publish(value); bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpShootBullet').length, 1);
});

test('零伤害可视枪击仅允许普通枪，火箭、手雷和未知武器均不创建原生弹丸', async () => {
  const { joaat } = await appearanceModule;
  for (const weapon of [joaat('weapon_rpg'), joaat('weapon_hominglauncher'), joaat('weapon_grenade'), 0xffffffff]) {
    const bridge = engine();
    bridge.connect(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ weapon: 0 }) }],
      shots: [{ id: 1, player_id: 'REMOTE', event: { origin: [710, -1080, 22], target: [715, -1080, 22], weapon } }] }));
    assert.equal(bridge.calls.filter((call) => call.name === 'mpShootBullet').length, 0);
    assert.equal(bridge.calls.filter((call) => call.name === 'mpTaskShootAtCoord').length, 0);
    assert.equal(bridge.calls.filter((call) => call.name === 'mpRequestWeaponAsset').length, 0);
    assert.ok(bridge.messages.some((entry) => entry.multiplayer?.type === 'shot_ack'));
  }
});

test('普通枪资源未就绪时保留本次轨迹且不确认，资源就绪后播放同一发并确认', () => {
  const bridge = engine({ weaponAssetReady: false });
  const event = { origin: [710, -1080, 22], target: [715, -1080, 22], weapon: 0x1b06d571 };
  bridge.connect(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ weapon: 0 }) }],
    shots: [{ id: 1, player_id: 'REMOTE', event }] }));
  assert.equal(bridge.calls.filter((call) => call.name === 'mpShootBullet').length, 0);
  assert.deepEqual(bridge.calls.filter((call) => call.name === 'mpRequestWeaponAsset').map((call) => call.arguments),
    [[0x1b06d571 | 0, 31, 0]]);
  assert.equal(bridge.messages.filter(m => m.multiplayer?.type === 'shot_ack').length, 0);
  bridge.setWeaponAssetReady(true);
  bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpShootBullet').length, 1);
  assert.ok(bridge.messages.some(m => m.multiplayer?.type === 'shot_ack' && m.multiplayer.ids.includes(1)));
  bridge.publish(packet({ shots: [{ id: 1, player_id: 'REMOTE', event }] })); bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpShootBullet').length, 1);
});

test('本地生命值遵从服务端权威且只在不同值时写入，死亡后活跃状态可恢复原生角色', () => {
  const bridge = engine();
  bridge.connect(packet({ peers: [], combat: [{ id: 'LOCAL', health: 175, alive: true }] }));
  const ped = bridge.localPed();
  assert.equal(bridge.health.get(ped), 188);
  assert.ok(bridge.invincible.has(ped));
  for (let index = 0; index < 8; index++) bridge.tick();
  assert.deepEqual(bridge.calls.filter((call) => call.name === 'mpSetHealth').map((call) => call.arguments), [[ped, 188, 0]]);
  bridge.publish(packet({ peers: [], combat: [{ id: 'LOCAL', health: 0, alive: false }] })); bridge.tick();
  assert.ok(!bridge.invincible.has(ped)); assert.ok(bridge.dead.has(ped));
  assert.equal(bridge.health.get(ped), 0);
  bridge.publish(packet({ peers: [], combat: [{ id: 'LOCAL', health: 200, alive: true }] })); bridge.tick();
  assert.equal(bridge.health.get(ped), 200); assert.ok(!bridge.dead.has(ped));
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrect').length, 0);
  for (const name of ['mpRevive', 'mpClearTasksImmediately']) {
    assert.deepEqual(bridge.calls.filter((call) => call.name === name).map((call) => call.arguments), [[ped]]);
  }
  for (let index = 0; index < 8; index++) bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetHealth').length, 3);
});

test('远端死亡以 combat 权威覆盖客户端健康，解除冻结后不持续瞬移尸体，复活恢复同一实体一次', () => {
  const bridge = engine(); bridge.connect();
  const ped = bridge.calls.find((call) => call.name === 'mpFreeze').arguments[0];
  const flushesAtCreation = bridge.calls.filter((call) => call.name === 'mpClearTasksImmediately').length;
  const movesBefore = bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === ped).length;
  bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ health: 200, position: [713, -1080, 22] }) }],
    combat: [{ id: 'REMOTE', health: 0, alive: false }] })); bridge.tick();
  assert.equal(bridge.health.get(ped), 0); assert.ok(!bridge.invincible.has(ped));
  assert.deepEqual(bridge.calls.filter((call) => call.name === 'mpFreeze' && call.arguments[0] === ped).at(-1).arguments, [ped, 0]);
  for (let index = 0; index < 8; index++) bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === ped).length, movesBefore);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetHealth' && call.arguments[0] === ped && call.arguments[1] === 0).length, 1);
  bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ position: [713, -1080, 22] }) }],
    combat: [{ id: 'REMOTE', health: 200, alive: true }] })); bridge.tick();
  assert.equal(bridge.health.get(ped), 200); assert.ok(bridge.invincible.has(ped));
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
  for (const name of ['mpResurrect', 'mpRevive']) {
    assert.deepEqual(bridge.calls.filter((call) => call.name === name).map((call) => call.arguments), [[ped]]);
  }
  assert.equal(bridge.calls.filter((call) => call.name === 'mpClearTasksImmediately').length, flushesAtCreation + 1);
  for (let index = 0; index < 8; index++) bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrect').length, 1);
});

test('服务器仍存活的远端被单机独立击杀或倒地时恢复同一替身，本人生命与位置不受影响', () => {
  const bridge = engine();
  const value = packet({ combat: [{ id: 'REMOTE', health: 200, alive: true, revision: 1 }] });
  bridge.connect(value);
  const ped = [...bridge.equippedWeapons.keys()][0], localPosition = bridge.position();
  bridge.dead.add(ped); bridge.health.set(ped, 0); bridge.ragdoll.add(ped);
  bridge.tick();
  assert.ok(!bridge.dead.has(ped)); assert.equal(bridge.health.get(ped), 200);
  assert.ok(!bridge.ragdoll.has(ped)); assert.equal(bridge.ragdollAllowed.get(ped), false);
  assert.ok(bridge.invincible.has(ped));
  assert.equal(bridge.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 0);
  assert.deepEqual(bridge.position(), localPosition);
  assert.equal(bridge.health.get(bridge.localPed()), 200);
  const restores = bridge.calls.filter((call) => call.name === 'mpResurrect').length;
  bridge.ragdoll.add(ped); bridge.health.set(ped, 180); bridge.tick();
  assert.ok(!bridge.ragdoll.has(ped)); assert.equal(bridge.health.get(ped), 200);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrect').length, restores);
});

test('远端复活原生事务失败时限频重试，成功后旧死亡快照不能让替身再倒地', () => {
  const bridge = engine();
  bridge.connect(packet({ combat: [{ id: 'REMOTE', health: 0, alive: false, revision: 2 }] }));
  const ped = [...bridge.alive].find((id) => id !== bridge.localPed());
  assert.ok(bridge.dead.has(ped)); assert.equal(bridge.ragdollAllowed.get(ped), true);
  bridge.setRemoteRecoveryBlocked(true);
  bridge.publish(packet({ combat: [{ id: 'REMOTE', health: 200, alive: true, revision: 3 }] })); bridge.tick();
  const attempt = bridge.calls.filter((call) => call.name === 'mpResurrect').length;
  for (let index = 0; index < 3; index++) bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrect').length, attempt);
  bridge.setRemoteRecoveryBlocked(false); bridge.tick(bridge.now() + 500);
  assert.ok(!bridge.dead.has(ped)); assert.equal(bridge.ragdollAllowed.get(ped), false);
  bridge.publish(packet({ combat: [{ id: 'REMOTE', health: 0, alive: false, revision: 2 }] })); bridge.tick();
  assert.ok(!bridge.dead.has(ped)); assert.equal(bridge.health.get(ped), 200);
});

test('服务器死亡不能被旧存活快照或旧重生控制覆盖，本地与远端都服从同一版本', () => {
  const bridge = engine(); bridge.connect(packet({ combat: [combatPlayer()] }));
  const values = [combatPlayer({ health: 0, alive: false, revision: 4 }),
    { id: 'REMOTE', health: 0, alive: false, revision: 4 }];
  bridge.publish(packet({ combat: values })); bridge.tick();
  const remote = [...bridge.alive].find((id) => id !== bridge.localPed());
  assert.ok(bridge.dead.has(bridge.localPed())); assert.ok(bridge.dead.has(remote));
  bridge.publish(packet({ combat: [combatPlayer({ revision: 3 }), { id: 'REMOTE', health: 200, alive: true, revision: 3 }],
    controls: [respawnControl(80, { revision: 3 })] })); bridge.tick();
  assert.ok(bridge.dead.has(bridge.localPed())); assert.ok(bridge.dead.has(remote));
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 0);
});

test('本地被单机意外击杀但服务器存活时恢复最后在线位置，不自动送回出生点', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [], combat: [combatPlayer({ health: 150, kills: 2, revision: 3 })] }));
  bridge.setPosition([735, -1075, 23]); bridge.setHeading(220); bridge.tick();
  bridge.dead.add(bridge.localPed()); bridge.health.set(bridge.localPed(), 0); bridge.tick();
  assert.ok(!bridge.dead.has(bridge.localPed())); assert.equal(bridge.health.get(bridge.localPed()), 175);
  assert.deepEqual(bridge.position(), [735, -1075, 23]); assert.equal(bridge.heading(), 220);
  bridge.tick(bridge.now() + 1100);
  const status = bridge.messages.filter((message) => message.multiplayer?.type === 'game_status').at(-1).multiplayer;
  assert.equal(status.kills, 2); assert.equal(status.revision, 3);
});

test('适配器按战斗版本合并事件，旧全量快照不倒退，等序号的服务端生命更新仍接收', () => {
  const page = adapter(directNetwork());
  page.receive({ type: 'session', connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }, { id: 'REMOTE' }],
    combat: [combatPlayer(), { id: 'REMOTE', health: 200, alive: true, revision: 1 }],
    peers: [{ player_id: 'REMOTE', state: peerState({ seq: 10 }) }] });
  page.receive({ type: 'death', player_id: 'REMOTE', revision: 2 }); page.flush();
  assert.equal(page.read().combat.find((value) => value.id === 'REMOTE').alive, false);
  page.receive({ type: 'combat_state', players: [{ id: 'REMOTE', alive: true, health: 200, revision: 1 }] });
  page.receive({ type: 'player_state', player_id: 'REMOTE', state: peerState({ seq: 10, health: 0, alive: false }) });
  page.flush(); assert.equal(page.read().combat.find((value) => value.id === 'REMOTE').alive, false);
  assert.equal(page.read().peers[0].state.health, 0);
  const controls = page.read().controls.length;
  page.receive({ type: 'respawn', player_id: 'REMOTE', revision: 1, health: 200, position: [711, -1088, 22] });
  page.receive({ type: 'player_state', player_id: 'REMOTE', state: peerState({ seq: 9, position: [800, -800, 23] }) });
  page.flush(); assert.equal(page.read().controls.length, controls); assert.equal(page.read().peers[0].state.seq, 10);
  page.receive({ type: 'respawn', player_id: 'REMOTE', revision: 3, health: 200, position: [711, -1088, 22] });
  page.flush(); assert.equal(page.read().combat.find((value) => value.id === 'REMOTE').alive, true);
});

test('服务器武器规则传入引擎，原生连射采样服从100毫秒冷却并留发送余量', () => {
  const bridge = engine({ localWeapon: 0x13532244, noClip: true });
  const rules = [{ weapon: 0x13532244, cooldown_ms: 100, damage: 35 }];
  bridge.connect(packet({ peers: [], weapon_rules: rules })); bridge.setShooting(true);
  for (let index = 0; index < 10; index++) bridge.tick();
  const shots = bridge.messages.filter((message) => message.multiplayer?.type === 'local_shot');
  assert.ok(shots.length >= 3 && shots.length <= 7);
  const page = adapter(directNetwork()); page.receive({ type: 'session', connected: true, client_id: 'LOCAL',
    members: [{ id: 'LOCAL' }], weapon_rules: rules }); page.flush();
  assert.deepEqual(page.read().weapon_rules, rules);
});

test('复活控制跨共享快照重发只执行一次固定点放置，并对重发继续确认', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [] }));
  const ped = bridge.localPed();
  bridge.health.set(ped, 0); bridge.dead.add(ped);
  const value = packet({ peers: [], combat: [{ id: 'LOCAL', health: 200, alive: true }],
    controls: [{ id: 7, event: { type: 'respawn', player_id: 'LOCAL', position: [711.5, -1088.1, 22.4], heading: 90 } }] });
  const movesBefore = bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === ped).length;
  bridge.publish(value); bridge.tick();
  bridge.publish(value); bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrect').length, 0);
  for (const name of ['mpRevive', 'mpClearTasksImmediately']) {
    assert.deepEqual(bridge.calls.filter((call) => call.name === name).map((call) => call.arguments), [[ped]]);
  }
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === ped).length, movesBefore + 1);
  assert.ok(Math.abs(bridge.position()[0] - 711.5) < .001);
  assert.ok(Math.abs(bridge.position()[1] + 1088.1) < .001);
  assert.equal(bridge.health.get(ped), 200);
  assert.equal(bridge.messages.filter((entry) => entry.multiplayer?.type === 'control_ack').length, 2);
});

test('暂时断线再恢复同一身份不重复本地换模、服饰随机或出生放置', () => {
  const bridge = engine({ localModel: 0x0d7114c9 }); bridge.connect(packet({ peers: [] }));
  const ped = bridge.localPed();
  const correction = packet({ peers: [], controls: [{ id: 3, event: { type: 'correction', position: [735, -1075, 23], heading: 120 } }] });
  bridge.publish(correction); bridge.tick();
  const movesBefore = bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === ped).length;
  bridge.publish(packet({ connected: false, peers: [] })); bridge.tick();
  bridge.publish(packet({ peers: [] })); bridge.tick();
  for (let index = 0; index < 8; index++) bridge.tick();
  assert.deepEqual(bridge.position(), [735, -1075, 23]);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomProps').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset' && call.arguments[0] === ped).length, movesBefore);
});

test('新页面的有效恢复位置用于首次放置，非法恢复位置回落固定测试点', () => {
  const resume = engine(); resume.connect(packet({ peers: [], resume_position: [735, -1075, 23] }));
  assert.deepEqual(resume.position(), [735, -1075, 23]);
  const invalid = engine(); invalid.connect(packet({ peers: [], resume_position: [17000, -1075, 23] }));
  assert.ok(Math.abs(invalid.position()[0] - 711.5) < .001);
  assert.ok(Math.abs(invalid.position()[1] + 1088.1) < .001);
});

test('刷新恢复完整外观、模型、位置与朝向，后续快照不再次随机换装', () => {
  const appearance = { ...captureFixture(),
    overlays: Array.from({ length: 13 }, () => [255, 0, 0, 0, 0]), hair: [7, 12] };
  const state = peerState({ position: [735, -1075, 23], heading: 220, model: 0x9c9effd8, appearance });
  const restored = packet({ peers: [], model: 0x0d7114c9,
    resumed: true, resume_state_ready: true, resume_state: state });
  const bridge = engine({ localModel: 0x0d7114c9 }); bridge.connect(restored);
  const ped = bridge.localPed();
  assert.deepEqual(bridge.position(), state.position);
  assert.deepEqual(bridge.calls.filter((call) => call.name === 'mpSetHeading').at(-1).arguments, [ped, 220]);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomProps').length, 0);
  assert.deepEqual(bridge.calls.filter((call) => call.name === 'mpSetComponent').map((call) => call.arguments),
    appearance.components.map((part, index) => [ped, index, ...part]));
  assert.deepEqual(bridge.calls.filter((call) => call.name === 'mpSetHairTint').at(-1).arguments, [ped, 7, 12]);
  const published = bridge.messages.find((message) => message.multiplayer?.type === 'local_state').multiplayer.state;
  assert.deepEqual(JSON.parse(JSON.stringify(published.appearance)), appearance);
  bridge.setPosition([737, -1075, 23]);
  for (let index = 0; index < 8; index++) { bridge.publish(restored); bridge.tick(); }
  assert.deepEqual(bridge.position(), [737, -1075, 23]);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetComponent').length, 12);
});

test('恢复首份世界快照前不随机服饰、不放置或上报初始坐标', () => {
  const bridge = engine();
  bridge.connect(packet({ peers: [], resumed: true, resume_state_ready: false }));
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset').length, 0);
  assert.equal(bridge.messages.filter((message) => message.multiplayer?.type === 'local_state').length, 0);
  bridge.publish(packet({ peers: [], resumed: true, resume_state_ready: true, resume_state: null }));
  bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 1);
  assert.ok(bridge.messages.some((message) => message.multiplayer?.type === 'local_state'));
});

test('主动新加入忽略旧恢复外观，使用新的角色选择', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [], resumed: false,
    resume_state_ready: true, resume_state: peerState({ model: 0x9c9effd8, appearance: captureFixture() }) }));
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').length, 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 1);
});

test('刷新加载期间收到权威重生或位置纠正，不再被旧恢复坐标覆盖', () => {
  for (const type of ['respawn', 'correction']) {
    const destination = [713.5, -1088.1, 22.4];
    const bridge = engine(); bridge.connect(packet({ peers: [], resumed: true, resume_state_ready: true,
      resume_state: peerState({ position: [800, -900, 25] }),
      controls: [{ id: 1, event: { type, player_id: 'LOCAL', position: destination, heading: 175,
        health: 200, revision: 2 } }] }));
    assert.ok(bridge.position().every((number, index) => Math.abs(number - destination[index]) < .001));
    assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset').length, 1);
    const local = bridge.messages.find((message) => message.multiplayer?.type === 'local_state').multiplayer.state;
    assert.ok(local.position.every((number, index) => Math.abs(number - destination[index]) < .001));
  }
});

test('刷新本地角色需复活而服务器玩家仍存活时，在原位置恢复而不送回出生点', () => {
  const destination = [735, -1075, 23];
  const bridge = engine({ localHealth: 0 });
  bridge.dead.add(bridge.localPed());
  bridge.connect(packet({ peers: [], resumed: true, resume_state_ready: true,
    resume_state: peerState({ position: destination, heading: 220 }),
    combat: [{ id: 'LOCAL', alive: true, health: 170, revision: 3, spawn: [713.5, -1088.1, 22.4] }] }));
  assert.deepEqual(bridge.position(), destination);
  assert.equal(bridge.health.get(bridge.localPed()), 185);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetCoordsNoOffset').length, 1);
  assert.deepEqual(bridge.calls.filter((call) => call.name === 'mpSetHeading').at(-1).arguments, [bridge.localPed(), 220]);
});

test('适配器将恢复标志及完整服务器角色状态交给当前引擎', () => {
  const page = adapter(directNetwork());
  const state = peerState({ seq: 42, position: [735, -1075, 23], appearance: captureFixture() });
  page.receive({ type: 'session', connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }],
    resumed: true, resume_state_ready: true, resume_state: state }); page.flush();
  assert.equal(page.read().resumed, true);
  assert.equal(page.read().resume_state_ready, true);
  assert.deepEqual(page.read().resume_state, state);
});

test('离线成员的旧 peer 状态不得创建或反复重建实体，再上线才允许重新创建', () => {
  const members = [{ id: 'LOCAL', connected: true }, { id: 'REMOTE', connected: false }];
  const fresh = engine(); fresh.connect(packet({ members }));
  for (let index = 0; index < 8; index++) fresh.tick();
  assert.equal(fresh.calls.filter((call) => call.name === 'mpCreatePed').length, 0);
  const connected = engine(); connected.connect();
  connected.publish(packet({ members })); connected.tick();
  for (let index = 0; index < 8; index++) { connected.publish(packet({ members })); connected.tick(); }
  assert.equal(connected.calls.filter((call) => call.name === 'mpCreatePed').length, 1);
  assert.equal(connected.calls.filter((call) => call.name === 'mpDeletePed').length, 1);
  assert.equal(connected.blips.size, 0);
  connected.publish(packet({ members: members.map((member) => ({ ...member, connected: true })) })); connected.tick();
  assert.equal(connected.calls.filter((call) => call.name === 'mpCreatePed').length, 2);
  assert.equal(connected.blips.size, 1);
});

test('适配器控制队列跨 combat 和玩家快照保留事件，确认只移除对应事件且重复确认无害', () => {
  const page = adapter();
  page.receive({ type: 'session', connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }], peers: [] });
  page.receive({ type: 'respawn', player_id: 'LOCAL', position: [711.5, -1088.1, 22.4] }); page.flush();
  const first = page.read().controls[0].id;
  page.receive({ type: 'correction', position: [735, -1075, 23] });
  page.receive({ type: 'combat_state', players: [{ id: 'LOCAL', health: 200, alive: true }] });
  page.receive({ type: 'player_state', player_id: 'REMOTE', state: peerState() }); page.flush();
  const ids = page.read().controls.map((control) => control.id);
  assert.equal(ids.length, 2); assert.equal(ids[0], first);
  assert.equal(page.read().combat[0].health, 200);
  page.api.onWorkerMessage({ multiplayer: { type: 'control_ack', ids: [first] } }); page.flush();
  assert.deepEqual(page.read().controls.map((control) => control.id), [ids[1]]);
  page.api.onWorkerMessage({ multiplayer: { type: 'control_ack', ids: [first] } }); page.flush();
  assert.deepEqual(page.read().controls.map((control) => control.id), [ids[1]]);
  page.api.onWorkerMessage({ multiplayer: { type: 'control_ack', ids: [ids[1]] } }); page.flush();
  assert.equal(page.read().controls.length, 0);
});

const combatPlayer = (changes = {}) => ({ id: 'LOCAL', health: 200, alive: true, revision: 1,
  spawn: [711.5, -1088.1, 22.4], kills: 0, deaths: 0, ...changes });
const respawnControl = (id = 51, changes = {}) => ({ id, event: { type: 'respawn', player_id: 'LOCAL',
  position: [711.5, -1088.1, 22.4], heading: 90, health: 200, revision: 3, ...changes } });
function enterDeath(bridge) {
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ health: 0, alive: false, revision: 2 })] }));
  bridge.tick();
  bridge.state.fadedOut = true; bridge.state.controlsEnabled = false; bridge.state.gamePlaying = false;
}
function assertRecovered(bridge) {
  const ped = bridge.localPed();
  assert.ok(ped, '服务端复活后应重新获得本地角色句柄');
  assert.ok(!bridge.dead.has(ped), '不能只恢复网络坐标，角色实体也应恢复');
  assert.equal(bridge.state.deathState, false, '必须退出原生玩家死亡状态，PED 复活无法完成这个事务');
  assert.equal(bridge.state.fadedOut, false, '复活事务应恢复屏幕');
  assert.equal(bridge.state.controlsEnabled, true, '复活事务应恢复玩家控制');
  assert.equal(bridge.state.gamePlaying, true, '复活事务必须退出单机医院重启状态');
  assert.equal(bridge.health.get(ped), 200);
  assert.ok(Math.abs(bridge.position()[0] - 711.5) < .001);
  assert.ok(Math.abs(bridge.position()[1] + 1088.1) < .001);
  assert.ok(!bridge.messages.some((entry) => entry.multiplayer?.type === 'bridge_error'));
}

test('死亡期间坐标归零仍消费复活快照，恢复玩家状态、摄像机和控制', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [], combat: [combatPlayer()] }));
  enterDeath(bridge); bridge.setPosition([0, 0, 0]);
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [respawnControl()] }));
  bridge.tick();
  assertRecovered(bridge);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 1);
  assert.ok(bridge.messages.some((entry) => entry.multiplayer?.type === 'control_ack' && entry.multiplayer.ids.includes(51)));
});

test('没有本地角色时仍接收战局与复活命令，角色恢复后消费命令而不调用空角色 native', () => {
  const bridge = engine({ localPed: 0, localPosition: [0, 0, 0] });
  bridge.setup();
  bridge.connect(packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [respawnControl()] }));
  assert.equal(bridge.localPed(), 0);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 0,
    '真实 native 的 FindPlayerPed 没有空指针保护，必须等待角色出现');
  assert.ok(!bridge.messages.some((entry) => entry.multiplayer?.type === 'control_ack' && entry.multiplayer.ids.includes(51)));
  bridge.setLocalPed(7); bridge.tick();
  assertRecovered(bridge);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 1);
  assert.equal(bridge.calls.filter((call) => ['mpResurrect', 'mpRevive'].includes(call.name) && call.arguments[0] === 0).length, 0);
});

test('死亡后角色句柄消失也能恢复，复活指令跨缺失窗口保留到原生事务成功再确认', () => {
  const bridge = engine({ localRecoveryBlocked: true });
  bridge.connect(packet({ peers: [], combat: [combatPlayer()] })); enterDeath(bridge);
  bridge.setLocalPed(0); bridge.setPosition([0, 0, 0]);
  const value = packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [respawnControl()] });
  bridge.publish(value); bridge.tick();
  assert.equal(bridge.localPed(), 0);
  assert.ok(!bridge.messages.some((entry) => entry.multiplayer?.type === 'control_ack' && entry.multiplayer.ids.includes(51)),
    '原生复活没有产生玩家句柄时不能提前确认，适配器否则会丢掉唯一复活命令');
  bridge.setLocalPed(7); bridge.tick();
  assert.ok(!bridge.messages.some((entry) => entry.multiplayer?.type === 'control_ack' && entry.multiplayer.ids.includes(51)),
    '有句柄但 native 仍报告死亡时也不能只凭生命值写入就确认');
  bridge.setLocalRecoveryBlocked(false);
  bridge.tick(bridge.now() + 1000);
  assertRecovered(bridge);
  assert.ok(bridge.messages.some((entry) => entry.multiplayer?.type === 'control_ack' && entry.multiplayer.ids.includes(51)));
});

test('复活事件优先于旧 revision 的死亡快照，同一发布批次不能先复活再杀死', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [], combat: [combatPlayer()] })); enterDeath(bridge);
  const zerosBefore = bridge.calls.filter((call) => call.name === 'mpSetHealth' && call.arguments[1] === 0).length;
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ health: 0, alive: false, revision: 2 })],
    controls: [respawnControl()] })); bridge.tick();
  assertRecovered(bridge);
  for (let index = 0; index < 5; index++) bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetHealth' && call.arguments[1] === 0).length, zerosBefore);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 1);
});

test('单独复活事件丢失时，combat 的存活转换和固定出生点能完成恢复', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [], combat: [combatPlayer()] })); enterDeath(bridge);
  bridge.setPosition([0, 0, 0]);
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [] })); bridge.tick();
  assertRecovered(bridge);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 1);
});

test('复活期间恢复主角模型仅在该事务中修复一次，并继续发布在线角色状态', () => {
  const bridge = engine({ resurrectionModel: 0x0d7114c9 });
  bridge.connect(packet({ peers: [], combat: [combatPlayer()] })); enterDeath(bridge);
  const value = packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [respawnControl()] });
  bridge.publish(value); bridge.tick();
  assertRecovered(bridge);
  for (let index = 0; index < 8; index++) { bridge.publish(value); bridge.tick(); }
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').length, 1,
    '重生后模型修复必须是一次事务，不能按每个快照持续换模');
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 1,
    '模型修复必须沿用已捕获的服装，不得每次重生再随机');
  const samples = bridge.messages.filter((entry) => entry.multiplayer?.type === 'local_state').map((entry) => entry.multiplayer.state);
  assert.equal(samples.at(-1).model, 0x705e61f2);
});

test('已成功重生后旧 revision 的医院纠正不得覆盖固定出生点，新纠正仍可执行', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [], combat: [combatPlayer()] })); enterDeath(bridge);
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [respawnControl()] })); bridge.tick();
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [{ id: 52,
    event: { type: 'correction', player_id: 'LOCAL', position: [298, -584, 43], heading: 0, revision: 2 } }] })); bridge.tick();
  assertRecovered(bridge);
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [{ id: 53,
    event: { type: 'correction', player_id: 'LOCAL', position: [720, -1090, 22.4], heading: 120, revision: 3 } }] })); bridge.tick();
  assert.ok(Math.abs(bridge.position()[0] - 720) < .001);
  assert.ok(Math.abs(bridge.position()[1] + 1090) < .001);
});

test('复活后的单机延迟淡出被限频恢复，普通存活帧不反复淡入或复活', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [], combat: [combatPlayer()] })); enterDeath(bridge);
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [respawnControl()] })); bridge.tick();
  const fadesBefore = bridge.calls.filter((call) => call.name === 'mpScreenFadeIn').length;
  for (let index = 0; index < 5; index++) bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpScreenFadeIn').length, fadesBefore,
    '没有黑屏时不应按每帧干预摄像机');
  bridge.state.fadedOut = true; bridge.state.controlsEnabled = false; bridge.state.gamePlaying = false;
  bridge.tick();
  assertRecovered(bridge);
  const correctedFades = bridge.calls.filter((call) => call.name === 'mpScreenFadeIn').length;
  assert.equal(correctedFades, fadesBefore + 1);
  bridge.state.fadedOut = true; bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpScreenFadeIn').length, correctedFades,
    '延迟淡出修复应限频，不能每帧与单机脚本抢屏幕状态');
  bridge.tick(bridge.now() + 500);
  assert.equal(bridge.state.fadedOut, false);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 1);
});

test('新的服务端死亡 revision 仍可击杀已重生玩家，第二次复活仅执行一次且保留服装', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [], combat: [combatPlayer()] })); enterDeath(bridge);
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [respawnControl()] })); bridge.tick();
  assertRecovered(bridge);
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ health: 0, alive: false, revision: 4 })] })); bridge.tick();
  assert.ok(bridge.dead.has(bridge.localPed()), '旧复活覆盖状态不能压住更新的服务端死亡');
  const next = packet({ peers: [], combat: [combatPlayer({ revision: 5 })], controls: [respawnControl(52, { revision: 5 })] });
  bridge.publish(next); bridge.tick(); assertRecovered(bridge);
  for (let index = 0; index < 5; index++) { bridge.publish(next); bridge.tick(); }
  assert.equal(bridge.calls.filter((call) => call.name === 'mpResurrectLocalPlayer').length, 2);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpRandomComponents').length, 1);
  assert.equal(bridge.calls.filter((call) => call.name === 'mpSetPlayerModel').length, 0);
});

test('公共战局仅暂停一次单机死亡重启，暂停发生于服务端死亡写入之前且断线不重复初始化', () => {
  const bridge = engine(); bridge.connect(packet({ peers: [], combat: [combatPlayer()] })); enterDeath(bridge);
  assert.equal(bridge.state.deathRestartPaused, true);
  const pause = bridge.calls.findIndex((call) => call.name === 'mpPauseDeathRestart');
  const death = bridge.calls.findIndex((call) => call.name === 'mpSetHealth' && call.arguments[1] === 0);
  assert.ok(pause >= 0 && pause < death, '应先阻止单机医院重启再写入死亡生命值');
  bridge.publish(packet({ connected: false, peers: [] })); bridge.tick();
  bridge.publish(packet({ peers: [], combat: [combatPlayer({ revision: 3 })], controls: [respawnControl()] })); bridge.tick();
  assert.equal(bridge.calls.filter((call) => call.name === 'mpPauseDeathRestart').length, 1);
  assertRecovered(bridge);
});

const noticeAcknowledged = (bridge, id) => bridge.messages.some((entry) => entry.multiplayer?.type === 'notice_ack'
  && entry.multiplayer.ids?.includes(id));

test('原生战局通知以独立 NUL 终止 UTF-8 构造，成功后确认，重发相同 ID 只展示一次', () => {
  const bridge = engine();
  const text = '公共戰局已連線，玩家「阿麗雅」加入了遊戲。';
  const value = packet({ peers: [], notices: [{ id: 81, text }] });
  bridge.connect(value);
  advanceUntil(bridge, () => noticeAcknowledged(bridge, 81));
  assert.equal(bridge.notifications.length, 1);
  const notification = bridge.notifications[0];
  assert.equal(notification.command.text, 'STRING');
  assert.equal(notification.parts.map((part) => part.text).join(''), text);
  assert.ok(notification.parts.every((part) => part.pointer !== notification.command.pointer));
  assert.deepEqual(notification.parts.flatMap((part) => part.bytes), [...new TextEncoder().encode(text)]);
  const calls = bridge.calls.filter((call) => ['mpBeginTheFeedPost', 'mpAddTextPlayerSubstring', 'mpEndTheFeedPostTicker'].includes(call.name));
  assert.equal(calls[0].name, 'mpBeginTheFeedPost'); assert.equal(calls.at(-1).name, 'mpEndTheFeedPostTicker');
  assert.ok(bridge.messages.some((entry) => entry.multiplayer?.type === 'native_hud' && entry.multiplayer.available === true));
  for (let index = 0; index < 20; index++) { bridge.publish(value); bridge.tick(); }
  assert.equal(bridge.notifications.length, 1, '跨共享快照重发不能产生重复通知');
  assertNoBridgeError(bridge);
});

test('原生通知缺失、返回 -1 或抛异常时不确认、不停止角色同步', () => {
  for (const options of [{ noNativeNotices: true }, { noticeResult: -1 }, { noticeThrows: true }]) {
    const bridge = engine(options);
    bridge.connect(packet({ peers: [], notices: [{ id: 82, text: '原生通知失败仍应同步角色' }] }));
    const before = bridge.messages.filter((entry) => entry.multiplayer?.type === 'local_state').length;
    for (let index = 0; index < 20; index++) bridge.tick();
    assert.ok(!noticeAcknowledged(bridge, 82));
    assert.ok(bridge.messages.filter((entry) => entry.multiplayer?.type === 'local_state').length > before);
    assertNoBridgeError(bridge);
  }
});

test('原生通知发送失败后保留 ID，feed 恢复时重试并且只在成功后确认', () => {
  const bridge = engine({ noticeResult: -1 });
  const value = packet({ peers: [], notices: [{ id: 83, text: '通知成功后再移除待发送消息' }] });
  bridge.connect(value); bridge.tick();
  assert.ok(!noticeAcknowledged(bridge, 83));
  bridge.setNoticeResult(123);
  advanceUntil(bridge, () => noticeAcknowledged(bridge, 83));
  assert.equal(bridge.notifications.filter((notification) => notification.result >= 0).length, 1);
  for (let index = 0; index < 20; index++) { bridge.publish(value); bridge.tick(); }
  assert.equal(bridge.notifications.filter((notification) => notification.result >= 0).length, 1);
  assertNoBridgeError(bridge);
});

test('适配器保存未确认原生通知，完整战局与控制快照不会清空它，确认只移除匹配 ID', () => {
  const page = adapter(directNetwork());
  page.receive({ type: 'session', connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }], peers: [] });
  page.receive({ type: 'network_status', connected: true, members: 2, text: '服务器已连接' });
  page.api.onWorkerMessage({ multiplayer: { type: 'game_status', peer_count: 1, alive: true, health: 200 } });
  page.flush();
  assert.ok(Array.isArray(page.read().notices) && page.read().notices.length > 0);
  const ids = page.read().notices.map((notice) => notice.id);
  assert.ok(page.read().notices.every((notice) => typeof notice.text === 'string' && Number.isSafeInteger(notice.id)));
  page.receive({ type: 'session', connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }], peers: [] });
  page.receive({ type: 'combat_state', players: [combatPlayer()] });
  page.receive({ type: 'respawn', player_id: 'LOCAL', revision: 3, position: [711.5, -1088.1, 22.4], health: 200 });
  page.flush();
  assert.ok(ids.every((id) => page.read().notices.some((notice) => notice.id === id)));
  page.api.onWorkerMessage({ multiplayer: { type: 'notice_ack', ids: [ids[0]] } }); page.flush();
  assert.ok(!page.read().notices.some((notice) => notice.id === ids[0]));
  assert.ok(ids.slice(1).every((id) => page.read().notices.some((notice) => notice.id === id)));
  const count = page.read().notices.length;
  page.api.onWorkerMessage({ multiplayer: { type: 'notice_ack', ids: [ids[0]] } }); page.flush();
  assert.equal(page.read().notices.length, count, '重复通知确认无害');
});

test('原生 HUD 可用后隐藏网页浮层，原生失败保留网页提示且继续网络同步', () => {
  const page = adapter(directNetwork());
  page.receive({ type: 'network_status', connected: true, members: 2 });
  page.api.onWorkerMessage({ multiplayer: { type: 'game_status', peer_count: 1, health: 200, alive: true } });
  page.api.onWorkerMessage({ multiplayer: { type: 'native_hud', available: true } });
  assert.equal(page.hud.style.display, 'none');
  page.receive({ type: 'network_status', connected: false, text: '正在自动重连服务器' });
  page.api.onWorkerMessage({ multiplayer: { type: 'game_status', role_recovering: true, peer_count: 1 } });
  assert.equal(page.hud.style.display, 'none', '原生可用期间不重新显示网页悬浮层');
  page.api.onWorkerMessage({ multiplayer: { type: 'native_hud', available: false } });
  assert.notEqual(page.hud.style.display, 'none');
  assert.ok(page.hud.textContent.includes('自动重连'));
});

test('远端缓存坐标收敛后仍纠正引擎实际漂移及转身，保持静止和同一模型', () => {
  const bridge = engine(); bridge.connect();
  const ped = bridge.calls.find(c => c.name === 'mpCreatePed') ? 101 : 0;
  assert.ok(ped);
  bridge.remotePositions.set(ped, [715, -1070, 22]); bridge.remoteHeadings.set(ped, 10);
  bridge.frozen.set(ped, false);
  const clears = bridge.calls.filter(c => c.name === 'mpClearTasksImmediately').length;
  bridge.tick();
  assert.deepEqual(bridge.remotePositions.get(ped), [710, -1080, 22]);
  assert.equal(bridge.remoteHeadings.get(ped), 120);
  assert.equal(bridge.frozen.get(ped), true);
  assert.equal(bridge.tasks.get(ped).kind, 'idle');
  assert.equal(bridge.tasks.get(ped).timeout, -1);
  assert.equal(bridge.calls.filter(c => c.name === 'mpClearTasksImmediately').length, clears, '纠偏不能取消已排入的动作');
  assert.equal(bridge.calls.filter(c => c.name === 'mpCreatePed').length, 1);
});

test('远端移动按真实间隔估算速度，停止后取消走动任务且挂接不独立瞬移', () => {
  const bridge = engine(); bridge.connect(); const ped = 101;
  bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ position: [710.25, -1080, 22] }) }] }));
  bridge.tick(bridge.now() + 250);
  assert.equal(bridge.tasks.get(ped).kind, 'move');
  assert.ok(bridge.tasks.get(ped).speed <= 1.1, '250ms走0.25米不能被当作每秒3米');
  for (let i = 0; i < 15; i++) bridge.tick();
  assert.equal(bridge.tasks.get(ped).kind, 'idle');
  bridge.remotePositions.set(ped, [800, -1080, 22]);
  bridge.publish(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ attachment: { entity_id: 'car', seat: 'driver' } }) }] }));
  bridge.tick();
  assert.deepEqual(bridge.remotePositions.get(ped), [800, -1080, 22]);
  assert.equal(bridge.frozen.get(ped), true, '车尚未加载和实际入座时不解冻');
});

test('真实两层桥的远端拳击使用全身动画，静止与移动更新不能覆盖动作窗口', () => {
  const bridge = engine({ worldBridge: true });
  const entity = (id, playerId, x) => ({ entity_id: id, kind: 'ped', player_id: playerId, generation: 1,
    revision: 1, model: 0x705e61f2, owner_epoch: 1, owner_id: playerId, ownership: 'active',
    components: { transform: { position: [x, -1080, 22], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angular_velocity: [0, 0, 0] },
      combat: { health: 200, alive: true }, ped: { weapon: 0xa2719263, actions: {} } } });
  const state = packet({ world: { ready: true, world_epoch: 'TEST', entities: [entity('SELF', 'LOCAL', 711), entity('OTHER', 'REMOTE', 710)] }, world_events: [] });
  bridge.connect(state);
  state.world_events = [{ id: 1, event: { world_epoch: 'TEST', attacker_entity_id: 'OTHER', attacker_generation: 1, hit: false } }];
  bridge.publish(state); bridge.tick();
  assert.equal(bridge.tasks.get(101).kind, 'punch');
  const play = bridge.calls.filter(c => c.name === 'mpTaskPlayAnim').at(-1);
  assert.equal(play.arguments[6], 0, '拳击使用完整身体动作');
  const afterPunch = bridge.calls.length;
  for (let i = 0; i < 6; i++) bridge.tick();
  assert.equal(bridge.tasks.get(101).kind, 'punch');
  assert.equal(bridge.calls.slice(afterPunch).filter(c => ['mpTaskGoStraight', 'mpTaskStandStill', 'mpClearTasksImmediately'].includes(c.name) && c.arguments[0] === 101).length, 0);
  bridge.tick(bridge.now() + 800);
  assert.equal(bridge.tasks.get(101).kind, 'idle');
});

test('空手native无武器对象时仍视为就绪，不反复装备空手打断拳击', () => {
  const bridge = engine({ localWeapon: 0xa2719263, unarmedNoWeapon: true }); bridge.setWeaponReady(false);
  bridge.connect(packet({ peers: [{ player_id: 'REMOTE', state: peerState({ weapon: 0xa2719263 }) }] }));
  const initialEquip = bridge.calls.filter(c => c.name === 'mpSetCurrentWeapon' && c.arguments[0] === 101).length;
  for (let i = 0; i < 20; i++) bridge.tick();
  assert.equal(bridge.calls.filter(c => c.name === 'mpSetCurrentWeapon' && c.arguments[0] === 101).length, initialEquip);
  const status = bridge.messages.filter(m => m.multiplayer?.type === 'game_status' && m.multiplayer.weapon === 0xa2719263).at(-1);
  assert.equal(status.multiplayer.weapon_ready, true);
});

test('暂停无脚本owner回调时由独立前端尾部刷新公共战局菜单，只调用UI不操作角色', () => {
  const bridge = engine({ sessionUI: true });
  bridge.connect(packet({ members: [{ id: 'LOCAL', name: '测试玩家' }, { id: 'REMOTE' }] }));
  bridge.state.active = 0n; bridge.state.handler = 0n; bridge.state.pauseActive = true;
  const start = bridge.calls.length;
  bridge.frontendTick();
  assert.deepEqual(bridge.uiCalls.map(c => c.method), ['SET_HEADER_TITLE', 'SET_HEADING_DETAILS']);
  assert.equal(bridge.uiCalls[0].parameters[0], 'GTA V · 公共在線戰局');
  assert.equal(bridge.uiCalls[1].parameters[0], '测试玩家');
  assert.equal(bridge.calls.slice(start).some(c => /^mp(?:GetPlayerPed|SetCoords|CreatePed|SetHealth|GetActiveThread|GetCurrentHandler)/.test(c.name)), false);
  bridge.publish(packet({ connected: false, members: [] })); bridge.frontendTick(bridge.now() + 300);
  assert.ok(bridge.uiCalls.at(-1).parameters.includes('正在重新連線'));
  bridge.publish(packet({ connected: false, members: [], language: 'en' })); bridge.frontendTick(bridge.now() + 16);
  assert.equal(bridge.uiCalls.at(-2).parameters[0], 'GTA V · Public Online Session');
  assert.ok(bridge.uiCalls.at(-1).parameters.includes('Reconnecting'));
});

test('服务器挂接待本机车辆就绪并实际入座后才解除冻结，不用过期坐标拉动乘客', () => {
  const vehicles = new Map(); const bridge = engine({ vehicleHandles: vehicles }); bridge.connect();
  const value = packet({ peers: [{ player_id: 'REMOTE', state: peerState({ attachment: { entity_id: 'car', seat: 'passenger:0' } }) }] });
  bridge.publish(value); bridge.tick(); assert.equal(bridge.frozen.get(101), true);
  vehicles.set('car', 501); bridge.tick(); assert.equal(bridge.frozen.get(101), true);
  bridge.occupiedVehicles.set(101, 501); bridge.remotePositions.set(101, [780, -1088, 22]);
  bridge.tick(); assert.equal(bridge.frozen.get(101), false);
  assert.deepEqual(bridge.remotePositions.get(101), [780, -1088, 22]);
});

test('刷新恢复时雷达清掉标记也会补建，不重建角色且恢复地图可见属性', () => {
  const bridge = engine();
  const value = packet({ resumed: true, resume_state_ready: true, resume_state: peerState(),
    members: [{ id: 'LOCAL' }, { id: 'REMOTE', name: '测试队友' }] });
  bridge.connect(value); const beforePed = bridge.calls.filter(c => c.name === 'mpCreatePed').length;
  const old = [...bridge.blips.keys()][0]; assert.ok(old);
  bridge.blips.delete(old); bridge.tick(bridge.now() + 500);
  assert.equal(bridge.calls.filter(c => c.name === 'mpCreatePed').length, beforePed);
  assert.equal(bridge.blips.size, 1); const replacement = [...bridge.blips.keys()][0]; assert.notEqual(replacement, old);
  assert.deepEqual(bridge.blipStyles.get(replacement), { display: 4, alpha: 255 });
  const named = bridge.calls.filter(c => c.name === 'mpEndSetBlipName').at(-1); assert.equal(named.arguments[0], replacement);
  for (let i = 0; i < 10; i++) bridge.tick();
  assert.equal(bridge.blips.size, 1); assert.equal(bridge.calls.filter(c => c.name === 'mpCreatePed').length, beforePed);
});

test('雷达尚未就绪首次返回0时重试建标记，死亡也可补建标记', () => {
  const bridge = engine({ blipReady: false }); bridge.connect(); assert.equal(bridge.blips.size, 0);
  bridge.setBlipReady(true); bridge.tick(bridge.now() + 500); assert.equal(bridge.blips.size, 1);
  bridge.blips.clear(); bridge.publish(packet({ combat: [{ id: 'REMOTE', alive: false, health: 0, revision: 10 }] }));
  bridge.tick(bridge.now() + 500); assert.equal(bridge.blips.size, 1);
  assert.equal(bridge.calls.filter(c => c.name === 'mpCreatePed').length, 1);
});

test('射击到达时远端模型未载入则等待同一事件，创建角色后播放且不重复', () => {
  const bridge = engine({ unavailableModels: [0x9c9effd8] });
  const shot = { id: 20, player_id: 'REMOTE', event: { origin: [710, -1080, 22], target: [715, -1080, 22], weapon: 0x1b06d571 } };
  const value = packet({ peers: [{ player_id: 'REMOTE', state: peerState({ model: 0x9c9effd8 }) }], shots: [shot] });
  bridge.connect(value); assert.equal(bridge.calls.filter(c => c.name === 'mpShootBullet').length, 0);
  assert.equal(bridge.messages.filter(m => m.multiplayer?.type === 'shot_ack').length, 0);
  bridge.setModelAvailable(0x9c9effd8, true); bridge.tick();
  assert.equal(bridge.calls.filter(c => c.name === 'mpShootBullet').length, 1);
  bridge.publish(value); bridge.tick(); assert.equal(bridge.calls.filter(c => c.name === 'mpShootBullet').length, 1);
});

test('视觉资源迟迟不就绪时有界过期，不补播旧弹道，短暂native失败仍重试', () => {
  const shot = { id: 21, player_id: 'REMOTE', event: { origin: [710, -1080, 22], target: [715, -1080, 22], weapon: 0x1b06d571 } };
  const expired = engine({ weaponAssetReady: false }); expired.connect(packet({ shots: [shot] }));
  expired.tick(expired.now() + 2100); expired.setWeaponAssetReady(true); expired.tick();
  assert.equal(expired.calls.filter(c => c.name === 'mpShootBullet').length, 0);
  assert.ok(expired.messages.some(m => m.multiplayer?.type === 'shot_ack' && m.multiplayer.ids.includes(21)));
  const recover = engine(); recover.connect(); recover.setShootThrows(true);
  recover.publish(packet({ shots: [shot] })); recover.tick();
  assert.ok(!recover.messages.some(m => m.multiplayer?.type === 'shot_ack' && m.multiplayer.ids.includes(21)));
  recover.setShootThrows(false); recover.tick();
  assert.equal(recover.visualVectors.length, 1);
});

test('远端弹道优先从真实枪口播放，缺骨架时只使用安全右手位置且伤害仍为0', () => {
  const shot = { id: 22, player_id: 'REMOTE', event: { origin: [704, -1083, 24], target: [715, -1080, 22], weapon: 0x1b06d571 } };
  const muzzle = engine({ muzzle: [710.5, -1080, 23] }); muzzle.connect(packet({ shots: [shot] }));
  assert.deepEqual(muzzle.visualVectors[0].origin, [710.5, -1080, 23]);
  assert.equal(muzzle.calls.find(c => c.name === 'mpShootBullet').arguments[2], 0);
  const hand = engine({ muzzle: [710.5, -1080, 23], noWeaponSkeleton: true, hand: [710.25, -1080, 23] });
  hand.connect(packet({ shots: [shot] })); assert.deepEqual(hand.visualVectors[0].origin, [710.25, -1080, 23]);
  assert.equal(hand.calls.filter(c => c.name === 'mpEntityBoneIndexByName').length, 0, '不能查询空骨架');
});

test('启动器动态配置进入共享快照，配置更新不清除角色或战斗消息', () => {
  let update;
  const page = adapter(null, { watchOnlineConfiguration: callback => { update = callback; callback({ oltitle: 'https://gtav.2t.hk' }); return () => {}; } });
  page.receive({ type: 'session', connected: true, client_id: 'LOCAL', members: [{ id: 'LOCAL' }, { id: 'REMOTE' }] });
  page.receive({ type: 'player_state', player_id: 'REMOTE', state: peerState() }); page.flush();
  assert.equal(page.read().remote_config.oltitle, 'https://gtav.2t.hk');
  update({ oltitle: 'https://gtav.2t.hk/status', source: 'remote', stale: false }); page.flush();
  assert.equal(page.read().remote_config.oltitle, 'https://gtav.2t.hk/status');
  assert.equal(page.read().peers[0].player_id, 'REMOTE');
});

test('公共战局只挂起审核的单机事件脚本，加载输入暂停和未知脚本继续运行', () => {
  const bridge=engine();assert.equal(bridge.scriptGate('respawn_controller'),0);
  bridge.connect(packet({world_v2:true,world:{ready:true,entities:[],world_epoch:'A'}}));
  for(const name of ['respawn_controller','mission_triggerer_a','randomchar_controller','re_arrests'])assert.equal(bridge.scriptGate(name),1,name);
  for(const name of ['main_persistent','initial','player_controller','pausemenu','unreviewed_script'])assert.equal(bridge.scriptGate(name),0,name);
  assert.ok(bridge.messages.some(m=>m.multiplayer?.type==='script_policy'&&m.multiplayer.phase==='suspended'));
});
test('无弹夹投掷减总弹药仍上报一次，黏弹引爆只发服务器意图', () => {
  const weapon=0x2c3731d9, bridge=engine({localWeapon:weapon,noClip:true});
  bridge.connect(packet({weapon_rules:[{weapon,mode:'projectile',cooldown_ms:200,damage:100}]}));
  bridge.setAmmo(29);bridge.tick();bridge.tick();
  assert.equal(bridge.messages.filter(m=>m.multiplayer?.type==='local_shot').length,1);
  bridge.setDetonate(true);bridge.tick();bridge.setDetonate(false);
  assert.ok(bridge.messages.some(m=>m.multiplayer?.type==='interaction_request'&&m.multiplayer.action==='detonate'));
});

test('排队和投射物的异步权威damage会提示命中，同受害同版本不重复', () => {
  const page=adapter(directNetwork());
  page.receive({type:'session',connected:true,client_id:'LOCAL',members:[{id:'LOCAL'},{id:'REMOTE'}]});page.flush();
  page.receive({type:'damage',victim_id:'REMOTE',attacker_id:'LOCAL',shot_seq:2,weapon:0xb1ca77b1,damage:100,health:100,revision:4});page.flush();
  const notices=page.read().notices.length;assert.ok(page.read().notices.at(-1).text.includes('100'));
  page.receive({type:'damage',victim_id:'REMOTE',attacker_id:'LOCAL',shot_seq:2,weapon:0xb1ca77b1,damage:100,health:100,revision:4});
  page.receive({type:'combat_feedback',accepted:true,hit:true,victim_id:'REMOTE',damage:100,health:100,revision:4});page.flush();
  assert.equal(page.read().notices.length,notices);
  page.receive({type:'damage',victim_id:'OTHER',attacker_id:'LOCAL',shot_seq:2,weapon:0xb1ca77b1,damage:100,health:0,revision:4});page.flush();
  assert.equal(page.read().notices.length,notices+1,'同一爆炸的另一个受害者保留独立反馈');
});

test('服务器空白名单冻结全部本地VM含未知剧情，owner桥继续回调且断线不恢复剧情', () => {
  const policy={revision:1,story_enabled:false,local_script_mode:'suspend_after_ready',allowed_scripts:[],mission_events:'server_only'};
  const bridge=engine();bridge.setup();
  bridge.publish(packet({world_v2:true,session_policy:policy,world:{ready:false,entities:[],world_epoch:'A'}}));
  bridge.tick();
  assert.equal(bridge.scriptGate('main_persistent'),0,'初始化前保留加载VM');
  assert.equal(bridge.state.controlsEnabled,false,'加载阶段禁止玩家输入触发剧情');
  bridge.connect(packet({world_v2:true,session_policy:policy,world:{ready:true,entities:[],world_epoch:'A'}}));
  for(const script of ['unknown_mission','main_persistent','main','initial','player_controller','pausemenu','re_arrests'])
    assert.equal(bridge.scriptGate(script),1,script);
  assert.equal(bridge.state.controlsEnabled,true,'仅在角色和完整战局就绪后释放控制');
  const before=bridge.messages.filter(m=>m.multiplayer?.type==='local_state').length;
  bridge.tick(bridge.now()+100);assert.equal(bridge.scriptGate('main_persistent'),1);
  assert.ok(bridge.messages.filter(m=>m.multiplayer?.type==='local_state').length>before,'VM暂停不能暂停owner桥回调');
  bridge.publish(packet({connected:false,world_v2:false,world:null}));bridge.tick();
  assert.equal(bridge.scriptGate('unknown_mission'),1,'断线维持服务端禁止剧情的策略');
  const offline=engine();offline.setup();assert.equal(offline.scriptGate('unknown_mission'),0,'离线入口不套用公共战局策略');
});
test('脚本例外仅按服务器更高版本白名单生效，同版本和旧策略不能开放脚本', () => {
  const policy={revision:2,story_enabled:false,local_script_mode:'suspend_after_ready',allowed_scripts:['permitted_loader'],mission_events:'server_only'};
  const bridge=engine();bridge.connect(packet({world_v2:true,session_policy:policy,world:{ready:true,entities:[],world_epoch:'A'}}));
  assert.equal(bridge.scriptGate('permitted_loader'),0);assert.equal(bridge.scriptGate('unknown_story'),1);
  bridge.publish(packet({world_v2:true,session_policy:{...policy,revision:1,allowed_scripts:['unknown_story']},world:{ready:true,entities:[],world_epoch:'A'}}));
  bridge.tick();assert.equal(bridge.scriptGate('unknown_story'),1);assert.equal(bridge.scriptGate('permitted_loader'),0);
});

test('公共战局小地图恢复道路底图，解除单机迷雾和背景隐藏而保持剧情禁用', () => {
  const policy = { revision: 1, story_enabled: false, local_script_mode: 'suspend_after_ready', allowed_scripts: [], mission_events: 'server_only' };
  const bridge = engine();
  bridge.connect(packet({ world_v2: true, session_policy: policy, world: { ready: true, entities: [], world_epoch: 'A' } }));
  assert.equal(bridge.state.radar.rendering, true);
  assert.equal(bridge.state.radar.fog, false);
  assert.equal(bridge.state.radar.backgroundHidden, false);
  assert.equal(bridge.state.radar.prologue, false);
  assert.equal(bridge.scriptGate('main_persistent'), 1, '恢复底图不重新运行剧情');
  assert.ok(bridge.messages.some(m => m.multiplayer?.type === 'radar_status' && m.multiplayer.rendering));
});

test('小地图维护只作用于就绪公共世界，不改离线、加载中或暂停地图', () => {
  const bridge = engine(); bridge.connect();
  assert.equal(bridge.calls.filter(c => c.name === 'mpDisplayRadar').length, 0, '非world_v2不动雷达');
  bridge.publish(packet({ world_v2: true, world: { ready: false, entities: [], world_epoch: 'A' } })); bridge.tick();
  assert.equal(bridge.calls.filter(c => c.name === 'mpDisplayRadar').length, 0);
  bridge.state.pauseActive = true;
  bridge.publish(packet({ world_v2: true, world: { ready: true, entities: [], world_epoch: 'A' } })); bridge.tick();
  assert.equal(bridge.calls.filter(c => c.name === 'mpDisplayRadar').length, 0, '暂停大地图不受干扰');
  bridge.state.pauseActive = false; bridge.tick();
  assert.equal(bridge.state.radar.rendering, true);
});

test('小地图恢复限频执行，换角色和重新显示时仍能修复，不覆盖用户偏好', () => {
  const bridge = engine();
  bridge.connect(packet({ world_v2: true, world: { ready: true, entities: [], world_epoch: 'A' } }));
  const count = () => bridge.calls.filter(c => c.name === 'mpDisplayRadar').length;
  const before = count(); bridge.tick(bridge.now() + 50); assert.equal(count(), before);
  bridge.state.radar.fog = true; bridge.state.radar.backgroundHidden = true;
  bridge.tick(bridge.now() + 600); assert.equal(bridge.state.radar.rendering, true);
  bridge.state.radar.radarPreference = false;
  bridge.tick(bridge.now() + 600);
  assert.equal(bridge.state.radar.radarPreference, false, '不修改用户自己的地图设置');
  assert.ok(bridge.messages.some(m => m.multiplayer?.type === 'radar_status' && m.multiplayer.radar_preference === false));
  const unlocked = () => bridge.calls.filter(c => c.name === 'mpUnlockMinimapPosition').length;
  const old = unlocked(); bridge.setLocalPed(81); bridge.tick();
  assert.equal(unlocked(), old + 1, '新角色立即清理旧雷达坐标锁');
});

test('小地图native暂不可用时限频重试，不中断角色同步', () => {
  const bridge = engine(); bridge.state.radar.throwBackground = true;
  bridge.connect(packet({ world_v2: true, world: { ready: true, entities: [], world_epoch: 'A' } }));
  const count = () => bridge.calls.filter(c => c.name === 'mpMinimapBackgroundInfo').length;
  const attempts = count(); bridge.tick(bridge.now() + 50); assert.equal(count(), attempts);
  assert.ok(bridge.messages.some(m => m.multiplayer?.type === 'local_state'));
  assert.ok(bridge.messages.some(m => m.multiplayer?.type === 'radar_status' && m.multiplayer.retrying));
  bridge.state.radar.throwBackground = false; bridge.tick(bridge.now() + 600);
  assert.equal(bridge.state.radar.rendering, true);
  assert.equal(bridge.messages.filter(m => m.multiplayer?.type === 'bridge_error').length, 0);
});

const diagnosticLines = (page) => page.requests.flatMap(request => request.body.split('\n').map(line => JSON.parse(line.slice('[public-client] '.length))));
const settleDiagnostics = async () => { await Promise.resolve(); await Promise.resolve(); };

test('interleaved steady worker statuses are deduplicated by type and sent in one batch', async () => {
  const page = adapter(), networkBefore = page.channels[0].posts.length;
  const statuses = [
    { type: 'world_readiness', mode: 'read_only', ped_tree_initialized: false },
    { type: 'world_environment_status', weather: 'CLEAR', clock: [12, 0] },
    { type: 'shot_visual', played: 0, expired: 0 },
    { type: 'game_status', role_loading: true, peer_count: 0 },
  ];
  for (let tick = 0; tick < 1000; tick++) for (const value of statuses) page.api.onWorkerMessage({ multiplayer: value });
  assert.equal(page.requests.length, 0);
  page.runTimer(1000); await settleDiagnostics();
  assert.equal(page.requests.length, 1);
  assert.deepEqual(diagnosticLines(page).map(value => value.phase), ['engine_ready', 'world_readiness', 'world_environment', 'shot_visual', 'loading_avatar']);
  for (let tick = 0; tick < 1000; tick++) for (const value of statuses) page.api.onWorkerMessage({ multiplayer: value });
  assert.equal(page.requests.length, 1);
  assert.ok(!page.pendingTimers().includes(1000));
  assert.equal(page.channels[0].posts.length, networkBefore, 'diagnostics never enter the gameplay protocol');
});

test('steady game and environment revisions do not trigger HTTP while real state changes retain current revision', async () => {
  const page = adapter();
  const game = { type:'game_status', peer_count:1, client_id:'LOCAL', health:200, alive:true,
    native_health:200, native_dead:false, weapon:0x1b06d571, weapon_ready:true };
  const environment = { type:'world_environment_status', world_epoch:'WORLD', weather:'CLEAR', hour:12 };
  for (let revision = 1; revision <= 100; revision++) {
    page.api.onWorkerMessage({ multiplayer:{ ...game,revision } });
    page.api.onWorkerMessage({ multiplayer:{ ...environment,revision } });
  }
  page.runTimer(1000); await settleDiagnostics();
  assert.equal(diagnosticLines(page).find(value => value.phase === 'synchronizing').revision, 100);
  assert.equal(diagnosticLines(page).find(value => value.phase === 'world_environment').revision, 100);
  const sent = page.requests.length;
  for (let revision = 101; revision <= 1000; revision++) {
    page.api.onWorkerMessage({ multiplayer:{ ...game,revision } });
    page.api.onWorkerMessage({ multiplayer:{ ...environment,revision } });
  }
  assert.equal(page.requests.length, sent); assert.ok(!page.pendingTimers().includes(1000));
  assert.match(page.hud.textContent, /生命值 200/, 'HUD remains current independently of logging');
  page.api.onWorkerMessage({ multiplayer:{ ...game,health:175,revision:1001 } });
  page.api.onWorkerMessage({ multiplayer:{ ...environment,hour:13,revision:1001 } });
  page.runTimer(1000); await settleDiagnostics();
  const changed = diagnosticLines(page).slice(-2);
  assert.equal(changed.find(value => value.phase === 'synchronizing').server_health, 175);
  assert.equal(changed.find(value => value.phase === 'world_environment').hour, 13);
  assert.ok(changed.every(value => value.revision === 1001));
  page.api.onWorkerMessage({ multiplayer:{ ...environment,world_epoch:'NEXT',revision:1 } });
  page.runTimer(1000); await settleDiagnostics();
  assert.equal(diagnosticLines(page).at(-1).world_epoch, 'NEXT');
});

test('rapidly changing samples coalesce to latest values while entity diagnostics have bounded queues', async () => {
  const page = adapter();
  for (let seq = 0; seq < 1000; seq++) {
    page.api.onWorkerMessage({ multiplayer: { type: 'shot_visual', played: seq, expired: 0 } });
    page.api.onWorkerMessage({ multiplayer: { type: 'world_entity_status', entity_id: 'npc-' + seq, kind: 'ped', phase: 'created' } });
  }
  page.runTimer(1000); await settleDiagnostics();
  assert.equal(page.requests.length, 1);
  assert.ok(diagnosticLines(page).length <= 64);
  page.runTimer(1000); await settleDiagnostics();
  assert.equal(page.requests.length, 2);
  const reports = diagnosticLines(page);
  assert.ok(reports.length <= 128);
  assert.equal(reports.find(value => value.phase === 'shot_visual').played, 999);
  assert.ok(page.requests.every(request => Buffer.byteLength(request.body) <= 65536));
});

test('errors are immediately diagnostic, repeats deduplicate and later changes cannot create concurrent HTTP', async () => {
  let release;
  const page = adapter(null, { fetch: () => new Promise(resolve => { release = resolve; }) });
  page.api.onWorkerMessage({ multiplayer: { type: 'bridge_error', message: 'cannot allocate sync buffers' } });
  assert.equal(page.requests.length, 1);
  assert.equal(diagnosticLines(page)[0].phase, 'error');
  assert.match(page.hud.textContent, /cannot allocate sync buffers/);
  for (let tick = 0; tick < 1000; tick++) {
    page.api.onWorkerMessage({ multiplayer: { type: 'bridge_error', message: 'cannot allocate sync buffers' } });
    page.api.onWorkerMessage({ multiplayer: { type: 'world_readiness', ready: false, count: tick } });
  }
  assert.equal(page.requests.length, 1);
  page.api.onWorkerMessage({ multiplayer: { type: 'bridge_error', message: 'another distinct error' } });
  assert.equal(page.requests.length, 1);
  release({ ok: true }); await settleDiagnostics();
  assert.ok(page.pendingTimers().includes(250));
  page.runTimer(250);
  assert.equal(page.requests.length, 2);
  assert.equal(diagnosticLines(page).find(value => value.message === 'another distinct error').phase, 'error');
  assert.equal(diagnosticLines(page).filter(value => value.message === 'cannot allocate sync buffers').length, 1);
});

test('stalled logging aborts after a bounded timeout, preserves latest queued diagnostics and closes on pagehide', async () => {
  const page = adapter(null, { fetch: () => new Promise(() => {}) });
  page.runTimer(1000);
  page.api.onWorkerMessage({ multiplayer: { type: 'world_readiness', ready: true } });
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].signal.aborted, false);
  page.runTimer(5000);
  assert.equal(page.requests[0].signal.aborted, true);
  assert.equal(page.requests.length, 1);
  page.runTimer(0);
  assert.equal(page.requests.length, 2);
  assert.ok(diagnosticLines(page).some(value => value.phase === 'world_readiness'));
  page.close();
  assert.equal(page.requests[1].signal.aborted, true);
  assert.equal(page.pendingTimers().length, 0);
  page.api.onWorkerMessage({ multiplayer: { type: 'bridge_error', message: 'after close' } });
  assert.equal(page.requests.length, 2);
});

test('diagnostic failures never prevent gameplay forwarding and oversized errors keep valid bounded JSON', async () => {
  const network = directNetwork(), page = adapter(network, { fetch: () => { throw new Error('logging unavailable'); } });
  page.api.onWorkerMessage({ multiplayer: { type: 'bridge_error', message: 'error'.repeat(10000) } });
  assert.equal(page.requests.length, 1);
  const error = diagnosticLines(page)[0];
  assert.equal(error.phase, 'error'); assert.equal(error.truncated, true); assert.ok(error.message.length <= 2048);
  page.api.onWorkerMessage({ multiplayer: { type: 'local_state', state: peerState() } });
  assert.equal(network.messages.at(-1).type, 'local_state');
  page.api.onWorkerMessage({ multiplayer: { type: 'shot_visual', played: 1 } });
  page.runTimer(1000);
  assert.equal(page.requests.length, 2);
});
