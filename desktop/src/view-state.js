import { createTranslator, translateMessage } from './i18n.js';
export const phases = Object.freeze({ checking: ['识别与校验', 20], engine: ['准备运行引擎', 55], fonts: ['准备游戏字体', 82], ready: ['准备完成', 100] });
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
export function displayDirectory(value, language = 'zh-CN') { return value || createTranslator(language)('resources.noDirectory'); }
export function canLaunch({ selected, busy, desktop }) { return Boolean(selected && !busy && desktop); }
export function progressValue(phase) { return phases[phase]?.[1] || 0; }

export function clientCapacity({ availableHeight, cardHeight, rowGap = 0, columns = 2 }) {
  if (!Number.isFinite(availableHeight) || !Number.isFinite(cardHeight) || cardHeight <= 0) return null;
  const count = Number.isInteger(columns) && columns > 0 ? columns : 2;
  const gap = Number.isFinite(rowGap) && rowGap >= 0 ? rowGap : 0;
  return Math.max(1, Math.floor((Math.max(0, availableHeight) + gap) / (cardHeight + gap))) * count;
}
export function clientPage(clients, capacity, page = 0, anchorId = null) {
  const size = Number.isInteger(capacity) && capacity > 0 ? capacity : 2;
  const anchor = anchorId === null ? -1 : clients.findIndex((client) => String(client.id) === String(anchorId));
  const current = Number.isInteger(page) && page >= 0 ? page : 0;
  return anchor >= 0 ? Math.floor(anchor / size) : Math.min(current, Math.max(0, Math.ceil(clients.length / size) - 1));
}

export function paginateText(value, { lines = 12, columns = 34 } = {}) {
  const text = String(value ?? '');
  if (!text) return [];
  const limit = (value, fallback) => Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  const lineLimit = limit(lines, 12), columnLimit = limit(columns, 34);
  const segments = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)
    : text.matchAll(/\r\n|./gsu);
  const pages = [];
  let page = '', line = 1, column = 0;
  const finishPage = () => { if (page) pages.push(page); page = ''; line = 1; column = 0; };
  for (const segment of segments) {
    const char = segment.segment ?? segment[0];
    const newline = /^(?:\r\n|[\r\n\u2028\u2029])$/.test(char);
    // A full line wraps only when the next character needs space; its newline belongs to that same line.
    if (!newline && column === columnLimit) {
      if (line === lineLimit) finishPage();
      else { line++; column = 0; }
    }
    page += char;
    if (newline) {
      if (line === lineLimit) finishPage();
      else { line++; column = 0; }
    } else column++;
  }
  finishPage();
  return pages;
}

