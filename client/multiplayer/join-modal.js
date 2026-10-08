import { normalizeServerAddress, displayServerAddress } from './server-address.js';

export const PUBLIC_SERVER = '183.66.27.21:47485';
export const SESSION_KEY = 'gta5.public.session';
export const PREFERENCES_KEY = 'gta5.public.preferences';
const FRESH_JOIN_KEY = 'gta5.public.pending-join';
const RESOURCE_CHECK_PENDING = '正在检查多人运行副本，请稍候…';
const RESOURCE_CHECK_MISSING = '多人运行副本尚未就绪。请先运行 python3 tools/build_multiplayer_client.py（自定义资源目录需附加对应的 --game-dir 和 --runtime-dir），再重启 serve_local.py 并刷新页面。';
export const ROLE_PRESETS = Object.freeze(['npc_male', 'npc_female', 'freemode_male', 'freemode_female']);

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
      <label>服务器 IP:端口<input name="server" type="text" autocomplete="off" spellcheck="false" placeholder="183.66.27.21:47485" required></label>
      <label>角色预设<select name="preset"><option value="npc_male">随机男性 NPC</option><option value="npc_female">随机女性 NPC</option><option value="freemode_male">男性自由模式角色</option><option value="freemode_female">女性自由模式角色</option></select></label>
      <p class="online-join__hint" id="online-join-hint">角色会生成随机服饰与适用妆容。所有玩家加入同一个 GTA V 公共战局。</p>
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
  function inputAddress() {
    // 保留已存储的 WSS 协议；只改显示形式不能把安全连接变成普通 WS。
    return server.value.trim() === displayServerAddress(connectionAddress, location.href)
      ? connectionAddress : normalizeServerAddress(server.value, location.href);
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
  }
  function close() {
    overlay.hidden = true;
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
      if (!query.has('server') && !panel && !stored && !editedServer && typeof config.multiplayer_server === 'string'
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
