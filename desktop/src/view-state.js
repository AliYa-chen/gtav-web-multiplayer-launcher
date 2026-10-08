export const phases = Object.freeze({ checking: ['识别与校验', 20], engine: ['准备运行引擎', 55], fonts: ['准备游戏字体', 82], ready: ['准备完成', 100] });
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
export function displayDirectory(value) { return value || '尚未选择游戏资源目录'; }
export function canLaunch({ selected, busy, desktop }) { return Boolean(selected && !busy && desktop); }
export function progressValue(phase) { return phases[phase]?.[1] || 0; }

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
export function remotePresentation(snapshot, version, platform = '') {
  const config = snapshot?.config || {};
  const latest = typeof config.latest_version === 'string' ? config.latest_version : '';
  const update = isNewerVersion(latest, version);
  const available = Boolean(platform && config.downloads?.[platform]?.url && config.downloads?.[platform]?.sha256);
  return {
    title: typeof config.oltitle === 'string' ? config.oltitle : '',
    websiteAvailable: Boolean(config.website || /^https:\/\//i.test(config.oltitle || '')),
    announcements: Array.isArray(config.announcements) ? config.announcements.filter((item) => item && typeof item === 'object').map((item) => ({
      title: String(item.title || '战局公告'), body: String(item.body || ''), date: String(item.date || ''),
    })) : [],
    releaseNotes: typeof config.release_notes === 'string' ? config.release_notes : '',
    latest, update, downloadAvailable: update && available,
    versionText: !latest ? '暂无版本信息' : update ? `新版本 ${latest}` : `已安装 ${version}`,
    sourceText: snapshot?.source === 'cache' ? '离线缓存' : snapshot?.source === 'remote' ? '已更新' : '内置配置',
  };
}
export function launcherActions({ selected, busy, desktop, urls }, remoteBusy = false) {
  return {
    choose: Boolean(desktop && !busy && !urls.length),
    launch: canLaunch({ selected, busy, desktop }),
    additional: Boolean(desktop && !busy && urls.length),
    stop: Boolean(desktop && !busy && urls.length),
    refresh: Boolean(desktop && !remoteBusy),
  };
}