export const backgroundPreferenceKey = 'gta5data.launcher.background';
export const defaultBackground = 'sunglasses';
export function readBackground(storage, allowed) {
  try {
    const saved = storage.getItem(backgroundPreferenceKey);
    return allowed.includes(saved) ? saved : defaultBackground;
  } catch { return defaultBackground; }
}
export function saveBackground(storage, id, allowed) {
  if (!allowed.includes(id)) return false;
  try { storage.setItem(backgroundPreferenceKey, id); return true; }
  catch { return false; }
}
function parsedVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || '').trim().replace(/^v/, ''));
  return match ? { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || '' } : null;
}
export function isNewerVersion(latest, current) {
  const next = parsedVersion(latest), installed = parsedVersion(current);
  if (!next || !installed) return false;
  for (let i = 0; i < 3; i++) if (next.numbers[i] !== installed.numbers[i]) return next.numbers[i] > installed.numbers[i];
  if (!next.prerelease && installed.prerelease) return true;
  if (!installed.prerelease || !next.prerelease) return false;
  const a = next.prerelease.split('.'), b = installed.prerelease.split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return false;
    if (b[i] === undefined) return true;
    if (a[i] === b[i]) continue;
    const numericA = /^\d+$/.test(a[i]), numericB = /^\d+$/.test(b[i]);
    if (numericA && numericB) return Number(a[i]) > Number(b[i]);
    if (numericA !== numericB) return !numericA;
    return a[i] > b[i];
  }
  return false;
}
export function remotePresentation(snapshot, version, platform = '', language = 'zh-CN') {
  const t = createTranslator(language);
  const loaded = snapshot?.source === 'remote' && snapshot?.stale !== true;
  const config = loaded ? snapshot.config || {} : {};
  const localized = config.i18n?.[language] || {};
  const announcements = Array.isArray(localized.announcements) ? localized.announcements : config.announcements;
  const title = typeof localized.oltitle === 'string' ? localized.oltitle : config.oltitle;
  const releaseNotes = typeof localized.release_notes === 'string' ? localized.release_notes : config.release_notes;
  const latest = typeof config.latest_version === 'string' ? config.latest_version : '';
  const update = snapshot?.debug_local !== true && import.meta.env?.DEV !== true && isNewerVersion(latest, version);
  const available = Boolean(platform && config.downloads?.[platform]?.url && config.downloads?.[platform]?.sha256);
  return {
    loaded,
    title: typeof title === 'string' && title ? title : '-',
    websiteAvailable: Boolean(config.website || /^https:\/\//i.test(config.oltitle || '')),
    announcements: Array.isArray(announcements) ? announcements.filter((item) => item && typeof item === 'object').map((item) => ({
      title: String(item.i18n?.[language]?.title || item.title || t('remote.announcements')), body: String(item.i18n?.[language]?.body || item.body || ''), date: String(item.date || ''),
    })) : [],
    servers: (Array.isArray(config.servers) ? config.servers : Array.isArray(config.server) ? config.server : config.server ? [config.server] : [])
      .filter((item) => item && typeof item.address === 'string').map((item) => ({ address: item.address, name: translateMessage(item.i18n?.[language]?.name || item.name || t('remote.defaultServer'), language), role: translateMessage(item.i18n?.[language]?.role || item.role || '', language) })),
    releaseNotes: typeof releaseNotes === 'string' ? releaseNotes : '',
    latest, update, downloadAvailable: update && available,
    versionText: !latest ? '-' : update ? t('update.newVersion', { version: latest }) : t('update.installed', { version }),
    sourceText: snapshot?.debug_local === true
      ? (language === 'en' ? 'Local development' : '本机开发配置') : loaded ? t('remote.updated') : '-',
  };
}
export function launcherActions({ selected, busy, desktop, urls, lan, updateRequired = false }, remoteBusy = false) {
  return {
    choose: Boolean(desktop && !busy && !urls.length && !lan?.running_url && !updateRequired),
    launch: !updateRequired && canLaunch({ selected, busy, desktop }),
    additional: Boolean(desktop && !busy && urls.length && urls.length < 8 && !updateRequired),
    stop: Boolean(desktop && !busy && urls.length),
    refresh: Boolean(desktop && !remoteBusy),
  };
}

export function lanSettings(lan) {
  return {
    port: lan?.settings?.port || 8443,
    httpPort: lan?.settings?.http_port || 8442,
    address: lan?.settings?.address || '',
  };
}
export function lanActions({ desktop, busy, updateRequired, lan, urls = [] }) {
  return {
    configure: Boolean(desktop && !busy && !updateRequired),
    save: Boolean(desktop && !busy && !updateRequired && !urls.length && !lan?.running_url),
  };
}
export function lanRequest(settings, language = 'zh-CN') {
  const t = createTranslator(language);
  const port = Number(settings.port), httpPort = Number(settings.httpPort);
  const address = String(settings.address || '').trim();
  if (![port, httpPort].every((value) => Number.isInteger(value) && value >= 1 && value <= 65535)) throw new Error(t('lan.invalidPorts'));
  if (port === httpPort) throw new Error(t('lan.samePorts'));
  if (!address) return { port, httpPort, address: null };
  const parts = address.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) throw new Error(t('lan.invalidAddress'));
  const [a, b] = parts.map(Number);
  if (!(a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127)) throw new Error(t('lan.invalidAddress'));
  return { port, httpPort, address };
}

