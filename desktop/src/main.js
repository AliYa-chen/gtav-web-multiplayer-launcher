import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import metadata from '../package.json';
import { escapeHtml as html, displayDirectory, progressValue, readBackground, saveBackground, remotePresentation, launcherActions, paginateText, lanSettings, lanActions, lanRequest, clientCapacity, clientPage, launchPreferences, launchServerOptions, launchRequest, displayLaunchServer } from './view-state.js';
import { backgrounds } from './backgrounds.js';
import { createTranslator, normalizeLanguageConfig, translateMessage, message, supportedPreferences } from './i18n.js';
import { checkBrowserServers } from './server-health.js';
import './style.css';

const app = document.querySelector('#app');
const PROJECT_REPOSITORY_URL = 'https://github.com/AliYa-chen/gtav-web-multiplayer-launcher';
const backgroundIds = backgrounds.map((item) => item.id);
const storage = { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };
const state = {
  language: normalizeLanguageConfig(null, navigator.languages || [navigator.language]), languageBusy: false, languageInitialized: false, languageError: '',
  desktop: isTauri(), selected: '', resources: null, clients: [], urls: [], invitationUrls: [], version: metadata.version, busy: false, phase: '',
  message: message('message.welcome'), error: '', background: readBackground(storage, backgroundIds), settingsOpen: false,
  remote: null, remoteBusy: false, remoteError: '', platform: '',
  announcementIndex: 0, clientPage: 0, clientCapacity: 2, clientFocusId: null, reading: null, readingPage: 0,
  updateRequired: false, caInstallFailed: false, caInstallError: '', caSystemStatus: null,
  launch: launchPreferences(), launchDirty: false, serverAvailability: [], serverChecking: false, serverCatalog: '',
  lan: null, lanOpen: false, lanSettings: lanSettings(null),
};
const t = (key, params) => createTranslator(state.language.resolved)(key, params);
const localText = (value) => translateMessage(value, state.language.resolved);
function applyLanguage(value) {
  if (!value || typeof value !== 'object') return;
  const next = normalizeLanguageConfig(value, navigator.languages || [navigator.language]);
  if (state.languageInitialized && next.revision < state.language.revision) return;
  if (state.languageBusy && next.revision === state.language.revision && next.preference !== state.language.preference) return;
  state.language = next;
  state.languageInitialized = true;
}
let serverCheckPromise = null, serverCheckGeneration = 0;
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
    state.caSystemStatus = { installed: false, trusted: false, message: message('ca.unavailable'), error: String(error) };
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
  github: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M5 16h14l-2-3V9a5 5 0 0 0-10 0v4zm5 4h4"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
};
function updateStatus(value) {
  if (value.language) applyLanguage(value.language);
  if (value.launch_preferences && !state.launchDirty) state.launch = launchPreferences(value.launch_preferences);
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
    state.updateRequired = remotePresentation(snapshot, state.version, state.platform, state.language.resolved).update;
  }
  if (state.updateRequired) { state.settingsOpen = false; state.reading = null; state.lanOpen = false; }
  if (snapshot?.source !== 'remote' || snapshot?.stale === true) state.reading = null;
  const catalog = JSON.stringify(launchServerOptions(snapshot).map(item => [item.address, item.server, item.health_url]));
  if (catalog !== state.serverCatalog) {
    state.serverCatalog = catalog; state.serverAvailability = []; serverCheckGeneration++;
    if (state.desktop && !state.updateRequired) void refreshServerAvailability();
  }
}
async function refreshServerAvailability() {
  if (!state.desktop || state.updateRequired) return;
  if (serverCheckPromise) return serverCheckPromise;
  const options = launchServerOptions(state.remote);
  if (!options.length) { state.serverAvailability = []; return; }
  const generation = serverCheckGeneration;
  state.serverChecking = true; render();
  serverCheckPromise = checkBrowserServers(options).then(values => {
    if (generation !== serverCheckGeneration) return;
    state.serverAvailability = options.map(option => {
      const value = Array.isArray(values) ? values.find(item => item?.address === option.address) : null;
      const available = value?.available === true && Number.isFinite(value.latency_ms) && value.latency_ms >= 0;
      return { address: option.address, available, latency_ms: available ? Math.round(value.latency_ms) : null,
        error: typeof value?.error === 'string' ? value.error : '' };
    });
    if (!state.launch.server) {
      const first = state.serverAvailability.find(item => item.available);
      if (first) state.launch.server = first.address;
    }
  }).catch(() => {
    if (generation === serverCheckGeneration) state.serverAvailability = options.map(option => ({ address: option.address, available: false, latency_ms: null }));
  }).finally(() => {
    serverCheckPromise = null; state.serverChecking = false; render();
    if (generation !== serverCheckGeneration) void refreshServerAvailability();
  });
  return serverCheckPromise;
}
function selectedServerAvailability() {
  const options = launchServerOptions(state.remote);
  const selected = options.find(item => item.address === state.launch.server || item.server === state.launch.server);
  return selected && state.serverAvailability.find(item => item.address === selected.address);
}
function canUseSelectedServer() { return !state.serverChecking && selectedServerAvailability()?.available === true; }

