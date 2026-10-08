import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import metadata from '../package.json';
import { escapeHtml as html, displayDirectory, progressValue, readBackground, saveBackground, remotePresentation, launcherActions } from './view-state.js';
import { backgrounds } from './backgrounds.js';
import './style.css';

const app = document.querySelector('#app');
const backgroundIds = backgrounds.map((item) => item.id);
const storage = { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };
const state = {
  desktop: isTauri(), selected: '', resources: null, urls: [], version: metadata.version, busy: false, phase: '',
  message: '选择你的游戏资源，下一站就是洛圣都。', error: '', background: readBackground(storage, backgroundIds), settingsOpen: false,
  remote: null, remoteBusy: false, remoteError: '', platform: '',
};
const icons = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"/><path d="M3 10h18"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="m10 3-.6 2.5-2 .9L5 5.7 3.5 8.3l1.8 1.8-.2 2.3-2.1 1.5 1.5 2.6 2.6-.6 1.9 1.2.5 2.9h3l.6-2.6 2-.9 2.4.7 1.5-2.6-1.8-1.8.2-2.3 2.1-1.5-1.5-2.6-2.6.6-1.9-1.2L13 3z"/><circle cx="11.5" cy="11.5" r="3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M5 16h14l-2-3V9a5 5 0 0 0-10 0v4zm5 4h4"/></svg>',
};
function updateStatus(value) {
  state.selected = value.selected_directory || state.selected;
  state.resources = value.resources || null;
  state.urls = value.running_urls || [];
  state.version = value.version || state.version;
  state.platform = value.platform || state.platform;
  if (value.remote_configuration) state.remote = value.remote_configuration;
}
function render() {
  const running = state.urls.length > 0, ready = Boolean(state.resources);
  const pickerScroll = document.querySelector('.background-grid')?.scrollTop || 0;
  const focusedBackground = document.activeElement?.dataset?.background;
  const actions = launcherActions(state, state.remoteBusy), remote = remotePresentation(state.remote, state.version, state.platform);
  const background = backgrounds.find((item) => item.id === state.background) || backgrounds[0];
  document.documentElement.style.setProperty('--scene', `url("${background.image}")`);
  app.innerHTML = `<div class="scene" aria-hidden="true"></div><div class="shell">
    <aside class="sidebar"><div class="brand"><span class="brand__mark">V</span><div>GTA5DATA<span>公共战局启动器</span></div></div>
      <div class="nav-label">你的启动空间</div><div class="nav-item"><span class="nav-icon">◈</span> 游戏启动器 <span class="nav-dot"></span></div>
      <div class="sidebar__bottom"><div class="engine-label"><span class="status-dot ${running ? 'live' : ''}"></span>${running ? '游戏服务运行中' : '随时准备出发'}</div>
        <p>你的世界，<br>共同的战局。</p><span class="version">启动器 ${html(state.version)}</span></div>
    </aside>
    <main><header><span class="header-label">GTA V / 公共战局</span><div class="header-actions"><span class="pill"><span class="status-dot ${running ? 'live' : ''}"></span>${running ? `${state.urls.length} 个客户端已启动` : '启动器就绪'}</span>
      <div class="settings"><button id="settings-toggle" class="settings-toggle ${state.settingsOpen ? 'is-open' : ''}" aria-expanded="${state.settingsOpen}" aria-controls="background-picker">${icons.settings} 设置 ${icons.chevron}</button>
        ${state.settingsOpen ? `<section id="background-picker" class="background-picker" aria-label="背景设置"><div class="picker-heading"><h2>背景切换</h2><span>为你的下一站换个风景</span></div><div class="background-grid">${backgrounds.map((item) => `<button class="background-option ${item.id === state.background ? 'selected' : ''}" data-background="${item.id}" aria-pressed="${item.id === state.background}" aria-label="选择背景：${html(item.label)}"><img src="${item.image}" alt="${html(item.label)}" loading="lazy"><span>${html(item.label)}${item.id === state.background ? icons.check : ''}</span></button>`).join('')}</div></section>` : ''}
      </div></div></header>
      <section class="hero"><div class="hero__copy"><p class="eyebrow">你的世界，共同的战局</p><h1>下一站，<br><em>洛圣都。</em></h1><p class="hero__description">带上你的游戏资源。<br>从单人探索到公共战局，一键出发。</p></div><span class="scene-label">${html(background.label)}</span></section>
      <div class="dashboard"><div class="game-column"><section class="glass setup-card"><div class="section-heading"><span class="step-number">01</span><div><h2>选择游戏资源</h2><p>选择资源文件夹，或其中的 b / data 目录。</p></div><span class="resource-badge ${ready ? 'verified' : ''}">${ready ? `${icons.check} 已通过校验` : '首次设置'}</span></div>
        <button class="directory" id="choose" ${actions.choose ? '' : 'disabled'}><span class="folder-icon">${icons.folder}</span><span class="directory__text"><small>${state.selected ? '所选目录' : '游戏资源目录'}</small><span title="${html(state.selected)}">${html(displayDirectory(state.selected))}</span></span><span class="browse">${state.selected ? '更换' : '选择'} ↗</span></button>
        ${ready ? `<div class="resource-detail"><span>${icons.check} ${Number(state.resources.manifest_file_count || 0).toLocaleString()} 项资源</span><span>资源只读，不修改游戏数据</span></div>` : '<p class="directory-note">支持原始资源包；自动识别目录，使用启动器内置游戏页面。</p>'}
      </section>
      <section class="glass launch-card"><div class="launch-copy"><div class="section-heading"><span class="step-number">02</span><div><h2>${running ? '游戏已准备就绪' : '启动你的游戏'}</h2><p>${running ? '继续游戏，或邀请另一个客户端加入战局。' : '准备完成后，在默认浏览器中开启游戏。'}</p></div></div>
          <div class="progress-status ${state.error ? 'has-error' : ''}" role="status" aria-live="polite"><span class="${state.busy ? 'spinner' : 'status-dot'}"></span>${html(state.error || state.message)}</div>
          ${state.busy ? `<div class="progress-track"><span style="width:${progressValue(state.phase)}%"></span></div>` : ''}</div>
        <div class="launch-actions"><button id="launch" class="primary" ${actions.launch ? '' : 'disabled'}>${running ? '打开游戏' : state.busy ? '正在准备…' : '启动游戏'}${icons.arrow}</button>
          ${running ? `<button id="additional" class="secondary" ${actions.additional ? '' : 'disabled'}>另开一个客户端</button><button id="stop" class="text-button" ${actions.stop ? '' : 'disabled'}>停止游戏服务</button>` : `<button id="verify" class="text-button" ${actions.launch ? '' : 'disabled'}>检查资源</button>`}</div>
      </section>
      ${running ? `<div class="addresses">${state.urls.map((url, index) => `<button data-open="${index}" ${state.busy ? 'disabled' : ''}><span class="status-dot live"></span>客户端 ${index + 1}<code>${html(url)}</code> ↗</button>`).join('')}</div>` : ''}</div>
      <aside class="community-column"><section class="glass announcement-card"><div class="card-heading"><h2>${icons.bell} 战局公告</h2><span class="config-source">${html(remote.sourceText)}</span></div>
        ${remote.announcements.length ? `<div class="announcements">${remote.announcements.map((item) => `<article><div class="announcement-heading"><h3>${html(item.title)}</h3>${item.date ? `<time>${html(item.date)}</time>` : ''}</div><p>${html(item.body)}</p></article>`).join('')}</div>` : '<p class="empty-note">暂无公告。准备好，就出发吧。</p>'}
        ${remote.title ? `<div class="server-info"><span>在线模式服务器状态</span><strong>${html(remote.title)}</strong>${remote.websiteAvailable && state.desktop ? '<button id="website" class="text-button">查看服务器状态 ↗</button>' : ''}</div>` : ''}
      </section><section class="glass update-card"><div class="card-heading"><h2>版本更新</h2><span class="version-chip">v${html(state.version)}</span></div><p class="update-state ${remote.update ? 'update-available' : ''}">${html(remote.versionText)}</p>
        ${remote.releaseNotes ? `<p class="release-notes">${html(remote.releaseNotes)}</p>` : ''}
        <div class="update-actions">${remote.downloadAvailable ? `<button id="update-download" class="secondary download-button" ${state.remoteBusy || !state.desktop ? 'disabled' : ''}>${icons.download} 下载新版本</button>` : ''}<button id="check-updates" class="text-button" ${actions.refresh ? '' : 'disabled'}>${state.remoteBusy ? '<span class="spinner"></span>' : icons.refresh}${state.remoteBusy ? '正在检查…' : '检查更新'}</button></div>
        ${state.remoteError ? `<p class="remote-note" role="status">${html(state.remoteError)}</p>` : state.remote?.source === 'cache' ? '<p class="remote-note">暂时无法连接，正在显示已缓存的信息。</p>' : ''}
      </section></aside></div>
      <footer><span>保持启动器开启，畅游洛圣都</span><span>关闭启动器会停止游戏服务</span></footer>
    </main></div>`;
  const picker = document.querySelector('.background-grid');
  if (picker) picker.scrollTop = pickerScroll;
  if (focusedBackground && state.settingsOpen) document.querySelector(`[data-background="${focusedBackground}"]`)?.focus({ preventScroll: true });
}
async function operation(work) {
  if (state.busy || !state.desktop) return;
  state.busy = true; state.error = ''; render();
  try { await work(); }
  catch (error) { state.error = typeof error === 'string' ? error : error.message || String(error); state.message = ''; }
  finally { state.busy = false; render(); }
}
async function refreshRemote(forceRefresh = true) {
  if (!state.desktop || state.remoteBusy) return;
  state.remoteBusy = true; state.remoteError = ''; render();
  try {
    state.remote = await invoke('remote_configuration', { forceRefresh });
    if (state.remote?.error && !state.remote?.config?.latest_version) state.remoteError = '暂时无法检查更新，请稍后重试。';
  } catch { state.remoteError = '暂时无法连接，游戏仍可正常启动。'; }
  finally { state.remoteBusy = false; render(); }
}
async function prepare() {
  state.phase = 'checking'; state.message = '正在识别资源目录…'; render();
  updateStatus(await invoke('prepare_game', { selected: state.selected }));
  state.phase = 'ready'; state.message = '资源与运行引擎已就绪。';
}
app.addEventListener('click', async (event) => {
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  if (target.id === 'settings-toggle') {
    state.settingsOpen = !state.settingsOpen; render();
    if (state.settingsOpen) document.querySelector('.background-option.selected')?.focus();
  } else if (target.dataset.background) {
    if (!backgroundIds.includes(target.dataset.background)) return;
    state.background = target.dataset.background; saveBackground(storage, state.background, backgroundIds); render();
    document.querySelector('.background-option.selected')?.focus();
  } else if (target.id === 'check-updates') await refreshRemote();
  else if (target.id === 'update-download' || target.id === 'website') {
    if (!state.desktop || state.remoteBusy) return;
    state.remoteBusy = true; state.remoteError = ''; render();
    try { await invoke(target.id === 'update-download' ? 'open_update_download' : 'open_project_website'); }
    catch { state.remoteError = target.id === 'update-download' ? '暂时没有适用于当前系统的下载，请稍后检查更新。' : '暂时无法打开服务器状态页面。'; }
    finally { state.remoteBusy = false; render(); }
  } else if (target.id === 'choose') await operation(async () => {
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
    state.message = '新客户端已打开，可以加入同一个公共战局。';
  });
  else if (target.id === 'stop') await operation(async () => { updateStatus(await invoke('stop_game')); state.message = '游戏服务已停止。'; });
  else if (target.dataset.open !== undefined) await operation(() => invoke('open_game', { index: Number(target.dataset.open) }));
});
document.addEventListener('click', (event) => {
  if (state.settingsOpen && !event.target.closest('.settings')) { state.settingsOpen = false; render(); }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.settingsOpen) { state.settingsOpen = false; render(); document.querySelector('#settings-toggle')?.focus(); }
});
render();
if (state.desktop) {
  listen('launcher-progress', ({ payload }) => { state.phase = payload.phase; state.message = payload.text; render(); });
  listen('launcher-remote-config', ({ payload }) => { state.remote = payload; render(); });
  invoke('launcher_status').then(updateStatus).then(render).catch((error) => { state.error = String(error); render(); }).finally(() => refreshRemote(false));
  setInterval(() => refreshRemote(true), 5 * 60 * 1000);
} else { state.message = '界面预览：通过桌面启动器选择资源并开始游戏。'; render(); }
