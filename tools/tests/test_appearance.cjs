#!/usr/bin/env node
'use strict';
// 直接导入前端外观模块，验证网络描述和种子约定；不依赖游戏资源或 WASM。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../../client/multiplayer/appearance.js'), 'utf8');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const fixture = () => ({
  components: Array.from({ length: 12 }, (_, index) => [index, index % 3, index % 4]),
  props: Array.from({ length: 8 }, (_, index) => index % 2 ? [-1, -1] : [index, index % 3]),
});

test('模型目录只包含六个 NPC 和两种自由角色，哈希与 GTA 已知自由角色匹配', async () => {
  const { MODEL_CATALOG, AVATAR_PRESETS, joaat, isAllowedOnlineModel } = await modulePromise;
  assert.equal(MODEL_CATALOG.npc_male.length, 3);
  assert.equal(MODEL_CATALOG.npc_female.length, 3);
  assert.equal(MODEL_CATALOG.freemode_male.length, 1);
  assert.equal(MODEL_CATALOG.freemode_female.length, 1);
  assert.equal(joaat('mp_m_freemode_01'), 0x705e61f2);
  assert.equal(joaat('MP_F_FREEMODE_01'), 0x9c9effd8);
  const models = Object.values(MODEL_CATALOG).flat();
  assert.equal(new Set(models.map((model) => model.hash)).size, 8);
  for (const model of models) {
    assert.ok(isAllowedOnlineModel(model.hash));
    assert.equal(joaat(model.name), model.hash);
    assert.ok(Object.isFrozen(model));
  }
  assert.deepEqual(AVATAR_PRESETS.map((preset) => preset.id), Object.keys(MODEL_CATALOG));
  for (const invalid of [0x0d7114c9, -1, 0x100000000, NaN, Infinity, '1885233650', null]) {
    assert.equal(isAllowedOnlineModel(invalid), false);
  }
});

test('外观偏好兼容旧男女字段并限制种子为无符号整数，未知预设回落 NPC', async () => {
  const { normalizePreferences } = await modulePromise;
  assert.deepEqual(normalizePreferences('male'), { preset: 'freemode_male', seed: 0 });
  assert.deepEqual(normalizePreferences('female'), { preset: 'freemode_female', seed: 0 });
  assert.deepEqual(normalizePreferences({ preset: 'npc_female', seed: 0xffffffff }),
    { preset: 'npc_female', seed: 0xffffffff });
  for (const invalid of [null, [], 'unknown', { preset: '__proto__' }, { preset: 'constructor' }]) {
    assert.deepEqual(normalizePreferences(invalid), { preset: 'npc_male', seed: 0 });
  }
  for (const seed of [-1, 0x100000000, 1.5, NaN, Infinity, '12']) {
    assert.deepEqual(normalizePreferences({ preset: 'freemode_female', seed }), { preset: 'freemode_female', seed: 0 });
  }
});

test('固定种子决定模型，重复计算不修改偏好也不重新随机', async () => {
  const { MODEL_CATALOG, modelForPreset, seededRandom } = await modulePromise;
  const first = seededRandom(123), second = seededRandom(123), other = seededRandom(124);
  const values = Array.from({ length: 20 }, () => first());
  assert.deepEqual(values, Array.from({ length: 20 }, () => second()));
  assert.notDeepEqual(values, Array.from({ length: 20 }, () => other()));
  assert.ok(values.every((value) => value >= 0 && value < 1));
  for (const preset of Object.keys(MODEL_CATALOG)) {
    const selected = new Set();
    for (let seed = 0; seed < 40; seed++) {
      const preferences = { preset, seed };
      const model = modelForPreset(preferences);
      assert.equal(modelForPreset(preferences), model);
      assert.ok(MODEL_CATALOG[preset].some((entry) => entry.hash === model));
      assert.deepEqual(preferences, { preset, seed });
      selected.add(model);
    }
    assert.equal(selected.size, MODEL_CATALOG[preset].length, preset + ' 的种子样本覆盖所有候选模型');
  }
});

