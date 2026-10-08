import { normalizeServerAddress, displayServerAddress } from './server-address.js';

export const PUBLIC_SERVER = '183.66.27.21:47485';
export const SESSION_KEY = 'gta5.public.session';
export const PREFERENCES_KEY = 'gta5.public.preferences';
const FRESH_JOIN_KEY = 'gta5.public.pending-join';
const RESOURCE_CHECK_PENDING = '正在检查多人运行副本，请稍候…';
const RESOURCE_CHECK_MISSING = '多人运行副本尚未就绪。请先运行 python3 tools/build_multiplayer_client.py（自定义资源目录需附加对应的 --game-dir 和 --runtime-dir），再重启 serve_local.py 并刷新页面。';
export const ROLE_PRESETS = Object.freeze(['npc_male', 'npc_female', 'freemode_male', 'freemode_female']);

// 服务器列表只来自本次有效响应；显示内容通过 DOM 文本属性写入。
export function cleanJoinServerOptions(snapshot, pageUrl = globalThis.location?.href) {
  if (snapshot?.source !== 'remote' || snapshot.stale === true) return [];
  const config = snapshot?.config;
  const values = Array.isArray(config?.servers) ? config.servers : Array.isArray(config?.server)
    ? config.server : config?.server && typeof config.server === 'object' ? [config.server] : [];
  const result = [], seen = new Set();
  const text = (value, limit) => typeof value === 'string'
    ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, limit).join('') : '';
  for (const value of values.slice(0, 32)) {
    if (!value || typeof value.address !== 'string' || !value.address.trim() || value.address.length > 512) continue;
    try {
      const address = normalizeServerAddress(value.address, pageUrl);
      const display = displayServerAddress(address, pageUrl);
      if (seen.has(display)) continue;
      seen.add(display);
      const id = text(value.id, 80), name = text(value.name, 80), role = text(value.role, 40);
      result.push({ id, name, role, address, display,
        label: [name, role, display].filter(Boolean).join(' · ') });
    } catch { /* 无效线路不影响其他线路，也不限制手动输入。 */ }
  }
  return result;
}

export function readPublicPreferences(storage, pageUrl = globalThis.location?.href) {
  try {
    storage ||= globalThis.sessionStorage;
    const value = JSON.parse(storage.getItem(SESSION_KEY));
    if (!value || typeof value.server !== 'string' || !value.server.trim()
      || !ROLE_PRESETS.includes(value.preset) || typeof value.name !== 'string'
      || !value.name.trim() || Array.from(value.name).length > 24 || !Number.isInteger(value.seed)
      || value.seed < 0 || value.seed > 0xffffffff) return null;
    return { server: normalizeServerAddress(value.server, pageUrl), name: value.name.trim(), preset: value.preset, seed: value.seed };
  } catch { return null; }
}

export function readPanelPreferences(storage, pageUrl = globalThis.location?.href) {
  try {
    storage ||= globalThis.localStorage;
    const value = JSON.parse(storage.getItem(PREFERENCES_KEY));
    if (!value || typeof value.name !== 'string' || !value.name.trim()
      || Array.from(value.name.trim()).length > 24 || !ROLE_PRESETS.includes(value.preset)
      || typeof value.server !== 'string' || !value.server.trim()) return null;
    return { name: value.name.trim(), preset: value.preset,
      server: normalizeServerAddress(value.server, pageUrl) };
  } catch { return null; }
}

export function savePanelPreferences(value, storage, pageUrl = globalThis.location?.href) {
  try {
    storage ||= globalThis.localStorage;
    const name = String(value?.name || '').trim();
    if (!name || Array.from(name).length > 24 || !ROLE_PRESETS.includes(value?.preset)) return false;
    const server = normalizeServerAddress(value.server, pageUrl);
    storage.setItem(PREFERENCES_KEY, JSON.stringify({ name, server, preset: value.preset }));
    return true;
  }
  catch { return false; }
}

// 一次性标记区分主动加入与刷新恢复；身份凭据仍仅保存在当前标签页。
export function consumePublicEntryIntent(navigationType, storage) {
  try {
    storage ||= globalThis.sessionStorage;
    const fresh = storage.getItem(FRESH_JOIN_KEY) === '1';
    storage.removeItem(FRESH_JOIN_KEY);
    return navigationType === 'reload' || navigationType === 'back_forward' || !fresh;
  } catch { return true; }
}

function newAppearanceSeed() {
  if (globalThis.crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * 0x100000000);
}

