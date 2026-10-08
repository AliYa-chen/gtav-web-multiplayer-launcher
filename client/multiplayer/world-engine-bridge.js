'use strict';
// 统一实体适配器：只创建服务器登记对象，所有者代算 GTA 物理，其他端应用已确认组件。
self.createWorldEntityBridge = function ({ ex, memory, post, playerReplica, onPlayerAnimation }) {
  const replicas = new Map();
  const requestedModels = new Map();
  let epoch = null, buffer = 0, requestNumber = 0, lastInteractionAt = -Infinity;
  let lastLifeAt = -Infinity, pendingLife = null, lastMelee = false, fadesPaused = false;
  let lastSeat = null, leavePendingAt = -Infinity;
  let enumerationBuffer = 0, lastPopulationCleanup = -Infinity;
  let localGeneration = null;
  let animationBuffer = 0, animationRequestedAt = -Infinity;
  let lastMeleeSampleAt = -Infinity, lastMeleeSentAt = -Infinity, lastMeleeInput = false;
  let pendingMelee = null, lastMeleePhase = null;
  const consumedWorldEvents = new Set(), animationEvents = new Map();
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
    for (const replica of replicas.values()) erase(replica);
    replicas.clear(); requestedModels.clear(); epoch = null; pendingLife = null; lastMelee = false; localGeneration = null;
    pendingMelee = null; lastMeleeInput = false; lastMeleePhase = null;
    consumedWorldEvents.clear(); animationEvents.clear();
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
  function sampleMelee(packet, now, localPed, { localReady = true } = {}) {
    if (now - lastMeleeSampleAt < 5 || !packet?.connected || !packet.world?.ready || !localReady || !localPed) return;
    lastMeleeSampleAt = now;
    const actor = packet.world.entities.find((entity) => entity.player_id === packet.client_id);
    if (!actor || !actor.components.combat?.alive || actor.components.attachment || ex.mpIsDead(localPed, 0)) { pendingMelee = null; return; }
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
      pendingMelee = { at: now, actor: actor.entity_id, generation: actor.generation, world: packet.world.world_epoch };
    }
    lastMelee = melee; lastMeleeInput = input; lastMeleePhase = phase;
    if (!pendingMelee) return;
    if (pendingMelee.actor !== actor.entity_id || pendingMelee.generation !== actor.generation
        || pendingMelee.world !== packet.world.world_epoch || now - pendingMelee.at > 350) { pendingMelee = null; return; }
    if (now - lastMeleeSentAt < 715) return;
    const requestId = 'engine:' + (++requestNumber);
    post({ type: 'melee_sample', request_id: requestId, actor_entity_id: actor.entity_id,
      source: newAnimation ? 'animation' : input ? 'input' : 'task' });
    // 不依赖 GET_MELEE_TARGET 的瞬时本机 GUID；服务器使用已确认位置和面向选取目标。
    ex.mpGetEntityCoords(BigInt(buffer), localPed, 1);
    const position = readVector(0);
    const heading = ((ex.mpHeading(localPed) % 360) + 360) % 360;
    const state = { position, heading, model: ex.mpGetModel(localPed) >>> 0, health: Math.max(0, Math.min(1000, ex.mpGetHealth(localPed))),
      weapon: ex.mpSelectedWeapon(localPed) >>> 0, shooting: false,
      actions: { aiming: false, reloading: false, jumping: false, ducking: Boolean(ex.mpIsDucking?.(localPed)), sprinting: false },
      ...(actor.components.appearance ? { appearance: actor.components.appearance } : {}) };
    post({ type: 'interaction_request', request_id: requestId, action: 'melee', actor_generation: actor.generation, state });
    lastMeleeSentAt = now; pendingMelee = null;
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
        if (health === 0) ex.mpFreeze(replica.handle, 0);
        ex.mpBlockEvents(replica.handle, active ? 0 : 1);
        ex.mpSetCanRagdoll?.(replica.handle, active || health === 0 ? 1 : 0);
        ex.mpSetInvincible(replica.handle, active || health === 0 ? 0 : 1);
        if (!active || !replica.active || replica.serverHealth !== health) {
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
        if (active && health > 0 && !state.attachment && (!replica.active || replica.task !== 'wander')) {
          ex.mpTaskWander?.(replica.handle, 10, 0); replica.task = 'wander'; replica.driveStarted = false;
        }
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
    // 附件引用统一实体 ID；本机 ped/vehicle 句柄在每端单独解析。
    for (const entity of entities.values()) {
      if (entity.kind !== 'ped') continue;
      const handle = entity.player_id === packet.client_id ? localPed
        : entity.player_id ? playerReplica(entity.player_id) : replicas.get(entity.entity_id)?.handle;
      const attachment = entity.components.attachment;
      const vehicle = attachment ? replicas.get(attachment.entity_id)?.handle : 0;
      if (!handle || !ex.mpExists(handle)) continue;
      const current = ex.mpGetVehiclePedIsIn?.(handle, 0) || 0;
      if (entity.player_id === packet.client_id && attachment && lastSeat === attachment.entity_id && !current
          && now - leavePendingAt >= 1000) {
        leavePendingAt = now; request('leave_vehicle', entity);
      }
      const leaving = entity.player_id === packet.client_id && now - leavePendingAt < 1500 && !current;
      if (vehicle && current !== vehicle && !leaving) ex.mpSetPedIntoVehicle?.(handle, vehicle, seatNumber(attachment.seat));
      else if (!attachment && current && [...replicas.values()].some((entry) => entry.kind === 'vehicle' && entry.handle === current)) {
        ex.mpLeaveVehicle?.(handle, current, 16);
      }
      if (entity.player_id === packet.client_id) lastSeat = attachment && (current === vehicle || lastSeat === attachment.entity_id)
        ? attachment.entity_id : null;
      if (!entity.player_id && attachment && entity.simulation_task === 'driver') {
        const replica = replicas.get(entity.entity_id);
        if (replica?.active && !replica.driveStarted && vehicle) {
          ex.mpDriveWander?.(handle, vehicle, 10, 786603); replica.driveStarted = true; replica.task = 'driver';
        } else if (replica && !replica.active) replica.driveStarted = false;
      }
    }
    playWorldEvents(packet, entities, now);
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
    if (tryingVehicle && now - lastInteractionAt >= 1000) {
      const target = [...entities.values()].find((entity) => replicas.get(entity.entity_id)?.handle === tryingVehicle);
      if (target) {
        lastInteractionAt = now; const seat = ex.mpTryingSeat?.(localPed) ?? -1;
        ex.mpClearTasksImmediately?.(localPed);
        request('enter_vehicle', target, seat === -1 ? 'driver' : 'passenger:' + seat);
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
  return { update, sampleMelee, suppressPopulation, clear, entityHandle: (id) => replicas.get(id)?.handle || 0 };
};
