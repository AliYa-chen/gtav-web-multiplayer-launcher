const DEFAULT_BUDGETS = Object.freeze({ connecting: 30000, reconnecting: 30000, engine_loading: 180000,
  snapshot_sync: 45000, character_loading: 90000, scene_loading: 90000, descent: 30000, admitting: 15000 });
const FLAGS = ['connected', 'networkReady', 'engineReady', 'characterReady', 'sceneReady', 'serverReady', 'cameraActive', 'reducedMotion'];
const TERMINAL = new Set(['failed', 'cancelled']);
// Yellow means an observed session handshake/synchronization is pending. There
// is no cloud-save indicator until the host has a real save operation to report.
const JOINING_STAGES = new Set(['connecting', 'reconnecting', 'snapshot_sync', 'admitting']);

// The host supplies observed readiness, never a timer-derived percentage. Each
// attempt is isolated; a reconnect invalidates its previous world/camera gates.
export function createEntryController({ budgets = {}, now = () => performance.now(), onChange = () => {},
  onCancel = () => {}, onRetry = () => {} } = {}) {
  let sequence = 0, state = { attemptId: 0, stage: 'cancelled', visible: false }, seenConnected = false;
  let deadlines = new Map(), disposed = false, entered = false;
  const snapshot = () => ({ ...state });
  function stage() {
    if (state.error) return 'failed';
    if (!state.connected) return seenConnected ? 'reconnecting' : 'connecting';
    if (!state.engineReady) return 'engine_loading';
    if (!state.networkReady || !state.worldEpoch) return 'snapshot_sync';
    if (entered && state.serverReady) return 'active';
    if (!state.characterReady) return 'character_loading';
    if (!state.sceneReady) return 'scene_loading';
    if (state.cameraPhase !== 'finished' && state.cameraOutcome !== 'skipped') return 'descent';
    return state.serverReady ? 'active' : 'admitting';
  }
  function publish() {
    state.stage = stage(); state.visible = state.stage !== 'active';
    if (state.stage === 'active') entered = true;
    if (DEFAULT_BUDGETS[state.stage] && !deadlines.has(state.stage)) {
      const duration = budgets[state.stage];
      deadlines.set(state.stage, now() + (Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_BUDGETS[state.stage]));
    }
    onChange(snapshot());
  }
  function start(initial = {}) {
    if (disposed) return 0;
    deadlines = new Map(); seenConnected = false; entered = false;
    state = { attemptId: ++sequence, stage: 'connecting', visible: true, connected: false, networkReady: false,
      engineReady: false, characterReady: false, sceneReady: false, serverReady: false, cameraActive: false, reducedMotion: false,
      serverVersion: '', worldEpoch: '', cameraPhase: '', cameraOutcome: '', error: '', timeoutStage: '' };
    update(state.attemptId, initial);
    return state.attemptId;
  }
  function update(attemptId, patch = {}) {
    if (disposed || attemptId !== state.attemptId || !attemptId || TERMINAL.has(state.stage)) return false;
    const previous = state.stage, disconnected = state.connected && patch.connected === false;
    const worldChanged = state.worldEpoch && Object.hasOwn(patch, 'worldEpoch') && patch.worldEpoch !== state.worldEpoch;
    if (disconnected || worldChanged || patch.networkReady === false || patch.serverReady === false) entered = false;
    if (disconnected || worldChanged || patch.networkReady === false) {
      Object.assign(state, { networkReady: false, characterReady: false, sceneReady: false, serverReady: false, cameraPhase: '', cameraOutcome: '', cameraActive: false });
      if (disconnected) state.worldEpoch = '';
    }
    // A new recovery cycle gets new budgets, but repeated snapshots cannot extend them.
    if (previous === 'active' && (disconnected || worldChanged || patch.networkReady === false || patch.serverReady === false)) deadlines.clear();
    for (const name of FLAGS) if (typeof patch[name] === 'boolean') state[name] = patch[name];
    if (typeof patch.worldEpoch === 'string') state.worldEpoch = patch.worldEpoch;
    if (typeof patch.serverVersion === 'string') state.serverVersion = /^\d+\.\d+\.\d+$/.test(patch.serverVersion) ? patch.serverVersion : '';
    if (['', 'active', 'finished'].includes(patch.cameraPhase)) state.cameraPhase = patch.cameraPhase;
    if (['', 'skipped'].includes(patch.cameraOutcome)) state.cameraOutcome = patch.cameraOutcome;
    if (typeof patch.error === 'string' && patch.error) state.error = patch.error.slice(0, 600);
    if (!state.connected) Object.assign(state, { serverVersion: '', networkReady: false, characterReady: false, sceneReady: false, serverReady: false, cameraPhase: '', cameraOutcome: '', cameraActive: false });
    if (state.connected) seenConnected = true;
    publish(); return true;
  }
  function tick() {
    if (disposed || !state.visible || TERMINAL.has(state.stage)) return false;
    if (now() < (deadlines.get(state.stage) ?? Infinity)) return false;
    state.timeoutStage = state.stage; state.error = 'timeout'; state.cameraActive = false;
    publish(); return true;
  }
  function cancel() {
    if (disposed || !state.attemptId || state.stage === 'active' || state.stage === 'cancelled') return false;
    state.stage = 'cancelled'; state.visible = false; state.cameraActive = false;
    onChange(snapshot()); onCancel(state.attemptId); return true;
  }
  function retry() {
    if (disposed || !TERMINAL.has(state.stage)) return 0;
    const attemptId = start(); onRetry(attemptId); return attemptId;
  }
  function destroy() { disposed = true; deadlines.clear(); }
  return { start, update, tick, cancel, retry, destroy, getState: snapshot };
}

