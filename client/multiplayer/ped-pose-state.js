// Original RD_MALE/RD_FEMALE rigid-part bone tags. No client hit verdicts.
export const PED_POSE_TAGS = Object.freeze([11816, 58271, 63931, 14201, 51826, 36864, 52301,
  57597, 24816, 24817, 24818, 64729, 45509, 61163, 18905, 10706, 40269, 28252, 57005, 39317, 31086]);
export function cleanPedPose(value) {
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !['bones', 'origin', 'sample_tick', 'bounds', 'water_height'].includes(key))
    || !Array.isArray(value.bones) || value.bones.length !== PED_POSE_TAGS.length) return null;
  const seen = new Set(), bones = [];
  for (const bone of value.bones) {
    if (!bone || Array.isArray(bone) || Object.keys(bone).some(key => !['tag', 'matrix'].includes(key))
      || !PED_POSE_TAGS.includes(bone.tag) || seen.has(bone.tag) || !Array.isArray(bone.matrix)
      || bone.matrix.length !== 12 || bone.matrix.some((v, i) => !Number.isFinite(v) || Math.abs(v) > (i < 9 ? 2 : 16000))) return null;
    seen.add(bone.tag); bones.push({ tag: bone.tag, matrix: [...bone.matrix] });
  }
  const result = { bones };
  if (Object.hasOwn(value, 'origin')) {
    if (!Array.isArray(value.origin) || value.origin.length !== 3
      || value.origin.some(v => !Number.isFinite(v) || Math.abs(v) > 16000)) return null;
    result.origin = [...value.origin];
  }
  if (Object.hasOwn(value, 'sample_tick')) {
    if (!Number.isSafeInteger(value.sample_tick) || value.sample_tick < 0) return null;
    result.sample_tick = value.sample_tick;
  }
  if (Object.hasOwn(value, 'bounds')) {
    const bounds = value.bounds;
    if (!bounds || Array.isArray(bounds) || Object.keys(bounds).some(key => !['minimum', 'maximum'].includes(key))
      || ![bounds.minimum, bounds.maximum].every(v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) <= 16000))
      || bounds.minimum.some((v, i) => v >= bounds.maximum[i] || bounds.maximum[i] - v > 8)) return null;
    result.bounds = { minimum: [...bounds.minimum], maximum: [...bounds.maximum] };
  }
  if (Object.hasOwn(value, 'water_height')) {
    if (value.water_height !== null && (!Number.isFinite(value.water_height) || Math.abs(value.water_height) > 16000)) return null;
    result.water_height = value.water_height;
  }
  return result;
}
