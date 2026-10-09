mod engine;
mod fonts;
mod http_server;
mod resources;
mod remote_config;
mod lan;
mod lan_ca_embedded;
mod lan_bootstrap;
mod ca_trust;
mod language;

use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::{Arc, Mutex, RwLock, atomic::{AtomicBool, Ordering}}};
use tauri::{Emitter, Manager, State};

static CLIENT: Dir<'_> = include_dir!("$OUT_DIR/embedded-client");

#[derive(Default, Deserialize, Serialize)]
struct Preferences { selected_directory: Option<String>, #[serde(default)] lan_settings: Option<lan::Settings>, #[serde(default)] language: Option<String> }
struct Prepared { resources: resources::ResourceInfo, runtime: PathBuf, fonts: HashMap<String, PathBuf> }
struct GameClient { id: u64, number: u64, primary: bool, guide: lan_bootstrap::BootstrapHandle, server: http_server::ServerHandle }
struct ClientIdentity { id: u64, primary: bool }
#[derive(Default)]
struct Inner { selected: Option<String>, prepared: Option<Prepared>, clients: Vec<GameClient>,
    lan_settings: lan::Settings, last_client_id: u64,
    lan_address: Option<String>, lan_fingerprint: Option<String> }
struct LauncherState { inner: Mutex<Inner>, busy: Arc<AtomicBool>, remote_busy: Arc<AtomicBool>,
    update_required: Arc<AtomicBool>, shutting_down: AtomicBool, remote: Arc<RwLock<serde_json::Value>>, language: language::SharedLanguage }
impl Default for LauncherState {
    fn default() -> Self {
        Self { inner: Mutex::new(Inner::default()), busy: Arc::new(AtomicBool::new(false)), language: language::shared(),
            remote_busy: Arc::new(AtomicBool::new(false)), update_required: Arc::new(AtomicBool::new(false)), shutting_down: AtomicBool::new(false), remote: Arc::new(RwLock::new(
                serde_json::to_value(remote_config::ConfigSnapshot::default()).unwrap_or_default())) }
    }
}
struct BusyGuard(Arc<AtomicBool>);
impl Drop for BusyGuard { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }
fn acquire(state: &LauncherState) -> Result<BusyGuard, String> {
    state.busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "正在处理上一项操作，请稍候。".to_string())?;
    Ok(BusyGuard(state.busy.clone()))
}

#[derive(Serialize)]
struct LauncherStatus { selected_directory: Option<String>, resources: Option<resources::ResourceInfo>, clients: Vec<ClientStatus>, running_urls: Vec<String>, invitation_urls: Vec<String>,
    version: &'static str, platform: &'static str, update_required: bool, remote_configuration: serde_json::Value, lan: LanStatus, language: language::LanguageConfig }
#[derive(Serialize)]
struct ClientStatus { id: u64, number: u64, primary: bool, running_url: String, invitation_url: String }
#[derive(Serialize)]
struct LanStatus { settings: lan::Settings, addresses: Vec<String>, running_url: Option<String>, guide_url: Option<String>,
    host_address: Option<String>, ca_fingerprint: Option<String> }
fn platform_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos_arm64", ("macos", "x86_64") => "macos_x64",
        ("windows", "x86_64") => "windows_x64", ("windows", "aarch64") => "windows_arm64", _ => "unsupported",
    }
}
fn reconcile_update_requirement(required: &AtomicBool, value: &serde_json::Value) -> bool {
    let previous = required.load(Ordering::Acquire);
    let next = serde_json::from_value::<remote_config::ConfigSnapshot>(value.clone()).ok()
        .map(|snapshot| remote_config::update_requirement(previous, &snapshot, env!("CARGO_PKG_VERSION")))
        .unwrap_or(previous);
    required.store(next, Ordering::Release);
    next
}

fn publish_remote_snapshot(remote: &RwLock<serde_json::Value>, required: &AtomicBool,
    snapshot: remote_config::ConfigSnapshot) -> Result<serde_json::Value, String> {
    let value = serde_json::to_value(snapshot).map_err(|e| e.to_string())?;
    let mut stored = remote.write().map_err(|e| e.to_string())?;
    // Set the native gate before either the event or shared HTTP metadata can
    // expose a newer release to the UI.
    reconcile_update_requirement(required, &value);
    *stored = value.clone();
    Ok(value)
}

fn ensure_current_launcher(state: &LauncherState) -> Result<(), String> {
    if state.shutting_down.load(Ordering::Acquire) { return Err("启动器正在关闭。".into()); }
    // The local HTTP proxy can refresh this same snapshot. Reconcile it while
    // holding its read lock so command entry points also observe those updates.
    let value = state.remote.read().map_err(|e| e.to_string())?;
    if reconcile_update_requirement(&state.update_required, &value) {
        return Err("请先更新启动器至最新版本。".into());
    }
    Ok(())
}

