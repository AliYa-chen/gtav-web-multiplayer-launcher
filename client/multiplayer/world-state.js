import { normalizeAppearance } from './appearance.js';

const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const vector = (value, bound = 16000) => Array.isArray(value) && value.length === 3
  && value.every((part) => Number.isFinite(part) && Math.abs(part) <= bound);
const actions = (value) => record(value) && Object.keys(value).length === 5
  && ['aiming', 'reloading', 'jumping', 'ducking', 'sprinting'].every((key) => typeof value[key] === 'boolean');
const clone = (value) => JSON.parse(JSON.stringify(value));
const weatherTypes = new Set(['EXTRASUNNY', 'CLEAR', 'CLOUDS', 'OVERCAST', 'RAIN', 'THUNDER', 'CLEARING', 'SMOG', 'FOGGY']);

export function cleanWorldEnvironment(value) {
  if (!record(value) || !integer(value.revision, 1) || !record(value.clock) || !record(value.weather)) return null;
  const c = value.clock, w = value.weather;
  if (!integer(c.hour, 0, 23) || !integer(c.minute, 0, 59) || !integer(c.second, 0, 59)
      || typeof c.paused !== 'boolean' || !Number.isFinite(c.rate) || c.rate < 0 || c.rate > 120 || !integer(c.anchor_tick)
      || !weatherTypes.has(w.type) || !Number.isFinite(w.rain) || w.rain < 0 || w.rain > 1
      || !Number.isFinite(w.wind) || w.wind < 0 || w.wind > 1 || !integer(w.transition_ms, 0, 120000) || !integer(w.anchor_tick)) return null;
  return clone(value);
}
export function cleanWorldLaw(value, epoch) {
  if (!record(value) || !integer(value.revision) || value.world_epoch !== epoch || !Array.isArray(value.players)
      || value.players.length > 256 || !Array.isArray(value.dispatches) || value.dispatches.length > 8) return null;
  if (value.players.some(p => !record(p) || !identifier(p.player_id) || !integer(p.generation, 1)
      || !integer(p.stars, 0, 5) || !integer(p.expires_at_tick) || !integer(p.last_crime_tick) || !integer(p.revision))) return null;
  if (value.dispatches.some(d => !record(d) || !identifier(d.response_id) || !identifier(d.target_entity_id)
      || !identifier(d.target_player_id) || !integer(d.target_generation, 1) || !vector(d.target_position)
      || !(d.owner_id === null || identifier(d.owner_id)) || !['offered', 'active', 'frozen', 'retiring'].includes(d.phase)
      || !Array.isArray(d.entity_ids) || d.entity_ids.length > 3 || !d.entity_ids.every(identifier))) return null;
  return clone(value);
}

export function cleanWorldTransform(value) {
  if (!record(value) || !vector(value.position) || !Array.isArray(value.rotation) || value.rotation.length !== 4
    || !value.rotation.every((part) => Number.isFinite(part) && Math.abs(part) <= 1.01)
    || Math.abs(Math.hypot(...value.rotation) - 1) > .01 || !vector(value.velocity, 300)
    || Math.hypot(...value.velocity) > 300 || !vector(value.angular_velocity, 30)
    || Math.hypot(...value.angular_velocity) > 30) return null;
  if (Object.keys(value).some((key) => !['position', 'rotation', 'velocity', 'angular_velocity'].includes(key))) return null;
  return clone(value);
}

