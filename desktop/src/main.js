import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { escapeHtml as html, displayDirectory, progressValue } from './view-state.js';
import './style.css';

const app = document.querySelector('#app');
const state = { desktop: isTauri(), selected: '', resources: null, urls: [], version: '0.1.1', busy: false, phase: '',
  message: '选择你自己的游戏资源包，即可开始。', error: '', copied: false };
const icons = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"/><path d="M3 10h18"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="m10 14 4-4m-6 6-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1"/></svg>',
};
function updateStatus(value) {
  state.selected = value.selected_directory || state.selected;
  state.resources = value.resources; state.urls = value.running_urls || []; state.version = value.version;
}
function render() {
  const running = state.urls.length > 0, ready = Boolean(state.resources), disabled = state.busy || !state.desktop;
  app.innerHTML = `<div class="shell">
    <aside class="sidebar"><div class="brand"><span class="brand__mark">V</span><div>GTA5DATA<span>公共战局</span></div></div>
      <div class="nav-label">你的启动空间</div><div class="nav-item"><span class="nav-icon">◈</span> 游戏启动器 <span class="nav-dot"></span></div>
      <div class="sidebar__bottom"><div class="engine-label"><span class="status-dot ${running ? 'live' : ''}"></span>${running ? '本地服务运行中' : '随时准备出发'}</div>
        <p>游戏资源由你保管<br>启动、连接由这里完成</p><span class="version">启动器 ${html(state.version)}</span></div>
    </aside>
    <main><header><span>GTA V / 浏览器版</span><span class="pill"><span class="status-dot ${running ? 'live' : ''}"></span>${running ? `${state.urls.length} 个客户端已启动` : '启动器就绪'}</span></header>
      <section class="hero"><div class="hero__copy"><p class="eyebrow">你的世界，共同的战局</p><h1>下一站，<br><em>洛圣都。</em></h1><p class="hero__description">带上你的游戏资源。<br>从单人探索到公共战局，一键出发。</p></div>
        <div class="city" aria-hidden="true"><div class="sun"></div><div class="city__grid"></div><div class="tower t1"></div><div class="tower t2"></div><div class="tower t3"></div><div class="tower t4"></div><div class="tower t5"></div><div class="city__road"></div><span class="city__caption">洛圣都 · 自由模式</span></div>
      </section>
      <section class="setup-card"><div class="section-heading"><span class="step-number">01</span><div><h2>选择游戏资源</h2><p>可选资源根目录、b / data，或包含 mirror 的外层文件夹。</p></div><span class="resource-badge ${ready ? 'verified' : ''}">${ready ? '已通过校验' : '仅首次需要设置'}</span></div>
        <button class="directory" id="choose" ${disabled || running ? 'disabled' : ''}><span class="folder-icon">${icons.folder}</span><span class="directory__text"><small>${state.selected ? '所选目录' : '游戏资源目录'}</small><span title="${html(state.selected)}">${html(displayDirectory(state.selected))}</span></span><span class="browse">${state.selected ? '更换目录' : '选择文件夹'} ↗</span></button>
        ${ready ? `<div class="resource-detail"><span>${icons.check} ${state.resources.manifest_file_count.toLocaleString()} 项资源</span><span>引擎版本 ${html(state.resources.original_sha256.slice(0, 12))}</span><span>原游戏资源只读</span></div>` : '<p class="directory-note">自动识别实际资源位置；始终使用启动器自带页面，不使用资源包里的 index.html。</p>'}
      </section>
      <section class="launch-card"><div><div class="section-heading"><span class="step-number">02</span><div><h2>${running ? '游戏已准备就绪' : '启动你的游戏'}</h2><p>${running ? '可重新打开游戏，或另开一个客户端测试公共战局。' : '自动准备引擎和字体，并在默认浏览器中打开游戏。'}</p></div></div>
          <div class="progress-status ${state.error ? 'has-error' : ''}" role="status" aria-live="polite"><span class="${state.busy ? 'spinner' : 'status-dot'}"></span>${html(state.error || state.message)}</div>
          ${state.busy ? `<div class="progress-track"><span style="width:${progressValue(state.phase)}%"></span></div>` : ''}</div>
        <div class="launch-actions"><button id="launch" class="primary" ${disabled || !state.selected ? 'disabled' : ''}>${running ? '打开游戏' : state.busy ? '正在准备…' : '启动游戏'}${icons.arrow}</button>
          ${running ? `<button id="additional" class="secondary" ${disabled ? 'disabled' : ''}>另开一个客户端</button><button id="stop" class="text-button" ${disabled ? 'disabled' : ''}>停止本地服务</button>` : `<button id="verify" class="text-button" ${disabled || !state.selected ? 'disabled' : ''}>只检查资源</button>`}</div>
      </section>
      ${running ? `<div class="addresses">${state.urls.map((url, index) => `<button data-open="${index}"><span class="status-dot live"></span>客户端 ${index + 1}<code>${html(url)}</code> ↗</button>`).join('')}</div>` : ''}
      <footer><span>无需手动运行 Python 或命令行</span><span>关闭启动器会停止本地游戏服务</span></footer>
    </main></div>`;
}
async function operation(work) {
  if (state.busy || !state.desktop) return;
  state.busy = true; state.error = ''; render();
  try { await work(); }
  catch (error) { state.error = typeof error === 'string' ? error : error.message || String(error); state.message = ''; }
  finally { state.busy = false; render(); }
}
async function prepare() {
  state.phase = 'checking'; state.message = '正在识别资源目录…'; render();
  updateStatus(await invoke('prepare_game', { selected: state.selected }));
  state.phase = 'ready'; state.message = '资源与运行引擎已就绪。';
}
app.addEventListener('click', async (event) => {
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  if (target.id === 'choose') await operation(async () => {
    const value = await invoke('choose_game_directory');
    if (value) { state.selected = value; state.resources = null; state.phase = ''; state.message = '目录已选择，启动时将自动识别和校验。'; }
  });
  else if (target.id === 'verify') await operation(prepare);
  else if (target.id === 'launch') await operation(async () => {
    if (!state.urls.length) { if (!state.resources) await prepare(); updateStatus(await invoke('start_game', { additional: false })); }
    await invoke('open_game', { index: 0 }); state.message = '游戏已在浏览器打开，请保持启动器运行。';
  });
  else if (target.id === 'additional') await operation(async () => {
    updateStatus(await invoke('start_game', { additional: true })); await invoke('open_game', { index: state.urls.length - 1 });
    state.message = '新客户端使用独立地址与浏览器存储。';
  });
  else if (target.id === 'stop') await operation(async () => { updateStatus(await invoke('stop_game')); state.message = '本地服务已停止，浏览器游戏页可以关闭。'; });
  else if (target.dataset.open !== undefined) await operation(() => invoke('open_game', { index: Number(target.dataset.open) }));
});
render();
if (state.desktop) {
  listen('launcher-progress', ({ payload }) => { state.phase = payload.phase; state.message = payload.text; render(); });
  invoke('launcher_status').then(updateStatus).then(render).catch((error) => { state.error = String(error); render(); });
} else { state.message = '界面预览模式：请通过桌面启动器选择资源并启动游戏。'; render(); }
