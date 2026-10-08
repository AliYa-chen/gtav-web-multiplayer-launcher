import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import metadata from '../package.json';
import { escapeHtml as html, displayDirectory, progressValue, readBackground, saveBackground, remotePresentation, launcherActions, paginateText, lanSettings, lanActions, lanRequest } from './view-state.js';
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
  updateRequired: false, caInstallFailed: false,
  lan: null, lanOpen: false, lanSettings: lanSettings(null),
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
  if (value.lan) {
    state.lan = value.lan;
    if (!state.lanOpen) resetLanSettings();
  }
  // 操作返回的状态可能早于刚收到的更新事件，不能用它解除已经确认的更新要求。
  if (value.remote_configuration && !state.updateRequired) applyRemote(value.remote_configuration);
  if (value.update_required === true) state.updateRequired = true;
}
function resetLanSettings() {
  state.lanSettings = lanSettings(state.lan);
}
function applyRemote(snapshot) {
  state.remote = snapshot;
  state.remoteError = typeof snapshot?.error === 'string' ? snapshot.error : '';
  if (snapshot?.source === 'remote' && snapshot?.stale !== true) {
    state.updateRequired = remotePresentation(snapshot, state.version, state.platform).update;
  }
  if (state.updateRequired) { state.settingsOpen = false; state.reading = null; state.lanOpen = false; }
  if (snapshot?.source !== 'remote' || snapshot?.stale === true) state.reading = null;
}
function render() {
  const running = state.urls.length > 0, ready = Boolean(state.resources);
  const focusedBackground = document.activeElement?.dataset?.background;
  const focusedUpdateAction = document.activeElement?.id;
  const focusedLanField = state.lanOpen && document.activeElement?.dataset?.lanField ? document.activeElement : null;
  const lanUrl = state.lan?.running_url || '', lanGuideUrl = state.lan?.guide_url || '';
  const caFingerprint = state.lan?.ca_fingerprint || '', lanAddress = state.lan?.host_address || state.lanSettings.address;
  const lanAddresses = [...new Set([...(state.lan?.addresses || []), ...(lanAddress ? [lanAddress] : [])])];
  const sharing = lanActions(state), caEnabled = state.desktop && !state.busy && !state.updateRequired;
  const actions = launcherActions(state, state.remoteBusy), remote = remotePresentation(state.remote, state.version, state.platform);
  const background = backgrounds.find((item) => item.id === state.background) || backgrounds[0];
  state.announcementIndex = Math.min(state.announcementIndex, Math.max(0, remote.announcements.length - 1));
  state.clientPage = Math.min(state.clientPage, Math.max(0, Math.ceil(state.urls.length / 4) - 1));
  const announcement = remote.announcements[state.announcementIndex];
  const visibleClients = state.urls.slice(state.clientPage * 4, state.clientPage * 4 + 4);
  const pages = state.reading ? paginateText(state.reading.text) : [];
  state.readingPage = Math.min(state.readingPage, Math.max(0, pages.length - 1));
  document.documentElement.style.setProperty('--scene', `url("${background.image}")`);
  app.innerHTML = `<div class="scene" aria-hidden="true"></div><div class="shell" ${state.updateRequired || state.lanOpen ? 'inert aria-hidden="true"' : ''}>
    <main><header><div class="brand"><span class="brand__mark">V<span>ONLINE</span></span><div>GTA5DATA<span>公共战局启动器</span></div></div><div class="header-actions"><span class="pill"><span class="status-dot ${running ? 'live' : ''}"></span>${running ? `${state.urls.length} 个客户端已启动` : '启动器就绪'}</span>
      <div class="settings"><button id="settings-toggle" class="settings-toggle ${state.settingsOpen ? 'is-open' : ''}" aria-expanded="${state.settingsOpen}" aria-controls="background-picker">${icons.settings} 设置 ${icons.chevron}</button>
        ${state.settingsOpen ? `<button class="picker-backdrop" id="picker-dismiss" aria-label="关闭背景设置"></button><section id="background-picker" class="background-picker" role="dialog" aria-modal="true" aria-labelledby="picker-title"><div class="picker-heading"><div><p class="eyebrow">YOUR LOS SANTOS</p><h2 id="picker-title">换一处风景</h2><span>12 个场景 · 主图完整展示</span></div><button id="picker-close" class="icon-button" aria-label="关闭背景设置">${icons.close}</button></div><div class="background-grid">${backgrounds.map((item) => `<button class="background-option ${item.id === state.background ? 'selected' : ''}" data-background="${item.id}" aria-pressed="${item.id === state.background}" aria-label="选择背景：${html(item.label)}"><img src="${item.image}" alt="${html(item.label)}" loading="lazy"><span>${html(item.label)}${item.id === state.background ? icons.check : ''}</span></button>`).join('')}</div></section>` : ''}
      </div></div></header>
      <section class="hero"><div class="hero__copy"><p class="eyebrow"><span class="status-dot live"></span> 你的世界，共同的战局</p><h1>下一站，<em>洛圣都。</em></h1><p class="hero__description">带上你的游戏资源，从单人探索到公共战局。</p></div><span class="scene-label">${html(background.label)}</span></section>
      <div class="dashboard"><div class="game-column"><section class="glass setup-card"><div class="section-heading"><span class="step-number">01</span><div><h2>选择游戏资源</h2><p>选择资源文件夹，或其中的 b / data 目录。</p></div><span class="resource-badge ${ready ? 'verified' : ''}">${ready ? `${icons.check} 已通过校验` : '首次设置'}</span></div>
        <button class="directory" id="choose" ${actions.choose ? '' : 'disabled'}><span class="folder-icon">${icons.folder}</span><span class="directory__text"><small>${state.selected ? '所选目录' : '游戏资源目录'}</small><span title="${html(state.selected)}">${html(displayDirectory(state.selected))}</span></span><span class="browse">${state.selected ? '更换' : '选择'} ↗</span></button>
        ${ready ? `<div class="resource-detail"><span>${icons.check} ${Number(state.resources.manifest_file_count || 0).toLocaleString()} 项资源</span><span>资源只读，不修改游戏数据</span></div>` : '<p class="directory-note">支持原始资源包；自动识别目录，使用启动器内置游戏页面。</p>'}
        <div class="resource-help">${state.desktop ? '<button id="get-game-resources" type="button" class="text-button">没有游戏本体？ ↗</button>' : '<a class="text-button" href="https://archive.org/download/gta5-wasm/" target="_blank" rel="noopener noreferrer">没有游戏本体？ ↗</a>'}</div>
      </section>
      <section class="glass launch-card"><div class="launch-main"><div class="launch-copy"><div class="section-heading"><span class="step-number">02</span><div><h2>${running ? '游戏已准备就绪' : '启动你的游戏'}</h2><p>${running ? '继续游戏，或邀请另一个客户端加入战局。' : '准备完成后，在默认浏览器中开启游戏。'}</p></div></div>
          <div class="progress-status ${state.error ? 'has-error' : ''}" role="status" aria-live="polite"><span class="${state.busy ? 'spinner' : 'status-dot'}"></span><span class="status-copy" title="${html(state.error || state.message)}">${html(state.error || state.message)}</span>${state.error ? '<button class="text-button" data-read="error">详情</button>' : ''}</div>
          ${state.busy ? `<div class="progress-track"><span style="width:${progressValue(state.phase)}%"></span></div>` : ''}</div>
        <div class="launch-actions"><button id="launch" class="primary" ${actions.launch ? '' : 'disabled'}>${running ? '打开游戏' : state.busy ? '正在准备…' : '启动游戏'}${icons.arrow}</button>
          ${running ? `<button id="additional" class="secondary" ${actions.additional ? '' : 'disabled'}>另开一个客户端</button><button id="stop" class="text-button" ${actions.stop ? '' : 'disabled'}>停止本机游戏服务</button>` : `<button id="verify" class="text-button" ${actions.launch ? '' : 'disabled'}>检查资源</button>`}
          ${state.desktop ? `<button id="lan-setup" class="secondary" ${sharing.configure ? '' : 'disabled'}>${lanUrl ? '局域网共享设置' : '局域网共享'}</button>${lanUrl ? `<button id="lan-stop" class="text-button" ${sharing.stop ? '' : 'disabled'}>停止局域网共享</button>` : ''}` : ''}</div></div>
      <div class="ca-trust-actions"><div><span>本机浏览器证书信任</span><small>BinGo Root CA · 只需安装一次</small></div><div class="ca-trust-actions__buttons"><button id="ca-install" class="secondary" ${caEnabled ? '' : 'disabled'}>安装并信任 CA</button><button id="ca-save" class="text-button" ${caEnabled ? '' : 'disabled'}>下载 CA 证书</button></div>${state.caInstallFailed ? '<p class="ca-trust-fallback" role="status">自动安装未完成。可点击“下载 CA 证书”，按系统说明手动安装并信任；浏览器安装指引见局域网 HTTP 引导页。</p>' : ''}</div>
      ${lanUrl ? `<div class="lan-address"><span class="status-dot live"></span><div><span>朋友首次访问地址</span><code>${html(lanGuideUrl || '-')}</code><small>安装并信任内置 CA 后，页面会检测并跳转 HTTPS 游戏。</small></div><button id="lan-copy" class="secondary" ${state.busy || !lanGuideUrl ? 'disabled' : ''}>复制邀请地址</button></div>` : ''}
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
    </main></div>${state.reading ? `<div class="reader-overlay"><button id="reader-dismiss" class="reader-backdrop" aria-label="关闭详情"></button><section class="glass reader" role="dialog" aria-modal="true" aria-labelledby="reader-title"><div class="reader-heading"><h2 id="reader-title">${html(state.reading.title)}</h2><button id="reader-close" class="icon-button" aria-label="关闭详情">${icons.close}</button></div><div class="reader-text">${html(pages[state.readingPage] || '')}</div><div class="reader-footer"><span>第 ${state.readingPage + 1} / ${Math.max(1, pages.length)} 页</span><div class="pager"><button id="reader-prev" ${state.readingPage ? '' : 'disabled'} aria-label="上一页">‹</button><button id="reader-next" ${state.readingPage < pages.length - 1 ? '' : 'disabled'} aria-label="下一页">›</button></div></div></section></div>` : ''}
    ${state.lanOpen && !state.updateRequired ? `<section class="lan-overlay" role="dialog" aria-modal="true" aria-labelledby="lan-title" tabindex="-1"><div class="glass lan-panel"><div class="reader-heading"><div><p class="eyebrow">共享洛圣都</p><h2 id="lan-title">局域网共享</h2></div><button id="lan-close" class="icon-button" aria-label="关闭局域网共享设置" ${state.busy ? 'disabled' : ''}>${icons.close}</button></div><p class="lan-description">在这台电脑共享游戏资源。朋友通过局域网 IP 访问安装引导页，信任证书后进入游戏，无需另行准备游戏资源包。</p><div class="lan-fields"><label class="lan-fields__address">本机局域网 IP<input id="lan-address" data-lan-field="address" type="text" list="lan-ip-options" value="${html(state.lanSettings.address)}" placeholder="选择或输入本机 IP，例如 192.168.1.2" autocomplete="off" spellcheck="false" ${lanUrl || state.busy ? 'disabled' : ''}><datalist id="lan-ip-options">${lanAddresses.map((address) => `<option value="${html(address)}"></option>`).join('')}</datalist></label><label>安装引导 HTTP 端口<input id="lan-http-port" data-lan-field="httpPort" type="number" min="1" max="65535" value="${html(state.lanSettings.httpPort)}" ${lanUrl || state.busy ? 'disabled' : ''}></label><label>游戏 HTTPS 端口<input id="lan-port" data-lan-field="port" type="number" min="1" max="65535" value="${html(state.lanSettings.port)}" ${lanUrl || state.busy ? 'disabled' : ''}></label></div><div class="lan-guidance"><span class="status-dot ${lanUrl ? 'live' : ''}"></span><div><p>启动器使用内置 CA 为当前局域网 IP 签发证书。所有共享主机和端口共用同一 CA，朋友信任一次即可。</p><p>朋友打开 HTTP 引导页下载 CA，按系统说明安装并信任。页面会检测 HTTPS 连接，成功后自动进入游戏；部分浏览器需要重启后重试。</p><p>允许两个端口通过本机防火墙。浏览器按需读取资源，在朋友的电脑上运行游戏；请保持本机与启动器开启。</p></div></div>${lanUrl ? `<div class="lan-result"><span>首次访问</span><code>${html(lanGuideUrl || '-')}</code><button id="lan-modal-copy" class="secondary" ${state.busy || !lanGuideUrl ? 'disabled' : ''}>复制邀请地址</button></div><div class="lan-result"><span>已信任后进入</span><code>${html(lanUrl)}</code><button id="lan-game-copy" class="secondary" ${state.busy ? 'disabled' : ''}>复制游戏地址</button></div>` : ''}${caFingerprint ? `<div class="lan-result lan-fingerprint"><span>CA SHA-256 指纹</span><code>${html(caFingerprint)}</code><button id="lan-fingerprint-copy" class="secondary" ${state.busy ? 'disabled' : ''}>复制指纹</button><small>朋友安装前请与你核对指纹，仅信任认识的共享主机。</small></div>` : ''}<div class="lan-operation" role="status" aria-live="polite">${state.busy ? '<span class="spinner"></span>' : ''}<p class="${state.error ? 'has-error' : ''}">${html(state.error || (!state.selected ? '请先在主界面选择游戏资源目录。' : state.busy ? state.message : lanUrl ? '共享已开启；本机游戏服务可同时运行。' : '准备完成后开启共享。'))}</p></div><div class="lan-panel__actions">${lanUrl ? `<button id="lan-modal-stop" class="secondary" ${sharing.stop ? '' : 'disabled'}>停止局域网共享</button>` : `<button id="lan-start" class="primary" ${sharing.start && state.lanSettings.address ? '' : 'disabled'}>${state.busy ? '正在准备…' : '开启共享'}${icons.arrow}</button>`}<button id="lan-done" class="text-button" ${state.busy ? 'disabled' : ''}>完成</button></div></div></section>` : ''}
    ${state.updateRequired ? `<section class="mandatory-update" role="alertdialog" aria-modal="true" aria-labelledby="mandatory-update-title" aria-describedby="mandatory-update-description" tabindex="-1"><div class="glass mandatory-update__panel"><div class="mandatory-update__icon" aria-hidden="true">${icons.download}</div><p class="eyebrow">启动器更新</p><h2 id="mandatory-update-title">请更新后继续</h2><p id="mandatory-update-description">新版启动器已发布，请下载并打开新版后继续使用。</p><div class="mandatory-update__versions"><span>当前版本 <strong>${html(state.version)}</strong></span><span>最新版本 <strong>${html(remote.latest || '-')}</strong></span></div><div class="mandatory-update__notes">${remote.releaseNotes ? `<p>${html(remote.releaseNotes)}</p>` : '<p>-</p>'}</div><div class="mandatory-update__actions">${remote.downloadAvailable ? `<button id="mandatory-update-download" class="primary" ${state.remoteBusy || !state.desktop ? 'disabled' : ''}>${icons.download} 下载新版本</button>` : '<p class="mandatory-update__missing">当前系统的下载地址暂不可用，请重新检查。</p>'}<button id="mandatory-update-check" class="secondary" ${actions.refresh ? '' : 'disabled'}>${state.remoteBusy ? '<span class="spinner"></span>' : icons.refresh}${state.remoteBusy ? '正在检查…' : '重新检查'}</button></div>${state.remoteError ? `<p class="remote-note" role="status">${html(state.remoteError)}</p>` : ''}<p class="mandatory-update__footnote">下载后退出当前启动器，替换并打开新版。</p></div></section>` : ''}`;
  if (state.updateRequired) {
    const action = ['mandatory-update-download', 'mandatory-update-check'].includes(focusedUpdateAction)
      ? document.querySelector(`#${focusedUpdateAction}:not(:disabled)`) : null;
    (action || document.querySelector('.mandatory-update button:not(:disabled)') || document.querySelector('.mandatory-update'))?.focus({ preventScroll: true });
  }
  if (focusedBackground && state.settingsOpen) document.querySelector(`[data-background="${focusedBackground}"]`)?.focus({ preventScroll: true });
  if (focusedLanField && state.lanOpen) {
    const replacement = document.querySelector(`#${focusedLanField.id}`);
    replacement?.focus({ preventScroll: true });
    if (typeof focusedLanField.selectionStart === 'number') replacement?.setSelectionRange?.(focusedLanField.selectionStart, focusedLanField.selectionEnd);
  }
}
async function operation(work) {
  if (state.busy || !state.desktop || state.updateRequired) return;
  state.busy = true; state.error = ''; render();
  try { await work(); }
  catch (error) { state.error = typeof error === 'string' ? error : error.message || String(error); state.message = ''; }
  finally { state.busy = false; render(); }
}
function requireCurrentVersion() {
  if (state.updateRequired) throw new Error('请先更新启动器至最新版本。');
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
  requireCurrentVersion();
  state.phase = 'checking'; state.message = '正在识别资源目录…'; render();
  updateStatus(await invoke('prepare_game', { selected: state.selected }));
  state.phase = 'ready'; state.message = '资源与运行引擎已就绪。';
}
app.addEventListener('click', async (event) => {
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  if (state.updateRequired && !['mandatory-update-download', 'mandatory-update-check'].includes(target.id)) return;
  if (target.id === 'get-game-resources') {
    if (!state.desktop) return;
    try { await invoke('open_game_resource_page'); }
    catch { state.error = '无法打开浏览器，请访问 https://archive.org/download/gta5-wasm/。'; render(); }
  } else if (target.id === 'settings-toggle') {
    state.settingsOpen = !state.settingsOpen; state.reading = null; render();
    if (state.settingsOpen) document.querySelector('.background-option.selected')?.focus();
  } else if (target.id === 'picker-close' || target.id === 'picker-dismiss') {
    state.settingsOpen = false; render(); document.querySelector('#settings-toggle')?.focus();
  } else if (target.id === 'ca-install') {
    await operation(async () => {
      state.caInstallFailed = false; state.phase = ''; state.message = '正在请求安装并信任 CA，请完成系统授权…'; render();
      try { state.message = await invoke('install_lan_ca'); }
      catch (error) { state.caInstallFailed = true; throw error; }
    });
  } else if (target.id === 'ca-save') {
    await operation(async () => {
      state.phase = ''; state.message = '请选择 CA 证书保存位置…'; render();
      const saved = await invoke('save_lan_ca_certificate');
      state.message = saved ? `已保存 CA 证书：${saved}。请按系统说明安装并信任；浏览器安装指引见局域网 HTTP 引导页。` : '已取消保存 CA 证书。';
    });
  } else if (target.id === 'lan-setup') {
    if (!lanActions(state).configure) return;
    state.lanOpen = true; state.settingsOpen = false; state.reading = null; state.error = ''; resetLanSettings(); render();
    document.querySelector('#lan-address')?.focus();
  } else if (target.id === 'lan-close' || target.id === 'lan-done') {
    state.lanOpen = false; state.error = ''; render(); document.querySelector('#lan-setup')?.focus();
  } else if (target.id === 'lan-start') {
    if (!lanActions(state).start) return;
    await operation(async () => {
      const request = lanRequest(state.lanSettings);
      if (!state.resources) await prepare();
      requireCurrentVersion();
      updateStatus(await invoke('start_lan_share', request));
      state.message = '局域网共享已开启。';
    });
  } else if (target.id === 'lan-stop' || target.id === 'lan-modal-stop') {
    await operation(async () => { updateStatus(await invoke('stop_lan_share')); state.message = '局域网共享已停止。'; });
  } else if (['lan-copy', 'lan-modal-copy', 'lan-game-copy', 'lan-fingerprint-copy'].includes(target.id)) {
    const value = target.id === 'lan-fingerprint-copy' ? state.lan?.ca_fingerprint : target.id === 'lan-game-copy' ? state.lan?.running_url : state.lan?.guide_url;
    if (value) {
      try { if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(value); state.error = ''; state.message = target.id === 'lan-fingerprint-copy' ? 'CA 指纹已复制。' : '地址已复制。'; render(); }
      catch { state.error = '无法访问剪贴板，请手动复制。'; render(); }
    }
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
  } else if (target.id === 'check-updates' || target.id === 'mandatory-update-check') await refreshRemote();
  else if (target.id === 'update-download' || target.id === 'mandatory-update-download' || target.id === 'website') {
    if (!state.desktop || state.remoteBusy) return;
    state.remoteBusy = true; state.remoteError = ''; render();
    const download = target.id !== 'website';
    try { await invoke(download ? 'open_update_download' : 'open_project_website'); }
    catch { state.remoteError = download ? '暂时没有适用于当前系统的下载，请稍后检查更新。' : '暂时无法打开服务器状态页面。'; }
    finally { state.remoteBusy = false; render(); }
  } else if (target.id === 'choose') await operation(async () => {
    const value = await invoke('choose_game_directory');
    if (value) { state.selected = value; state.resources = null; state.phase = ''; state.message = '目录已选择，启动时将自动识别和校验。'; }
  });
  else if (target.id === 'verify') await operation(prepare);
  else if (target.id === 'launch') await operation(async () => {
    if (!state.urls.length) { if (!state.resources) await prepare(); requireCurrentVersion(); updateStatus(await invoke('start_game', { additional: false })); }
    requireCurrentVersion();
    await invoke('open_game', { index: 0 }); state.message = '游戏已在浏览器打开，请保持启动器运行。';
  });
  else if (target.id === 'additional') await operation(async () => {
    updateStatus(await invoke('start_game', { additional: true })); requireCurrentVersion(); await invoke('open_game', { index: state.urls.length - 1 });
    state.message = '新客户端已打开，可以加入同一个公共战局。';
  });
  else if (target.id === 'stop') await operation(async () => { updateStatus(await invoke('stop_game')); state.message = '游戏服务已停止。'; });
  else if (target.dataset.open !== undefined) await operation(() => invoke('open_game', { index: Number(target.dataset.open) }));
});
app.addEventListener('input', (event) => {
  const field = event.target?.dataset?.lanField;
  if (!field || !state.lanOpen) return;
  state.lanSettings[field] = event.target.value;
});
app.addEventListener('change', (event) => {
  const field = event.target?.dataset?.lanField;
  if (field && state.lanOpen) { state.lanSettings[field] = event.target.value; render(); }
});
document.addEventListener('click', (event) => {
  if (state.settingsOpen && !event.target.closest('.settings')) { state.settingsOpen = false; render(); }
});
document.addEventListener('keydown', (event) => {
  if (state.updateRequired) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); return; }
    if (event.key === 'Tab') {
      const dialog = document.querySelector('.mandatory-update');
      const buttons = [...(dialog?.querySelectorAll('button:not(:disabled)') || [])];
      const first = buttons[0], last = buttons.at(-1);
      if (!first) { event.preventDefault(); dialog?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    return;
  }
  if (state.lanOpen) {
    const dialog = document.querySelector('.lan-overlay');
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!state.busy) { state.lanOpen = false; state.error = ''; render(); document.querySelector('#lan-setup')?.focus(); }
    } else if (event.key === 'Tab') {
      const controls = [...(dialog?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)') || [])];
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); dialog?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    return;
  }
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