export function cleanWorldEntity(value) {
  if (!record(value) || !identifier(value.entity_id) || !['ped', 'vehicle', 'object'].includes(value.kind)
    || !integer(value.model, 0, 0xffffffff) || !integer(value.revision, 1) || !integer(value.generation, 1)
    || !integer(value.owner_epoch, 1) || !integer(value.lease_until_tick)
    || !(value.owner_id === null || identifier(value.owner_id))
    || !(value.player_id === null || identifier(value.player_id)) || !record(value.components)) return null;
  if (Object.hasOwn(value, 'combat_revision') && !integer(value.combat_revision)) return null;
  if (Object.hasOwn(value, 'last_input_seq') && !integer(value.last_input_seq, -1)) return null;
  if (Object.hasOwn(value, 'task_revision') && !integer(value.task_revision)) return null;
  if (Object.hasOwn(value, 'ownership') && !['offered', 'active', 'unowned'].includes(value.ownership)) return null;
  if (value.law_response) {
    const r = value.law_response;
    if (!record(r) || !identifier(r.response_id) || !identifier(r.target_player_id) || !identifier(r.target_entity_id)
      || !integer(r.target_generation, 1) || !vector(r.target_position) || !(r.owner_id === null || identifier(r.owner_id))
      || !['officer', 'vehicle'].includes(r.role) || !['offered', 'active', 'frozen', 'retiring'].includes(r.phase)) return null;
  }
  const components = value.components;
  if (Object.keys(components).some((key) => !['transform', 'ped', 'appearance', 'combat', 'vehicle', 'object', 'attachment'].includes(key))) return null;
  const transform = cleanWorldTransform(components.transform);
  if (!transform) return null;
  if (value.kind === 'ped') {
    const ped = components.ped;
    if (!record(ped) || !integer(ped.weapon, 0, 0xffffffff) || typeof ped.shooting !== 'boolean' || !actions(ped.actions)
      || (Object.hasOwn(ped, 'aim_target') && !vector(ped.aim_target))) return null;
    if (Object.keys(ped).some((key) => !['weapon', 'shooting', 'actions', 'aim_target'].includes(key))) return null;
  } else if (Object.hasOwn(components, 'ped')) return null;
  if (Object.hasOwn(components, 'appearance') && !normalizeAppearance(components.appearance)) return null;
  if (Object.hasOwn(components, 'combat')) {
    const life = components.combat;
    if (!record(life) || !integer(life.max_health, 1, 10000) || !integer(life.health, 0, life.max_health)
      || life.alive !== (life.health > 0) || !integer(life.kills) || !integer(life.deaths)
      || !integer(life.respawn_at_tick) || (life.alive && life.respawn_at_tick !== 0)) return null;
  }
  if (value.kind === 'vehicle') {
    const vehicle = components.vehicle;
    if (!record(vehicle) || !Number.isFinite(vehicle.engine_health) || vehicle.engine_health < -4000 || vehicle.engine_health > 1000
      || !Number.isFinite(vehicle.body_health) || vehicle.body_health < 0 || vehicle.body_health > 1000
      || !record(vehicle.seats) || !Object.hasOwn(vehicle.seats, 'driver') || Object.keys(vehicle.seats).length > 17
      || Object.entries(vehicle.seats).some(([seat, id]) => !/^(driver|passenger:(?:[0-9]|1[0-5]))$/.test(seat)
        || !(id === null || identifier(id))) || typeof vehicle.engine_on !== 'boolean' || typeof vehicle.lights_on !== 'boolean') return null;
    const occupants = Object.values(vehicle.seats).filter((id) => id !== null);
    if (new Set(occupants).size !== occupants.length) return null;
  } else if (Object.hasOwn(components, 'vehicle')) return null;
  if (Object.hasOwn(components, 'attachment') && components.attachment !== null) {
    const attachment = components.attachment;
    if (!record(attachment) || !identifier(attachment.entity_id)
      || !/^(driver|passenger:(?:[0-9]|1[0-5]))$/.test(attachment.seat)) return null;
  }
  return clone({ ...value, components: { ...components, transform } });
}

export function cleanWorldTombstone(value) {
  if (!record(value) || !identifier(value.entity_id) || !integer(value.revision, 1) || !integer(value.generation, 1)
    || !integer(value.world_revision)) return null;
  return clone(value);
}

