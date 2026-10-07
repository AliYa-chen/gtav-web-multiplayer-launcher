const DEFAULT_PORT = '47485';

// 可独立调用，便于检查域名、IPv4、IPv6 以及 HTTPS 下的地址输入。
export function normalizeServerAddress(value, pageUrl = 'http://localhost:8000/') {
  const page = new URL(pageUrl);
  let address = String(value ?? '').trim();
  if (!address) address = page.hostname;
  if (!address || /\s/.test(address) || address.startsWith('/')) {
    throw new Error('请输入有效的服务器 IP 或地址。');
  }
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(address);
  if (hasScheme && !/^wss?:\/\//i.test(address)) {
    throw new Error('服务器地址仅支持 ws:// 或 wss://。');
  }
  if (!hasScheme) {
    // 不带方括号的 IPv6 地址可直接输入；指定 IPv6 端口时应使用 [::1]:8787。
    if (!address.startsWith('[') && !address.includes('/') && (address.match(/:/g) || []).length > 1) {
      address = '[' + address + ']';
    }
    address = (page.protocol === 'https:' ? 'wss://' : 'ws://') + address;
  }
  let url;
  try { url = new URL(address); }
  catch { throw new Error('服务器地址格式不正确，例如 192.168.1.10:8787 或 [::1]:8787。'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('请输入不含用户名、密码或片段的 ws:// 或 wss:// 地址。');
  }
  if (page.protocol === 'https:' && url.protocol === 'ws:') {
    throw new Error('HTTPS 页面需要 wss:// 服务器地址，请使用加密连接。');
  }
  // URL 会移除显式的标准端口 80/443，需区分它们与未填写端口的情况。
  const authority = address.split('://')[1].split(/[/?#]/)[0];
  const explicitPort = authority.startsWith('[') ? /\]:\d+$/.test(authority) : /:\d+$/.test(authority);
  if (!url.port && !explicitPort) url.port = DEFAULT_PORT;
  if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
  return url.href;
}
