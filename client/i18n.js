// All browser surfaces read the launcher's shared language configuration. The
// game service protocol and user-authored names are deliberately independent.
const messages = Object.freeze({
  'language.reload': ['语言已更新。游戏菜单语言会在下次进入游戏时应用。', 'Language updated. Game menus will use it the next time you enter the game.'],
  'page.starting': ['正在启动…', 'Starting…'],
  'page.loading': ['加载中…', 'Loading…'],
  'join.eyebrow': ['GTA V · 公共战局', 'GTA V · Public Session'],
  'join.title': ['加入在线战局', 'Join an Online Session'],
  'join.close': ['关闭加入战局', 'Close session dialog'],
  'join.nickname': ['您的昵称', 'Your nickname'],
  'join.nicknamePlaceholder': ['输入昵称', 'Enter your nickname'],
  'join.server': ['服务器 IP:端口', 'Server IP:port'],
  'join.serverPlaceholder': ['选择线路或输入 IP:端口', 'Choose a server or enter IP:port'],
  'join.preset': ['角色预设', 'Character preset'],
  'join.npc_male': ['随机男性 NPC', 'Random male NPC'],
  'join.npc_female': ['随机女性 NPC', 'Random female NPC'],
  'join.freemode_male': ['男性自由模式角色', 'Male freemode character'],
  'join.freemode_female': ['女性自由模式角色', 'Female freemode character'],
  'join.hint': ['角色会生成随机服饰与适用妆容。选择同一条线路的玩家进入同一个 GTA V 公共战局。', 'Clothing and compatible makeup are randomized. Players on the same server join the same GTA V public session.'],
  'join.submit': ['加入战局', 'Join Session'],
  'join.defaultName': ['玩家', 'Player'],
  'join.saveFailed': ['无法保存本次战局设置，请允许此页面使用会话存储后重试。', 'Could not save session settings. Allow session storage for this page, then try again.'],
  'join.checkPending': ['正在检查多人运行副本，请稍候…', 'Checking the multiplayer runtime, please wait…'],
  'join.checkMissing': ['多人运行副本尚未就绪。请先运行 python3 tools/build_multiplayer_client.py（自定义资源目录需附加对应的 --game-dir 和 --runtime-dir），再重启 serve_local.py 并刷新页面。', 'The multiplayer runtime is not ready. Run python3 tools/build_multiplayer_client.py (add --game-dir and --runtime-dir for custom resources), then restart serve_local.py and refresh this page.'],
  'page.crash': ['游戏已停止（{kind}）：{reason}{advice}', 'The game stopped ({kind}): {reason}{advice}'],
  'page.crashMemory': ['。可能与内存不足有关，请关闭其他标签页后刷新。', '. Memory may be low. Close other tabs and refresh.'],
  'page.crashRefresh': ['。请刷新页面。', '. Please refresh this page.'],
  'page.gpuLost': ['显卡连接已中断（{reason}），画面无法继续显示。请刷新页面。', 'The graphics device disconnected ({reason}). Rendering cannot continue. Please refresh this page.'],
  'page.loadFailed': ['加载失败：{reason}', 'Loading failed: {reason}'],
  'page.stall': ['已 {seconds} 秒没有加载进展{step}。设备可能内存不足，请关闭其他标签页或刷新。', 'No loading progress for {seconds} seconds{step}. Memory may be low. Close other tabs or refresh.'],
  'page.lastStep': ['（上一步：{step}）', ' (last step: {step})'],
  'page.data': ['游戏数据：{mb} MB{speed}', 'Game data: {mb} MB{speed}'],
  'page.fps': ['{fps} 帧/秒', '{fps} FPS'],
  'page.lowMemory': ['已启用低内存模式（浏览器报告 {gb} GB）：请关闭其他标签页。若出现“Aw, Snap!”（崩溃提示）或 SIGILL，表示内存不足。', 'Low-memory mode is enabled (browser reports {gb} GB). Close other tabs. An “Aw, Snap!” crash or SIGILL indicates insufficient memory.'],
  'page.workerError': ['游戏工作线程出错：{reason}', 'Game worker error: {reason}'],
  'progress.downloadingCompile': ['正在下载并编译游戏引擎（{value}）', 'Downloading and compiling the engine ({value})'],
  'progress.downloading': ['正在下载游戏引擎（{value}）', 'Downloading the engine ({value})'],
  'progress.busy': ['服务器繁忙，正在重试（第 {value} 次）', 'The server is busy, retrying ({value})'],
});