fn primary_client(inner: &Inner) -> Option<&GameClient> {
    inner.clients.iter().find(|client| client.primary)
}

fn snapshot(inner: &Inner, state: &LauncherState) -> LauncherStatus {
    let (remote_configuration, update_required) = state.remote.read().map(|value| {
        let update_required = reconcile_update_requirement(&state.update_required, &value);
        (value.clone(), update_required)
    }).unwrap_or_else(|_| (serde_json::Value::Null, state.update_required.load(Ordering::Acquire)));
    LauncherStatus { selected_directory: inner.selected.clone(), resources: inner.prepared.as_ref().map(|p| p.resources.clone()),
        clients: inner.clients.iter().map(|client| ClientStatus { id: client.id, number: client.number, primary: client.primary,
            running_url: client.server.url(), invitation_url: client.guide.url() }).collect(),
        running_urls: inner.clients.iter().map(|client| client.server.url()).collect(),
        invitation_urls: inner.clients.iter().map(|client| client.guide.url()).collect(), version: env!("CARGO_PKG_VERSION"), platform: platform_key(),
        update_required, remote_configuration, language: language::snapshot(&state.language), lan: LanStatus { settings: inner.lan_settings.clone(), addresses: lan::addresses(),
            running_url: primary_client(inner).map(|client| client.server.url()), guide_url: primary_client(inner).map(|client| client.guide.url()),
            host_address: inner.lan_address.clone(), ca_fingerprint: inner.lan_fingerprint.clone().or_else(|| ca_trust::fingerprint().ok()) } }
}
fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|p| p.join("launcher.json")).map_err(|e| e.to_string())
}
fn save_preferences(app: &tauri::AppHandle, inner: &Inner) -> Result<(), String> {
    let preference=app.try_state::<LauncherState>().map(|state| language::snapshot(&state.language).preference);
    save_preferences_with_language(app, inner, preference)
}
fn save_preferences_with_language(app: &tauri::AppHandle, inner: &Inner, preference: Option<String>) -> Result<(), String> {
    let path = preferences_path(app)?;
    write_preferences(&path,&Preferences { selected_directory: inner.selected.clone(),
        lan_settings: Some(inner.lan_settings.clone()), language: preference })
}
fn write_preferences(path: &Path, preferences: &Preferences) -> Result<(), String> {
    use std::io::Write;
    let parent=path.parent().ok_or("启动器设置目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes=serde_json::to_vec_pretty(preferences).map_err(|e|e.to_string())?;
    let mut pending=tempfile::NamedTempFile::new_in(parent).map_err(|e|format!("无法保存启动器设置：{e}"))?;
    pending.write_all(&bytes).and_then(|_|pending.as_file().sync_all()).map_err(|e|format!("无法保存启动器设置：{e}"))?;
    pending.persist(path).map_err(|e|format!("无法保存启动器设置：{e}"))?;
    Ok(())
}
fn embedded_client() -> HashMap<String, &'static [u8]> {
    fn visit(directory: &'static Dir<'static>, files: &mut HashMap<String, &'static [u8]>) {
        for file in directory.files() {
            let path = file.path().to_string_lossy().replace('\\', "/");
            let url = if path == "loader.js" { "/b/8b0b5899ed/loader.js".to_string() } else { format!("/{path}") };
            files.insert(url, file.contents());
        }
        for child in directory.dirs() { visit(child, files); }
    }
    let mut files = HashMap::new(); visit(&CLIENT, &mut files); files
}

#[tauri::command]
fn launcher_status(state: State<'_, LauncherState>) -> Result<LauncherStatus, String> {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(snapshot(&inner, &state))
}
#[tauri::command]
fn set_language(app: tauri::AppHandle,state: State<'_,LauncherState>,language: String)->Result<LauncherStatus,String>{
    let inner=state.inner.lock().map_err(|e|e.to_string())?;
    let previous=language::snapshot(&state.language);
    let next=language::LanguageConfig::with_preference(&language,previous.revision.checked_add(1).ok_or("Language revision exhausted.")?)?;
    // Keep the live setting unchanged until persistence succeeds, including for polling Web clients.
    save_preferences_with_language(&app,&inner,Some(next.preference.clone()))?;
    *state.language.write().map_err(|e|e.to_string())?=next.clone();
    let _=app.emit("language-change",next);
    update_native_language(&app,&state);
    Ok(snapshot(&inner,&state))
}

