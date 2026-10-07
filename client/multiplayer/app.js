const DEFAULT_PORT = '8787';

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

function initializePublicSession() {
  const byId = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'connect-form', 'server-address', 'nickname', 'avatar', 'connect-button', 'disconnect-button',
    'connection-badge', 'connection-status', 'notice', 'member-count', 'member-list',
    'session-empty', 'game-status', 'game-link', 'game-help',
    'chat-log', 'chat-form', 'chat-input', 'chat-button',
  ].map((id) => [id, byId(id)]));
  const query = new URLSearchParams(location.search);
  const state = { socket: null, status: 'offline', clientId: null, name: '', session: null };
  let connectionTimer = 0;
  let addressEdited = false;
  let nameEdited = false;
  let hasWelcomed = false;
  let hasProfile = false;
  const peerStates = new Map();
  const bridge = typeof BroadcastChannel === 'function' ? new BroadcastChannel('gta5-public-bridge-v1') : null;
  let stateSequence = 0;
  let shotSequence = 0;
  let lastStateSentAt = -Infinity;
  let lastShotSentAt = -Infinity;
  let stateSendTimer = 0;
  let pendingState = null;
  const nicknameKey = 'gta5.multiplayer.nickname';

  let savedName = '';
  try { savedName = localStorage.getItem(nicknameKey) || ''; } catch { /* 隐私模式可禁用存储 */ }
  ui['server-address'].value = query.get('server') || location.hostname + ':' + DEFAULT_PORT;
  ui.nickname.value = query.get('name') || savedName || '玩家';
  ui.avatar.value = 'male';
  // 不同本地端口的模拟玩家各自复用自己的游戏标签页。
  ui['game-link'].target = 'gta5-game-' + (location.port || location.hostname);
  ui['server-address'].addEventListener('input', () => { addressEdited = true; });
  ui.nickname.addEventListener('input', () => { nameEdited = true; });

  function showNotice(message, kind = '') {
    ui.notice.textContent = message;
    ui.notice.dataset.kind = kind;
  }

  function postSession() {
    const connected = state.status === 'connected' && Boolean(state.session);
    bridge?.postMessage({
      type: 'session', connected, client_id: connected ? state.clientId : null,
      peers: connected ? [...peerStates.values()] : [],
      members: connected ? state.session.members.map(({ id, name }) => ({ id, name })) : [],
      avatar: ui.avatar.value === 'female' ? 'female' : 'male',
      game_sync: false,
    });
  }

  const coordinates = (value) => Array.isArray(value) && value.length === 3
    && value.every((number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 16000);
  const unsignedHash = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  function cleanPlayerState(value) {
    if (!value || !coordinates(value.position) || !Number.isFinite(value.heading) || value.heading < 0 || value.heading > 360
      || !unsignedHash(value.model) || !unsignedHash(value.weapon) || !Number.isInteger(value.health)
      || value.health < 0 || value.health > 1000 || typeof value.shooting !== 'boolean') return null;
    return { position: value.position.slice(), heading: value.heading, model: value.model, health: value.health,
      weapon: value.weapon, shooting: value.shooting };
  }
  function cleanShotEvent(value) {
    if (!value || !coordinates(value.origin) || !coordinates(value.target) || !unsignedHash(value.weapon)) return null;
    return { origin: value.origin.slice(), target: value.target.slice(), weapon: value.weapon };
  }
  function flushLocalState() {
    stateSendTimer = 0;
    if (!pendingState || !state.session || state.status !== 'connected') return;
    const delay = Math.max(0, 50 - (performance.now() - lastStateSentAt));
    if (delay || state.socket?.bufferedAmount > 65536) {
      stateSendTimer = setTimeout(flushLocalState, Math.max(10, delay));
      return;
    }
    const next = pendingState;
    pendingState = null;
    if (send('player_state', { seq: ++stateSequence, ...next })) lastStateSentAt = performance.now();
  }
  if (bridge) bridge.onmessage = ({ data }) => {
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'bridge_ready') { postSession(); return; }
    if (!state.session || state.status !== 'connected') return;
    if (data.type === 'local_state') {
      const next = cleanPlayerState(data.state);
      if (!next) return;
      pendingState = next;
      if (!stateSendTimer) flushLocalState();
    } else if (data.type === 'local_shot') {
      const event = cleanShotEvent(data.event);
      const now = performance.now();
      if (!event || now - lastShotSentAt < 50 || state.socket?.bufferedAmount > 65536) return;
      if (send('shot_event', { seq: ++shotSequence, ...event })) lastShotSentAt = now;
    }
    // 同源桥只接受本地角色状态和射击事件，不转发其他操作或任意命令。
  };

  function render() {
    const online = state.status === 'connected';
    const busy = state.status === 'connecting';
    const joined = online && Boolean(state.session);
    ui['connection-badge'].dataset.state = state.status;
    ui['connection-status'].textContent = joined ? '战局在线' : online ? '正在加入…' : busy ? '正在连接…' : '未连接';
    ui['server-address'].disabled = online || busy;
    ui.nickname.disabled = online || busy;
    ui.avatar.disabled = online || busy;
    ui['connect-button'].hidden = online || busy;
    ui['disconnect-button'].hidden = !online && !busy;
    ui['disconnect-button'].textContent = busy ? '取消连接' : '断开连接';
    ui['chat-input'].disabled = !joined;
    ui['chat-button'].disabled = !joined;
    ui['session-empty'].hidden = joined;
    ui['member-list'].hidden = !joined;
    ui['game-link'].hidden = !joined;
    ui['game-help'].hidden = !joined;
    ui['game-status'].textContent = joined ? '已加入 GTA V 公共战局，随时可以进入本地沙盒。'
      : online ? '正在加入 GTA V 公共战局…' : busy ? '正在连接战局服务器…' : '等待连接公共战局。';
    const members = joined ? state.session.members : [];
    ui['member-count'].textContent = String(members.length);
    ui['member-list'].replaceChildren(...members.map((member) => {
      const row = document.createElement('li');
      row.className = 'member';
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = Array.from(member.name)[0] || '人';
      const name = document.createElement('span');
      name.className = 'member-name';
      name.textContent = member.name;
      if (member.id === state.clientId) {
        const tag = document.createElement('span');
        tag.className = 'member-tag';
        tag.textContent = '你';
        name.append(tag);
      }
      const status = document.createElement('span');
      status.className = 'member-state ready';
      status.textContent = '在线';
      row.append(avatar, name, status);
      return row;
    }));
  }

  function endConnection(message, kind = '') {
    const oldSocket = state.socket;
    state.socket = null;
    state.status = 'offline';
    state.clientId = null;
    state.session = null;
    hasWelcomed = false;
    hasProfile = false;
    peerStates.clear();
    pendingState = null;
    clearTimeout(stateSendTimer);
    stateSendTimer = 0;
    stateSequence = shotSequence = 0;
    lastStateSentAt = lastShotSentAt = -Infinity;
    clearTimeout(connectionTimer);
    connectionTimer = 0;
    ui['chat-log'].replaceChildren();
    ui['chat-input'].value = '';
    if (oldSocket) {
      oldSocket.onopen = oldSocket.onmessage = oldSocket.onerror = oldSocket.onclose = null;
      oldSocket.close();
    }
    render();
    postSession();
    if (message) showNotice(message, kind);
  }

  function send(type, fields = {}) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      showNotice('当前未连接，请点击“加入公共战局”后重试。', 'error');
      return false;
    }
    try { state.socket.send(JSON.stringify({ type, ...fields })); return true; }
    catch { endConnection('连接已中断，请重新加入公共战局。', 'error'); return false; }
  }

  function validateSession(session) {
    if (!session || session.id !== 'PUBLIC' || session.map !== 'gta5' || session.phase !== 'launched'
      || session.host_id !== null || !Array.isArray(session.members) || session.members.length > 1024
      || !session.members.every((member) => typeof member.id === 'string' && typeof member.name === 'string')
      || !session.members.some((member) => member.id === state.clientId)) {
      throw new Error('服务器战局不兼容，请使用项目附带的 GTA V 公共战局服务器。');
    }
    return session;
  }

  function receive(message) {
    if (!message || typeof message.type !== 'string') throw new Error('服务器消息格式无效。');
    if (!hasWelcomed && message.type !== 'welcome' && message.type !== 'error') throw new Error('服务器尚未完成连接确认。');
    switch (message.type) {
      case 'welcome': {
        if (hasWelcomed || message.protocol !== 1 || typeof message.client_id !== 'string'
          || !Array.isArray(message.capabilities) || !['public_session', 'chat', 'player_state', 'shoot_events'].every((feature) => message.capabilities.includes(feature))) {
          throw new Error('服务器协议不兼容，请使用项目附带的公共战局服务器。');
        }
        hasWelcomed = true;
        state.clientId = message.client_id;
        send('hello', { name: state.name });
        break;
      }
      case 'profile': {
        if (message.client_id !== state.clientId || typeof message.name !== 'string') throw new Error('服务器玩家信息无效。');
        hasProfile = true;
        state.name = message.name;
        state.status = 'connected';
        showNotice('已连接服务器，正在自动加入公共战局…');
        break;
      }
      case 'room_state': {
        if (message.room === null) throw new Error('你已离开公共战局，请重新连接后加入。');
        const initial = !state.session;
        state.session = validateSession(message.room);
        const members = new Set(state.session.members.map((member) => member.id));
        for (const playerId of peerStates.keys()) if (!members.has(playerId)) peerStates.delete(playerId);
        postSession();
        clearTimeout(connectionTimer);
        connectionTimer = 0;
        if (initial) showNotice('已加入 GTA V 公共战局。所有在线玩家都在同一个战局中。', 'success');
        break;
      }
      case 'chat': {
        if (message.room_id !== state.session?.id) break;
        if (typeof message.text !== 'string' || typeof message.name !== 'string' || message.text.length > 2000) throw new Error('服务器聊天消息格式无效。');
        addChat(message);
        break;
      }
      case 'world_state': {
        if (message.room_id !== state.session?.id) return;
        if (!Array.isArray(message.states) || message.states.length > 1024) throw new Error('服务器战局状态格式无效。');
        peerStates.clear();
        const members = new Set(state.session.members.map((member) => member.id));
        for (const entry of message.states) {
          const player = cleanPlayerState(entry.state);
          if (members.has(entry.player_id) && player && Number.isSafeInteger(entry.state.seq) && entry.state.seq >= 0) {
            peerStates.set(entry.player_id, { player_id: entry.player_id, state: { seq: entry.state.seq, ...player } });
          }
        }
        postSession();
        return;
      }
      case 'player_state': {
        if (message.room_id !== state.session?.id || !state.session.members.some(({ id }) => id === message.player_id)) return;
        const player = cleanPlayerState(message.state);
        if (!player || !Number.isSafeInteger(message.state.seq) || message.state.seq < 0) throw new Error('服务器角色状态格式无效。');
        peerStates.set(message.player_id, { player_id: message.player_id, state: { seq: message.state.seq, ...player } });
        bridge?.postMessage(message);
        return;
      }
      case 'shot_event': {
        if (message.room_id !== state.session?.id || !state.session.members.some(({ id }) => id === message.player_id)) return;
        if (!cleanShotEvent(message.event) || !Number.isSafeInteger(message.event.seq) || message.event.seq < 0) throw new Error('服务器射击事件格式无效。');
        bridge?.postMessage(message);
        return;
      }
      case 'error': {
        const text = typeof message.message === 'string' ? message.message.slice(0, 300) : '服务器未能完成操作，请重试。';
        if (!hasProfile || !state.session) { endConnection(text + ' 请检查服务器地址或昵称后重新连接。', 'error'); return; }
        showNotice(text, 'error');
        break;
      }
      default: throw new Error('服务器消息类型不兼容，请检查服务器版本。');
    }
    render();
  }

  function addChat(message) {
    const log = ui['chat-log'];
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const row = document.createElement('li');
    row.className = 'chat-message';
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    const sender = document.createElement('strong');
    sender.textContent = message.name + (message.sender_id === state.clientId ? '（你）' : '');
    const time = document.createElement('time');
    const stamp = typeof message.time === 'number' ? new Date(message.time * (message.time < 1e12 ? 1000 : 1)) : new Date(message.time);
    if (!Number.isNaN(stamp.getTime())) {
      time.dateTime = stamp.toISOString();
      time.textContent = stamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    meta.append(sender, time);
    const text = document.createElement('p');
    text.textContent = message.text;
    row.append(meta, text);
    log.append(row);
    while (log.children.length > 100) log.firstElementChild.remove();
    if (nearBottom || message.sender_id === state.clientId) log.scrollTop = log.scrollHeight;
  }

  function connect() {
    if (state.status !== 'offline') return;
    const name = ui.nickname.value.trim();
    if (!name || Array.from(name).length > 24) { showNotice('请输入 1 至 24 个字符的昵称。', 'error'); ui.nickname.focus(); return; }
    let address;
    try { address = normalizeServerAddress(ui['server-address'].value, location.href); }
    catch (error) { showNotice(error.message, 'error'); ui['server-address'].focus(); return; }
    endConnection();
    state.name = name;
    ui.nickname.value = name;
    ui['server-address'].value = address;
    try { localStorage.setItem(nicknameKey, name); } catch { /* 每个连接仍拥有独立身份 */ }
    let socket;
    try { socket = new WebSocket(address); }
    catch { showNotice('浏览器无法连接此服务器，请检查地址格式和连接协议。', 'error'); return; }
    state.socket = socket;
    state.status = 'connecting';
    showNotice('正在连接公共战局服务器…');
    render();
    connectionTimer = setTimeout(() => {
      if (state.socket === socket) endConnection('连接超时。请确认公共战局服务器已启动、IP 和端口正确，然后重新加入。', 'error');
    }, 10000);
    socket.onmessage = (event) => {
      if (state.socket !== socket) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw new Error('服务器消息超过允许的大小。');
        receive(JSON.parse(event.data));
      } catch (error) { endConnection(error instanceof SyntaxError ? '服务器消息无法解析，请检查服务器版本。' : error.message, 'error'); }
    };
    socket.onerror = () => {
      if (state.socket === socket) endConnection('连接失败。请确认公共战局服务器已启动，地址和端口正确，并允许防火墙连接。', 'error');
    };
    socket.onclose = () => {
      if (state.socket === socket) endConnection('与服务器的连接已断开，战局状态已清空。点击“加入公共战局”重新连接。', 'error');
    };
  }

  ui['connect-form'].addEventListener('submit', (event) => { event.preventDefault(); connect(); });
  ui['disconnect-button'].addEventListener('click', () => endConnection('已断开公共战局连接。需要时可以重新加入。'));
  ui['chat-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    const text = ui['chat-input'].value.trim();
    if (!text || !state.session) return;
    if (Array.from(text).length > 500) { showNotice('每条聊天消息最多 500 个字符。', 'error'); return; }
    if (send('chat', { text })) ui['chat-input'].value = '';
  });
  addEventListener('pagehide', () => { if (state.socket) endConnection('已断开连接。点击“加入公共战局”重新连接。'); });
  render();

  // 本地启动器可以为多开的实例提供独立昵称；显式地址栏参数优先。
  const configAbort = new AbortController();
  const configTimer = setTimeout(() => configAbort.abort(), 3000);
  fetch('/api/local-config', { signal: configAbort.signal, cache: 'no-store' })
    .then((response) => response.ok ? response.json() : null)
    .then((config) => {
      if (!config || state.status !== 'offline') return;
      if (!query.has('server') && !addressEdited && typeof config.multiplayer_server === 'string') ui['server-address'].value = config.multiplayer_server;
      if (!query.has('name') && !nameEdited && typeof config.instance_name === 'string') ui.nickname.value = config.instance_name;
    })
    .catch(() => { /* 独立部署时使用默认地址，配置接口不是加入战局的前提 */ })
    .finally(() => clearTimeout(configTimer));
}

if (typeof document !== 'undefined' && document.getElementById('connect-form')) initializePublicSession();