// Source aliases cover diagnostics received from the unchanged engine and
// existing connection errors. Unknown diagnostics remain intact for support.
const textPairs = [
  ['返回', 'Back'], ['退格', 'Backspace'], ['GTA V 地图', 'GTA V Map'], ['GTA VI 地图', 'GTA VI Map'],
  ['沙盒模式', 'Sandbox Mode'], ['空格', 'Space'], ['故事模式', 'Story Mode'], ['回车', 'Enter'],
  ['正在加载故事模式', 'Loading Story Mode'], ['正在加载沙盒模式：GTA V 地图', 'Loading Sandbox: GTA V Map'],
  ['正在加载沙盒模式：GTA VI 地图', 'Loading Sandbox: GTA VI Map'], ['恢复战局中', 'Rejoining Session'],
  ['加入战局中', 'Joining Session'], ['请选择地图以继续', 'Choose a map to continue'],
  ['请选择故事模式、沙盒模式或在线战局以继续', 'Choose Story Mode, Sandbox Mode, or an Online Session to continue'],
  ['正在读取服务器线路…', 'Loading servers…'], ['可选择线路，也可手动输入 IP:端口。', 'Choose a server or enter IP:port manually.'],
  ['请选择远程线路或输入服务器 IP:端口。', 'Choose a server or enter its IP:port.'],
  ['服务器线路请求失败', 'Could not load the server list'], ['请输入 1 至 24 个字符的昵称。', 'Enter a nickname with 1 to 24 characters.'],
  ['浏览器禁止保存战局设置，请允许此网站的会话存储后重试。', 'Your browser cannot save session settings. Allow session storage for this site and try again.'],
  ['正在加入战局…', 'Joining session…'], ['主线路', 'Main server'], ['实验线路', 'Experimental server'],
  ['公共战局', 'Public Session'], ['实验战局', 'Experimental Session'],
  ['请输入有效的服务器 IP 或地址。', 'Enter a valid server IP or address.'],
  ['服务器地址仅支持 ws:// 或 wss://。', 'Server addresses must use ws:// or wss://.'],
  ['服务器地址格式不正确，例如 192.168.1.10:8787 或 [::1]:8787。', 'Invalid server address. For example: 192.168.1.10:8787 or [::1]:8787.'],
  ['请输入不含用户名、密码或片段的 ws:// 或 wss:// 地址。', 'Enter a ws:// or wss:// address without credentials or a fragment.'],
  ['HTTPS 页面需要 wss:// 服务器地址，请使用加密连接。', 'HTTPS pages require a wss:// server address. Use an encrypted connection.'],
  ['远程服务器地址无效。', 'Invalid remote server address.'],
  ['远程 WebSocket 端点必须提供完整的 ws:// 或 wss:// 地址。', 'The remote WebSocket endpoint must be a complete ws:// or wss:// address.'],
  ['远程配置响应失败', 'Could not load remote configuration'],
  ['连接超时，请检查服务器地址及端口后重试。', 'Connection timed out. Check the server address and port, then try again.'],
  ['已退出公共战局', 'Left Public Session'], [' 正在重新连接…', ' Reconnecting…'],
  ['服务器长时间未响应。', 'The server has not responded for too long.'],
  ['服务器战局不兼容，请使用 GTA V 公共战局服务器。', 'Incompatible session. Use a GTA V public session server.'],
  ['服务器消息格式无效。', 'Invalid server message.'], ['服务器尚未完成连接确认。', 'The server has not confirmed the connection.'],
  ['服务器协议不兼容。', 'Incompatible server protocol.'], ['服务器武器规则格式无效。', 'Invalid server weapon rules.'],
  ['服务器战局脚本策略格式无效。', 'Invalid server session script policy.'],
  ['服务器未提供已声明的战局脚本策略。', 'The server did not provide its declared session script policy.'],
  ['服务器未提供入局确认状态。', 'The server did not provide its entry readiness state.'],
  ['服务器玩家信息无效。', 'Invalid player information from the server.'], ['服务器尚未确认玩家身份。', 'The server has not confirmed your identity.'],
  ['已加入公共战局', 'Joined Public Session'], ['服务器战局状态格式无效。', 'Invalid session state from the server.'],
  ['正在同步公共战局玩家', 'Synchronizing Public Session Players'],
  ['服务器投射物事件格式无效。', 'Invalid projectile event from the server.'], ['服务器投射物基线格式无效。', 'Invalid projectile baseline from the server.'],
  ['服务器角色状态格式无效。', 'Invalid character state from the server.'], ['服务器射击事件格式无效。', 'Invalid shot event from the server.'],
  ['服务器心跳格式无效。', 'Invalid server heartbeat.'], ['碰撞观测未通过服务器校验，本次判定已跳过。', 'The server rejected the collision observation. This result was skipped.'],
  ['服务器武器目录不识别当前武器，请更新服务端资源目录。', 'The server does not recognize this weapon. Update its weapon catalog.'],
  ['武器切换尚未同步，请稍后重新射击。', 'The weapon change has not synchronized yet. Try firing again shortly.'],
  ['服务器未接受这次操作', 'The server did not accept this action'], ['服务器未能完成操作。', 'The server could not complete this action.'],
  ['服务器消息类型不兼容，请检查服务器版本。', 'Incompatible server message type. Check the server version.'],
  ['正在连接服务器', 'Connecting to Server'], ['无法连接服务器。', 'Cannot connect to the server.'], ['服务器连接超时。', 'The server connection timed out.'],
  ['服务器消息超过允许的大小。', 'The server message exceeds the allowed size.'], ['服务器消息无法解析。', 'Cannot parse the server message.'],
  ['连接失败，请检查服务器 IP 和端口。', 'Connection failed. Check the server IP and port.'], ['战局连接已中断。', 'The session connection was interrupted.'],
  ['游戏桥接收器必须是函数。', 'The game bridge receiver must be a function.'], ['已取消连接。', 'Connection cancelled.'],
  ['连接未完成，请确认战局服务器地址', 'Connection incomplete. Check the session server address'],
  ['请输入昵称与服务器地址以加入战局', 'Enter your nickname and server address to join a session'],
  ['页面未启用跨域隔离：请通过 HTTPS 或 localhost 打开，并确认服务器发送了 COOP/COEP 响应头。', 'Cross-origin isolation is unavailable. Open via HTTPS or localhost and ensure the host sends COOP/COEP headers.'],
  ['点击游戏画面以锁定鼠标（Esc 释放鼠标）', 'Click the game to lock the pointer (Esc to release)'],
  ['点击游戏画面以锁定鼠标（Esc 释放鼠标，Shift+P 切换键盘模式，= 显示帧率）', 'Click the game to lock the pointer (Esc to release, Shift+P to change keyboard mode, = to show FPS)'],
  ['错误', 'Error'], ['未处理的异常', 'Unhandled exception'], ['中止', 'Abort'], ['退出', 'Exit'],
  ['正在编译游戏引擎', 'Compiling the engine'], ['正在启动游戏引擎', 'Starting the engine'], ['正在挂载资源包', 'Mounting archives'],
  ['正在读取设置', 'Reading settings'], ['正在初始化图形', 'Starting graphics'], ['正在加载着色器', 'Loading shaders'],
  ['正在加载文字资源', 'Loading text'], ['正在启动音频', 'Starting audio'], ['正在加载音频信息', 'Loading audio metadata'],
  ['正在启动游戏脚本', 'Starting scripts'], ['正在加载游戏世界', 'Loading the world'], ['正在生成第一帧', 'First frame'],
  ['正在准备着色器', 'Preparing shaders'], ['加载完成', 'Ready'],
  ['请点击“确定”终止程序，当前无法安全继续运行。', 'Press Ok to abort the program.  It is not safe to continue.'],
  ['运行时错误：内存访问越界', 'RuntimeError: memory access out of bounds'], ['运行时错误：执行到不可达指令', 'RuntimeError: unreachable'],
];