#[tauri::command]
async fn choose_game_directory(state: State<'_,LauncherState>) -> Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new().set_title(language::snapshot(&state.language).text("选择游戏资源目录（或包含 mirror 的外层目录）","Select your game resources folder (or its outer mirror folder)"))
        .pick_folder().await.map(|file| file.path().to_string_lossy().into_owned()))
}

fn progress(app: &tauri::AppHandle, phase: &str, text: &str) {
    let _ = app.emit("launcher-progress", serde_json::json!({"phase":phase,"text":text}));
}

#[tauri::command]
async fn prepare_game(app: tauri::AppHandle, state: State<'_, LauncherState>, selected: String) -> Result<LauncherStatus, String> {
    ensure_current_launcher(&state)?;
    let _guard = acquire(&state)?;
    if { let inner = state.inner.lock().map_err(|e| e.to_string())?; !inner.clients.is_empty() } {
        return Err("请先停止正在运行的游戏服务，再更换资源目录。".into());
    }
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let worker_app = app.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        progress(&worker_app, "checking", "识别资源目录并校验引擎版本…");
        let resources = resources::inspect_game_resources(Path::new(&selected))?;
        let cache = cache.join(&resources.original_sha256);
        let runtime = cache.join("runtime");
        progress(&worker_app, "engine", "准备启动器的离线与在线运行引擎…");
        engine::prepare(&resources.original_wasm, &runtime)?;
        progress(&worker_app, "fonts", "从自己的资源包准备字体缓存…");
        let fonts = fonts::prepare(&resources.root, &resources.original_wasm, &cache.join("fonts"))?;
        Ok::<_, String>(Prepared { resources, runtime, fonts })
    }).await.map_err(|e| format!("资源准备任务异常：{e}"))??;
    ensure_current_launcher(&state)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.selected = Some(prepared.resources.root.to_string_lossy().into_owned());
    inner.prepared = Some(prepared);
    save_preferences(&app, &inner)?;
    progress(&app, "ready", "资源已就绪，可以启动游戏。");
    Ok(snapshot(&inner, &state))
}

#[cfg(test)]
fn start_client(prepared: &Prepared, lan: lan::PreparedLan, index: usize, log_dir: &Path,
    remote: Arc<RwLock<serde_json::Value>>, multiplayer_server: String) -> Result<GameClient, String> {
    start_client_with_identity(prepared, lan, ClientIdentity { id: index as u64, primary: index == 1 }, log_dir, remote, multiplayer_server, language::shared())
}

fn start_client_with_identity(prepared: &Prepared, lan: lan::PreparedLan, identity: ClientIdentity,
    log_dir: &Path, remote: Arc<RwLock<serde_json::Value>>, multiplayer_server: String, language: language::SharedLanguage) -> Result<GameClient, String> {
    let ip = lan.config.address;
    let server = http_server::start(prepared.resources.clone(), prepared.runtime.clone(), embedded_client(), http_server::ServerConfig {
        online_ready: true, instance_name: format!("玩家{}", identity.id),
        log_file: log_dir.join(format!("browser-{}.log", identity.id)), preferred_port: Some(lan.settings.port),
        font_overrides: prepared.fonts.clone(), remote_configuration: remote, multiplayer_server,
        language: language.clone(),
        lan: Some(lan.config), ..Default::default()
    })?;
    // 引导端口不可用时回滚 HTTPS，只有两者都成功才发布客户端。
    let guide = lan_bootstrap::start_with_language(ip, lan.settings.http_port, server.port(), lan.ca_certificate, lan.fingerprint,language)?;
    Ok(GameClient { id: identity.id, number: identity.id, primary: identity.primary, guide, server })
}

fn next_client_identity(inner: &Inner, additional: bool) -> Result<Option<ClientIdentity>, String> {
    if !additional && primary_client(inner).is_some() { return Ok(None); }
    if inner.clients.len() >= 8 { return Err("最多同时开启 8 个客户端。".into()); }
    let id = inner.last_client_id.checked_add(1).ok_or("客户端编号已达到上限，请重启启动器。")?;
    Ok(Some(ClientIdentity { id, primary: !additional }))
}

fn client_settings(inner: &Inner, additional: bool) -> Result<lan::Settings, String> {
    if additional { lan::additional_settings() } else { Ok(inner.lan_settings.clone()) }
}

