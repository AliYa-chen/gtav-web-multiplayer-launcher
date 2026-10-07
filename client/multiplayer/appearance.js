// 公共战局外观约定：只在加入或主动重选时确定模型和随机种子。
// 衣服和饰品由引擎选取有效变体后采样，其他客户端应用同一组采样值。
export const AVATAR_PRESETS = Object.freeze([
  Object.freeze({ id: 'npc_male', label: '随机男性 NPC' }),
  Object.freeze({ id: 'npc_female', label: '随机女性 NPC' }),
  Object.freeze({ id: 'freemode_male', label: '男性自由模式角色' }),
  Object.freeze({ id: 'freemode_female', label: '女性自由模式角色' }),
]);

export function joaat(name) {
  let hash = 0;
  for (const character of String(name).toLowerCase()) {
    hash = (hash + character.charCodeAt(0)) >>> 0;
    hash = (hash + (hash << 10)) >>> 0;
    hash ^= hash >>> 6;
  }
  hash = (hash + (hash << 3)) >>> 0;
  hash ^= hash >>> 11;
  return (hash + (hash << 15)) >>> 0;
}

const MODEL_NAMES = Object.freeze({
  npc_male: Object.freeze(['a_m_y_business_01', 'a_m_y_beach_01', 'a_m_y_hipster_01']),
  npc_female: Object.freeze(['a_f_y_business_01', 'a_f_y_beach_01', 'a_f_y_hipster_01']),
  freemode_male: Object.freeze(['mp_m_freemode_01']),
  freemode_female: Object.freeze(['mp_f_freemode_01']),
});

export const MODEL_CATALOG = Object.freeze(Object.fromEntries(
  Object.entries(MODEL_NAMES).map(([preset, names]) => [preset,
    Object.freeze(names.map((name) => Object.freeze({ name, hash: joaat(name) })))]),
));
const ONLINE_MODELS = new Set(Object.values(MODEL_CATALOG).flat().map((model) => model.hash));

export function normalizePreferences(value) {
  // 兼容先前只有男女自由模式的客户端。
  if (value === 'male' || value === 'female') value = { preset: 'freemode_' + value, seed: 0 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const preset = Object.hasOwn(MODEL_NAMES, value.preset) ? value.preset : 'npc_male';
  const seed = Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= 0xffffffff ? value.seed : 0;
  return { preset, seed };
}

export function createPreferences(value = {}) {
  let seed;
  if (globalThis.crypto?.getRandomValues) seed = crypto.getRandomValues(new Uint32Array(1))[0];
  else seed = Math.floor(Math.random() * 0x100000000);
  return normalizePreferences({ ...value, seed });
}

export function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let result = Math.imul(state ^ (state >>> 15), state | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 0x100000000;
  };
}

export function modelForPreset(preferences) {
  const { preset, seed } = normalizePreferences(preferences);
  const models = MODEL_CATALOG[preset];
  return models[Math.floor(seededRandom(seed)() * models.length)].hash;
}

export function isAllowedOnlineModel(hash) {
  return Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff && ONLINE_MODELS.has(hash);
}

const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const tupleList = (value, count, valid) => Array.isArray(value) && value.length === count && value.every(valid);

// 返回全新的固定长度描述；不能把不受限的网络对象直接交给引擎 native。
export function normalizeAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !['components', 'props', 'overlays', 'hair'].includes(key))) return null;
  if (!tupleList(value.components, 12, (parts) => Array.isArray(parts) && parts.length === 3 &&
      integer(parts[0], 0, 1024) && integer(parts[1], 0, 255) && integer(parts[2], 0, 3))) return null;
  if (!tupleList(value.props, 8, (parts) => Array.isArray(parts) && parts.length === 2 &&
      integer(parts[0], -1, 1024) && integer(parts[1], -1, 255) && (parts[0] === -1 || parts[1] >= 0))) return null;
  const result = { components: value.components.map((parts) => [...parts]), props: value.props.map((parts) => [...parts]) };
  if (Object.hasOwn(value, 'overlays')) {
    if (!tupleList(value.overlays, 13, (parts) => Array.isArray(parts) && parts.length === 5 &&
        integer(parts[0], 0, 255) && Number.isFinite(parts[1]) && parts[1] >= 0 && parts[1] <= 1 &&
        integer(parts[2], 0, 2) && integer(parts[3], 0, 63) && integer(parts[4], 0, 63))) return null;
    result.overlays = value.overlays.map((parts) => [...parts]);
  }
  if (Object.hasOwn(value, 'hair')) {
    if (!Array.isArray(value.hair) || value.hair.length !== 2 || !value.hair.every((color) => integer(color, 0, 63))) return null;
    result.hair = [...value.hair];
  }
  return result;
}

// 返回需与引擎采样的 components/props 合并的妆容片段。
// 普通 NPC 的面容已包含在模型里，头部妆容 native 只用于自由模式角色。
export function randomAppearance(preset, seed) {
  if (preset && typeof preset === 'object') ({ preset, seed } = normalizePreferences(preset));
  if (preset !== 'freemode_male' && preset !== 'freemode_female') return {};
  const random = seededRandom((Number(seed) >>> 0) ^ 0x6a09e667);
  const pick = (count) => Math.floor(random() * count);
  const hair = [pick(29), pick(29)];
  const overlays = Array.from({ length: 13 }, () => [255, 0, 0, 0, 0]);
  overlays[2] = [pick(33), 0.85, 1, hair[0], hair[0]]; // 眉毛
  if (preset === 'freemode_male') {
    if (random() < 0.65) overlays[1] = [pick(28), 0.7, 1, hair[0], hair[0]]; // 胡须
  } else {
    if (random() < 0.6) overlays[4] = [pick(16), 0.45, 0, 0, 0]; // 淡妆
    if (random() < 0.6) overlays[8] = [pick(10), 0.4, 2, pick(10), 0]; // 唇色
  }
  return { overlays, hair };
}