export function resolveLanguage(value) { return /^zh(?:-|_|$)/i.test(String(value || '')) ? 'zh-CN' : 'en'; }
const browserLanguage = () => resolveLanguage(globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || 'en');
let languageConfig = { preference: 'system', resolved: browserLanguage(), revision: 0 };
let launcherConfigured = false, initPromise = null, pollTimer = 0, pollController = null, closed = false, requestSequence = 0;
const listeners = new Set();
const aliases = new Map(textPairs.flatMap(pair => pair.map(value => [value, pair])));
for (const pair of Object.values(messages)) for (const value of pair) aliases.set(value, pair);

export function getLanguage() { return languageConfig.resolved; }
export function t(key, params = {}) {
  const pair = messages[key];
  const text = pair ? pair[getLanguage() === 'en' ? 1 : 0] : String(key);
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
export function translateText(value) {
  const text = String(value ?? ''), pair = aliases.get(text);
  if (pair) return pair[getLanguage() === 'en' ? 1 : 0];
  for (const [pattern, key] of [
    [/^(?:Downloading and compiling the engine \(|正在下载并编译游戏引擎（)(.*)[)）]$/, 'progress.downloadingCompile'],
    [/^(?:Downloading the engine \(|正在下载游戏引擎（)(.*)[)）]$/, 'progress.downloading'],
    [/^(?:The server is busy, retrying \(|服务器繁忙，正在重试（第 )(\d+)(?:\)| 次）)$/, 'progress.busy'],
  ]) { const match = pattern.exec(text); if (match) return t(key, { value: match[1] }); }
  const reconnect = /^(.*)(?: 正在重新连接…| Reconnecting…)$/.exec(text);
  if (reconnect) return translateText(reconnect[1]) + translateText(' 正在重新连接…');
  const prefixPairs = [
    ['游戏引擎下载失败：', 'engine download failed: '], ['Scaleform 字体预加载失败：', 'Scaleform font preload failed: '],
    ['工作线程出错：', 'worker error: '],
  ];
  for (const pair of prefixPairs) for (const prefix of pair) if (text.startsWith(prefix)) return pair[getLanguage() === 'en' ? 1 : 0] + translateText(text.slice(prefix.length));
  if (getLanguage() === 'en') return text.replace(/线程异常（([^)]+)）：/g, 'THREAD REJECTION ($1): ')
    .replace(/运行时错误：内存访问越界/g, 'RuntimeError: memory access out of bounds').replace(/运行时错误：执行到不可达指令/g, 'RuntimeError: unreachable');
  return text.replace(/THREAD REJECTION \(([^)]+)\): /g, '线程异常（$1）：')
    .replace(/RuntimeError: memory access out of bounds/g, '运行时错误：内存访问越界').replace(/RuntimeError: unreachable/g, '运行时错误：执行到不可达指令')
    .replace(/^\[wasm\] hang report (\d+): no engine log line for (\d+) s; blocked threads:/, '[wasm] 卡顿报告 $1：引擎已 $2 秒未输出日志；阻塞线程：');
}