#[tauri::command]
async fn start_game(app: tauri::AppHandle, state: State<'_, LauncherState>, additional: bool) -> Result<LauncherStatus, String> {
    ensure_current_launcher(&state)?;
    let _guard = acquire(&state)?;
    let (settings, address, identity) = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        let Some(identity) = next_client_identity(&inner, additional)? else { return Ok(snapshot(&inner, &state)); };
        inner.prepared.as_ref().ok_or("请先选择并校验游戏资源。")?;
        let address = inner.lan_address.clone().or_else(|| inner.lan_settings.address.clone())
            .or_else(|| lan::addresses().into_iter().next())
            .ok_or("未检测到本机局域网 IPv4 地址，请连接局域网或在共享设置中选择本机 IP。")?;
        let settings = client_settings(&inner, additional)?;
        (settings, address, identity)
    };
    progress(&app, "lan", "正在使用本机局域网 IP 准备游戏服务…");
    let lan = tauri::async_runtime::spawn_blocking(move || lan::prepare(settings, &address))
        .await.map_err(|_| "局域网证书准备异常。".to_string())??;
    ensure_current_launcher(&state)?;
    let address = lan.config.address.to_string();
    let fingerprint = lan.fingerprint.clone();
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if state.shutting_down.load(Ordering::Acquire) { return Err("启动器正在关闭。".into()); }
    let prepared = inner.prepared.as_ref().ok_or("游戏资源尚未就绪。")?;
    let multiplayer_server = configured_remote(&state).ok()
        .and_then(|config| config.server.map(|server| server.websocket_url.unwrap_or(server.address)))
        .unwrap_or_else(|| "183.66.27.21:47485".to_string());
    let id = identity.id;
    let client = start_client_with_identity(prepared, lan, identity, &app.path().app_log_dir().map_err(|e| e.to_string())?,
        state.remote.clone(), multiplayer_server,state.language.clone())?;
    inner.last_client_id = id;
    inner.clients.push(client);
    inner.lan_address = Some(address);
    inner.lan_fingerprint = Some(fingerprint);
    progress(&app, "ready", "游戏服务已启动，可将客户端邀请地址发给局域网朋友。");
    Ok(snapshot(&inner, &state))
}

fn stop_clients(inner: &mut Inner) {
    inner.clients.clear();
    inner.lan_address = None;
    inner.lan_fingerprint = None;
}

fn shutdown_clients(state: &LauncherState) {
    state.shutting_down.store(true, Ordering::Release);
    // 即使之前某项操作 panic 导致锁中毒，也必须停止已持有的全部监听器。
    let mut inner = state.inner.lock().unwrap_or_else(|error| error.into_inner());
    stop_clients(&mut inner);
}

fn remove_client(inner: &mut Inner, id: u64) -> Result<(), String> {
    let index = inner.clients.iter().position(|client| client.id == id)
        .ok_or("指定的游戏客户端不存在或已经停止。")?;
    inner.clients.remove(index);
    if inner.clients.is_empty() {
        inner.lan_address = None;
        inner.lan_fingerprint = None;
    }
    Ok(())
}

#[tauri::command]
fn stop_game(state: State<'_, LauncherState>) -> Result<LauncherStatus, String> {
    let _guard = acquire(&state)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    stop_clients(&mut inner);
    Ok(snapshot(&inner, &state))
}

#[tauri::command]
fn stop_game_client(state: State<'_, LauncherState>, id: u64) -> Result<LauncherStatus, String> {
    stop_client(&state, id)
}

fn stop_client(state: &LauncherState, id: u64) -> Result<LauncherStatus, String> {
    let _guard = acquire(&state)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    remove_client(&mut inner, id)?;
    Ok(snapshot(&inner, &state))
}

fn find_client(inner: &Inner, id: Option<u64>, index: Option<usize>) -> Result<&GameClient, String> {
    let client = match (id, index) {
        (Some(id), _) => inner.clients.iter().find(|client| client.id == id),
        (None, Some(index)) => inner.clients.get(index),
        (None, None) => primary_client(inner),
    };
    client.ok_or("指定的游戏客户端不存在或已经停止。".into())
}

#[tauri::command]
fn open_game(state: State<'_, LauncherState>, id: Option<u64>, index: Option<usize>, trusted: Option<bool>) -> Result<(), String> {
    ensure_current_launcher(&state)?;
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    let client = find_client(&inner, id, index)?;
    // 未确认信任时先打开 HTTP 引导；引导页验证 HTTPS 后自动进入对应客户端。
    let url = if trusted.unwrap_or(false) { client.server.url() } else { client.guide.url() };
    drop(inner);
    open::that(url).map_err(|e| format!("无法打开默认浏览器，请复制客户端邀请地址手动打开：{e}"))
}