export function launchPreferences(value = {}) {
  return { mode: ['online', 'story', 'sandbox'].includes(value.mode) ? value.mode : 'online',
    name: typeof value.name === 'string' ? value.name : '玩家1', server: typeof value.server === 'string' ? value.server : '',
    preset: ['npc_male', 'npc_female', 'freemode_male', 'freemode_female'].includes(value.preset) ? value.preset : 'npc_male',
    map: value.map === 'env_test' ? 'env_test' : 'gtav' };
}
export function launchServer(value, { allowLocal = false } = {}) {
  const input = String(value || '').trim();
  if (!input || input.length > 2048 || /\s/.test(input) || input.startsWith('/')) throw new Error('请输入有效的服务器 IP 或地址。');
  const explicit = input.includes('://');
  let url;
  try { url = new URL(explicit ? input : 'wss://' + input); } catch { throw new Error('服务器地址格式无效。'); }
  const localDevelopment = allowLocal === true && url.protocol === 'ws:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!localDevelopment && url.protocol !== 'wss:') || !url.hostname || url.username || url.password || url.hash) throw new Error('请输入不含用户名、密码或片段的 wss:// 地址。');
  if (url.pathname === '/') url.pathname = '/ws';
  return url.href;
}
export function launchServerOptions(snapshot, language = 'zh-CN') {
  if (snapshot?.source !== 'remote' || snapshot.stale) return [];
  const config = snapshot.config || {}, values = config.servers || config.server || [];
  // Native Rust emits this flag only for an explicit local debug config. A
  // standalone debug app still uses a Vite production bundle (DEV is false).
  const allowLocal = snapshot.debug_local === true;
  return (Array.isArray(values) ? values : [values]).slice(0, 32).flatMap(item => {
    try {
      let server = launchServer(item.websocket_url || item.ws_url || item.address, { allowLocal });
      if (!item.websocket_url && !item.ws_url && !String(item.address).includes('://') && item.health_url) {
        const health = new URL(item.health_url), target = new URL(server), port = url => url.port || '443';
        const pathname = health.pathname.replace(/\/+$/, '');
        if (health.protocol === 'https:' && !health.username && !health.password && !health.hash && health.hostname === target.hostname && port(health) === port(target) && pathname.endsWith('/health')) {
          health.protocol = 'wss:'; health.pathname = pathname.slice(0, -7) + '/ws'; server = launchServer(health.href);
        }
      }
      let healthUrl = '';
      if (typeof item.health_url === 'string') {
        const health = new URL(item.health_url), endpoint = new URL(server);
        const localDevelopment = allowLocal && health.protocol === 'http:' && endpoint.protocol === 'ws:'
          && ['127.0.0.1', 'localhost', '[::1]'].includes(health.hostname);
        const port = url => url.port || (url.protocol === 'http:' || url.protocol === 'ws:' ? '80' : '443');
        if ((health.protocol === 'https:' || localDevelopment) && !health.username && !health.password && !health.hash
          && health.hostname === endpoint.hostname && port(health) === port(endpoint)) healthUrl = health.href;
      }
      const localized = item.i18n?.[language] || {};
      return [{ address: String(item.address), server, health_url: healthUrl, ...(allowLocal ? { debug_local: true } : {}), label: [translateMessage(localized.name || item.name || '', language), translateMessage(localized.role || item.role || '', language), item.address].filter(Boolean).join(' · ') }];
    } catch { return []; }
  });
}
export function launchRequest(value, snapshot, availability = null) {
  const result = launchPreferences(value);
  result.name = result.name.trim();
  if (result.mode === 'online' && (!result.name || Array.from(result.name).length > 24 || /[\u0000-\u001f\u007f]/.test(result.name))) throw new Error('请输入 1 至 24 个字符的昵称。');
  if (result.mode === 'online') {
    const options = launchServerOptions(snapshot), input = result.server.trim();
    const selected = options.find(item => item.address === input || item.server === input);
    if (!selected) throw new Error('请选择已检测可用的服务器线路。');
    if (availability && !availability.some(item => item.address === selected.address && item.available === true)) throw new Error('所选服务器不可用，请选择可用线路或重新检测。');
    result.server = selected.server;
  }
  return result;
}

export function displayLaunchServer(value, options = []) {
  const known = options.find(item => item.server === value || item.address === value);
  if (known) return known.address;
  try { const url = new URL(value); return url.hostname + ':' + (url.port || '443'); } catch { return value || options[0]?.address || ''; }
}
