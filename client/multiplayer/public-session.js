import { normalizeServerAddress } from './server-address.js';
import { modelForPreset, normalizeAppearance, randomAppearance } from './appearance.js';

const coordinates = (value) => Array.isArray(value) && value.length === 3
  && value.every((number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 16000);
const unsignedHash = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const ACTION_KEYS = ['aiming', 'reloading', 'jumping', 'ducking', 'sprinting'];
const validResumeIdentity = (value) => value && typeof value.client_id === 'string'
  && value.client_id.length > 0 && value.client_id.length <= 128
  && typeof value.resume_token === 'string' && value.resume_token.length > 0 && value.resume_token.length <= 512;
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
  return { seq: value.seq, weapon: value.weapon, accepted: value.accepted, hit,
    ...(Object.hasOwn(value, 'victim_id') ? { victim_id: value.victim_id } : {}),
    ...(Object.hasOwn(value, 'damage') ? { damage: value.damage } : {}),
    ...(Object.hasOwn(value, 'health') ? { health: value.health } : {}),
    ...(Object.hasOwn(value, 'reason') ? { reason: value.reason } : {}) };
}

// 游戏页直接持有连接。关闭大厅不会影响战局，也不需要另开浏览器标签页。
export async function startPublicSession(preferences, onStatus = () => {}, options = {}) {
  const address = normalizeServerAddress(preferences.server, location.href);
  const peers = new Map();
  const combat = new Map();
  // 每个游戏页独占连接与桥接，避免同一来源的多个标签页混用角色和身份。
  let receiver = null, latestStatus = null;
  const pendingControls = [];
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
  let spawn = null;
  let reconnectTimer = 0, connectionTimer = 0, stateTimer = 0, shotTimer = 0, heartbeatTimer = 0, snapshotTimer = 0, attempts = 0;
  let lastServerMessageAt = performance.now(), pingNonce = 0;
  let stateSequence = 0, shotSequence = 0, pendingState = null;
  let pendingShot = null, latestLocalState = null;
  let lastSentState = null, lastCombatResultSequence = -1;
  let lastStateSentAt = -Infinity, lastShotSentAt = -Infinity;
  let lastStatus = '';
  let readyResolve, readyReject, initialDone = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // 首次连接失败由入口页处理；后续断线保持游戏运行并自动重连。
  const firstTimer = setTimeout(() => {
    if (!initialDone) { initialDone = true; readyReject(new Error('连接超时，请检查服务器地址及端口后重试。')); }
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
    } else if (['damage', 'death', 'respawn', 'correction'].includes(data.type)) {
      pendingControls.push(data);
      if (pendingControls.length > 64) pendingControls.shift();
    }
  }
  function status(phase, text) {
    const value = { phase, text, server: address, client_id: clientId,
      connected: Boolean(room && profiled), members: room?.members.length || 0,
      peers: [...peers.keys()].filter((id) => id !== clientId).length };
    const encoded = JSON.stringify(value);
    if (encoded === lastStatus) return;
    lastStatus = encoded;
    latestStatus = { type: 'network_status', ...value };
    try { onStatus(value); } catch { /* 界面回调不应中断连接。 */ }
    emit(latestStatus);
    // 只记录连接目标和玩家数量变化，不输出坐标、外观或逐帧状态。
    try { fetch('/log', { method: 'POST', body: '[public-session] ' + encoded }).catch(() => {}); } catch {}
  }
  function postSession() {
    const connected = Boolean(room && profiled);
    const ownState = connected && resumed ? peers.get(clientId)?.state : null;
    const cleanResumeState = ownState ? cleanPlayerState(ownState) : null;
    const resumeState = cleanResumeState ? { seq: ownState.seq, ...cleanResumeState } : null;
    emit({ type: 'session', connected, client_id: connected ? clientId : null,
      members: connected ? room.members.map(({ id, name, connected }) => ({ id, name, connected: connected !== false })) : [],
      peers: connected ? [...peers.values()] : [],
      combat: connected ? [...combat.values()] : [],
      resumed: connected && resumed,
      resume_state_ready: connected && (!resumed || resumeStateReady),
      resume_state: resumeState,
      resume_position: resumeState?.position || null,
      spawn: connected ? spawn : null,
      avatar: preferences.preset.endsWith('_female') ? 'female' : 'male', preset: preferences.preset, seed: preferences.seed,
      model: modelForPreset(preferences), appearance_spec: randomAppearance(preferences) });
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
    if (now - shot.at >= 250 || latestLocalState?.weapon !== shot.event.weapon) {
      clearPendingShot(); return;
    }
    const delay = Math.max(0, 50 - (now - lastShotSentAt));
    if (delay || !socket || socket.bufferedAmount > 65536) { scheduleShot(delay || 10); return; }
    // 一条有限寿命的射击等待最新同武器状态，防止单发被状态节流或短暂背压丢弃。
    pendingState = latestLocalState || shot.state;
    if (!pendingState || pendingState.weapon !== shot.event.weapon || !flushState(true)) { scheduleShot(); return; }
    if (!send('shot_event', { seq: shotSequence + 1, ...shot.event })) { scheduleShot(); return; }
    shotSequence++; lastShotSentAt = now;
    logCombat({ stage: 'sent', seq: shotSequence, weapon: shot.event.weapon });
    clearPendingShot();
  }
  function onWorkerMessage(data) {
    if (data?.type === 'bridge_ready') { postSession(); return; }
    if (!room || !profiled || stopped) return;
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
      pendingShot = { event, state, at: now };
      flushShot();
    }
  }
  function disconnect(text, retry = true) {
    clearTimeout(reconnectTimer); reconnectTimer = 0;
    clearTimeout(connectionTimer); connectionTimer = 0;
    clearTimeout(stateTimer); stateTimer = 0;
    clearPendingShot();
    clearTimeout(heartbeatTimer); heartbeatTimer = 0;
    clearTimeout(snapshotTimer); snapshotTimer = 0;
    const previous = socket; socket = null;
    if (previous) { previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null; try { previous.close(); } catch {} }
    clientId = null; room = null; welcomed = profiled = false;
    attemptedResumeId = null; resumed = resumeStateReady = false;
    supportsAppearance = supportsActions = false;
    supportsCombat = supportsResume = supportsHeartbeat = supportsSnapshot = false;
    supportsCombatFeedback = false;
    peers.clear(); combat.clear(); pendingState = null;
    latestLocalState = null;
    lastSentState = null; lastCombatResultSequence = -1;
    // 新身份从 profile 的服务端序号恢复，不能把重连当作换一个玩家。
    lastStateSentAt = lastShotSentAt = -Infinity;
    postSession();
    if (stopped) status('closed', '已退出公共战局');
    if (!stopped && retry) {
      const wait = Math.min(5000, 500 * 2 ** Math.min(attempts++, 4));
      status('reconnecting', text + ' 正在重新连接…');
      reconnectTimer = setTimeout(connect, wait);
    }
  }
  function hello(includeResume = true) {
    const capabilities = [
      ...(supportsCombat ? ['combat'] : []), ...(supportsResume ? ['resume'] : []),
      ...(supportsHeartbeat ? ['heartbeat'] : []), ...(supportsSnapshot ? ['snapshot'] : []),
      ...(supportsCombatFeedback ? ['combat_feedback'] : []),
      ...(supportsActions ? ['actions'] : []),
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
    if (room && profiled && (!resumed || resumeStateReady)) {
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
        attempts = 0;
        startRecoveryTimers();
        postSession(); status(initial ? 'joined' : 'membership', '已加入公共战局');
        completeInitialJoin();
        break;
      }
      case 'world_state': {
        if (message.room_id !== room?.id) return;
        if (!Array.isArray(message.states) || message.states.length > 1024) throw new Error('服务器战局状态格式无效。');
        peers.clear();
        const members = new Set(room.members.map(({ id }) => id));
        for (const entry of message.states) {
          const state = cleanPlayerState(entry.state);
          if (members.has(entry.player_id) && state && Number.isSafeInteger(entry.state.seq) && entry.state.seq >= 0) {
            peers.set(entry.player_id, { player_id: entry.player_id, state: { seq: entry.state.seq, ...state } });
          }
        }
        resumeStateReady = true;
        postSession(); status('sync', '正在同步公共战局玩家'); completeInitialJoin(); break;
      }
      case 'player_state': {
        if (message.room_id !== room?.id || !room.members.some(({ id }) => id === message.player_id)) return;
        const state = cleanPlayerState(message.state);
        if (!state || !Number.isSafeInteger(message.state.seq) || message.state.seq < 0) throw new Error('服务器角色状态格式无效。');
        peers.set(message.player_id, { player_id: message.player_id, state: { seq: message.state.seq, ...state } });
        if (resumed && message.player_id === clientId) postSession();
        emit(message); status('sync', '正在同步公共战局玩家'); break;
      }
      case 'shot_event':
        if (message.room_id !== room?.id || !room.members.some(({ id }) => id === message.player_id)) return;
        if (!cleanShotEvent(message.event) || !Number.isSafeInteger(message.event.seq) || message.event.seq < 0) throw new Error('服务器射击事件格式无效。');
        emit(message); break;
      case 'shot_result': {
        // 战斗反馈不可把正常拒绝或未来版本扩展变成整个战局断线。
        if (!supportsCombatFeedback || !profiled) break;
        const result = cleanShotResult(message);
        if (!result || result.seq <= lastCombatResultSequence) break;
        lastCombatResultSequence = result.seq;
        logCombat({ stage: 'result', seq: result.seq, weapon: result.weapon,
          accepted: result.accepted, hit: result.hit, reason: result.reason || '' });
        emit({ type: 'combat_feedback', ...result });
        break;
      }
      case 'chat': break; // 游戏页不显示大厅聊天。
      case 'combat_state':
        if (!supportsCombat || !Array.isArray(message.players)) return;
        combat.clear();
        for (const player of message.players) {
          if (typeof player.id === 'string' && Number.isInteger(player.health) && player.health >= 0 && player.health <= 200
              && typeof player.alive === 'boolean' && Number.isSafeInteger(player.revision)) combat.set(player.id, player);
        }
        emit({ ...message, players: [...combat.values()] });
        break;
      case 'damage': case 'death': case 'respawn': case 'correction':
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
        if (profiled && ['rate_limited', 'stale_seq', 'invalid_shot', 'invalid_movement', 'not_ready', 'player_dead', 'unsupported_weapon', 'weapon_mismatch'].includes(message.code)) {
          const text = message.code === 'unsupported_weapon' ? '当前武器暂不支持多人伤害同步，请使用普通枪械。'
            : message.code === 'weapon_mismatch' ? '武器切换尚未同步，请稍后重新射击。'
            : typeof message.message === 'string' ? message.message : '服务器未接受这次操作';
          status('notice', text);
          if (['unsupported_weapon', 'weapon_mismatch'].includes(message.code)) emit({ type: 'combat_feedback', accepted: false,
            hit: false, reason: message.code });
          break;
        }
        throw new Error(typeof message.message === 'string' ? message.message.slice(0, 300) : '服务器未能完成操作。');
      default: throw new Error('服务器消息类型不兼容，请检查服务器版本。');
    }
  }
  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    if (stopped || socket) return;
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
      } catch (error) { disconnect(error instanceof SyntaxError ? '服务器消息无法解析。' : error.message); }
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
      if (latestStatus) emit(latestStatus);
      const controls = pendingControls.splice(0);
      for (const control of controls) emit(control);
    }
  }
  function close() {
    if (stopped) return;
    stopped = true; clearTimeout(firstTimer); clearTimeout(reconnectTimer);
    disconnect('', false);
    removeEventListener('pagehide', close);
    removeEventListener('online', checkConnection);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    releaseIdentityLock();
    receiver = null; pendingControls.length = 0;
    if (!initialDone) { initialDone = true; readyReject(new Error('已取消连接。')); }
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