#[tauri::command]
fn save_lan_settings(app: tauri::AppHandle, state: State<'_, LauncherState>, port: u16, http_port: u16,
    address: Option<String>) -> Result<LauncherStatus, String> {
    ensure_current_launcher(&state)?;
    let _guard = acquire(&state)?;
    let address = address.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
    let settings = lan::Settings { port, http_port, address };
    lan::validate_ports(&settings)?;
    if let Some(address) = settings.address.as_ref() { lan::validate_local_settings(&settings, address)?; }
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if !inner.clients.is_empty() { return Err("请先停止游戏服务，再修改局域网 IP 或端口。".into()); }
    let previous = std::mem::replace(&mut inner.lan_settings, settings);
    if let Err(error) = save_preferences(&app, &inner) {
        inner.lan_settings = previous;
        return Err(error);
    }
    Ok(snapshot(&inner, &state))
}

#[tauri::command]
async fn check_lan_ca_status() -> Result<ca_trust::Status, String> {
    // 只读查询可在游戏启动前进行，不占用资源准备或安装操作的忙锁。
    tauri::async_runtime::spawn_blocking(ca_trust::check_status)
        .await.map_err(|_| "系统证书检测任务异常，请稍后重试。".to_string())?
}

#[tauri::command]
async fn install_lan_ca(app: tauri::AppHandle, state: State<'_, LauncherState>) -> Result<String, String> {
    ensure_current_launcher(&state)?;
    let _guard = acquire(&state)?;
    progress(&app, "ca", "正在请求系统授权，安装并信任局域网 CA…");
    let message = tauri::async_runtime::spawn_blocking(ca_trust::install)
        .await.map_err(|_| "证书安装任务异常，请下载 CA 证书后手动安装。".to_string())??;
    progress(&app, "ready", &message);
    Ok(message)
}

#[tauri::command]
async fn save_lan_ca_certificate(state: State<'_, LauncherState>) -> Result<Option<String>, String> {
    ensure_current_launcher(&state)?;
    let _guard = acquire(&state)?;
    let locale=language::snapshot(&state.language);
    let Some(file) = rfd::AsyncFileDialog::new().set_title(locale.text("保存局域网 CA 公共证书","Save the LAN CA public certificate"))
        .set_file_name("GTA5DATA-LAN-CA.cer").add_filter(locale.text("CA 公共证书","CA public certificate"), &["cer", "crt"])
        .save_file().await else { return Ok(None); };
    ensure_current_launcher(&state)?;
    let path = file.path().to_owned();
    let game_root = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.prepared.as_ref().map(|prepared| prepared.resources.root.clone())
            .or_else(|| inner.selected.as_ref().and_then(|selected| Path::new(selected).canonicalize().ok()))
    };
    tauri::async_runtime::spawn_blocking(move || {
        write_public_ca(&path, game_root.as_deref())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }).await.map_err(|_| "证书保存任务异常，请重试。".to_string())?
}

fn write_public_ca(path: &Path, game_root: Option<&Path>) -> Result<(), String> {
    let parent = path.parent().ok_or("证书保存位置无效。")?.canonicalize().map_err(|_| "证书保存目录不可访问。")?;
    let target = parent.join(path.file_name().ok_or("证书文件名无效。")?);
    if let Some(game) = game_root {
        let game = game.canonicalize().map_err(|_| "游戏资源目录不可访问，请重新选择保存位置。".to_string())?;
        if target.starts_with(game) {
            return Err("CA 证书不能保存到游戏资源目录，请选择其他位置。".into());
        }
    }
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("证书保存位置必须是普通文件，不能使用目录或符号链接。".into());
        }
    }
    let der = ca_trust::public_certificate_der()?;
    fs::write(target, der).map_err(|_| "无法保存 CA 公共证书，请选择可写目录。".into())
}

#[tauri::command]
async fn remote_configuration(app: tauri::AppHandle, state: State<'_, LauncherState>, force_refresh: bool) -> Result<serde_json::Value, String> {
    if !force_refresh || state.remote_busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return state.remote.read().map(|value| value.clone()).map_err(|e| e.to_string());
    }
    let _guard = BusyGuard(state.remote_busy.clone());
    let snapshot = tauri::async_runtime::spawn_blocking(remote_config::load).await.map_err(|e| e.to_string())?;
    let value = publish_remote_snapshot(&state.remote, &state.update_required, snapshot)?;
    let _ = app.emit("launcher-remote-config", &value);
    Ok(value)
}

fn configured_remote(state: &LauncherState) -> Result<remote_config::RemoteConfig, String> {
    let value = state.remote.read().map_err(|e| e.to_string())?;
    if value.get("source").and_then(|source| source.as_str()) != Some("remote") {
        return Err("远程配置尚未加载，请检查更新后重试。".into());
    }
    remote_config::parse_config(&serde_json::to_vec(value.get("config").ok_or("远程配置尚未加载")?).map_err(|e| e.to_string())?)
}

