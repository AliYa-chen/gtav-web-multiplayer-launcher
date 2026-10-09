import zhCN from './locales/zh-CN.js';
import en from './locales/en.js';

export const dictionaries = Object.freeze({ 'zh-CN': zhCN, en });
export const supportedPreferences = Object.freeze(['system', 'zh-CN', 'en']);
export function resolveLanguage(preference = 'system', languages = globalThis.navigator?.languages || [globalThis.navigator?.language || 'en']) {
  if (preference === 'zh-CN' || preference === 'en') return preference;
  const first = Array.isArray(languages) ? languages.find((item) => typeof item === 'string' && item) : languages;
  return /^zh(?:[-_]|$)/i.test(first || '') ? 'zh-CN' : 'en';
}
export function normalizeLanguageConfig(value, languages) {
  const preference = supportedPreferences.includes(value?.preference) ? value.preference : 'system';
  return {
    preference,
    resolved: value?.resolved === 'zh-CN' || value?.resolved === 'en' ? value.resolved : resolveLanguage(preference, languages),
    revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
  };
}
export function createTranslator(language = 'zh-CN') {
  const dictionary = dictionaries[language] || dictionaries.en;
  return (key, params = {}) => String(dictionary[key] ?? dictionaries.en[key] ?? key).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
export function message(key, params = {}) { return { key, params }; }

// Native commands keep diagnostic strings for compatibility. Translate only known
// messages and preserve unknown diagnostics verbatim, including paths and OS errors.
export function translateMessage(value, language = 'zh-CN') {
  if (value && typeof value === 'object' && typeof value.key === 'string') return createTranslator(language)(value.key, value.params);
  const source = String(value ?? '');
  const t = createTranslator(language);
  for (const [key, original] of Object.entries(zhCN)) {
    if ((source === original || source === en[key]) && !/\{[a-zA-Z0-9_]+\}/.test(original)) return t(key);
  }
  for (const entry of nativeMessagePatterns) {
    const match = entry.pattern.exec(source);
    if (match) return t(entry.key, Object.fromEntries(entry.params.map((name, index) => [name, match[index + 1]])));
  }
  for (const entry of nativeTemplates) {
    const match = entry.pattern.exec(source);
    if (match) return t(entry.key, Object.fromEntries(entry.params.map((name, index) => [name, translateMessage(match[index + 1], language)])));
  }
  return source;
}
const nativeTemplates = [...Object.entries(zhCN), ...Object.entries(en)].filter(([key, original]) => key.startsWith('native.') && /\{[a-zA-Z0-9_]+\}/.test(original)).map(([key, original]) => {
  const params = [], pieces = [];
  let previous = 0;
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of original.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    pieces.push(escapeRegex(original.slice(previous, match.index)), '(.*?)');
    params.push(match[1]);
    previous = match.index + match[0].length;
  }
  pieces.push(escapeRegex(original.slice(previous)));
  return { key, params, pattern: new RegExp(`^${pieces.join('')}$`, 's') };
});
const nativeMessagePatterns = [
  { pattern: /^无法打开所选目录[：:]\s*(.*)$/s, key: 'native.directoryOpen', params: ['detail'] },
  { pattern: /^资源目录无法读取[：:]\s*(.*)$/s, key: 'native.resourcesRead', params: ['detail'] },
  { pattern: /^游戏引擎版本不兼容（SHA-256：(.*)）。请选择此启动器支持的完整游戏资源；原文件未修改。$/s, key: 'native.engineUnsupported', params: ['hash'] },
  { pattern: /^游戏资源不完整，清单中的 (\d+) 个文件缺失：(.*)。启动器不会下载或修改游戏数据。$/s, key: 'native.resourcesMissing', params: ['count', 'files'] },
  { pattern: /^找到多个游戏资源目录，无法自动决定。请重新选择其中一个：\n(.*)$/s, key: 'native.resourcesMultiple', params: ['choices'] },
  { pattern: /^无法打开默认浏览器，请复制客户端邀请地址手动打开[：:]\s*(.*)$/s, key: 'native.browserOpen', params: ['detail'] },
  { pattern: /^无法保存启动器设置[：:]\s*(.*)$/s, key: 'native.settingsSave', params: ['detail'] },
  { pattern: /^资源准备任务异常[：:]\s*(.*)$/s, key: 'native.prepareTask', params: ['detail'] },
  { pattern: /^无法读取资源 (.*)[：:]\s*(.*)$/s, key: 'native.resourceRead', params: ['file', 'detail'] },
  { pattern: /^资源不存在或链接指向目录外[：:]\s*(.*)$/s, key: 'native.resourceOutside', params: ['file'] },
  { pattern: /^资源路径不能越过已选择目录[：:]\s*(.*)$/s, key: 'native.resourceTraversal', params: ['file'] },
  { pattern: /^资源路径格式无效[：:]\s*(.*)$/s, key: 'native.resourcePath', params: ['file'] },
];
