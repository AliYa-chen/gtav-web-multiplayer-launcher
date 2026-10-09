import { getLanguage, translateText, localizeServerError, onLanguageChange } from '../i18n.js';
import { normalizeServerAddress } from './server-address.js';
import { modelForPreset, normalizeAppearance, randomAppearance } from './appearance.js';
import { createWorldState, cleanWorldTransform, cleanSessionPolicy } from './world-state.js';

const coordinates = (value) => Array.isArray(value) && value.length === 3
  && value.every((number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 16000);
const unsignedHash = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const ACTION_KEYS = ['aiming', 'reloading', 'jumping', 'ducking', 'sprinting'];
const validResumeIdentity = (value) => value && typeof value.client_id === 'string'
  && value.client_id.length > 0 && value.client_id.length <= 128
  && typeof value.resume_token === 'string' && value.resume_token.length > 0 && value.resume_token.length <= 512;
let pageInstanceSequence = 0;
function newRequestNamespace() {
  let random;
  try { random = globalThis.crypto?.randomUUID?.().replaceAll('-', ''); } catch {}
  if (!random) random = Date.now().toString(36) + Math.random().toString(36).slice(2) + (++pageInstanceSequence).toString(36);
  return 'p' + random.slice(0, 36);
}
function cleanPlayerState(value) {
  if (!value || !coordinates(value.position) || !Number.isFinite(value.heading) || value.heading < 0 || value.heading > 360
    || !unsignedHash(value.model) || !unsignedHash(value.weapon) || !Number.isInteger(value.health)
    || value.health < 0 || value.health > 1000 || typeof value.shooting !== 'boolean') return null;
  const appearance = Object.hasOwn(value, 'appearance') ? normalizeAppearance(value.appearance) : null;
  if (Object.hasOwn(value, 'appearance') && !appearance) return null;
  const actions = Object.hasOwn(value, 'actions') ? value.actions : null;
  if (Object.hasOwn(value, 'actions') && (!actions || typeof actions !== 'object' || Array.isArray(actions)
    || Object.keys(actions).length !== ACTION_KEYS.length || !ACTION_KEYS.every((key) => typeof actions[key] === 'boolean'))) return null;
  if (Object.hasOwn(value, 'aim_target') && !coordinates(value.aim_target)) return null;
  return { position: value.position.slice(), heading: value.heading, model: value.model, health: value.health,
    weapon: value.weapon, shooting: value.shooting, ...(appearance ? { appearance } : {}),
    ...(actions ? { actions: Object.fromEntries(ACTION_KEYS.map((key) => [key, actions[key]])) } : {}),
    ...(Object.hasOwn(value, 'aim_target') ? { aim_target: value.aim_target.slice() } : {}) };
}
function cleanShotEvent(value) {
  if (!value || !coordinates(value.origin) || !coordinates(value.target) || !unsignedHash(value.weapon)) return null;
  return { origin: value.origin.slice(), target: value.target.slice(), weapon: value.weapon };
}
function cleanShotResult(value) {
  if (!value || !Number.isSafeInteger(value.seq) || value.seq < 0 || !unsignedHash(value.weapon)
    || typeof value.accepted !== 'boolean') return null;
  // 服务器拒绝消息只含原因；没有 hit 字段时明确视为未命中，成功结果仍必须提供布尔判定。
  const hit = value.accepted === false && !Object.hasOwn(value, 'hit') ? false : value.hit;
  if (typeof hit !== 'boolean' || (hit && !value.accepted)) return null;
  if (Object.hasOwn(value, 'victim_id') && (typeof value.victim_id !== 'string' || !value.victim_id || value.victim_id.length > 128)) return null;
  for (const key of ['damage', 'health']) {
    if (Object.hasOwn(value, key) && (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 200)) return null;
  }
  if (Object.hasOwn(value, 'reason') && (typeof value.reason !== 'string' || !/^[a-z_]{1,64}$/.test(value.reason))) return null;
  if (Object.hasOwn(value, 'revision') && (!Number.isSafeInteger(value.revision) || value.revision < 0)) return null;
  return { seq: value.seq, weapon: value.weapon, accepted: value.accepted, hit,
    ...(value.pending === true ? { pending: true } : {}),
    ...(Number.isSafeInteger(value.scheduled_at) && value.scheduled_at >= 0 ? { scheduled_at: value.scheduled_at } : {}),
    ...(Object.hasOwn(value, 'victim_id') ? { victim_id: value.victim_id } : {}),
    ...(Object.hasOwn(value, 'damage') ? { damage: value.damage } : {}),
    ...(Object.hasOwn(value, 'health') ? { health: value.health } : {}),
    ...(Object.hasOwn(value, 'revision') ? { revision: value.revision } : {}),
    ...(Object.hasOwn(value, 'reason') ? { reason: value.reason } : {}) };
}
function cleanCombatPlayer(value) {
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 128
    || !Number.isInteger(value.health) || value.health < 0 || value.health > 200 || typeof value.alive !== 'boolean') return null;
  const revision = Object.hasOwn(value, 'revision') ? value.revision : 0;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  return { ...value, revision, ...(coordinates(value.spawn) ? { spawn: value.spawn.slice() } : {}) };
}
function cleanWeaponRules(value) {
  if (!Array.isArray(value) || value.length > 256) return null;
  const hashes = new Set(), rules = [];
  for (const rule of value) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || !unsignedHash(rule.weapon) || hashes.has(rule.weapon)
      || !Number.isInteger(rule.cooldown_ms) || rule.cooldown_ms < 1 || rule.cooldown_ms > 10000
      || !Number.isInteger(rule.damage) || rule.damage < 0 || rule.damage > 200) return null;
    if (Object.keys(rule).some(key => !['weapon', 'name', 'mode', 'cooldown_ms', 'damage', 'range', 'pellets', 'spread',
      'blast_radius', 'speed', 'fuse_ms', 'melee_damage', 'melee_range', 'detonation', 'gravity', 'lifetime_ms',
      'effect_duration_ms', 'effect_interval_ms', 'asset_damage', 'asset_fire_type', 'damage_type', 'collision_model'].includes(key))) return null;
    if (rule.mode !== undefined && !['hitscan', 'shotgun', 'projectile', 'melee', 'utility', 'environment'].includes(rule.mode)) return null;
    if (rule.name !== undefined && (typeof rule.name !== 'string' || !/^[A-Za-z0-9_]{1,80}$/.test(rule.name))) return null;
    for (const key of ['range', 'spread', 'blast_radius', 'speed', 'melee_range', 'gravity']) {
      if (rule[key] !== undefined && (!Number.isFinite(rule[key]) || rule[key] < 0 || rule[key] > 10000)) return null;
    }
    if (rule.asset_damage !== undefined && (!Number.isFinite(rule.asset_damage) || rule.asset_damage < -1 || rule.asset_damage > 10000)) return null;
    for (const [key, max] of [['pellets', 128], ['fuse_ms', 120000], ['melee_damage', 200], ['lifetime_ms', 600000],
      ['effect_duration_ms', 600000], ['effect_interval_ms', 600000]]) {
      if (rule[key] !== undefined && (!Number.isInteger(rule[key]) || rule[key] < 0 || rule[key] > max)) return null;
    }
    if (rule.detonation !== undefined && !['impact', 'timed', 'remote', 'none'].includes(rule.detonation)) return null;
    for (const key of ['damage_type', 'asset_fire_type']) if (rule[key] !== undefined
      && (typeof rule[key] !== 'string' || !/^[A-Z_]{1,64}$/.test(rule[key]))) return null;
    if (rule.collision_model !== undefined && !['ped_capsules', 'ped_capsules_aim_terminal', 'server_trajectories_world_queries'].includes(rule.collision_model)) return null;
    hashes.add(rule.weapon); rules.push({ ...rule });
  }
  return rules;
}