#[tauri::command]
fn open_update_download(state: State<'_, LauncherState>) -> Result<(), String> {
    let config = configured_remote(&state)?;
    let latest = config.latest_version.as_deref().ok_or("远程配置尚未发布版本信息。")?;
    if !remote_config::has_update(env!("CARGO_PKG_VERSION"), Some(latest)) { return Err("没有比当前版本更新的下载。".into()); }
    let download = remote_config::download_for_platform(&config, platform_key()).ok_or("远程配置尚未提供此系统的下载地址与校验值。")?;
    // 仅打开已验证元数据里的 HTTPS 下载，绝不执行远程命令或自动覆盖正在运行的应用。
    open::that(&download.url).map_err(|e| format!("无法打开版本下载地址：{e}"))
}

#[tauri::command]
fn open_project_website(state: State<'_, LauncherState>) -> Result<(), String> {
    let config = configured_remote(&state)?;
    let url = config.website.as_deref().or_else(|| (!config.oltitle.is_empty()).then_some(config.oltitle.as_str()))
        .ok_or("远程配置尚未提供状态页面地址。")?;
    remote_config::https_url(url)?;
    open::that(url).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_game_resource_page() -> Result<(), String> {
    open::that("https://archive.org/download/gta5-wasm/")
        .map_err(|_| "无法打开游戏资源页面，请检查默认浏览器设置。".to_string())
}

fn update_native_language(app: &tauri::AppHandle,state: &LauncherState) {
    let locale=language::snapshot(&state.language);
    if let Some(window)=app.get_webview_window("main") {
        let _=window.set_title(locale.text("GTA V 公共战局 · 启动器","GTA V Public Session · Launcher"));
    }
    let _=apply_native_menu(app,state);
}
fn apply_native_menu(app: &tauri::AppHandle,state: &LauncherState)->Result<(),tauri::Error>{
            // 默认 macOS 菜单仍提供全屏和最大化；固定窗口只保留必要系统操作。
    #[cfg(target_os = "macos")]
    {
                use tauri::menu::{Menu, Submenu, PredefinedMenuItem};
                let locale=language::snapshot(&state.language);
                let application = Submenu::with_items(app, "GTA5Data", true, &[
                    &PredefinedMenuItem::hide(app, Some(locale.text("隐藏启动器","Hide Launcher")))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some(locale.text("退出启动器","Quit Launcher")))?,
                ])?;
                let edit = Submenu::with_items(app, locale.text("编辑","Edit"), true, &[
                    &PredefinedMenuItem::undo(app, Some(locale.text("撤销","Undo")))?,
                    &PredefinedMenuItem::redo(app, Some(locale.text("重做","Redo")))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some(locale.text("剪切","Cut")))?,
                    &PredefinedMenuItem::copy(app, Some(locale.text("复制","Copy")))?,
                    &PredefinedMenuItem::paste(app, Some(locale.text("粘贴","Paste")))?,
                    &PredefinedMenuItem::select_all(app, Some(locale.text("全选","Select All")))?,
                ])?;
                let window = Submenu::with_items(app, locale.text("窗口","Window"), true, &[
                    &PredefinedMenuItem::minimize(app, Some(locale.text("最小化","Minimize")))?,
                    &PredefinedMenuItem::close_window(app, Some(locale.text("关闭","Close")))?,
                ])?;
                app.set_menu(Menu::with_items(app, &[&application, &edit, &window])?)?;
            }
    #[cfg(not(target_os = "macos"))]
    let _=(app,state);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(LauncherState::default())
        .setup(|app| {
            let settings = preferences_path(app.handle()).ok().and_then(|path| fs::read(path).ok())
                .and_then(|bytes| serde_json::from_slice::<Preferences>(&bytes).ok()).unwrap_or_default();
            let state = app.state::<LauncherState>();
            let mut inner = state.inner.lock().unwrap();
            inner.selected = settings.selected_directory;
            inner.lan_settings = settings.lan_settings.unwrap_or_default();
            *state.language.write().unwrap()=language::LanguageConfig::with_preference(settings.language.as_deref().unwrap_or("system"),1).unwrap_or_default();
            drop(inner);
            update_native_language(app.handle(),&state);
            let remote = state.remote.clone(); let busy = state.remote_busy.clone();
            let update_required = state.update_required.clone();
            let handle = app.handle().clone();
            busy.store(true, Ordering::Release);
            tauri::async_runtime::spawn_blocking(move || {
                let _guard = BusyGuard(busy);
                if let Ok(value) = publish_remote_snapshot(&remote, &update_required, remote_config::load()) {
                    let _ = handle.emit("launcher-remote-config", value);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                shutdown_clients(&window.state::<LauncherState>());
                // macOS 默认允许无窗口应用留在后台；关闭启动器就退出整个进程。
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![launcher_status, choose_game_directory, prepare_game, start_game, stop_game, stop_game_client, open_game,
            remote_configuration, open_update_download, open_project_website, open_game_resource_page,
            save_lan_settings, check_lan_ca_status, install_lan_ca, save_lan_ca_certificate, set_language])
        .build(tauri::generate_context!()).expect("启动桌面界面失败")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                shutdown_clients(&app.state::<LauncherState>());
            }
        });
}

