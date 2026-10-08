'use strict';
// 由公共战局副本的 CPauseMenu::Update 正常尾部调用；暂停时脚本 owner 不再调度。
// 只更新受守卫的原生 header / 线上页，不操作实体、不改变原网络状态或菜单版本。
self.createNativeSessionUI = function ({ ex, memory }) {
  const BYTES = 2720;
  const slots = {
    titleMethod: [0, 64], detailsMethod: [64, 64], title: [128, 256],
    name: [384, 256], count: [640, 128], status: [768, 256], mode: [1024, 256],
    panelMethod: [1280, 64], panelTitle: [1344, 256], panelBody: [1600, 1024], empty: [2624, 8],
  };
  const PANEL_OUTPUT = 2640;
  const required = ['mpAlloc', 'mpPauseMenuActive', 'mpFrontendReady', 'mpBeginPauseHeader',
    'mpScaleformString', 'mpScaleformBool', 'mpEndScaleform'];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const supported = required.every((name) => typeof ex?.[name] === 'function');
  const panelSupported = ['mpGetPausePanel', 'mpPausePanelName', 'mpBeginPauseContent', 'mpScaleformInt']
    .every((name) => typeof ex?.[name] === 'function');
  let buffer = 0, disposed = false, wasOpen = false;
  let lastAttempt = -Infinity, lastSuccess = -Infinity, lastSignature = '', lastPanel = '';

  function reset() {
    wasOpen = false; lastAttempt = -Infinity; lastSuccess = -Infinity; lastSignature = ''; lastPanel = '';
  }
  function cleanName(value) {
    // Scaleform 可解释 ~ 格式标签及 HTML；昵称只作为受限纯文字，不允许其改动布局。
    const text = typeof value === 'string' ? value : '';
    return Array.from(text.replace(/~[^~]*~/g, '').replace(/[~<>&"'\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ''))
      .slice(0, 32).join('').trim() || '玩家';
  }
  function statusText(summary) {
    if (summary.phase === 'leaving') return '正在離開戰局';
    if (summary.phase === 'reconnecting' || (!summary.connected && summary.phase !== 'connecting')) return '正在重新連線';
    if (summary.phase === 'connecting') return '正在連接戰局';
    if (summary.phase === 'loading') return '正在同步世界';
    return summary.connected ? '已連接公共戰局' : '正在連接戰局';
  }
  function texts(summary) {
    const count = Number.isSafeInteger(summary.player_count) ? Math.max(0, Math.min(1024, summary.player_count)) : 0;
    // 配置经过页面与启动器校验；这里再次拒绝格式指令、HTML和不安全协议。
    const candidate = summary.remote_config?.oltitle;
    const address = typeof candidate === 'string' && Array.from(candidate).length <= 160 && candidate.trim()
      && !/[<>~&"'\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(candidate)
      && (!/^[a-z][a-z\d+.-]*:/i.test(candidate) || /^https:\/\/[^\s]+$/i.test(candidate))
      && !/^https:\/\/[^/]*@/i.test(candidate)
      ? candidate : '-';
    return {
      titleMethod: 'SET_HEADER_TITLE', detailsMethod: 'SET_HEADING_DETAILS',
      title: 'GTA V · 公共在線戰局', name: cleanName(summary.name),
      count: '在線玩家：' + count, status: statusText(summary),
      mode: '公共戰局 · GTA V 自由模式',
      panelMethod: 'SHOW_WARNING_MESSAGE', panelTitle: 'GTA 線上模式',
      panelBody: '線上模式伺服器狀態：' + address + '\n'
        + statusText(summary) + ' · 在線玩家：' + count + '\n公共戰局 · GTA V 自由模式', empty: '',
    };
  }
  function prepare(value) {
    if (!buffer) {
      const allocated = Number(ex.mpAlloc(BigInt(BYTES)));
      if (!Number.isSafeInteger(allocated) || allocated <= 0 || allocated + BYTES > memory.buffer.byteLength) return false;
      buffer = allocated;
    }
    // WASM 内存可能增长；每次都重新取视图。每个槽独立 NUL 终止且不截断 UTF-8 字符。
    const bytes = new Uint8Array(memory.buffer, buffer, BYTES);
    bytes.fill(0);
    for (const [key, [offset, capacity]] of Object.entries(slots)) {
      let cursor = offset;
      for (const character of value[key]) {
        const encoded = encoder.encode(character);
        if (cursor + encoded.length >= offset + capacity) break;
        bytes.set(encoded, cursor); cursor += encoded.length;
      }
    }
    return true;
  }
  function pointer(key) { return BigInt(buffer + slots[key][0]); }
  function currentPanel() {
    if (!panelSupported || !buffer) return '';
    const output = buffer + PANEL_OUTPUT;
    new DataView(memory.buffer).setInt32(output, -1, true);
    ex.mpGetPausePanel(BigInt(output));
    if (new DataView(memory.buffer).getInt32(output, true) < 0) return '';
    const start = Number(ex.mpPausePanelName(BigInt(output)));
    if (!Number.isSafeInteger(start) || start <= 0 || start >= memory.buffer.byteLength) return '';
    const bytes = new Uint8Array(memory.buffer), limit = Math.min(start + 128, bytes.length);
    let end = start; while (end < limit && bytes[end]) end++;
    if (end === limit) return '';
    // 浏览器 TextDecoder 不接受 SharedArrayBuffer 视图，必须复制到普通缓冲区。
    try { return decoder.decode(bytes.slice(start, end)); } catch { return ''; }
  }
  function invoke(method, parameters, content = false) {
    const begin = content ? ex.mpBeginPauseContent : ex.mpBeginPauseHeader;
    if (!begin(pointer(method))) return false;
    try {
      for (const parameter of parameters) {
        if (typeof parameter === 'boolean') ex.mpScaleformBool(parameter ? 1 : 0);
        else if (typeof parameter === 'number') ex.mpScaleformInt(parameter);
        else ex.mpScaleformString(pointer(parameter));
      }
    } finally {
      // Begin 失败时禁止 Add/End；成功后即使参数接口失败也尽力关闭当前方法。
      ex.mpEndScaleform();
    }
    return true;
  }
  function tick(now, summary) {
    if (disposed || !supported) return { available: false, applied: false, reason: disposed ? 'disposed' : 'unsupported' };
    if (!summary || summary.online !== true || summary.phase === 'closed') {
      reset(); return { available: true, applied: false, reason: 'inactive' };
    }
    if (!Number.isFinite(now)) return { available: true, applied: false, reason: 'invalid_time' };
    if (now < lastAttempt) reset();
    try {
      // 原查询也有自己的 movie 守卫。资源未就绪、菜单关闭时不分配或写入 header。
      const open = Boolean(ex.mpPauseMenuActive()) && Boolean(ex.mpFrontendReady());
      if (!open) { reset(); return { available: true, applied: false, reason: 'menu_closed' }; }
      const justOpened = !wasOpen; wasOpen = true;
      // 这个原始 pane 的 XML runtime 是 PauseMenu_Multiplayer，已有引擎日志也确认“線上”进入它。
      // 查询实际 MenuScreenId；不能用可见标签索引，也不能覆盖地图/设置等任意当前电影。
      if (!buffer && !prepare(texts(summary))) return { available: false, applied: false, reason: 'allocation_failed' };
      const panel = currentPanel(), panelChanged = panel !== lastPanel;
      const value = texts(summary), signature = JSON.stringify(value);
      // 原 CPauseMenu 会重建 header，750ms 重应用；状态变化最短间隔250ms。
      if (!justOpened && !panelChanged && (now - lastAttempt < 250 || (signature === lastSignature && now - lastSuccess < 750))) {
        return { available: true, applied: false, content_applied: false, panel, reason: 'throttled' };
      }
      lastAttempt = now;
      if (!prepare(value)) return { available: false, applied: false, reason: 'allocation_failed' };
      // 原 CPauseMenu::Update 的常规标题分支只有一个字符串；不猜测额外可选参数。
      const title = invoke('titleMethod', ['title']);
      // 原 UpdatePlayerInfoAtTopOfScreen：三字符串、bool、末字符串。false采用线上 header 布局。
      const details = invoke('detailsMethod', ['name', 'count', 'status', false, 'mode']);
      let content = false;
      if (panel === 'MENU_UNIQUE_ID_MISSION_CREATOR') {
        // 与 CScaleformMenuHelper::SHOW_WARNING_MESSAGE 的原始参数一致：
        // visible=true, column=0, layout=3（整页），标题、正文、宽度430、空图像/纹理、alignment=0、空图像说明、false。
        content = invoke('panelMethod', [true, 0, 3, 'panelTitle', 'panelBody', 430, 'empty', 'empty', 0, 'empty', false], true);
      }
      lastPanel = panel;
      if (title && details) { lastSignature = signature; lastSuccess = now; }
      return { available: true, applied: title && details, content_applied: content, panel,
        reason: title && details ? 'applied' : 'header_pending' };
    } catch {
      // UI 不可用不能终止角色/世界同步；下次前端回调限频重试。
      lastAttempt = now;
      return { available: false, applied: false, reason: 'native_failure' };
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; reset();
    if (buffer && typeof ex.mpFree === 'function') {
      try { ex.mpFree(BigInt(buffer)); } catch { /* 退出时原引擎可能已结束。 */ }
    }
    buffer = 0;
  }
  return { tick, reset, dispose };
};