const TEXT = Object.freeze({
  title: ['公共在线战局', 'PUBLIC ONLINE SESSION', '公共線上戰局'],
  loading: ['加载中…', 'Loading…', '載入中…'],
  connecting: ['正在连接战局', 'Connecting to session', '正在連接戰局'],
  engine_loading: ['正在启动游戏引擎', 'Starting the game engine', '正在啟動遊戲引擎'],
  snapshot_sync: ['正在同步战局', 'Synchronizing the session', '正在同步戰局'],
  character_loading: ['正在准备角色', 'Preparing your character', '正在準備角色'],
  scene_loading: ['正在加载出生区域', 'Loading your spawn area', '正在載入出生區域'],
  descent: ['正在进入游戏世界', 'Entering the game world', '正在進入遊戲世界'],
  admitting: ['正在确认入场', 'Confirming entry', '正在確認入場'],
  reconnecting: ['正在重新连接战局', 'Reconnecting to session', '正在重新連接戰局'],
  failed: ['未能进入战局', 'Could not enter the session', '未能進入戰局'],
  cancel: ['返回', 'Back', '返回'], retry: ['重试', 'Retry', '重試'],
  connectingHint: ['正在等待服务器确认连接。', 'Waiting for the server to confirm your connection.', '正在等待伺服器確認連線。'],
  engine_loadingHint: ['正在读取本机游戏资源并初始化画面。', 'Reading local game resources and initializing graphics.', '正在讀取本機遊戲資源並初始化畫面。'],
  snapshot_syncHint: ['正在接收当前世界和玩家状态。', 'Receiving the current world and player state.', '正在接收目前世界和玩家狀態。'],
  character_loadingHint: ['正在应用本次选择的角色与外观。', 'Applying your selected character and appearance.', '正在套用本次選擇的角色與外觀。'],
  scene_loadingHint: ['等待附近场景与碰撞数据就绪。', 'Waiting for nearby scenery and collision data.', '等待附近場景與碰撞資料就緒。'],
  descentHint: ['正在将镜头切换到你的角色。', 'Moving the camera to your character.', '正在將鏡頭切換到你的角色。'],
  admittingHint: ['正在等待服务器确认本次入场。', 'Waiting for the server to confirm your entry.', '正在等待伺服器確認本次入場。'],
  reconnectingHint: ['连接恢复后将重新确认世界状态。', 'World state will be checked again after reconnection.', '連線恢復後將重新確認世界狀態。'],
  failedHint: ['请重试，或返回选择服务器。', 'Retry, or go back to choose a server.', '請重試，或返回選擇伺服器。'],
  timeout: ['等待超时：', 'Timed out: ', '等待逾時：'],
});

