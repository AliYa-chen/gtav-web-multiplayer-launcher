import { getLanguage, onLanguageChange } from '../i18n.js';

// 只读取启动器代理后的配置，不从引擎线程联网，也不执行远程HTML或脚本。
const FALLBACK = Object.freeze({ oltitle: '-', source: 'unavailable', stale: true });
export function cleanOnlineConfiguration(snapshot, language = getLanguage()) {
  if (snapshot?.source !== 'remote' || snapshot.stale !== false) return { ...FALLBACK };
  const localized = snapshot?.config?.i18n?.[language]?.oltitle;
  const value = typeof localized === 'string' && localized.trim() ? localized : snapshot?.config?.oltitle;
  if (typeof value !== 'string' || Array.from(value).length > 160 || !value.trim()
      || /[<>\u0000-\u001f]/.test(value)) return { ...FALLBACK };
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return { ...FALLBACK };
    return { oltitle: url.href.replace(/\/$/, ''), source: 'remote', stale: false };
  } catch {
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return { ...FALLBACK };
    return { oltitle: value.trim(), source: 'remote', stale: false };
  }
}
export function watchOnlineConfiguration(onChange) {
  let closed = false, timer = 0, controller = null, latestSnapshot = null;
  const stopLanguage = onLanguageChange(() => { if (!closed) onChange(cleanOnlineConfiguration(latestSnapshot)); });
  async function update() {
    controller = new AbortController();
    const abort = setTimeout(() => controller?.abort(), 9000);
    try {
      const response = await fetch('/api/remote-config?refresh=1', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('远程配置响应失败');
      const snapshot = await response.json();
      if (!closed) { latestSnapshot = snapshot; onChange(cleanOnlineConfiguration(snapshot)); }
    } catch {
      if (!closed) { latestSnapshot = null; onChange({ ...FALLBACK }); }
    }
    finally { clearTimeout(abort); if (!closed) timer = setTimeout(update, 60000); }
  }
  onChange({ ...FALLBACK }); update();
  return () => { closed = true; stopLanguage(); clearTimeout(timer); controller?.abort(); };
}
