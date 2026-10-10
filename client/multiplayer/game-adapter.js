// 游戏页直接持有公共战局连接；引擎线程通过共享内存读取最新快照，避免阻塞帧循环。
import { getLanguage, onLanguageChange, translateText, localizeServerError } from '../i18n.js';

export function installGameAdapter(worker, network = null, { watchOnlineConfiguration, onEntryState, entryAttempt = 0, reducedMotion = false } = {}) {
  // 正常在线游戏直接连接本页网络会话，避免同一端口多个标签页串用身份和外观。
  // 广播频道仅保留给独立探针或旧测试入口。
  const channel = network ? null : new BroadcastChannel('gta5-public-bridge-v1');
  const sendLocal = (message) => network ? network.onWorkerMessage(message) : channel.postMessage(message);
  const peers = new Map();
  let session = { connected: false, client_id: null, members: [], avatar: 'male', preset: 'npc_male', seed: 0 };
  let shots = [];
  let nextShotId = 0;
  let combat = [];
  let world = null;
  let worldEvents = [], nextWorldEventId = 0;
  let worldShots = [], nextWorldShotId = 0;
  const projectiles = new Map(), areaEffects = new Map();
  const collisionQueries = new Map();
  let effectEvents = [], nextEffectId = 0;
  const seenWorldEvents = new Set();
  let oldServerNotice = false;
  const combatById = new Map();
  const confirmedHits = new Set();
  let controls = [], nextControlId = 0;
  let notices = [], nextNoticeId = 0;
  let nativeHud = false, lastNetworkNotice = '', lastGamePhase = '', lastKills = null;
  let shared = null;
  let engineReady = false;
  let entry = { attempt_id: entryAttempt, cancelled: false, reduced_motion: reducedMotion === true };
  let nativeEntry = null, entrySentAt = -Infinity;
  let entryTraceKey = '', entryTraceSignature = '';
  const entryTrace = [];
  function entryIdentity() {
    const identity = world?.entities?.find(entity => entity.player_id === session.client_id);
    return identity && typeof identity.entity_id === 'string' && identity.entity_id
      && Number.isSafeInteger(identity.generation) && identity.generation >= 1 ? identity : null;
  }
  function entryState() {
    if (closed || typeof onEntryState !== 'function') return;
    const identity = entryIdentity();
    const current = identity && nativeEntry?.attempt_id === entry.attempt_id && nativeEntry?.world_epoch === world?.world_epoch
      && nativeEntry?.client_id === session.client_id && nativeEntry?.generation === identity.generation ? nativeEntry : null;
    onEntryState({ attemptId: entry.attempt_id, connected: session.connected === true,
      networkReady: session.connected === true && world?.ready === true,
      serverVersion: session.connected ? session.server_version || '' : '',
      engineReady, worldEpoch: world?.world_epoch || '', characterReady: current?.character_ready === true,
      sceneReady: current?.scene_ready === true, cameraActive: current?.camera_active === true,
      cameraPhase: current?.camera_phase === 'complete' && current.camera_done && !current.cleanup_pending ? 'finished' : current?.camera_active ? 'active' : '',
      cameraOutcome: current?.camera_phase === 'fallback' && current.camera_done && !current.cleanup_pending ? 'skipped' : '',
      serverReady: session.entry_readiness !== true || session.entry_ready === true,
      ...(current?.error ? { error: current.error } : {}) });
  }
  let timer = 0;
  let closed = false;
  // Worker status types interleave every tick. Remember each type independently
  // and coalesce its newest sample instead of posting one HTTP request per tick.
  const reportHistory = new Map(), pendingReports = new Map();
  let reportTimer = 0, reportTimeout = 0, reportInFlight = false, reportController = null;
  let lastReportSentAt = -Infinity;
  let networkMessage = '', gameMessage = '';
  let lastCombatNotice = '', lastCombatNoticeAt = -Infinity;
  let remoteConfig = { oltitle: '-', source: 'unavailable', stale: true };
  const stopRemoteConfiguration = watchOnlineConfiguration?.((value) => { remoteConfig = value; schedule(); });
  const text = (zh, en, nativeZh = zh) => ({ zh, en, nativeZh });
  function localize(value, native = false) {
    if (value?.serverError) return localizeServerError(native && value.nativeChinese
      ? { ...value.serverError, chinese: value.nativeChinese } : value.serverError);
    if (value && typeof value === 'object') return getLanguage() === 'en' ? value.en : native ? value.nativeZh : value.zh;
    return translateText(value || '');
  }
  const stopLanguage = onLanguageChange(() => { renderHud(); schedule(); });
  function mergeCombat(value) {
    if (!value || typeof value.id !== 'string') return;
    const revision = Number.isSafeInteger(value.revision) ? value.revision : 0;
    const previous = combatById.get(value.id);
    if (previous && (previous.revision ?? 0) > revision) return;
    combatById.set(value.id, { ...previous, ...value, revision });
    combat = [...combatById.values()];
  }
  function mergeControlCombat(event) {
    if (!['damage', 'death', 'respawn'].includes(event.type)) return true;
    const id = event.type === 'damage' ? event.victim_id : event.player_id;
    const revision = Number.isSafeInteger(event.revision) ? event.revision : 0;
    if (typeof id !== 'string' || revision < (combatById.get(id)?.revision ?? 0)) return false;
    const health = event.type === 'death' ? 0 : event.health;
    if (Number.isInteger(health)) mergeCombat({ id, health, alive: health > 0, revision,
      ...(event.type === 'respawn' && Array.isArray(event.position) ? { spawn: event.position } : {}) });
    return true;
  }
  function mergePeer(peer) {
    if (!peer?.player_id || peer.player_id === session.client_id || !peer.state) return;
    const old = peers.get(peer.player_id)?.state;
    if (Number.isSafeInteger(peer.state.seq) && Number.isSafeInteger(old?.seq) && peer.state.seq < old.seq) return;
    peers.set(peer.player_id, peer);
  }
  function combatFeedback(data) {
    if (data.accepted === false && ['rate_limited', 'cooldown', 'stale_seq', 'stale_input', 'stale_generation',
      'invalid_revision', 'seat_unavailable', 'weapon_mismatch', 'not_ready', 'player_dead'].includes(data.reason)) return;
    const victim = data.victim_id || data.target_entity_id;
    if (data.hit === true && victim && Number.isSafeInteger(data.revision)) {
      const key = victim + ':' + data.revision;
      if (confirmedHits.has(key)) return;
      confirmedHits.add(key);
      while (confirmedHits.size > 256) confirmedHits.delete(confirmedHits.values().next().value);
    }
    const rejected = {
      unsupported_weapon: text('当前武器暂不支持多人伤害同步，请使用普通枪械。', 'This weapon does not support multiplayer damage yet. Use a regular firearm.', '目前武器暫不支援多人傷害同步，請使用一般槍械。'),
      weapon_mismatch: text('武器切换尚未同步，请稍后重新射击。', 'Weapon switch is still synchronizing. Try firing again shortly.', '武器切換尚未同步，請稍後重新射擊。'),
      player_dead: text('已阵亡，等待服务器重生。', 'You died. Waiting for server respawn.', '已陣亡，等待伺服器重生。'),
      not_ready: text('角色状态尚未同步，请稍后重新射击。', 'Your character is still synchronizing. Try firing again shortly.', '角色狀態尚未同步，請稍後重新射擊。'),
      stale_seq: text('本次射击已过期，请重新射击。', 'This shot expired. Fire again.', '這次射擊已過期，請重新射擊。'),
      invalid_shot: text('服务器未接受这次射击，请重新瞄准。', 'The server could not accept this shot. Aim again.', '伺服器未接受這次射擊，請重新瞄準。'),
      rate_limited: text('射击过快，请稍后重试。', 'Firing too quickly. Try again shortly.', '射擊過快，請稍後重試。'),
    };
    const lines = data.accepted === false ? (rejected[data.reason] || text('服务器未接受这次射击。', 'The server could not accept this shot.', '伺服器未接受這次射擊。'))
      : data.hit ? (data.health === 0 ? text('击杀已由服务器确认。', 'Kill confirmed by the server.', '擊殺已由伺服器確認。')
        : text((data.action === 'melee' ? '拳击命中' : '命中玩家') + (Number.isInteger(data.damage) ? ' · 伤害 ' + data.damage : ''),
          (data.action === 'melee' ? 'Melee hit' : 'Player hit') + (Number.isInteger(data.damage) ? ' · Damage ' + data.damage : ''),
          (data.action === 'melee' ? '拳擊命中' : '命中玩家') + (Number.isInteger(data.damage) ? ' · 傷害 ' + data.damage : ''))) : null;
    // 未命中仍由连接模块记录判定，但不让原生通知盖满整个战局。
    if (!lines) return;
    gameMessage = lines; renderHud();
    const key = data.accepted === false ? 'reject:' + (data.reason || '') : data.health === 0 ? 'kill' : (data.action || 'shot') + ':hit';
    const now = performance.now();
    if (key !== lastCombatNotice || now - lastCombatNoticeAt >= 1500) {
      lastCombatNotice = key; lastCombatNoticeAt = now; notify(lines);
    }
  }
  function meleeFeedback(data) {
    // 仅采用连接模块校验、服务端确认的命中事件；本地挥拳或动作播放不产生提示/伤害。
    if (data.accepted !== true || data.hit !== true || !Number.isInteger(data.damage) || data.damage <= 0
      || data.damage > 200 || !Number.isInteger(data.health) || data.health < 0 || data.health > 200) return;
    if (data.attacker_id === session.client_id) {
      combatFeedback({ ...data, action: 'melee' });
    } else if (world.entities.some((entity) => entity.entity_id === data.target_entity_id
      && entity.player_id === session.client_id && entity.generation === data.target_generation)) {
      gameMessage = text('受到拳击 · 生命 ' + data.health + '/200', 'Melee damage received · Health ' + data.health + '/200'); renderHud();
      // 生命值以每次命中的服务器结果显示，避免挥拳动作存在而扣血结果不可见。
      notify(data.health === 0 ? text('拳击致死，等待服务器重生', 'Killed by melee. Waiting for server respawn.', '拳擊致死，等待伺服器重生')
        : text('受到拳击 · 伤害 ' + data.damage + ' · 生命 ' + data.health + '/200', 'Melee damage received · Damage ' + data.damage + ' · Health ' + data.health + '/200',
          '受到拳擊 · 傷害 ' + data.damage + ' · 生命 ' + data.health + '/200'));
    }
  }
  function renderHud() {
    const hud = document.getElementById('hud');
    if (hud) {
      hud.style.display = nativeHud ? 'none' : '';
      hud.textContent = nativeHud ? '' : [networkMessage, gameMessage].filter(Boolean).map(value => localize(value)).join(' · ');
    }
  }
  function notify(value) {
    notices.push({ id: ++nextNoticeId, value });
    if (notices.length > 16) notices.shift();
    schedule();
  }

  function reportStatus(value) {
    if (closed) return;
    let serialized;
    try { serialized = JSON.stringify(value); } catch { return; }
    if (!serialized) return;
    // Bound malformed diagnostics too; keep each log line valid JSON for probes.
    if (serialized.length > 8192) serialized = JSON.stringify({ phase: value.phase,
      message: String(value.message || value.text || '').slice(0, 2048),
      ...(Array.isArray(value.tail) ? { tail: value.tail.slice(-8).map(line => String(line).slice(0, 256)) } : {}), truncated: true });
    const kind = value.phase || 'unknown';
    const key = kind + (kind === 'world_entity' ? ':' + String(value.entity_id).slice(0, 160)
      : kind === 'script_policy' ? ':' + String(value.script).slice(0, 160) : '');
    // A world transaction increments revision even when the displayed state is
    // unchanged. Keep it in the diagnostic payload, not its change signature.
    const signature = ['synchronizing', 'loading_avatar', 'recovering_avatar', 'dead', 'world_environment'].includes(kind)
      ? JSON.stringify({ ...value, revision: undefined }) : serialized;
    if (reportHistory.get(key) === signature) {
      // A pending batch may still carry the latest observed revision without
      // scheduling another request solely because that revision advanced.
      if (pendingReports.has(key)) pendingReports.get(key).text = serialized;
      return;
    }
    reportHistory.delete(key); reportHistory.set(key, signature);
    while (reportHistory.size > 256) reportHistory.delete(reportHistory.keys().next().value);
    const urgent = kind === 'error' || kind === 'engine_crash';
    pendingReports.delete(key); pendingReports.set(key, { text: serialized, urgent });
    while (pendingReports.size > 128) {
      const oldestNormal = [...pendingReports].find(([, report]) => !report.urgent)?.[0];
      pendingReports.delete(oldestNormal ?? pendingReports.keys().next().value);
    }
    scheduleReports(urgent);
  }
  function scheduleReports(urgent = false) {
    if (closed || reportInFlight || !pendingReports.size) return;
    if (reportTimer) {
      if (!urgent) return;
      clearTimeout(reportTimer); reportTimer = 0;
    }
    const interval = urgent ? 250 : 1000;
    const delay = Math.max(0, interval - (performance.now() - lastReportSentAt));
    if (urgent && delay === 0) { flushReports(); return; }
    // First normal report is also batched, so startup statuses share one request.
    reportTimer = setTimeout(flushReports, Number.isFinite(lastReportSentAt) ? delay : interval);
  }
  function flushReports() {
    reportTimer = 0;
    if (closed || reportInFlight || !pendingReports.size) return;
    const lines = [];
    let bytes = 0;
    // Preserve urgent diagnostics before ordinary samples when the queue is full.
    const entries = [...pendingReports].sort((a, b) => Number(b[1].urgent) - Number(a[1].urgent));
    for (const [key, report] of entries) {
      const line = '[public-client] ' + report.text;
      const length = new TextEncoder().encode(line).length + 1;
      if (lines.length >= 64 || bytes + length > 65536) break;
      lines.push(line); bytes += length; pendingReports.delete(key);
    }
    reportInFlight = true; lastReportSentAt = performance.now();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    reportController = controller;
    let finished = false;
    const complete = () => {
      if (finished) return;
      finished = true; clearTimeout(reportTimeout); reportTimeout = 0;
      reportController = null; reportInFlight = false;
      scheduleReports([...pendingReports.values()].some(report => report.urgent));
    };
    // A stalled diagnostics endpoint must never accumulate concurrent requests.
    reportTimeout = setTimeout(() => { controller?.abort(); complete(); }, 5000);
    try { Promise.resolve(fetch('/log', { method: 'POST', body: lines.join('\n'),
      ...(controller ? { signal: controller.signal } : {}) })).then(complete, complete); }
    catch { complete(); } // Logging failures never interrupt gameplay or retry old samples.
  }

  const crashes = new BroadcastChannel('game-crash');
  crashes.onmessage = ({ data }) => {
    if (!data || !data.text) return;
    reportStatus({ phase: 'engine_crash', thread: data.thread, text: data.text, tail: data.tail || [] });
    onEntryState?.({ attemptId: entry.attempt_id, error: getLanguage() === 'en' ? 'The game engine stopped. Please retry.' : '游戏引擎已停止，请重试。' });
  };

  function publish() {
    timer = 0;
    if (!shared || closed) return;
    const packet = { ...session, peers: [...peers.values()], shots, combat, controls,
      notices: notices.map(({ id, value }) => ({ id, text: localize(value, true) })),
      language: getLanguage(), engine_ready: engineReady, entry, world, world_events: worldEvents,
      remote_config: remoteConfig, world_shots: worldShots, world_projectiles: [...projectiles.values()],
      world_areas: [...areaEffects.values()], world_effects: effectEvents, collision_queries: [...collisionQueries.values()] };
    const bytes = new TextEncoder().encode(JSON.stringify(packet));
    if (bytes.length > shared.capacity) return;
    const header = new Int32Array(shared.memory.buffer, shared.block, 4);
    const payload = new Uint8Array(shared.memory.buffer, shared.block + 16, shared.capacity);
    // 序列锁：奇数表示写入中，偶数表示完整；引擎复制前后检查同一序号。
    Atomics.add(header, 0, 1);
    payload.set(bytes);
    Atomics.store(header, 1, bytes.length);
    Atomics.add(header, 0, 1);
  }

  function schedule() {
    if (!timer) timer = setTimeout(publish, 40);
  }

  const receive = (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'entry_status') {
      const identity = entryIdentity();
      if (session.connected && world?.ready && identity && data.ready === true && data.world_epoch === world.world_epoch
          && data.entity_id === identity.entity_id && data.generation === identity.generation) session.entry_ready = true;
      entryState(); schedule(); return;
    } else if (data.type === 'network_status') {
      networkMessage = data.connected ? text('服务器在线 · ' + (data.members || 1) + ' 位玩家', 'Server online · ' + (data.members || 1) + ' players')
        : (data.text || text('服务器连接中断，正在自动重连…', 'Connection lost. Reconnecting automatically…'));
      const key = data.connected ? 'online:' + (data.members || 1) : 'offline';
      if (key !== lastNetworkNotice) {
        lastNetworkNotice = key;
        notify(data.connected ? text('公共战局已连接 · ' + (data.members || 1) + ' 位玩家', 'Connected to public session · ' + (data.members || 1) + ' players',
          '公共戰局已連線 · ' + (data.members || 1) + ' 位玩家')
          : text('连接中断，正在自动重新连接…', 'Connection lost. Reconnecting automatically…', '連線中斷，正在自動重新連線…'));
      } else if (data.phase === 'notice' && data.text && !/武器/.test(data.text)) notify(String(data.text).slice(0, 200));
      renderHud();
      entryState();
      return;
    } else if (data.type === 'combat_feedback') {
      combatFeedback(data);
      return;
    } else if (data.type === 'world_state_v2') {
      if (world?.world_epoch && world.world_epoch !== data.world_epoch) {
        worldEvents = []; worldShots = []; seenWorldEvents.clear(); projectiles.clear(); areaEffects.clear(); effectEvents = [];
        collisionQueries.clear();
        nativeEntry = null; entrySentAt = -Infinity;
        if (session.entry_readiness) session.entry_ready = false;
      }
      world = { schema_version: 2, world_epoch: data.world_epoch, world_revision: data.world_revision,
        world_tick: data.world_tick, stream_seq: data.stream_seq, ready: data.ready === true,
        environment: data.environment || null, environment_received_at: data.environment_received_at || 0,
        environment_received_at_epoch: data.environment_received_at_epoch || 0,
        environment_server_tick: data.environment_server_tick || 0,
        session_policy: data.session_policy || null,
        law: data.law || null,
        entities: Array.isArray(data.entities) ? data.entities : [], tombstones: Array.isArray(data.tombstones) ? data.tombstones : [] };
    } else if (data.type === 'collision_query') {
      if (!world || data.world_epoch !== world.world_epoch || data.observer_id !== session.client_id) return;
      collisionQueries.set(data.query_id, data);
      while (collisionQueries.size > 32) collisionQueries.delete(collisionQueries.keys().next().value);
    } else if (['projectile_state', 'projectile_event', 'explosion_event'].includes(data.type)) {
      if (!world || data.world_epoch !== world.world_epoch) return;
      const received = { received_at: performance.now(), received_at_epoch: Number.isFinite(performance.timeOrigin)
        ? performance.timeOrigin + performance.now() : 0 };
      if (data.type === 'projectile_state') {
        projectiles.clear(); areaEffects.clear();
        for (const value of data.effects) (value.type === 'area_effect' ? areaEffects : projectiles)
          .set(value.projectile_id, { ...value, world_epoch: world.world_epoch, world_tick: value.world_tick ?? data.world_tick, ...received });
      } else if (data.type === 'projectile_event') {
        if (data.phase === 'expired') projectiles.delete(data.projectile_id);
        else projectiles.set(data.projectile_id, { ...data, ...received });
      } else {
        projectiles.delete(data.projectile_id);
        const key = 'effect:' + data.projectile_id + ':' + data.world_tick;
        if (!seenWorldEvents.has(key)) {
          seenWorldEvents.add(key); effectEvents.push({ id: ++nextEffectId, event: { ...data, ...received } });
          if (effectEvents.length > 64) effectEvents.splice(0, effectEvents.length - 64);
          if (data.effect_duration_ms) areaEffects.set(data.projectile_id, { ...data, ...received,
            expires_at: data.world_tick + data.effect_duration_ms });
        }
      }
      while (projectiles.size > 256) projectiles.delete(projectiles.keys().next().value);
      while (areaEffects.size > 256) areaEffects.delete(areaEffects.keys().next().value);
      while (seenWorldEvents.size > 256) seenWorldEvents.delete(seenWorldEvents.values().next().value);
    } else if (data.type === 'world_shot_event') {
      if (!world || data.world_epoch !== world.world_epoch || !data.event_id || seenWorldEvents.has(data.event_id)) return;
      seenWorldEvents.add(data.event_id); worldShots.push({ id: ++nextWorldShotId, event: data });
      if (worldShots.length > 32) worldShots.shift();
    } else if (data.type === 'melee_event') {
      if (!world || data.world_epoch !== world.world_epoch || !data.event_id || seenWorldEvents.has(data.event_id)) return;
      seenWorldEvents.add(data.event_id);
      if (seenWorldEvents.size > 256) seenWorldEvents.delete(seenWorldEvents.values().next().value);
      worldEvents.push({ id: ++nextWorldEventId, event: data });
      meleeFeedback(data);
    } else if (data.type === 'interaction_result') {
      if (data.accepted === false && !['rate_limited', 'cooldown', 'stale_seq', 'stale_input', 'stale_generation',
        'stale_revision', 'stale_owner', 'invalid_revision', 'seat_unavailable', 'too_far', 'not_facing', 'player_dead', 'not_ready'].includes(data.reason)) {
        notify({ serverError: { code: data.reason, chinese: '互动未完成，请稍后重试。' },
          nativeChinese: '互動未完成，請稍後重試。' });
      }
      return;
    } else if (data.type === 'session') {
      const previousId = session.client_id;
      session = { connected: data.connected === true, client_id: data.client_id || null,
        server_version: typeof data.server_version === 'string' && /^\d+\.\d+\.\d+$/.test(data.server_version) ? data.server_version : '',
        members: Array.isArray(data.members) ? data.members : [],
        avatar: data.avatar === 'female' ? 'female' : 'male',
        preset: data.preset || (data.avatar === 'female' ? 'freemode_female' : 'freemode_male'),
        seed: Number.isInteger(data.seed) ? data.seed >>> 0 : 0,
        model: Number.isInteger(data.model) ? data.model >>> 0 : undefined,
        appearance_spec: data.appearance_spec || {},
        weapon_rules: Array.isArray(data.weapon_rules) ? data.weapon_rules : [],
        session_policy: data.session_policy || null,
        world_v2: data.world_v2 === true,
        entry_readiness: data.entry_readiness === true, entry_ready: data.entry_ready === true,
        resumed: data.resumed === true,
        resume_state_ready: data.resume_state_ready === true,
        resume_state: data.resume_state || null,
        resume_position: data.resume_position || null, spawn: data.spawn || null };
      if (!session.connected || previousId !== session.client_id) { collisionQueries.clear(); nativeEntry = null; entrySentAt = -Infinity; }
      if (session.client_id && previousId && session.client_id !== previousId) { peers.clear(); combatById.clear(); }
      if (session.connected && (data.world_v2 === false || data.melee_events === false) && !oldServerNotice) {
        oldServerNotice = true;
        notify(text('服务器不支持近战，请更新服务端或重新连接', 'This server does not support melee. Update the server or reconnect.', '伺服器不支援近戰，請更新服務端或重新連線'));
      }
      const members = new Set(session.members.map((member) => member.id));
      for (const id of peers.keys()) if (!members.has(id)) peers.delete(id);
      for (const id of combatById.keys()) if (!members.has(id)) combatById.delete(id);
      for (const peer of data.peers || []) mergePeer(peer);
      if (!session.connected) { shots = []; controls = []; world = null; worldEvents = []; worldShots = []; seenWorldEvents.clear();
        projectiles.clear(); areaEffects.clear(); effectEvents = []; }
      for (const value of data.combat || []) mergeCombat(value);
      combat = [...combatById.values()];
    } else if (data.type === 'combat_state' && Array.isArray(data.players)) {
      for (const value of data.players) mergeCombat(value);
    } else if (['damage', 'death', 'respawn', 'correction'].includes(data.type)) {
      if (!mergeControlCombat(data)) return;
      if (data.type === 'damage' && data.attacker_id === session.client_id && Number.isSafeInteger(data.shot_seq)
          && Number.isInteger(data.damage) && data.damage > 0 && Number.isInteger(data.health)) {
        combatFeedback({ ...data, accepted: true, hit: true });
      }
      controls.push({ id: ++nextControlId, event: data });
      if (controls.length > 32) controls.shift();
      if (data.type === 'respawn' && data.player_id === session.client_id) notify(text('已重生，正在恢复角色', 'Respawned. Restoring character.', '已重生，正在恢復角色'));
      if (data.type === 'death' && data.player_id === session.client_id) {
        lastGamePhase = 'dead'; notify(text('已阵亡，等待服务器重生', 'You died. Waiting for server respawn.', '已陣亡，等待伺服器重生'));
      }
    } else if (data.type === 'player_state' && data.player_id !== session.client_id && data.state) {
      mergePeer({ player_id: data.player_id, state: data.state });
    } else if (data.type === 'shot_event' && data.player_id !== session.client_id && data.event) {
      shots.push({ id: ++nextShotId, player_id: data.player_id, event: data.event });
      if (shots.length > 32) shots.shift();
    } else return;
    entryState();
    schedule();
  };
  if (network) network.setReceiver(receive);
  else channel.onmessage = ({ data }) => receive(data);

  function onWorkerMessage(data) {
    const message = data?.multiplayer;
    if (!message) return;
    if (message.type === 'entry_status') {
      const identity = entryIdentity();
      if (!identity || !entry.attempt_id || message.attempt_id !== entry.attempt_id || message.world_epoch !== world?.world_epoch
          || message.client_id !== session.client_id || message.generation !== identity.generation) return;
      nativeEntry = message; entryState();
      // The host callback may synchronously cancel, reconnect or start another
      // attempt. Recheck its identity before asking the server for admission.
      if (!closed && !entry.cancelled && session.connected && world?.ready && session.entry_readiness && !session.entry_ready
          && entry.attempt_id === message.attempt_id && world.world_epoch === message.world_epoch
          && entryIdentity() === identity
          && message.character_ready === true && message.scene_ready === true && message.camera_done === true
          && !message.cleanup_pending && performance.now() - entrySentAt >= 1000) {
        entrySentAt = performance.now();
        sendLocal({ type: 'entry_ready', world_epoch: world.world_epoch, entity_id: identity.entity_id, generation: identity.generation });
      }
      const traceKey = [message.attempt_id, message.client_id, message.world_epoch, message.generation].join(':');
      if (entryTraceKey !== traceKey) { entryTraceKey = traceKey; entryTrace.length = 0; entryTraceSignature = ''; }
      const entrySample = { camera: message.camera_phase, camera_stage: message.camera_stage,
        camera_active: message.camera_active === true, cloud_active: message.cloud_active === true,
        sound_cues: message.sound_cues || 0, sound_reason: message.sound_reason || null,
        character_ready: message.character_ready, scene_ready: message.scene_ready,
        cleanup_pending: message.cleanup_pending, reason: message.reason };
      const entrySampleSignature = JSON.stringify(entrySample);
      if (entrySampleSignature !== entryTraceSignature) {
        entryTraceSignature = entrySampleSignature;
        entryTrace.push({ at_ms: Math.round(performance.now()), ...entrySample });
        if (entryTrace.length > 20) entryTrace.shift();
      }
      // Keep short transitions through HTTP log coalescing, including failed
      // camera activation. A later admission must not erase what actually ran.
      reportStatus({ phase: 'entry', ...entrySample, transitions: [...entryTrace] });
      return;
    } else if (message.type === 'memory') {
      shared = message;
      publish();
      sendLocal({ type: 'bridge_ready' });
      reportStatus({ phase: 'engine_ready' });
    } else if (message.type === 'shot_ack' && Array.isArray(message.ids)) {
      const consumed = new Set(message.ids);
      shots = shots.filter((shot) => !consumed.has(shot.id));
      schedule();
    } else if (message.type === 'control_ack' && Array.isArray(message.ids)) {
      const consumed = new Set(message.ids);
      controls = controls.filter((control) => !consumed.has(control.id));
      schedule();
    } else if (message.type === 'world_event_ack' && Array.isArray(message.ids)) {
      const consumed = new Set(message.ids);
      worldEvents = worldEvents.filter((entry) => !consumed.has(entry.id));
      schedule();
    } else if (message.type === 'world_shot_ack' && Array.isArray(message.ids)) {
      const consumed = new Set(message.ids); worldShots = worldShots.filter(entry => !consumed.has(entry.id)); schedule();
    } else if (message.type === 'world_effect_ack' && Array.isArray(message.ids)) {
      const consumed = new Set(message.ids); effectEvents = effectEvents.filter(entry => !consumed.has(entry.id)); schedule();
    } else if (message.type === 'notice_ack' && Array.isArray(message.ids)) {
      const consumed = new Set(message.ids);
      notices = notices.filter((notice) => !consumed.has(notice.id));
      schedule();
    } else if (message.type === 'native_hud') {
      nativeHud = message.available === true;
      renderHud();
    } else if (message.type === 'collision_result') {
      collisionQueries.delete(message.query_id); sendLocal(message); schedule();
    } else if (['local_state', 'local_shot', 'entity_ready', 'entity_input', 'interaction_request', 'simulation_result'].includes(message.type)) {
      sendLocal(message);
    } else if (message.type === 'game_status') {
      gameMessage = message.role_recovering ? text('正在自动恢复在线角色…', 'Restoring online character automatically…')
        : message.role_loading ? text('正在加载在线角色…', 'Loading online character…')
        : message.alive === false ? text('已阵亡 · 等待服务器重生', 'You died · Waiting for server respawn')
        : text('已显示 ' + message.peer_count + ' 位其他玩家' + (Number.isInteger(message.health)
          ? ' · 生命值 ' + message.health + ' · 击杀 ' + (message.kills || 0) + ' / 阵亡 ' + (message.deaths || 0) : ''),
          message.peer_count + ' other players visible' + (Number.isInteger(message.health)
            ? ' · Health ' + message.health + ' · Kills ' + (message.kills || 0) + ' / Deaths ' + (message.deaths || 0) : ''));
      renderHud();
      const phase = message.role_recovering ? 'recovering_avatar' : message.role_loading ? 'loading_avatar'
        : message.alive === false ? 'dead' : 'synchronizing';
      if (phase !== lastGamePhase) {
        const previous = lastGamePhase; lastGamePhase = phase;
        notify(phase === 'recovering_avatar' ? text('正在自动恢复在线角色…', 'Restoring online character automatically…', '正在自動恢復線上角色…')
          : phase === 'loading_avatar' ? text('正在加载在线角色…', 'Loading online character…', '正在載入線上角色…')
          : phase === 'dead' ? text('已阵亡，等待服务器重生', 'You died. Waiting for server respawn.', '已陣亡，等待伺服器重生')
          : previous === 'recovering_avatar' ? text('角色已恢复，同步继续', 'Character restored. Synchronization resumed.', '角色已恢復，同步繼續')
            : text('公共战局已就绪', 'Public session ready.', '公共戰局已就緒'));
      }
      if (Number.isInteger(message.kills)) {
        if (lastKills !== null && message.kills > lastKills) notify(text('击杀成功 · 总击杀 ' + message.kills, 'Kill confirmed · Total kills ' + message.kills, '擊殺成功 · 總擊殺 ' + message.kills));
        lastKills = message.kills;
      }
      reportStatus({ phase, peers: message.peer_count,
        ...(message.client_id ? { client_id: message.client_id } : {}),
        ...(Number.isInteger(message.health) ? { server_health: message.health, server_alive: message.alive,
          revision: message.revision, native_health: message.native_health, native_dead: message.native_dead } : {}),
        ...(Number.isInteger(message.weapon) ? { weapon: message.weapon, weapon_ready: message.weapon_ready === true } : {}) });
    } else if (message.type === 'lifecycle') {
      reportStatus({ phase: 'lifecycle', ...message });
    } else if (message.type === 'life_reconcile') {
      reportStatus({ phase: 'life_reconcile', ...message });
    } else if (message.type === 'world_readiness') {
      reportStatus({ phase: 'world_readiness', ...message });
    } else if (message.type === 'shot_visual') {
      reportStatus({ phase: 'shot_visual', ...message });
    } else if (message.type === 'world_environment_status') {
      reportStatus({ phase: 'world_environment', ...message });
    } else if (message.type === 'world_entity_status') {
      reportStatus({ phase: 'world_entity', entity_id: message.entity_id,
        kind: message.kind, state: message.phase });
    } else if (message.type === 'script_policy') {
      reportStatus({ phase: 'script_policy', script: message.script, action: message.phase, policy: message.policy });
    } else if (message.type === 'radar_status') {
      reportStatus({ phase: 'radar', hidden: message.hidden, rendering: message.rendering,
        hud_preference: message.hud_preference, radar_preference: message.radar_preference, retrying: message.retrying });
    } else if (message.type === 'melee_sample') {
      reportStatus({ phase: 'melee_sample', request_id: message.request_id,
        actor_entity_id: message.actor_entity_id, source: message.source });
    } else if (message.type === 'bridge_error') {
      entry = { ...entry, cancelled: true }; nativeEntry = null; publish();
      onEntryState?.({ attemptId: entry.attempt_id, error: getLanguage() === 'en'
        ? 'Game synchronization stopped. Please retry.' : '游戏同步已停止，请重试。' });
      nativeHud = false;
      gameMessage = text('角色同步已暂停：' + message.message, 'Character synchronization paused: '
        + String(message.message).replace('同步缓冲区分配失败', 'Could not allocate synchronization buffers'));
      renderHud();
      const hud = document.getElementById('hud');
      if (hud) hud.style.color = '#f96';
      reportStatus({ phase: 'error', message: message.message });
    }
  }

  sendLocal({ type: 'bridge_ready' });
  addEventListener('pagehide', () => {
    closed = true;
    stopRemoteConfiguration?.();
    stopLanguage?.();
    clearTimeout(timer);
    clearTimeout(reportTimer); clearTimeout(reportTimeout);
    reportController?.abort(); pendingReports.clear(); reportHistory.clear();
    sendLocal({ type: 'game_closed' });
    channel?.close();
    crashes.close();
  }, { once: true });
  return { onWorkerMessage, setEntryAttempt(attemptId, options = {}) {
    if (closed || !Number.isSafeInteger(attemptId) || attemptId <= 0) return;
    entry = { attempt_id: attemptId, cancelled: options.cancelled === true, reduced_motion: options.reducedMotion === true };
    if (session.entry_readiness) session.entry_ready = false;
    nativeEntry = null; entrySentAt = -Infinity; entryState(); publish();
  }, cancelEntry() {
    entry = { ...entry, cancelled: true }; publish();
  }, setEngineReady() {
    if (closed || engineReady) return;
    engineReady = true;
    entryState();
    schedule();
  } };
}