function cleanProjectileEffect(value, { area = false } = {}) {
  const id = text => typeof text === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(text);
  const time = number => Number.isSafeInteger(number) && number >= 0;
  if (!value || !id(value.projectile_id) || !unsignedHash(value.weapon) || !coordinates(value.position)) return null;
  if (area || value.type === 'area_effect') {
    if (!time(value.expires_at) || !Number.isFinite(value.radius) || value.radius < 0 || value.radius > 100
      || typeof value.damage_type !== 'string' || !/^[A-Z_]{1,64}$/.test(value.damage_type)) return null;
    return { type: 'area_effect', projectile_id: value.projectile_id, weapon: value.weapon, position: [...value.position],
      expires_at: value.expires_at, radius: value.radius, damage_type: value.damage_type };
  }
  if (!id(value.player_id) || !time(value.shot_seq) || !time(value.world_tick)) return null;
  if (value.type === 'explosion_event') {
    if (!Number.isFinite(value.radius) || value.radius < 0 || value.radius > 100
      || !time(value.effect_duration_ms) || value.effect_duration_ms > 600000
      || typeof value.damage_type !== 'string' || !/^[A-Z_]{1,64}$/.test(value.damage_type)) return null;
    return { ...value, position: [...value.position] };
  }
  if (!['launch', 'landed', 'flight', 'expired'].includes(value.phase) || !coordinates(value.origin)
      || !coordinates(value.target) || !time(value.created_at) || !time(value.expires_at)
      || !time(value.flight_ms) || value.flight_ms < 1 || value.flight_ms > 120000
      || !time(value.fuse_ms) || value.fuse_ms > 120000 || !Number.isFinite(value.gravity)
      || value.gravity < 0 || value.gravity > 100 || !['impact', 'timed', 'remote', 'none'].includes(value.detonation)) return null;
  if (Object.hasOwn(value, 'physics') && !['ballistic', 'legacy_arc'].includes(value.physics)) return null;
  if (value.physics === 'ballistic' && (!coordinates(value.motion_origin) || !coordinates(value.velocity)
      || !time(value.motion_at) || value.motion_at > value.world_tick)) return null;
  return { ...value, origin: [...value.origin], target: [...value.target], position: [...value.position],
    ...(value.physics === 'ballistic' ? { motion_origin: [...value.motion_origin], velocity: [...value.velocity],
      motion_at: value.motion_at } : {}) };
}