// These are typed protocol errors, not arbitrary server/player text. Retain the
// Chinese diagnostic for Chinese UI, and translate stable codes for English UI.
// Unknown diagnostics never become an untranslated English product message.
const serverErrorMessages = Object.freeze({
  invalid_owner: 'This action is not authorized for the current entity owner.',
  not_owner: 'You do not currently control this entity. Wait for synchronization and try again.',
  invalid_request: 'This action could not be verified. Please try it again.',
  too_far: 'Move closer to the target and try again.',
  room_full: 'The public session is full. Please try again shortly.',
  server_full: 'The server is full. Please try again shortly.',
  world_full: 'The world has reached its entity limit. Please try again shortly.',
  projectile_limit: 'Too many projectiles are active. Wait a moment and try again.',
  duplicate_player: 'Your character is already present in this session.',
  invalid_message: 'The server could not verify this message. Update the launcher if this continues.',
  invalid_json: 'The server could not read this message. Reconnect if this continues.',
  unknown_type: 'This action requires a compatible launcher and server version.',
  client_world_rules_required: 'Update the launcher to join this public session.',
  capability_required: 'Update the launcher to use this session feature.',
  public_session_only: 'Choose a public session to continue.',
  not_in_room: 'Join the public session before performing this action.',
  resume_denied: 'The previous session could not be restored. Join the session again.',
  invalid_resume: 'The previous session could not be restored. Join the session again.',
  resume_expired: 'The previous session expired. Join the session again.',
  invalid_hello: 'The connection could not be verified. Update the launcher and reconnect.',
  protocol_mismatch: 'The launcher and server versions are incompatible. Update the launcher and reconnect.',
  handshake_timeout: 'The connection was not confirmed in time. Please reconnect.',
  rate_limited: 'Wait a moment and try this action again.',
  cooldown: 'This action is not ready yet. Try again shortly.',
  stale_seq: 'This action has expired. Please try it again.',
  stale_input: 'This action has expired. Please try it again.',
  stale_owner: 'Control of this entity changed. Wait for synchronization and try again.',
  invalid_lease: 'Control of this entity could not be verified. Wait for synchronization and try again.',
  invalid_revision: 'This entity is still synchronizing. Try again shortly.',
  stale_revision: 'This entity changed. Wait for synchronization and try again.',
  stale_generation: 'The target changed. Select the current target and try again.',
  wrong_world: 'This action belongs to an earlier session. Wait for synchronization and try again.',
  attached_entity: 'Leave the vehicle before moving this character independently.',
  dead_entity: 'This entity is no longer alive. Choose another target.',
  static_entity: 'This object cannot be moved.',
  invalid_movement: 'The server corrected this movement. Wait for synchronization and try again.',
  invalid_component: 'This action is not supported by the selected entity.',
  invalid_batch: 'The server could not verify this update. Wait for synchronization and try again.',
  invalid_tick: 'The world is still synchronizing. Try again shortly.',
  invalid_seat: 'This seat is unavailable for the current character.',
  seat_unavailable: 'This seat is unavailable. Choose another seat.',
  unknown_entity: 'The target is no longer available. Choose another target.',
  unsupported_model: 'This character or vehicle is not supported by the server.',
  unsupported_weapon: 'The server does not recognize this weapon. Update its weapon catalog.',
  weapon_mismatch: 'The weapon change has not synchronized yet. Try firing again shortly.',
  invalid_shot: 'The server could not verify this shot. Aim again and retry.',
  not_ready: 'Your character is still synchronizing. Try again shortly.',
  entry_not_ready: 'Your character and scene are still loading.',
  entry_timeout: 'Entry loading timed out. Please reconnect.',
  player_dead: 'You died. Wait for the server to respawn your character.',
  unsupported_interaction: 'This interaction is not currently available.',
  unsupported_simulation: 'This action is not currently supported by the server.',
  simulation_not_ready: 'This entity is still loading. Try again shortly.',
  player_input_required: 'Perform this action with your own character.',
  health_increase_denied: 'Health recovery must be confirmed by the server.',
  invalid_target: 'Choose a valid target and try again.',
  invalid_reason: 'The server could not verify the cause of this action.',
  not_facing: 'Face the target and try again.',
  snapshot_required: 'Wait for the world to synchronize before trying again.',
  invalid_collision: 'The server could not verify this collision. This result was skipped.',
  stale_collision: 'This collision observation has expired. This result was skipped.',
  unconfirmed_arrest: 'The arrest has not been confirmed by the server.',
});
export function localizeServerError(error, language = getLanguage()) {
  if (language === 'en') return typeof error?.code === 'string' && Object.hasOwn(serverErrorMessages, error.code)
    ? serverErrorMessages[error.code] : 'The server could not complete this action. Please try again.';
  return typeof error?.chinese === 'string' ? error.chinese
    : typeof error?.message === 'string' ? error.message.slice(0, 300)
    : '服务器未能完成操作。';
}