function render() {
  document.documentElement.lang = state.language.resolved;
  document.title = t('app.title');
  const running = state.urls.length > 0, ready = Boolean(state.resources);
  const languageFocused = document.activeElement?.id === 'launcher-language';
  const focusedBackground = document.activeElement?.dataset?.background;
  const focusedUpdateAction = document.activeElement?.id;
  const focusedLaunchField = document.activeElement?.dataset?.launchField ? document.activeElement : null;
  const focusedLanField = state.lanOpen && document.activeElement?.dataset?.lanField ? document.activeElement : null;
  const lanAddress = state.lan?.host_address || state.lan?.addresses?.[0] || '';
  const lanAddresses = [...new Set([...(state.lan?.addresses || []), ...(lanAddress ? [lanAddress] : [])])];
  const sharing = lanActions(state), caEnabled = state.desktop && !state.busy && !state.updateRequired;
  const caSystemTrusted = systemCaTrusted();
  const actions = launcherActions(state, state.remoteBusy), remote = remotePresentation(state.remote, state.version, state.platform, state.language.resolved);
  const canVerify = actions.launch;
  const launchServers = launchServerOptions(state.remote, state.language.resolved);
  const selectedServer = state.launch.server ? displayLaunchServer(state.launch.server, launchServers) : '';
  const existingOpen = primaryClient() && !state.launchDirty;
  if (state.launch.mode === 'online') {
    actions.launch = actions.launch && (existingOpen || canUseSelectedServer());
    actions.additional = actions.additional && canUseSelectedServer();
  }
  const background = backgrounds.find((item) => item.id === state.background) || backgrounds[0];
  state.announcementIndex = Math.min(state.announcementIndex, Math.max(0, remote.announcements.length - 1));
  state.clientPage = clientPage(state.clients, state.clientCapacity, state.clientPage);
  const clientPages = Math.ceil(state.clients.length / state.clientCapacity);
  const announcement = remote.announcements[state.announcementIndex];
  const visibleClients = state.clients.slice(state.clientPage * state.clientCapacity, (state.clientPage + 1) * state.clientCapacity);
  const reading = state.reading?.kind === 'announcement'
    ? (() => { const item = remote.announcements[state.reading.index]; return item ? { title: item.title, text: `${item.date ? `${item.date}\n\n` : ''}${item.body}` } : null; })()
    : state.reading?.kind === 'release' ? { titleKey: 'reader.release', text: remote.releaseNotes } : state.reading;
  const pages = reading ? paginateText(localText(reading.text)) : [];
  state.readingPage = Math.min(state.readingPage, Math.max(0, pages.length - 1));
  document.documentElement.style.setProperty('--scene', `url("${background.image}")`);
  app.innerHTML = `<div class="scene" aria-hidden="true"></div><div class="shell" ${state.updateRequired || state.lanOpen ? 'inert aria-hidden="true"' : ''}>
    <main><header><div class="brand"><span class="brand__mark">V<span>ONLINE</span></span><div>GTA5DATA<span>${t('app.brand')}</span></div></div><div class="header-actions"><span class="pill"><span class="status-dot ${running ? 'live' : ''}"></span>${running ? t('app.clientsRunning', { count: state.urls.length }) : t('app.ready')}</span>
      <button id="project-repository" type="button" class="repository-button" aria-label="${t('app.repository')}" title="${t('app.repository')}">${icons.github}</button>
      <div class="settings"><button id="settings-toggle" class="settings-toggle ${state.settingsOpen ? 'is-open' : ''}" aria-expanded="${state.settingsOpen}" aria-controls="background-picker">${icons.settings} ${t('settings.title')} ${icons.chevron}</button>
        ${state.settingsOpen ? `<button class="picker-backdrop" id="picker-dismiss" aria-label="${t('settings.close')}"></button><section id="background-picker" class="background-picker" role="dialog" aria-modal="true" aria-labelledby="picker-title"><div class="picker-heading"><div><p class="eyebrow">${t('settings.eyebrow')}</p><h2 id="picker-title">${t('settings.scenery')}</h2><span>${t('settings.scenes')}</span></div><button id="picker-close" class="icon-button" aria-label="${t('settings.close')}">${icons.close}</button></div><div class="language-setting"><label for="launcher-language">${t('language.label')}</label><select id="launcher-language" ${state.languageBusy || (state.desktop && !state.languageInitialized) ? 'disabled' : ''}><option value="system" ${state.language.preference === 'system' ? 'selected' : ''}>${t('language.system')}</option><option value="zh-CN" ${state.language.preference === 'zh-CN' ? 'selected' : ''}>${t('language.zhCN')}</option><option value="en" ${state.language.preference === 'en' ? 'selected' : ''}>${t('language.en')}</option></select><small role="status">${state.languageError ? html(localText(state.languageError)) : state.languageBusy ? t('language.saving') : t('language.help')}</small></div><div class="background-grid">${backgrounds.map((item) => `<button class="background-option ${item.id === state.background ? 'selected' : ''}" data-background="${item.id}" aria-pressed="${item.id === state.background}" aria-label="${html(t('settings.chooseBackground', { name: t(item.labelKey) }))}"><img src="${item.image}" alt="${html(t(item.labelKey))}" loading="lazy"><span>${html(t(item.labelKey))}${item.id === state.background ? icons.check : ''}</span></button>`).join('')}</div></section>` : ''}
      </div></div></header>
      <section class="hero"><div class="hero__copy"><h1>${t('hero.next')}<em>${t('hero.city')}</em></h1><p class="hero__description">${t('hero.description')}</p></div><span class="scene-label">${html(t(background.labelKey))}</span></section>
      <div class="dashboard"><div class="game-column"><section class="glass setup-card"><div class="section-heading"><span class="step-number">01</span><div><h2>${t('resources.title')}</h2><p>${t('resources.description')}</p></div><span class="resource-badge ${ready ? 'verified' : ''}">${ready ? `${icons.check} ${t('resources.verified')}` : t('resources.firstSetup')}</span></div>
        <button class="directory" id="choose" ${actions.choose ? '' : 'disabled'}><span class="folder-icon">${icons.folder}</span><span class="directory__text"><small>${state.selected ? t('resources.selectedDirectory') : t('resources.directory')}</small><span title="${html(state.selected)}">${html(displayDirectory(state.selected, state.language.resolved))}</span></span><span class="browse">${state.selected ? t('resources.change') : t('resources.choose')} ↗</span></button>
        <div class="resource-footer">${ready ? `<div class="resource-detail"><span>${icons.check} ${t('resources.count', { count: Number(state.resources.manifest_file_count || 0).toLocaleString(state.language.resolved) })}</span><span>${t('resources.readOnly')}</span></div>` : `<p class="directory-note">${t('resources.note')}</p>`}
        <div class="resource-help">${state.desktop ? `<button id="get-game-resources" type="button" class="text-button">${t('resources.getGame')} ↗</button>` : `<a class="text-button" href="https://archive.org/download/gta5-wasm/" target="_blank" rel="noopener noreferrer">${t('resources.getGame')} ↗</a>`}</div></div>
      </section>
      <section class="glass launch-card"><div class="launch-main"><div class="launch-heading"><div class="section-heading"><span class="step-number">02</span><div><h2>${running ? t('launch.ready') : t('launch.title')}</h2></div></div>${running ? `<button id="stop" class="text-button launch-stop" title="${t('launch.stopAllHint')}" ${actions.stop ? '' : 'disabled'}>${t('launch.stopAll')}</button>` : ''}</div>
        <div class="progress-status ${state.error ? 'has-error' : ''}" role="status" aria-live="polite"><span class="${state.busy ? 'spinner' : 'status-dot'}"></span><span class="status-copy" title="${html(localText(state.error || state.message))}">${html(localText(state.error || state.message))}</span>${state.error ? `<button class="text-button" data-read="error">${t('launch.details')}</button>` : ''}</div>
        ${state.busy ? `<div class="progress-track"><span style="width:${progressValue(state.phase)}%"></span></div>` : ''}</div>
        <div class="launch-configuration"><div class="launch-mode" role="group" aria-label="${t('launch.mode')}">${['online', 'story', 'sandbox'].map(mode => `<button type="button" data-launch-mode="${mode}" aria-pressed="${state.launch.mode === mode}" ${state.busy ? 'disabled' : ''}>${t('launch.' + mode)}</button>`).join('')}</div><div class="launch-fields">${state.launch.mode === 'online' ? `<label>${t('launch.nickname')}<input id="launch-name" data-launch-field="name" value="${html(state.launch.name)}" maxlength="24" ${state.busy ? 'disabled' : ''}></label><label>${t('launch.preset')}<select id="launch-preset" data-launch-field="preset" ${state.busy ? 'disabled' : ''}>${['npc_male', 'npc_female', 'freemode_male', 'freemode_female'].map(preset => `<option value="${preset}" ${state.launch.preset === preset ? 'selected' : ''}>${t('launch.' + preset)}</option>`).join('')}</select></label><label class="launch-fields__server">${t('launch.server')}<div class="launch-server-control"><select id="launch-server" data-launch-field="server" ${state.busy || state.serverChecking ? 'disabled' : ''}><option value="" ${!selectedServer ? 'selected' : ''} disabled>${t(state.serverChecking ? 'launch.checkingRoutes' : 'launch.chooseRoute')}</option>${launchServers.map(item => {
          const status = state.serverAvailability.find(value => value.address === item.address);
          const available = !state.serverChecking && status?.available === true;
          return `<option value="${html(item.address)}" ${selectedServer === item.address ? 'selected' : ''} ${available ? '' : 'disabled'}>${html(item.label)} · ${state.serverChecking || !status ? t('launch.checking') : available ? t('launch.latency', { ms: status.latency_ms }) : t('launch.unavailable')}</option>`;
        }).join('')}${selectedServer && !launchServers.some(item => item.address === selectedServer) ? `<option value="${html(selectedServer)}" selected disabled>${html(selectedServer)} · ${t('launch.unavailable')}</option>` : ''}</select><button id="check-servers" type="button" class="text-button" ${state.serverChecking || state.busy || !state.desktop || !launchServers.length ? 'disabled' : ''}>${state.serverChecking ? t('launch.checking') : t('launch.checkRoutes')}</button></div><small class="launch-server-status" role="status">${state.serverChecking ? t('launch.checkingRoutes') : selectedServerAvailability()?.available ? t('launch.availableLatency', { ms: selectedServerAvailability().latency_ms }) : t('launch.chooseAvailableRoute')}</small></label>` : state.launch.mode === 'sandbox' ? `<label class="launch-fields__server">${t('launch.map')}<select id="launch-map" data-launch-field="map" ${state.busy ? 'disabled' : ''}>${['gtav', 'env_test'].map(map => `<option value="${map}" ${state.launch.map === map ? 'selected' : ''}>${t(map === 'gtav' ? 'launch.map5' : 'launch.map6')}</option>`).join('')}</select></label>` : ''}</div><small>${t(state.launch.mode === 'online' ? 'launch.onlineHint' : 'launch.offlineHint')}</small></div><div class="launch-actions"><button id="launch" class="primary" ${actions.launch ? '' : 'disabled'}>${primaryClient() ? t('launch.open') : state.busy ? t('launch.preparing') : t('launch.start')}${icons.arrow}</button>
          ${running ? `<button id="additional" class="secondary" ${actions.additional ? '' : 'disabled'}>${t('launch.additional')}</button>` : `<button id="verify" class="text-button" ${canVerify ? '' : 'disabled'}>${t('launch.verify')}</button>`}
          ${state.desktop ? `<button id="lan-setup" class="secondary" ${sharing.configure ? '' : 'disabled'}>${t('launch.sharing')}</button>` : ''}</div>
        <div class="launch-details">${caSystemTrusted ? '' : `<div class="ca-trust-actions"><div><span>${t('ca.title')}</span><small title="${html(localText(state.caSystemStatus?.message || state.caSystemStatus?.error || ''))}">${html(state.caSystemStatus?.installed === true ? t('ca.installedUntrusted') : localText(state.caSystemStatus?.message) || t('ca.once'))}</small></div><div class="ca-trust-actions__buttons"><button id="ca-install" class="secondary" ${caEnabled ? '' : 'disabled'}>${t('ca.install')}</button><button id="ca-save" class="text-button" ${caEnabled ? '' : 'disabled'}>${t('ca.download')}</button></div>${state.caInstallFailed ? `<p class="ca-trust-fallback" role="status">${t('ca.fallback')}</p>` : ''}</div>`}
        ${running ? `<div class="client-list"><div class="client-list__heading"><span>${t('clients.title')}</span>${clientPages > 1 ? `<button id="clients-next" class="text-button client-page" aria-label="${t('clients.next')}">${state.clientPage + 1} / ${clientPages} ${icons.arrow}</button>` : state.clients.some((client) => !client.primary) ? `<small>${t('clients.sendToFriends')}</small>` : ''}</div><div class="addresses">${visibleClients.map((client) => {
          const invitation = client.invitation_url, address = client.primary ? client.running_url : invitation, number = html(client.number), id = html(client.id);
          return `<div class="client-address" data-client-id="${id}"><div class="client-address__heading"><span><span class="status-dot live"></span>${t('clients.name', { number })} · ${client.primary ? t('clients.local') : t('clients.friend')}</span></div><button data-stop-client="${id}" class="text-button client-close" aria-label="${t('clients.stopLabel', { number })}" title="${t('clients.stopHint')}" ${state.busy ? 'disabled' : ''}>${t('clients.stop')}</button>${client.primary ? '' : `<div class="client-address__actions"><button data-open="${id}" class="text-button" ${state.busy || state.updateRequired ? 'disabled' : ''}>${t('clients.openLocal')} ↗</button><button data-copy-client="${id}" class="secondary client-copy" ${state.busy || !invitation ? 'disabled' : ''}>${t('clients.copyInvite')}</button></div>`}<code title="${html(address)}">${html(address)}</code></div>`;
        }).join('')}</div></div>` : ''}</div></section></div>
      <aside class="community-column"><section class="glass announcement-card"><div class="card-heading"><h2>${icons.bell} ${t('remote.announcements')}</h2><span class="config-source">${html(remote.sourceText)}</span></div>
        ${announcement ? `<div class="announcements"><article><div class="announcement-heading"><h3 title="${html(announcement.title)}">${html(announcement.title)}</h3>${announcement.date ? `<time>${html(announcement.date)}</time>` : ''}</div><p>${html(announcement.body)}</p></article><div class="announcement-actions"><button class="text-button" data-read="announcement">${t('remote.details')} ↗</button>${remote.announcements.length > 1 ? `<div class="pager"><button id="announcement-prev" aria-label="${t('remote.previous')}" ${state.announcementIndex ? '' : 'disabled'}>‹</button><span>${state.announcementIndex + 1} / ${remote.announcements.length}</span><button id="announcement-next" aria-label="${t('remote.next')}" ${state.announcementIndex < remote.announcements.length - 1 ? '' : 'disabled'}>›</button></div>` : ''}</div></div>` : '<p class="empty-note">-</p>'}
        <div class="server-info"><span>${t('remote.status')}</span><strong>${html(remote.title)}</strong>${remote.websiteAvailable && state.desktop ? `<button id="website" class="text-button">${t('remote.openStatus')} ↗</button>` : ''}</div>
      </section><section class="glass update-card"><div class="card-heading"><h2>${t('update.title')}</h2><span class="version-chip">v${html(state.version)}</span></div><p class="update-state ${remote.update ? 'update-available' : ''}">${html(remote.versionText)}</p>
        ${remote.releaseNotes ? `<p class="release-notes">${html(remote.releaseNotes)}</p><button class="text-button notes-link" data-read="release">${t('update.details')} ↗</button>` : ''}
        <div class="update-actions">${remote.downloadAvailable ? `<button id="update-download" class="secondary download-button" ${state.remoteBusy || !state.desktop ? 'disabled' : ''}>${icons.download} ${t('update.download')}</button>` : ''}<button id="check-updates" class="text-button" ${actions.refresh ? '' : 'disabled'}>${state.remoteBusy ? '<span class="spinner"></span>' : icons.refresh}${state.remoteBusy ? t('update.checking') : t('update.check')}</button></div>
        ${state.remoteError ? `<p class="remote-note" role="status">${html(localText(state.remoteError))}</p>` : ''}
      </section></aside></div>
      <footer><span>${t('footer.launcher', { version: html(state.version) })}</span><span>${t('footer.keepOpen')}</span></footer>
    </main></div>${reading ? `<div class="reader-overlay"><button id="reader-dismiss" class="reader-backdrop" aria-label="${t('reader.close')}"></button><section class="glass reader" role="dialog" aria-modal="true" aria-labelledby="reader-title"><div class="reader-heading"><h2 id="reader-title">${html(reading.titleKey ? t(reading.titleKey) : reading.title)}</h2><button id="reader-close" class="icon-button" aria-label="${t('reader.close')}">${icons.close}</button></div><div class="reader-text">${html(pages[state.readingPage] || '')}</div><div class="reader-footer"><span>${t('reader.page', { page: state.readingPage + 1, count: Math.max(1, pages.length) })}</span><div class="pager"><button id="reader-prev" ${state.readingPage ? '' : 'disabled'} aria-label="${t('reader.previous')}">‹</button><button id="reader-next" ${state.readingPage < pages.length - 1 ? '' : 'disabled'} aria-label="${t('reader.next')}">›</button></div></div></section></div>` : ''}
    ${state.lanOpen && !state.updateRequired ? `<section class="lan-overlay" role="dialog" aria-modal="true" aria-labelledby="lan-title" tabindex="-1"><div class="glass lan-panel"><div class="reader-heading"><div><p class="eyebrow">${t('lan.eyebrow')}</p><h2 id="lan-title">${t('lan.title')}</h2></div><button id="lan-close" class="icon-button" aria-label="${t('lan.close')}" ${state.busy ? 'disabled' : ''}>${icons.close}</button></div><p class="lan-description">${t('lan.description')}</p><div class="lan-fields"><label class="lan-fields__address">${t('lan.address')}<input id="lan-address" data-lan-field="address" type="text" list="lan-ip-options" value="${html(state.lanSettings.address)}" placeholder="${html(lanAddress ? t('lan.detected', { address: lanAddress }) : t('lan.autoDetect'))}" autocomplete="off" spellcheck="false" ${running || state.busy ? 'disabled' : ''}><datalist id="lan-ip-options">${lanAddresses.map((address) => `<option value="${html(address)}"></option>`).join('')}</datalist></label><label>${t('lan.httpPort')}<input id="lan-http-port" data-lan-field="httpPort" type="number" min="1" max="65535" value="${html(state.lanSettings.httpPort)}" ${running || state.busy ? 'disabled' : ''}></label><label>${t('lan.httpsPort')}<input id="lan-port" data-lan-field="port" type="number" min="1" max="65535" value="${html(state.lanSettings.port)}" ${running || state.busy ? 'disabled' : ''}></label></div><div class="lan-guidance"><span class="status-dot ${running ? 'live' : ''}"></span><div><p>${t('lan.caGuide')}</p><p>${t('lan.firewall')}</p></div></div><div class="lan-operation" role="status" aria-live="polite">${state.busy ? '<span class="spinner"></span>' : ''}<p class="${state.error ? 'has-error' : ''}">${html(localText(state.error || (state.busy ? state.message : running ? t('lan.running') : t('lan.nextLaunch'))))}</p></div><div class="lan-panel__actions"><button id="lan-save" class="primary" ${sharing.save ? '' : 'disabled'}>${state.busy ? t('lan.saving') : t('lan.save')}${icons.check}</button><button id="lan-done" class="secondary" ${state.busy ? 'disabled' : ''}>${t('lan.done')}</button></div></div></section>` : ''}
    ${state.updateRequired ? `<section class="mandatory-update" role="alertdialog" aria-modal="true" aria-labelledby="mandatory-update-title" aria-describedby="mandatory-update-description" tabindex="-1"><div class="glass mandatory-update__panel"><div class="mandatory-update__icon" aria-hidden="true">${icons.download}</div><p class="eyebrow">${t('update.launcher')}</p><h2 id="mandatory-update-title">${t('update.requiredTitle')}</h2><p id="mandatory-update-description">${t('update.requiredDescription')}</p><div class="mandatory-update__versions"><span>${t('update.current')} <strong>${html(state.version)}</strong></span><span>${t('update.latest')} <strong>${html(remote.latest || '-')}</strong></span></div><div class="mandatory-update__notes">${remote.releaseNotes ? `<p>${html(remote.releaseNotes)}</p>` : '<p>-</p>'}</div><div class="mandatory-update__actions">${remote.downloadAvailable ? `<button id="mandatory-update-download" class="primary" ${state.remoteBusy || !state.desktop ? 'disabled' : ''}>${icons.download} ${t('update.download')}</button>` : `<p class="mandatory-update__missing">${t('update.missing')}</p>`}<button id="mandatory-update-check" class="secondary" ${actions.refresh ? '' : 'disabled'}>${state.remoteBusy ? '<span class="spinner"></span>' : icons.refresh}${state.remoteBusy ? t('update.checking') : t('update.recheck')}</button></div>${state.remoteError ? `<p class="remote-note" role="status">${html(localText(state.remoteError))}</p>` : ''}<p class="mandatory-update__footnote">${t('update.footnote')}</p></div></section>` : ''}`;
  if (state.updateRequired) {
    const action = ['mandatory-update-download', 'mandatory-update-check'].includes(focusedUpdateAction)
      ? document.querySelector(`#${focusedUpdateAction}:not(:disabled)`) : null;
    (action || document.querySelector('.mandatory-update button:not(:disabled)') || document.querySelector('.mandatory-update'))?.focus({ preventScroll: true });
  }
  if (languageFocused && state.settingsOpen) document.querySelector('#launcher-language')?.focus({ preventScroll: true });
  if (focusedBackground && state.settingsOpen) document.querySelector(`[data-background="${focusedBackground}"]`)?.focus({ preventScroll: true });
  if (focusedLaunchField) {
    const replacement = document.querySelector(`#${focusedLaunchField.id}`); replacement?.focus({ preventScroll: true });
    if (typeof focusedLaunchField.selectionStart === 'number') replacement?.setSelectionRange?.(focusedLaunchField.selectionStart, focusedLaunchField.selectionEnd);
  }
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
  if (state.updateRequired) throw new Error(t('message.requireUpdate'));
}
async function refreshRemote(forceRefresh = true) {
  if (!state.desktop || state.remoteBusy) return;
  state.remoteBusy = true; state.remoteError = ''; render();
  try {
    applyRemote(await invoke('remote_configuration', { forceRefresh }));
    await refreshServerAvailability();
  } catch { applyRemote({ config: {}, source: 'unavailable', stale: true, error: '远程配置暂时无法加载，请稍后重试。' }); }
  finally { state.remoteBusy = false; render(); }
}
async function prepare() {
  requireCurrentVersion();
  state.phase = 'checking'; state.message = message('message.detecting'); render();
  updateStatus(await invoke('prepare_game', { selected: state.selected }));
  state.phase = 'ready'; state.message = message('message.resourcesReady');
}
app.addEventListener('click', async (event) => {
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  if (state.updateRequired && !['mandatory-update-download', 'mandatory-update-check'].includes(target.id)) return;
  if (target.dataset.launchMode) { if (state.busy) return; state.launch.mode = target.dataset.launchMode; state.launchDirty = true; render(); return; }
  if (target.id === 'project-repository') {
    try {
      if (state.desktop) await invoke('open_project_repository');
      else window.open(PROJECT_REPOSITORY_URL, '_blank', 'noopener,noreferrer');
    } catch {
      state.error = message('message.repositoryFailed'); render();
      document.querySelector('#project-repository')?.focus({ preventScroll: true });
    }
  } else if (target.id === 'get-game-resources') {
    if (!state.desktop) return;
    try { await invoke('open_game_resource_page'); }
    catch { state.error = message('message.resourcePageFailed'); render(); }
  } else if (target.id === 'settings-toggle') {
    state.settingsOpen = !state.settingsOpen; state.reading = null; render();
    if (state.settingsOpen) document.querySelector('.background-option.selected')?.focus();
  } else if (target.id === 'picker-close' || target.id === 'picker-dismiss') {
    state.settingsOpen = false; render(); document.querySelector('#settings-toggle')?.focus();
  } else if (target.id === 'ca-install') {
    if (systemCaTrusted()) return;
    await operation(async () => {
      state.caInstallFailed = false; state.caInstallError = ''; state.phase = ''; state.message = message('message.installCa'); render();
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
      if (installError) state.message = state.caSystemStatus.message || message('message.caTrusted');
    });
  } else if (target.id === 'ca-save') {
    if (systemCaTrusted()) return;
    await operation(async () => {
      state.phase = ''; state.message = message('message.caSaveChoose'); render();
      const saved = await invoke('save_lan_ca_certificate');
      state.message = saved ? message('message.caSaved', { path: saved }) : message('message.caSaveCancelled');
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
      const request = lanRequest(state.lanSettings, state.language.resolved);
      requireCurrentVersion();
      updateStatus(await invoke('save_lan_settings', request));
      resetLanSettings();
      state.message = message('message.lanSaved');
      state.lanOpen = false;
    });
  } else if (target.dataset.copyClient !== undefined) {
    if (state.busy) return;
    const client = findClient(target.dataset.copyClient);
    if (!client || client.primary) return;
    const value = client.invitation_url;
    if (value) {
      try { if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(value); state.error = ''; state.message = message('message.inviteCopied'); render(); }
      catch { state.error = message('message.clipboardFailed'); render(); }
    }
  } else if (target.dataset.read) {
    const remote = remotePresentation(state.remote, state.version, state.platform, state.language.resolved);
    const item = remote.announcements[state.announcementIndex];
    if (target.dataset.read === 'announcement' && item) state.reading = { kind: 'announcement', index: state.announcementIndex };
    else if (target.dataset.read === 'release') state.reading = { kind: 'release' };
    else if (target.dataset.read === 'error') state.reading = { titleKey: 'reader.error', text: state.error };
    state.readingPage = 0; state.settingsOpen = false; render(); document.querySelector('#reader-close')?.focus();
  } else if (target.id === 'reader-close' || target.id === 'reader-dismiss') {
    state.reading = null; render();
  } else if (target.id === 'reader-prev' || target.id === 'reader-next') {
    state.readingPage += target.id === 'reader-next' ? 1 : -1; render(); document.querySelector(`#${target.id}`)?.focus();
  } else if (target.id === 'announcement-prev' || target.id === 'announcement-next') {
    const count = remotePresentation(state.remote, state.version, state.platform, state.language.resolved).announcements.length;
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
    catch { state.remoteError = download ? t('message.downloadUnavailable') : t('message.statusPageFailed'); }
    finally { state.remoteBusy = false; render(); }
  } else if (target.id === 'choose') await operation(async () => {
    const value = await invoke('choose_game_directory');
    if (value) { state.selected = value; state.resources = null; state.phase = ''; state.message = message('message.directoryChosen'); }
  });
  else if (target.id === 'check-servers') await refreshServerAvailability();
  else if (target.id === 'verify') await operation(prepare);
  else if (target.id === 'launch') await operation(async () => {
    if (primaryClient() && !state.launchDirty) { await openClient(primaryClient()); state.message = message('message.gameOpened'); return; }
    if (state.launch.mode === 'online') { launchRequest(state.launch, state.remote); await refreshServerAvailability(); }
    const launch = launchRequest(state.launch, state.remote, state.serverAvailability);
    if (!state.resources) await prepare();
    if (!primaryClient()) {
      requireCurrentVersion();
      const caStatus = refreshCaSystemStatus(true);
      const status = await invoke('start_game', { additional: false, launch });
      state.launchDirty = false; updateStatus(status);
      await caStatus;
    } else {
      const status = await invoke('start_game', { additional: false, launch });
      state.launchDirty = false; updateStatus(status);
    }
    requireCurrentVersion();
    const client = primaryClient();
    if (!client) throw new Error(t('message.localNotStarted'));
    await openClient(client); state.message = systemCaTrusted() ? message('message.gameOpened') : message('message.lanStarted');
  });
  else if (target.id === 'additional' && launcherActions(state).additional) await operation(async () => {
    requireCurrentVersion();
    const previousIds = new Set(state.clients.map((client) => client.id));
    if (state.launch.mode === 'online') await refreshServerAvailability();
    updateStatus(await invoke('start_game', { additional: true, launch: launchRequest(state.launch, state.remote, state.serverAvailability) }));
    const added = state.clients.find((client) => !previousIds.has(client.id));
    if (added) {
      const page = clientPage(state.clients, state.clientCapacity, state.clientPage, added.id);
      if (page !== state.clientPage) { state.clientPage = page; state.clientFocusId = added.id; }
    }
    state.message = message('message.friendReady');
  });
  else if (target.id === 'stop') await operation(async () => { updateStatus(await invoke('stop_game')); state.message = message('message.stopped'); });
  else if (target.dataset.stopClient !== undefined) {
    const client = findClient(target.dataset.stopClient);
    if (!client) return;
    await operation(async () => {
      updateStatus(await invoke('stop_game_client', { id: client.id }));
      state.message = message('message.clientStopped', { number: client.number });
    });
  } else if (target.dataset.open !== undefined) {
    const client = findClient(target.dataset.open);
    if (client) await operation(() => openClient(client));
  }
});
app.addEventListener('input', (event) => {
  const launchField = event.target?.dataset?.launchField;
  if (launchField && launchField !== 'server' && !state.busy) { state.launch[launchField] = event.target.value; state.launchDirty = true; return; }
  const field = event.target?.dataset?.lanField;
  if (!field || !state.lanOpen || state.busy || state.urls.length) return;
  state.lanSettings[field] = event.target.value;
});
app.addEventListener('change', async (event) => {
  const launchField = event.target?.dataset?.launchField;
  if (launchField && !state.busy) {
    if (launchField === 'server' && (state.serverChecking || !state.serverAvailability.some(item => item.address === event.target.value && item.available))) return;
    state.launch[launchField] = event.target.value; state.launchDirty = true; render(); return;
  }
  if (event.target?.id === 'launcher-language') {
    const preference = event.target.value;
    if (state.languageBusy || !supportedPreferences.includes(preference) || state.updateRequired) return;
    if (!state.desktop) { applyLanguage({ preference, revision: state.language.revision + 1 }); render(); return; }
    if (!state.languageInitialized) return;
    const previous = state.language;
    state.languageBusy = true; state.languageError = '';
    // Apply the choice immediately; only the native backend persists it and broadcasts to pages.
    state.language = normalizeLanguageConfig({ preference, revision: previous.revision }, navigator.languages || [navigator.language]);
    render();
    try {
      const result = await invoke('set_language', { language: preference });
      applyLanguage(result.language || result);
    } catch {
      if (state.language.revision <= previous.revision) state.language = previous;
      state.languageError = message('language.failed');
    } finally { state.languageBusy = false; render(); }
    return;
  }
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
    const buttons = [...dialog.querySelectorAll('button:not(:disabled), select:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
render();
if (state.desktop) {
  listen('language-change', ({ payload }) => { applyLanguage(payload); render(); });
  listen('launcher-progress', ({ payload }) => { state.phase = payload.phase; state.message = payload.text; render(); });
  listen('launcher-remote-config', ({ payload }) => { applyRemote(payload); render(); if (payload?.source === 'remote' && !payload.stale) void refreshServerAvailability(); });
  void refreshCaSystemStatus();
  invoke('launcher_status').then(updateStatus).then(render).catch((error) => { state.languageInitialized = true; state.error = String(error); render(); }).finally(() => refreshRemote(false));
  setInterval(() => refreshRemote(true), 5 * 60 * 1000);
  setInterval(() => { if (document.visibilityState !== 'hidden') void refreshServerAvailability(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshServerAvailability(); });
} else { state.message = message('message.preview'); render(); }