test('有效外观规范化为独立副本，允许边界值但不会保留原始数组引用', async () => {
  const { normalizeAppearance } = await modulePromise;
  const original = fixture();
  original.components[0] = [1024, 255, 3];
  original.props[0] = [1024, 255];
  original.overlays = Array.from({ length: 13 }, () => [255, 1, 2, 63, 63]);
  original.hair = [0, 63];
  const normalized = normalizeAppearance(original);
  assert.deepEqual(normalized, original);
  assert.notEqual(normalized.components, original.components);
  assert.notEqual(normalized.props[0], original.props[0]);
  assert.notEqual(normalized.overlays[0], original.overlays[0]);
  assert.notEqual(normalized.hair, original.hair);
  original.components[0][0] = 0; original.props[0][0] = -1;
  original.overlays[0][0] = 0; original.hair[1] = 0;
  assert.equal(normalized.components[0][0], 1024);
  assert.equal(normalized.props[0][0], 1024);
  assert.equal(normalized.overlays[0][0], 255);
  assert.equal(normalized.hair[1], 63);
});

test('不完整或越界网络外观被拒绝，不接受额外字段、错误类型和无效饰品组合', async () => {
  const { normalizeAppearance } = await modulePromise;
  const invalid = [null, [], {}, { ...fixture(), model: 1 }];
  for (const mutate of [
    (value) => { value.components.pop(); },
    (value) => { value.components.push([0, 0, 0]); },
    (value) => { value.components[0] = null; },
    (value) => { value.components[0] = [-1, 0, 0]; },
    (value) => { value.components[0] = [1025, 0, 0]; },
    (value) => { value.components[0] = [0, 256, 0]; },
    (value) => { value.components[0] = [0, 0, 4]; },
    (value) => { value.components[0] = [0.1, 0, 0]; },
    (value) => { value.components[0] = ['0', 0, 0]; },
    (value) => { value.components[0] = [NaN, 0, 0]; },
    (value) => { value.props.pop(); },
    (value) => { value.props[0] = [-2, -1]; },
    (value) => { value.props[0] = [0, -1]; },
    (value) => { value.props[0] = [1025, 0]; },
    (value) => { value.props[0] = [0, 256]; },
    (value) => { value.hair = [0]; },
    (value) => { value.hair = [64, 0]; },
    (value) => { value.hair = [Infinity, 0]; },
    (value) => { value.overlays = []; },
    (value) => { value.overlays = Array.from({ length: 13 }, () => [0, 1.1, 0, 0, 0]); },
    (value) => { value.overlays = Array.from({ length: 13 }, () => [0, 1, 3, 0, 0]); },
    (value) => { value.overlays = Array.from({ length: 13 }, () => [0, 1, 0, 64, 0]); },
  ]) {
    const value = fixture(); mutate(value); invalid.push(value);
  }
  for (const value of invalid) assert.equal(normalizeAppearance(value), null, JSON.stringify(value));
});

test('妆容固定种子可重复且经完整网络外观验证，普通 NPC 不生成自由模式妆容', async () => {
  const { randomAppearance, normalizeAppearance } = await modulePromise;
  for (const preset of ['npc_male', 'npc_female', 'unknown']) assert.deepEqual(randomAppearance(preset, 123), {});
  for (const preset of ['freemode_male', 'freemode_female']) {
    const variants = new Set();
    for (let seed = 0; seed < 30; seed++) {
      const cosmetics = randomAppearance(preset, seed);
      assert.deepEqual(randomAppearance({ preset, seed }), cosmetics);
      assert.deepEqual(randomAppearance(preset, seed), cosmetics);
      assert.ok(normalizeAppearance({ ...fixture(), ...cosmetics }));
      assert.equal(cosmetics.overlays.length, 13);
      variants.add(JSON.stringify(cosmetics));
    }
    assert.ok(variants.size > 1, '不同种子应能选出不同妆容');
  }
});