// 世界逻辑基线与渲染资源是否加载分离。只在 snapshot_end 后替换有效基线。
export function createWorldState() {
  let worldEpoch = null, worldRevision = 0, worldTick = 0, streamSequence = 0, ready = false, pending = null;
  let environment = null, environmentReceivedAt = 0, environmentReceivedAtEpoch = 0, environmentServerTick = 0, law = null;
  const entities = new Map(), tombstones = new Map(), retiredEpochs = new Set();
  const reset = () => { worldEpoch = null; worldRevision = worldTick = streamSequence = 0; ready = false;
    pending = null; environment = law = null; environmentReceivedAt = environmentReceivedAtEpoch = environmentServerTick = 0; entities.clear(); tombstones.clear(); retiredEpochs.clear(); };
  const state = () => ({ schema_version: 2, world_epoch: worldEpoch, world_revision: worldRevision,
    world_tick: worldTick, stream_seq: streamSequence, ready, entities: clone([...entities.values()]),
    tombstones: clone([...tombstones.values()]), environment: environment && clone(environment),
    environment_received_at: environmentReceivedAt, environment_received_at_epoch: environmentReceivedAtEpoch,
    environment_server_tick: environmentServerTick, law: law && clone(law) });
  function receiveEnvironment(value, tick) {
    if (!value || (environment && value.revision <= environment.revision)) return false;
    environment = value; environmentReceivedAt = globalThis.performance?.now?.() ?? Date.now(); environmentServerTick = tick;
    environmentReceivedAtEpoch = Number.isFinite(globalThis.performance?.timeOrigin) ? globalThis.performance.timeOrigin + environmentReceivedAt : Date.now();
    worldTick = Math.max(worldTick, tick); return true;
  }
  function apply(targets, removed, entityValues, deletedValues) {
    for (const value of deletedValues) {
      const old = targets.get(value.entity_id), dead = removed.get(value.entity_id);
      if ((old && (value.generation < old.generation || value.revision < old.revision))
        || (dead && (value.generation < dead.generation || value.revision <= dead.revision))) continue;
      targets.delete(value.entity_id); removed.set(value.entity_id, value);
    }
    for (const value of entityValues) {
      const dead = removed.get(value.entity_id), old = targets.get(value.entity_id);
      if (old && value.generation === old.generation && value.revision === old.revision
          && (value.task_revision ?? 0) > (old.task_revision ?? 0)) {
        // 控制任务使用独立版本；不能借元数据更新回滚已确认姿态、血量或归属。
        targets.set(value.entity_id, { ...old, task_revision: value.task_revision, law_response: value.law_response,
          simulation_task: value.simulation_task }); continue;
      }
      if ((dead && (value.generation <= dead.generation || value.revision <= dead.revision))
        || (old && (value.generation < old.generation || value.revision <= old.revision))) continue;
      removed.delete(value.entity_id); targets.set(value.entity_id, value);
    }
  }
  function values(message) {
    if (!Array.isArray(message.entities) || message.entities.length > 4096
      || !Array.isArray(message.tombstones) || message.tombstones.length > 4096) return null;
    const next = message.entities.map(cleanWorldEntity), deleted = message.tombstones.map(cleanWorldTombstone);
    if (next.some((value) => !value) || deleted.some((value) => !value)) return null;
    if ([...next, ...deleted].some((value) => !value.entity_id.startsWith('w:' + message.world_epoch + ':'))) return null;
    const cut = message.type === 'world_delta' ? message.world_revision : message.cut_revision;
    if (deleted.some((value) => value.world_revision > cut)) return null;
    return { entities: next, tombstones: deleted };
  }
  function receive(message) {
    if (!record(message) || message.schema_version !== 2 || !identifier(message.world_epoch)) return { changed: false };
    if (retiredEpochs.has(message.world_epoch)) return { changed: false };
    if (message.type === 'snapshot_begin') {
      if (!identifier(message.snapshot_id) || !integer(message.cut_revision) || !integer(message.world_tick)
        || !integer(message.stream_seq)) return { changed: false, needsSnapshot: true };
      if (worldEpoch === message.world_epoch && (message.cut_revision < worldRevision || message.stream_seq < streamSequence)) return { changed: false };
      const nextEnvironment = message.environment === undefined ? null : cleanWorldEnvironment(message.environment);
      const nextLaw = message.law === undefined ? null : cleanWorldLaw(message.law, message.world_epoch);
      if (message.environment !== undefined && !nextEnvironment) return { changed: false, needsSnapshot: true };
      if (message.law !== undefined && !nextLaw) return { changed: false, needsSnapshot: true };
      pending = { ...message, environment: nextEnvironment, law: nextLaw, chunks: new Map(), queued: [] };
      ready = false;
      return { changed: true };
    }
    if (message.type === 'snapshot_chunk') {
      if (!pending || message.world_epoch !== pending.world_epoch || message.snapshot_id !== pending.snapshot_id
        || message.cut_revision !== pending.cut_revision || !integer(message.index, 0, 127)) return { changed: false, needsSnapshot: true };
      const next = values(message);
      if (!next || pending.chunks.has(message.index)) return { changed: false, needsSnapshot: true };
      pending.chunks.set(message.index, next); return { changed: false };
    }
    if (message.type === 'snapshot_end') {
      if (!pending || message.world_epoch !== pending.world_epoch || message.snapshot_id !== pending.snapshot_id
        || message.cut_revision !== pending.cut_revision || message.stream_seq !== pending.stream_seq
        || message.world_tick !== pending.world_tick || [...pending.chunks.keys()].some((index) => index >= pending.chunks.size)) return { changed: false, needsSnapshot: true };
      if (JSON.stringify(message.environment ?? null) !== JSON.stringify(pending.environment)) return { changed: false, needsSnapshot: true };
      if (JSON.stringify(message.law ?? null) !== JSON.stringify(pending.law)) return { changed: false, needsSnapshot: true };
      const next = new Map(), deleted = new Map();
      for (let index = 0; index < pending.chunks.size; index++) {
        const chunk = pending.chunks.get(index); apply(next, deleted, chunk.entities, chunk.tombstones);
      }
      if (worldEpoch && worldEpoch !== pending.world_epoch) retiredEpochs.add(worldEpoch);
      const changedEpoch = worldEpoch !== pending.world_epoch;
      worldEpoch = pending.world_epoch; worldRevision = pending.cut_revision; worldTick = pending.world_tick;
      if (changedEpoch) { environment = law = null; environmentReceivedAt = environmentReceivedAtEpoch = environmentServerTick = 0; }
      receiveEnvironment(pending.environment, pending.world_tick);
      if (pending.law && (!law || pending.law.revision >= law.revision)) law = pending.law;
      streamSequence = pending.stream_seq; entities.clear(); tombstones.clear();
      for (const [id, value] of next) entities.set(id, value);
      for (const [id, value] of deleted) tombstones.set(id, value);
      const queued = pending.queued; pending = null; ready = true;
      for (const delta of queued) {
        const result = receive(delta);
        if (result.needsSnapshot) return { changed: true, needsSnapshot: true };
      }
      return { changed: true };
    }
    if (message.type === 'world_delta') {
      const next = values(message);
      const nextEnvironment = message.environment === undefined ? null : cleanWorldEnvironment(message.environment);
      const nextLaw = message.law === undefined ? null : cleanWorldLaw(message.law, message.world_epoch);
      if (!integer(message.world_revision) || !integer(message.world_tick) || !integer(message.stream_seq, 1) || !next) return { changed: false, needsSnapshot: true };
      if (message.environment !== undefined && !nextEnvironment) return { changed: false, needsSnapshot: true };
      if (message.law !== undefined && !nextLaw) return { changed: false, needsSnapshot: true };
      if (!Array.isArray(message.scope_leave) || message.scope_leave.length > 4096
        || !message.scope_leave.every(identifier)) return { changed: false, needsSnapshot: true };
      if (pending && message.world_epoch === pending.world_epoch) {
        if (pending.queued.length >= 256) return { changed: false, needsSnapshot: true };
        pending.queued.push(message); return { changed: false };
      }
      if (!ready || message.world_epoch !== worldEpoch) return { changed: false, needsSnapshot: true };
      if (message.stream_seq <= streamSequence) return { changed: false };
      if (message.stream_seq !== streamSequence + 1) { ready = false; return { changed: true, needsSnapshot: true }; }
      streamSequence = message.stream_seq;
      const environmentChanged = receiveEnvironment(nextEnvironment, message.world_tick);
      const lawChanged = Boolean(nextLaw && (!law || nextLaw.revision > law.revision));
      if (lawChanged) law = nextLaw;
      if (message.world_revision <= worldRevision) {
        if (message.world_revision === worldRevision) apply(entities, tombstones, next.entities, next.tombstones);
        return { changed: environmentChanged || lawChanged };
      }
      apply(entities, tombstones, next.entities, next.tombstones);
      for (const id of message.scope_leave) entities.delete(id);
      worldRevision = message.world_revision; worldTick = Math.max(worldTick, message.world_tick);
      return { changed: true };
    }
    return { changed: false };
  }
  return { reset, state, receive, entity: (id) => entities.has(id) ? clone(entities.get(id)) : null };
}
