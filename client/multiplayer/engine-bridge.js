'use strict';
// 此桥在 scrThread::Run 安装有效脚本上下文后执行。网络消息通过共享内存快照输入。
// 原始引擎保留；只有公共战局 /play/ 选用另一个带导出和线程回调的 WASM 副本。
self.prepareMultiplayerBridge = function (imports) {
  const MAGIC = 0x4d505442;
  const original = imports.env.wasm_module_int_js;
  let tick = null;
  imports.env.wasm_module_int_js = (pointer, value) => {
    if (value === MAGIC) { if (tick) tick(Number(pointer)); return 0; }
    return original(pointer, value);
  };
  return function bind(instance) {
    const ex = instance.exports;
    const memory = imports.env.memory;
    const CAPACITY = 128 * 1024;
    // 公共战局测试区：所有玩家使用同一中心点，按顺序错开两米防止重叠。
    const TEST_SPAWN = [711.5, -1088.1, 22.4];
    function joaat(name) {
      let hash = 0;
      for (const character of name) { hash = (hash + character.charCodeAt(0)) >>> 0; hash = (hash + (hash << 10)) >>> 0; hash ^= hash >>> 6; }
      hash = (hash + (hash << 3)) >>> 0; hash ^= hash >>> 11;
      return (hash + (hash << 15)) >>> 0;
    }
    const ONLINE_MODELS = new Set(['mp_m_freemode_01', 'mp_f_freemode_01', 'a_m_y_business_01',
      'a_m_y_beach_01', 'a_m_y_hipster_01', 'a_f_y_business_01', 'a_f_y_beach_01', 'a_f_y_hipster_01'].map(joaat));
    const OWNER_WARMUP_MS = 1200;
    const replicas = new Map();
    const contexts = new Map();
    const retryAfter = new Map();
    const requested = new Map();
    const consumedShots = new Set();
    const consumedControls = new Set();
    const consumedNotices = new Set();
    const authorityStates = new Map();
    const weaponRequests = new Map();
    // 零伤害转播仍会触发原生武器物理，只允许普通枪，拒绝爆炸类武器。
    const VISUAL_WEAPONS = new Set(['weapon_pistol', 'weapon_combatpistol', 'weapon_appistol',
      'weapon_pistol50', 'weapon_microsmg', 'weapon_smg', 'weapon_assaultsmg', 'weapon_assaultrifle',
      'weapon_carbinerifle', 'weapon_advancedrifle', 'weapon_mg', 'weapon_combatmg', 'weapon_pumpshotgun',
      'weapon_sawnoffshotgun', 'weapon_assaultshotgun', 'weapon_bullpupshotgun', 'weapon_sniperrifle',
      'weapon_heavysniper', 'weapon_marksmanrifle', 'weapon_minigun'].map(joaat));
    const decoder = new TextDecoder();
    let scratch = 0, block = 0, sequence = -1, packet = null, lastTick = 0, nameBuffer = 0;
    let lastShot = 0, lastState = 0, initialPlacement = false, stopped = false;
    let smoothingTime = 0, lastStatus = 0;
    let owner = null, avatarTarget = 0, avatarInitialized = false, avatarChangeRequested = false;
    let sessionId = null, avatarChanges = 0, replicaCreates = 0, replicaRemovals = 0;
    let lastLifecycleReport = '';
    let localAppearance = null, appearancePed = 0;
    let lifeOverride = null, lastAuthorityAlive = null, lastRespawnRevision = -1;
    let deathRestartPaused = false, lastRecoveryAt = -Infinity, lastRecoveryFadeAt = -Infinity;
    let avatarRequestedAt = 0, avatarAttempts = 0, avatarChangedAt = 0;
    let modelMismatch = null, modelRestore = null, lastGoodLocal = null;
    let modelDefaultsPending = false;
    let noticeBuffer = 0, lastNoticeAttempt = -Infinity, nativeHudAvailable = null;
    let shotBuffer = 0, shotSampleAt = -Infinity, weaponSample = null, pendingShots = [];
    let worldReadinessAt = -Infinity, worldReadinessSignature = '';

    const post = (value) => self.postMessage({ multiplayer: value });
    const validPosition = (position) => Array.isArray(position) && position.length === 3 &&
      position.every((value) => Number.isFinite(value) && Math.abs(value) <= 16000);
    // GTA 人形角色保留约 100 点内部生命基线；战局血量为 0～200。
    // 存活状态保持在基线之上，只有服务端宣布死亡时写入 native 0。
    const nativeCombatHealth = (health) => health > 0 ? 100 + Math.max(1, Math.round(health / 2)) : 0;
    function view() { return new DataView(memory.buffer); }
    function vector(offset, position) {
      const data = view();
      for (let i = 0; i < 3; i++) data.setFloat32(scratch + offset + 8 * i, position[i], true);
      return BigInt(scratch + offset);
    }
    function readVector(offset) {
      const data = view();
      return [0, 8, 16].map((part) => data.getFloat32(scratch + offset + part, true));
    }
    function observeWorldReadiness(now) {
      if (now - worldReadinessAt < 5000 || !ex.mpPedSyncTree || !ex.mpPlayerSyncTree || !ex.mpNetworkScriptHandler) return;
      worldReadinessAt = now;
      try {
        const inMemory = (pointer) => pointer > 0n && pointer < BigInt(memory.buffer.byteLength);
        const report = { type: 'world_readiness',
          ped_tree_initialized: inMemory(ex.mpPedSyncTree(0n)),
          player_tree_initialized: inMemory(ex.mpPlayerSyncTree(0n)),
          network_script_context: Boolean(ex.mpNetworkScriptHandler()),
          // 此观测不创建网络对象，不发送原网络包，也不能证明同步树已可应用。
          mode: 'read_only' };
        const signature = JSON.stringify(report);
        if (signature !== worldReadinessSignature) { worldReadinessSignature = signature; post(report); }
      } catch { /* 整体引擎审计的观测失败不能中断现有角色同步。 */ }
    }
    function mergeAuthority(value) {
      if (!value || typeof value.id !== 'string') return;
      const revision = Number.isSafeInteger(value.revision) ? value.revision : 0;
      const previous = authorityStates.get(value.id);
      if (previous && (previous.revision ?? 0) > revision) return;
      authorityStates.set(value.id, { ...previous, ...value, revision });
    }
    function authorityControl(event) {
      if (!event || !['damage', 'death', 'respawn'].includes(event.type)) return;
      const id = event.type === 'damage' ? event.victim_id : event.player_id;
      if (typeof id !== 'string') return;
      const update = { id, revision: Number.isSafeInteger(event.revision) ? event.revision : 0 };
      if (event.type === 'death') Object.assign(update, { health: 0, alive: false });
      else if (Number.isInteger(event.health)) Object.assign(update, { health: event.health, alive: event.health > 0 });
      if (event.type === 'respawn' && validPosition(event.position)) update.spawn = [...event.position];
      mergeAuthority(update);
    }
    function actualWeapon(ped) {
      if (ex.mpGetCurrentPedWeapon) {
        const ready = ex.mpGetCurrentPedWeapon(ped, BigInt(scratch + 112), 1);
        if (ready) return { hash: view().getUint32(scratch + 112, true), ready: true };
        return { hash: ex.mpSelectedWeapon(ped) >>> 0, ready: false };
      }
      return { hash: ex.mpSelectedWeapon(ped) >>> 0, ready: true };
    }
    function cameraRay() {
      ex.mpCamCoords(BigInt(scratch + 24)); ex.mpCamRot(BigInt(scratch + 48), 2);
      const origin = readVector(24), rotation = readVector(48);
      const pitch = rotation[0] * Math.PI / 180, yaw = rotation[2] * Math.PI / 180;
      const direction = [-Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
      return { origin, target: origin.map((value, index) => value + 100 * direction[index]) };
    }
    function actionsFor(ped) {
      return { aiming: Boolean(ex.mpIsAiming?.(ex.mpPlayerId())), reloading: Boolean(ex.mpIsReloading?.(ped)),
        jumping: Boolean(ex.mpIsJumping?.(ped)), ducking: Boolean(ex.mpIsDucking?.(ped)),
        sprinting: Boolean(ex.mpIsSprinting?.(ped)) };
    }
    function shotInterval(weapon) {
      const rule = (packet?.weapon_rules || []).find((entry) => entry.weapon === weapon);
      return Number.isInteger(rule?.cooldown_ms) && rule.cooldown_ms >= 1 && rule.cooldown_ms <= 2000
        ? Math.max(50, rule.cooldown_ms + 15) : 50;
    }
    // 每个有效 owner 回调只读取本地武器脉冲；较重的实体更新仍每 40ms 执行。
    function sampleShots(now) {
      if (now - shotSampleAt < 5 || !packet?.connected || !initialPlacement || modelRestore) return;
      shotSampleAt = now;
      const authority = authorityStates.get(packet.client_id);
      const ped = ex.mpGetPlayerPed(-1);
      if (!ped || authority?.alive === false || (ex.mpGetModel(ped) >>> 0) !== avatarTarget) {
        weaponSample = null; pendingShots = []; return;
      }
      const { hash: weapon, ready } = actualWeapon(ped);
      const shooting = Boolean(ex.mpIsShooting(ped));
      const reloading = Boolean(ex.mpIsReloading?.(ped));
      if (!weapon || !ready || reloading) { weaponSample = null; return; }
      let clip = null;
      if (ex.mpGetAmmoInClip && ex.mpGetAmmoInClip(ped, weapon | 0, BigInt(scratch + 116))) clip = view().getInt32(scratch + 116, true);
      const same = weaponSample?.ped === ped && weaponSample.weapon === weapon;
      const decreased = same && clip !== null && weaponSample.clip !== null && clip < weaponSample.clip;
      const rising = shooting && (!same || !weaponSample.shooting);
      const priorFiredAt = same ? weaponSample.firedAt : -Infinity;
      let pendingDecrease = same ? weaponSample.pendingDecrease : null;
      if (pendingDecrease && now - pendingDecrease.at > 300) pendingDecrease = null;
      // 射击位可能比扣弹提前；记住尚未扣弹的已发送脉冲，匹配后续计数而非再算一发。
      const delayedDecrease = decreased && pendingDecrease && clip === pendingDecrease.clip - 1;
      if (delayedDecrease) pendingDecrease = null;
      // 持续无限弹时用慢速脉冲兜底，仍由服务器武器射速校验。
      const interval = shotInterval(weapon);
      const fallback = shooting && !decreased && now - priorFiredAt >= Math.max(150, interval);
      const firedAt = same ? weaponSample.firedAt : -Infinity;
      weaponSample = { ped, weapon, shooting, clip, firedAt, pendingDecrease };
      if ((!decreased || delayedDecrease) && !rising && !fallback) return;
      if (now - firedAt < interval) return;
      weaponSample.firedAt = now;
      if (!decreased && clip !== null) weaponSample.pendingDecrease = { clip, at: now };
      const ray = cameraRay();
      if (ex.mpLastWeaponImpact) {
        if (!shotBuffer) shotBuffer = Number(ex.mpAlloc(16n));
        if (shotBuffer && ex.mpLastWeaponImpact(ped, BigInt(shotBuffer))) {
          // 此 native 使用紧凑 rage::Vector3，而不是 0/8/16 的 scrVector。
          const impact = [0, 4, 8].map((offset) => view().getFloat32(shotBuffer + offset, true));
          const range = Math.hypot(...impact.map((value, index) => value - ray.origin[index]));
          if (validPosition(impact) && range > .001 && range <= 300) ray.target = impact;
        }
      }
      if (!validPosition(ray.origin) || !validPosition(ray.target)) return;
      pendingShots.push({ at: now, ped, event: { ...ray, weapon } });
      if (pendingShots.length > 4) pendingShots.shift();
    }
    function requestModel(hash, now) {
      if (now - (requested.get(hash) ?? -Infinity) >= 1000) {
        ex.mpRequestModel(hash);
        requested.set(hash, now);
      }
    }
    function contextName(thread) {
      const start = thread + 428;
      if (!Number.isSafeInteger(start) || start < 0 || start + 32 > memory.buffer.byteLength) return '';
      const bytes = new Uint8Array(memory.buffer, start, 32);
      const end = bytes.indexOf(0);
      // 浏览器 TextDecoder 不接受 SharedArrayBuffer 视图，先复制到普通缓冲区。
      return decoder.decode(bytes.slice(0, end < 0 ? 32 : end)).replace(/[^\w.-]/g, '').slice(0, 32);
    }
    function useOwner(thread, handler, now) {
      if (owner) {
        if (owner.thread === thread && owner.handler === handler) { owner.seen = now; return true; }
        // 不在一帧里轮流把模型和实体注册给不同脚本；原 owner 结束后重新观察。
        if (now - owner.seen < 5000) return false;
        owner = null; contexts.clear();
      }
      const key = thread + ':' + handler;
      let candidate = contexts.get(key);
      if (!candidate || now - candidate.seen > 500) {
        candidate = { thread, handler, first: now, seen: now, samples: 0, name: contextName(thread) };
        contexts.set(key, candidate);
      }
      candidate.seen = now; candidate.samples++;
      for (const [id, value] of contexts) if (now - value.seen > 500) contexts.delete(id);
      if (now - candidate.first < OWNER_WARMUP_MS || candidate.samples < 3) return false;
      owner = candidate;
      contexts.clear();
      return true;
    }
    function lifecycle(reason) {
      const metrics = { type: 'lifecycle', avatar_changes: avatarChanges, replica_creates: replicaCreates,
        replica_removals: replicaRemovals, owner_script: owner?.name || '',
        respawn_revision: lastRespawnRevision, expected_model: avatarTarget,
        actual_model: ex.mpGetPlayerPed(-1) ? ex.mpGetModel(ex.mpGetPlayerPed(-1)) >>> 0 : 0,
        local_ped: ex.mpGetPlayerPed(-1), reason };
      const text = JSON.stringify(metrics);
      if (text !== lastLifecycleReport) { lastLifecycleReport = text; post(metrics); }
    }
    function validAppearance(value) {
      const integer = (number, min, max) => Number.isInteger(number) && number >= min && number <= max;
      return value && Array.isArray(value.components) && value.components.length === 12 &&
        value.components.every((part) => Array.isArray(part) && part.length === 3 &&
          integer(part[0], 0, 1024) && integer(part[1], 0, 255) && integer(part[2], 0, 3)) &&
        Array.isArray(value.props) && value.props.length === 8 && value.props.every((part) =>
          Array.isArray(part) && part.length === 2 && integer(part[0], -1, 1024) && integer(part[1], -1, 255)) &&
        (!value.overlays || (Array.isArray(value.overlays) && value.overlays.length === 13 &&
          value.overlays.every((part) => Array.isArray(part) && part.length === 5 && integer(part[0], 0, 255) &&
            Number.isFinite(part[1]) && part[1] >= 0 && part[1] <= 1 && integer(part[2], 0, 2) &&
            integer(part[3], 0, 63) && integer(part[4], 0, 63)))) &&
        (!value.hair || (Array.isArray(value.hair) && value.hair.length === 2 && value.hair.every((color) => integer(color, 0, 63))));
    }
    function applyMakeup(ped, appearance, model) {
      if (model !== 0x705e61f2 && model !== 0x9c9effd8) return {};
      const result = {};
      if (Array.isArray(appearance.overlays) && appearance.overlays.length === 13 && ex.mpSetHeadOverlay) {
        result.overlays = appearance.overlays.map((entry, index) => {
          const part = [...entry];
          if (part[0] !== 255 && ex.mpHeadOverlayCount) {
            const count = ex.mpHeadOverlayCount(index);
            part[0] = count > 0 ? part[0] % count : 255;
          }
          ex.mpSetHeadOverlay(ped, index, part[0], part[1]);
          if (ex.mpSetOverlayTint) ex.mpSetOverlayTint(ped, index, part[2], part[3], part[4]);
          return part;
        });
      }
      if (Array.isArray(appearance.hair) && appearance.hair.length === 2 && ex.mpSetHairTint) {
        result.hair = [...appearance.hair]; ex.mpSetHairTint(ped, ...result.hair);
      }
      return result;
    }
    function randomizeAndCapture(ped, model, specification) {
      if (!ex.mpGetDrawable || !ex.mpGetPropIndex) return null;
      if (ex.mpRandomComponents) ex.mpRandomComponents(ped, 0);
      if (ex.mpRandomProps) ex.mpRandomProps(ped);
      const appearance = {
        components: Array.from({ length: 12 }, (_, index) => [Math.max(0, ex.mpGetDrawable(ped, index)),
          Math.max(0, ex.mpGetTexture(ped, index)), Math.max(0, Math.min(3, ex.mpGetPalette(ped, index)))]),
        props: Array.from({ length: 8 }, (_, index) => {
          const drawable = ex.mpGetPropIndex(ped, index);
          return drawable < 0 ? [-1, -1] : [drawable, Math.max(0, ex.mpGetPropTextureIndex(ped, index))];
        }), ...applyMakeup(ped, specification || {}, model),
      };
      return validAppearance(appearance) ? appearance : null;
    }
    function applyAppearance(ped, appearance, model) {
      if (!validAppearance(appearance) || !ex.mpSetComponent) return false;
      appearance.components.forEach((part, index) => {
        if (ex.mpDrawableCount && part[0] >= ex.mpDrawableCount(ped, index)) return;
        if (ex.mpTextureCount && part[1] >= ex.mpTextureCount(ped, index, part[0])) return;
        ex.mpSetComponent(ped, index, ...part);
      });
      appearance.props.forEach((part, index) => {
        if (part[0] < 0) ex.mpClearProp(ped, index);
        else ex.mpSetProp(ped, index, part[0], part[1], 1);
      });
      applyMakeup(ped, appearance, model);
      return true;
    }
    function recoverLocal(position, heading, health, revision, now) {
      // 这个 native 内部读取 FindPlayerPed；没有有效角色时保留事件，不能调用空角色。
      let ped = ex.mpGetPlayerPed(-1);
      if (!ped || !validPosition(position)) return null;
      if (ex.mpResurrectLocalPlayer) {
        ex.mpResurrectLocalPlayer(vector(0, position), heading, 0, 0, 0, 0, 0);
      } else if (ex.mpResurrect) ex.mpResurrect(ped);
      ped = ex.mpGetPlayerPed(-1);
      if (!ped) return null;
      if (ex.mpRevive) ex.mpRevive(ped);
      if (ex.mpClearTasksImmediately) ex.mpClearTasksImmediately(ped);
      ex.mpSetInvincible(ped, 1);
      ex.mpSetHealth(ped, nativeCombatHealth(health), 0);
      ex.mpSetCoordsNoOffset(ped, vector(0, position), 1, 1, 1);
      ex.mpSetHeading(ped, heading);
      // PED 复活不足以退出本地医院重启状态；恢复游戏状态、控制和镜头淡入。
      if (ex.mpForcePlaying) ex.mpForcePlaying();
      if (ex.mpSetPlayerControl) ex.mpSetPlayerControl(ex.mpPlayerId(), 1, 0);
      if (ex.mpScreenFadeIn) ex.mpScreenFadeIn(250);
      if (ex.mpIsDead(ped, 0) || ex.mpGetHealth(ped) <= 100) return null;
      lifeOverride = { ...authorityStates.get(packet.client_id), id: packet.client_id, health, alive: true, revision, spawn: [...position] };
      lastRespawnRevision = Math.max(lastRespawnRevision, revision);
      lastAuthorityAlive = true;
      lastGoodLocal = { ...(lastGoodLocal || {}), position: [...position], heading };
      modelMismatch = null; modelRestore = null;
      // 加载期间缓存的重生位置优先于刷新时较早的世界快照。
      initialPlacement = true;
      avatarInitialized = false; avatarChangeRequested = false;
      avatarRequestedAt = 0; avatarAttempts = 0;
      lastRecoveryAt = lastRecoveryFadeAt = now;
      lifecycle('local_respawn');
      return ped;
    }
    function readPacket() {
      const header = new Int32Array(memory.buffer, block, 4);
      const before = Atomics.load(header, 0);
      if ((before & 1) || before === sequence) return;
      const length = Atomics.load(header, 1);
      if (length < 0 || length > CAPACITY) return;
      const bytes = new Uint8Array(memory.buffer, block + 16, length).slice();
      if (before !== Atomics.load(header, 0)) return;
      sequence = before;
      if (!length) return;
      try { packet = JSON.parse(decoder.decode(bytes)); } catch { return; }
    }
    function processNotices(now) {
      if (!ex.mpBeginTheFeedPost || !ex.mpAddTextPlayerSubstring || !ex.mpEndTheFeedPostTicker) {
        if (nativeHudAvailable !== false) { nativeHudAvailable = false; post({ type: 'native_hud', available: false }); }
        return;
      }
      const acknowledged = (packet?.notices || []).filter((notice) => consumedNotices.has(notice.id)).map((notice) => notice.id);
      const notice = (packet?.notices || []).find((entry) => Number.isSafeInteger(entry.id) && typeof entry.text === 'string' && !consumedNotices.has(entry.id));
      if (notice && now - lastNoticeAttempt >= 1000 && ex.mpGetPlayerPed(-1)) {
        lastNoticeAttempt = now;
        try {
          if (!noticeBuffer) noticeBuffer = Number(ex.mpAlloc(520n));
          if (!noticeBuffer) return;
          const bytes = new Uint8Array(memory.buffer, noticeBuffer, 520);
          bytes.fill(0); bytes.set([83, 84, 82, 73, 78, 71]); // STRING\0
          // 按字符限制 UTF-8，去除游戏文本格式指令；同一 tick 完成三步，独立于坐标缓冲。
          const encoder = new TextEncoder();
          let offset = 8;
          for (const character of notice.text.replace(/[~\u0000-\u001f]/g, '').slice(0, 240)) {
            const encoded = encoder.encode(character);
            if (offset + encoded.length >= 520) break;
            bytes.set(encoded, offset); offset += encoded.length;
          }
          ex.mpBeginTheFeedPost(BigInt(noticeBuffer));
          ex.mpAddTextPlayerSubstring(BigInt(noticeBuffer + 8));
          const handle = ex.mpEndTheFeedPostTicker(0, 1);
          if (handle >= 0) {
            consumedNotices.add(notice.id); acknowledged.push(notice.id);
            if (consumedNotices.size > 128) consumedNotices.delete(consumedNotices.values().next().value);
            if (nativeHudAvailable !== true) { nativeHudAvailable = true; post({ type: 'native_hud', available: true }); }
          } else if (nativeHudAvailable !== false) {
            nativeHudAvailable = false; post({ type: 'native_hud', available: false });
          }
        } catch {
          // 通知尚未就绪不能停止角色同步；保留消息限频重试并允许页面显示。
          if (nativeHudAvailable !== false) { nativeHudAvailable = false; post({ type: 'native_hud', available: false }); }
        }
      }
      if (acknowledged.length) post({ type: 'notice_ack', ids: acknowledged });
    }
    function roleWaiting(now, recovering = false) {
      if (now - lastStatus < 1000) return;
      lastStatus = now;
      post({ type: 'game_status', connected: true, role_loading: !recovering,
        role_recovering: recovering, peer_count: replicas.size });
    }
    function erase(replica, reason = 'leave') {
      if (replica?.blip && ex.mpRemoveBlip) {
        view().setInt32(scratch + 124, replica.blip, true);
        ex.mpRemoveBlip(BigInt(scratch + 124));
      }
      if (replica && ex.mpExists(replica.ped)) {
        view().setInt32(scratch + 120, replica.ped, true);
        ex.mpDeletePed(BigInt(scratch + 120));
      }
      if (replica) { replicaRemovals++; lifecycle(reason); }
    }
    function updateReplica(id, state, now, delta) {
      if (!validPosition(state?.position) || !Number.isInteger(state.model) || !Number.isFinite(state.heading)) return;
      let replica = replicas.get(id);
      if (!ONLINE_MODELS.has(state.model)) return; // 单机恢复主角的瞬态数据不能重建在线替身。
      if (replica && !ex.mpExists(replica.ped)) {
        replica.missingSince ??= now;
        if (now - replica.missingSince < 300) return;
        erase(replica, 'entity_missing'); replicas.delete(id);
        retryAfter.set(id, now + 1000);
        return;
      }
      if (replica) replica.missingSince = null;
      if (replica && replica.model !== state.model) {
        if (replica.pendingModel !== state.model) {
          replica.pendingModel = state.model; replica.modelSince = now;
        }
        if (now - replica.modelSince < 600) return;
        erase(replica, 'stable_model_change'); replicas.delete(id); replica = null;
      } else if (replica) {
        replica.pendingModel = null;
      }
      const hash = state.model | 0;
      if (!replica) {
        if (now < (retryAfter.get(id) || 0)) return;
        if (!ex.mpHasModel(hash)) {
          requestModel(hash, now);
          return;
        }
        const ped = ex.mpCreatePed(4, hash, vector(72, state.position), state.heading, 0, 0);
        if (!ped) return;
        ex.mpBlockEvents(ped, 1);
        ex.mpSetInvincible(ped, 1);
        if (ex.mpDefaultVariation) ex.mpDefaultVariation(ped);
        ex.mpFreeze(ped, 1);
        ex.mpSetCoordsNoOffset(ped, vector(72, state.position), 1, 1, 1);
        let blip = 0;
        if (ex.mpAddBlipForEntity) {
          blip = ex.mpAddBlipForEntity(ped);
          if (blip) {
            ex.mpSetBlipColour(blip, 3);
            ex.mpSetBlipSprite(blip, 1);
            ex.mpSetBlipScale(blip, .85);
            ex.mpSetBlipAsShortRange(blip, 0);
            const name = packet.members?.find((member) => member.id === id)?.name;
            if (name && ex.mpBeginSetBlipName && ex.mpAddTextPlayerSubstring && ex.mpEndSetBlipName) {
              if (!nameBuffer) nameBuffer = Number(ex.mpAlloc(256n));
              if (nameBuffer) {
                const buffer = new Uint8Array(memory.buffer, nameBuffer, 256);
                buffer.fill(0);
                buffer.set(new TextEncoder().encode('STRING'), 0);
                buffer.set(new TextEncoder().encode(String(name).slice(0, 24)), 32);
                ex.mpBeginSetBlipName(BigInt(nameBuffer));
                ex.mpAddTextPlayerSubstring(BigInt(nameBuffer + 32));
                ex.mpEndSetBlipName(blip);
              }
            }
          }
        }
        replica = { ped, model: state.model, position: [...state.position], heading: state.heading,
          health: null, weapon: 0, seen: now, blip, missingSince: null, pendingModel: null,
          moving: false, behaviorAt: 0, target: [...state.position] };
        replicas.set(id, replica);
        replicaCreates++; lifecycle('create');
      }
      replica.seen = now;
      if (state.appearance) {
        const signature = JSON.stringify(state.appearance);
        if (replica.appearance !== signature && applyAppearance(replica.ped, state.appearance, state.model)) replica.appearance = signature;
      }
      const dead = state.alive === false || state.health <= 0;
      if (dead) {
        if (!replica.dead || !ex.mpIsDead(replica.ped, 0) || ex.mpGetHealth(replica.ped) !== 0) {
          ex.mpFreeze(replica.ped, 0);
          ex.mpSetInvincible(replica.ped, 0);
          if (ex.mpSetCanRagdoll) ex.mpSetCanRagdoll(replica.ped, 1);
          ex.mpSetHealth(replica.ped, 0, 0);
          replica.dead = true; replica.health = 0;
          replica.ragdollProtected = false;
          lifecycle('replica_authority_dead');
        }
        return;
      }
      // 单机任务可能让替身独立死亡；逻辑缓存存活时也必须检查实体本身。
      if (replica.dead || ex.mpIsDead(replica.ped, 0) || ex.mpGetHealth(replica.ped) <= 100) {
        if (now - (replica.recoveryAt ?? -Infinity) < 500) return;
        replica.recoveryAt = now;
        post({ type: 'life_reconcile', player_id: id, server_health: state.health,
          server_alive: true, revision: state.revision, native_health: ex.mpGetHealth(replica.ped),
          native_dead: Boolean(ex.mpIsDead(replica.ped, 0)) });
        if (ex.mpResurrect) ex.mpResurrect(replica.ped);
        if (ex.mpRevive) ex.mpRevive(replica.ped);
        if (ex.mpClearTasksImmediately) ex.mpClearTasksImmediately(replica.ped);
        ex.mpSetInvincible(replica.ped, 1); ex.mpFreeze(replica.ped, 1);
        ex.mpSetHealth(replica.ped, state.server_authority ? nativeCombatHealth(state.health) : state.health, 0);
        if (ex.mpIsDead(replica.ped, 0)) { replica.recovering = true; return; }
        replica.dead = false; replica.recovering = false; replica.health = null; replica.position = [...state.position];
        replica.actions = null;
        replica.reloadActive = false;
        ex.mpSetCoordsNoOffset(replica.ped, vector(72, state.position), 1, 1, 1);
        lifecycle('replica_authority_restored');
      }
      // 无敌只阻止扣血，不会退出已经触发的 ragdoll；存活替身保持可见站姿。
      if (ex.mpSetCanRagdoll && (!replica.ragdollProtected || ex.mpIsRagdoll?.(replica.ped))) {
        ex.mpSetCanRagdoll(replica.ped, 0); replica.ragdollProtected = true;
      }
      ex.mpSetInvincible(replica.ped, 1);
      if (state.weapon) {
        const equipped = actualWeapon(replica.ped);
        // Give/Select 无成功返回，资源加载或其他任务收枪后需验证实际装备并限频重试。
        if ((!equipped.ready || equipped.hash !== state.weapon) && now - (replica.weaponAt ?? -Infinity) >= 500) {
          replica.weaponAt = now;
          if (state.weapon !== 0xa2719263 && ex.mpRequestWeaponAsset && ex.mpHasWeaponAsset && !ex.mpHasWeaponAsset(state.weapon | 0)) {
            if (now - (weaponRequests.get(state.weapon) ?? -Infinity) >= 1000) {
              ex.mpRequestWeaponAsset(state.weapon | 0, 31, 0); weaponRequests.set(state.weapon, now);
            }
          } else {
            ex.mpGiveWeapon(replica.ped, state.weapon | 0, 999, 0, 1);
            ex.mpSetCurrentWeapon(replica.ped, state.weapon | 0, 1);
          }
        }
        const confirmed = actualWeapon(replica.ped);
        replica.weapon = confirmed.ready ? confirmed.hash : 0;
      }
      const distance = Math.hypot(...state.position.map((value, i) => value - replica.position[i]));
      const newMovement = Math.hypot(...state.position.map((value, i) => value - replica.target[i]));
      const actions = state.actions || {};
      if (typeof actions.ducking === 'boolean' && actions.ducking !== replica.actions?.ducking && ex.mpSetDucking) ex.mpSetDucking(replica.ped, actions.ducking ? 1 : 0);
      if (actions.jumping && !replica.actions?.jumping && ex.mpTaskJump) ex.mpTaskJump(replica.ped, 0, 0, 0);
      const readyWeapon = replica.weapon === state.weapon;
      if (actions.reloading && readyWeapon && !replica.reloadActive && ex.mpTaskReloadWeapon) {
        ex.mpTaskReloadWeapon(replica.ped, 1); replica.reloadActive = true;
      } else if (!actions.reloading) replica.reloadActive = false;
      if (actions.aiming && readyWeapon && !actions.reloading && validPosition(state.aim_target) && ex.mpTaskAimGunAtCoord
          && now - (replica.aimAt ?? -Infinity) >= 250) {
        ex.mpTaskAimGunAtCoord(replica.ped, vector(72, state.aim_target), 500, 0, 0); replica.aimAt = now;
      } else if (!actions.aiming && replica.actions?.aiming && !state.shooting && !actions.reloading && ex.mpTaskStandStill) {
        ex.mpTaskStandStill(replica.ped, 500);
      }
      replica.actions = { ...actions };
      if (!state.shooting && !actions.aiming && !actions.reloading && !actions.jumping
          && ex.mpTaskGoStraight && now - replica.behaviorAt >= 250) {
        if (newMovement > .015 || distance > .15) {
          const speed = actions.sprinting ? 3 : Math.min(3, Math.max(1, newMovement / .05));
          ex.mpTaskGoStraight(replica.ped, vector(72, state.position), speed, 500, state.heading, .05);
          replica.moving = true; replica.behaviorAt = now;
        } else if (replica.moving && ex.mpTaskStandStill) {
          ex.mpTaskStandStill(replica.ped, 1000); replica.moving = false; replica.behaviorAt = now;
        }
        replica.target = [...state.position];
      }
      const amount = distance > 20 ? 1 : Math.min(1, delta / 100);
      replica.position = state.position.map((value, i) => replica.position[i] + (value - replica.position[i]) * amount);
      if (distance > .002) {
        // 常规移动保留任务和物理状态；只有大范围纠正才执行完整瞬移。
        ex.mpSetCoordsNoOffset(replica.ped, vector(72, replica.position), 1, 1, distance > 20 ? 1 : 0);
      }
      if (Math.abs(((state.heading - replica.heading + 540) % 360) - 180) > .1) {
        ex.mpSetHeading(replica.ped, state.heading); replica.heading = state.heading;
      }
      const nativeHealth = state.server_authority ? nativeCombatHealth(state.health) : state.health;
      if (ex.mpSetHealth && Number.isInteger(state.health) && ex.mpGetHealth(replica.ped) !== nativeHealth) {
        ex.mpSetHealth(replica.ped, nativeHealth, 0); replica.health = nativeHealth;
      }

    }
    // 远端实体和射击队列独立处理，本地角色切换期间仍继续显示其他玩家。
    function updateWorld(now) {
      const members = new Set((packet.members || []).filter((member) => member.connected !== false).map((member) => member.id));
      const peers = (packet.peers || []).filter((peer) => peer.player_id !== packet.client_id && members.has(peer.player_id) && validPosition(peer.state?.position));
      for (const [id, replica] of replicas) {
        if (!members.has(id)) { erase(replica); replicas.delete(id); }
      }
      const delta = smoothingTime ? Math.min(100, now - smoothingTime) : 40;
      smoothingTime = now;
      for (const peer of peers.slice(0, 32)) {
        const combat = authorityStates.get(peer.player_id);
        updateReplica(peer.player_id, combat ? { ...peer.state, health: combat.health, alive: combat.alive,
          revision: combat.revision, server_authority: true } : peer.state, now, delta);
      }
      for (const shot of packet.shots || []) {
        if (consumedShots.has(shot.id)) continue;
        consumedShots.add(shot.id);
        if (consumedShots.size > 128) consumedShots.delete(consumedShots.values().next().value);
        const replica = replicas.get(shot.player_id);
        if (replica && !replica.dead && validPosition(shot.event?.origin) && validPosition(shot.event?.target)) {
          const weapon = shot.event.weapon >>> 0;
          if (VISUAL_WEAPONS.has(weapon) && ex.mpShootBullet && ex.mpHasWeaponAsset) {
            if (!ex.mpHasWeaponAsset(weapon | 0)) {
              if (now - (weaponRequests.get(weapon) ?? -Infinity) >= 1000) {
                ex.mpRequestWeaponAsset(weapon | 0, 31, 0); weaponRequests.set(weapon, now);
              }
            } else {
              // 服务端已确认伤害，转播只产生轨迹/枪声，不再次独立扣血。
              ex.mpShootBullet(vector(24, shot.event.origin), vector(72, shot.event.target),
                0, 1, weapon | 0, replica.ped, 1, 0, -1);
              // TASK_SHOOT_AT_COORD 会再产生默认伤害实弹；姿态仅使用不射击的瞄准任务。
              if (ex.mpTaskAimGunAtCoord) ex.mpTaskAimGunAtCoord(replica.ped, vector(72, shot.event.target), 250, 0, 0);
            }
          }
        }
      }
      if (packet.shots?.length) post({ type: 'shot_ack', ids: packet.shots.map((shot) => shot.id) });
      packet.shots = [];
    }
    tick = (thread) => {
      try {
        const now = performance.now();
        if (stopped) return;
        // 跳过没有游戏脚本资源管理器的线程，不能从任意帧回调直接写实体。
        const handler = Number(ex.mpGetCurrentHandler());
        if (Number(ex.mpGetActiveThread()) !== thread || !handler) return;
        if (!scratch) {
          scratch = Number(ex.mpAlloc(128n));
          block = Number(ex.mpAlloc(BigInt(CAPACITY + 16)));
          if (!scratch || !block) throw new Error('同步缓冲区分配失败');
          new Uint8Array(memory.buffer, block, CAPACITY + 16).fill(0);
          post({ type: 'memory', memory, block, capacity: CAPACITY });
        }
        readPacket();
        if (!useOwner(thread, handler, now)) return;
        sampleShots(now);
        if (now - lastTick < 40) return;
        lastTick = now;
        observeWorldReadiness(now);
        processNotices(now);
        if (!packet?.connected) {
          for (const replica of replicas.values()) erase(replica);
          replicas.clear();
          // 断线恢复同一身份时保留本地角色和位置，不重复随机换模/出生。
          return;
        }
        if (sessionId !== packet.client_id) {
          for (const replica of replicas.values()) erase(replica, 'new_session');
          replicas.clear(); retryAfter.clear();
          sessionId = packet.client_id; initialPlacement = false;
          avatarInitialized = false; avatarChangeRequested = false; avatarTarget = 0;
          avatarRequestedAt = 0; avatarAttempts = 0; avatarChangedAt = 0;
          appearancePed = 0; localAppearance = null;
          lifeOverride = null; lastAuthorityAlive = null; lastRespawnRevision = -1;
          modelMismatch = null; modelRestore = null; lastGoodLocal = null;
          modelDefaultsPending = false;
          weaponSample = null; pendingShots = [];
          authorityStates.clear();
        }
        for (const player of packet.combat || []) mergeAuthority(player);
        for (const control of packet.controls || []) authorityControl(control.event);
        const members = new Set((packet.members || []).map((member) => member.id));
        for (const id of authorityStates.keys()) if (id !== packet.client_id && !members.has(id)) authorityStates.delete(id);
        updateWorld(now);
        // 等待服务器恢复快照，避免刷新时先随机换装或上报单机出生坐标。
        if (packet.resumed && !packet.resume_state_ready) return;
        const resumeState = packet.resumed ? packet.resume_state : null;
        if (!deathRestartPaused && ex.mpPauseDeathRestart) {
          ex.mpPauseDeathRestart(1); deathRestartPaused = true;
        }
        let authority = authorityStates.get(packet.client_id);
        const acknowledgement = [];
        for (const control of packet.controls || []) {
          if (consumedControls.has(control.id)) { acknowledgement.push(control.id); continue; }
          const event = control.event;
          let completed = true;
          const revision = Number.isSafeInteger(event?.revision) ? event.revision : 0;
          const eventId = event?.type === 'damage' ? event.victim_id : event?.player_id;
          if (['damage', 'death', 'respawn'].includes(event?.type) && revision < (authorityStates.get(eventId)?.revision ?? 0)) {
            consumedControls.add(control.id); acknowledgement.push(control.id); continue;
          }
          if (event?.type === 'respawn' && event.player_id === packet.client_id) {
            if (revision > lastRespawnRevision) {
              completed = Boolean(recoverLocal(event.position, event.heading ?? 90, event.health ?? 200, revision, now));
            }
          } else if (event?.type === 'correction' && revision >= lastRespawnRevision) {
            const ped = ex.mpGetPlayerPed(-1);
            completed = Boolean(ped && validPosition(event.position));
            if (completed) {
              ex.mpSetCoordsNoOffset(ped, vector(0, event.position), 1, 1, 1);
              ex.mpSetHeading(ped, event.heading ?? 90);
              initialPlacement = true;
              lastGoodLocal = { ...(lastGoodLocal || {}), position: [...event.position], heading: event.heading ?? 90 };
              if (modelRestore) modelRestore = lastGoodLocal;
            }
          }
          if (completed) {
            consumedControls.add(control.id); acknowledgement.push(control.id);
            if (consumedControls.size > 128) consumedControls.delete(consumedControls.values().next().value);
          }
        }
        if (acknowledgement.length) post({ type: 'control_ack', ids: acknowledgement });
        packet.controls = (packet.controls || []).filter((control) => !consumedControls.has(control.id));
        if (lifeOverride && (!authority || (authority.revision ?? 0) <= lifeOverride.revision)) authority = lifeOverride;
        else if (authority && lifeOverride) lifeOverride = null;
        let localPed = ex.mpGetPlayerPed(-1);
        if (!localPed) { roleWaiting(now, true); return; } // 远端更新继续，复活命令等待有效角色。
        if (authority) {
          if (authority.alive) {
            const revision = Number.isSafeInteger(authority.revision) ? authority.revision : 0;
            if (lastAuthorityAlive === false || ex.mpIsDead(localPed, 0)) {
              const restoring = !initialPlacement && validPosition(resumeState?.position);
              const localAccident = lastAuthorityAlive !== false && validPosition(lastGoodLocal?.position);
              const destination = restoring ? resumeState.position
                : localAccident ? lastGoodLocal.position
                : validPosition(authority.spawn) ? authority.spawn
                : validPosition(packet.spawn) ? packet.spawn : TEST_SPAWN;
              const restored = recoverLocal(destination, restoring && Number.isFinite(resumeState.heading)
                ? resumeState.heading : localAccident ? lastGoodLocal.heading : 90, authority.health, revision, now);
              if (!restored) return;
              localPed = restored;
              authority = lifeOverride;
            }
            ex.mpSetInvincible(localPed, 1);
            if (now - lastRecoveryAt < 5000 && now - lastRecoveryFadeAt >= 500 && ex.mpIsScreenFadedOut?.()) {
              if (ex.mpForcePlaying) ex.mpForcePlaying();
              if (ex.mpSetPlayerControl) ex.mpSetPlayerControl(ex.mpPlayerId(), 1, 0);
              if (ex.mpScreenFadeIn) ex.mpScreenFadeIn(250);
              lastRecoveryFadeAt = now;
            }
          } else ex.mpSetInvincible(localPed, 0);
          const nativeHealth = nativeCombatHealth(authority.health);
          if (ex.mpGetHealth(localPed) !== nativeHealth) ex.mpSetHealth(localPed, nativeHealth, 0);
          lastAuthorityAlive = authority.alive;
        }
        ex.mpGetEntityCoords(BigInt(scratch), localPed, 1);
        let position = readVector(0);
        const positionUnavailable = !validPosition(position) || (position[0] === 0 && position[1] === 0);
        // 被替换的 ped 可能暂在原点；恢复事务仍可使用最后有效的在线位置。
        if (positionUnavailable) {
          if (!validPosition(lastGoodLocal?.position)) { roleWaiting(now, true); return; }
          position = [...lastGoodLocal.position];
        }
        // 公共战局使用 GTA 的多人自由模式角色；不替换单机三位主角。
        if (ex.mpSetPlayerModel && ex.mpPlayerId && ex.mpDefaultVariation) {
          const fallback = packet.avatar === 'female' ? 0x9c9effd8 : 0x705e61f2;
          const avatar = ONLINE_MODELS.has(resumeState?.model) ? resumeState.model
            : ONLINE_MODELS.has(packet.model) ? packet.model : fallback;
          if (avatarTarget !== avatar) {
            avatarTarget = avatar; avatarInitialized = false; avatarChangeRequested = false;
            avatarRequestedAt = 0; avatarAttempts = 0;
            localAppearance = null; appearancePed = 0;
            modelMismatch = null; modelRestore = null;
          }
          const currentModel = ex.mpGetModel(localPed) >>> 0;
          if (currentModel === avatar) {
            avatarInitialized = true; modelMismatch = null;
            if (avatarChangeRequested) { avatarChangeRequested = false; avatarAttempts = 0; }
            if (modelDefaultsPending) { ex.mpDefaultVariation(localPed); modelDefaultsPending = false; }
          } else if (authority?.alive === false) {
            // 死亡由服务端重生恢复，不对尸体启动活人换模。
            return;
          } else if (avatarInitialized) {
            const key = localPed + ':' + currentModel;
            if (modelMismatch?.key !== key) modelMismatch = { key, since: now };
            if (now - modelMismatch.since < 1000 || now - avatarChangedAt < 3000) { roleWaiting(now, true); return; }
            avatarInitialized = false; avatarChangeRequested = false; avatarAttempts = 0;
            modelRestore = lastGoodLocal ? { ...lastGoodLocal, position: [...lastGoodLocal.position] }
              : { position: [...position], heading: ex.mpHeading(localPed), weapon: ex.mpSelectedWeapon(localPed) >>> 0 };
            lifecycle('avatar_recovery_requested');
          }
          if (!avatarInitialized && currentModel !== avatar) {
            const hash = avatar | 0;
            if (!ex.mpHasModel(hash)) {
              requestModel(hash, now);
              roleWaiting(now, Boolean(modelRestore));
              return;
            }
            // 不与原脚本每帧抢着换模；公共引擎已隔离原 SET_PLAYER_MODEL 包装入口。
            if (avatarChangeRequested) {
              // 异步换模可能暂未完成，限频重试；不能让一次超时永久关闭同步桥。
              const cooldown = Math.min(10000, 3000 + Math.max(0, avatarAttempts - 3) * 1000);
              if (now - avatarRequestedAt < cooldown) { roleWaiting(now, Boolean(modelRestore)); return; }
            }
            avatarChangeRequested = true;
            avatarRequestedAt = now; avatarAttempts++;
            modelDefaultsPending = true;
            try { ex.mpSetPlayerModel(ex.mpPlayerId(), hash); }
            catch { roleWaiting(now, true); return; }
            localPed = ex.mpGetPlayerPed(-1);
            if (!localPed) { roleWaiting(now, true); return; }
            avatarChanges++; lifecycle('avatar_initialized');
            if ((ex.mpGetModel(localPed) >>> 0) !== avatar) { roleWaiting(now, Boolean(modelRestore)); return; }
            ex.mpDefaultVariation(localPed); modelDefaultsPending = false;
            avatarInitialized = true;
            avatarChangeRequested = false; avatarAttempts = 0; modelMismatch = null;
            avatarChangedAt = now;
            ex.mpGetEntityCoords(BigInt(scratch), localPed, 1);
            position = readVector(0);
          }
          if (modelRestore && avatarInitialized) {
            ex.mpSetCoordsNoOffset(localPed, vector(0, modelRestore.position), 1, 1, 1);
            ex.mpSetHeading(localPed, modelRestore.heading ?? 90);
            if (modelRestore.weapon) {
              ex.mpGiveWeapon(localPed, modelRestore.weapon | 0, 999, 0, 1);
              ex.mpSetCurrentWeapon(localPed, modelRestore.weapon | 0, 1);
            }
            if (authority) {
              ex.mpSetInvincible(localPed, authority.alive ? 1 : 0);
              ex.mpSetHealth(localPed, nativeCombatHealth(authority.health), 0);
            }
            position = [...modelRestore.position]; modelRestore = null;
            appearancePed = 0; avatarChangedAt = now;
            lifecycle('avatar_recovered');
          } else if (positionUnavailable) {
            roleWaiting(now, true); return;
          }
        }
        if (appearancePed !== localPed) {
          if (!localAppearance && resumeState?.model === (ex.mpGetModel(localPed) >>> 0)
              && validAppearance(resumeState.appearance)) localAppearance = resumeState.appearance;
          if (localAppearance) applyAppearance(localPed, localAppearance, ex.mpGetModel(localPed) >>> 0);
          else localAppearance = randomizeAndCapture(localPed, ex.mpGetModel(localPed) >>> 0, packet.appearance_spec);
          appearancePed = localPed;
        }
        // 换模会创建新的 ped，不能沿用旧句柄上写过的权威血量。
        if (authority) {
          ex.mpSetInvincible(localPed, authority.alive ? 1 : 0);
          if (ex.mpGetHealth(localPed) !== nativeCombatHealth(authority.health)) ex.mpSetHealth(localPed, nativeCombatHealth(authority.health), 0);
        }
        // 测试阶段固定出生区，既不使用随机点，也不依赖对方状态是否已经到达。
        if (!initialPlacement) {
          const index = Math.max(0, (packet.members || []).findIndex((member) => member.id === packet.client_id));
          position = validPosition(resumeState?.position) ? [...resumeState.position]
            : validPosition(packet.resume_position) ? [...packet.resume_position]
            : validPosition(packet.spawn) ? [...packet.spawn]
            : [TEST_SPAWN[0] + (index % 8) * 2, TEST_SPAWN[1] + Math.floor(index / 8) * 2, TEST_SPAWN[2]];
          ex.mpSetCoordsNoOffset(localPed, vector(0, position), 1, 1, 1);
          ex.mpSetHeading(localPed, Number.isFinite(resumeState?.heading) ? resumeState.heading : 90);
          initialPlacement = true;
          post({ type: 'game_status', connected: true, peer_count: replicas.size, spawned: true });
        }
        const model = ex.mpGetModel(localPed) >>> 0;
        const heading = ((ex.mpHeading(localPed) % 360) + 360) % 360;
        const health = Math.max(0, Math.min(1000, ex.mpGetHealth(localPed)));
        const weapon = actualWeapon(localPed).hash;
        const shooting = !!ex.mpIsShooting(localPed);
        const actions = actionsFor(localPed);
        const ray = actions.aiming ? cameraRay() : null;
        const localState = { position, model, heading, health, weapon, shooting, actions,
          ...(ray && validPosition(ray.target) ? { aim_target: ray.target } : {}),
          ...(localAppearance ? { appearance: localAppearance } : {}) };
        if (!authority || authority.alive) lastGoodLocal = { position: [...position], heading, weapon };
        if (now - lastState >= 50) {
          lastState = now;
          post({ type: 'local_state', state: localState });
        }
        if (now - lastStatus >= 1000) {
          lastStatus = now;
          post({ type: 'game_status', connected: true, peer_count: replicas.size,
            client_id: packet.client_id,
            weapon, weapon_ready: actualWeapon(localPed).ready,
            ...(authority ? { health: authority.health, alive: authority.alive, revision: authority.revision,
              native_health: ex.mpGetHealth(localPed), native_dead: Boolean(ex.mpIsDead(localPed, 0)),
              kills: authority.kills, deaths: authority.deaths } : {}) });
        }
        pendingShots = pendingShots.filter((shot) => now - shot.at <= Math.max(250, shotInterval(shot.event.weapon) + 100)
          && shot.ped === localPed && shot.event.weapon === weapon);
        if (pendingShots.length && now - lastShot >= shotInterval(weapon) && (!authority || authority.alive)) {
          lastShot = now;
          const shot = pendingShots.shift();
          // 同一武器的新状态随事件交给页面，网络层先发状态再发射击，避免换枪竞态。
          post({ type: 'local_shot', event: shot.event, state: localState });
        }
      } catch (error) {
        // 不能把 JS 异常抛回 scrThread::Run；它必须继续执行原来的 TLS 清理路径。
        stopped = true;
        try { post({ type: 'bridge_error', message: String(error) }); } catch { /* 不向 WASM 抛异常 */ }
      }
    };
  };
};
