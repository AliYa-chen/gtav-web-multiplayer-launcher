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
  // 完整协议地址使用协议标准端口，裸主机使用战局默认端口。
  // URL 会移除显式的 80/443；再次读取缓存地址时必须保持同一端口。
  const authority = address.split('://')[1].split(/[/?#]/)[0];
  const explicitPort = authority.startsWith('[') ? /\]:\d+$/.test(authority) : /:\d+$/.test(authority);
  if (!url.port && !explicitPort && !hasScheme) url.port = DEFAULT_PORT;
  if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
  return url.href;
}

// 输入框显示用户关心的主机和端口；连接协议与 /ws 路径仅在内部使用。
export function displayServerAddress(value, pageUrl = 'http://localhost:8000/') {
  const url = new URL(normalizeServerAddress(value, pageUrl));
  return url.hostname + ':' + (url.port || (url.protocol === 'wss:' ? '443' : '80'));
}

// 远程列表的显示地址和实际连接端点可以不同；TLS 与代理路径不能从输入框里丢失。
export function normalizeRemoteServerAddress(server, pageUrl = 'http://localhost:8000/') {
  if (!server || typeof server.address !== 'string' || !server.address.trim()) {
    throw new Error('远程服务器地址无效。');
  }
  const explicit = server.websocket_url ?? server.ws_url;
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== 'string' || !/^wss?:\/\//i.test(explicit.trim())) {
      throw new Error('远程 WebSocket 端点必须提供完整的 ws:// 或 wss:// 地址。');
    }
    return normalizeServerAddress(explicit, pageUrl);
  }
  const address = normalizeServerAddress(server.address, pageUrl);
  if (/^wss?:\/\//i.test(server.address.trim())) return address;
  if (typeof server.health_url === 'string' && server.health_url.length <= 2048) {
    try {
      const health = new URL(server.health_url);
      const target = new URL('wss://' + server.address.trim());
      const targetPort = target.port || '443';
      const healthPort = health.port || '443';
      const healthPath = health.pathname.replace(/\/+$/, '');
      if (health.protocol === 'https:' && !health.username && !health.password && !health.hash
        && health.hostname === target.hostname && healthPort === targetPort && /\/health$/.test(healthPath)) {
        health.protocol = 'wss:';
        health.pathname = healthPath.replace(/\/health$/, '/ws');
        return normalizeServerAddress(health.href, pageUrl);
      }
    } catch { /* 健康接口格式不适用时不猜测其它代理路径。 */ }
  }
  return address;
}
