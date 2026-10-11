'use strict';
// Presentation uses only accepted state. Native tasks may animate a replica but
// never authorize movement, damage, equipment or attachments. All calls run on
// the bridge's established script owner. See docs/character-actions.md for ABI.
self.createCharacterActionBridge = function ({ ex, memory }) {
  let scratch = 0;
  const finite = (value, minimum, maximum, fallback = 0) => Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value)) : fallback;
  const flag = (name, ped, ...args) => Boolean(ex[name]?.(ped, ...args));
  function storage() {
    if (!scratch) scratch = address(ex.mpAlloc(512n), 512);
    if (!scratch || !address(scratch, 512)) throw new Error('Character action buffer allocation failed');
    return new DataView(memory.buffer);
  }
  function vector(position) {
    const data = storage();
    position.forEach((value, index) => data.setFloat32(scratch + 16 + 8 * index, value, true));
    return BigInt(scratch + 16);
  }
  function sample(ped, aiming = false) {
    let x = 0, y = 0, hasBlend = false;
    if (ex.mpGetMoveBlend) {
      storage();
      if (ex.mpGetMoveBlend(ped, BigInt(scratch), BigInt(scratch + 4))) {
        const data = new DataView(memory.buffer);
        x = finite(data.getFloat32(scratch, true), -3, 3);
        y = finite(data.getFloat32(scratch + 4, true), -3, 3);
        hasBlend = true;
      }
    }
    const inCover = flag('mpIsInCover', ped, 0), tree = motionNodes(ped), ladder = sampleLadder(ped);
    const phases = samplePhases(tree), blends = sampleBlends(tree);
    return {
      aiming: Boolean(aiming), reloading: flag('mpIsReloading', ped),
      jumping: flag('mpIsJumping', ped), ducking: flag('mpIsDucking', ped),
      sprinting: flag('mpIsSprinting', ped), falling: flag('mpIsFalling', ped),
      climbing: flag('mpIsClimbing', ped),
      climbing_ladder: flag('mpGetTaskActive', ped, 1) || flag('mpGetTaskActive', ped, 47), vaulting: flag('mpIsVaulting', ped),
      swimming: flag('mpIsSwimming', ped), underwater: flag('mpIsUnderwater', ped),
      ragdoll: flag('mpIsRagdoll', ped), rolling: flag('mpGetTaskActive', ped, 3),
      in_cover: inCover, cover_left: inCover && flag('mpIsCoverLeft', ped),
      cover_high: inCover && flag('mpIsHighCover', ped),
      cover_aiming: inCover && flag('mpIsAimingFromCover', ped),
      going_into_cover: flag('mpIsGoingIntoCover', ped), strafing: flag('mpIsStrafing', ped),
      // The native desired getter returns only Y (negative for backwards).
      // Current XY magnitude preserves strafing and reverse locomotion speed.
      move_blend: finite(hasBlend ? Math.hypot(x, y) : Math.abs(ex.mpGetDesiredMoveBlend?.(ped)), 0, 3), move_x: x, move_y: y,
      ...(ladder ? { ladder } : {}),
      ...(phases.length ? { animation_phases: phases } : {}),
      ...(blends.length ? { animation_blends: blends } : {}),
    };
  }
  function phaseSupported() {
    return ['mpGetEntityAddress', 'mpExists', 'mpIsPed', 'mpGetAnimationPhase', 'mpSetAnimationPhase',
      'mpGetAnimationRate', 'mpSetAnimationRate', 'mpGetClipPhase', 'mpSetClipPhase',
      'mpGetClipRate', 'mpSetClipRate'].every(name => typeof ex[name] === 'function');
  }
  function phasePrefix(kind) {
    return kind === 4 ? 'Animation' : kind === 15 ? 'Clip' : kind === 17 ? 'Parameterized' : null;
  }
  function phaseKindSupported(kind) {
    const prefix = phasePrefix(kind);
    return prefix && ['Get', 'Set'].every(operation => ['Phase', 'Rate'].every(value =>
      typeof ex['mp' + operation + prefix + value] === 'function'));
  }
  function residentName(view, pointer) {
    const start = address(pointer, 1);
    if (!start) return null;
    let result = '';
    for (let i = 0; i <= 160 && start + i < view.byteLength; i++) {
      const code = view.getUint8(start + i);
      if (!code) return result || null;
      if (code < 32 || code > 126 || i === 160) return null;
      result += String.fromCharCode(code);
    }
    return null;
  }
  function motionNodes(ped) {
    if (!phaseSupported() || !ex.mpExists(ped) || !ex.mpIsPed(ped)) return [];
    const base = address(ex.mpGetEntityAddress(ped), 88);
    if (!base) return [];
    const view = new DataView(memory.buffer);
    const ptr = (at, bytes) => address(at, 8) ? address(view.getBigUint64(at, true), bytes) : 0;
    const drawable = ptr(base + 80, 72), director = drawable && ptr(drawable + 64, 256);
    // Original GetComponentByType maps the move component's runtime type to
    // its first active phase slot. This is the same root used by DumpNetwork.
    if (!director || !address(10868688, 4)) return [];
    const type = view.getUint32(10868688, true), count = view.getUint32(director + 168, true);
    if (type < 1 || type > 7 || count < 1 || count > 12) return [];
    let index = 12;
    for (let phase = 0; phase < 4 && index === 12; phase++) index = view.getUint8(director + 228 + (type - 1) * 4 + phase);
    if (index >= count) return [];
    const component = ptr(director + 72 + index * 8, 40);
    const move = component && ptr(component + 32, 512), tree = move && ptr(move + 504, 736);
    const root = tree && ptr(tree + 728, 64);
    if (!root) return [];
    const todo = [root], seen = new Set(), result = [];
    while (todo.length) {
      const node = todo.pop();
      // Cycles, oversized or partially invalid graphs are not safe snapshots.
      if (!node || seen.has(node) || seen.size >= 256) return [];
      seen.add(node);
      for (const offset of [16, 24]) {
        const raw = view.getBigUint64(node + offset, true);
        if (raw) {
          const child = address(raw, 64);
          if (!child) return [];
          todo.push(child);
        }
      }
      const kind = view.getUint8(node + 13);
      const entry = { node, kind, first: ptr(node + 16, 64), next: ptr(node + 24, 64), name: null };
      result.push(entry);
      if (!phaseKindSupported(kind)) continue;
      if (!address(node, kind === 4 ? 144 : kind === 15 ? 264 : 80)) return [];
      let asset = ptr(node + (kind === 4 ? 88 : 64), 64);
      if (!asset) continue;
      const motion = kind === 17 ? asset : 0;
      // The PM player owns its resident motion. The original Dump resolves
      // that motion's nonempty name through +16, then string +24/count +32.
      if (kind === 17) {
        asset = ptr(asset + 16, 40);
        if (!asset || !view.getUint16(asset + 32, true)) continue;
      }
      const name = residentName(view, view.getBigUint64(asset + (kind === 4 ? 32 : 24), true));
      if (name) Object.assign(entry, { name, motion, key: kind + ':' + name });
    }
    return result;
  }
  function phaseNodes(nodes) {
    const named = nodes.filter(node => node.name);
    const counts = new Map();
    for (const node of named) counts.set(node.key, (counts.get(node.key) || 0) + 1);
    // Equal clip names on several layers are ambiguous; never guess a layer.
    return named.filter(node => counts.get(node.key) === 1);
  }
  function readNodeValue(node, value) {
    storage();
    const prefix = phasePrefix(node.kind);
    ex['mpGet' + prefix + value](BigInt(scratch), BigInt(node.node), 0);
    return new DataView(memory.buffer).getFloat32(scratch, true);
  }
  function parameterCount(node) {
    if (node.kind !== 17 || !['mpGetParameterizedDimensions', 'mpGetParameterizedValue',
      'mpSetParameterizedValue'].every(name => typeof ex[name] === 'function')) return 0;
    const count = ex.mpGetParameterizedDimensions(BigInt(node.motion));
    return Number.isInteger(count) && count > 0 && count <= 16 ? count : 0;
  }
  function sampleParameters(node) {
    const count = parameterCount(node);
    if (!count) return null;
    storage();
    const parameters = [];
    for (let dimension = 0; dimension < count; dimension++) {
      ex.mpGetParameterizedValue(BigInt(scratch), BigInt(node.node), dimension);
      const value = new DataView(memory.buffer).getFloat32(scratch, true);
      if (!Number.isFinite(value) || Math.abs(value) > 65536) return null;
      parameters.push(value);
    }
    return parameters;
  }
  function samplePhases(nodes) {
    return phaseNodes(nodes).slice(0, 32).flatMap(node => {
      const phase = readNodeValue(node, 'Phase'), rate = readNodeValue(node, 'Rate');
      const parameters = sampleParameters(node);
      return Number.isFinite(phase) && phase >= 0 && phase <= 1 && Number.isFinite(rate) && Math.abs(rate) <= 16
        ? [{ kind: node.kind, name: node.name, phase, rate, ...(parameters ? { parameters } : {}) }] : [];
    });
  }
  function applyPhaseEntries(replica, state) {
    const phases = state.actions?.animation_phases, ped = replica.ped ?? replica.handle;
    if (!Array.isArray(phases) || !phases.length) { replica.characterPhases = null; return false; }
    if (!phaseSupported() || phases.length > 32 || state.alive === false || state.health <= 0
      || state.attachment || ex.mpIsDead?.(ped, 0)) return false;
    const incoming = new Map();
    for (const entry of phases) {
      if (!entry || ![4, 15, 17].includes(entry.kind) || typeof entry.name !== 'string'
        || !/^[\x20-\x7e]{1,160}$/.test(entry.name) || !Number.isFinite(entry.phase) || entry.phase < 0 || entry.phase > 1
        || (entry.rate !== undefined && (!Number.isFinite(entry.rate) || Math.abs(entry.rate) > 16))
        || (entry.parameters !== undefined && (entry.kind !== 17 || !Array.isArray(entry.parameters)
          || entry.parameters.length < 1 || entry.parameters.length > 16
          || entry.parameters.some(value => !Number.isFinite(value) || Math.abs(value) > 65536)))) return false;
      const key = entry.kind + ':' + entry.name;
      if (incoming.has(key)) return false;
      incoming.set(key, entry);
    }
    // Object identity is not stable across shared packets. Compare accepted
    // values instead; never rewind on each render of the same older snapshot.
    const signature = JSON.stringify(phases);
    const now = typeof performance === 'undefined' ? Date.now() : performance.now();
    if (replica.characterPhases?.signature !== signature || replica.characterPhases.ped !== ped) {
      replica.characterPhases = { signature, ped, at: now, applied: new Set() };
    }
    // A missing node gets a short chance to stream/start, never an unbounded
    // invitation to apply stale phase data to a future unrelated task.
    if (now - replica.characterPhases.at > 500) return false;
    const applied = replica.characterPhases.applied;
    if (applied.size === incoming.size) return false;
    let changed = false;
    for (const node of phaseNodes(motionNodes(ped))) {
      const entry = incoming.get(node.key);
      if (!entry || applied.has(node.key)) continue;
      if (entry.parameters && entry.parameters.length !== parameterCount(node)) continue;
      storage();
      const prefix = phasePrefix(node.kind);
      if (entry.parameters) {
        for (let dimension = 0; dimension < entry.parameters.length; dimension++) {
          new DataView(memory.buffer).setFloat32(scratch, entry.parameters[dimension], true);
          // Native SetParameter retains its own parameter limits and blending.
          ex.mpSetParameterizedValue(BigInt(node.node), BigInt(scratch), dimension);
        }
      }
      new DataView(memory.buffer).setFloat32(scratch, entry.phase, true);
      ex['mpSet' + prefix + 'Phase'](BigInt(node.node), BigInt(scratch), 0);
      if (entry.rate !== undefined) {
        new DataView(memory.buffer).setFloat32(scratch, entry.rate, true);
        ex['mpSet' + prefix + 'Rate'](BigInt(node.node), BigInt(scratch), 0);
      }
      applied.add(node.key); changed = true;
    }
    return changed;
  }
  function blendSupported() {
    return ['mpSetBlendWeight', 'mpSetAdditiveBlendWeight', 'mpGetBlendNodeWeight',
      'mpSetBlendNodeWeight', 'mpGetBlendFilterName'].every(name => typeof ex[name] === 'function');
  }
  function blendNodes(nodes) {
    if (!blendSupported()) return [];
    const byAddress = new Map(nodes.map(node => [node.node, node])), memo = new Map(), filters = new Map();
    const view = () => new DataView(memory.buffer);
    function filterName(at) {
      const raw = view().getBigUint64(at, true);
      if (!raw) return '';
      const pointer = address(raw, 16);
      if (!pointer) return null;
      if (!filters.has(pointer)) {
        const name = ex.mpGetBlendFilterName(BigInt(pointer));
        filters.set(pointer, residentName(view(), name));
      }
      return filters.get(pointer);
    }
    function identify(node, depth = 0) {
      if (!node || depth > 32) return null;
      if (memo.has(node.node)) return memo.get(node.node);
      memo.set(node.node, null);
      if (node.name && !node.first) {
        const identity = [node.kind, node.name]; memo.set(node.node, identity); return identity;
      }
      const pair = node.kind === 5 || node.kind === 6;
      if (!pair && node.kind !== 13 && node.kind !== 22) return null;
      if (!address(node.node, pair ? 112 : 208)) return null;
      // A custom weight modifier has additional semantics not represented by
      // one scalar weight. Never silently treat it as an ordinary blend.
      if (pair && view().getBigUint64(node.node + 104, true)) return null;
      const children = [];
      for (let child = byAddress.get(node.first); child; child = byAddress.get(child.next)) {
        if (children.length >= 8) return null;
        const identity = identify(child, depth + 1);
        if (!identity) return null;
        children.push(identity);
      }
      if (pair ? children.length !== 2 : !children.length || children.length !== view().getUint32(node.node + 204, true)) return null;
      const filter = filterName(node.node + (pair ? 80 : 192));
      if (filter === null) return null;
      const inputFilters = [];
      if (!pair) {
        for (let index = 0; index < children.length; index++) {
          const name = filterName(node.node + 72 + 16 * index);
          if (name === null) return null;
          inputFilters.push(name);
        }
      }
      const identity = [node.kind, filter, view().getUint8(node.node + (pair ? 92 : 200)), inputFilters, children];
      const key = JSON.stringify(identity);
      if (key.length > 1024) return null;
      node.blend = { key, pair, count: pair ? 1 : children.length };
      memo.set(node.node, identity); return identity;
    }
    for (const node of nodes) identify(node);
    const candidates = nodes.filter(node => node.blend), counts = new Map();
    for (const node of candidates) counts.set(node.blend.key, (counts.get(node.blend.key) || 0) + 1);
    return candidates.filter(node => counts.get(node.blend.key) === 1);
  }
  function validBlend(entry) {
    if (!entry || ![5, 6, 13, 22].includes(entry.kind) || typeof entry.key !== 'string'
      || !/^[\x20-\x7e]{1,1024}$/.test(entry.key) || !Array.isArray(entry.weights)
      || entry.weights.length < 1 || entry.weights.length > 8
      || ((entry.kind === 5 || entry.kind === 6) && entry.weights.length !== 1)
      || entry.weights.some(weight => !Number.isFinite(weight) || weight < -16 || weight > 16
        || ((entry.kind === 5 || entry.kind === 13) && (weight < 0 || weight > 1)))
      || (entry.rate !== undefined && (![5, 6].includes(entry.kind) || !Number.isFinite(entry.rate) || Math.abs(entry.rate) > 16))) return false;
    return true;
  }
  function sampleBlends(nodes) {
    return blendNodes(nodes).slice(0, 16).flatMap(node => {
      const data = new DataView(memory.buffer), { key, pair, count } = node.blend;
      const weights = pair ? [data.getFloat32(node.node + 96, true)] : Array.from({ length: count }, (_, index) =>
        ex.mpGetBlendNodeWeight(BigInt(node.node), index));
      const entry = { kind: node.kind, key, weights, ...(pair ? { rate: data.getFloat32(node.node + 100, true) } : {}) };
      return validBlend(entry) ? [entry] : [];
    });
  }
  function applyBlends(replica, state) {
    const blends = state.actions?.animation_blends, ped = replica.ped ?? replica.handle;
    if (!Array.isArray(blends) || !blends.length) { replica.characterBlends = null; return false; }
    if (!blendSupported() || blends.length > 16 || state.alive === false || state.health <= 0
      || state.attachment || ex.mpIsDead?.(ped, 0)) return false;
    const incoming = new Map();
    for (const entry of blends) {
      if (!validBlend(entry) || incoming.has(entry.key)) return false;
      incoming.set(entry.key, entry);
    }
    const signature = JSON.stringify(blends), now = typeof performance === 'undefined' ? Date.now() : performance.now();
    if (replica.characterBlends?.signature !== signature || replica.characterBlends.ped !== ped) {
      replica.characterBlends = { signature, ped, at: now, applied: new Set() };
    }
    if (now - replica.characterBlends.at > 500) return false;
    if (replica.characterBlends.applied.size === incoming.size) return false;
    let changed = false;
    for (const node of blendNodes(motionNodes(ped))) {
      const entry = incoming.get(node.blend.key);
      if (!entry || entry.kind !== node.kind || entry.weights.length !== node.blend.count
        || replica.characterBlends.applied.has(node.blend.key)) continue;
      if (node.blend.pair) {
        ex[node.kind === 5 ? 'mpSetBlendWeight' : 'mpSetAdditiveBlendWeight'](BigInt(node.node), entry.weights[0]);
        if (entry.rate !== undefined) new DataView(memory.buffer).setFloat32(node.node + 100, entry.rate, true);
      } else {
        entry.weights.forEach((weight, index) => ex.mpSetBlendNodeWeight(BigInt(node.node), index, weight));
      }
      replica.characterBlends.applied.add(node.blend.key); changed = true;
    }
    return changed;
  }
  function applyPhases(replica, state) {
    const phases = applyPhaseEntries(replica, state);
    return applyBlends(replica, state) || phases;
  }
  function mode(actions) {
    if (actions.ragdoll) return 'ragdoll';
    if (actions.rolling) return 'rolling';
    if (actions.climbing_ladder) return 'ladder';
    if (actions.climbing || actions.vaulting) return 'climbing';
    if (actions.underwater) return 'underwater';
    if (actions.swimming) return 'swimming';
    if (actions.falling) return 'falling';
    if (actions.in_cover || actions.going_into_cover) return 'cover';
    return '';
  }
  function physical(actions) { return ['ragdoll', 'falling', 'climbing', 'ladder', 'swimming', 'underwater'].includes(mode(actions || {})); }
  function reset(replica) {
    replica.characterAction = null;
    replica.characterReload = null;
    replica.characterPhases = null;
    replica.characterBlends = null;
    replica.characterLadder = null;
  }
  function address(value, bytes) {
    const result = Number(value);
    return Number.isSafeInteger(result) && result > 0 && result + bytes <= memory.buffer.byteLength ? result : 0;
  }
  function secondary(ped) {
    if (!ex.mpExists(ped) || !ex.mpIsPed(ped) || ex.mpIsDead(ped, 0)) return null;
    const base = address(ex.mpGetEntityAddress(ped), 4328);
    if (!base) return null;
    const view = new DataView(memory.buffer);
    const intelligence = address(view.getBigUint64(base + 4320, true), 4068);
    if (!intelligence || view.getUint32(intelligence + 4064, true) <= 1) return null;
    const tree = address(view.getBigUint64(intelligence + 4040, true), 76);
    // SetTask must not mutate a tree while that tree is processing a task.
    if (!tree || view.getInt32(tree + 72, true) <= 0 || view.getInt32(tree + 20, true) !== -1) return null;
    const task = address(view.getBigUint64(tree + 32, true), 54);
    return { intelligence, task, type: task ? view.getUint16(task + 52, true) : -1 };
  }
  function applyReload(replica, state, { poseReady, animating = false, readyWeapon = true }) {
    if (!layeredReloadSupported()) return false;
    const ped = replica.ped ?? replica.handle, actions = state.actions || {}, actionMode = mode(actions);
    const allowed = poseReady && !animating && readyWeapon && !state.attachment && state.alive !== false
      && state.health > 0 && actions.reloading && !actions.jumping && (!actionMode || actionMode === 'cover');
    const old = replica.characterReload;
    if (old && (!allowed || old.weapon !== state.weapon || old.ped !== ped)) {
      const active = old.ped === ped ? secondary(ped) : null;
      if (active?.type === 301 && active.task === old.task) ex.mpClearSecondaryTask(ped);
      replica.characterReload = null;
    }
    // One start per accepted reload edge. A naturally completed native task
    // must not restart while its last server snapshot still says reloading.
    // Call reset() after any external ClearTasksImmediately/lifecycle rebuild.
    if (!allowed || replica.characterReload) return true;
    if (!secondary(ped)) return true;
    storage();
    // Copy() reads only these two fields before constructing its own complete
    // task in the native pool. The source is our 400-byte zeroed template.
    new Uint8Array(memory.buffer, scratch + 64, 400).fill(0);
    const view = new DataView(memory.buffer);
    view.setInt32(scratch + 64 + 328, 4, true); // scripted weapon controller
    view.setInt32(scratch + 64 + 388, actionMode === 'cover' ? 12 : 4, true);
    let task = ex.mpCreateReloadTask(BigInt(scratch + 64));
    if (!task) return true;
    try {
      const allocated = address(task, 400), active = secondary(ped);
      if (!allocated || new DataView(memory.buffer).getUint16(allocated + 52, true) !== 301) {
        throw new Error('Unsupported native reload task layout');
      }
      if (!active) return true;
      const owned = task; task = 0n;
      ex.mpAddSecondaryTask(BigInt(active.intelligence), owned);
      replica.characterReload = { ped, weapon: state.weapon, task: allocated };
      return true;
    } finally {
      if (task) ex.mpDeleteUnassignedReloadTask(task);
    }
  }
  function roll(ped, actions) {
    if (!ex.mpCreateCombatRollTask || !ex.mpGiveCharacterTask || !ex.mpDeleteUnassignedCombatRollTask
        || !ex.mpExists(ped) || ex.mpIsDead(ped, 0)) return false;
    storage();
    const name = new TextEncoder().encode('MP_COMBAT_ROLL\0');
    new Uint8Array(memory.buffer, scratch + 48, 16).set(name);
    let task = ex.mpCreateCombatRollTask(0n);
    if (!task) return false;
    try {
      // Only this just-allocated object is writable. No network field is ever
      // interpreted as an address. Copy() writes type=3 and sentinel angle at
      // offset 320; UpdateFSM consumes atan2(-moveX,moveY), in radians.
      const address = Number(task);
      if (!Number.isSafeInteger(address) || address <= 0 || address + 336 > memory.buffer.byteLength
          || new DataView(memory.buffer).getUint16(address + 52, true) !== 3) {
        throw new Error('Unsupported native combat-roll task layout');
      }
      const x = finite(actions.move_x, -3, 3), y = finite(actions.move_y, -3, 3);
      if (Math.hypot(x, y) > .1) new DataView(memory.buffer).setFloat32(address + 320, Math.atan2(-x, y), true);
      if (!ex.mpExists(ped) || ex.mpIsDead(ped, 0)) return false;
      const owned = task; task = 0n;
      // Ownership passes on entry: native rejection deletes the task and
      // successful event insertion clones it then releases the original. Never
      // free or retry this pointer if the native throws after accepting it.
      ex.mpGiveCharacterTask(ped, owned, 0, BigInt(scratch + 48));
      return true;
    } finally {
      if (task) ex.mpDeleteUnassignedCombatRollTask(task);
    }
  }
  function activeTask(ped, kind, bytes) {
    if (!ex.mpGetEntityAddress || !ex.mpExists?.(ped) || !ex.mpIsPed?.(ped) || ex.mpIsDead?.(ped, 0)) return null;
    const base = address(ex.mpGetEntityAddress(ped), 4904), data = new DataView(memory.buffer);
    const ptr = (at, size) => address(at, 8) ? address(data.getBigUint64(at, true), size) : 0;
    const intelligence = base && ptr(base + 4320, 6200);
    const tree = intelligence && data.getUint32(intelligence + 4064, true) > 0 && ptr(intelligence + 4032, 76);
    if (!tree || data.getInt32(tree + 20, true) !== -1) return null;
    const count = data.getUint32(tree + 72, true), active = data.getInt32(tree + 16, true);
    if (!count || count > 5 || active < 0 || active >= count) return null;
    let task = ptr(tree + 32 + active * 8, 64);
    const seen = new Set();
    while (task) {
      if (seen.has(task) || seen.size >= 64 || ptr(task + 16, 4904) !== base) return null;
      seen.add(task);
      if (data.getUint16(task + 52, true) === kind) {
        return address(task, bytes) ? { task, base, intelligence, state: data.getInt8(task + 54) } : null;
      }
      const raw = data.getBigUint64(task + 32, true);
      task = raw ? address(raw, 64) : 0;
      if (raw && !task) return null;
    }
    return null;
  }
  function coverTask(ped) {
    const native = activeTask(ped, 312, 624);
    if (!native) return null;
    const data = new DataView(memory.buffer), parent = address(data.getBigUint64(native.task + 24, true), 688);
    if (!parent || data.getUint16(parent + 52, true) !== 290
      || data.getBigUint64(parent + 16, true) !== BigInt(native.base)
      || !address(data.getBigUint64(native.base + 4896, true), 40)) return null;
    return { ...native, parent, child: address(data.getBigUint64(native.task + 32, true), 64) };
  }
  function validLadder(value) {
    return value && Number.isInteger(value.model) && value.model >= 0 && value.model <= 4294967295
      && Number.isInteger(value.effect) && value.effect >= 0 && value.effect <= 65535
      && Number.isInteger(value.type) && value.type >= 0 && value.type <= 2
      && Number.isInteger(value.state) && value.state >= 0 && value.state <= 15
      && Array.isArray(value.geometry) && value.geometry.length === 12
      && value.geometry.every((n, i) => Number.isFinite(n) && Math.abs(n) <= (i < 9 ? 2 : 16000))
      && Array.isArray(value.target) && value.target.length === 3
      && value.target.every(n => Number.isFinite(n) && Math.abs(n) <= 16000);
  }
  function ladderTask(ped) {
    const native = activeTask(ped, 1, 672);
    if (!native) return null;
    const data = new DataView(memory.buffer), geometry = address(data.getBigUint64(native.task + 592, true), 160);
    const model = geometry && address(data.getBigUint64(geometry + 32, true), 28);
    if (!model) return null;
    const value = { model: data.getUint32(model + 24, true),
      geometry: [0, 4, 8, 16, 20, 24, 32, 36, 40, 48, 52, 56].map(offset => data.getFloat32(geometry + 96 + offset, true)),
      effect: data.getInt32(native.task + 616, true), type: data.getInt32(native.task + 600, true), state: native.state,
      target: [0, 4, 8].map(offset => data.getFloat32(native.task + 480 + offset, true)) };
    return validLadder(value) ? { ...native, value } : null;
  }
  function sampleLadder(ped) { return ladderTask(ped)?.value || null; }
  function applyLadder(replica, state, now) {
    const value = state.actions?.ladder;
    if (!value) { replica.characterLadder = null; return false; }
    if (!validLadder(value) || !ex.mpSetLadderState) return false;
    const ped = replica.ped ?? replica.handle, signature = JSON.stringify(value);
    if (replica.characterLadder?.signature !== signature || replica.characterLadder.ped !== ped) {
      replica.characterLadder = { signature, ped, at: now, applied: false };
    }
    const pending = replica.characterLadder;
    if (pending.applied || now - pending.at > 500) return false;
    const native = ladderTask(ped);
    if (!native || native.value.model !== value.model || native.value.effect !== value.effect || native.value.type !== value.type
      || native.value.geometry.some((n, i) => Math.abs(n - value.geometry[i]) > (i < 9 ? .0001 : .02))) return false;
    // Only reconcile a task already attached to the same resident ladder.
    // Mount/dismount retain their native geometry and readiness checks.
    const inputs = { 7: 0, 8: 1, 9: 2, 12: 4 };
    if (!Object.hasOwn(inputs, native.state) || !Object.hasOwn(inputs, value.state)
      || Math.hypot(...native.value.target.map((n, i) => n - value.target[i])) > 2) return false;
    const data = new DataView(memory.buffer);
    value.target.forEach((n, i) => data.setFloat32(native.task + 480 + i * 4, n, true));
    data.setInt32(native.task + 608, inputs[value.state], true);
    if (native.state !== value.state) ex.mpSetLadderState(BigInt(native.task), value.state);
    pending.applied = true;
    return true;
  }
  function applyCoverAim(replica, state, now) {
    if (!['mpSetTaskTarget', 'mpCoverWeaponReady', 'mpSetCoverState'].every(name => typeof ex[name] === 'function')) return false;
    const ped = replica.ped ?? replica.handle, native = coverTask(ped);
    if (!native || ![2, 6, 7, 8].includes(native.state)) return false;
    const actions = state.actions || {}, target = state.aim_target;
    const targetValid = Array.isArray(target) && target.length === 3
      && target.every(value => Number.isFinite(value) && Math.abs(value) <= 16000);
    const aiming = Boolean((actions.cover_aiming || actions.aiming) && !actions.reloading && targetValid);
    const current = replica.characterAction;
    if (!current) return false;
    if (aiming) {
      // CreateFireTask's alternate combat branch can select controller 2.
      // Such an incompatible resident AI task is never driven into aiming.
      if (new DataView(memory.buffer).getUint8(native.intelligence + 6197) & 16
        || !ex.mpCoverWeaponReady(BigInt(native.parent))) return false;
      const data = storage();
      // The original cover task uses 8192 to choose controller 1 (aim only).
      // Keep its stay-in-cover flag; never switch a replica to an AI fire controller.
      data.setUint32(native.parent + 376, data.getUint32(native.parent + 376, true) | 8192, true);
      target.forEach((value, index) => data.setFloat32(scratch + 16 + index * 4, value, true));
      data.setFloat32(scratch + 28, 0, true);
      ex.mpSetTaskTarget(BigInt(native.parent + 544), BigInt(scratch + 16));
      // CreateFireTask copies the parent target. Refresh that independent copy
      // as the source turns; the native Gun FSM propagates it to its aim child.
      if (native.child && address(native.child, 656)) {
        const view = new DataView(memory.buffer);
        if (view.getUint16(native.child + 52, true) === 293
          && view.getBigUint64(native.child + 24, true) === BigInt(native.task)
          && view.getInt32(native.child + 324, true) === 1) {
          ex.mpSetTaskTarget(BigInt(native.child + 352), BigInt(scratch + 16));
        }
      }
    }
    // Enter/leave through native transitions, not direct state-byte writes.
    // AimIntro computes geometry, starts the filtered network and creates its
    // own child; AimOutro restores the native covered stance.
    const desired = aiming && native.state === 2 ? 6 : !aiming && [6, 7].includes(native.state) ? 8 : null;
    if (desired === null) { current.coverRequest = null; return aiming; }
    const key = native.task + ':' + desired;
    if (current.coverRequest === key && now - current.coverRequestAt < 500) return aiming;
    ex.mpSetCoverState(BigInt(native.task), desired);
    current.coverRequest = key; current.coverRequestAt = now;
    return aiming;
  }
  function apply(replica, state, { now, poseReady, animating = false }) {
    const ped = replica.ped ?? replica.handle, actions = state.actions || {};
    if (!poseReady || state.attachment || state.alive === false || state.health <= 0) return false;
    const next = mode(actions), previous = replica.characterAction;
    const key = next + (next === 'cover' ? ':' + Boolean(actions.cover_left) + ':' + Boolean(actions.cover_high) : '');
    if (!next) {
      if (previous) {
        // A stopped special task must not keep owning the pose. Preserve native
        // death tasks by calling this only after the caller's living-state gate.
        ex.mpClearTasksImmediately?.(ped);
        ex.mpSetCanRagdoll?.(ped, 0);
        replica.characterAction = null; replica.characterReload = null; replica.characterPhases = null; replica.characterBlends = null; replica.characterLadder = null; replica.actions = null;
        replica.moving = false; replica.reloadActive = false;
        replica.behaviorAt = replica.idleAt = replica.aimAt = -Infinity;
      }
      return false;
    }
    if (animating && next !== 'ragdoll') return true;
    const changed = previous?.key !== key;
    if (changed) {
      ex.mpClearTasksImmediately?.(ped);
      replica.characterReload = null; replica.characterPhases = null; replica.characterBlends = null; replica.characterLadder = null;
      replica.moving = false; replica.reloadActive = false;
      replica.characterAction = { key, at: -Infinity, attempted: false };
    }
    const current = replica.characterAction;
    if (next === 'ragdoll') {
      ex.mpSetCanRagdoll?.(ped, 1);
      ex.mpFreeze?.(ped, 0);
      if (changed || now - current.at >= 400) {
        ex.mpSetToRagdoll?.(ped, 650, 650, 0, 0, 0, 0); current.at = now;
      }
    } else if (next === 'rolling') {
      if (!current.attempted) {
        current.attempted = true; roll(ped, actions); current.at = now;
      }
    } else if (next === 'climbing' || next === 'ladder') {
      if (!current.attempted) {
        if (next === 'ladder') ex.mpTaskClimbLadder?.(ped, 1);
        else ex.mpTaskClimb?.(ped, 0); current.attempted = true; current.at = now;
      }
      if (next === 'ladder') applyLadder(replica, state, now);
    } else if (next === 'cover') {
      if (changed || (!ex.mpIsInCover?.(ped, 0) && now - current.at >= 1000)) {
        // Native selects cover geometry; explicit left/right is a verified
        // parameter, whereas the cover-height query is observation only.
        ex.mpTaskCover?.(ped, vector(state.position), -1, 0, state.heading * Math.PI / 180,
          1, actions.cover_left ? 1 : 0, 0, 0);
        current.at = now;
      }
      applyCoverAim(replica, state, now);
    } else if (next === 'swimming' || next === 'underwater') {
      const moving = finite(actions.move_blend, 0, 3) > .05;
      // These exact hashes are observed in the engine's swimming/diving
      // IsInMotionState implementations and original diagnostic strings.
      const motionState = next === 'swimming' ? -776007225 : moving ? -1855028596 : 1212730861;
      if (changed || current.motionState !== motionState) {
        ex.mpTaskForceMotionState?.(ped, motionState, 0); current.motionState = motionState;
      }
      ex.mpSetDesiredMoveBlend?.(ped, finite(actions.move_blend, 0, 3));
    }
    // Falling retains native gravity/fall detection with accepted coordinates;
    // it is not replaced by a fabricated jump or an unconditional ragdoll.
    return true;
  }
  function layeredReloadSupported() {
    return ['mpGetEntityAddress', 'mpIsPed', 'mpExists', 'mpIsDead', 'mpAlloc', 'mpCreateReloadTask',
      'mpDeleteUnassignedReloadTask', 'mpAddSecondaryTask', 'mpClearSecondaryTask'].every(name => typeof ex[name] === 'function');
  }
  return { sample, apply, applyReload, applyPhases, reset, physical, mode,
    get layeredReloadSupported() { return layeredReloadSupported(); } };
};
