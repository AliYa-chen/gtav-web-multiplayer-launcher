'use strict';
// Called only from the verified active scrThread callback. Cameras belong to
// their creating script handler; deferred cleanup must return to that handler.
self.createOnlineEntryCamera = function ({ ex, memory, random = Math.random }) {
  const REQUIRED = ['mpAlloc', 'mpFree', 'mpGetCurrentHandler', 'mpCreateCam', 'mpDestroyCam',
    'mpDoesCamExist', 'mpSetCamActive', 'mpIsCamActive', 'mpIsCamRendering', 'mpGetRenderingCam',
    'mpSetCamCoord', 'mpSetCamRot', 'mpSetCamFov', 'mpRenderScriptCams'];
  const supported = REQUIRED.every((name) => typeof ex[name] === 'function');
  const SKY_LIMIT_MS = 12000, SKY_HOLD_MIN_MS = 5000, SKY_HOLD_MAX_MS = 10000;
  const CLOUD_SETTLE_MS = 900, ACTIVATION_LIMIT_MS = 2000, BUFFER_BYTES = 128;
  // Original playerswitch.meta LONG uses a 1190 m ceiling and 1-3 jumps;
  // MEDIUM uses 600 m. Only the ceiling/reference rhythm is reused here.
  // These owned-camera timings/waypoints do not run CPlayerSwitchMgrLong,
  // which also changes streaming/population and is unsafe for public entities.
  const SWITCH_CEILING = 1190;
  // CPlayerSwitchMgrLong::SetState uses the original Hit_2 cue for descent.
  // The verified frontend function selects its initialized long-switch set.
  const DESCENT_SOUND_HASH = 1706549474;
  const DESCENT_STAGES = Object.freeze([
    Object.freeze({ name: 'high', duration: 950, hold: 150 }),
    Object.freeze({ name: 'mid', duration: 900, hold: 150 }),
    Object.freeze({ name: 'close', duration: 1150, hold: 0 }),
  ]);
  const DESCENT_MS = DESCENT_STAGES.reduce((total, stage) => total + stage.duration + stage.hold, 0);
  // Read-only layout audited against the original engine SHA-256
  // 11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0.
  // The launcher rejects every unverified engine version before this runs.
  const CLOUD_LAYOUT = Object.freeze({ managerSlot: 28411080, managerBytes: 1864,
    itemsOffset: 40, countOffset: 48, scriptIndexOffset: 1860, itemBytes: 512,
    nameOffset: 64, nameBytes: 64, maximumCount: 64 });
  const validPosition = (value) => Array.isArray(value) && value.length === 3
    && value.every((part) => Number.isFinite(part) && Math.abs(part) <= 16000);
  let attempt = null, epoch = null, phase = 'idle', reason = null, done = false, disposed = false;
  let handle = null, owner = null, buffer = 0, rendered = false, cleanupPending = false;
  let anchor = null, heading = 0, sky = null, destination = null;
  let cameraStage = null, descentPoses = null, soundedStages = 0, soundCues = 0, soundReason = null;
  let requestedAt = 0, startedAt = 0, skyHoldMs = null, descentAt = null, lastFrameAt = -Infinity, lastCleanupAt = -Infinity;
  let cloudOwner = null, cloudAttempted = false, cloudAllowed = false;
  let cloudReason = null, cloudAlpha = null, cloudRequestedAt = null;
  let clock = 0;

  function status() {
    return { attempt_id: attempt, phase, camera_active: rendered, done, reason,
      cleanup_pending: cleanupPending, camera_stage: cameraStage, cloud_active: cloudOwner !== null,
      cloud_owned: cloudOwner !== null, cloud_alpha: cloudAlpha, cloud_reason: cloudReason,
      sound_cues: soundCues, sound_reason: soundReason };
  }
  function currentHandler() {
    try {
      const value = ex.mpGetCurrentHandler?.();
      return typeof value === 'bigint' && value > 0n ? value : null;
    } catch { return null; }
  }
  function ownsContext() { return owner !== null && currentHandler() === owner; }
  function vector(offset, values) {
    const view = new DataView(memory.buffer);
    values.forEach((value, index) => view.setFloat32(buffer + offset + 8 * index, value, true));
    return BigInt(buffer + offset);
  }
  function readVector(offset) {
    const view = new DataView(memory.buffer);
    return [0, 8, 16].map((part) => view.getFloat32(buffer + offset + part, true));
  }
  function cloudState() {
    const bytes = memory.buffer.byteLength, layout = CLOUD_LAYOUT;
    const fits = (pointer, length) => Number.isSafeInteger(pointer) && pointer > 0
      && Number.isSafeInteger(length) && length > 0 && pointer <= bytes - length;
    if (!fits(layout.managerSlot, 8)) return null;
    const view = new DataView(memory.buffer);
    const manager = Number(view.getBigUint64(layout.managerSlot, true));
    if (!fits(manager, layout.managerBytes)) return null;
    const count = view.getUint16(manager + layout.countOffset, true);
    const items = Number(view.getBigUint64(manager + layout.itemsOffset, true));
    if (count < 1 || count > layout.maximumCount || !fits(items, count * layout.itemBytes)) return null;
    const index = view.getInt32(manager + layout.scriptIndexOffset, true);
    if (index < -1 || index >= count) return null;
    return { manager, items, count, index };
  }
  function sameCloudOwner(value) {
    return value && cloudOwner && value.manager === cloudOwner.manager
      && value.items === cloudOwner.items && value.count === cloudOwner.count && value.index === cloudOwner.index;
  }
  function observeCloud() {
    if (!cloudOwner) return true;
    if (!cloudAllowed || !sameCloudOwner(cloudState())) {
      cloudReason = cloudAllowed ? 'ownership_changed' : 'isolation_lost';
      cloudOwner = null; cloudAlpha = null;
      return false;
    }
    if (typeof ex.mpGetCloudHatAlpha === 'function') {
      try {
        const alpha = ex.mpGetCloudHatAlpha();
        cloudAlpha = Number.isFinite(alpha) ? alpha : null;
      } catch { cloudAlpha = null; } // Optional diagnostics cannot prevent owned cleanup.
    }
    return true;
  }
  function requestCloud(now) {
    if (cloudAttempted) return;
    if (!cloudAllowed) { cloudReason = 'waiting_for_isolation'; return; }
    cloudAttempted = true;
    if (typeof ex.mpLoadCloudHat !== 'function' || typeof ex.mpUnloadCloudHat !== 'function') {
      cloudReason = 'unsupported'; return;
    }
    const state = cloudState();
    if (!state) { cloudReason = 'manager_unavailable'; return; }
    if (state.index !== -1) { cloudReason = 'preexisting_override'; return; }
    let target = -1;
    for (let index = 0; index < state.count; index++) {
      const bytes = new Uint8Array(memory.buffer, state.items + index * CLOUD_LAYOUT.itemBytes
        + CLOUD_LAYOUT.nameOffset, CLOUD_LAYOUT.nameBytes);
      const end = bytes.indexOf(0);
      if (end < 0) { cloudReason = 'invalid_metadata'; return; }
      const name = String.fromCharCode(...bytes.subarray(0, end));
      if (name.toLowerCase() === 'cloudy 01') {
        // The native matches case-insensitively. Ambiguous metadata could load
        // a different index from the token we are permitted to restore.
        if (name !== 'Cloudy 01' || target !== -1) { cloudReason = 'invalid_metadata'; return; }
        target = index;
      }
    }
    if (target < 0) { cloudReason = 'cloud_unavailable'; return; }
    const bytes = new Uint8Array(memory.buffer, buffer + 96, 32); bytes.fill(0);
    bytes.set(new TextEncoder().encode('Cloudy 01'));
    // Set the expected token before invoking a native that may trap after
    // mutating the global override. Cleanup still checks the actual index.
    cloudOwner = { ...state, index: target };
    ex.mpLoadCloudHat(BigInt(buffer + 96), 0.6);
    if (!sameCloudOwner(cloudState())) {
      cloudOwner = null; cloudReason = 'load_unconfirmed'; return;
    }
    cloudRequestedAt = now; cloudReason = 'native_override'; observeCloud();
  }
  function releaseCloud() {
    if (!cloudOwner) return;
    observeCloud();
    if (!cloudOwner) return;
    // UnloadCloudHat does not check which script owns the global override.
    // Only our isolated handler and unchanged read-only token permit this call.
    ex.mpUnloadCloudHat(BigInt(buffer + 96), 0.6);
    const after = cloudState();
    if (sameCloudOwner(after)) throw new Error('cloud release pending');
    cloudOwner = null; cloudAlpha = null;
    cloudReason = after?.index === -1 ? 'weather_restored' : 'ownership_changed';
  }
  function finish(nextReason, success = false) {
    phase = success ? 'complete' : 'fallback'; reason = nextReason; done = true;
    if (success) cameraStage = 'complete';
    cleanupPending = handle !== null || buffer !== 0 || cloudOwner !== null;
  }
  function cleanup(now) {
    if (!cleanupPending) return true;
    if (!ownsContext() || now - lastCleanupAt < 250) return false;
    lastCleanupAt = now;
    try {
      releaseCloud();
      if (handle !== null) {
        if (ex.mpDoesCamExist(handle)) {
          // Rendering is global. Never stop a camera that another script has
          // taken over, and never use DestroyCam's cross-handler flag.
          if (ex.mpGetRenderingCam() === handle) ex.mpRenderScriptCams(0, 0, 0, 0, 0, 0);
          rendered = false;
          ex.mpSetCamActive(handle, 0);
          ex.mpDestroyCam(handle, 0);
          if (ex.mpDoesCamExist(handle)) return false;
        }
        handle = null; rendered = false;
      }
      if (buffer) { ex.mpFree(BigInt(buffer)); buffer = 0; }
      owner = null; cleanupPending = false;
      return true;
    } catch {
      // Preserve the handle for a later owner callback. A visual failure must
      // not escape into the engine's script-context teardown path.
      reason = reason || 'cleanup_retry';
      return false;
    }
  }
  function begin(input) {
    attempt = input.attempt_id; epoch = input.world_epoch ?? null;
    phase = 'waiting'; reason = null; done = false;
    anchor = sky = destination = null; skyHoldMs = null; descentAt = null;
    cameraStage = null; descentPoses = null; soundedStages = 0; soundCues = 0; soundReason = null;
    cloudOwner = null; cloudAttempted = false; cloudReason = null; cloudAlpha = null; cloudRequestedAt = null;
    lastFrameAt = lastCleanupAt = -Infinity;
  }
  function pose(distance, height) {
    const radians = heading * Math.PI / 180;
    return { position: [anchor[0] + Math.sin(radians) * distance,
      anchor[1] - Math.cos(radians) * distance, anchor[2] + height],
    rotation: [-Math.atan2(height - 1, distance) * 180 / Math.PI, 0, heading], fov: 55 };
  }
  function apply(value) {
    ex.mpSetCamCoord(handle, vector(32, value.position));
    ex.mpSetCamRot(handle, vector(64, value.rotation), 2);
    ex.mpSetCamFov(handle, value.fov);
  }
  function interpolate(from, to, progress) {
    const ease = progress * progress * (3 - 2 * progress);
    const shortestAngle = (start, end) => ((end - start + 540) % 360 + 360) % 360 - 180;
    return { position: from.position.map((value, index) => value + (to.position[index] - value) * ease),
      rotation: from.rotation.map((value, index) => value + shortestAngle(value, to.rotation[index]) * ease),
      fov: from.fov + (to.fov - from.fov) * ease };
  }
  function playDescentSound(index) {
    const bit = 1 << index;
    if (soundedStages & bit) return;
    // Mark before invoking native code: a trap or a readiness reset must not
    // replay the same stage. No IDs/loops are created by the finite native cue.
    soundedStages |= bit;
    if (typeof ex.mpPlayLongSwitchSound !== 'function') { soundReason = 'unsupported'; return; }
    try {
      new DataView(memory.buffer).setUint32(buffer + 24, DESCENT_SOUND_HASH, true);
      ex.mpPlayLongSwitchSound(BigInt(buffer + 24), 0);
      soundCues++; soundReason = 'native_cue';
    } catch { soundReason = 'native_failure'; } // Optional audio cannot strand the camera.
  }
  function applyDescent(elapsed) {
    let remaining = Math.max(0, elapsed);
    for (let index = 0; index < DESCENT_STAGES.length; index++) {
      const stage = DESCENT_STAGES[index], total = stage.duration + stage.hold;
      if (remaining < total || index === DESCENT_STAGES.length - 1) {
        cameraStage = stage.name;
        apply(interpolate(descentPoses[index], descentPoses[index + 1], Math.min(1, remaining / stage.duration)));
        // A delayed frame skips missed cues instead of playing a catch-up burst.
        if (elapsed < DESCENT_MS) playDescentSound(index);
        return elapsed >= DESCENT_MS;
      }
      remaining -= total;
    }
    return false;
  }
  function gameplayDestination() {
    const fallback = pose(4.5, 2.2);
    if (!ex.mpCamCoords || !ex.mpCamRot) return fallback;
    ex.mpCamCoords(BigInt(buffer + 32)); ex.mpCamRot(BigInt(buffer + 64), 2);
    const position = readVector(32), rotation = readVector(64);
    const fov = ex.mpCamFov ? ex.mpCamFov() : fallback.fov;
    // A gameplay camera still following the previous single-player character
    // is unsuitable as the online landing target.
    if (!validPosition(position) || !rotation.every(Number.isFinite)
        || Math.hypot(...position.map((value, index) => value - anchor[index])) > 30
        || !Number.isFinite(fov) || fov < 10 || fov > 120) return fallback;
    return { position, rotation, fov };
  }
  function start(input, now) {
    const context = currentHandler();
    if (context === null) return;
    const existing = ex.mpGetRenderingCam();
    if (Number.isInteger(existing) && existing >= 0 && ex.mpDoesCamExist(existing)) {
      finish('camera_busy'); return;
    }
    owner = context;
    const pointer = ex.mpAlloc(BigInt(BUFFER_BYTES));
    buffer = Number(pointer);
    if (!Number.isSafeInteger(buffer) || buffer <= 0 || buffer + BUFFER_BYTES > memory.buffer.byteLength) {
      // A failed allocation must never become an arbitrary memory write.
      buffer = 0; owner = null; finish('allocation_failed'); return;
    }
    const bytes = new Uint8Array(memory.buffer, buffer, BUFFER_BYTES); bytes.fill(0);
    bytes.set(new TextEncoder().encode('DEFAULT_SCRIPTED_CAMERA'));
    const camera = ex.mpCreateCam(BigInt(buffer), 0);
    // Zero is a valid script GUID in this engine build.
    if (!Number.isInteger(camera) || camera < 0) {
      finish('camera_unavailable'); cleanup(now); return;
    }
    handle = camera;
    if (!ex.mpDoesCamExist(handle)) { finish('camera_unavailable'); cleanup(now); return; }
    anchor = [...input.position]; heading = Number.isFinite(input.heading) ? input.heading % 360 : 0;
    // Cloudy 01 contains the engine's original 600/800/900 m altitude layers.
    // Keep streaming focus on the ground player; never move its collision focus.
    sky = pose(180, Math.max(120, SWITCH_CEILING - anchor[2])); sky.fov = 60;
    apply(sky);
    ex.mpSetCamActive(handle, 1);
    // If a native traps after changing the global view, retain a conservative
    // active state until owner-scoped cleanup verifies it is released.
    rendered = true;
    ex.mpRenderScriptCams(1, 0, 0, 0, 0, 0);
    // Rendering queries observe the camera manager's completed update. The
    // director request above may take another game frame to become dominant.
    rendered = false; requestedAt = now; startedAt = now; phase = 'activating'; cameraStage = 'cloud';
  }
  function tick(input = {}) {
    const suppliedTime = Number(input.now);
    if (Number.isFinite(suppliedTime)) clock = Math.max(clock, suppliedTime);
    const now = clock;
    cloudAllowed = input.cloud_control_allowed === true;
    const identityChanged = input.attempt_id !== attempt || (input.world_epoch ?? null) !== epoch;
    if (identityChanged && (handle !== null || buffer)) finish('attempt_changed');
    if (input.connected !== true && !done) finish('disconnected');
    if (disposed && !done) finish('disposed');
    if (cleanupPending && !cleanup(now)) return status();
    if (disposed) return status();
    if (identityChanged) begin(input);
    if (input.attempt_id === undefined || input.attempt_id === null || input.connected !== true) {
      if (!done) finish(input.connected === true ? 'no_attempt' : 'disconnected');
      return status();
    }
    if (done) return status();
    if (input.reduced_motion === true) { finish('reduced_motion'); cleanup(now); return status(); }
    if (!supported) { finish('unsupported'); return status(); }
    if (handle !== null && (input.engine_ready !== true || input.world_ready !== true)) {
      finish('world_unavailable'); cleanup(now); return status();
    }
    try {
      if (handle === null) {
        if (input.can_start === false || input.engine_ready !== true || input.world_ready !== true
            || !Number.isInteger(input.ped) || input.ped <= 0 || !validPosition(input.position)) return status();
        start(input, now);
        if (handle === null || done) return status();
      }
      if (!ownsContext()) {
        if (now - startedAt >= SKY_LIMIT_MS + DESCENT_MS) finish('context_unavailable');
        return status();
      }
      const renderingCamera = ex.mpGetRenderingCam();
      if (!ex.mpDoesCamExist(handle) || !ex.mpIsCamActive(handle)) {
        finish('camera_interrupted'); cleanup(now); return status();
      }
      if (phase === 'activating') {
        if (renderingCamera === handle && ex.mpIsCamRendering(handle)) {
          rendered = true; startedAt = now; phase = 'sky'; lastFrameAt = now;
          // Start one sampled hold only after the native camera is confirmed
          // rendering. Readiness changes never resample or restart this clock.
          const sample = random();
          const fraction = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
          skyHoldMs = SKY_HOLD_MIN_MS + fraction * (SKY_HOLD_MAX_MS - SKY_HOLD_MIN_MS);
        } else {
          // A different script camera taking over must still be preserved.
          if (Number.isInteger(renderingCamera) && renderingCamera >= 0 && renderingCamera !== handle)
            finish('camera_interrupted');
          else if (now - requestedAt >= ACTIVATION_LIMIT_MS) finish('activation_timeout');
          cleanup(now); return status();
        }
      } else if (renderingCamera !== handle || !ex.mpIsCamRendering(handle)) {
        finish('camera_interrupted'); cleanup(now); return status();
      }
      if (!observeCloud()) { finish('cloud_interrupted'); cleanup(now); return status(); }
      requestCloud(now);
      const ready = input.character_ready === true && input.collision_ready === true;
      if (!ready && now - startedAt >= SKY_LIMIT_MS) {
        finish('readiness_timeout'); cleanup(now); return status();
      }
      if (!ready && descentAt !== null) {
        // A model/ground readiness loss must not land the view on an invalid
        // player. Keep the total camera lifetime bounded across retries.
        descentAt = null; descentPoses = null; phase = 'sky'; cameraStage = 'cloud'; apply(sky);
      }
      if (ready && descentAt === null && now - startedAt >= skyHoldMs
          && (cloudRequestedAt === null || now - cloudRequestedAt >= CLOUD_SETTLE_MS)) {
        destination = gameplayDestination(); descentAt = now; phase = 'descent'; cameraStage = 'high';
        const highHeight = Math.min(300, (sky.position[2] - anchor[2]) * .55);
        const midHeight = Math.min(80, highHeight * .4);
        const high = pose(Math.min(75, highHeight / 4), highHeight);
        const mid = pose(Math.min(18, midHeight / 4), midHeight);
        high.fov = 50; mid.fov = 45;
        descentPoses = [sky, high, mid, destination];
      }
      if (descentAt !== null && now - lastFrameAt >= 16) {
        const complete = applyDescent(now - descentAt);
        lastFrameAt = now;
        if (complete) { finish(null, true); cleanup(now); }
      }
      if (!done && now - startedAt >= SKY_LIMIT_MS + DESCENT_MS) { finish('camera_timeout'); cleanup(now); }
    } catch { finish('native_failure'); cleanup(now); }
    return status();
  }
  function cancel() {
    finish('cancelled');
    return status();
  }
  function dispose(input = {}) {
    disposed = true; finish('disposed');
    return tick(input);
  }
  return { tick, cancel, dispose, status };
};
