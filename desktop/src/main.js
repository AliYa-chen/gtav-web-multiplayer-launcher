import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import metadata from '../package.json';
import { escapeHtml as html, displayDirectory, progressValue, readBackground, saveBackground, remotePresentation, launcherActions, paginateText, lanSettings, lanActions, lanRequest, clientCapacity, clientPage } from './view-state.js';
import { backgrounds } from './backgrounds.js';
import './style.css';

const app = document.querySelector('#app');
const backgroundIds = backgrounds.map((item) => item.id);
const storage = { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };
const state = {
  desktop: isTauri(), selected: '', resources: null, clients: [], urls: [], invitationUrls: [], version: metadata.version, busy: false, phase: '',
  message: '选择你的游戏资源，下一站就是洛圣都。', error: '', background: readBackground(storage, backgroundIds), settingsOpen: false,
  remote: null, remoteBusy: false, remoteError: '', platform: '',
  announcementIndex: 0, clientPage: 0, clientCapacity: 2, clientFocusId: null, reading: null, readingPage: 0,
  updateRequired: false, caInstallFailed: false, caInstallError: '', caSystemStatus: null,
  lan: null, lanOpen: false, lanSettings: lanSettings(null),
};
let caSystemRequest = null, caSystemRetryTimer = null;
let clientMeasureFrame = null;
let measuredFriendHeight = 0;
const clientResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleClientMeasurement) : null;
function findClient(id) { return state.clients.find((client) => String(client.id) === String(id)); }
function primaryClient() { return state.clients.find((client) => client.primary); }
function openClient(client) {
  const identity = client.legacyIndex === undefined ? { id: client.id } : { index: client.legacyIndex };
  return invoke('open_game', { ...identity, trusted: systemCaTrusted() });
}
function scheduleClientMeasurement() {
  if (clientMeasureFrame !== null || typeof requestAnimationFrame !== 'function') return;
  clientMeasureFrame = requestAnimationFrame(() => {
    clientMeasureFrame = null;
    if (!state.clients.length || state.lanOpen || state.updateRequired) return;
    const details = document.querySelector('.launch-details'), addresses = document.querySelector('.addresses');
    const cards = [...(addresses?.querySelectorAll('.client-address') || [])];
    if (!details || !addresses || !cards.length) return;
    const top = addresses.getBoundingClientRect().top - details.getBoundingClientRect().top + details.scrollTop;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(addresses) : null;
    const friendCards = cards.filter((card) => findClient(card.dataset.clientId)?.primary === false);
    if (friendCards.length) measuredFriendHeight = Math.max(...friendCards.map((card) => card.getBoundingClientRect().height));
    // A page containing only the shorter local card must keep the capacity used by the friend cards.
    const cardHeight = Math.max(...cards.map((card) => card.getBoundingClientRect().height), state.clients.some((client) => !client.primary) ? measuredFriendHeight : 0);
    const capacity = clientCapacity({ availableHeight: details.clientHeight - top,
      cardHeight, rowGap: parseFloat(style?.rowGap) });
    if (capacity === null || capacity === state.clientCapacity) return;
    const anchorId = findClient(state.clientFocusId)?.id ?? state.clients[state.clientPage * state.clientCapacity]?.id ?? null;
    state.clientCapacity = capacity;
    state.clientPage = clientPage(state.clients, capacity, state.clientPage, anchorId);
    render();
  });
}
function systemCaTrusted(status = state.caSystemStatus) {
  return status?.installed === true && status?.trusted === true;
}
function systemCaNeedsRetry(status) {
  return !systemCaTrusted(status);
}
function scheduleCaSystemCheck() {
  clearTimeout(caSystemRetryTimer);
  caSystemRetryTimer = null;
  if (!state.desktop || !systemCaNeedsRetry(state.caSystemStatus)) return;
  caSystemRetryTimer = setTimeout(() => { caSystemRetryTimer = null; void refreshCaSystemStatus(); }, 4000);
}
async function refreshCaSystemStatus(fresh = false) {
  if (!state.desktop) return;
  if (caSystemRequest) {
    if (!fresh) return caSystemRequest;
    await caSystemRequest;
  }
  caSystemRequest = invoke('check_lan_ca_status').then((value) => {
    state.caSystemStatus = value && typeof value === 'object' ? value : { installed: false, trusted: false, message: '' };
    if (state.caSystemStatus.installed === true && state.caSystemStatus.trusted === true) {
      if (state.error === state.caInstallError) state.error = '';
      state.caInstallFailed = false;
      state.caInstallError = '';
    }
    scheduleCaSystemCheck();
    if (!state.busy && !state.lanOpen) render();
    return state.caSystemStatus;
  }).catch((error) => {
    state.caSystemStatus = { installed: false, trusted: false, message: '系统证书状态暂不可用，可手动安装或下载 CA。', error: String(error) };
    scheduleCaSystemCheck();
    if (!state.busy && !state.lanOpen) render();
    return state.caSystemStatus;
  }).finally(() => { caSystemRequest = null; });
  return caSystemRequest;
}
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
  const visibleIds = state.clients.slice(state.clientPage * state.clientCapacity, (state.clientPage + 1) * state.clientCapacity).map((client) => client.id);
  state.selected = value.selected_directory || state.selected;
  state.resources = value.resources || null;
  state.clients = Array.isArray(value.clients) ? value.clients : (value.running_urls || []).map((url, index) => ({
    id: index, number: index + 1, primary: url === value.lan?.running_url,
    running_url: url, invitation_url: value.invitation_urls?.[index] || '', legacyIndex: index,
  }));
  state.urls = state.clients.map((client) => client.running_url);
  state.invitationUrls = state.clients.map((client) => client.invitation_url);
  state.clientPage = clientPage(state.clients, state.clientCapacity, state.clientPage, visibleIds.find((id) => findClient(id)) ?? null);
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
  const lanAddress = state.lan?.host_address || state.lan?.addresses?.[0] || '';
  const lanAddresses = [...new Set([...(state.lan?.addresses || []), ...(lanAddress ? [lanAddress] : [])])];
  const sharing = lanActions(state), caEnabled = state.desktop && !state.busy && !state.updateRequired;
  const caSystemTrusted = systemCaTrusted();
  const actions = launcherActions(state, state.remoteBusy), remote = remotePresentation(state.remote, state.version, state.platform);
  const background = backgrounds.find((item) => item.id === state.background) || backgrounds[0];
  state.announcementIndex = Math.min(state.announcementIndex, Math.max(0, remote.announcements.length - 1));
  state.clientPage = clientPage(state.clients, state.clientCapacity, state.clientPage);
  const clientPages = Math.ceil(state.clients.length / state.clientCapacity);
  const announcement = remote.announcements[state.announcementIndex];
  const visibleClients = state.clients.slice(state.clientPage * state.clientCapacity, (state.clientPage + 1) * state.clientCapacity);
  const pages = state.reading ? paginateText(state.reading.text) : [];
  state.readingPage = Math.min(state.readingPage, Math.max(0, pages.length - 1));
  document.documentElement.style.setProperty('--scene', `url("${background.image}")`);
  app.innerHTML = `<div class="scene" aria-hidden="true"></div><div class="shell" ${state.updateRequired || state.lanOpen ? 'inert aria-hidden="true"' : ''}>
    <main><header><div class="brand"><span class="brand__mark">V<span>ONLINE</span></span><div>GTA5DATA<span>公共战局启动器</span></div></div><div class="header-actions"><span class="pill"><span class="status-dot ${running ? 'live' : ''}"></span>${running ? `${state.urls.length} 个客户端已启动` : '启动器就绪'}</span>
      <div class="settings"><button id="settings-toggle" class="settings-toggle ${state.settingsOpen ? 'is-open' : ''}" aria-expanded="${state.settingsOpen}" aria-controls="background-picker">${icons.settings} 设置 ${icons.chevron}</button>
        ${state.settingsOpen ? `<button class="picker-backdrop" id="picker-dismiss" aria-label="关闭背景设置"></button><section id="background-picker" class="background-picker" role="dialog" aria-modal="true" aria-labelledby="picker-title"><div class="picker-heading"><div><p class="eyebrow">YOUR LOS SANTOS</p><h2 id="picker-title">换一处风景</h2><span>12 个场景 · 主图完整展示</span></div><button id="picker-close" class="icon-button" aria-label="关闭背景设置">${icons.close}</button></div><div class="background-grid">${backgrounds.map((item) => `<button class="background-option ${item.id === state.background ? 'selected' : ''}" data-background="${item.id}" aria-pressed="${item.id === state.background}" aria-label="选择背景：${html(item.label)}"><img src="${item.image}" alt="${html(item.label)}" loading="lazy"><span>${html(item.label)}${item.id === state.background ? icons.check : ''}</span></button>`).join('')}</div></section>` : ''}
      </div></div></header>
      <section class="hero"><div class="hero__copy"><h1>下一站，<em>洛圣都。</em></h1><p class="hero__description">选择资源，开启共享战局。</p></div><span class="scene-label">${html(background.label)}</span></section>
      <div class="dashboard"><div class="game-column"><section class="glass setup-card"><div class="section-heading"><span class="step-number">01</span><div><h2>选择游戏资源</h2><p>选择资源文件夹，或其中的 b / data 目录。</p></div><span class="resource-badge ${ready ? 'verified' : ''}">${ready ? `${icons.check} 已通过校验` : '首次设置'}</span></div>
        <button class="directory" id="choose" ${actions.choose ? '' : 'disabled'}><span class="folder-icon">${icons.folder}</span><span class="directory__text"><small>${state.selected ? '所选目录' : '游戏资源目录'}</small><span title="${html(state.selected)}">${html(displayDirectory(state.selected))}</span></span><span class="browse">${state.selected ? '更换' : '选择'} ↗</span></button>
        <div class="resource-footer">${ready ? `<div class="resource-detail"><span>${icons.check} ${Number(state.resources.manifest_file_count || 0).toLocaleString()} 项资源</span><span>资源只读，不修改游戏数据</span></div>` : '<p class="directory-note">自动识别资源目录，使用内置游戏页面。</p>'}
        <div class="resource-help">${state.desktop ? '<button id="get-game-resources" type="button" class="text-button">没有游戏本体？ ↗</button>' : '<a class="text-button" href="https://archive.org/download/gta5-wasm/" target="_blank" rel="noopener noreferrer">没有游戏本体？ ↗</a>'}</div></div>
      </section>
      <section class="glass launch-card"><div class="launch-main"><div class="launch-heading"><div class="section-heading"><span class="step-number">02</span><div><h2>${running ? '游戏已准备就绪' : '启动你的游戏'}</h2></div></div>${running ? `<button id="stop" class="text-button launch-stop" title="停止所有客户端与局域网共享" ${actions.stop ? '' : 'disabled'}>停止全部</button>` : ''}</div>
        <div class="progress-status ${state.error ? 'has-error' : ''}" role="status" aria-live="polite"><span class="${state.busy ? 'spinner' : 'status-dot'}"></span><span class="status-copy" title="${html(state.error || state.message)}">${html(state.error || state.message)}</span>${state.error ? '<button class="text-button" data-read="error">详情</button>' : ''}</div>
        ${state.busy ? `<div class="progress-track"><span style="width:${progressValue(state.phase)}%"></span></div>` : ''}</div>
        <div class="launch-actions"><button id="launch" class="primary" ${actions.launch ? '' : 'disabled'}>${primaryClient() ? '打开游戏' : state.busy ? '正在准备…' : '启动游戏'}${icons.arrow}</button>
          ${running ? `<button id="additional" class="secondary" ${actions.additional ? '' : 'disabled'}>另开一个客户端</button>` : `<button id="verify" class="text-button" ${actions.launch ? '' : 'disabled'}>检查资源</button>`}
          ${state.desktop ? `<button id="lan-setup" class="secondary" ${sharing.configure ? '' : 'disabled'}>共享设置</button>` : ''}</div>
        <div class="launch-details">${caSystemTrusted ? '' : `<div class="ca-trust-actions"><div><span>本机浏览器证书信任</span><small title="${html(state.caSystemStatus?.message || state.caSystemStatus?.error || '')}">${html(state.caSystemStatus?.installed === true ? '系统已安装但未信任，请完成系统信任' : state.caSystemStatus?.message || 'BinGo Root CA · 只需安装一次')}</small></div><div class="ca-trust-actions__buttons"><button id="ca-install" class="secondary" ${caEnabled ? '' : 'disabled'}>安装并信任 CA</button><button id="ca-save" class="text-button" ${caEnabled ? '' : 'disabled'}>下载 CA 证书</button></div>${state.caInstallFailed ? '<p class="ca-trust-fallback" role="status">自动安装未完成，可下载证书手动信任。系统确认信任后会自动隐藏此提示。</p>' : ''}</div>`}
        ${running ? `<div class="client-list"><div class="client-list__heading"><span>客户端</span>${clientPages > 1 ? `<button id="clients-next" class="text-button client-page" aria-label="显示下一组客户端">${state.clientPage + 1} / ${clientPages} ${icons.arrow}</button>` : state.clients.some((client) => !client.primary) ? '<small>复制后发给朋友</small>' : ''}</div><div class="addresses">${visibleClients.map((client) => {
          const invitation = client.invitation_url, address = client.primary ? client.running_url : invitation, number = html(client.number), id = html(client.id);
          return `<div class="client-address" data-client-id="${id}"><div class="client-address__heading"><span><span class="status-dot live"></span>客户端 ${number}${client.primary ? ' · 本机' : ' · 朋友'}</span></div><button data-stop-client="${id}" class="text-button client-close" aria-label="停止客户端 ${number} 的游戏与共享服务" title="只停止此客户端的游戏与共享服务" ${state.busy ? 'disabled' : ''}>停止服务</button>${client.primary ? '' : `<div class="client-address__actions"><button data-open="${id}" class="text-button" ${state.busy || state.updateRequired ? 'disabled' : ''}>本机打开 ↗</button><button data-copy-client="${id}" class="secondary client-copy" ${state.busy || !invitation ? 'disabled' : ''}>复制邀请地址</button></div>`}<code title="${html(address)}">${html(address)}</code></div>`;
        }).join('')}</div></div>` : ''}</div></section></div>
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
    ${state.lanOpen && !state.updateRequired ? `<section class="lan-overlay" role="dialog" aria-modal="true" aria-labelledby="lan-title" tabindex="-1"><div class="glass lan-panel"><div class="reader-heading"><div><p class="eyebrow">共享洛圣都</p><h2 id="lan-title">局域网共享设置</h2></div><button id="lan-close" class="icon-button" aria-label="关闭局域网共享设置" ${state.busy ? 'disabled' : ''}>${icons.close}</button></div><p class="lan-description">启动游戏时自动使用本机局域网 IP 共享资源。“另开一个客户端”会生成独立邀请地址，发给朋友即可使用。</p><div class="lan-fields"><label class="lan-fields__address">本机局域网 IP<input id="lan-address" data-lan-field="address" type="text" list="lan-ip-options" value="${html(state.lanSettings.address)}" placeholder="${html(lanAddress ? `自动检测：${lanAddress}（留空自动选择）` : '留空自动检测本机 IP')}" autocomplete="off" spellcheck="false" ${running || state.busy ? 'disabled' : ''}><datalist id="lan-ip-options">${lanAddresses.map((address) => `<option value="${html(address)}"></option>`).join('')}</datalist></label><label>安装引导 HTTP 端口<input id="lan-http-port" data-lan-field="httpPort" type="number" min="1" max="65535" value="${html(state.lanSettings.httpPort)}" ${running || state.busy ? 'disabled' : ''}></label><label>游戏 HTTPS 端口<input id="lan-port" data-lan-field="port" type="number" min="1" max="65535" value="${html(state.lanSettings.port)}" ${running || state.busy ? 'disabled' : ''}></label></div><div class="lan-guidance"><span class="status-dot ${running ? 'live' : ''}"></span><div><p>所有客户端共用 BinGo Root CA，朋友信任一次即可。邀请地址会引导安装证书，HTTPS 验证通过后自动进入游戏。</p><p>允许 HTTP 与 HTTPS 端口通过本机防火墙，并保持本机和启动器开启。</p></div></div><div class="lan-operation" role="status" aria-live="polite">${state.busy ? '<span class="spinner"></span>' : ''}<p class="${state.error ? 'has-error' : ''}">${html(state.error || (state.busy ? state.message : running ? '游戏与共享正在运行；请先停止游戏，再修改 IP 或端口。' : '设置保存后将在下次启动游戏时生效。'))}</p></div><div class="lan-panel__actions"><button id="lan-save" class="primary" ${sharing.save ? '' : 'disabled'}>${state.busy ? '正在保存…' : '保存设置'}${icons.check}</button><button id="lan-done" class="secondary" ${state.busy ? 'disabled' : ''}>完成</button></div></div></section>` : ''}
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
  clientResizeObserver?.disconnect();
  const details = document.querySelector('.launch-details'), addresses = document.querySelector('.addresses');
  if (details) clientResizeObserver?.observe(details);
  if (addresses) clientResizeObserver?.observe(addresses);
  scheduleClientMeasurement();
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
    if (systemCaTrusted()) return;
    await operation(async () => {
      state.caInstallFailed = false; state.caInstallError = ''; state.phase = ''; state.message = '正在请求安装并信任 CA，请完成系统授权…'; render();
      let installError;
      try { state.message = await invoke('install_lan_ca'); }
      catch (error) {
        installError = error;
      }
      finally {
        await refreshCaSystemStatus(true);
      }
      if (installError && !systemCaTrusted()) {
        state.caInstallFailed = true;
        state.caInstallError = typeof installError === 'string' ? installError : installError.message || String(installError);
        throw installError;
      }
      if (installError) state.message = state.caSystemStatus.message || 'CA 已安装并受系统信任。';
    });
  } else if (target.id === 'ca-save') {
    if (systemCaTrusted()) return;
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
    if (state.busy) return;
    state.lanOpen = false; state.error = ''; render(); document.querySelector('#lan-setup')?.focus();
  } else if (target.id === 'lan-save') {
    if (!lanActions(state).save) return;
    await operation(async () => {
      const request = lanRequest(state.lanSettings);
      requireCurrentVersion();
      updateStatus(await invoke('save_lan_settings', request));
      resetLanSettings();
      state.message = '局域网共享设置已保存，下次启动游戏时生效。';
      state.lanOpen = false;
    });
  } else if (target.dataset.copyClient !== undefined) {
    if (state.busy) return;
    const client = findClient(target.dataset.copyClient);
    if (!client || client.primary) return;
    const value = client.invitation_url;
    if (value) {
      try { if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(value); state.error = ''; state.message = '邀请地址已复制，可以发给朋友。'; render(); }
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
    if (!state.clients.length) return;
    state.clientPage = (state.clientPage + 1) % Math.ceil(state.clients.length / state.clientCapacity);
    state.clientFocusId = state.clients[state.clientPage * state.clientCapacity]?.id ?? null;
    render();
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
    if (!primaryClient()) {
      if (!state.resources) await prepare();
      requireCurrentVersion();
      const caStatus = refreshCaSystemStatus(true);
      updateStatus(await invoke('start_game', { additional: false }));
      await caStatus;
    }
    requireCurrentVersion();
    const client = primaryClient();
    if (!client) throw new Error('本机客户端尚未启动，请重试。');
    await openClient(client); state.message = systemCaTrusted() ? '游戏已在浏览器打开，局域网共享已开启。' : '局域网共享已开启，浏览器验证证书后会自动进入游戏。';
  });
  else if (target.id === 'additional' && launcherActions(state).additional) await operation(async () => {
    requireCurrentVersion();
    const previousIds = new Set(state.clients.map((client) => client.id));
    updateStatus(await invoke('start_game', { additional: true }));
    const added = state.clients.find((client) => !previousIds.has(client.id));
    if (added) {
      const page = clientPage(state.clients, state.clientCapacity, state.clientPage, added.id);
      if (page !== state.clientPage) { state.clientPage = page; state.clientFocusId = added.id; }
    }
    state.message = '朋友客户端已准备就绪，复制它的邀请地址发给朋友。';
  });
  else if (target.id === 'stop') await operation(async () => { updateStatus(await invoke('stop_game')); state.message = '游戏与局域网共享已停止。'; });
  else if (target.dataset.stopClient !== undefined) {
    const client = findClient(target.dataset.stopClient);
    if (!client) return;
    await operation(async () => {
      updateStatus(await invoke('stop_game_client', { id: client.id }));
      state.message = `客户端 ${client.number} 的游戏与共享服务已停止。`;
    });
  } else if (target.dataset.open !== undefined) {
    const client = findClient(target.dataset.open);
    if (client) await operation(() => openClient(client));
  }
});
app.addEventListener('input', (event) => {
  const field = event.target?.dataset?.lanField;
  if (!field || !state.lanOpen || state.busy || state.urls.length) return;
  state.lanSettings[field] = event.target.value;
});
app.addEventListener('change', (event) => {
  const field = event.target?.dataset?.lanField;
  if (field && state.lanOpen && !state.busy && !state.urls.length) { state.lanSettings[field] = event.target.value; render(); }
});
document.addEventListener('click', (event) => {
  if (state.settingsOpen && !event.target.closest('.settings')) { state.settingsOpen = false; render(); }
});
document.addEventListener('contextmenu', (event) => event.preventDefault());
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
  void refreshCaSystemStatus();
  invoke('launcher_status').then(updateStatus).then(render).catch((error) => { state.error = String(error); render(); }).finally(() => refreshRemote(false));
  setInterval(() => refreshRemote(true), 5 * 60 * 1000);
} else { state.message = '界面预览：通过桌面启动器选择资源并开始游戏。'; render(); }
