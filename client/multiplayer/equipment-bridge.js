'use strict';
// Runs only on the engine bridge's verified script owner. Inventory belongs to
// the server; this module reconciles native presentation and sends intentions.
self.createEquipmentBridge = function ({ ex, memory, post }) {
  const UNARMED = 0xa2719263;
  let key = '', ped = 0, buffer = 0, initialized = false, nextPrediction = 0;
  let lastSync = -Infinity, lastRequest = -Infinity, lastSelected = null, appliedWeapon = null;
  let reloadToken = '', reloadObserved = false, reloadWasActive = false, reloadFilled = false;
  let reloadRequestAt = -Infinity, nativeReloadStartedAt = -Infinity, reloadExpectedEnd = Infinity;
  let nearPickup = '', lastFrame = null;
  const pending = new Map(), completed = new Set(), acknowledgements = new Set();
  function reset() {
    key = ''; ped = 0; initialized = false; pending.clear(); completed.clear(); acknowledgements.clear();
    lastSync = lastRequest = reloadRequestAt = -Infinity; lastSelected = appliedWeapon = null;
    reloadToken = ''; reloadObserved = reloadWasActive = reloadFilled = false; nativeReloadStartedAt = -Infinity;
    reloadExpectedEnd = Infinity; nearPickup = ''; lastFrame = null;
  }
  function vector(offset, values) {
    const view = new DataView(memory.buffer);
    values.forEach((value, index) => view.setFloat32(buffer + offset + index * 8, value, true));
    return BigInt(buffer + offset);
  }
  function nativeClip(weapon) {
    if (!ex.mpGetAmmoInClip?.(ped, weapon | 0, BigInt(buffer + 96))) return null;
    const value = new DataView(memory.buffer).getInt32(buffer + 96, true);
    return value >= 0 ? value : null;
  }
  function request(action, fields, now) {
    post({ type: 'equipment_request', action, ...fields }); lastRequest = now;
  }
  function renderPickups(state, packet, now) {
    const entity = packet.world.entities.find(item => item.entity_id === state.entity_id);
    const position = entity?.components?.transform?.position;
    if (!position || entity.components.attachment || entity.components.combat?.alive === false) return;
    let nearest = null, distance = Infinity;
    const frame = ex.mpFrameCount ? ex.mpFrameCount() : Math.floor(now / 16);
    for (const pickup of state.pickups || []) {
      if (!pickup.available) continue;
      const range = Math.hypot(...pickup.position.map((part, index) => part - position[index]));
      if (range < distance && range <= pickup.radius) { nearest = pickup; distance = range; }
      if (range <= 60 && frame !== lastFrame && ex.mpDrawMarker) {
        ex.mpDrawMarker(1, vector(0, [pickup.position[0], pickup.position[1], pickup.position[2] - 1]),
          vector(24, [0, 0, 0]), vector(48, [0, 0, 0]), vector(72, [pickup.radius * 2, pickup.radius * 2, .15]),
          70, 180, 240, 110, 0, 0, 2, 0, 0n, 0n, 0);
      }
    }
    lastFrame = frame;
    const next = nearest ? nearest.id + ':' + nearest.generation : '';
    if (nearPickup !== next) {
      nearPickup = next;
      if (nearest) post({ type: 'equipment_prompt', name: nearest.name });
    }
    if (nearest && ex.mpControlJustPressed?.(0, 38) && now - lastRequest >= 250)
      request('pickup_claim', { pickup_id: nearest.id, pickup_generation: nearest.generation }, now);
  }
  function receivePredictions(packet, state) {
    const ack = [];
    for (const event of packet.equipment_predictions || []) {
      if (!Number.isSafeInteger(event.id)) continue;
      const local = pending.get(event.id);
      if (completed.has(event.id) || !local) { ack.push(event.id); continue; }
      if (event.weapon !== local.weapon) continue;
      if (event.status === 'cancelled' || event.status === 'consumed'
          && Number.isSafeInteger(event.seq) && state.last_shot_seq >= event.seq) {
        pending.delete(event.id); completed.add(event.id); ack.push(event.id);
      }
    }
    const events = [];
    for (const event of packet.equipment_events || []) {
      if (!Number.isSafeInteger(event.id)) continue;
      events.push(event.id);
      if (acknowledgements.has(event.id)) continue;
      acknowledgements.add(event.id);
      if (event.accepted === false && event.action === 'reload_begin' && event.reason !== 'reload_in_progress') {
        reloadObserved = false; reloadRequestAt = -Infinity;
      }
    }
    while (completed.size > 256) completed.delete(completed.values().next().value);
    while (acknowledgements.size > 128) acknowledgements.delete(acknowledgements.values().next().value);
    if (ack.length || events.length) post({ type: 'equipment_acknowledge', predictions: ack, events });
  }
  function predictionCounts(state) {
    const slots = new Map(state.weapons.map(slot => [slot.weapon, slot]));
    const byWeapon = new Map(), byAmmo = new Map();
    for (const prediction of pending.values()) {
      const slot = slots.get(prediction.weapon); if (!slot || slot.infinite) continue;
      byWeapon.set(slot.weapon, (byWeapon.get(slot.weapon) || 0) + 1);
      byAmmo.set(slot.ammo_type, (byAmmo.get(slot.ammo_type) || 0) + 1);
    }
    return { slots, byWeapon, byAmmo };
  }
  function reconcile(state, nativeReloading) {
    let changed = false;
    const { slots, byWeapon, byAmmo } = predictionCounts(state);
    const selected = (ex.mpSelectedWeapon(ped) >>> 0) || UNARMED;
    const currentSlot = slots.get(selected);
    const totals = new Map();
    for (const slot of state.weapons) {
      if (!slot.ammo_type) continue;
      const total = Math.max(0, slot.total - (byAmmo.get(slot.ammo_type) || 0));
      totals.set(slot.ammo_type, { weapon: slot.weapon, hash: slot.ammo_hash, total });
    }
    for (const [pool, { weapon, hash, total }] of totals) {
      if (nativeReloading && pool === currentSlot?.ammo_type) continue;
      if (ex.mpGetAmmo(ped, weapon | 0) !== total) {
        ex.mpSetAmmoByType(ped, hash | 0, total); changed = true;
      }
    }
    // Clip natives explicitly support only the currently equipped weapon.
    // SetPedAmmo refreshes its CWeapon total but may fill its clip; restore the
    // clip next, then undo SetAmmoInClip's pool delta with the by-type setter.
    if (currentSlot?.ammo_type && !nativeReloading) {
      const total = totals.get(currentSlot.ammo_type).total;
      const desired = Math.max(0, Math.min(total, currentSlot.thrown ? Math.min(currentSlot.clip_size, total)
        : currentSlot.clip - (byWeapon.get(selected) || 0)));
      const current = nativeClip(selected);
      if (current !== null && (current !== desired || changed || appliedWeapon !== selected)) {
        ex.mpSetAmmo(ped, selected | 0, total, 0);
        ex.mpSetAmmoInClip(ped, selected | 0, desired);
        ex.mpSetAmmoByType(ped, currentSlot.ammo_hash | 0, total);
        appliedWeapon = selected; changed = true;
      }
    }
    return changed;
  }
  function tick({ packet, localPed, now, localReady }) {
    if (!packet?.equipment_v1 || !packet.connected) { reset(); return false; }
    const state = packet.equipment;
    const entity = packet.world?.entities?.find(item => item.player_id === packet.client_id);
    if (!localReady || !state || !entity || !packet.world?.ready || !localPed
      || state.world_epoch !== packet.world.world_epoch || state.entity_id !== entity.entity_id
      || state.generation !== entity.generation || state.player_id !== packet.client_id
      || entity.components.combat?.alive === false || !ex.mpExists(localPed)) return false;
    if (!ex.mpRemoveAllWeapons || !ex.mpSetAmmo || !ex.mpSetAmmoByType || !ex.mpSetAmmoInClip || !ex.mpGetAmmo || !ex.mpGetAmmoInClip) return false;
    if (!buffer) {
      buffer = Number(ex.mpAlloc(128n));
      if (!Number.isSafeInteger(buffer) || buffer <= 0 || buffer + 128 > memory.buffer.byteLength) { buffer = 0; return false; }
    }
    const identity = state.world_epoch + ':' + state.entity_id + ':' + state.generation + ':' + localPed;
    if (key !== identity) {
      reset(); key = identity; ped = localPed;
      ex.mpRemoveAllWeapons(ped, 1); ex.mpSetInfiniteAmmoClip?.(ped, 0);
      for (const slot of state.weapons) {
        ex.mpGiveWeapon(ped, slot.weapon | 0, 0, 0, 0);
        ex.mpSetInfiniteAmmo?.(ped, slot.infinite ? 1 : 0, slot.weapon | 0);
      }
      ex.mpSetCurrentWeapon(ped, state.selected_weapon | 0, 1);
      lastSelected = state.selected_weapon;
      reconcile(state, false); initialized = true; lastSync = now; return true;
    }
    receivePredictions(packet, state);
    renderPickups(state, packet, now);
    if (now - lastSync < 40) return false;
    lastSync = now;
    const selected = (ex.mpSelectedWeapon(ped) >>> 0) || UNARMED;
    const allowed = state.weapons.some(slot => slot.weapon === selected);
    if (!allowed) {
      ex.mpRemoveWeapon?.(ped, selected | 0);
      ex.mpSetCurrentWeapon(ped, state.selected_weapon | 0, 1); return true;
    }
    if (selected !== lastSelected) {
      request('equip', { weapon: selected }, now); lastSelected = selected;
      reloadWasActive = false; reloadObserved = false; reloadFilled = false; reloadToken = '';
    }
    const nativeReloading = Boolean(ex.mpIsReloading?.(ped));
    const slot = state.weapons.find(item => item.weapon === selected);
    if (nativeReloading && !reloadWasActive) { nativeReloadStartedAt = now; reloadFilled = false; }
    if ((nativeReloading || reloadWasActive) && slot) {
      const { byWeapon, byAmmo } = predictionCounts(state);
      const predictedClip = Math.max(0, slot.clip - (byWeapon.get(slot.weapon) || 0));
      const clip = nativeClip(selected), target = Math.min(slot.clip_size, Math.max(0, slot.total - (byAmmo.get(slot.ammo_type) || 0)));
      if (clip !== null && target > predictedClip && clip >= target) reloadFilled = true;
    }
    if (nativeReloading && !state.reload && now - reloadRequestAt >= 500 && selected === state.selected_weapon) {
      request('reload_begin', { weapon: selected }, now); reloadRequestAt = now; reloadObserved = true;
    }
    if (state.reload) {
      if (reloadToken !== state.reload.token) {
        reloadToken = state.reload.token;
        reloadExpectedEnd = now + Math.max(0, state.reload.ready_at - state.server_time);
      }
      if (nativeReloading && selected === state.reload.weapon) reloadObserved = true;
      if (selected !== state.reload.weapon && now - reloadRequestAt >= 500) {
        request('reload_cancel', { reload_token: state.reload.token }, now); reloadRequestAt = now;
      } else if (reloadObserved && !nativeReloading && now - reloadRequestAt >= 250) {
        if (!reloadFilled) { request('reload_cancel', { reload_token: state.reload.token }, now); reloadRequestAt = now; }
        else if (now >= reloadExpectedEnd) { request('reload_complete', { reload_token: state.reload.token }, now); reloadRequestAt = now; }
      }
    } else if (!nativeReloading && (reloadToken || now - reloadRequestAt > 10000)) { reloadToken = ''; reloadObserved = false; reloadFilled = false; }
    reloadWasActive = nativeReloading;
    return reconcile(state, nativeReloading);
  }
  return { tick, reset, ready: () => initialized,
    predictShot(weapon) { const id = ++nextPrediction; pending.set(id, { weapon }); return id; },
    cancelPrediction(id) { pending.delete(id); completed.add(id); } };
};