/// 后端维护检查：不创建窗口、不打开浏览器，所有生成物仅写入显式外部缓存。
pub fn verify_resources(selected: &Path, cache: &Path) -> Result<serde_json::Value, String> {
    let info = resources::inspect_game_resources(selected)?;
    engine::prepare(&info.original_wasm, &cache.join("runtime"))?;
    let fonts = fonts::prepare(&info.root, &info.original_wasm, &cache.join("fonts"))?;
    let remote = remote_config::load();
    let remote_value = serde_json::to_value(&remote).map_err(|e| e.to_string())?;
    let server = http_server::start(info.clone(), cache.join("runtime"), embedded_client(), http_server::ServerConfig {
        online_ready: true, font_overrides: fonts.clone(), log_file: cache.join("browser.log"),
        remote_configuration: Arc::new(RwLock::new(remote_value)), ..Default::default()
    })?;
    use std::io::{Read, Write};
    let mut connection = std::net::TcpStream::connect(("127.0.0.1", server.port())).map_err(|e| e.to_string())?;
    connection.set_read_timeout(Some(std::time::Duration::from_secs(5))).map_err(|e| e.to_string())?;
    connection.write_all(format!("GET / HTTP/1.0\r\nHost: 127.0.0.1:{}\r\n\r\n", server.port()).as_bytes()).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new(); connection.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let split = bytes.windows(4).position(|part| part == b"\r\n\r\n").ok_or("HTTP响应格式无效")?;
    let body = &bytes[split + 4..];
    if body != CLIENT.get_file("index.html").ok_or("启动器未嵌入首页")?.contents() { return Err("HTTP首页未采用内嵌client".into()); }
    let headers = String::from_utf8_lossy(&bytes[..split]);
    if !headers.contains("Cross-Origin-Embedder-Policy: require-corp") { return Err("缺少跨域隔离响应头".into()); }
    let mut remote_connection = std::net::TcpStream::connect(("127.0.0.1", server.port())).map_err(|e| e.to_string())?;
    remote_connection.set_read_timeout(Some(std::time::Duration::from_secs(10))).map_err(|e| e.to_string())?;
    remote_connection.write_all(format!("GET /api/remote-config?refresh=1 HTTP/1.0\r\nHost: 127.0.0.1:{}\r\n\r\n", server.port()).as_bytes()).map_err(|e| e.to_string())?;
    let mut remote_bytes = Vec::new(); remote_connection.read_to_end(&mut remote_bytes).map_err(|e| e.to_string())?;
    let remote_split = remote_bytes.windows(4).position(|part| part == b"\r\n\r\n").ok_or("远程配置代理响应格式无效")?;
    let remote_http: serde_json::Value = serde_json::from_slice(&remote_bytes[remote_split + 4..]).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "resources": info, "embedded_client": true, "fonts_cached": fonts.len(),
        "offline_engine": cache.join("runtime/offline/game.wasm"), "online_engine": cache.join("runtime/online/game.wasm"),
        "http_started": true, "python_required": false, "game_resources_changed": false,
        "remote_source": remote.source, "oltitle": remote.config.oltitle,
        "remote_error": remote.error, "remote_servers": remote.config.servers,
        "remote_announcements": remote.config.announcements.len(),
        "remote_latest_version": remote.config.latest_version,
        "remote_http_source": remote_http["source"], "remote_http_error": remote_http["error"],
        "remote_http_servers": remote_http["config"]["servers"],
        "remote_http_announcements": remote_http["config"]["announcements"].as_array().map(Vec::len) }))
}

#[cfg(test)]
mod update_gate_tests {
    use super::*;