// 游戏页直接持有连接。关闭大厅不会影响战局，也不需要另开浏览器标签页。
export async function startPublicSession(preferences, onStatus = () => {}, options = {}) {
  const address = normalizeServerAddress(preferences.server, location.href);
  const peers = new Map();
  const combat = new Map();
  const world = createWorldState(), entityInputSequences = new Map(), entityReadyEpochs = new Map();
  const requestNamespace = newRequestNamespace(), requestAliases = new Map();
  let wireRequestSequence = 0;
  const meleeRequests = new Map(), consumedMeleeEvents = new Set();
  const quietRejections = new Set(['rate_limited', 'cooldown', 'stale_seq', 'stale_input', 'stale_owner', 'stale_generation',
    'stale_revision', 'invalid_revision', 'seat_unavailable', 'too_far', 'not_facing', 'player_dead', 'weapon_mismatch', 'not_ready', 'stale_collision']);
  let collisionNoticeShown = false;
  let pendingMelee = null, meleeTimer = 0;
  const meleeQueue = [];
  const pendingEntityInputs = new Map();
  let entityTimer = 0, lastEntityBatchSentAt = -Infinity;
  let lastWorldSyncAt = -Infinity, interactionSequence = 0;
  const weaponRuleByHash = new Map();
  let weaponRules = [];
  let sessionPolicy = null;
  // 每个游戏页独占连接与桥接，避免同一来源的多个标签页混用角色和身份。
  let receiver = null, latestStatus = null;
  const pendingControls = [];
  const pendingWorldEvents = new Map();
  const projectileEffects = new Map();
  const collisionQueries = new Map();
  const identityKey = 'gta5.public.identity:' + address + ':' + preferences.name;
  let savedIdentity = null;
  // 主页主动选择角色属于新加入；刷新游戏页才读取上一身份。当前连接的自动重连仍使用之后保存的身份。
  if (options.reconnect === true) {
    try { savedIdentity = JSON.parse(sessionStorage.getItem(identityKey)); } catch { /* 不支持存储时可正常加入。 */ }
    if (!validResumeIdentity(savedIdentity)) savedIdentity = null;
  }
  let socket = null, clientId = null, room = null, welcomed = false, profiled = false, stopped = false;
  let attemptedResumeId = null, resumed = false, resumeStateReady = false;
  let identityLock = null, lockGeneration = 0;
  let supportsAppearance = false, supportsActions = false;
  let supportsCombat = false, supportsResume = false, supportsHeartbeat = false, supportsSnapshot = false;
  let supportsCombatFeedback = false;
  let supportsWorldV2 = false;
  const serverFeatures = new Set();
  let supportsEntityBatch = false;
  let supportsMeleeEvents = false;
  let spawn = null;
  let reconnectTimer = 0, connectionTimer = 0, stateTimer = 0, shotTimer = 0, heartbeatTimer = 0, snapshotTimer = 0, attempts = 0;
  let lastServerMessageAt = performance.now(), pingNonce = 0;
  let stateSequence = 0, shotSequence = 0, pendingState = null;
  let pendingShot = null, latestLocalState = null;
  let lastSentState = null, lastCombatResultSequence = -1;
  let lastStateSentAt = -Infinity, lastShotSentAt = -Infinity;
  let lastStatus = '', latestStatusSource = null;
  const statusLogHistory = new Map();
  let readyResolve, readyReject, initialDone = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // 首次连接失败由入口页处理；后续断线保持游戏运行并自动重连。
  const firstTimer = setTimeout(() => {
    if (!initialDone) { initialDone = true; readyReject(new Error(translateText('连接超时，请检查服务器地址及端口后重试。'))); }
  }, 12000);
  function releaseIdentityLock() {
    lockGeneration++;
    identityLock?.release();
    identityLock = null;
  }
  function acquireIdentityLock(id) {
    const locks = globalThis.navigator?.locks;
    if (!locks?.request) return Promise.resolve(true);
    if (identityLock?.id === id) return Promise.resolve(true);
    releaseIdentityLock();
    const generation = lockGeneration;
    return new Promise((resolve) => {
      let release;
      const held = new Promise((done) => { release = done; });
      try {
        const requested = locks.request('gta5.public.identity:' + address + ':' + id, { ifAvailable: true }, (lock) => {
          if (!lock || stopped || generation !== lockGeneration) { resolve(false); return; }
          identityLock = { id, generation, release };
          resolve(true);
          return held.finally(() => {
            if (identityLock?.generation === generation) identityLock = null;
          });
        });
        Promise.resolve(requested).catch(() => {
          // 浏览器禁用 Web Locks 时继续使用已有的单标签身份恢复。
          resolve(!stopped && generation === lockGeneration);
        });
      } catch { resolve(!stopped && generation === lockGeneration); }
    });
  }
  function emit(data) {
    if (receiver) {
      // 渲染器失败不能被当作网络错误，从而反复注销和重建服务端身份。
      try { receiver(data); } catch { /* 游戏桥自行报告同步错误。 */ }
    } else if (data.type === 'melee_event') {
      pendingWorldEvents.set(data.event_id, data);
    } else if (['damage', 'death', 'respawn', 'correction'].includes(data.type)) {
      pendingControls.push(data);
      if (pendingControls.length > 64) pendingControls.shift();
    }
  }
  function status(phase, text) {
    latestStatusSource = { phase, text };
    const displayText = text && typeof text === 'object' && text.serverError
      ? localizeServerError(text.serverError) + translateText(text.suffix || '') : translateText(text);
    const value = { phase, text: displayText, server: address, client_id: clientId,
      connected: Boolean(room && profiled), members: room?.members.length || 0,
      peers: [...peers.keys()].filter((id) => id !== clientId).length };
    const encoded = JSON.stringify(value);
    if (encoded === lastStatus) return;
    lastStatus = encoded;
    latestStatus = { type: 'network_status', ...value };
    try { onStatus(value); } catch { /* 界面回调不应中断连接。 */ }
    emit(latestStatus);
    // 只记录连接目标和玩家数量变化，不输出坐标、外观或逐帧状态。
    // Periodic membership/sync callbacks still reach the HUD, while each phase
    // logs only when its own state changed instead of alternating every poll.
    if (statusLogHistory.get(phase) !== encoded) {
      statusLogHistory.set(phase, encoded);
      try { fetch('/log', { method: 'POST', body: '[public-session] ' + encoded }).catch(() => {}); } catch {}
    }
  }
  function postSession() {
    const connected = Boolean(room && profiled);
    const ownState = connected && resumed ? peers.get(clientId)?.state : null;
    const cleanResumeState = ownState ? cleanPlayerState(ownState) : null;
    const resumeState = cleanResumeState ? { seq: ownState.seq, ...cleanResumeState } : null;
    emit({ type: 'session', language: getLanguage(), connected, client_id: connected ? clientId : null,
      members: connected ? room.members.map(({ id, name, connected }) => ({ id, name, connected: connected !== false })) : [],
      peers: connected ? [...peers.values()] : [],
      combat: connected ? [...combat.values()] : [],
      resumed: connected && resumed,
      resume_state_ready: connected && (!resumed || resumeStateReady),
      resume_state: resumeState,
      resume_position: resumeState?.position || null,
      spawn: connected ? spawn : null,
      weapon_rules: weaponRules.map((rule) => ({ ...rule })),
      session_policy: sessionPolicy && { ...sessionPolicy, allowed_scripts: [...sessionPolicy.allowed_scripts] },
      world_v2: supportsWorldV2,
      melee_events: supportsMeleeEvents,
      avatar: preferences.preset.endsWith('_female') ? 'female' : 'male', preset: preferences.preset, seed: preferences.seed,
      model: modelForPreset(preferences), appearance_spec: randomAppearance(preferences) });
  }
  const stopLanguage = onLanguageChange(() => {
    if (stopped) return;
    postSession();
    if (latestStatusSource) status(latestStatusSource.phase, latestStatusSource.text);
  });
  function postWorld() {
    if (supportsWorldV2) emit({ type: 'world_state_v2', ...world.state() });
  }
  function requestWorldSync() {
    const now = performance.now();
    if (!supportsWorldV2 || !profiled || now - lastWorldSyncAt < 1000) return;
    const current = world.state();
    if (send('world_sync', current.world_epoch ? { world_epoch: current.world_epoch, after_revision: current.world_revision } : {})) lastWorldSyncAt = now;
  }
  function logMelee(value) {
    try { fetch('/log', { method: 'POST', body: '[public-melee] ' + JSON.stringify(value) }).catch(() => {}); } catch {}
  }
  function wireRequestId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) return null;
    if (requestAliases.has(value)) return requestAliases.get(value);
    const wire = requestNamespace + ':' + (++wireRequestSequence).toString(36);
    requestAliases.set(value, wire);
    // 请求文本不截断，避免不同长ID映射到同一个服务器幂等键。
    if (requestAliases.size > 4096) requestAliases.delete(requestAliases.keys().next().value);
    return wire;
  }
  function receiveMeleeEvent(message) {
    const current = world.state();
    const meleeRule = weaponRuleByHash.get(message.weapon);
    const maximumDamage = meleeRule?.melee_damage ?? 20;
    const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
    const generation = (value) => Number.isSafeInteger(value) && value > 0;
    if (!supportsMeleeEvents || message.schema_version !== 2 || message.world_epoch !== current.world_epoch
      || !id(message.event_id) || !id(message.request_id) || !id(message.attacker_entity_id)
      || !id(message.attacker_id) || !generation(message.attacker_generation) || message.action !== 'punch'
      || message.accepted !== true || typeof message.hit !== 'boolean' || !Number.isInteger(message.damage)
      || message.damage < 0 || message.damage > maximumDamage || !Number.isSafeInteger(message.revision) || message.revision < 0
      || !Number.isSafeInteger(message.world_tick) || message.world_tick < 0) return;
    const attacker = world.entity(message.attacker_entity_id);
    const target = message.target_entity_id === null ? null : world.entity(message.target_entity_id);
    if (!attacker || attacker.kind !== 'ped' || attacker.generation !== message.attacker_generation
      || attacker.player_id !== message.attacker_id || (message.target_entity_id !== null
        && (!id(message.target_entity_id) || !target || target.kind !== 'ped' || target.generation !== message.target_generation))
      || (message.target_entity_id === null && message.target_generation !== null)
      || (message.hit && (!target || !Number.isInteger(message.health) || message.health < 0 || message.health > 200))
      || (!message.hit && (message.damage !== 0 || message.health !== null))) return;
    if (consumedMeleeEvents.has(message.event_id)) return;
    consumedMeleeEvents.add(message.event_id);
    if (consumedMeleeEvents.size > 256) consumedMeleeEvents.delete(consumedMeleeEvents.values().next().value);
    const event = { type: 'melee_event', schema_version: 2, world_epoch: message.world_epoch, event_id: message.event_id,
      request_id: message.request_id, action: 'punch', attacker_entity_id: message.attacker_entity_id,
      attacker_id: message.attacker_id, attacker_generation: message.attacker_generation,
      target_entity_id: message.target_entity_id, target_generation: message.target_generation,
      accepted: true, hit: message.hit, damage: message.damage, health: message.health, revision: message.revision, world_tick: message.world_tick };
    if (unsignedHash(message.weapon)) event.weapon = message.weapon;
    if (typeof message.melee_style === 'string' && /^[a-z_]{1,32}$/.test(message.melee_style)) event.melee_style = message.melee_style;
    logMelee({ stage: 'event', request_id: event.request_id, event_id: event.event_id,
      attacker_entity_id: event.attacker_entity_id, target_entity_id: event.target_entity_id,
      hit: event.hit, damage: event.damage, health: event.health, revision: event.revision, reason: '' });
    emit(event);
  }
  function clearPendingMelee() { pendingMelee = null; meleeQueue.length = 0; clearTimeout(meleeTimer); meleeTimer = 0; }
  function nextMelee() {
    pendingMelee = meleeQueue.shift() || null; clearTimeout(meleeTimer); meleeTimer = 0;
    if (pendingMelee) meleeTimer = setTimeout(flushMelee, 10);
  }
  function flushMelee() {
    clearTimeout(meleeTimer); meleeTimer = 0;
    if (!pendingMelee || stopped || !profiled) return;
    const current = world.state(), attempt = pendingMelee, target = attempt.entity_id ? world.entity(attempt.entity_id) : null;
    const actor = current.entities.find((entity) => entity.player_id === clientId);
    if (!current.ready || current.world_epoch !== attempt.world_epoch || performance.now() - attempt.at >= 250
      || (attempt.entity_id && (!target || target.generation !== attempt.target_generation)) || !actor
      || actor.generation !== attempt.attacker_generation || actor.components.combat?.alive === false) { clearPendingMelee(); return; }
    const state = latestLocalState;
    if (!state) { clearPendingMelee(); return; }
    pendingState = state;
    if (!socket || socket.bufferedAmount > 65536 || !flushState(true)) { meleeTimer = setTimeout(flushMelee, 10); return; }
    if (!send('interaction_request', { world_epoch: attempt.world_epoch, request_id: attempt.request_id,
      action: 'melee', ...(target ? { entity_id: target.entity_id, target_generation: attempt.target_generation,
        expected_revision: attempt.expected_revision } : {}) })) { meleeTimer = setTimeout(flushMelee, 10); return; }
    const details = { request_id: attempt.request_id, attacker_entity_id: actor.entity_id,
      attacker_generation: actor.generation, target_entity_id: target?.entity_id || null, target_generation: target?.generation || null };
    meleeRequests.set(attempt.request_id, details);
    if (meleeRequests.size > 128) meleeRequests.delete(meleeRequests.keys().next().value);
    logMelee({ stage: 'sent', ...details }); nextMelee();
  }
  function clearEntityInputs() {
    pendingEntityInputs.clear(); clearTimeout(entityTimer); entityTimer = 0;
  }
  function scheduleEntityInputs() {
    if (entityTimer || !pendingEntityInputs.size) return;
    entityTimer = setTimeout(flushEntityInputs, Math.max(100, 100 - (performance.now() - lastEntityBatchSentAt)));
  }
  function flushEntityInputs() {
    entityTimer = 0;
    const current = world.state(), now = performance.now();
    if (!supportsEntityBatch || !supportsWorldV2 || !current.ready || stopped || !profiled) { clearEntityInputs(); return; }
    const candidates = [];
    for (const [id, pending] of pendingEntityInputs) {
      const entity = world.entity(id);
      if (now - pending.at >= 250 || current.world_epoch !== pending.world_epoch || !entity
        || entity.owner_id !== clientId || (entity.ownership && entity.ownership !== 'active')
        || entity.owner_epoch !== pending.owner_epoch || entity.generation !== pending.generation
        || entity.components.attachment || (entity.components.combat && !entity.components.combat.alive)) { pendingEntityInputs.delete(id); continue; }
      candidates.push({ entity, pending });
    }
    // 当前受控车辆优先，NPC 保留最新一次姿态；每个网络批次最多24条。
    candidates.sort((a, b) => (a.entity.kind === 'vehicle' ? 0 : 1) - (b.entity.kind === 'vehicle' ? 0 : 1)
      || b.pending.at - a.pending.at);
    const selected = candidates.slice(0, 24);
    if (!selected.length) return;
    if (!socket || socket.bufferedAmount > 65536) { scheduleEntityInputs(); return; }
    const updates = selected.map(({ entity, pending }) => {
      const key = current.world_epoch + ':' + entity.entity_id + ':' + entity.generation + ':' + entity.owner_epoch;
      const seq = Math.max(entityInputSequences.get(key) || 0,
        Number.isSafeInteger(entity.last_input_seq) ? entity.last_input_seq : -1) + 1;
      return { entity_id: entity.entity_id, owner_epoch: entity.owner_epoch, input_seq: seq, based_on_revision: entity.revision,
        transform: pending.transform, ...(pending.view ? { view: pending.view } : {}) };
    });
    if (!send('entity_batch', { world_epoch: current.world_epoch, updates })) { scheduleEntityInputs(); return; }
    lastEntityBatchSentAt = now;
    for (let index = 0; index < selected.length; index++) {
      const { entity } = selected[index];
      entityInputSequences.set(current.world_epoch + ':' + entity.entity_id + ':' + entity.generation + ':' + entity.owner_epoch, updates[index].input_seq);
      pendingEntityInputs.delete(entity.entity_id);
    }
    scheduleEntityInputs();
  }
  function worldWorkerMessage(data) {
    if (!supportsWorldV2 || !world.state().ready || !socket
      || (data.type !== 'entity_input' && !(data.type === 'interaction_request' && data.action === 'melee')
        && socket.bufferedAmount > 65536)) return;
    const current = world.state();
    const ownPlayer = current.entities.find((entry) => entry.player_id === clientId);
    const meleeNoTarget = data.type === 'interaction_request' && ['melee', 'detonate'].includes(data.action) && !data.entity_id;
    const leaveFromPlayer = data.type === 'interaction_request' && data.action === 'leave_vehicle'
      && (!data.entity_id || data.entity_id === ownPlayer?.entity_id);
    const targetId = leaveFromPlayer ? ownPlayer?.components.attachment?.entity_id
      : data.type === 'simulation_result' && !Object.hasOwn(data, 'entity_id') ? ownPlayer?.entity_id : data.entity_id;
    const entity = meleeNoTarget ? ownPlayer : world.entity(targetId);
    if (!entity || (Object.hasOwn(data, 'world_epoch') && data.world_epoch !== current.world_epoch)) return;
    if (data.type === 'entity_ready') {
      if (entity.owner_id !== clientId || (entity.ownership && entity.ownership !== 'offered')
        || (Object.hasOwn(data, 'owner_epoch') && data.owner_epoch !== entity.owner_epoch)) return;
      const key = current.world_epoch + ':' + entity.entity_id + ':' + entity.generation + ':' + entity.owner_epoch;
      if (entityReadyEpochs.has(key)) return;
      if (send('entity_ready', { world_epoch: current.world_epoch, entity_id: entity.entity_id, owner_epoch: entity.owner_epoch })) entityReadyEpochs.set(key, true);
      return;
    }
    if (data.type === 'interaction_request') {
      if (!['enter_vehicle', 'leave_vehicle', 'melee', 'detonate'].includes(data.action)
        || Object.keys(data).some((key) => !['type', 'world_epoch', 'entity_id', 'action', 'seat', 'request_id', 'expected_revision', 'target_generation', 'attacker_generation', 'actor_generation', 'state'].includes(key))
        || (data.action === 'enter_vehicle' && (entity.kind !== 'vehicle' || !/^(driver|passenger:(?:[0-9]|1[0-5]))$/.test(data.seat)))
        || (!meleeNoTarget && Object.hasOwn(data, 'target_generation') && data.target_generation !== entity.generation)
        || (!leaveFromPlayer && !meleeNoTarget && Object.hasOwn(data, 'expected_revision') && (!Number.isSafeInteger(data.expected_revision)
          || data.expected_revision < 0 || data.expected_revision > entity.revision))) return;
      const requestId = wireRequestId(data.request_id ?? 'request-' + (++interactionSequence));
      if (!requestId) return;
      if (data.action === 'detonate') {
        send('interaction_request', { world_epoch: current.world_epoch, request_id: requestId, action: 'detonate' }); return;
      }
      if (data.action === 'melee') {
        if (!ownPlayer || entity.kind !== 'ped'
          || (Object.hasOwn(data, 'attacker_generation') && data.attacker_generation !== ownPlayer.generation)
          || (Object.hasOwn(data, 'actor_generation') && data.actor_generation !== ownPlayer.generation)) return;
        if (Object.hasOwn(data, 'state')) {
          const clean = cleanPlayerState(data.state);
          if (!clean) return;
          latestLocalState = clean; pendingState = clean;
        }
        if (!latestLocalState) return;
        const attempt = { world_epoch: current.world_epoch, request_id: requestId, entity_id: meleeNoTarget ? null : entity.entity_id,
          target_generation: meleeNoTarget ? null : entity.generation, attacker_generation: ownPlayer.generation,
          expected_revision: meleeNoTarget ? null : (data.expected_revision ?? entity.revision), at: performance.now() };
        if (pendingMelee) { meleeQueue.push(attempt); if (meleeQueue.length > 8) meleeQueue.splice(7, 1); }
        else pendingMelee = attempt;
        flushMelee(); return;
      }
      send('interaction_request', { world_epoch: current.world_epoch, request_id: requestId, action: data.action,
        entity_id: entity.entity_id, target_generation: entity.generation,
        expected_revision: leaveFromPlayer ? entity.revision : (data.expected_revision ?? entity.revision),
        ...(data.action === 'enter_vehicle' ? { seat: data.seat } : {}) });
      return;
    }
    if (entity.owner_id !== clientId || (entity.ownership && entity.ownership !== 'active')
      || (Object.hasOwn(data, 'owner_epoch') && data.owner_epoch !== entity.owner_epoch)
      || (Object.hasOwn(data, 'generation') && data.generation !== entity.generation)) return;
    const key = current.world_epoch + ':' + entity.entity_id + ':' + entity.generation + ':' + entity.owner_epoch;
    const inputSequence = Math.max(entityInputSequences.get(key) || 0,
      Number.isSafeInteger(entity.last_input_seq) ? entity.last_input_seq : -1) + 1;
    if (data.type === 'entity_input') {
      // 当前玩家角色仍由 v1 的有验证状态入口投影；v2 动态提议用于已授权车辆。
      if (!['vehicle', 'ped'].includes(entity.kind) || entity.player_id !== null
        || entity.components.attachment
        || Object.keys(data).some((name) => !['type', 'world_epoch', 'entity_id', 'owner_epoch', 'generation', 'based_on_revision', 'transform', 'view'].includes(name))
        || (Object.hasOwn(data, 'based_on_revision') && (!Number.isSafeInteger(data.based_on_revision)
          || data.based_on_revision < 0 || data.based_on_revision > entity.revision))) return;
      const transform = cleanWorldTransform(data.transform);
      if (!transform) return;
      let view;
      if (Object.hasOwn(data, 'view')) {
        if (!data.view || Array.isArray(data.view)) return;
        if (entity.kind === 'vehicle') {
          if (Object.keys(data.view).length !== 2 || typeof data.view.engine_on !== 'boolean' || typeof data.view.lights_on !== 'boolean') return;
          view = { engine_on: data.view.engine_on, lights_on: data.view.lights_on };
        } else {
          if (Object.keys(data.view).some((name) => !['weapon', 'shooting', 'actions', 'aim_target'].includes(name))) return;
          const clean = cleanPlayerState({ position: transform.position, heading: 0, model: entity.model, health: 200, ...data.view });
          if (!clean || !clean.actions) return;
          view = { weapon: clean.weapon, shooting: clean.shooting, actions: clean.actions,
            ...(clean.aim_target ? { aim_target: clean.aim_target } : {}) };
        }
      }
      if (supportsEntityBatch) {
        if (!pendingEntityInputs.has(entity.entity_id) && pendingEntityInputs.size >= 256) return;
        pendingEntityInputs.set(entity.entity_id, { world_epoch: current.world_epoch, owner_epoch: entity.owner_epoch,
          generation: entity.generation, at: performance.now(), transform, view });
        scheduleEntityInputs();
      } else if (socket.bufferedAmount <= 65536 && send('entity_input', { world_epoch: current.world_epoch, entity_id: entity.entity_id,
        owner_epoch: entity.owner_epoch, input_seq: inputSequence, based_on_revision: entity.revision, transform,
        ...(view ? { view } : {}) })) entityInputSequences.set(key, inputSequence);
    } else if (data.type === 'simulation_result') {
      const envelope = { world_epoch: current.world_epoch, entity_id: entity.entity_id, owner_epoch: entity.owner_epoch, input_seq: inputSequence };
      if (data.kind === 'life_report') {
        if (entity.player_id !== clientId || !['environmental', 'dead', 'arrest'].includes(data.reason)
          || !Number.isInteger(data.health) || data.health < 0 || data.health > 200
          || Object.keys(data).some((name) => !['type', 'world_epoch', 'entity_id', 'owner_epoch', 'generation', 'kind', 'reason', 'health'].includes(name))) return;
        if (send('simulation_result', { ...envelope, kind: 'life_report', reason: data.reason, health: data.health })) entityInputSequences.set(key, inputSequence);
      } else if (data.kind === 'vehicle_damage') {
        if (entity.kind !== 'vehicle' || !Number.isFinite(data.engine_health) || data.engine_health < -4000
          || data.engine_health > entity.components.vehicle.engine_health || !Number.isFinite(data.body_health) || data.body_health < 0
          || data.body_health > entity.components.vehicle.body_health
          || Object.keys(data).some((name) => !['type', 'world_epoch', 'entity_id', 'owner_epoch', 'generation', 'kind', 'engine_health', 'body_health'].includes(name))) return;
        if (send('simulation_result', { ...envelope, kind: 'vehicle_damage', engine_health: data.engine_health, body_health: data.body_health })) entityInputSequences.set(key, inputSequence);
      } else if (data.kind === 'entity_health') {
        if (entity.kind !== 'ped' || entity.player_id !== null || !Number.isInteger(data.health) || data.health < 0
          || data.health > Math.min(200, entity.components.combat?.health ?? 0)
          || Object.keys(data).some((name) => !['type', 'world_epoch', 'entity_id', 'owner_epoch', 'generation', 'kind', 'health'].includes(name))) return;
        if (send('simulation_result', { ...envelope, kind: 'entity_health', health: data.health })) entityInputSequences.set(key, inputSequence);
      } else if (data.kind === 'npc_shot') {
        const target = world.entity(data.target_entity_id), response = entity.law_response;
        if (entity.kind !== 'ped' || entity.player_id !== null || response?.role !== 'officer' || response.phase !== 'active'
            || !target || target.generation !== data.target_generation || target.entity_id !== response.target_entity_id
            || target.generation !== response.target_generation || target.components.combat?.alive === false
            || Object.keys(data).some(name => !['type', 'world_epoch', 'entity_id', 'owner_epoch', 'generation', 'kind', 'target_entity_id', 'target_generation'].includes(name))) return;
        if (send('simulation_result', { ...envelope, kind: 'npc_shot', target_entity_id: target.entity_id, target_generation: target.generation })) entityInputSequences.set(key, inputSequence);
      }
    }
  }
  function mergeCombat(value) {
    const player = cleanCombatPlayer(value);
    if (!player || (room && !room.members.some(({ id }) => id === player.id))) return false;
    const previous = combat.get(player.id);
    if (previous && player.revision < previous.revision) return false;
    combat.set(player.id, { ...previous, ...player });
    return true;
  }
  function applyCombatEvent(message) {
    if (Object.hasOwn(message, 'room_id') && message.room_id !== room?.id) return false;
    const id = message.type === 'damage' ? message.victim_id : message.player_id;
    if (typeof id !== 'string' || !room?.members.some((member) => member.id === id)) return false;
    const previous = combat.get(id);
    const revision = Object.hasOwn(message, 'revision') ? message.revision : 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || (previous && revision < previous.revision)) return false;
    const health = message.type === 'death' ? 0 : message.type === 'respawn' ? (message.health ?? 200) : message.health;
    return mergeCombat({ ...previous, id, revision, health, alive: health > 0,
      ...(message.type === 'respawn' && coordinates(message.position) ? { spawn: message.position.slice() } : {}),
      ...(message.type === 'death' && Number.isInteger(message.deaths) && message.deaths >= 0 ? { deaths: message.deaths } : {}) });
  }
  function mergePlayerState(id, value) {
    const state = cleanPlayerState(value);
    if (!state || !Number.isSafeInteger(value.seq) || value.seq < 0) return false;
    const previous = peers.get(id)?.state;
    // 伤害、死亡和重生会复用最后的移动序号，只有更小的序号才属于旧状态。
    if (previous && value.seq < previous.seq) return false;
    peers.set(id, { player_id: id, state: { seq: value.seq, ...state } });
    return true;
  }
  function send(type, fields) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify({ type, ...fields })); return true; } catch { return false; }
  }
  function outgoingState(value) {
    const next = { ...value };
    if (!supportsAppearance) delete next.appearance;
    if (!supportsActions) { delete next.actions; delete next.aim_target; }
    return next;
  }
  function logCombat(value) {
    try { fetch('/log', { method: 'POST', body: '[public-combat] ' + JSON.stringify(value) }).catch(() => {}); } catch {}
  }
  function flushState(force = false) {
    clearTimeout(stateTimer);
    stateTimer = 0;
    if (!pendingState || !room || !profiled || stopped) return false;
    const next = outgoingState(pendingState);
    // 引擎同一 tick 可能先上报状态再上报射击；已发送的同一快照不重复占状态预算。
    if (force && lastSentState && JSON.stringify(next) === JSON.stringify(lastSentState)) {
      pendingState = null; return true;
    }
    const delay = Math.max(0, (force ? 1000 / 30 : 50) - (performance.now() - lastStateSentAt));
    if (delay || socket?.bufferedAmount > 65536) {
      stateTimer = setTimeout(() => flushState(force), Math.max(10, delay)); return false;
    }
    if (!send('player_state', { seq: stateSequence + 1, ...next })) {
      stateTimer = setTimeout(() => flushState(), 50); return false;
    }
    stateSequence++; lastStateSentAt = performance.now(); lastSentState = next; pendingState = null;
    return true;
  }
  function clearPendingShot() {
    pendingShot = null; clearTimeout(shotTimer); shotTimer = 0;
  }
  function scheduleShot(delay = 10) {
    clearTimeout(shotTimer);
    shotTimer = setTimeout(flushShot, Math.max(10, Math.min(50, delay)));
  }
  function flushShot() {
    clearTimeout(shotTimer); shotTimer = 0;
    if (!pendingShot || !room || !profiled || stopped) return;
    const now = performance.now(), shot = pendingShot;
    if (now - shot.at >= shot.maxWait || latestLocalState?.weapon !== shot.event.weapon) {
      clearPendingShot(); return;
    }
    const rule = weaponRuleByHash.get(shot.event.weapon);
    const delay = Math.max(0, (rule ? Math.max(10, rule.cooldown_ms + 15) : 50) - (now - lastShotSentAt));
    if (delay || !socket || socket.bufferedAmount > 65536) { scheduleShot(delay || 10); return; }
    // 一条有限寿命的射击等待最新同武器状态，防止单发被状态节流或短暂背压丢弃。
    pendingState = latestLocalState || shot.state;
    if (!pendingState || pendingState.weapon !== shot.event.weapon || !flushState(true)) { scheduleShot(); return; }
    if (!send('shot_event', { seq: shotSequence + 1, ...shot.event })) { scheduleShot(); return; }
    shotSequence++; lastShotSentAt = now;
    logCombat({ stage: 'sent', client_id: clientId, seq: shotSequence, weapon: shot.event.weapon });
    clearPendingShot();
  }
  function onWorkerMessage(data) {
    if (data?.type === 'bridge_ready') { postSession(); postWorld(); return; }
    if (!room || !profiled || stopped) return;
    if (data?.type === 'collision_result') {
      const query = collisionQueries.get(data.query_id);
      if (!query || data.world_epoch !== query.world_epoch || data.world_epoch !== world.state().world_epoch
        || typeof data.complete !== 'boolean' || performance.now() > query.local_expires) return;
      collisionQueries.delete(data.query_id);
      const hits = data.hits;
      if (!Array.isArray(hits) || (data.complete && hits.length !== query.segments.length)
        || hits.some(hit => hit !== null && (!coordinates(hit.position) || !coordinates(hit.normal) || !unsignedHash(hit.material)))) return;
      send('collision_result', { schema_version: 2, world_epoch: query.world_epoch, query_id: query.query_id,
        complete: data.complete, hits: data.complete ? hits.map(hit => hit && ({ position: hit.position,
          normal: hit.normal, material: hit.material })) : [],
        ...(typeof data.reason === 'string' && /^[a-z_]{1,64}$/.test(data.reason) ? { reason: data.reason } : {}) });
      return;
    }
    if (['entity_ready', 'entity_input', 'interaction_request', 'simulation_result'].includes(data?.type)) { worldWorkerMessage(data); return; }
    if (data?.type === 'local_state') {
      const clean = cleanPlayerState(data.state);
      if (clean) {
        latestLocalState = clean;
        if (pendingShot && pendingShot.event.weapon !== clean.weapon) clearPendingShot();
        pendingState = clean; if (!stateTimer) flushState();
      }
    } else if (data?.type === 'local_shot') {
      const event = cleanShotEvent(data.event), now = performance.now();
      if (!event) return;
      let state;
      if (Object.hasOwn(data, 'state')) {
        state = cleanPlayerState(data.state);
        if (!state || state.weapon !== event.weapon) return;
      } else {
        state = latestLocalState || pendingState || lastSentState;
        if (!state || state.weapon !== event.weapon) return;
      }
      latestLocalState = state;
      const rule = weaponRuleByHash.get(event.weapon);
      pendingShot = { event, state, at: now, maxWait: Math.min(10250, Math.max(250, (rule?.cooldown_ms || 0) + 100)) };
      flushShot();
    }
  }
  function disconnect(text, retry = true) {
    clearTimeout(reconnectTimer); reconnectTimer = 0;
    clearTimeout(connectionTimer); connectionTimer = 0;
    clearTimeout(stateTimer); stateTimer = 0;
    clearPendingShot();
    clearPendingMelee(); meleeRequests.clear(); consumedMeleeEvents.clear();
    pendingWorldEvents.clear(); projectileEffects.clear(); collisionQueries.clear();
    clearEntityInputs(); lastEntityBatchSentAt = -Infinity;
    clearTimeout(heartbeatTimer); heartbeatTimer = 0;
    clearTimeout(snapshotTimer); snapshotTimer = 0;
    const previous = socket; socket = null;
    if (previous) { previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null; try { previous.close(); } catch {} }
    clientId = null; room = null; welcomed = profiled = false;
    attemptedResumeId = null; resumed = resumeStateReady = false;
    supportsAppearance = supportsActions = false;
    supportsCombat = supportsResume = supportsHeartbeat = supportsSnapshot = false;
    supportsCombatFeedback = false;
    supportsWorldV2 = false; serverFeatures.clear(); world.reset(); entityInputSequences.clear(); entityReadyEpochs.clear(); lastWorldSyncAt = -Infinity;
    supportsEntityBatch = false;
    supportsMeleeEvents = false;
    peers.clear(); combat.clear(); pendingState = null;
    latestLocalState = null;
    weaponRules = []; weaponRuleByHash.clear();
    lastSentState = null; lastCombatResultSequence = -1;
    // 新身份从 profile 的服务端序号恢复，不能把重连当作换一个玩家。
    lastStateSentAt = lastShotSentAt = -Infinity;
    postSession();
    if (stopped) status('closed', '已退出公共战局');
    if (!stopped && retry) {
      const wait = Math.min(5000, 500 * 2 ** Math.min(attempts++, 4));
      status('reconnecting', text && typeof text === 'object' && text.serverError
        ? { ...text, suffix: ' 正在重新连接…' } : text + ' 正在重新连接…');
      reconnectTimer = setTimeout(connect, wait);
    }
  }
  function hello(includeResume = true) {
    const capabilities = [
      ...(supportsCombat ? ['combat'] : []), ...(supportsResume ? ['resume'] : []),
      ...(supportsHeartbeat ? ['heartbeat'] : []), ...(supportsSnapshot ? ['snapshot'] : []),
      ...(supportsCombatFeedback ? ['combat_feedback'] : []),
      ...(supportsActions ? ['actions'] : []),
      ...(supportsWorldV2 ? ['world_v2'] : []),
      ...(supportsWorldV2 && serverFeatures.has('session_policy') ? ['session_policy'] : []),
      ...(supportsWorldV2 && serverFeatures.has('world_environment') ? ['world_environment'] : []),
      ...(supportsWorldV2 && serverFeatures.has('shared_law') ? ['shared_law'] : []),
      ...(supportsWorldV2 && serverFeatures.has('physics_queries') ? ['physics_queries'] : []),
      ...(supportsEntityBatch ? ['entity_batch'] : []),
      ...(supportsMeleeEvents ? ['melee_events'] : []),
    ];
    const identity = includeResume && supportsResume && validResumeIdentity(savedIdentity) ? savedIdentity : null;
    attemptedResumeId = null;
    if (send('hello', { name: preferences.name, ...(capabilities.length ? { capabilities } : {}),
      ...(identity ? { client_id: identity.client_id, resume_token: identity.resume_token } : {}) })) {
      attemptedResumeId = identity?.client_id || null;
    }
  }
  function completeInitialJoin() {
    // 刷新后必须先取得服务器原角色快照，不能在 world_state 到达前随机初始化服装和出生点。
    if (room && profiled && (!resumed || resumeStateReady) && (!supportsWorldV2 || world.state().ready)) {
      clearTimeout(connectionTimer); connectionTimer = 0;
      if (!initialDone) { initialDone = true; clearTimeout(firstTimer); readyResolve(); }
    }
  }
  function heartbeat() {
    heartbeatTimer = 0;
    if (!socket || !room || !profiled || stopped) return;
    if (performance.now() - lastServerMessageAt >= 25000) {
      disconnect('服务器长时间未响应。'); return;
    }
    if (supportsHeartbeat) {
      pingNonce = pingNonce >= Number.MAX_SAFE_INTEGER ? 1 : pingNonce + 1;
      send('ping', { nonce: pingNonce });
    }
    heartbeatTimer = setTimeout(heartbeat, 5000);
  }
  function snapshot() {
    snapshotTimer = 0;
    if (!socket || !room || !profiled || stopped || !supportsSnapshot) return;
    send('sync', {});
    if (supportsWorldV2 && !world.state().ready) requestWorldSync();
    snapshotTimer = setTimeout(snapshot, 10000);
  }
  function startRecoveryTimers() {
    if (!heartbeatTimer) heartbeatTimer = setTimeout(heartbeat, 5000);
    if (supportsSnapshot && !snapshotTimer) snapshotTimer = setTimeout(snapshot, 10000);
  }
  function validateRoom(value) {
    if (!value || value.id !== 'PUBLIC' || value.map !== 'gta5' || value.phase !== 'launched' || value.host_id !== null
      || !Array.isArray(value.members) || value.members.length > 1024
      || !value.members.every((member) => typeof member.id === 'string' && typeof member.name === 'string')
      || !value.members.some((member) => member.id === clientId)) throw new Error('服务器战局不兼容，请使用 GTA V 公共战局服务器。');
    return value;
  }
  function receive(message) {
    if (!message || typeof message.type !== 'string') throw new Error('服务器消息格式无效。');
    if (!welcomed && message.type !== 'welcome' && message.type !== 'error') throw new Error('服务器尚未完成连接确认。');
    switch (message.type) {
      case 'welcome':
        if (welcomed || message.protocol !== 1 || typeof message.client_id !== 'string' || !Array.isArray(message.capabilities)
          || !['public_session', 'player_state', 'shoot_events'].every((feature) => message.capabilities.includes(feature))) throw new Error('服务器协议不兼容。');
        welcomed = true; clientId = message.client_id;
        supportsAppearance = message.capabilities.includes('appearance');
        supportsActions = message.capabilities.includes('actions');
        supportsCombat = message.capabilities.includes('combat');
        supportsResume = message.capabilities.includes('resume');
        supportsHeartbeat = message.capabilities.includes('heartbeat');
        supportsSnapshot = message.capabilities.includes('snapshot');
        supportsCombatFeedback = message.capabilities.includes('combat_feedback');
        supportsWorldV2 = message.capabilities.includes('world_v2');
        serverFeatures.clear(); for (const feature of message.capabilities) serverFeatures.add(feature);
        supportsEntityBatch = supportsWorldV2 && message.capabilities.includes('entity_batch');
        supportsMeleeEvents = supportsWorldV2 && message.capabilities.includes('melee_events');
        weaponRules = Object.hasOwn(message, 'weapon_rules') ? cleanWeaponRules(message.weapon_rules) : [];
        if (!weaponRules) throw new Error('服务器武器规则格式无效。');
        sessionPolicy = Object.hasOwn(message, 'session_policy') ? cleanSessionPolicy(message.session_policy) : null;
        if (Object.hasOwn(message, 'session_policy') && !sessionPolicy) throw new Error('服务器战局脚本策略格式无效。');
        if (serverFeatures.has('session_policy') && !sessionPolicy) throw new Error('服务器未提供已声明的战局脚本策略。');
        weaponRuleByHash.clear(); for (const rule of weaponRules) weaponRuleByHash.set(rule.weapon, rule);
        hello();
        status('joining', '加入战局中');
        break;
      case 'profile':
        if (typeof message.client_id !== 'string' || typeof message.name !== 'string'
          || (!supportsResume && message.client_id !== clientId)) throw new Error('服务器玩家信息无效。');
        resumed = attemptedResumeId !== null && message.client_id === attemptedResumeId;
        clientId = message.client_id;
        spawn = coordinates(message.spawn) ? message.spawn.slice() : null;
        stateSequence = Math.max(0, Number.isSafeInteger(message.last_state_seq) ? message.last_state_seq : 0);
        shotSequence = Math.max(0, Number.isSafeInteger(message.last_shot_seq) ? message.last_shot_seq : 0);
        if (supportsResume && typeof message.resume_token === 'string') {
          savedIdentity = { client_id: clientId, resume_token: message.resume_token };
          try { sessionStorage.setItem(identityKey, JSON.stringify(savedIdentity)); } catch { /* 存储限制不影响当前连接。 */ }
          // 新加入的服务端 ID 同样持锁；网络中断时保留到页面真正退出。
          acquireIdentityLock(clientId);
        }
        profiled = true;
        break;
      case 'room_state': {
        const initial = !room;
        room = validateRoom(message.room);
        if (!profiled) throw new Error('服务器尚未确认玩家身份。');
        const members = new Set(room.members.map(({ id }) => id));
        for (const id of peers.keys()) if (!members.has(id)) peers.delete(id);
        for (const id of combat.keys()) if (!members.has(id)) combat.delete(id);
        attempts = 0;
        startRecoveryTimers();
        postSession(); status(initial ? 'joined' : 'membership', '已加入公共战局');
        completeInitialJoin();
        break;
      }
      case 'world_state': {
        if (message.room_id !== room?.id) return;
        if (!Array.isArray(message.states) || message.states.length > 1024) throw new Error('服务器战局状态格式无效。');
        const members = new Set(room.members.map(({ id }) => id));
        for (const entry of message.states) {
          if (members.has(entry.player_id)) mergePlayerState(entry.player_id, entry.state);
        }
        resumeStateReady = true;
        postSession(); status('sync', '正在同步公共战局玩家'); completeInitialJoin(); break;
      }
      case 'snapshot_begin': case 'snapshot_chunk': case 'snapshot_end': case 'world_delta': {
        if (!supportsWorldV2 || !profiled) break;
        const previousEpoch = world.state().world_epoch;
        const result = world.receive(message);
        if ((message.type === 'snapshot_begin' && result.changed) || result.needsSnapshot
          || previousEpoch !== world.state().world_epoch) { clearEntityInputs(); clearPendingMelee(); }
        if (previousEpoch && previousEpoch !== world.state().world_epoch) { pendingWorldEvents.clear(); projectileEffects.clear(); }
        if (result.changed) postWorld();
        if (result.needsSnapshot) requestWorldSync();
        completeInitialJoin();
        break;
      }
      case 'collision_query': {
        if (!supportsWorldV2 || !serverFeatures.has('physics_queries') || !world.state().ready
          || message.world_epoch !== world.state().world_epoch || message.observer_id !== clientId
          || message.schema_version !== 2 || typeof message.query_id !== 'string'
          || !message.query_id || message.query_id.length > 128 || collisionQueries.has(message.query_id)
          || !['shot', 'projectile', 'visibility'].includes(message.purpose)
          || !Number.isSafeInteger(message.issued_at) || !Number.isSafeInteger(message.expires_at)
          || message.expires_at <= message.issued_at || message.expires_at - message.issued_at > 5000
          || !Array.isArray(message.segments) || !message.segments.length || message.segments.length > 16
          || message.segments.some(segment => !coordinates(segment?.from) || !coordinates(segment?.to)
            || !Number.isFinite(segment.radius) || segment.radius < 0 || segment.radius > 2)) break;
        const query = { type: 'collision_query', schema_version: 2, world_epoch: message.world_epoch,
          query_id: message.query_id, observer_id: clientId, purpose: message.purpose,
          segments: message.segments.map(segment => ({ from: [...segment.from], to: [...segment.to], radius: segment.radius })),
          issued_at: message.issued_at, expires_at: message.expires_at };
        for (const [id, old] of collisionQueries) if (old.local_expires < performance.now()) collisionQueries.delete(id);
        if (collisionQueries.size >= 32) break;
        collisionQueries.set(query.query_id, { ...query, local_expires: performance.now() + Math.min(1000, query.expires_at - query.issued_at) });
        emit(query); break;
      }
      case 'interaction_result':
        if (supportsWorldV2 && typeof message.request_id === 'string' && message.request_id.length <= 64
          && typeof message.accepted === 'boolean' && (!Object.hasOwn(message, 'reason') || typeof message.reason === 'string')) {
          const previous = meleeRequests.get(message.request_id);
          if (previous) logMelee({ stage: 'result', ...previous, accepted: message.accepted,
            hit: message.hit === true, reason: typeof message.reason === 'string' ? message.reason.slice(0, 200) : '',
            ...(typeof message.attacker_entity_id === 'string' ? { attacker_entity_id: message.attacker_entity_id } : {}),
            ...(typeof message.target_entity_id === 'string' || message.target_entity_id === null ? { target_entity_id: message.target_entity_id } : {}) });
          emit({ type: 'interaction_result', request_id: message.request_id, accepted: message.accepted,
            ...(message.action === 'melee' || previous ? { action: 'melee', hit: message.hit === true } : {}),
            ...(typeof message.reason === 'string' ? { reason: message.reason.slice(0, 200) } : {}) });
        }
        break;
      case 'melee_event':
        receiveMeleeEvent(message);
        break;
      case 'world_shot_event': {
        const current = world.state(), attacker = world.entity(message.attacker_entity_id), target = world.entity(message.target_entity_id);
        const task = attacker?.ai_task;
        if (!current.ready || message.world_epoch !== current.world_epoch || typeof message.event_id !== 'string'
            || message.event_id.length > 200 || !attacker || !target || task?.action !== 'combat'
            || task.target_entity_id !== target.entity_id || task.target_generation !== target.generation
            || attacker.generation !== message.attacker_generation || target.generation !== message.target_generation
            || message.weapon !== attacker.components.ped.weapon || !coordinates(message.origin) || !coordinates(message.target)) break;
        emit({ type: 'world_shot_event', ...message }); break;
      }
      case 'projectile_event':
      case 'explosion_event': {
        const current = world.state();
        if (!supportsWorldV2 || message.room_id !== room?.id || message.world_epoch !== current.world_epoch) break;
        const effect = cleanProjectileEffect(message);
        if (!effect) throw new Error('服务器投射物事件格式无效。');
        if (effect.type === 'projectile_event') {
          if (effect.phase === 'expired') projectileEffects.delete(effect.projectile_id);
          else projectileEffects.set(effect.projectile_id, effect);
        } else {
          projectileEffects.delete(effect.projectile_id);
          if (effect.effect_duration_ms) projectileEffects.set(effect.projectile_id, { type: 'area_effect',
            projectile_id: effect.projectile_id, weapon: effect.weapon, position: effect.position,
            expires_at: effect.world_tick + effect.effect_duration_ms, radius: effect.radius, damage_type: effect.damage_type });
        }
        emit(effect); break;
      }
      case 'projectile_state': {
        const current = world.state();
        if (!supportsWorldV2 || message.room_id !== room?.id || message.world_epoch !== current.world_epoch) break;
        if (!Array.isArray(message.effects) || message.effects.length > 256) throw new Error('服务器投射物基线格式无效。');
        const effects = message.effects.map(value => cleanProjectileEffect(value, { area: value.type === 'area_effect' }));
        if (effects.some(value => !value)) throw new Error('服务器投射物基线格式无效。');
        projectileEffects.clear(); for (const effect of effects) projectileEffects.set(effect.projectile_id, effect);
        emit({ type: 'projectile_state', world_epoch: current.world_epoch, world_tick: current.world_tick, effects }); break;
      }
      case 'player_state': {
        if (message.room_id !== room?.id || !room.members.some(({ id }) => id === message.player_id)) return;
        const state = cleanPlayerState(message.state);
        if (!state || !Number.isSafeInteger(message.state.seq) || message.state.seq < 0) throw new Error('服务器角色状态格式无效。');
        if (!mergePlayerState(message.player_id, message.state)) return;
        if (resumed && message.player_id === clientId) postSession();
        emit({ ...message, state: peers.get(message.player_id).state }); status('sync', '正在同步公共战局玩家'); break;
      }
      case 'shot_event':
        if (message.room_id !== room?.id || !room.members.some(({ id }) => id === message.player_id)) return;
        if (!cleanShotEvent(message.event) || !Number.isSafeInteger(message.event.seq) || message.event.seq < 0) throw new Error('服务器射击事件格式无效。');
        emit(message); break;
      case 'shot_queued':
      case 'shot_geometry_pending':
      case 'shot_cancelled':
        // 执行队列与地图验证是合法进度；最终反馈使用 shot_result / damage。
        // 此广播也会到达旁观玩家，不可把等待几何结果当作未知协议而断线。
        break;
      case 'shot_result': {
        // 战斗反馈不可把正常拒绝或未来版本扩展变成整个战局断线。
        if (!supportsCombatFeedback || !profiled) break;
        const result = cleanShotResult(message);
        if (!result || result.seq <= lastCombatResultSequence) break;
        lastCombatResultSequence = result.seq;
        logCombat({ stage: 'result', client_id: clientId, seq: result.seq, weapon: result.weapon,
          accepted: result.accepted, hit: result.hit, reason: result.reason || '',
          ...(Object.hasOwn(result, 'victim_id') ? { victim_id: result.victim_id } : {}),
          ...(Object.hasOwn(result, 'damage') ? { damage: result.damage } : {}),
          ...(Object.hasOwn(result, 'health') ? { health: result.health } : {}),
          ...(Object.hasOwn(result, 'revision') ? { revision: result.revision } : {}) });
        emit({ type: 'combat_feedback', ...result });
        break;
      }
      case 'chat': break; // 游戏页不显示大厅聊天。
      case 'combat_state':
        if (!supportsCombat || !Array.isArray(message.players)) return;
        if (Object.hasOwn(message, 'room_id') && message.room_id !== room?.id) return;
        for (const player of message.players) mergeCombat(player);
        emit({ ...message, players: [...combat.values()] });
        break;
      case 'damage': case 'death': case 'respawn':
        if (supportsCombat && applyCombatEvent(message)) {
          // 完整快照的权威版本先更新；随后控制消息不会被下一次周期快照覆盖回旧生命状态。
          postSession(); emit(message);
        }
        break;
      case 'correction':
        if (supportsCombat) emit(message);
        break;
      case 'pong':
        if (!Number.isSafeInteger(message.nonce) || message.nonce < 0) throw new Error('服务器心跳格式无效。');
        break;
      case 'error':
        if (!profiled && ['resume_denied', 'invalid_resume', 'resume_expired'].includes(message.code)) {
          savedIdentity = null;
          try { sessionStorage.removeItem(identityKey); } catch {}
          // 服务端重启或恢复窗口到期时，仍使用当前连接重新加入，不无限重试失效凭据。
          hello(false);
          break;
        }
        if (profiled && quietRejections.has(message.code)) break;
        if (profiled && message.code === 'invalid_collision') {
          if (!collisionNoticeShown) {
            collisionNoticeShown = true;
            status('notice', '碰撞观测未通过服务器校验，本次判定已跳过。');
          }
          break;
        }
        if (profiled && ['rate_limited', 'stale_seq', 'invalid_shot', 'invalid_movement', 'not_ready', 'player_dead', 'unsupported_weapon', 'weapon_mismatch',
          'stale_input', 'wrong_world', 'invalid_owner', 'not_owner', 'invalid_lease', 'invalid_revision', 'attached_entity', 'dead_entity',
          'seat_unavailable', 'invalid_seat', 'invalid_component', 'unsupported_interaction', 'stale_owner', 'simulation_not_ready',
          'player_input_required', 'health_increase_denied', 'unsupported_simulation', 'invalid_target', 'invalid_reason', 'not_facing', 'invalid_request',
          'too_far', 'stale_revision', 'stale_generation', 'unknown_entity', 'snapshot_required', 'invalid_batch', 'invalid_message', 'static_entity'].includes(message.code)) {
          const chinese = message.code === 'unsupported_weapon' ? '服务器武器目录不识别当前武器，请更新服务端资源目录。'
            : message.code === 'weapon_mismatch' ? '武器切换尚未同步，请稍后重新射击。'
            : typeof message.message === 'string' ? message.message : '服务器未接受这次操作';
          status('notice', { serverError: { code: message.code, message: message.message, chinese } });
          if (['unsupported_weapon', 'weapon_mismatch'].includes(message.code)) emit({ type: 'combat_feedback', accepted: false,
            hit: false, reason: message.code });
          break;
        }
        // Keep typed diagnostics internally so a visible error can be rendered
        // again when the launcher changes language without touching player text.
        const error = new Error(localizeServerError(message));
        error.serverError = { code: message.code, message: typeof message.message === 'string' ? message.message.slice(0, 300) : undefined };
        throw error;
      default: throw new Error('服务器消息类型不兼容，请检查服务器版本。');
    }
  }
  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    if (stopped || socket) return;
    statusLogHistory.clear(); // A new transport is a real connection lifecycle.
    status('connecting', '正在连接服务器');
    let current;
    try { current = new WebSocket(address); }
    catch { disconnect('无法连接服务器。'); return; }
    socket = current;
    lastServerMessageAt = performance.now();
    connectionTimer = setTimeout(() => { if (socket === current) disconnect('服务器连接超时。'); }, 10000);
    current.onmessage = ({ data }) => {
      if (socket !== current) return;
      try {
        if (typeof data !== 'string' || data.length > 1024 * 1024) throw new Error('服务器消息超过允许的大小。');
        receive(JSON.parse(data));
        if (socket === current) lastServerMessageAt = performance.now();
      } catch (error) { disconnect(error instanceof SyntaxError ? '服务器消息无法解析。'
        : error.serverError ? { serverError: error.serverError } : error.message); }
    };
    current.onerror = () => { if (socket === current) disconnect('连接失败，请检查服务器 IP 和端口。'); };
    current.onclose = () => { if (socket === current) disconnect('战局连接已中断。'); };
  }
  function checkConnection() {
    if (stopped) return;
    if (socket && room && profiled && performance.now() - lastServerMessageAt >= 25000) {
      disconnect('服务器长时间未响应。');
    }
    // 网络恢复或标签页重新激活时立即尝试连接，不等待上一轮退避。
    if (!socket) connect();
  }
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') checkConnection();
  }
  function setReceiver(next) {
    if (next !== null && typeof next !== 'function') throw new TypeError('游戏桥接收器必须是函数。');
    receiver = next;
    if (receiver) {
      postSession();
      postWorld();
      if (projectileEffects.size) emit({ type: 'projectile_state', world_epoch: world.state().world_epoch,
        world_tick: world.state().world_tick, effects: [...projectileEffects.values()] });
      if (latestStatus) emit(latestStatus);
      const controls = pendingControls.splice(0);
      for (const control of controls) emit(control);
      const events = [...pendingWorldEvents.values()]; pendingWorldEvents.clear();
      for (const event of events) if (event.world_epoch === world.state().world_epoch) emit(event);
      for (const query of collisionQueries.values()) {
        if (query.world_epoch === world.state().world_epoch && query.local_expires > performance.now()) {
          const { local_expires, ...wireQuery } = query; emit(wireQuery);
        }
      }
    }
  }
  function close() {
    if (stopped) return;
    stopped = true; stopLanguage(); clearTimeout(firstTimer); clearTimeout(reconnectTimer);
    disconnect('', false);
    removeEventListener('pagehide', close);
    removeEventListener('online', checkConnection);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    releaseIdentityLock();
    receiver = null; pendingControls.length = 0; pendingWorldEvents.clear();
    if (!initialDone) { initialDone = true; readyReject(new Error(translateText('已取消连接。'))); }
  }
  addEventListener('pagehide', close, { once: true });
  addEventListener('online', checkConnection);
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (savedIdentity) {
    if (!await acquireIdentityLock(savedIdentity.client_id)) savedIdentity = null;
  }
  connect();
  return { ready, close, setReceiver, onWorkerMessage };
}