export function createOnlineEntry({ root = document.body, onCancel, onRetry, onChange = () => {}, language = 'zh-CN',
  getLanguage = () => language, budgets, now } = {}) {
  const doc = root.ownerDocument, view = doc.defaultView;
  const element = doc.createElement('section'); element.className = 'online-entry'; element.hidden = true;
  element.setAttribute('role', 'dialog'); element.setAttribute('aria-modal', 'true'); element.setAttribute('tabindex', '-1');
  // Artwork and cloud cameras belong to the original game surface underneath.
  // This overlay only reports actual entry state and provides recovery controls.
  element.innerHTML = '<div class="online-entry__panel">'
    + '<div class="online-entry__copy"><p class="online-entry__version" hidden></p><div class="online-entry__activity"><h1 class="online-entry__status" role="status" aria-live="polite" aria-atomic="true"></h1>'
    + '<span class="online-entry__spinner" aria-hidden="true"><img src="/b/8b0b5899ed/title/spinner.png" alt=""></span></div></div>'
    + '<p class="online-entry__hint"></p><p class="online-entry__error"></p>'
    + '<div class="online-entry__actions"><button type="button" data-action="cancel"></button><button type="button" data-action="retry"></button></div></div>';
  const status = element.querySelector('.online-entry__status');
  const version = element.querySelector('.online-entry__version');
  const spinner = element.querySelector('.online-entry__spinner'), spinnerImage = spinner.querySelector('img');
  // Reuse the selected game's original title spinner. An unavailable title
  // asset must not leave a broken-image icon or remove the loading indication.
  spinnerImage.addEventListener('error', () => { spinnerImage.hidden = true; spinner.dataset.fallback = 'true'; });
  const hint = element.querySelector('.online-entry__hint'), error = element.querySelector('.online-entry__error');
  const actions = element.querySelector('.online-entry__actions');
  const cancelButton = element.querySelector('[data-action="cancel"]'), retryButton = element.querySelector('[data-action="retry"]');
  root.appendChild(element);
  let lastStage = '', lastLanguage = '', priorFocus = null;
  let timer = 0;
  const controller = createEntryController({ budgets, now, onCancel, onRetry, onChange: render });
  function word(key) {
    const locale = getLanguage();
    return TEXT[key]?.[/^zh[-_](?:tw|hk|hant)/i.test(locale) ? 2 : /^zh/i.test(locale) ? 0 : 1] || '';
  }
  function render(state) {
    const opening = element.hidden && state.visible, stageChanged = lastStage !== state.stage;
    element.hidden = !state.visible; element.dataset.stage = state.stage;
    const busy = state.visible && !TERMINAL.has(state.stage);
    element.dataset.indicator = busy ? (JOINING_STAGES.has(state.stage) ? 'joining' : 'loading') : '';
    element.dataset.reducedMotion = String(state.reducedMotion);
    spinner.hidden = !busy;
    version.textContent = state.serverVersion ? 'ONLINE ' + state.serverVersion : '';
    version.hidden = !state.serverVersion;
    hint.hidden = state.stage !== 'failed';
    if (state.visible && !timer) timer = view.setInterval(() => { controller.tick(); if (lastLanguage !== getLanguage()) render(controller.getState()); }, 500);
    if (!state.visible && timer) { view.clearInterval(timer); timer = 0; }
    if (lastStage !== state.stage || lastLanguage !== getLanguage()) {
      status.textContent = word(busy ? 'loading' : state.stage); hint.textContent = word(state.stage + 'Hint');
      element.setAttribute('aria-label', word('title'));
      cancelButton.textContent = word('cancel'); retryButton.textContent = word('retry');
      lastStage = state.stage; lastLanguage = getLanguage();
    }
    error.textContent = state.timeoutStage ? word('timeout') + word(state.timeoutStage) : state.error;
    error.hidden = !error.textContent;
    const failed = state.stage === 'failed';
    actions.hidden = cancelButton.hidden = retryButton.hidden = !failed;
    if (opening) priorFocus = doc.activeElement;
    if (state.visible && (opening || stageChanged)) {
      (failed ? retryButton : element).focus({ preventScroll: true });
    } else if (!state.visible && element.contains(doc.activeElement)) priorFocus?.focus?.({ preventScroll: true });
    onChange(state);
  }
  function keydown(event) {
    if (element.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.cancel(); }
    if (event.key === 'Tab') {
      if (actions.hidden) { event.preventDefault(); element.focus({ preventScroll: true }); return; }
      const first = cancelButton, last = retryButton;
      if (doc.activeElement === element) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  cancelButton.addEventListener('click', () => controller.cancel());
  retryButton.addEventListener('click', () => controller.retry());
  element.addEventListener('keydown', keydown);
  return { ...controller, element, destroy() {
    controller.destroy();
    if (timer) view.clearInterval(timer);
    element.remove();
  } };
}
