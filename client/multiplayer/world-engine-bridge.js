'use strict';
// 统一实体适配器：只创建服务器登记对象，所有者代算 GTA 物理，其他端应用已确认组件。
self.createWorldEntityBridge = function ({ ex, memory, post, playerReplica }) {
  const replicas = new Map();
  const requestedModels = new Map();
  let epoch = null, buffer = 0, requestNumber = 0, lastInteractionAt = -Infinity;
  let lastLifeAt = -Infinity, pendingLife = null, lastMelee = false, fadesPaused = false;
  let lastSeat = null, leavePendingAt = -Infinity;
  let enumerationBuffer = 0, lastPopulationCleanup = -Infinity;
  let localGeneration = null;
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
    const melee = Boolean(ex.mpMeleeAction?.(localPed));
    if (melee && !lastMelee && now - lastInteractionAt >= 715) {
      const targetHandle = ex.mpMeleeTarget?.(localPed);
      const target = [...entities.values()].find((entity) => entity.kind === 'ped' && entity.entity_id !== local.entity_id
        && targetHandle && (entity.player_id ? playerReplica(entity.player_id) : replicas.get(entity.entity_id)?.handle) === targetHandle);
      if (target) { lastInteractionAt = now; request('melee', target); }
    }
    lastMelee = melee;
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
  return { update, suppressPopulation, clear, entityHandle: (id) => replicas.get(id)?.handle || 0 };
};
