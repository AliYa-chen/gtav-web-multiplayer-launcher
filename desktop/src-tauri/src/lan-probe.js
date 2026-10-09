/* The HTTP guide can test trust; it cannot install a certificate or bypass TLS. */
(function (root) {
  'use strict';
  function createProbe(options) {
    const request = options.fetch || root.fetch.bind(root);
    const timeoutMs = options.timeoutMs || 6000;
    const schedule = options.setTimeout || root.setTimeout.bind(root);
    const cancel = options.clearTimeout || root.clearTimeout.bind(root);
    let pending = false;
    let redirected = false;
    function status(key, fallback, ready = false) {
      let message = fallback;
      try {
        const translated = options.translate?.(key, fallback);
        if (typeof translated === 'string' && translated) message = translated;
      } catch { /* A missing translation cannot change certificate verification. */ }
      options.status?.(message, ready, key);
    }
    async function check() {
      if (pending || redirected) return false;
      pending = true;
      const controller = new AbortController();
      let timer;
      try {
        status('status.checking', '正在检测 HTTPS 证书信任…');
        const result = await Promise.race([
          (async function () {
            const response = await request(new URL('api/lan/ready', options.httpsUrl).href, {
              method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store',
              redirect: 'error', signal: controller.signal,
            });
            if (!response.ok || response.type === 'opaque') throw new Error('not-ready');
            return response.json();
          })(),
          new Promise((_, reject) => {
            timer = schedule(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
          }),
        ]);
        if (!result || result.ready !== true || result.fingerprint !== options.fingerprint) {
          throw new Error('identity-mismatch');
        }
        redirected = true;
        status('status.verified', '已验证资源主机证书，正在进入游戏…', true);
        options.redirect(options.httpsUrl);
        return true;
      } catch (error) {
        if (error.message === 'identity-mismatch') status('status.mismatch', '证书身份不一致，请核对资源主机上显示的指纹。');
        else status('status.untrusted', '尚未通过 HTTPS 验证。请安装并信任资源主机 CA，然后刷新或点击重新检测。');
        return false;
      } finally {
        cancel(timer);
        controller.abort();
        pending = false;
      }
    }
    return { check };
  }
  root.GTA5LanProbe = { createProbe };
})(typeof window === 'undefined' ? globalThis : window);
