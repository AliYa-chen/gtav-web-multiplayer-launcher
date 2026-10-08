// 只读取启动器代理后的配置，不从引擎线程联网，也不执行远程HTML或脚本。
const FALLBACK = Object.freeze({ oltitle: 'https://gtav.2t.hk', source: 'default', stale: true });
export function cleanOnlineConfiguration(snapshot) {
  const value = snapshot?.config?.oltitle;
  if (typeof value !== 'string' || Array.from(value).length > 160 || !value.trim()
      || /[<>\u0000-\u001f]/.test(value)) return { ...FALLBACK };
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return { ...FALLBACK };
    return { oltitle: url.href.replace(/\/$/, ''), source: ['remote', 'cache', 'default'].includes(snapshot.source) ? snapshot.source : 'default',
      stale: snapshot.stale !== false };
  } catch {
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return { ...FALLBACK };
    return { oltitle: value.trim(), source: ['remote', 'cache', 'default'].includes(snapshot.source) ? snapshot.source : 'default',
      stale: snapshot.stale !== false };
  }
}
export function watchOnlineConfiguration(onChange) {
  let closed = false, timer = 0, controller = null;
  async function update() {
    controller = new AbortController();
    const abort = setTimeout(() => controller?.abort(), 4000);
    try {
      const response = await fetch('/api/remote-config', { cache: 'no-store', signal: controller.signal });
      if (response.ok) {
        const snapshot = await response.json();
        if (!closed) onChange(cleanOnlineConfiguration(snapshot));
      }
    } catch { /* 配置暂时离线不影响游戏连接，也不清除最后可用文案。 */ }
    finally { clearTimeout(abort); if (!closed) timer = setTimeout(update, 60000); }
  }
  onChange({ ...FALLBACK }); update();
  return () => { closed = true; clearTimeout(timer); controller?.abort(); };
}
