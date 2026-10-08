// 游戏页直接持有公共战局连接；引擎线程通过共享内存读取最新快照，避免阻塞帧循环。
export function installGameAdapter(worker, network = null) {
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
  const seenWorldEvents = new Set();
  let oldServerNotice = false;
  const combatById = new Map();
  let controls = [], nextControlId = 0;
  let notices = [], nextNoticeId = 0;
  let nativeHud = false, lastNetworkNotice = '', lastGamePhase = '', lastKills = null;
  let shared = null;
  let timer = 0;
  let closed = false;
  let lastReport = '';
  let networkMessage = '', gameMessage = '';
  let lastCombatNotice = '', lastCombatNoticeAt = -Infinity;
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
    const rejected = {
      unsupported_weapon: ['当前武器暂不支持多人伤害同步，请使用普通枪械。', '目前武器暫不支援多人傷害同步，請使用一般槍械。'],
      weapon_mismatch: ['武器切换尚未同步，请稍后重新射击。', '武器切換尚未同步，請稍後重新射擊。'],
      player_dead: ['已阵亡，等待服务器重生。', '已陣亡，等待伺服器重生。'],
      not_ready: ['角色状态尚未同步，请稍后重新射击。', '角色狀態尚未同步，請稍後重新射擊。'],
      stale_seq: ['本次射击已过期，请重新射击。', '這次射擊已過期，請重新射擊。'],
      invalid_shot: ['服务器未接受这次射击，请重新瞄准。', '伺服器未接受這次射擊，請重新瞄準。'],
      rate_limited: ['射击过快，请稍后重试。', '射擊過快，請稍後重試。'],
    };
    const lines = data.accepted === false ? (rejected[data.reason] || ['服务器未接受这次射击。', '伺服器未接受這次射擊。'])
      : data.hit ? (data.health === 0 ? ['击杀已由服务器确认。', '擊殺已由伺服器確認。']
        : [(data.action === 'melee' ? '拳击命中' : '命中玩家') + (Number.isInteger(data.damage) ? ' · 伤害 ' + data.damage : ''),
          (data.action === 'melee' ? '拳擊命中' : '命中玩家') + (Number.isInteger(data.damage) ? ' · 傷害 ' + data.damage : '')]) : null;
    // 未命中仍由连接模块记录判定，但不让原生通知盖满整个战局。
    if (!lines) return;
    gameMessage = lines[0]; renderHud();
    const key = data.accepted === false ? 'reject:' + (data.reason || '') : data.health === 0 ? 'kill' : (data.action || 'shot') + ':hit';
    const now = performance.now();
    if (key !== lastCombatNotice || now - lastCombatNoticeAt >= 1500) {
      lastCombatNotice = key; lastCombatNoticeAt = now; notify(lines[1]);
    }
  }
  function meleeFeedback(data) {
    // 仅采用连接模块校验、服务端确认的命中事件；本地挥拳或动作播放不产生提示/伤害。
    if (data.accepted !== true || data.hit !== true || !Number.isInteger(data.damage) || data.damage <= 0
      || data.damage > 20 || !Number.isInteger(data.health) || data.health < 0 || data.health > 200) return;
    if (data.attacker_id === session.client_id) {
      combatFeedback({ ...data, action: 'melee' });
    } else if (world.entities.some((entity) => entity.entity_id === data.target_entity_id
      && entity.player_id === session.client_id && entity.generation === data.target_generation)) {
      gameMessage = '受到拳击 · 生命 ' + data.health + '/200'; renderHud();
      // 生命值以每次命中的服务器结果显示，避免挥拳动作存在而扣血结果不可见。
      notify(data.health === 0 ? '拳擊致死，等待伺服器重生' : '受到拳擊 · 傷害 ' + data.damage + ' · 生命 ' + data.health + '/200');
    }
  }
  function renderHud() {
    const hud = document.getElementById('hud');
    if (hud) {
      hud.style.display = nativeHud ? 'none' : '';
      hud.textContent = nativeHud ? '' : [networkMessage, gameMessage].filter(Boolean).join(' · ');
    }
  }
  function notify(text) {
    notices.push({ id: ++nextNoticeId, text });
    if (notices.length > 16) notices.shift();
    schedule();
  }

  function reportStatus(value) {
    const text = JSON.stringify(value);
    if (text === lastReport) return;
    lastReport = text;
    // 保存状态变化和错误，便于实际客户端复测；不输出调试面板或上传位置。
    try { fetch('/log', { method: 'POST', body: '[public-client] ' + text }).catch(() => {}); } catch { /* 日志失败不影响同步 */ }
  }

  const crashes = new BroadcastChannel('game-crash');
  crashes.onmessage = ({ data }) => {
    if (!data || !data.text) return;
    reportStatus({ phase: 'engine_crash', thread: data.thread, text: data.text, tail: data.tail || [] });
  };

  function publish() {
    timer = 0;
    if (!shared || closed) return;
    const packet = { ...session, peers: [...peers.values()], shots, combat, controls, notices, world, world_events: worldEvents };
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
    if (data.type === 'network_status') {
      networkMessage = data.connected ? '服务器在线 · ' + (data.members || 1) + ' 位玩家'
        : (data.text || '服务器连接中断，正在自动重连…');
      const key = data.connected ? 'online:' + (data.members || 1) : 'offline';
      if (key !== lastNetworkNotice) {
        lastNetworkNotice = key;
        notify(data.connected ? '公共戰局已連線 · ' + (data.members || 1) + ' 位玩家' : '連線中斷，正在自動重新連線…');
      } else if (data.phase === 'notice' && !/武器/.test(data.text || '')) notify('伺服器暫未接受這次操作');
      renderHud();
      return;
    } else if (data.type === 'combat_feedback') {
      combatFeedback(data);
      return;
    } else if (data.type === 'world_state_v2') {
      if (world?.world_epoch && world.world_epoch !== data.world_epoch) { worldEvents = []; seenWorldEvents.clear(); }
      world = { schema_version: 2, world_epoch: data.world_epoch, world_revision: data.world_revision,
        world_tick: data.world_tick, stream_seq: data.stream_seq, ready: data.ready === true,
        entities: Array.isArray(data.entities) ? data.entities : [], tombstones: Array.isArray(data.tombstones) ? data.tombstones : [] };
    } else if (data.type === 'melee_event') {
      if (!world || data.world_epoch !== world.world_epoch || !data.event_id || seenWorldEvents.has(data.event_id)) return;
      seenWorldEvents.add(data.event_id);
      if (seenWorldEvents.size > 256) seenWorldEvents.delete(seenWorldEvents.values().next().value);
      worldEvents.push({ id: ++nextWorldEventId, event: data });
      meleeFeedback(data);
    } else if (data.type === 'interaction_result') {
      if (data.accepted === false) notify('互動尚未完成，請稍後重試');
      return;
    } else if (data.type === 'session') {
      const previousId = session.client_id;
      session = { connected: data.connected === true, client_id: data.client_id || null,
        members: Array.isArray(data.members) ? data.members : [],
        avatar: data.avatar === 'female' ? 'female' : 'male',
        preset: data.preset || (data.avatar === 'female' ? 'freemode_female' : 'freemode_male'),
        seed: Number.isInteger(data.seed) ? data.seed >>> 0 : 0,
        model: Number.isInteger(data.model) ? data.model >>> 0 : undefined,
        appearance_spec: data.appearance_spec || {},
        weapon_rules: Array.isArray(data.weapon_rules) ? data.weapon_rules : [],
        world_v2: data.world_v2 === true,
        resumed: data.resumed === true,
        resume_state_ready: data.resume_state_ready === true,
        resume_state: data.resume_state || null,
        resume_position: data.resume_position || null, spawn: data.spawn || null };
      if (session.client_id && previousId && session.client_id !== previousId) { peers.clear(); combatById.clear(); }
      if (session.connected && (data.world_v2 === false || data.melee_events === false) && !oldServerNotice) {
        oldServerNotice = true;
        notify('伺服器不支援近戰，請更新服務端或重新連線');
      }
      const members = new Set(session.members.map((member) => member.id));
      for (const id of peers.keys()) if (!members.has(id)) peers.delete(id);
      for (const id of combatById.keys()) if (!members.has(id)) combatById.delete(id);
      for (const peer of data.peers || []) mergePeer(peer);
      if (!session.connected) { shots = []; controls = []; world = null; worldEvents = []; seenWorldEvents.clear(); }
      for (const value of data.combat || []) mergeCombat(value);
      combat = [...combatById.values()];
    } else if (data.type === 'combat_state' && Array.isArray(data.players)) {
      for (const value of data.players) mergeCombat(value);
    } else if (['damage', 'death', 'respawn', 'correction'].includes(data.type)) {
      if (!mergeControlCombat(data)) return;
      controls.push({ id: ++nextControlId, event: data });
      if (controls.length > 32) controls.shift();
      if (data.type === 'respawn' && data.player_id === session.client_id) notify('已重生，正在恢復角色');
      if (data.type === 'death' && data.player_id === session.client_id) {
        lastGamePhase = 'dead'; notify('已陣亡，等待伺服器重生');
      }
    } else if (data.type === 'player_state' && data.player_id !== session.client_id && data.state) {
      mergePeer({ player_id: data.player_id, state: data.state });
    } else if (data.type === 'shot_event' && data.player_id !== session.client_id && data.event) {
      shots.push({ id: ++nextShotId, player_id: data.player_id, event: data.event });
      if (shots.length > 32) shots.shift();
    } else return;
    schedule();
  };
  if (network) network.setReceiver(receive);
  else channel.onmessage = ({ data }) => receive(data);

  function onWorkerMessage(data) {
    const message = data?.multiplayer;
    if (!message) return;
    if (message.type === 'memory') {
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
    } else if (message.type === 'notice_ack' && Array.isArray(message.ids)) {
      const consumed = new Set(message.ids);
      notices = notices.filter((notice) => !consumed.has(notice.id));
      schedule();
    } else if (message.type === 'native_hud') {
      nativeHud = message.available === true;
      renderHud();
    } else if (['local_state', 'local_shot', 'entity_ready', 'entity_input', 'interaction_request', 'simulation_result'].includes(message.type)) {
      sendLocal(message);
    } else if (message.type === 'game_status') {
      gameMessage = message.role_recovering ? '正在自动恢复在线角色…'
        : message.role_loading ? '正在加载在线角色…'
        : message.alive === false ? '已阵亡 · 等待服务器重生'
        : '已显示 ' + message.peer_count + ' 位其他玩家' + (Number.isInteger(message.health)
          ? ' · 生命值 ' + message.health + ' · 击杀 ' + (message.kills || 0) + ' / 阵亡 ' + (message.deaths || 0) : '');
      renderHud();
      const phase = message.role_recovering ? 'recovering_avatar' : message.role_loading ? 'loading_avatar'
        : message.alive === false ? 'dead' : 'synchronizing';
      if (phase !== lastGamePhase) {
        const previous = lastGamePhase; lastGamePhase = phase;
        notify(phase === 'recovering_avatar' ? '正在自動恢復線上角色…'
          : phase === 'loading_avatar' ? '正在載入線上角色…'
          : phase === 'dead' ? '已陣亡，等待伺服器重生'
          : previous === 'recovering_avatar' ? '角色已恢復，同步繼續' : '公共戰局已就緒');
      }
      if (Number.isInteger(message.kills)) {
        if (lastKills !== null && message.kills > lastKills) notify('擊殺成功 · 總擊殺 ' + message.kills);
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
    } else if (message.type === 'world_entity_status') {
      reportStatus({ phase: 'world_entity', entity_id: message.entity_id,
        kind: message.kind, state: message.phase });
    } else if (message.type === 'melee_sample') {
      reportStatus({ phase: 'melee_sample', request_id: message.request_id,
        actor_entity_id: message.actor_entity_id, source: message.source });
    } else if (message.type === 'bridge_error') {
      nativeHud = false;
      const hud = document.getElementById('hud');
      if (hud) { hud.style.display = ''; hud.textContent = '角色同步已暂停：' + message.message; hud.style.color = '#f96'; }
      reportStatus({ phase: 'error', message: message.message });
    }
  }

  sendLocal({ type: 'bridge_ready' });
  addEventListener('pagehide', () => {
    closed = true;
    clearTimeout(timer);
    sendLocal({ type: 'game_closed' });
    channel?.close();
    crashes.close();
  }, { once: true });
  return { onWorkerMessage };
}
