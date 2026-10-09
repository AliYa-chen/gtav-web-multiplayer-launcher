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
  const update = isNewerVersion(latest, version);
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
    sourceText: loaded ? t('remote.updated') : '-',
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
