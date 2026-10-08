mod engine;
mod fonts;
mod http_server;
mod resources;

use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use tauri::{Emitter, Manager, State};

static CLIENT: Dir<'_> = include_dir!("$OUT_DIR/embedded-client");

#[derive(Default, Deserialize, Serialize)]
struct Preferences { selected_directory: Option<String>, preferred_port: Option<u16> }
struct Prepared { resources: resources::ResourceInfo, runtime: PathBuf, fonts: HashMap<String, PathBuf> }
#[derive(Default)]
struct Inner { selected: Option<String>, preferred_port: Option<u16>, prepared: Option<Prepared>, servers: Vec<http_server::ServerHandle> }
#[derive(Default)]
struct LauncherState { inner: Mutex<Inner>, busy: Arc<AtomicBool> }
struct BusyGuard(Arc<AtomicBool>);
impl Drop for BusyGuard { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }
fn acquire(state: &LauncherState) -> Result<BusyGuard, String> {
    state.busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "正在处理上一项操作，请稍候。".to_string())?;
    Ok(BusyGuard(state.busy.clone()))
}

#[derive(Serialize)]
struct LauncherStatus { selected_directory: Option<String>, resources: Option<resources::ResourceInfo>, running_urls: Vec<String>, version: &'static str }
fn snapshot(inner: &Inner) -> LauncherStatus {
    LauncherStatus { selected_directory: inner.selected.clone(), resources: inner.prepared.as_ref().map(|p| p.resources.clone()),
        running_urls: inner.servers.iter().map(|s| s.url()).collect(), version: env!("CARGO_PKG_VERSION") }
}
fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|p| p.join("launcher.json")).map_err(|e| e.to_string())
}
fn save_preferences(app: &tauri::AppHandle, inner: &Inner) -> Result<(), String> {
    let path = preferences_path(app)?;
    fs::create_dir_all(path.parent().ok_or("启动器设置目录无效")?).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&Preferences { selected_directory: inner.selected.clone(), preferred_port: inner.preferred_port }).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| format!("无法保存启动器设置：{e}"))
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
    Ok(snapshot(&inner))
}

#[tauri::command]
async fn choose_game_directory() -> Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new().set_title("选择游戏资源目录（或包含 mirror 的外层目录）")
        .pick_folder().await.map(|file| file.path().to_string_lossy().into_owned()))
}

fn progress(app: &tauri::AppHandle, phase: &str, text: &str) {
    let _ = app.emit("launcher-progress", serde_json::json!({"phase":phase,"text":text}));
}

#[tauri::command]
async fn prepare_game(app: tauri::AppHandle, state: State<'_, LauncherState>, selected: String) -> Result<LauncherStatus, String> {
    let _guard = acquire(&state)?;
    if !state.inner.lock().map_err(|e| e.to_string())?.servers.is_empty() {
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
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.selected = Some(prepared.resources.root.to_string_lossy().into_owned());
    inner.prepared = Some(prepared);
    save_preferences(&app, &inner)?;
    progress(&app, "ready", "资源已就绪，可以启动游戏。");
    Ok(snapshot(&inner))
}

#[tauri::command]
fn start_game(app: tauri::AppHandle, state: State<'_, LauncherState>, additional: bool) -> Result<LauncherStatus, String> {
    let _guard = acquire(&state)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if !additional && !inner.servers.is_empty() { return Ok(snapshot(&inner)); }
    if inner.servers.len() >= 8 { return Err("最多同时开启 8 个测试客户端。".into()); }
    let prepared = inner.prepared.as_ref().ok_or("请先选择并校验游戏资源。")?;
    let index = inner.servers.len() + 1;
    let log_file = app.path().app_log_dir().map_err(|e| e.to_string())?.join(format!("browser-{index}.log"));
    let server = http_server::start(prepared.resources.clone(), prepared.runtime.clone(), embedded_client(), http_server::ServerConfig {
        online_ready: true, instance_name: format!("玩家{index}"), log_file,
        preferred_port: if index == 1 { inner.preferred_port } else { None }, font_overrides: prepared.fonts.clone(),
        ..Default::default()
    })?;
    if index == 1 { inner.preferred_port = Some(server.port()); }
    inner.servers.push(server);
    save_preferences(&app, &inner)?;
    Ok(snapshot(&inner))
}

#[tauri::command]
fn stop_game(state: State<'_, LauncherState>) -> Result<LauncherStatus, String> {
    let _guard = acquire(&state)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.servers.clear(); Ok(snapshot(&inner))
}

#[tauri::command]
fn open_game(state: State<'_, LauncherState>, index: usize) -> Result<(), String> {
    let url = state.inner.lock().map_err(|e| e.to_string())?.servers.get(index).ok_or("游戏服务尚未启动。")?.url();
    // 游戏在系统浏览器运行，避免依赖不同系统 WebView 的 WebGPU / WASM 线程支持。
    open::that(url).map_err(|e| format!("无法打开默认浏览器，请复制游戏地址手动打开：{e}"))
}

pub fn run() {
    tauri::Builder::default()
        .manage(LauncherState::default())
        .setup(|app| {
            let settings = preferences_path(app.handle()).ok().and_then(|path| fs::read(path).ok())
                .and_then(|bytes| serde_json::from_slice::<Preferences>(&bytes).ok()).unwrap_or_default();
            let state = app.state::<LauncherState>();
            let mut inner = state.inner.lock().unwrap();
            inner.selected = settings.selected_directory; inner.preferred_port = settings.preferred_port;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![launcher_status, choose_game_directory, prepare_game, start_game, stop_game, open_game])
        .build(tauri::generate_context!()).expect("启动桌面界面失败")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Ok(mut inner) = app.state::<LauncherState>().inner.lock() { inner.servers.clear(); }
            }
        });
}

/// 后端维护检查：不创建窗口、不打开浏览器，所有生成物仅写入显式外部缓存。
pub fn verify_resources(selected: &Path, cache: &Path) -> Result<serde_json::Value, String> {
    let info = resources::inspect_game_resources(selected)?;
    engine::prepare(&info.original_wasm, &cache.join("runtime"))?;
    let fonts = fonts::prepare(&info.root, &info.original_wasm, &cache.join("fonts"))?;
    let server = http_server::start(info.clone(), cache.join("runtime"), embedded_client(), http_server::ServerConfig {
        online_ready: true, font_overrides: fonts.clone(), log_file: cache.join("browser.log"), ..Default::default()
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
    Ok(serde_json::json!({ "resources": info, "embedded_client": true, "fonts_cached": fonts.len(),
        "offline_engine": cache.join("runtime/offline/game.wasm"), "online_engine": cache.join("runtime/online/game.wasm"),
        "http_started": true, "python_required": false, "game_resources_changed": false }))
}