export function setLanguage(value) {
  let next;
  if (typeof value === 'string') {
    if (!['system', 'zh-CN', 'en'].includes(value)) return false;
    next = { preference: value, resolved: value === 'system' ? browserLanguage() : value, revision: languageConfig.revision };
  } else {
    if (!value || !['system', 'zh-CN', 'en'].includes(value.preference)
      || !(value.preference === 'system' && value.resolved === null || ['zh-CN', 'en'].includes(value.resolved))
      || value.preference !== 'system' && value.resolved !== value.preference
      || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
    next = { preference: value.preference, resolved: value.resolved || browserLanguage(), revision: value.revision };
  }
  const changed = next.resolved !== languageConfig.resolved || next.preference !== languageConfig.preference || next.revision !== languageConfig.revision;
  languageConfig = next;
  if (globalThis.document?.documentElement) document.documentElement.lang = next.resolved;
  if (changed) {
    const detail = { language: next.resolved, ...next };
    for (const listener of [...listeners]) { try { listener(detail); } catch {} }
    if (globalThis.document?.dispatchEvent && typeof globalThis.CustomEvent === 'function') document.dispatchEvent(new CustomEvent('gta-language-change', { detail }));
  }
  return true;
}
export function onLanguageChange(callback) { listeners.add(callback); return () => listeners.delete(callback); }

async function refreshLanguage() {
  if (closed) return getLanguage();
  const sequence = ++requestSequence;
  const controller = pollController = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('/api/language', { cache: 'no-store', signal: controller.signal });
    if (response.ok) {
      const snapshot = await response.json();
      if (!closed && !controller.signal.aborted && sequence === requestSequence && setLanguage(snapshot)) launcherConfigured = true;
    }
  } catch { /* Keep the last launcher selection through temporary disconnections. */ }
  finally { clearTimeout(timeout); if (pollController === controller) pollController = null; }
  if (!launcherConfigured) setLanguage('system');
  return getLanguage();
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!closed) pollTimer = setTimeout(async () => {
    if (globalThis.document?.visibilityState !== 'hidden') await refreshLanguage();
    schedulePoll();
  }, 2000);
}
export function initLanguage() {
  if (initPromise) return initPromise;
  closed = false;
  initPromise = refreshLanguage().then(() => {
    schedulePoll();
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible') { pollController?.abort(); refreshLanguage(); }
    });
    globalThis.addEventListener?.('pagehide', () => { closed = true; clearTimeout(pollTimer); pollController?.abort(); });
    globalThis.addEventListener?.('pageshow', (event) => {
      if (event.persisted) { closed = false; refreshLanguage(); schedulePoll(); }
    });
    return getLanguage();
  });
  return initPromise;
}