    #[test]
    fn older_preferences_keep_the_selected_resources_and_default_to_system_language() {
        let old: Preferences=serde_json::from_str(r#"{"selected_directory":"/games/player-data"}"#).unwrap();
        assert_eq!(old.selected_directory.as_deref(),Some("/games/player-data"));
        assert!(old.language.is_none());
        let saved=Preferences { language:Some("en".into()),..old };
        let reloaded:Preferences=serde_json::from_slice(&serde_json::to_vec(&saved).unwrap()).unwrap();
        assert_eq!(reloaded.language.as_deref(),Some("en"));
    }

    #[test]
    fn preferences_replace_atomically_without_rewriting_linked_files() {
        let temp=tempfile::tempdir().unwrap();
        let path=temp.path().join("launcher.json");
        fs::write(&path,b"previous preferences").unwrap();
        let linked=temp.path().join("player-original");
        fs::hard_link(&path,&linked).unwrap();
        write_preferences(&path,&Preferences { language:Some("en".into()),..Default::default() }).unwrap();
        assert_eq!(fs::read(&linked).unwrap(),b"previous preferences");
        let saved:Preferences=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved.language.as_deref(),Some("en"));
        let blocked=temp.path().join("directory");fs::create_dir(&blocked).unwrap();
        assert!(write_preferences(&blocked,&saved).is_err());
        assert_eq!(fs::read(&path).unwrap(),serde_json::to_vec_pretty(&saved).unwrap());
    }

    fn fresh_release(version: &str) -> remote_config::ConfigSnapshot {
        remote_config::ConfigSnapshot {
            config: remote_config::parse_config(&serde_json::to_vec(&serde_json::json!({
                "latest_version": version
            })).unwrap()).unwrap(),
            source: remote_config::ConfigSource::Remote, stale: false,
            fetched_at: Some(123), checked_at: 123, error: None,
        }
    }

    #[test]
    fn publish_latches_before_status_and_failure_cannot_unlock_game_commands() {
        let state = LauncherState::default();
        assert!(ensure_current_launcher(&state).is_ok());
        publish_remote_snapshot(&state.remote, &state.update_required, fresh_release("99.0.0")).unwrap();
        assert!(state.update_required.load(Ordering::Acquire));
        assert_eq!(ensure_current_launcher(&state).unwrap_err(), "请先更新启动器至最新版本。");
        assert!(snapshot(&Inner::default(), &state).update_required);
        publish_remote_snapshot(&state.remote, &state.update_required, remote_config::ConfigSnapshot::default()).unwrap();
        assert!(ensure_current_launcher(&state).is_err());
        publish_remote_snapshot(&state.remote, &state.update_required, fresh_release(env!("CARGO_PKG_VERSION"))).unwrap();
        assert!(ensure_current_launcher(&state).is_ok());
        assert!(!snapshot(&Inner::default(), &state).update_required);
    }

    #[test]
    fn game_command_gate_observes_the_local_http_proxy_shared_snapshot() {
        let state = LauncherState::default();
        *state.remote.write().unwrap() = serde_json::to_value(fresh_release("99.0.0")).unwrap();
        assert!(!state.update_required.load(Ordering::Acquire));
        assert!(ensure_current_launcher(&state).is_err());
        *state.remote.write().unwrap() = serde_json::to_value(remote_config::ConfigSnapshot::default()).unwrap();
        assert!(ensure_current_launcher(&state).is_err());
        *state.remote.write().unwrap() = serde_json::to_value(fresh_release(env!("CARGO_PKG_VERSION"))).unwrap();
        assert!(ensure_current_launcher(&state).is_ok());
    }


}

#[cfg(test)]
mod public_ca_export_tests {
    use super::*;

    #[test]
    fn export_contains_only_the_public_certificate_and_refuses_game_paths() {
        let temp = tempfile::tempdir().unwrap();
        let game = temp.path().join("game");
        fs::create_dir(&game).unwrap();
        let protected = game.join("original.data");
        fs::write(&protected, b"original data").unwrap();
        assert!(write_public_ca(&game.join("ca.cer"), Some(&game)).is_err());
        assert!(write_public_ca(&protected, Some(&game)).is_err());
        assert_eq!(fs::read(&protected).unwrap(), b"original data");
        let target = temp.path().join("public.cer");
        write_public_ca(&target, Some(&game)).unwrap();
        assert_eq!(fs::read(&target).unwrap(), ca_trust::public_certificate_der().unwrap());
        assert!(x509_parser::parse_x509_certificate(&fs::read(target).unwrap()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn export_cannot_follow_a_symbolic_link_into_resources() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("original.data");
        fs::write(&original, b"read only resources").unwrap();
        let alias = temp.path().join("ca.cer");
        std::os::unix::fs::symlink(&original, &alias).unwrap();
        assert!(write_public_ca(&alias, None).is_err());
        assert_eq!(fs::read(original).unwrap(), b"read only resources");
    }
}
