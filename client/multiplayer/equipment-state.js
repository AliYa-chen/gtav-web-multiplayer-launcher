// Equipment messages contain authoritative quantities; worker requests never do.
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const hash = value => integer(value, 0, 0xffffffff);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const position = value => Array.isArray(value) && value.length === 3
  && value.every(part => Number.isFinite(part) && Math.abs(part) <= 16000);
export function cleanEquipmentPickup(value) {
  if (!value || !text(value.id) || !integer(value.generation, 1) || !integer(value.revision)
    || !hash(value.type_hash) || !text(value.name) || (typeof value.model !== 'string' || value.model.length > 96) || !position(value.position)
    || !Number.isFinite(value.radius) || value.radius <= 0 || value.radius > 20
    || typeof value.available !== 'boolean' || !integer(value.available_at)
    || !Array.isArray(value.weapons) || value.weapons.length > 128 || value.weapons.some(item => !hash(item))) return null;
  return { id: value.id, generation: value.generation, revision: value.revision, type_hash: value.type_hash,
    name: value.name, model: value.model, position: value.position.slice(), radius: value.radius,
    available: value.available, available_at: value.available_at, weapons: value.weapons.slice() };
}
export function cleanEquipmentState(value) {
  if (!value || !text(value.player_id) || !text(value.world_epoch) || !text(value.entity_id)
    || !integer(value.generation, 1) || !integer(value.revision) || !integer(value.last_seq, -1)
    || !integer(value.last_shot_seq, -1) || !hash(value.selected_weapon) || !integer(value.server_time)
    || !Array.isArray(value.weapons) || value.weapons.length > 128
    || !Array.isArray(value.pickups) || value.pickups.length > 256) return null;
  const weapons = [], seen = new Set();
  for (const slot of value.weapons) {
    if (!slot || !hash(slot.weapon) || seen.has(slot.weapon) || !text(slot.name)
      || !integer(slot.clip, 0, 100000) || !integer(slot.clip_size, 0, 0x7fffffff) || slot.clip > slot.clip_size
      || !integer(slot.total, 0, 100000) || !integer(slot.max_ammo, 0, 100000) || slot.total > slot.max_ammo || slot.clip > slot.total
      || !hash(slot.ammo_hash) || typeof slot.ammo_type !== 'string' || slot.ammo_type.length > 96
      || typeof slot.infinite !== 'boolean' || typeof slot.thrown !== 'boolean'
      || !integer(slot.reload_ms, -1, 60000) || !integer(slot.reload_empty_ms, -1, 60000)) return null;
    seen.add(slot.weapon); weapons.push({ weapon: slot.weapon, name: slot.name, clip: slot.clip,
      clip_size: slot.clip_size, total: slot.total, max_ammo: slot.max_ammo, ammo_type: slot.ammo_type, ammo_hash: slot.ammo_hash,
      infinite: slot.infinite, thrown: slot.thrown, reload_ms: slot.reload_ms, reload_empty_ms: slot.reload_empty_ms });
  }
  if (!seen.has(value.selected_weapon)) return null;
  let reload = null;
  if (value.reload !== null) {
    const input = value.reload;
    if (!input || !text(input.token) || !seen.has(input.weapon) || !integer(input.started_at)
      || !integer(input.ready_at) || input.ready_at < input.started_at || input.ready_at - input.started_at > 60000
      || input.phase !== 'awaiting_native_completion') return null;
    reload = { token: input.token, weapon: input.weapon, started_at: input.started_at,
      ready_at: input.ready_at, phase: input.phase };
  }
  const pickups = value.pickups.map(cleanEquipmentPickup);
  if (pickups.some(item => !item) || new Set(pickups.map(item => item.id)).size !== pickups.length) return null;
  return { type: 'equipment_state', player_id: value.player_id, world_epoch: value.world_epoch, entity_id: value.entity_id,
    generation: value.generation, revision: value.revision, last_seq: value.last_seq, last_shot_seq: value.last_shot_seq,
    selected_weapon: value.selected_weapon, server_time: value.server_time, weapons, reload, pickups };
}
