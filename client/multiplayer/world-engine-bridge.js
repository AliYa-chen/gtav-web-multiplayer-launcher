'use strict';
// 统一实体适配器：只创建服务器登记对象，所有者代算 GTA 物理，其他端应用已确认组件。
self.createWorldEntityBridge = function ({ ex, memory, post, playerReplica, onPlayerAnimation }) {
  const replicas = new Map();
  const requestedModels = new Map();
  const seatConfig = new Map();
  let epoch = null, buffer = 0, requestNumber = 0, lastInteractionAt = -Infinity;
  let lastLifeAt = -Infinity, pendingLife = null, lastMelee = false, fadesPaused = false;
  let lastSeat = null, leavePendingAt = -Infinity;
  let enumerationBuffer = 0, lastPopulationCleanup = -Infinity;
  let localGeneration = null;
  let animationBuffer = 0, animationRequestedAt = -Infinity;
  let lastMeleeSampleAt = -Infinity, lastMeleeSentAt = -Infinity, lastMeleeInput = false;
  let pendingMelee = [], lastMeleePhase = null;
  const consumedWorldEvents = new Set(), animationEvents = new Map();
  const effectFlashes = new Map(), consumedEffects = new Set();
  let effectEpoch = null, lastEffectFrame = null;
  const MAX_EFFECT_MARKERS = 32, FLASH_DURATION_MS = 450;
  const meleeDict = 'melee@unarmed@streamed_core';
  const meleeClips = ['heavy_punch_a', 'heavy_punch_b', 'heavy_punch_c'];
  const validPosition = (value) => Array.isArray(value) && value.length === 3
    && value.every((part) => Number.isFinite(part) && Math.abs(part) <= 16000);
  const data = () => new DataView(memory.buffer);
  function vector(offset, values) {
    values.forEach((value, index) => data().setFloat32(buffer + offset + 8 * index, value, true));
    return BigInt(buffer + offset);
  }
  function readVector(offset) { return [0, 8, 16].map((index) => data().getFloat32(buffer + offset + index, true)); }
  function erase(replica) {
    if (!replica || !ex.mpExists(replica.handle)) return;
    data().setInt32(buffer + 120, replica.handle, true);
    if (replica.kind === 'vehicle') ex.mpDeleteVehicle?.(BigInt(buffer + 120));
    else ex.mpDeletePed(BigInt(buffer + 120));
  }
  function clear() {
    for (const handle of seatConfig.keys()) protectSeat(handle, false);
    for (const replica of replicas.values()) erase(replica);
    replicas.clear(); requestedModels.clear(); epoch = null; pendingLife = null; lastMelee = false; localGeneration = null;
    lastSeat = null; leavePendingAt = lastInteractionAt = -Infinity;
    pendingMelee = []; lastMeleeInput = false; lastMeleePhase = null;
    consumedWorldEvents.clear(); animationEvents.clear();
    effectFlashes.clear(); consumedEffects.clear(); effectEpoch = null; lastEffectFrame = null;
  }
  function transform(handle) {
    ex.mpGetEntityCoords(BigInt(buffer), handle, 1);
    const position = readVector(0);
    if (!validPosition(position)) return null;
    const pointers = [72, 76, 80, 84].map((offset) => BigInt(buffer + offset));
    ex.mpGetQuaternion(handle, ...pointers);
    const rotation = [72, 76, 80, 84].map((offset) => data().getFloat32(buffer + offset, true));
    const norm = Math.hypot(...rotation);
    if (!Number.isFinite(norm) || norm < .001) return null;
    ex.mpGetVelocity(BigInt(buffer + 24), handle);
    const velocity = readVector(24);
    ex.mpGetAngularVelocity?.(BigInt(buffer + 48), handle);
    const angularVelocity = ex.mpGetAngularVelocity ? readVector(48) : [0, 0, 0];
    return { position, rotation: rotation.map((part) => part / norm), velocity, angular_velocity: angularVelocity };
  }
  function applyTransform(handle, value) {
    ex.mpSetCoordsNoOffset(handle, vector(0, value.position), 1, 1, 0);
    ex.mpSetQuaternion(handle, ...value.rotation);
    ex.mpSetVelocity(handle, vector(24, value.velocity));
    ex.mpSetAngularVelocity?.(handle, vector(48, value.angular_velocity));
  }
  function seatNumber(seat) { return seat === 'driver' ? -1 : Number(String(seat).split(':')[1]); }
  function protectSeat(handle, attached) {
    if (!ex.mpSetPedConfigFlag || !ex.mpGetPedConfigFlag) return;
    if (!ex.mpExists(handle)) { seatConfig.delete(handle); return; }
    if (attached) {
      if (!seatConfig.has(handle)) seatConfig.set(handle, Boolean(ex.mpGetPedConfigFlag(handle, 184, 0)));
      if (!ex.mpGetPedConfigFlag(handle, 184, 0)) ex.mpSetPedConfigFlag(handle, 184, 1);
    } else if (seatConfig.has(handle)) {
      ex.mpSetPedConfigFlag(handle, 184, seatConfig.get(handle) ? 1 : 0); seatConfig.delete(handle);
    }
  }
  function seatedAt(handle, vehicle, seat) {
    return Boolean(vehicle && ex.mpGetVehiclePedIsIn?.(handle, 0) === vehicle
      && (!ex.mpGetPedInSeat || ex.mpGetPedInSeat(vehicle, seatNumber(seat), 0) === handle));
  }
  function requestedSeat(vehicle, nativeSeat, localEntityId, entities) {
    const seats = vehicle?.components?.vehicle?.seats;
    if (!seats || !Number.isInteger(nativeSeat) || nativeSeat < -1 || nativeSeat > 15) return null;
    const requested = nativeSeat === -1 ? 'driver' : 'passenger:' + nativeSeat;
    if (!Object.hasOwn(seats, requested)) return null;
    if (seats[requested] === null || seats[requested] === localEntityId) return requested;
    const occupant = entities.get(seats[requested]);
    // The server permits taking an NPC driver's seat, but never another
    // player's seat. Keep that existing interaction when there is no player.
    if (requested === 'driver' && occupant?.kind === 'ped' && !occupant.player_id) return requested;
    // GTA returns -1 when the automatic enter task targets an occupied driver
    // seat. Use the server snapshot to choose a real empty passenger seat so
    // the request is not rejected as a second driver attempt.
    return Object.keys(seats).filter((seat) => /^passenger:(?:[0-9]|1[0-5])$/.test(seat))
      .sort((left, right) => seatNumber(left) - seatNumber(right))
      .find((seat) => seats[seat] === null || seats[seat] === localEntityId) || null;
  }
  function request(action, entity, seat) {
    post({ type: 'interaction_request', request_id: 'engine:' + (++requestNumber), action,
      ...(entity ? { entity_id: entity.entity_id, expected_revision: entity.revision } : {}),
      ...(entity && action !== 'leave_vehicle' ? { target_generation: entity.generation } : {}),
      ...(seat ? { seat } : {}) });
  }
  function animationPointers() {
    if (!animationBuffer) {
      animationBuffer = Number(ex.mpAlloc(256n));
      if (!animationBuffer) return null;
      const bytes = new Uint8Array(memory.buffer, animationBuffer, 256); bytes.fill(0);
      const encoder = new TextEncoder(); bytes.set(encoder.encode(meleeDict));
      meleeClips.forEach((clip, index) => bytes.set(encoder.encode(clip), 64 + index * 48));
    }
    return { dict: BigInt(animationBuffer), clips: meleeClips.map((_clip, index) => BigInt(animationBuffer + 64 + index * 48)) };
  }
  function prepareMeleeAnimation(now) {
    if (!ex.mpTaskPlayAnim || !ex.mpHasAnimDictLoaded) return;
    const pointers = animationPointers();
    if (!pointers || (ex.mpAnimDictExists && !ex.mpAnimDictExists(pointers.dict))) return;
    if (!ex.mpHasAnimDictLoaded(pointers.dict) && now - animationRequestedAt >= 1000) {
      ex.mpRequestAnimDict?.(pointers.dict); animationRequestedAt = now;
    }
  }
  function applyAiTask(entity, replica, entities, packet, now, localPed) {
    // 尸体只应用服务器确认的位置；不能被 idle/standstill 重新激活动作。
    if (entity.components.combat?.alive === false) return;
    const task = entity.ai_task, active = entity.owner_id === packet.client_id && entity.ownership === 'active';
    const valid = task && task.entity_id === entity.entity_id && task.generation === entity.generation
      && task.owner_epoch === entity.owner_epoch
      && (task.expires_at_tick === 0 || task.expires_at_tick >= packet.world.world_tick);
    const vehicleEntity = entities.get(task?.vehicle_entity_id);
    const vehicle = replicas.get(task?.vehicle_entity_id)?.handle;
    const driveReady = vehicle && vehicleEntity?.owner_id === packet.client_id && vehicleEntity?.ownership === 'active'
      && entity.components.attachment?.entity_id === task?.vehicle_entity_id
      && entity.components.attachment?.seat === 'driver' && ex.mpGetVehiclePedIsIn?.(replica.handle, 0) === vehicle;
    const action = active && valid && (task.action !== 'drive' || driveReady) ? task.action : 'idle';
    const key = active + ':' + entity.owner_epoch + ':' + (valid ? task.revision : 0) + ':' + action;
    const target = task?.target_entity_id ? entities.get(task.target_entity_id) : null;
    const targetHandle = target?.player_id === packet.client_id ? localPed : target?.player_id
      ? playerReplica(target.player_id) : replicas.get(task?.target_entity_id)?.handle;
    const targetReady = target && target.generation === task?.target_generation && target.components.combat?.alive !== false
      && targetHandle && ex.mpExists(targetHandle);
    const walking = ['wander', 'flee', 'pursue'].includes(action) && !entity.components.attachment && validPosition(task?.destination);
    const distance = walking ? Math.hypot(...task.destination.map((part, index) => part - entity.components.transform.position[index])) : 0;
    // GoStraight 的原生任务会在三秒后结束；同一服务端路点仍未抵达时续发，避免等新 revision 才动。
    const refreshWalk = walking && distance > .2 && now - (replica.aiAppliedAt ?? -Infinity) >= 2500;
    if (replica.aiKey !== key || refreshWalk) {
      // 目标尚未加载时保留重试，但不逐帧清除原生任务。
      if (replica.aiKey !== key && replica.aiAttemptKey === key && now - replica.aiAttemptAt < 1000) return;
      replica.aiAttemptKey = key; replica.aiAttemptAt = now;
      ex.mpClearTasksImmediately?.(replica.handle);
      replica.aiKey = null;
      if (action === 'drive') {
        if (validPosition(task.destination) && ex.mpDriveToCoord) ex.mpDriveToCoord(replica.handle, vehicle, vector(0, task.destination), task.speed, 786603, 4);
        else if (!task.destination) ex.mpDriveWander?.(replica.handle, vehicle, task.speed, 786603);
      } else if (walking) {
        const heading = Math.atan2(task.destination[1] - entity.components.transform.position[1],
          task.destination[0] - entity.components.transform.position[0]) * 180 / Math.PI - 90;
        ex.mpTaskGoStraight?.(replica.handle, vector(0, task.destination), task.speed, 3000, heading, .5);
      } else if (action === 'wander' && !entity.components.attachment) {
        ex.mpTaskWander?.(replica.handle, 10, 0);
      } else if (action === 'combat' && !entity.components.attachment) {
        if (!targetReady) return; // 等目标模型出现后再应用同一个任务版本。
        ex.mpTaskCombatPed?.(replica.handle, targetHandle, 0, 16);
      } else ex.mpTaskStandStill?.(replica.handle, -1);
      replica.aiKey = key; replica.task = action; replica.aiAppliedAt = now;
      post({ type: 'world_entity_status', entity_id: entity.entity_id, kind: 'ped', phase: 'ai_' + action,
        task_revision: valid ? task.revision : 0 });
    }
    if (action === 'combat' && targetReady && ex.mpIsShooting(replica.handle)
        && now - (replica.lawShotAt ?? -Infinity) >= 1500) {
      replica.lawShotAt = now;
      post({ type: 'simulation_result', kind: 'npc_shot', entity_id: entity.entity_id, owner_epoch: entity.owner_epoch,
        generation: entity.generation, target_entity_id: target.entity_id, target_generation: target.generation });
    }
  }
  function renderEffects(packet, now) {
    if (!packet?.connected || !packet.world?.ready) return;
    if (!buffer) buffer = Number(ex.mpAlloc(128n));
    if (!buffer) return;
    // Effects run before the heavier entity update. Complete this transition
    // once so update() cannot erase acknowledged flashes or reset frame limits.
    if (epoch !== packet.world.world_epoch) { clear(); epoch = packet.world.world_epoch; }
    const tickFor = value => (value.world_tick || 0) + Math.max(0, value.received_at_epoch
      && Number.isFinite(globalThis.performance?.timeOrigin)
      ? globalThis.performance.timeOrigin + now - value.received_at_epoch : now - (value.received_at ?? now));
    if (effectEpoch !== packet.world.world_epoch) {
      effectEpoch = packet.world.world_epoch; effectFlashes.clear(); consumedEffects.clear(); lastEffectFrame = null;
    }
    const acknowledge = [];
    for (const item of (packet.world_effects || []).slice(0, 64)) {
      const event = item.event, key = 'effect:' + item.id;
      if (!consumedEffects.has(key)) {
        consumedEffects.add(key);
        if (event?.world_epoch === effectEpoch && validPosition(event.position)
            && event.damage_type === 'EXPLOSIVE' && Number.isFinite(event.radius)) {
          const age = Math.max(0, tickFor(event) - (event.world_tick || 0));
          if (age < FLASH_DURATION_MS) effectFlashes.set(key, { position: [...event.position],
            radius: Math.min(8, Math.max(.2, event.radius)), at: now - age });
        }
      }
      acknowledge.push(item.id);
    }
    while (consumedEffects.size > 2048) consumedEffects.delete(consumedEffects.values().next().value);
    while (effectFlashes.size > MAX_EFFECT_MARKERS) effectFlashes.delete(effectFlashes.keys().next().value);
    if (acknowledge.length) post({ type: 'world_effect_ack', ids: acknowledge });
    // DrawMarkerSphere uses the fullscreen-glow renderer, which traps in this
    // engine build. AddExplosion also runs physics/events even with noDamage.
    // Use ordinary model markers instead; never replay a native explosion.
    const frame = ex.mpFrameCount?.() ?? Math.floor(now / 16);
    if (frame === lastEffectFrame || !ex.mpDrawMarker) return;
    lastEffectFrame = frame;
    let drawn = 0;
    function marker(position, radius, red, green, blue, alpha) {
      if (drawn >= MAX_EFFECT_MARKERS || !validPosition(position) || !Number.isFinite(radius) || radius <= 0) return;
      const diameter = Math.min(16, radius * 2);
      drawn++;
      try {
        ex.mpDrawMarker(28, vector(0, position), vector(24, [0, 0, 0]), vector(48, [0, 0, 0]),
          vector(72, [diameter, diameter, diameter]), red, green, blue, alpha, 0, 0, 2, 0, 0n, 0n, 0);
      } catch { /* A visual failure must not stop input, state or effect acknowledgements. */ }
    }
    for (const [key, flash] of effectFlashes) {
      const age = now - flash.at;
      if (age >= FLASH_DURATION_MS) { effectFlashes.delete(key); continue; }
      const progress = Math.max(0, age / FLASH_DURATION_MS);
      marker(flash.position, Math.max(.2, flash.radius * (.25 + .75 * progress)), 255, 155, 40,
        Math.round(180 * (1 - progress)));
    }
    for (const item of (packet.world_projectiles || []).slice(0, 256)) {
      if (drawn >= MAX_EFFECT_MARKERS) break;
      if (item.world_epoch !== packet.world.world_epoch || !validPosition(item.position)) continue;
      const tick = tickFor(item);
      if (tick >= item.expires_at || item.phase === 'expired') continue;
      let position = item.position;
      if (item.phase !== 'landed' && item.physics === 'ballistic') {
        if (!validPosition(item.motion_origin) || !validPosition(item.velocity) || !Number.isSafeInteger(item.motion_at)
          || item.motion_at < 0 || !Number.isFinite(item.gravity) || item.gravity < 0 || item.gravity > 100) continue;
        const seconds = Math.max(0, tick - item.motion_at) / 1000;
        position = item.motion_origin.map((value, index) => value + item.velocity[index] * seconds
          - (index === 2 ? .5 * 9.81 * item.gravity * seconds ** 2 : 0));
      } else if (item.phase !== 'landed' && validPosition(item.origin) && validPosition(item.target) && item.flight_ms > 0) {
        const t = Math.max(0, Math.min(1, (tick - item.created_at) / item.flight_ms));
        const arc = item.gravity * 9.81 * (item.flight_ms / 1000) ** 2 / 8;
        position = item.origin.map((value, index) => value + (item.target[index] - value) * t + (index === 2 ? 4 * arc * t * (1 - t) : 0));
      }
      marker(position, .09, 245, 180, 70, 217);
    }
    for (const item of (packet.world_areas || []).slice(0, 256)) {
      if (drawn >= MAX_EFFECT_MARKERS) break;
      if (item.world_epoch !== packet.world.world_epoch || !validPosition(item.position) || tickFor(item) >= item.expires_at) continue;
      const fire = item.damage_type === 'FIRE';
      marker(item.position, Math.min(8, Math.max(.2, item.radius)), fire ? 230 : 135,
        fire ? 100 : 145, fire ? 30 : 150, 46);
    }
  }
  function sampleMelee(packet, now, localPed, { localReady = true } = {}) {
    if (now - lastMeleeSampleAt < 5 || !packet?.connected || !packet.world?.ready || !localReady || !localPed) return;
    lastMeleeSampleAt = now;
    const actor = packet.world.entities.find((entity) => entity.player_id === packet.client_id);
    if (!actor || !actor.components.combat?.alive || actor.components.attachment || ex.mpIsDead(localPed, 0)) { pendingMelee = []; return; }
    if (!buffer) buffer = Number(ex.mpAlloc(128n));
    if (!buffer) return;
    const melee = Boolean(ex.mpMeleeAction?.(localPed));
    const bytes = new Uint8Array(memory.buffer, buffer + 112, 2); bytes.fill(0);
    ex.mpCachedMeleeInputs?.(BigInt(buffer + 112), BigInt(buffer + 113));
    const input = Boolean(bytes[0] || bytes[1]);
    let phase = null;
    const pointers = ex.mpIsPlayingAnim && ex.mpAnimTime ? animationPointers() : null;
    if (pointers) {
      for (let index = 0; index < pointers.clips.length; index++) if (ex.mpIsPlayingAnim(localPed, pointers.dict, pointers.clips[index], 3)) {
        phase = { clip: index, time: ex.mpAnimTime(localPed, pointers.dict, pointers.clips[index]) }; break;
      }
    }
    const newAnimation = phase && (!lastMeleePhase || phase.clip !== lastMeleePhase.clip || phase.time < lastMeleePhase.time - .25);
    const edge = (input && !lastMeleeInput) || (melee && !lastMelee) || newAnimation;
    // 缓存输入捕获重复按键；动画相位补充连招，任务状态只作为兜底，不能把目标0当成已命中。
    if (edge || (input && melee && !phase && now - lastMeleeSentAt >= 900)) {
      pendingMelee.push({ at: now, actor: actor.entity_id, generation: actor.generation, world: packet.world.world_epoch });
      if (pendingMelee.length > 8) pendingMelee.splice(7, 1);
    }
    lastMelee = melee; lastMeleeInput = input; lastMeleePhase = phase;
    if (!pendingMelee.length) return;
    const intent = pendingMelee[0];
    if (intent.actor !== actor.entity_id || intent.generation !== actor.generation
        || intent.world !== packet.world.world_epoch || now - intent.at > 2000) { pendingMelee = []; return; }
    const weapon = ex.mpSelectedWeapon(localPed) >>> 0;
    // 战斗冷却由服务器有界队列裁决；客户端仅合并抖动，不丢弃连续按键。
    if (now - lastMeleeSentAt < 50) return;
    const requestId = 'engine:' + (++requestNumber);
    post({ type: 'melee_sample', request_id: requestId, actor_entity_id: actor.entity_id,
      source: newAnimation ? 'animation' : input ? 'input' : 'task' });
    // 不依赖 GET_MELEE_TARGET 的瞬时本机 GUID；服务器使用已确认位置和面向选取目标。
    ex.mpGetEntityCoords(BigInt(buffer), localPed, 1);
    const position = readVector(0);
    const heading = ((ex.mpHeading(localPed) % 360) + 360) % 360;
    const state = { position, heading, model: ex.mpGetModel(localPed) >>> 0, health: Math.max(0, Math.min(1000, ex.mpGetHealth(localPed))),
      weapon, shooting: false,
      actions: { aiming: false, reloading: false, jumping: false, ducking: Boolean(ex.mpIsDucking?.(localPed)), sprinting: false },
      ...(actor.components.appearance ? { appearance: actor.components.appearance } : {}) };
    post({ type: 'interaction_request', request_id: requestId, action: 'melee', actor_generation: actor.generation, state });
    lastMeleeSentAt = now; pendingMelee.shift();
  }
  function playWorldEvents(packet, entities, now) {
    const acknowledge = [];
    for (const item of packet.world_events || []) {
      if (consumedWorldEvents.has(item.id)) { acknowledge.push(item.id); continue; }
      const event = item.event, actor = entities.get(event?.attacker_entity_id);
      const obsolete = event?.world_epoch !== packet.world.world_epoch || !actor
        || actor.generation !== event.attacker_generation || actor.components.combat?.alive === false;
      if (obsolete || actor.player_id === packet.client_id) { consumedWorldEvents.add(item.id); acknowledge.push(item.id); continue; }
      const handle = actor.player_id ? playerReplica(actor.player_id) : replicas.get(actor.entity_id)?.handle;
      let state = animationEvents.get(item.id);
      if (!state) { state = { at: now, playedAt: -Infinity, attempts: 0 }; animationEvents.set(item.id, state); }
      if (!handle || !ex.mpExists(handle)) {
        if (now - state.at < 3000) continue;
      } else if (ex.mpTaskPlayAnim && ex.mpHasAnimDictLoaded) {
        const pointers = animationPointers();
        if (pointers && (!ex.mpAnimDictExists || ex.mpAnimDictExists(pointers.dict))) {
          if (!ex.mpHasAnimDictLoaded(pointers.dict)) {
            if (now - animationRequestedAt >= 1000) { ex.mpRequestAnimDict?.(pointers.dict); animationRequestedAt = now; }
            if (now - state.at < 3000) continue;
          } else {
            if (state.attempts && ex.mpIsPlayingAnim?.(handle, pointers.dict, pointers.clips[0], 3)) {
              consumedWorldEvents.add(item.id); acknowledge.push(item.id); animationEvents.delete(item.id); continue;
            }
            if (now - state.playedAt >= 400 && state.attempts < 3) {
              // 拳击需要全身姿态；上半身叠加会被原移动任务覆盖。位置仍由服务器姿态约束。
              // 纯脚本动画不会创建近战伤害任务，生命变化只采用服务器裁决。
              ex.mpClearTasksImmediately?.(handle);
              if (actor.player_id) onPlayerAnimation?.(actor.player_id, now, 750);
              ex.mpTaskPlayAnim(handle, pointers.dict, pointers.clips[0], 8, -8, 700, 0, 0, 0, 0, 0);
              state.playedAt = now; state.attempts++;
            }
            if (!ex.mpIsPlayingAnim || ex.mpIsPlayingAnim(handle, pointers.dict, pointers.clips[0], 3)) {
              consumedWorldEvents.add(item.id); acknowledge.push(item.id); animationEvents.delete(item.id); continue;
            }
            if (now - state.at < 2000) continue;
          }
        }
      }
      post({ type: 'world_entity_status', entity_id: actor.entity_id, kind: 'ped', phase: 'melee_animation_unavailable' });
      consumedWorldEvents.add(item.id); acknowledge.push(item.id); animationEvents.delete(item.id);
    }
    while (consumedWorldEvents.size > 128) consumedWorldEvents.delete(consumedWorldEvents.values().next().value);
    if (acknowledge.length) post({ type: 'world_event_ack', ids: acknowledge });
  }
  function update(packet, now, localPed, { localReady = true } = {}) {
    const world = packet?.world;
    if (!buffer) buffer = Number(ex.mpAlloc(128n));
    if (!buffer) return { active: false };
    if (!packet?.connected || !world?.ready) {
      if (!packet?.connected) clear();
      for (const replica of replicas.values()) ex.mpFreeze(replica.handle, 1);
      return { active: false };
    }
    if (epoch !== world.world_epoch) { clear(); epoch = world.world_epoch; }
    prepareMeleeAnimation(now);
    const entities = new Map(world.entities.map((entity) => [entity.entity_id, entity]));
    const local = world.entities.find((entity) => entity.player_id === packet.client_id);
    if (!localReady) { lastSeat = null; leavePendingAt = -Infinity; }
    if (localPed && ex.mpPopulationType && now - lastPopulationCleanup >= 1000) {
      lastPopulationCleanup = now;
      if (!enumerationBuffer) enumerationBuffer = Number(ex.mpAlloc(520n));
      if (enumerationBuffer) {
        const protectedHandles = new Set([localPed, ...replicas.values()].map((value) => typeof value === 'number' ? value : value.handle));
        for (const entity of entities.values()) if (entity.player_id) protectedHandles.add(playerReplica(entity.player_id));
        const removeAmbient = (kind, count) => {
          for (let index = 0; index < Math.min(64, Math.max(0, count)); index++) {
            const handle = data().getInt32(enumerationBuffer + 8 + index * 8, true);
            if (!handle || protectedHandles.has(handle) || !ex.mpExists(handle)) continue;
            const population = ex.mpPopulationType(handle);
            // 仅移除单机随机人口；玩家、服务器登记对象和剧情/任务对象受保护。
            if (population >= 1 && population <= 5) erase({ handle, kind });
          }
        };
        data().setInt32(enumerationBuffer, 64, true);
        if (ex.mpAllVehicles) removeAmbient('vehicle', ex.mpAllVehicles(BigInt(enumerationBuffer)));
        data().setInt32(enumerationBuffer, 64, true);
        if (ex.mpNearbyPeds) removeAmbient('ped', ex.mpNearbyPeds(localPed, BigInt(enumerationBuffer), -1));
      }
    }
    for (const [id, replica] of replicas) if (!entities.has(id)) { erase(replica); replicas.delete(id); }
    const ordered = [...entities.values()].sort((a, b) => (a.kind === 'vehicle' ? -1 : 1) - (b.kind === 'vehicle' ? -1 : 1));
    for (const entity of ordered) {
      if (entity.player_id || !['ped', 'vehicle'].includes(entity.kind)) continue;
      const state = entity.components, position = state.transform?.position;
      if (!validPosition(position)) continue;
      let replica = replicas.get(entity.entity_id);
      if (replica && (replica.model !== entity.model || replica.generation !== entity.generation || !ex.mpExists(replica.handle))) {
        erase(replica); replicas.delete(entity.entity_id); replica = null;
      }
      if (!replica) {
        if (!ex.mpHasModel(entity.model | 0)) {
          if (now - (requestedModels.get(entity.model) ?? -Infinity) >= 1000) {
            ex.mpRequestModel(entity.model | 0); requestedModels.set(entity.model, now);
          }
          continue;
        }
        const handle = entity.kind === 'vehicle'
          ? ex.mpCreateVehicle?.(entity.model | 0, vector(0, position), 0, 0, 0, 0)
          : ex.mpCreatePed(4, entity.model | 0, vector(0, position), 0, 0, 0);
        if (!handle) continue;
        replica = { handle, kind: entity.kind, model: entity.model, generation: entity.generation,
          epoch: entity.owner_epoch, submittedAt: -Infinity, readyAt: -Infinity, active: false, revision: -1 };
        replicas.set(entity.entity_id, replica);
        if (entity.kind === 'ped') { ex.mpDefaultVariation?.(handle); ex.mpBlockEvents(handle, 1); }
        applyTransform(handle, state.transform);
        post({ type: 'world_entity_status', entity_id: entity.entity_id, phase: 'created', kind: entity.kind });
      }
      if (replica.epoch !== entity.owner_epoch) {
        replica.epoch = entity.owner_epoch; replica.active = false; replica.revision = -1;
        replica.submittedAt = replica.readyAt = -Infinity;
        replica.driveStarted = false;
        applyTransform(replica.handle, state.transform);
      }
      const offered = entity.owner_id === packet.client_id && entity.ownership === 'offered';
      const active = entity.owner_id === packet.client_id && entity.ownership === 'active';
      ex.mpFreeze(replica.handle, active ? 0 : 1);
      if (offered && now - replica.readyAt >= 1000) {
        replica.readyAt = now;
        post({ type: 'entity_ready', entity_id: entity.entity_id, owner_epoch: entity.owner_epoch });
      }
      if (!active && replica.revision !== entity.revision) applyTransform(replica.handle, state.transform);
      if (entity.kind === 'vehicle') {
        ex.mpSetInvincible(replica.handle, active ? 0 : 1);
        if (state.vehicle && (!active || !replica.active || replica.serverEngine !== state.vehicle.engine_health
            || replica.serverBody !== state.vehicle.body_health)) {
          ex.mpSetEngineHealth?.(replica.handle, state.vehicle.engine_health);
          ex.mpSetBodyHealth?.(replica.handle, state.vehicle.body_health);
          ex.mpSetEngineOn?.(replica.handle, state.vehicle.engine_on ? 1 : 0, 1, 1);
        }
        replica.serverEngine = state.vehicle?.engine_health; replica.serverBody = state.vehicle?.body_health;
        if (active && state.vehicle) {
          const engineHealth = ex.mpEngineHealth?.(replica.handle) ?? state.vehicle.engine_health;
          const bodyHealth = ex.mpBodyHealth?.(replica.handle) ?? state.vehicle.body_health;
          if ((engineHealth < state.vehicle.engine_health || bodyHealth < state.vehicle.body_health)
              && now - (replica.damageAt ?? -Infinity) >= 500) {
            replica.damageAt = now;
            post({ type: 'simulation_result', kind: 'vehicle_damage', entity_id: entity.entity_id,
              generation: entity.generation,
              owner_epoch: entity.owner_epoch, engine_health: Math.max(-4000, Math.min(state.vehicle.engine_health, engineHealth)),
              body_health: Math.max(0, Math.min(state.vehicle.body_health, bodyHealth)) });
          }
        }
      } else {
        const health = state.combat?.health ?? 200;
        const nativeHealth = health > 0 ? 100 + Math.max(1, Math.round(health / 2)) : 0;
        if (health === 0) {
          if (replica.serverHealth !== 0) ex.mpClearTasksImmediately?.(replica.handle);
          if (replica.serverHealth !== 0 || replica.revision !== entity.revision) {
            applyTransform(replica.handle, { ...state.transform, velocity: [0, 0, 0], angular_velocity: [0, 0, 0] });
          }
          ex.mpFreeze(replica.handle, 1);
          replica.aiKey = null; replica.task = 'dead';
        }
        ex.mpBlockEvents(replica.handle, 1);
        ex.mpSetCanRagdoll?.(replica.handle, active && health > 0 ? 1 : 0);
        ex.mpSetInvincible(replica.handle, active && health > 0 ? 0 : 1);
        // 枪械、火焰、爆炸与近战只消费服务端血量；撞击/摔落/溺水仍可上报环境候选。
        ex.mpSetProofs?.(replica.handle, 1, 1, 1, 0, 1, 0, 0, 0);
        if (health === 0 || !active || !replica.active || replica.serverHealth !== health) {
          if (health > 0 && ex.mpIsDead(replica.handle, 0)) { ex.mpResurrect?.(replica.handle); ex.mpRevive?.(replica.handle); }
          if (ex.mpGetHealth(replica.handle) !== nativeHealth) ex.mpSetHealth(replica.handle, nativeHealth, 0);
        }
        replica.serverHealth = health;
        if (active && health > 0) {
          const observed = ex.mpIsDead(replica.handle, 0) ? 0 : Math.max(0, Math.min(200, Math.round((ex.mpGetHealth(replica.handle) - 100) * 2)));
          if (observed < health && now - (replica.damageAt ?? -Infinity) >= 500) {
            replica.damageAt = now;
            post({ type: 'simulation_result', kind: 'entity_health', entity_id: entity.entity_id,
              generation: entity.generation,
              owner_epoch: entity.owner_epoch, health: observed });
          }
        }
        // 服务器发布任务；owner只执行引擎寻路/动画，不自行选择目标或决定战斗。
        const weapon = state.ped?.weapon;
        if (weapon && ex.mpHasWeaponAsset?.(weapon | 0) && replica.lawWeapon !== weapon) {
          ex.mpGiveWeapon?.(replica.handle, weapon | 0, 999, 0, 1);
          ex.mpSetCurrentWeapon?.(replica.handle, weapon | 0, 1); replica.lawWeapon = weapon;
        } else if (weapon && !ex.mpHasWeaponAsset?.(weapon | 0)) ex.mpRequestWeaponAsset?.(weapon | 0, 31, 0);
        if (entity.law_response) ex.mpSetPedAsCop?.(replica.handle, 1);

      }
      replica.active = active; replica.revision = entity.revision;
      if (active && !state.attachment && state.combat?.alive !== false && now - replica.submittedAt >= 100) {
        const value = transform(replica.handle);
        if (value) {
          replica.submittedAt = now;
          const view = entity.kind === 'vehicle'
            ? { engine_on: Boolean(ex.mpEngineRunning?.(replica.handle)), lights_on: state.vehicle?.lights_on === true }
            : { ...state.ped, shooting: Boolean(ex.mpIsShooting(replica.handle)), actions: state.ped?.actions ||
                { aiming: false, reloading: false, jumping: false, ducking: false, sprinting: false } };
          post({ type: 'entity_input', entity_id: entity.entity_id, owner_epoch: entity.owner_epoch,
            generation: entity.generation,
            based_on_revision: entity.revision, transform: value, view });
        }
      }
    }
    // Release removed occupants before attaching their replacements. Native
    // SetPedIntoVehicle refuses an occupied seat even after the server freed it.
    const occupants = [];
    for (const entity of entities.values()) if (entity.kind === 'ped') {
      if (entity.player_id === packet.client_id && !localReady) continue;
      const handle = entity.player_id === packet.client_id ? localPed
        : entity.player_id ? playerReplica(entity.player_id) : replicas.get(entity.entity_id)?.handle;
      if (!handle || !ex.mpExists(handle)) continue;
      occupants.push({ entity, handle });
      protectSeat(handle, Boolean(entity.components.attachment));
      const current = ex.mpGetVehiclePedIsIn?.(handle, 0) || 0;
      if (!entity.components.attachment && current
          && [...replicas.values()].some((entry) => entry.kind === 'vehicle' && entry.handle === current)) {
        ex.mpLeaveVehicle?.(handle, current, 16);
      }
    }
    const handles = new Set(occupants.map(({ handle }) => handle));
    for (const handle of seatConfig.keys()) if (!handles.has(handle)) protectSeat(handle, false);
    // Two replicated occupants can cross seats while their server attachments
    // remain valid. Release only the mismatched native occupants first; this
    // makes both target seats available for the following attach pass.
    for (const { entity, handle } of occupants) {
      const attachment = entity.components.attachment;
      const vehicle = attachment ? replicas.get(attachment.entity_id)?.handle : 0;
      const current = ex.mpGetVehiclePedIsIn?.(handle, 0) || 0;
      const managed = current && [...replicas.values()].some((entry) => entry.kind === 'vehicle' && entry.handle === current);
      if (attachment && vehicle && managed
          && !seatedAt(handle, vehicle, attachment.seat)) {
        if (entity.player_id === packet.client_id) { lastSeat = null; leavePendingAt = -Infinity; }
        ex.mpLeaveVehicle?.(handle, current, 16);
      }
    }
    // Attachments use shared IDs; each client resolves its own native handles.
    for (const { entity, handle } of occupants) {
      const attachment = entity.components.attachment;
      const vehicle = attachment ? replicas.get(attachment.entity_id)?.handle : 0;
      const current = ex.mpGetVehiclePedIsIn?.(handle, 0) || 0;
      const seatKey = attachment ? entity.generation + ':' + attachment.entity_id + ':' + attachment.seat : null;
      if (entity.player_id === packet.client_id && attachment && lastSeat === seatKey && !current
          && now - leavePendingAt >= 1000) {
        leavePendingAt = now; request('leave_vehicle', entity);
      }
      const leaving = entity.player_id === packet.client_id && now - leavePendingAt < 1500 && !current;
      const correctSeat = attachment && seatedAt(handle, vehicle, attachment.seat);
      if (vehicle && !correctSeat && !leaving) ex.mpSetPedIntoVehicle?.(handle, vehicle, seatNumber(attachment.seat));
      if (entity.player_id === packet.client_id) {
        if (!attachment) lastSeat = null;
        else if (seatedAt(handle, vehicle, attachment.seat)) lastSeat = seatKey;
        else if (lastSeat !== seatKey) lastSeat = null;
      }
      if (!entity.player_id) {
        const replica = replicas.get(entity.entity_id);
        if (replica) applyAiTask(entity, replica, entities, packet, now, localPed);
      }
    }
    playWorldEvents(packet, entities, now);
    const shotAcks = [];
    for (const item of packet.world_shots || []) {
      if (consumedWorldEvents.has('shot:' + item.id)) { shotAcks.push(item.id); continue; }
      const event = item.event, attacker = entities.get(event?.attacker_entity_id), target = entities.get(event?.target_entity_id);
      if (!attacker || !target || event.world_epoch !== world.world_epoch || attacker.generation !== event.attacker_generation || target.generation !== event.target_generation) {
        consumedWorldEvents.add('shot:' + item.id); shotAcks.push(item.id); continue;
      }
      if (attacker.owner_id === packet.client_id) { consumedWorldEvents.add('shot:' + item.id); shotAcks.push(item.id); continue; }
      const rule = (packet.weapon_rules || []).find((entry) => entry.weapon === event.weapon);
      if (!rule || !['hitscan', 'shotgun'].includes(rule.mode)) {
        consumedWorldEvents.add('shot:' + item.id); shotAcks.push(item.id); continue;
      }
      const handle = replicas.get(attacker.entity_id)?.handle;
      if (!handle || !ex.mpExists(handle) || !ex.mpHasWeaponAsset?.(event.weapon | 0)) {
        ex.mpRequestWeaponAsset?.(event.weapon | 0, 31, 0); continue;
      }
      if (validPosition(event.origin) && validPosition(event.target) && ex.mpShootBullet) {
        const origin = [event.origin[0], event.origin[1], event.origin[2] + 1.2], hit = [event.target[0], event.target[1], event.target[2] + 1];
        ex.mpShootBullet(vector(0, origin), vector(24, hit), 0, 1, event.weapon | 0, handle, 1, 0, -1);
      }
      consumedWorldEvents.add('shot:' + item.id); shotAcks.push(item.id);
    }
    if (shotAcks.length) post({ type: 'world_shot_ack', ids: shotAcks });
    if (!local) return { active: true };
    if (localGeneration !== null && localGeneration !== local.generation) {
      // 服务器刚允许重生，本机实体尚在恢复事务中，不能把旧尸体再报告成新一轮死亡。
      localGeneration = local.generation; pendingLife = null;
      return { active: true, localEntity: local, lifeTransition: true };
    }
    // 首次加载和换模事务中可能短暂没有有效玩家，不能当成环境死亡上报。
    if (!localReady) return { active: true, localEntity: local };
    localGeneration = local.generation;
    const arrested = Boolean(ex.mpIsArrested?.(ex.mpPlayerId(), 0));
    if (!localPed) {
      if (arrested && local.components.combat?.alive && now - lastLifeAt >= 500) {
        lastLifeAt = now; pendingLife = { at: now, generation: local.generation };
        post({ type: 'simulation_result', kind: 'life_report', reason: 'arrest', health: 0,
          entity_id: local.entity_id, owner_epoch: local.owner_epoch, generation: local.generation });
      }
      return { active: true, localEntity: local, awaitingLife: Boolean(pendingLife) };
    }
    if (!fadesPaused) {
      ex.mpFadeAfterDeath?.(0); ex.mpFadeAfterArrest?.(0); ex.mpFadeAfterRestart?.(1); fadesPaused = true;
    }
    ex.mpSetProofs?.(localPed, 1, 1, 1, 0, 1, 0, 0, 0);
    const life = local.components.combat, actualHealth = ex.mpGetHealth(localPed);
    const dead = Boolean(ex.mpIsDead(localPed, 0)) || actualHealth <= 100;
    const expectedHealth = life ? 100 + Math.max(1, Math.round(life.health / 2)) : 200;
    if (pendingLife && (local.generation !== pendingLife.generation || !life?.alive || now - pendingLife.at > 2000)) pendingLife = null;
    if (life?.alive && (arrested || dead || actualHealth < expectedHealth) && now - lastLifeAt >= 500) {
      lastLifeAt = now;
      pendingLife = { at: now, generation: local.generation };
      post({ type: 'simulation_result', kind: 'life_report', reason: arrested ? 'arrest' : dead ? 'dead' : 'environmental',
        entity_id: local.entity_id, owner_epoch: local.owner_epoch, generation: local.generation,
        health: arrested || dead ? 0 : Math.max(0, Math.min(200, Math.round((actualHealth - 100) * 2))) });
    }
    sampleMelee(packet, now, localPed, { localReady });
    const tryingVehicle = ex.mpTryingVehicle?.(localPed) || 0;
    if (tryingVehicle && !local.components.attachment) {
      const target = [...entities.values()].find((entity) => replicas.get(entity.entity_id)?.handle === tryingVehicle);
      if (target?.kind === 'vehicle') {
        const seat = requestedSeat(target, ex.mpTryingSeat?.(localPed) ?? -1, local.entity_id, entities);
        // Cancel every native attempt before it can evict a confirmed occupant.
        // Only the server-approved attachment is allowed to put a player inside.
        ex.mpClearTasksImmediately?.(localPed);
        if (seat && now - lastInteractionAt >= 1000) {
          lastInteractionAt = now; request('enter_vehicle', target, seat);
        }
      }
    }
    return { active: true, localEntity: local, awaitingLife: Boolean(pendingLife),
      seated: Boolean(local.components.attachment) };
  }
  function suppressPopulation(packet) {
    if (!packet?.connected || !packet.world?.ready) return;
    ex.mpPedDensity?.(0); ex.mpScenarioDensity?.(0, 0);
    ex.mpVehicleDensity?.(0); ex.mpRandomVehicleDensity?.(0); ex.mpParkedVehicleDensity?.(0);
  }
  return { update, sampleMelee, renderEffects, suppressPopulation, clear, entityHandle: (id) => replicas.get(id)?.handle || 0 };
};
