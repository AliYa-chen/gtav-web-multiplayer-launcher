import { normalizeServerAddress } from './server-address.js';

export const PUBLIC_SERVER = '183.66.27.21:47485';
export const SESSION_KEY = 'gta5.public.session';
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
      <label>服务器 IP 或地址<input name="server" type="text" autocomplete="off" spellcheck="false" placeholder="183.66.27.21:47485" required></label>
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
  const query = new URLSearchParams(location.search);
  const stored = readPublicPreferences();
  let savedName = '';
  try { savedName = localStorage.getItem('gta5.multiplayer.nickname') || ''; } catch { /* 存储被禁用时仍可加入。 */ }
  nickname.value = query.get('name') || stored?.name || savedName || '玩家';
  server.value = query.get('server') || stored?.server || PUBLIC_SERVER;
  preset.value = stored?.preset || 'npc_male';
  let editedName = false, editedServer = false;
  let previousFocus = null;
  nickname.addEventListener('input', () => { editedName = true; });
  server.addEventListener('input', () => { editedServer = true; });

  const setMessage = (text) => { message.textContent = String(text || ''); };
  function open() {
    if (!overlay.hidden) return;
    previousFocus = document.activeElement;
    overlay.hidden = false;
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
    const name = nickname.value.trim();
    if (!name || Array.from(name).length > 24) { setMessage('请输入 1 至 24 个字符的昵称。'); nickname.focus(); return; }
    let address;
    try { address = normalizeServerAddress(server.value, location.href); }
    catch (error) { setMessage(error.message); server.focus(); return; }
    const preferences = { server: address, name, preset: preset.value, seed: newAppearanceSeed() };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(preferences));
    } catch { setMessage('浏览器禁止保存战局设置，请允许此网站的会话存储后重试。'); return; }
    try { localStorage.setItem('gta5.multiplayer.nickname', name); } catch { /* 昵称本次仍会发送给服务器。 */ }
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
      if (!query.has('name') && !stored && !editedName && typeof config.instance_name === 'string') nickname.value = config.instance_name;
      if (!query.has('server') && !stored && !editedServer && typeof config.multiplayer_server === 'string'
        && !/^(?:wss?:\/\/)?(?:localhost|0\.0\.0\.0|127\.0\.0\.1|\[::1\])(?::8787)?(?:\/ws)?\/?$/i.test(config.multiplayer_server)) {
        server.value = config.multiplayer_server;
      }
    }).catch(() => {}).finally(() => clearTimeout(timer));
  return { open, close, setMessage, get isOpen() { return !overlay.hidden; } };
}
