import { normalizeAppearance } from './appearance.js';

const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const vector = (value, bound = 16000) => Array.isArray(value) && value.length === 3
  && value.every((part) => Number.isFinite(part) && Math.abs(part) <= bound);
const actions = (value) => record(value) && Object.keys(value).length === 5
  && ['aiming', 'reloading', 'jumping', 'ducking', 'sprinting'].every((key) => typeof value[key] === 'boolean');
const clone = (value) => JSON.parse(JSON.stringify(value));

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
  if (Object.hasOwn(value, 'ownership') && !['offered', 'active', 'unowned'].includes(value.ownership)) return null;
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
  const entities = new Map(), tombstones = new Map(), retiredEpochs = new Set();
  const reset = () => { worldEpoch = null; worldRevision = worldTick = streamSequence = 0; ready = false;
    pending = null; entities.clear(); tombstones.clear(); retiredEpochs.clear(); };
  const state = () => ({ schema_version: 2, world_epoch: worldEpoch, world_revision: worldRevision,
    world_tick: worldTick, stream_seq: streamSequence, ready, entities: clone([...entities.values()]),
    tombstones: clone([...tombstones.values()]) });
  function apply(targets, removed, entityValues, deletedValues) {
    for (const value of deletedValues) {
      const old = targets.get(value.entity_id), dead = removed.get(value.entity_id);
      if ((old && (value.generation < old.generation || value.revision < old.revision))
        || (dead && (value.generation < dead.generation || value.revision <= dead.revision))) continue;
      targets.delete(value.entity_id); removed.set(value.entity_id, value);
    }
    for (const value of entityValues) {
      const dead = removed.get(value.entity_id), old = targets.get(value.entity_id);
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
      pending = { ...message, chunks: new Map(), queued: [] };
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
      const next = new Map(), deleted = new Map();
      for (let index = 0; index < pending.chunks.size; index++) {
        const chunk = pending.chunks.get(index); apply(next, deleted, chunk.entities, chunk.tombstones);
      }
      if (worldEpoch && worldEpoch !== pending.world_epoch) retiredEpochs.add(worldEpoch);
      worldEpoch = pending.world_epoch; worldRevision = pending.cut_revision; worldTick = pending.world_tick;
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
      if (!integer(message.world_revision) || !integer(message.world_tick) || !integer(message.stream_seq, 1) || !next) return { changed: false, needsSnapshot: true };
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
      if (message.world_revision <= worldRevision) return { changed: false };
      apply(entities, tombstones, next.entities, next.tombstones);
      for (const id of message.scope_leave) entities.delete(id);
      worldRevision = message.world_revision; worldTick = Math.max(worldTick, message.world_tick);
      return { changed: true };
    }
    return { changed: false };
  }
  return { reset, state, receive, entity: (id) => entities.has(id) ? clone(entities.get(id)) : null };
}