export function installJoinModal({ onJoin } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'online-join';
  overlay.hidden = true;
  overlay.innerHTML = `<section class="online-join__panel" role="dialog" aria-modal="true" aria-labelledby="online-join-title" aria-describedby="online-join-hint">
    <div class="online-join__header"><div><p class="online-join__eyebrow">GTA V · 公共战局</p><h1 id="online-join-title">加入在线战局</h1></div><button class="online-join__close" type="button" aria-label="关闭加入战局">×</button></div>
    <form>
      <label>您的昵称<input name="nickname" autocomplete="nickname" maxlength="48" placeholder="输入昵称" required></label>
      <label>服务器 IP:端口<input name="server" type="text" list="online-join-server-options" autocomplete="off" spellcheck="false" placeholder="选择线路或输入 IP:端口" aria-describedby="online-join-server-hint" required><datalist id="online-join-server-options"></datalist><span class="online-join__hint" id="online-join-server-hint">-</span></label>
      <label>角色预设<select name="preset"><option value="npc_male">随机男性 NPC</option><option value="npc_female">随机女性 NPC</option><option value="freemode_male">男性自由模式角色</option><option value="freemode_female">女性自由模式角色</option></select></label>
      <p class="online-join__hint" id="online-join-hint">角色会生成随机服饰与适用妆容。选择同一条线路的玩家进入同一个 GTA V 公共战局。</p>
      <p class="online-join__message" role="status" aria-live="polite"></p>
      <button class="online-join__submit" type="submit">加入战局</button>
    </form>
  </section>`;
  document.body.append(overlay);
  const form = overlay.querySelector('form');
  const nickname = form.elements.namedItem('nickname');
  const server = form.elements.namedItem('server');
  const preset = form.elements.namedItem('preset');
  const message = overlay.querySelector('.online-join__message');
  const submitButton = overlay.querySelector('.online-join__submit');
  const serverList = overlay.querySelector('#online-join-server-options');
  const serverHint = overlay.querySelector('#online-join-server-hint');
  let resourceCheck = 'pending';
  submitButton.disabled = true;
  const query = new URLSearchParams(location.search);
  const stored = readPublicPreferences();
  const panel = readPanelPreferences();
  let savedName = '';
  try { savedName = localStorage.getItem('gta5.multiplayer.nickname') || ''; } catch { /* 存储被禁用时仍可加入。 */ }
  nickname.value = query.get('name') || panel?.name || stored?.name || savedName || '玩家';
  let connectionAddress;
  try { connectionAddress = normalizeServerAddress(query.get('server') || panel?.server || stored?.server || PUBLIC_SERVER, location.href); }
  catch { connectionAddress = normalizeServerAddress(PUBLIC_SERVER, location.href); }
  server.value = displayServerAddress(connectionAddress, location.href);
  preset.value = panel?.preset || stored?.preset || 'npc_male';
  let editedName = false, editedServer = false;
  let previousFocus = null;
  let serverOptions = [], remoteRequest = 0, remoteController = null, remoteDefaultSelected = false;
  function inputAddress() {
    // 保留已存储的 WSS 协议；只改显示形式不能把安全连接变成普通 WS。
    const value = server.value.trim();
    if (value === displayServerAddress(connectionAddress, location.href)) return connectionAddress;
    const option = serverOptions.find((item) => item.display === value);
    return option?.address || normalizeServerAddress(value, location.href);
  }
  function persistPanel() {
    try {
      const address = inputAddress();
      if (savePanelPreferences({ name: nickname.value, server: address, preset: preset.value }, undefined, location.href)) connectionAddress = address;
    } catch { /* 正在输入不完整地址时保留上一个有效设置。 */ }
  }
  nickname.addEventListener('input', () => { editedName = true; persistPanel(); });
  server.addEventListener('input', () => { editedServer = true; persistPanel(); });
  server.addEventListener('blur', () => {
    try { connectionAddress = inputAddress(); server.value = displayServerAddress(connectionAddress, location.href); }
    catch { /* 提交时显示具体校验信息。 */ }
  });
  preset.addEventListener('change', persistPanel);

  const setMessage = (text) => { message.textContent = String(text || ''); };
  function clearServerOptions() {
    serverOptions = [];
    serverList.replaceChildren();
    serverHint.textContent = '-';
  }
  async function refreshServerOptions() {
    const request = ++remoteRequest;
    remoteController?.abort();
    const controller = remoteController = new AbortController();
    const initialInput = server.value;
    clearServerOptions();
    serverHint.textContent = '正在读取服务器线路…';
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch('/api/remote-config?refresh=1', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('服务器线路请求失败');
      const snapshot = await response.json();
      if (request !== remoteRequest || overlay.hidden) return;
      serverOptions = cleanJoinServerOptions(snapshot, location.href);
      for (const item of serverOptions) {
        const option = document.createElement('option');
        option.value = item.display;
        option.label = item.label;
        option.textContent = item.label;
        serverList.append(option);
      }
      serverHint.textContent = serverOptions.length ? '可选择线路，也可手动输入 IP:端口。' : '-';
      if (!query.has('server') && !panel && !stored && !editedServer && server.value === initialInput && serverOptions.length) {
        const preferred = serverOptions.find((item) => item.id === 'main') || serverOptions[0];
        connectionAddress = preferred.address;
        server.value = preferred.display;
        remoteDefaultSelected = true;
      }
    } catch {
      if (request === remoteRequest && !overlay.hidden) clearServerOptions();
    } finally {
      clearTimeout(timeout);
      if (request === remoteRequest) remoteController = null;
    }
  }
  function open() {
    if (!overlay.hidden) return;
    previousFocus = document.activeElement;
    overlay.hidden = false;
    if (resourceCheck === 'pending') setMessage(RESOURCE_CHECK_PENDING);
    else if (resourceCheck === 'missing') setMessage(RESOURCE_CHECK_MISSING);
    document.exitPointerLock?.();
    overlay.dispatchEvent(new Event('online-modal-open', { bubbles: true }));
    nickname.focus();
    nickname.select();
    refreshServerOptions();
  }
  function close() {
    overlay.hidden = true;
    ++remoteRequest;
    remoteController?.abort();
    remoteController = null;
    clearServerOptions();
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  overlay.querySelector('.online-join__close').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const targets = [...overlay.querySelectorAll('button,input,select')].filter((element) => !element.disabled);
    const first = targets[0], last = targets.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // 同时守住表单提交和按钮点击，避免配置尚未返回时先请求不存在的 WASM。
    if (resourceCheck === 'pending') { setMessage(RESOURCE_CHECK_PENDING); return; }
    if (resourceCheck === 'missing') { setMessage(RESOURCE_CHECK_MISSING); return; }
    const name = nickname.value.trim();
    if (!name || Array.from(name).length > 24) { setMessage('请输入 1 至 24 个字符的昵称。'); nickname.focus(); return; }
    let address;
    try { address = inputAddress(); }
    catch (error) { setMessage(error.message); server.focus(); return; }
    const preferences = { server: address, name, preset: preset.value, seed: newAppearanceSeed() };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(preferences));
      sessionStorage.setItem(FRESH_JOIN_KEY, '1');
    } catch { setMessage('浏览器禁止保存战局设置，请允许此网站的会话存储后重试。'); return; }
    try { localStorage.setItem('gta5.multiplayer.nickname', name); } catch { /* 昵称本次仍会发送给服务器。 */ }
    savePanelPreferences(preferences, undefined, location.href);
    connectionAddress = address;
    server.value = displayServerAddress(address, location.href);
    setMessage('正在加入战局…');
    onJoin?.(preferences);
  });

  // 显式 URL 参数和用户输入优先。启动器的本机默认值不能覆盖公网地址。
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3000);
  fetch('/api/local-config', { cache: 'no-store', signal: abort.signal })
    .then((response) => response.ok ? response.json() : null)
    .then((config) => {
      if (!config) return;
      // 只有启动器明确报告缺少适配器时才阻止加入；旧服务与静态部署可以没有此接口。
      if (config.multiplayer_ready === false) resourceCheck = 'missing';
      if (!query.has('name') && !panel && !stored && !editedName && typeof config.instance_name === 'string') nickname.value = config.instance_name;
      if (!query.has('server') && !panel && !stored && !editedServer && !remoteDefaultSelected && typeof config.multiplayer_server === 'string'
        && !/^(?:wss?:\/\/)?(?:localhost|0\.0\.0\.0|127\.0\.0\.1|\[::1\])(?::8787)?(?:\/ws)?\/?$/i.test(config.multiplayer_server)) {
        try {
          connectionAddress = normalizeServerAddress(config.multiplayer_server, location.href);
          server.value = displayServerAddress(connectionAddress, location.href);
        } catch { /* 无效启动配置不覆盖正常公网地址。 */ }
      }
    }).catch(() => {}).finally(() => {
      clearTimeout(timer);
      if (resourceCheck === 'pending') resourceCheck = 'ready';
      submitButton.disabled = resourceCheck === 'missing';
      if (resourceCheck === 'missing') setMessage(RESOURCE_CHECK_MISSING);
      else if (message.textContent === RESOURCE_CHECK_PENDING) setMessage('');
    });
  return { open, close, setMessage, get isOpen() { return !overlay.hidden; } };
}
