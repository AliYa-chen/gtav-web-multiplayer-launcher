import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import metadata from '../package.json';
import { escapeHtml as html, displayDirectory, progressValue, readBackground, saveBackground, remotePresentation, launcherActions, paginateText } from './view-state.js';
import { backgrounds } from './backgrounds.js';
import './style.css';

const app = document.querySelector('#app');
const backgroundIds = backgrounds.map((item) => item.id);
const storage = { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };
const state = {
  desktop: isTauri(), selected: '', resources: null, urls: [], version: metadata.version, busy: false, phase: '',
  message: '选择你的游戏资源，下一站就是洛圣都。', error: '', background: readBackground(storage, backgroundIds), settingsOpen: false,
  remote: null, remoteBusy: false, remoteError: '', platform: '',
  announcementIndex: 0, clientPage: 0, reading: null, readingPage: 0,
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
  close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
};
function updateStatus(value) {
  state.selected = value.selected_directory || state.selected;
  state.resources = value.resources || null;
  state.urls = value.running_urls || [];
  state.version = value.version || state.version;
  state.platform = value.platform || state.platform;
  if (value.remote_configuration) applyRemote(value.remote_configuration);
}
function applyRemote(snapshot) {
  state.remote = snapshot;
  state.remoteError = typeof snapshot?.error === 'string' ? snapshot.error : '';
  if (snapshot?.source !== 'remote' || snapshot?.stale === true) state.reading = null;
}
function render() {
  const running = state.urls.length > 0, ready = Boolean(state.resources);
  const focusedBackground = document.activeElement?.dataset?.background;
  const actions = launcherActions(state, state.remoteBusy), remote = remotePresentation(state.remote, state.version, state.platform);
  const background = backgrounds.find((item) => item.id === state.background) || backgrounds[0];
  state.announcementIndex = Math.min(state.announcementIndex, Math.max(0, remote.announcements.length - 1));
  state.clientPage = Math.min(state.clientPage, Math.max(0, Math.ceil(state.urls.length / 4) - 1));
  const announcement = remote.announcements[state.announcementIndex];
  const visibleClients = state.urls.slice(state.clientPage * 4, state.clientPage * 4 + 4);
  const pages = state.reading ? paginateText(state.reading.text) : [];
  state.readingPage = Math.min(state.readingPage, Math.max(0, pages.length - 1));
  document.documentElement.style.setProperty('--scene', `url("${background.image}")`);
  app.innerHTML = `<div class="scene" aria-hidden="true"></div><div class="shell">
    <main><header><div class="brand"><span class="brand__mark">V<span>ONLINE</span></span><div>GTA5DATA<span>公共战局启动器</span></div></div><div class="header-actions"><span class="pill"><span class="status-dot ${running ? 'live' : ''}"></span>${running ? `${state.urls.length} 个客户端已启动` : '启动器就绪'}</span>
      <div class="settings"><button id="settings-toggle" class="settings-toggle ${state.settingsOpen ? 'is-open' : ''}" aria-expanded="${state.settingsOpen}" aria-controls="background-picker">${icons.settings} 设置 ${icons.chevron}</button>
        ${state.settingsOpen ? `<button class="picker-backdrop" id="picker-dismiss" aria-label="关闭背景设置"></button><section id="background-picker" class="background-picker" role="dialog" aria-modal="true" aria-labelledby="picker-title"><div class="picker-heading"><div><p class="eyebrow">YOUR LOS SANTOS</p><h2 id="picker-title">换一处风景</h2><span>12 个场景 · 主图完整展示</span></div><button id="picker-close" class="icon-button" aria-label="关闭背景设置">${icons.close}</button></div><div class="background-grid">${backgrounds.map((item) => `<button class="background-option ${item.id === state.background ? 'selected' : ''}" data-background="${item.id}" aria-pressed="${item.id === state.background}" aria-label="选择背景：${html(item.label)}"><img src="${item.image}" alt="${html(item.label)}" loading="lazy"><span>${html(item.label)}${item.id === state.background ? icons.check : ''}</span></button>`).join('')}</div></section>` : ''}
      </div></div></header>
      <section class="hero"><div class="hero__copy"><p class="eyebrow"><span class="status-dot live"></span> 你的世界，共同的战局</p><h1>下一站，<em>洛圣都。</em></h1><p class="hero__description">带上你的游戏资源，从单人探索到公共战局。</p></div><span class="scene-label">${html(background.label)}</span></section>
      <div class="dashboard"><div class="game-column"><section class="glass setup-card"><div class="section-heading"><span class="step-number">01</span><div><h2>选择游戏资源</h2><p>选择资源文件夹，或其中的 b / data 目录。</p></div><span class="resource-badge ${ready ? 'verified' : ''}">${ready ? `${icons.check} 已通过校验` : '首次设置'}</span></div>
        <button class="directory" id="choose" ${actions.choose ? '' : 'disabled'}><span class="folder-icon">${icons.folder}</span><span class="directory__text"><small>${state.selected ? '所选目录' : '游戏资源目录'}</small><span title="${html(state.selected)}">${html(displayDirectory(state.selected))}</span></span><span class="browse">${state.selected ? '更换' : '选择'} ↗</span></button>
        ${ready ? `<div class="resource-detail"><span>${icons.check} ${Number(state.resources.manifest_file_count || 0).toLocaleString()} 项资源</span><span>资源只读，不修改游戏数据</span></div>` : '<p class="directory-note">支持原始资源包；自动识别目录，使用启动器内置游戏页面。</p>'}
      </section>
      <section class="glass launch-card"><div class="launch-main"><div class="launch-copy"><div class="section-heading"><span class="step-number">02</span><div><h2>${running ? '游戏已准备就绪' : '启动你的游戏'}</h2><p>${running ? '继续游戏，或邀请另一个客户端加入战局。' : '准备完成后，在默认浏览器中开启游戏。'}</p></div></div>
          <div class="progress-status ${state.error ? 'has-error' : ''}" role="status" aria-live="polite"><span class="${state.busy ? 'spinner' : 'status-dot'}"></span><span class="status-copy" title="${html(state.error || state.message)}">${html(state.error || state.message)}</span>${state.error ? '<button class="text-button" data-read="error">详情</button>' : ''}</div>
          ${state.busy ? `<div class="progress-track"><span style="width:${progressValue(state.phase)}%"></span></div>` : ''}</div>
        <div class="launch-actions"><button id="launch" class="primary" ${actions.launch ? '' : 'disabled'}>${running ? '打开游戏' : state.busy ? '正在准备…' : '启动游戏'}${icons.arrow}</button>
          ${running ? `<button id="additional" class="secondary" ${actions.additional ? '' : 'disabled'}>另开一个客户端</button><button id="stop" class="text-button" ${actions.stop ? '' : 'disabled'}>停止游戏服务</button>` : `<button id="verify" class="text-button" ${actions.launch ? '' : 'disabled'}>检查资源</button>`}</div></div>
      ${running ? `<div class="addresses">${visibleClients.map((url, offset) => `<button data-open="${state.clientPage * 4 + offset}" ${state.busy ? 'disabled' : ''}><span class="status-dot live"></span>客户端 ${state.clientPage * 4 + offset + 1}<code>${html(url)}</code> ↗</button>`).join('')}${state.urls.length > 4 ? `<button id="clients-next" class="client-page" aria-label="显示下一组客户端">${state.clientPage + 1} / ${Math.ceil(state.urls.length / 4)} ${icons.arrow}</button>` : ''}</div>` : ''}</section></div>
      <aside class="community-column"><section class="glass announcement-card"><div class="card-heading"><h2>${icons.bell} 战局公告</h2><span class="config-source">${html(remote.sourceText)}</span></div>
        ${announcement ? `<div class="announcements"><article><div class="announcement-heading"><h3 title="${html(announcement.title)}">${html(announcement.title)}</h3>${announcement.date ? `<time>${html(announcement.date)}</time>` : ''}</div><p>${html(announcement.body)}</p></article><div class="announcement-actions"><button class="text-button" data-read="announcement">查看详情 ↗</button>${remote.announcements.length > 1 ? `<div class="pager"><button id="announcement-prev" aria-label="上一条公告" ${state.announcementIndex ? '' : 'disabled'}>‹</button><span>${state.announcementIndex + 1} / ${remote.announcements.length}</span><button id="announcement-next" aria-label="下一条公告" ${state.announcementIndex < remote.announcements.length - 1 ? '' : 'disabled'}>›</button></div>` : ''}</div></div>` : '<p class="empty-note">-</p>'}
        <div class="server-info"><span>在线模式服务器状态</span><strong>${html(remote.title)}</strong>${remote.websiteAvailable && state.desktop ? '<button id="website" class="text-button">查看服务器状态 ↗</button>' : ''}${remote.servers.length ? `<ul class="server-routes">${remote.servers.map((item) => `<li><span>${html(item.name)}${item.role ? ` · ${html(item.role)}` : ''}</span><code>${html(item.address)}</code></li>`).join('')}</ul>` : ''}</div>
      </section><section class="glass update-card"><div class="card-heading"><h2>版本更新</h2><span class="version-chip">v${html(state.version)}</span></div><p class="update-state ${remote.update ? 'update-available' : ''}">${html(remote.versionText)}</p>
        ${remote.releaseNotes ? `<p class="release-notes">${html(remote.releaseNotes)}</p><button class="text-button notes-link" data-read="release">版本详情 ↗</button>` : ''}
        <div class="update-actions">${remote.downloadAvailable ? `<button id="update-download" class="secondary download-button" ${state.remoteBusy || !state.desktop ? 'disabled' : ''}>${icons.download} 下载新版本</button>` : ''}<button id="check-updates" class="text-button" ${actions.refresh ? '' : 'disabled'}>${state.remoteBusy ? '<span class="spinner"></span>' : icons.refresh}${state.remoteBusy ? '正在检查…' : '检查更新'}</button></div>
        ${state.remoteError ? `<p class="remote-note" role="status">${html(state.remoteError)}</p>` : ''}
      </section></aside></div>
      <footer><span>GTA V / 公共战局 <i></i> 启动器 ${html(state.version)}</span><span>保持启动器开启，畅游洛圣都</span></footer>
    </main></div>${state.reading ? `<div class="reader-overlay"><button id="reader-dismiss" class="reader-backdrop" aria-label="关闭详情"></button><section class="glass reader" role="dialog" aria-modal="true" aria-labelledby="reader-title"><div class="reader-heading"><h2 id="reader-title">${html(state.reading.title)}</h2><button id="reader-close" class="icon-button" aria-label="关闭详情">${icons.close}</button></div><div class="reader-text">${html(pages[state.readingPage] || '')}</div><div class="reader-footer"><span>第 ${state.readingPage + 1} / ${Math.max(1, pages.length)} 页</span><div class="pager"><button id="reader-prev" ${state.readingPage ? '' : 'disabled'} aria-label="上一页">‹</button><button id="reader-next" ${state.readingPage < pages.length - 1 ? '' : 'disabled'} aria-label="下一页">›</button></div></div></section></div>` : ''}`;
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
    applyRemote(await invoke('remote_configuration', { forceRefresh }));
  } catch { applyRemote({ config: {}, source: 'unavailable', stale: true, error: '远程配置暂时无法加载，请稍后重试。' }); }
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
    state.settingsOpen = !state.settingsOpen; state.reading = null; render();
    if (state.settingsOpen) document.querySelector('.background-option.selected')?.focus();
  } else if (target.id === 'picker-close' || target.id === 'picker-dismiss') {
    state.settingsOpen = false; render(); document.querySelector('#settings-toggle')?.focus();
  } else if (target.dataset.read) {
    const remote = remotePresentation(state.remote, state.version, state.platform);
    const item = remote.announcements[state.announcementIndex];
    if (target.dataset.read === 'announcement' && item) state.reading = { title: item.title, text: `${item.date ? `${item.date}\n\n` : ''}${item.body}` };
    else if (target.dataset.read === 'release') state.reading = { title: '版本说明', text: remote.releaseNotes };
    else if (target.dataset.read === 'error') state.reading = { title: '启动信息', text: state.error };
    state.readingPage = 0; state.settingsOpen = false; render(); document.querySelector('#reader-close')?.focus();
  } else if (target.id === 'reader-close' || target.id === 'reader-dismiss') {
    state.reading = null; render();
  } else if (target.id === 'reader-prev' || target.id === 'reader-next') {
    state.readingPage += target.id === 'reader-next' ? 1 : -1; render(); document.querySelector(`#${target.id}`)?.focus();
  } else if (target.id === 'announcement-prev' || target.id === 'announcement-next') {
    const count = remotePresentation(state.remote, state.version, state.platform).announcements.length;
    state.announcementIndex = Math.max(0, Math.min(count - 1, state.announcementIndex + (target.id === 'announcement-next' ? 1 : -1))); render();
  } else if (target.id === 'clients-next') {
    state.clientPage = (state.clientPage + 1) % Math.ceil(state.urls.length / 4); render();
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
  if (event.key === 'Escape' && (state.settingsOpen || state.reading)) { state.settingsOpen = false; state.reading = null; render(); document.querySelector('#settings-toggle')?.focus(); }
  if (event.key === 'Tab' && (state.settingsOpen || state.reading)) {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return;
    const buttons = [...dialog.querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
render();
if (state.desktop) {
  listen('launcher-progress', ({ payload }) => { state.phase = payload.phase; state.message = payload.text; render(); });
  listen('launcher-remote-config', ({ payload }) => { applyRemote(payload); render(); });
  invoke('launcher_status').then(updateStatus).then(render).catch((error) => { state.error = String(error); render(); }).finally(() => refreshRemote(false));
  setInterval(() => refreshRemote(true), 5 * 60 * 1000);
} else { state.message = '界面预览：通过桌面启动器选择资源并开始游戏。'; render(); }
