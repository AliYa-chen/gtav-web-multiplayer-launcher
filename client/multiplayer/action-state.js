// Shared wire validation; action flags describe presentation and never grant movement or damage.
export const BASE_ACTION_KEYS = Object.freeze(['aiming', 'reloading', 'jumping', 'ducking', 'sprinting']);
export const MOTION_ACTION_KEYS = Object.freeze(['falling', 'climbing', 'climbing_ladder', 'vaulting', 'swimming', 'underwater',
  'ragdoll', 'in_cover', 'cover_left', 'cover_high', 'cover_aiming', 'going_into_cover', 'strafing', 'rolling']);
const ratios = new Set(['move_blend', 'move_x', 'move_y']);
const flags = new Set([...BASE_ACTION_KEYS, ...MOTION_ACTION_KEYS]);

export function cleanActionState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !BASE_ACTION_KEYS.every(key => typeof value[key] === 'boolean')) return null;
  const result = {};
  for (const [key, part] of Object.entries(value)) {
    if (flags.has(key)) {
      if (typeof part !== 'boolean') return null;
    } else if (ratios.has(key)) {
      if (typeof part !== 'number' || !Number.isFinite(part) || part < (key === 'move_blend' ? 0 : -3) || part > 3) return null;
    } else if (key === 'ladder') {
      if (!part || typeof part !== 'object' || Array.isArray(part)
        || Object.keys(part).length !== 6 || Object.keys(part).some(name => !['model', 'geometry', 'effect', 'type', 'state', 'target'].includes(name))
        || !Number.isInteger(part.model) || part.model < 0 || part.model > 4294967295
        || !Number.isInteger(part.effect) || part.effect < 0 || part.effect > 65535
        || !Number.isInteger(part.type) || part.type < 0 || part.type > 2
        || !Number.isInteger(part.state) || part.state < 0 || part.state > 15
        || !Array.isArray(part.geometry) || part.geometry.length !== 12
        || part.geometry.some((n, i) => !Number.isFinite(n) || Math.abs(n) > (i < 9 ? 2 : 16000))
        || !Array.isArray(part.target) || part.target.length !== 3
        || part.target.some(n => !Number.isFinite(n) || Math.abs(n) > 16000)) return null;
      result[key] = { ...part, geometry: [...part.geometry], target: [...part.target] }; continue;
    } else if (key === 'animation_phases') {
      if (!Array.isArray(part) || part.length > 32) return null;
      const seen = new Set(), phases = [];
      for (const entry of part) {
        if (!entry || Array.isArray(entry) || Object.keys(entry).some(name => !['kind', 'name', 'phase', 'rate', 'parameters'].includes(name))
          || ![4, 15, 17].includes(entry.kind) || typeof entry.name !== 'string' || !/^[\x20-\x7e]{1,160}$/.test(entry.name)
          || !Number.isFinite(entry.phase) || entry.phase < 0 || entry.phase > 1
          || Object.hasOwn(entry, 'rate') && (!Number.isFinite(entry.rate) || entry.rate < -16 || entry.rate > 16)
          || Object.hasOwn(entry, 'parameters') && (entry.kind !== 17 || !Array.isArray(entry.parameters)
            || entry.parameters.length < 1 || entry.parameters.length > 16
            || entry.parameters.some(value => !Number.isFinite(value) || Math.abs(value) > 65536))) return null;
        const identity = entry.kind + ':' + entry.name;
        if (seen.has(identity)) return null;
        seen.add(identity); phases.push({ kind: entry.kind, name: entry.name, phase: entry.phase,
          ...(Object.hasOwn(entry, 'rate') ? { rate: entry.rate } : {}),
          ...(Object.hasOwn(entry, 'parameters') ? { parameters: [...entry.parameters] } : {}) });
      }
      result[key] = phases; continue;
    } else if (key === 'animation_blends') {
      if (!Array.isArray(part) || part.length > 16) return null;
      const seen = new Set(), blends = [];
      for (const entry of part) {
        if (!entry || Array.isArray(entry) || Object.keys(entry).some(name => !['kind', 'key', 'weights', 'rate'].includes(name))
          || ![5, 6, 13, 22].includes(entry.kind) || typeof entry.key !== 'string' || !/^[\x20-\x7e]{1,1024}$/.test(entry.key)
          || !Array.isArray(entry.weights) || entry.weights.length < 1 || entry.weights.length > 8
          || [5, 6].includes(entry.kind) && entry.weights.length !== 1
          || entry.weights.some(value => !Number.isFinite(value) || Math.abs(value) > 16 || [5, 13].includes(entry.kind) && (value < 0 || value > 1))
          || Object.hasOwn(entry, 'rate') && (![5, 6].includes(entry.kind) || !Number.isFinite(entry.rate) || Math.abs(entry.rate) > 16)) return null;
        const identity = entry.kind + ':' + entry.key;
        if (seen.has(identity)) return null;
        seen.add(identity); blends.push({ kind: entry.kind, key: entry.key, weights: [...entry.weights],
          ...(Object.hasOwn(entry, 'rate') ? { rate: entry.rate } : {}) });
      }
      result[key] = blends; continue;
    } else return null;
    result[key] = part;
  }
  return result;
}

export function legacyActionState(value) {
  return Object.fromEntries(BASE_ACTION_KEYS.map(key => [key, value[key]]));
}
