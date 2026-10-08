//! Local HTTP and optional LAN HTTPS bridges. Player resources are read-only.
use crate::resources::{contained_file, safe_relative, ResourceInfo};
use flate2::{write::GzEncoder, Compression};
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Request, Response, Server, SslConfig, StatusCode};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_BATCH_BYTES: u64 = 64 * 1024 * 1024;
const WORKERS: usize = 8;

#[derive(Clone)]
pub struct LanConfig {
    /// Selected local interface; never an arbitrary public address.
    pub address: Ipv4Addr,
    pub tls_certificate: Vec<u8>,
    pub tls_private_key: Vec<u8>,
    /// Only this HTTP guide may probe certificate trust; it cannot read game data.
    pub bootstrap_origin: String,
    pub ca_fingerprint: String,
}
impl std::fmt::Debug for LanConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("LanConfig")
            .field("address", &self.address).field("bootstrap_origin", &self.bootstrap_origin)
            .field("ca_fingerprint", &self.ca_fingerprint)
            .field("tls_certificate", &"[redacted]")
            .field("tls_private_key", &"[redacted]").finish()
    }
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub multiplayer_server: String,
    pub instance_name: String,
    pub log_file: PathBuf,
    pub online_ready: bool,
    /// Reuse the prior origin so the browser keeps the player's saved profile.
    pub preferred_port: Option<u16>,
    /// Relative data names mapped to read-only extracted font caches outside game data.
    pub font_overrides: HashMap<String, PathBuf>,
    /// Validated launcher metadata shared with the UI and all local game clients.
    pub remote_configuration: Arc<RwLock<Value>>,
    /// A separate HTTPS resource service for friends on the same LAN.
    pub lan: Option<LanConfig>,
}
impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            multiplayer_server: "183.66.27.21:47485".into(),
            instance_name: "玩家1".into(),
            log_file: std::env::temp_dir().join("gta5-launcher/browser-local.log"),
            online_ready: false,
            preferred_port: None,
            font_overrides: HashMap::new(),
            remote_configuration: Arc::new(RwLock::new(json!({ "config": {},
                "source": "unavailable", "stale": true }))),
            lan: None,
        }
    }
}

struct State {
    resources: ResourceInfo,
    runtime_root: PathBuf,
    client: HashMap<String, &'static [u8]>,
    config: ServerConfig,
    port: u16,
    log_lock: Mutex<()>,
}

pub struct ServerHandle {
    port: u16,
    url: String,
    running: Arc<AtomicBool>,
    server: Option<Arc<Server>>,
    dispatcher: Option<JoinHandle<()>>,
}
impl ServerHandle {
    pub fn url(&self) -> String { self.url.clone() }
    pub fn port(&self) -> u16 { self.port }
}
impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Some(server) = self.server.as_ref() { server.unblock(); }
        if let Some(thread) = self.dispatcher.take() { let _ = thread.join(); }
        drop(self.server.take());
        // tiny_http wakes its private accept thread asynchronously on Drop.
        // Wait briefly for it to release the port before a same-origin restart.
        let address = SocketAddr::from(([127, 0, 0, 1], self.port));
        for _ in 0..25 {
            if TcpStream::connect_timeout(&address, Duration::from_millis(10)).is_err() { break; }
            thread::sleep(Duration::from_millis(2));
        }
    }
}

/// Resolve a future log path without creating directories in a rejected game tree.
fn resolved_future_path(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() { path.to_path_buf() } else {
        std::env::current_dir().map_err(|e| e.to_string())?.join(path)
    };
    if absolute.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err("启动器输出路径不能包含父目录跳转。".into());
    }
    let mut existing = absolute.as_path();
    let mut suffix = Vec::new();
    while !existing.exists() {
        suffix.push(existing.file_name().ok_or("输出路径无效。")?.to_owned());
        existing = existing.parent().ok_or("输出路径无效。")?;
    }
    let mut resolved = existing.canonicalize().map_err(|e| e.to_string())?;
    for part in suffix.into_iter().rev() { resolved.push(part); }
    Ok(resolved)
}

pub(crate) fn private_lan_address(address: Ipv4Addr) -> bool {
    address.is_private() || address.is_link_local()
        || (address.octets()[0] == 100 && (64..128).contains(&address.octets()[1]))
}

fn bind_service(config: &ServerConfig, port: u16) -> Result<Server, String> {
    if let Some(lan) = config.lan.as_ref() {
        // tiny_http's PEM parser can panic on malformed private keys. The certificate
        // launcher validates first, but this boundary must still fail without a crash.
        std::panic::catch_unwind(|| Server::https((Ipv4Addr::UNSPECIFIED, port), SslConfig {
            certificate: lan.tls_certificate.clone(), private_key: lan.tls_private_key.clone(),
        })).map_err(|_| "HTTPS 证书或私钥格式无效。".to_owned())?
            .map_err(|error| format!("无法启动局域网 HTTPS 服务：{error}"))
    } else {
        Server::http((Ipv4Addr::LOCALHOST, port))
            .map_err(|error| format!("无法启动本机游戏服务：{error}"))
    }
}

pub fn start(
    resources: ResourceInfo,
    runtime_root: PathBuf,
    client: HashMap<String, &'static [u8]>,
    mut config: ServerConfig,
) -> Result<ServerHandle, String> {
    if let Some(lan) = config.lan.as_mut() {
        if !private_lan_address(lan.address) {
            return Err("共享资源服务只能选择本机的局域网 IPv4 地址。".into());
        }
        let bootstrap = url::Url::parse(&lan.bootstrap_origin)
            .map_err(|_| "证书安装引导地址无效。")?;
        if bootstrap.scheme() != "http" || bootstrap.host_str() != Some(&lan.address.to_string())
            || !bootstrap.username().is_empty() || bootstrap.password().is_some()
            || bootstrap.path() != "/" || bootstrap.query().is_some() || bootstrap.fragment().is_some()
            || bootstrap.port_or_known_default() == Some(0)
            || lan.bootstrap_origin != bootstrap.origin().ascii_serialization()
            || lan.ca_fingerprint.is_empty()
        {
            return Err("证书安装引导地址必须使用当前局域网 IP 和 HTTP 端口。".into());
        }
        if lan.tls_certificate.is_empty() || lan.tls_private_key.is_empty() {
            return Err("启动器缺少本机生成的 HTTPS 证书或对应私钥。".into());
        }
    }
    let runtime_root = runtime_root.canonicalize().map_err(|e| format!("启动器运行目录不存在：{e}"))?;
    if runtime_root.starts_with(&resources.root) {
        return Err("启动器运行目录不能位于游戏资源目录内。".into());
    }
    config.log_file = resolved_future_path(&config.log_file)?;
    if config.log_file.starts_with(&resources.root) {
        return Err("启动器诊断日志不能写入游戏资源目录。".into());
    }
    for (name, path) in &mut config.font_overrides {
        safe_relative(name)?;
        *path = path.canonicalize().map_err(|e| format!("字体缓存不可读：{e}"))?;
        if path.starts_with(&resources.root) || !path.is_file() {
            return Err("字体覆盖必须使用游戏目录之外的只读缓存。".into());
        }
    }
    if !client.contains_key("/index.html") { return Err("启动器缺少内嵌 client/index.html。".into()); }
    let listen = match config.preferred_port {
        // A shared URL must retain the requested public port. Local test instances
        // may still pick an unused origin when a previous port is occupied.
        Some(port) if port != 0 && config.lan.is_some() => bind_service(&config, port),
        Some(port) if port != 0 => bind_service(&config, port).or_else(|_| bind_service(&config, 0)),
        _ => bind_service(&config, 0),
    };
    let server = Arc::new(listen?);
    let port = server.server_addr().to_ip().ok_or("本机监听地址无效。")?.port();
    let url = match config.lan.as_ref() {
        Some(lan) => format!("https://{}:{port}/", lan.address),
        None => format!("http://127.0.0.1:{port}/"),
    };
    let running = Arc::new(AtomicBool::new(true));
    let state = Arc::new(State { resources, runtime_root, client, config, port, log_lock: Mutex::new(()) });
    let dispatcher_server = server.clone();
    let dispatcher_running = running.clone();
    let dispatcher = thread::Builder::new().name("game-http".into()).spawn(move || {
        let (sender, receiver) = mpsc::sync_channel::<Request>(64);
        let receiver = Arc::new(Mutex::new(receiver));
        let mut workers = Vec::new();
        for _ in 0..WORKERS {
            let receiver = receiver.clone();
            let state = state.clone();
            workers.push(thread::spawn(move || loop {
                let request = match receiver.lock() { Ok(lock) => lock.recv(), Err(_) => break };
                match request { Ok(request) => handle(request, &state), Err(_) => break }
            }));
        }
        while dispatcher_running.load(Ordering::Acquire) {
            match dispatcher_server.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(request)) => match sender.try_send(request) {
                    Ok(()) => {},
                    Err(mpsc::TrySendError::Full(request)) => reply_error(request, 503, "本机资源请求繁忙，请稍后重试。"),
                    Err(mpsc::TrySendError::Disconnected(_)) => break,
                },
                Ok(None) => {},
                Err(_) => break,
            }
        }
        drop(sender);
        for worker in workers { let _ = worker.join(); }
    }).map_err(|e| format!("无法启动本机服务线程：{e}"))?;
    Ok(ServerHandle { port, url, running, server: Some(server), dispatcher: Some(dispatcher) })
}

fn header(request: &Request, name: &'static str) -> Option<String> {
    request.headers().iter().find(|header| header.field.equiv(name)).map(|header| header.value.as_str().to_owned())
}
fn headers(content_type: &str) -> Vec<Header> {
    [
        ("Content-Type", content_type),
        ("Cross-Origin-Opener-Policy", "same-origin"),
        ("Cross-Origin-Embedder-Policy", "require-corp"),
        ("Cross-Origin-Resource-Policy", "same-origin"),
        ("Accept-Ranges", "bytes"),
        ("Cache-Control", "no-cache"),
        ("X-Content-Type-Options", "nosniff"),
    ].iter().map(|(key, value)| Header::from_bytes(key.as_bytes(), value.as_bytes()).unwrap()).collect()
}
fn extra_header(headers: &mut Vec<Header>, name: &str, value: &str) {
    if let Ok(header) = Header::from_bytes(name.as_bytes(), value.as_bytes()) { headers.push(header); }
}
fn reply(request: Request, code: u16, body: Vec<u8>, content_type: &str, extras: &[(&str, String)]) {
    let mut response_headers = headers(content_type);
    for (key, value) in extras { extra_header(&mut response_headers, key, value); }
    let size = body.len();
    let response = Response::new(StatusCode(code), response_headers, Cursor::new(body), Some(size), None);
    let _ = request.respond(response);
}
fn reply_error(request: Request, code: u16, message: &str) {
    reply(request, code, serde_json::to_vec(&json!({"error": message})).unwrap(), "application/json; charset=utf-8", &[]);
}

fn normalized_path(raw: &str) -> Result<String, String> {
    let mut path = raw.to_owned();
    for _ in 0..8 {
        let decoded = percent_decode_str(&path).decode_utf8().map_err(|_| "URL 路径编码无效。")?.into_owned();
        if decoded == path { break; }
        path = decoded;
    }
    if path.contains('\\') || path.contains('\0') || path.split('/').any(|part| part == "..") {
        return Err("资源路径不能越过已选择目录。".into());
    }
    let parts: Vec<_> = path.split('/').filter(|part| !part.is_empty() && *part != ".").collect();
    Ok(format!("/{}", parts.join("/")))
}

fn valid_request_context(
    remote_ip: Option<IpAddr>, secure: bool, host: &str, origin: Option<&str>,
    port: u16, lan: Option<&LanConfig>,
) -> bool {
    let allowed_hosts = match lan {
        Some(lan) => {
            if !secure || !remote_ip.map(|ip| match ip {
                IpAddr::V4(ip) => private_lan_address(ip) || ip.is_loopback(),
                IpAddr::V6(ip) => ip.is_loopback(),
            }).unwrap_or(false) { return false; }
            let mut hosts = vec![format!("{}:{port}", lan.address)];
            if port == 443 { hosts.push(lan.address.to_string()); }
            hosts
        },
        None => {
            if secure || !remote_ip.map(|ip| ip.is_loopback()).unwrap_or(false) { return false; }
            let mut hosts = vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")];
            if port == 80 { hosts.extend(["127.0.0.1".into(), "localhost".into()]); }
            hosts
        },
    };
    if !allowed_hosts.contains(&host.to_ascii_lowercase()) { return false; }
    let scheme = if lan.is_some() { "https" } else { "http" };
    origin.map(|origin| allowed_hosts.iter().any(|host| origin == format!("{scheme}://{host}")))
        .unwrap_or(true)
}

fn valid_origin(request: &Request, state: &State, readiness_probe: bool) -> bool {
    if request.headers().iter().filter(|header| header.field.equiv("Host")).count() != 1
        || request.headers().iter().filter(|header| header.field.equiv("Origin")).count() > 1 { return false; }
    let origin = header(request, "Origin");
    let trusted_probe = readiness_probe && state.config.lan.as_ref()
        .map(|lan| origin.as_deref().map(|origin|
            origin == lan.bootstrap_origin).unwrap_or(false)).unwrap_or(false);
    valid_request_context(request.remote_addr().map(|address| address.ip()), request.secure(),
        &header(request, "Host").unwrap_or_default(), if trusted_probe { None } else { origin.as_deref() },
        state.port, state.config.lan.as_ref())
}

fn handle(request: Request, state: &State) {
    let target = request.url().to_owned();
    let (raw_path, query) = target.split_once('?').unwrap_or((&target, ""));
    let path = match normalized_path(raw_path) { Ok(path) => path, Err(error) => return reply_error(request, 403, &error) };
    let readiness_probe = path == "/api/lan/ready";
    if !valid_origin(&request, state, readiness_probe) { return reply_error(request, 403, "仅允许当前游戏地址和局域网访问资源。 "); }
    if readiness_probe { return handle_ready(request, state); }
    match request.method() {
        Method::Post => return handle_post(request, &path, query, state),
        Method::Get | Method::Head => {},
        _ => return reply_error(request, 405, "此接口不支持该请求方法。"),
    }
    if path == "/multiplayer" {
        let mut params = vec![("online".to_owned(), "1".to_owned())];
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            if matches!(key.as_ref(), "name" | "server") && !params.iter().any(|(known, _)| known == &key) {
                params.push((key.into_owned(), value.into_owned()));
            }
        }
        let location = format!("/?{}", url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params).finish());
        return reply(request, 307, vec![], "text/plain", &[("Location", location)]);
    }
    if path == "/play" && (raw_path != "/play/" || !query.is_empty()) {
        return reply(request, 307, vec![], "text/plain", &[("Location", "/play/".into())]);
    }
    if path == "/api/local-config" {
        let body = json!({
            "multiplayer_server": state.config.multiplayer_server,
            "instance_name": state.config.instance_name,
            "game_path": "/play/", "mode": "sandbox", "map": "gta5", "debug": false,
            "resources_ready": true, "multiplayer_ready": state.config.online_ready,
            "resource_version": state.resources.manifest_version,
        });
        return reply(request, 200, serde_json::to_vec(&body).unwrap(), "application/json; charset=utf-8", &[]);
    }
    if path == "/api/remote-config" {
        let refresh = url::form_urlencoded::parse(query.as_bytes())
            .any(|(name, value)| name == "refresh" && value == "1");
        let body = if refresh {
            let value = serde_json::to_value(crate::remote_config::load()).unwrap_or_default();
            if let Ok(mut snapshot) = state.config.remote_configuration.write() { *snapshot = value.clone(); }
            value
        } else {
            state.config.remote_configuration.read().map(|value| value.clone())
                .unwrap_or_else(|_| json!({ "config": {}, "source": "unavailable", "stale": true }))
        };
        return reply(request, 200, serde_json::to_vec(&body).unwrap(), "application/json; charset=utf-8", &[]);
    }
    let client_path = if path == "/" || path == "/play" { "/index.html" } else { &path };
    if let Some(bytes) = state.client.get(client_path) {
        return serve_memory(request, bytes, mime_type(client_path));
    }
    if path.starts_with("/engine/") {
        let name = match path.as_str() {
            "/engine/offline/game.wasm" => "offline/game.wasm",
            "/engine/online/game.wasm" if state.config.online_ready => "online/game.wasm",
            _ => return reply_error(request, 404, "未找到启动器隔离引擎。"),
        };
        let file = match contained_file(&state.runtime_root, name) {
            Ok(file) if !file.starts_with(&state.resources.root) => file,
            _ => return reply_error(request, 403, "启动器引擎不能链接到游戏资源目录。"),
        };
        return serve_file(request, &file);
    }
    if path.to_ascii_lowercase().ends_with(".wasm") {
        return reply_error(request, 410, "游戏目录中的 WASM 入口已停用；请使用启动器 /engine/offline/game.wasm 或 /engine/online/game.wasm。");
    }
    let selected = if let Some(name) = path.strip_prefix("/data/") {
        data_file(state, name)
    } else if path.starts_with("/b/") {
        contained_file(&state.resources.root, path.trim_start_matches('/'))
    } else {
        return reply_error(request, 404, "未找到启动器页面或游戏资源。 ");
    };
    match selected {
        Ok(file) if file.extension().map(|value| value.eq_ignore_ascii_case("wasm")).unwrap_or(false) => reply_error(request, 410, "不能通过游戏资源链接读取 WASM。"),
        Ok(file) => serve_file(request, &file),
        Err(_) => reply_error(request, 404, "未找到游戏资源。"),
    }
}

fn handle_ready(request: Request, state: &State) {
    let Some(lan) = state.config.lan.as_ref() else {
        return reply_error(request, 404, "本机未启用局域网 HTTPS 共享。");
    };
    let preflight = request.method() == &Method::Options;
    if request.method() != &Method::Get && !preflight {
        return reply_error(request, 405, "证书就绪检测仅支持 GET。");
    }
    if preflight && (header(&request, "Access-Control-Request-Method").as_deref() != Some("GET")
        || header(&request, "Access-Control-Request-Headers").is_some()) {
        return reply_error(request, 403, "不允许此跨域检测请求。");
    }
    let origin = header(&request, "Origin");
    let private_network = header(&request, "Access-Control-Request-Private-Network").as_deref() == Some("true");
    let mut response_headers = headers("application/json; charset=utf-8");
    response_headers.retain(|value| !value.field.equiv("Cache-Control"));
    extra_header(&mut response_headers, "Cache-Control", "no-store");
    extra_header(&mut response_headers, "Vary", "Origin");
    if let Some(origin) = origin {
        extra_header(&mut response_headers, "Access-Control-Allow-Origin", &origin);
        if preflight {
            extra_header(&mut response_headers, "Access-Control-Allow-Methods", "GET");
            if private_network { extra_header(&mut response_headers, "Access-Control-Allow-Private-Network", "true"); }
        }
    }
    let body = if preflight { vec![] } else {
        serde_json::to_vec(&json!({"ready":true,"fingerprint":lan.ca_fingerprint})).unwrap()
    };
    let length = body.len();
    let response = Response::new(StatusCode(if preflight { 204 } else { 200 }), response_headers,
        Cursor::new(body), Some(length), None);
    let _ = request.respond(response);
}

fn data_file(state: &State, name: &str) -> Result<PathBuf, String> {
    safe_relative(name)?;
    let file = if let Some(file) = state.config.font_overrides.get(name) { file.clone() }
        else { contained_file(&state.resources.data_root, name)? };
    if file.extension().map(|value| value.eq_ignore_ascii_case("wasm")).unwrap_or(false) {
        return Err("不能通过游戏数据读取 WASM 引擎。".into());
    }
    Ok(file)
}

fn parse_range(value: Option<String>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let value = match value { Some(value) => value, None => return Ok(None) };
    let range = value.strip_prefix("bytes=").ok_or(())?;
    let (first, last) = range.split_once('-').ok_or(())?;
    if size == 0 || (first.is_empty() && last.is_empty()) || last.contains('-') { return Err(()); }
    if !first.bytes().all(|byte| byte.is_ascii_digit()) || !last.bytes().all(|byte| byte.is_ascii_digit()) { return Err(()); }
    let (start, end) = if first.is_empty() {
        let suffix = last.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 { return Err(()); }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = first.parse::<u64>().map_err(|_| ())?;
        let end = if last.is_empty() { size - 1 } else { last.parse::<u64>().map_err(|_| ())?.min(size - 1) };
        (start, end)
    };
    if start >= size || end < start { return Err(()); }
    Ok(Some((start, end)))
}

fn serve_memory(request: Request, bytes: &'static [u8], content_type: &str) {
    let size = bytes.len() as u64;
    match parse_range(header(&request, "Range"), size) {
        Err(_) => reply(request, 416, vec![], content_type, &[("Content-Range", format!("bytes */{size}"))]),
        Ok(range) => {
            let (start, end, code) = range.map(|(a, b)| (a, b + 1, 206)).unwrap_or((0, size, 200));
            let mut response_headers = headers(content_type);
            if code == 206 { extra_header(&mut response_headers, "Content-Range", &format!("bytes {}-{}/{size}", start, end - 1)); }
            let response = Response::new(StatusCode(code), response_headers, Cursor::new(&bytes[start as usize..end as usize]), Some((end - start) as usize), None);
            let _ = request.respond(response);
        }
    }
}
fn serve_file(request: Request, path: &Path) {
    let mut file = match File::open(path) { Ok(file) => file, Err(_) => return reply_error(request, 404, "无法打开游戏资源。") };
    let size = match file.metadata() { Ok(metadata) => metadata.len(), Err(_) => return reply_error(request, 404, "无法读取游戏资源。") };
    let range = match parse_range(header(&request, "Range"), size) {
        Ok(range) => range,
        Err(_) => return reply(request, 416, vec![], "application/octet-stream", &[("Content-Range", format!("bytes */{size}"))]),
    };
    let (start, count, code) = range.map(|(a, b)| (a, b - a + 1, 206)).unwrap_or((0, size, 200));
    if file.seek(SeekFrom::Start(start)).is_err() { return reply_error(request, 500, "无法定位资源读取范围。 "); }
    let mut response_headers = headers(mime_type(&path.to_string_lossy()));
    if code == 206 { extra_header(&mut response_headers, "Content-Range", &format!("bytes {}-{}/{size}", start, start + count - 1)); }
    let response = Response::new(StatusCode(code), response_headers, file.take(count), usize::try_from(count).ok(), None);
    let _ = request.respond(response);
}

fn read_body(request: &mut Request) -> Result<Vec<u8>, (u16, String)> {
    if request.body_length().map(|length| length > MAX_REQUEST_BYTES).unwrap_or(false) {
        return Err((413, "请求数据超过 1 MiB。".into()));
    }
    let mut body = Vec::new();
    request.as_reader().take(MAX_REQUEST_BYTES as u64 + 1).read_to_end(&mut body)
        .map_err(|error| (400, format!("请求内容无法读取：{error}")))?;
    if body.len() > MAX_REQUEST_BYTES { return Err((413, "请求数据超过 1 MiB。".into())); }
    Ok(body)
}

fn handle_post(mut request: Request, path: &str, query: &str, state: &State) {
    let result = post_result(&mut request, path, query, state);
    let (code, body, content_type, extras) = match result {
        Ok(value) => value,
        Err((code, error)) => (code, serde_json::to_vec(&json!({"error": error})).unwrap(), "application/json; charset=utf-8", vec![]),
    };
    let mut response_headers = headers(content_type);
    for (key, value) in extras { extra_header(&mut response_headers, key, &value); }
    let size = body.len();
    let response = Response::new(StatusCode(code), response_headers, Cursor::new(body), Some(size), None);
    let _ = request.respond(response);
}
type PostResult = Result<(u16, Vec<u8>, &'static str, Vec<(&'static str, String)>), (u16, String)>;
fn post_result(request: &mut Request, path: &str, query: &str, state: &State) -> PostResult {
    if !matches!(path, "/data/batch" | "/log") { return Err((404, "未找到本机接口。".into())); }
    let body = read_body(request)?;
    if path == "/log" {
        let _lock = state.log_lock.lock().map_err(|_| (500, "本机日志繁忙。".into()))?;
        let parent = state.config.log_file.parent().ok_or((500, "本机日志路径无效。".into()))?;
        fs::create_dir_all(parent).map_err(|e| (500, format!("无法创建本机日志目录：{e}")))?;
        let mut file = OpenOptions::new().create(true).append(true).open(&state.config.log_file)
            .map_err(|e| (500, format!("无法打开本机日志：{e}")))?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        writeln!(file, "[{stamp}] {}", String::from_utf8_lossy(&body)).map_err(|e| (500, format!("无法写入本机日志：{e}")))?;
        return Ok((204, vec![], "text/plain", vec![]));
    }
    let runs: Value = serde_json::from_slice(&body).map_err(|e| (400, format!("批量请求 JSON 无效：{e}")))?;
    let runs = runs.as_array().filter(|runs| runs.len() <= 1000).ok_or((400, "批量请求必须为最多 1000 项的数组。".into()))?;
    let mut selected = Vec::new();
    let mut total = 0u64;
    for run in runs {
        let row = run.as_array().filter(|row| row.len() == 3).ok_or((400, "批量请求中的文件范围格式无效。".into()))?;
        let name = row[0].as_str().ok_or((400, "文件路径格式无效。".into()))?;
        let start = row[1].as_u64().ok_or((400, "文件读取起点无效。".into()))?;
        let end = row[2].as_u64().filter(|end| *end >= start).ok_or((400, "文件读取终点无效。".into()))?;
        let file = data_file(state, name).map_err(|e| (400, e))?;
        let size = file.metadata().map_err(|e| (400, e.to_string()))?.len();
        let count = end.saturating_add(1).min(size).saturating_sub(start);
        total = total.checked_add(count).filter(|total| *total <= MAX_BATCH_BYTES).ok_or((400, "批量读取超过 64 MiB。".into()))?;
        selected.push((file, start, count));
    }
    let mut output = Vec::with_capacity(total as usize);
    let mut lengths = Vec::new();
    for (path, start, count) in selected {
        let mut file = File::open(path).map_err(|e| (400, e.to_string()))?;
        file.seek(SeekFrom::Start(start)).map_err(|e| (400, e.to_string()))?;
        let before = output.len();
        file.take(count).read_to_end(&mut output).map_err(|e| (400, e.to_string()))?;
        if (output.len() - before) as u64 != count { return Err((400, "资源在读取过程中发生变化，请重新选择稳定的游戏资源。".into())); }
        lengths.push(count.to_string());
    }
    let mut extras = vec![("X-Run-Lengths", lengths.join(","))];
    if url::form_urlencoded::parse(query.as_bytes()).any(|(key, value)| key == "gz" && value == "1") {
        let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
        gzip.write_all(&output).map_err(|e| (500, e.to_string()))?;
        output = gzip.finish().map_err(|e| (500, e.to_string()))?;
        extras.push(("Content-Encoding", "gzip".into()));
    }
    Ok((200, output, "application/octet-stream", extras))
}

fn mime_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8", "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8", "json" => "application/json; charset=utf-8",
        "wasm" => "application/wasm", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml", "webp" => "image/webp", "ico" => "image/x-icon",
        "woff2" => "font/woff2", "woff" => "font/woff", "mp3" => "audio/mpeg", "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;

    struct TestIdentity { certificate: Vec<u8>, private_key: Vec<u8>, root: rustls_pki_types::CertificateDer<'static> }
    // Generated disposable credentials. Nothing from the host's actual CA or game pack is used.
    fn test_identity() -> &'static TestIdentity {
        static IDENTITY: std::sync::OnceLock<TestIdentity> = std::sync::OnceLock::new();
        IDENTITY.get_or_init(|| {
            use rcgen::{CertificateParams, IsCa, BasicConstraints, KeyPair, KeyUsagePurpose, SanType, ExtendedKeyUsagePurpose};
            let root_key = KeyPair::generate().unwrap();
            let mut root_params = CertificateParams::new(Vec::<String>::new()).unwrap();
            root_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            root_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
            let root = root_params.self_signed(&root_key).unwrap();
            let key = KeyPair::generate().unwrap();
            let mut leaf_params = CertificateParams::new(Vec::<String>::new()).unwrap();
            leaf_params.subject_alt_names = vec![SanType::IpAddress(Ipv4Addr::new(192, 168, 1, 20).into())];
            leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
            leaf_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
            let leaf = leaf_params.signed_by(&key, &root, &root_key).unwrap();
            TestIdentity { certificate: format!("{}{}", leaf.pem(), root.pem()).into_bytes(),
                private_key: key.serialize_pem().into_bytes(), root: root.der().clone() }
        })
    }
    fn fixture() -> (tempfile::TempDir, ResourceInfo, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("game");
        let data = root.join("data");
        let runtime = temp.path().join("runtime");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(root.join("b/8b0b5899ed")).unwrap();
        fs::create_dir_all(runtime.join("offline")).unwrap();
        fs::create_dir_all(runtime.join("online")).unwrap();
        fs::write(root.join("index.html"), "untrusted game index").unwrap();
        fs::write(root.join("b/8b0b5899ed/game.wasm"), "original WASM must never be served").unwrap();
        fs::write(root.join("b/8b0b5899ed/game-multiplayer.wasm"), "stale WASM must never be served").unwrap();
        fs::write(root.join("b/8b0b5899ed/game.js"), "original engine JS").unwrap();
        fs::write(data.join("sample.bin"), b"0123456789").unwrap();
        fs::write(runtime.join("offline/game.wasm"), b"\0asm\x01\0\0\0OFFLINE").unwrap();
        fs::write(runtime.join("online/game.wasm"), b"\0asm\x01\0\0\0ONLINE").unwrap();
        let info = ResourceInfo {
            root: root.canonicalize().unwrap(), data_root: data.canonicalize().unwrap(),
            original_wasm: root.join("b/8b0b5899ed/game.wasm"), manifest_version: "test".into(),
            original_sha256: "test".into(), manifest_file_count: 1, sample_md5: None,
        };
        (temp, info, runtime)
    }
    fn request(server: &ServerHandle, method: &str, path: &str, extra: &str, body: &[u8]) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n", server.port(), body.len()).unwrap();
        stream.write_all(body).unwrap();
        let mut output = Vec::new(); stream.read_to_end(&mut output).unwrap();
        let split = output.windows(4).position(|value| value == b"\r\n\r\n").unwrap();
        (String::from_utf8(output[..split].to_vec()).unwrap(), output[split + 4..].to_vec())
    }
    fn client() -> HashMap<String, &'static [u8]> {
        HashMap::from([("/index.html".into(), b"trusted client index" as &'static [u8]), ("/b/8b0b5899ed/loader.js".into(), b"trusted loader" as &'static [u8])])
    }
    fn lan_config() -> LanConfig {
        let identity = test_identity();
        LanConfig { address: Ipv4Addr::new(192, 168, 1, 20), bootstrap_origin: "http://192.168.1.20:8442".into(),
            ca_fingerprint: "AA:BB:CC".into(), tls_certificate: identity.certificate.clone(),
            tls_private_key: identity.private_key.clone() }
    }
    fn tls_request(server: &ServerHandle, method: &str, path: &str, extra: &str, body: &[u8], trust: bool)
        -> Result<(String, Vec<u8>), String>
    {
        let mut roots = rustls::RootCertStore::empty();
        if trust { roots.add(test_identity().root.clone()).unwrap(); }
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth();
        let name = rustls_pki_types::ServerName::IpAddress(Ipv4Addr::new(192, 168, 1, 20).into());
        let connection = rustls::ClientConnection::new(Arc::new(config), name).map_err(|error| error.to_string())?;
        let tcp = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).map_err(|error| error.to_string())?;
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        tcp.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut stream = rustls::StreamOwned::new(connection, tcp);
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: 192.168.1.20:{}\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n", server.port(), body.len()).map_err(|error| error.to_string())?;
        stream.write_all(body).map_err(|error| error.to_string())?;
        let mut output = vec![];
        if let Err(error) = stream.read_to_end(&mut output) {
            if error.kind() != std::io::ErrorKind::UnexpectedEof || output.is_empty() { return Err(error.to_string()); }
        }
        let split = output.windows(4).position(|chunk| chunk == b"\r\n\r\n").ok_or("No HTTP response")?;
        Ok((String::from_utf8(output[..split].to_vec()).unwrap(), output[split + 4..].to_vec()))
    }
    #[test]
    fn lan_requests_require_private_peers_https_and_exact_ip_origin() {
        let lan = lan_config();
        let peer = Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 30)));
        assert!(valid_request_context(peer, true, "192.168.1.20:9443", Some("https://192.168.1.20:9443"), 9443, Some(&lan)));
        assert!(valid_request_context(peer, true, "192.168.1.20:443", Some("https://192.168.1.20"), 443, Some(&lan)));
        assert!(valid_request_context(peer, true, "192.168.1.20", None, 443, Some(&lan)));
        assert!(valid_request_context(Some("100.64.1.2".parse().unwrap()), true,
            "192.168.1.20:9443", None, 9443, Some(&lan)));
        for origin in ["http://192.168.1.20:9443", "https://evil.invalid:9443", "null", "http://192.168.1.20:8442"] {
            assert!(!valid_request_context(peer, true, "192.168.1.20:9443", Some(origin), 9443, Some(&lan)));
        }
        for host in ["other.invalid:9443", "127.0.0.1:9443", "192.168.1.20:9444"] {
            assert!(!valid_request_context(peer, true, host, None, 9443, Some(&lan)));
        }
        assert!(!valid_request_context(peer, false, "192.168.1.20:9443", None, 9443, Some(&lan)));
        assert!(!valid_request_context(None, true, "192.168.1.20:9443", None, 9443, Some(&lan)));
        assert!(!valid_request_context(Some("8.8.8.8".parse().unwrap()), true, "192.168.1.20:9443", None, 9443, Some(&lan)));
        assert!(!valid_request_context(Some("100.128.1.2".parse().unwrap()), true, "192.168.1.20:9443", None, 9443, Some(&lan)));
        assert!(!valid_request_context(peer, false, "127.0.0.1:9443", None, 9443, None));
    }
    #[test]
    fn invalid_lan_settings_and_private_keys_do_not_start_a_listener() {
        let (temp, info, runtime) = fixture();
        let config = ServerConfig { lan: Some(lan_config()), log_file: temp.path().join("log.txt"), ..Default::default() };
        let mut invalid = config.clone(); invalid.lan.as_mut().unwrap().address = Ipv4Addr::new(8, 8, 8, 8);
        assert!(start(info.clone(), runtime.clone(), client(), invalid).is_err());
        for origin in ["https://192.168.1.20:8442", "http://192.168.1.21:8442", "http://192.168.1.20:8442/path", "http://192.168.1.20:8442/", "http://user@192.168.1.20:8442"] {
            let mut invalid = config.clone(); invalid.lan.as_mut().unwrap().bootstrap_origin = origin.into();
            assert!(start(info.clone(), runtime.clone(), client(), invalid).is_err(), "{origin}");
        }
        let mut invalid = config; invalid.lan.as_mut().unwrap().tls_private_key = b"not a private key".to_vec();
        assert!(start(info, runtime, client(), invalid).is_err());
        let debug = format!("{:?}", lan_config());
        assert!(!debug.contains("BEGIN PRIVATE KEY"));
        assert!(!debug.contains("BEGIN CERTIFICATE"));
    }
    #[test]
    fn actual_ip_https_requires_its_ca_and_preserves_resource_isolation_ranges_batch_and_restart() {
        let (temp, info, runtime) = fixture();
        let config = ServerConfig { lan: Some(lan_config()), online_ready: true,
            log_file: temp.path().join("log.txt"), ..Default::default() };
        let local = start(info.clone(), runtime.clone(), client(), ServerConfig {
            log_file: temp.path().join("local-log.txt"), ..Default::default()
        }).unwrap();
        let server = start(info.clone(), runtime.clone(), client(), config.clone()).unwrap();
        assert_eq!(server.url(), format!("https://192.168.1.20:{}/", server.port()));
        assert_ne!(server.port(), local.port());
        assert_eq!(request(&local, "GET", "/", "", b"").1, b"trusted client index");
        assert!(tls_request(&server, "GET", "/", "", b"", false).is_err(), "untrusted CA must fail the real TLS handshake");
        let (headers, body) = tls_request(&server, "GET", "/", "", b"", true).unwrap();
        assert!(headers.starts_with("HTTP/1.1 200"));
        for header in ["cross-origin-embedder-policy: require-corp", "cross-origin-opener-policy: same-origin", "cross-origin-resource-policy: same-origin"] {
            assert!(headers.to_ascii_lowercase().contains(header));
        }
        assert_eq!(body, b"trusted client index");
        let (headers, body) = tls_request(&server, "GET", "/data/sample.bin", "Range: bytes=3-5\r\n", b"", true).unwrap();
        assert!(headers.starts_with("HTTP/1.1 206")); assert_eq!(body, b"345");
        let origin = format!("Origin: https://192.168.1.20:{}\r\n", server.port());
        let (headers, body) = tls_request(&server, "POST", "/data/batch", &origin, br#"[["sample.bin",1,3],["sample.bin",8,20]]"#, true).unwrap();
        assert!(headers.starts_with("HTTP/1.1 200")); assert!(headers.to_ascii_lowercase().contains("x-run-lengths: 3,2"));
        assert_eq!(body, b"12389");
        let (headers, body) = tls_request(&server, "HEAD", "/data/sample.bin", "", b"", true).unwrap();
        assert!(headers.starts_with("HTTP/1.1 200")); assert!(headers.to_ascii_lowercase().contains("content-length: 10"));
        assert!(body.is_empty());
        let (headers, _) = tls_request(&server, "GET", "/data/sample.bin", "Range: bytes=40-\r\n", b"", true).unwrap();
        assert!(headers.starts_with("HTTP/1.1 416")); assert!(headers.to_ascii_lowercase().contains("content-range: bytes */10"));
        assert!(tls_request(&server, "POST", "/data/batch", "", br#"[["../index.html",0,1]]"#, true).unwrap().0.starts_with("HTTP/1.1 400"));
        let (headers, body) = tls_request(&server, "GET", "/engine/online/game.wasm", "", b"", true).unwrap();
        assert!(headers.starts_with("HTTP/1.1 200")); assert!(body.starts_with(b"\0asm"));
        for path in ["/b/8b0b5899ed/game.wasm", "/b/8b0b5899ed/game-multiplayer.wasm"] {
            assert!(tls_request(&server, "GET", path, "", b"", true).unwrap().0.starts_with("HTTP/1.1 410"));
        }
        assert!(tls_request(&server, "GET", "/data/%252e%252e/index.html", "", b"", true).unwrap().0.starts_with("HTTP/1.1 403"));
        assert!(tls_request(&server, "GET", "/", "Origin: https://evil.invalid\r\n", b"", true).unwrap().0.starts_with("HTTP/1.1 403"));
        let preferred_port = Some(server.port()); drop(server);
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, preferred_port.unwrap())).is_err());
        let restarted = start(info, runtime, client(), ServerConfig { preferred_port, ..config }).unwrap();
        assert_eq!(Some(restarted.port()), preferred_port);
        assert!(tls_request(&restarted, "GET", "/", "", b"", true).unwrap().0.starts_with("HTTP/1.1 200"));
    }
    #[test]
    fn only_readiness_endpoint_allows_exact_http_guide_origin() {
        let (temp, info, runtime) = fixture();
        let server = start(info, runtime, client(), ServerConfig { lan: Some(lan_config()),
            log_file: temp.path().join("log.txt"), ..Default::default() }).unwrap();
        let origin = "Origin: http://192.168.1.20:8442\r\n";
        let (headers, body) = tls_request(&server, "GET", "/api/lan/ready", origin, b"", true).unwrap();
        assert!(headers.starts_with("HTTP/1.1 200"));
        let headers = headers.to_ascii_lowercase();
        assert!(headers.contains("access-control-allow-origin: http://192.168.1.20:8442"));
        assert!(headers.contains("cache-control: no-store")); assert!(!headers.contains("cache-control: no-cache"));
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body, json!({"ready":true,"fingerprint":"AA:BB:CC"}));
        for path in ["/", "/data/sample.bin", "/engine/offline/game.wasm", "/api/local-config", "/api/remote-config"] {
            assert!(tls_request(&server, "GET", path, origin, b"", true).unwrap().0.starts_with("HTTP/1.1 403"), "{path}");
        }
        for path in ["/data/batch", "/log"] {
            assert!(tls_request(&server, "POST", path, origin, b"[]", true).unwrap().0.starts_with("HTTP/1.1 403"), "{path}");
        }
        for extra in ["Origin: http://192.168.1.20:8441\r\n", "Origin: http://evil.invalid\r\n", "Origin: null\r\n", "Origin: http://192.168.1.20:8442\r\nOrigin: http://192.168.1.20:8442\r\n"] {
            assert!(tls_request(&server, "GET", "/api/lan/ready", extra, b"", true).unwrap().0.starts_with("HTTP/1.1 403"));
        }
        assert!(tls_request(&server, "GET", "/api/lan/ready", "", b"", true).unwrap().0.starts_with("HTTP/1.1 200"));
        let same_origin = format!("Origin: https://192.168.1.20:{}\r\n", server.port());
        assert!(tls_request(&server, "GET", "/api/lan/ready", &same_origin, b"", true).unwrap().0.starts_with("HTTP/1.1 200"));
        assert!(tls_request(&server, "POST", "/api/lan/ready", origin, b"", true).unwrap().0.starts_with("HTTP/1.1 405"));
        let preflight = format!("{origin}Access-Control-Request-Method: GET\r\nAccess-Control-Request-Private-Network: true\r\n");
        let (headers, body) = tls_request(&server, "OPTIONS", "/api/lan/ready", &preflight, b"", true).unwrap();
        assert!(headers.starts_with("HTTP/1.1 204")); assert!(body.is_empty());
        assert!(headers.to_ascii_lowercase().contains("access-control-allow-private-network: true"));
    }
    #[test]
    fn launcher_origins_no_longer_receive_a_tls_probe_exception() {
        let (temp, info, runtime) = fixture();
        let server = start(info, runtime, client(), ServerConfig { lan: Some(lan_config()),
            log_file: temp.path().join("log.txt"), ..Default::default() }).unwrap();
        for origin in ["tauri://localhost", "https://tauri.localhost", "http://tauri.localhost",
            "http://localhost:1420", "http://127.0.0.1:1420"] {
            let extra = format!("Origin: {origin}\r\n");
            for path in ["/api/lan/ready", "/data/sample.bin"] {
                let (headers, _) = tls_request(&server, "GET", path, &extra, b"", true).unwrap();
                assert!(headers.starts_with("HTTP/1.1 403"), "{origin} {path}");
                assert!(!headers.to_ascii_lowercase().contains("access-control-allow-origin:"));
            }
        }
    }
    #[test]
    fn a_busy_lan_port_is_reported_instead_of_silently_changing_the_shared_url() {
        let (temp, info, runtime) = fixture();
        let config = ServerConfig { lan: Some(lan_config()),
            log_file: temp.path().join("log.txt"), ..Default::default() };
        let first = start(info.clone(), runtime.clone(), client(), config.clone()).unwrap();
        let result = start(info, runtime, client(), ServerConfig { preferred_port: Some(first.port()), ..config });
        assert!(result.is_err());
        assert!(tls_request(&first, "GET", "/", "", b"", true).unwrap().0.starts_with("HTTP/1.1 200"));
    }
    #[test]
    fn ranges_cover_suffix_clipping_and_invalid_reads() {
        assert_eq!(parse_range(Some("bytes=2-6".into()), 10), Ok(Some((2, 6))));
        assert_eq!(parse_range(Some("bytes=-3".into()), 10), Ok(Some((7, 9))));
        assert_eq!(parse_range(Some("bytes=8-90".into()), 10), Ok(Some((8, 9))));
        for value in ["bytes=10-", "bytes=9-2", "bytes=-0", "bytes=0-1,3-4", "bytes=-", "bytes=--1"] {
            assert!(parse_range(Some(value.into()), 10).is_err(), "{value}");
        }
        assert!(parse_range(Some("bytes=0-".into()), 0).is_err());
    }
    #[test]
    fn paths_decode_before_validation() {
        assert!(normalized_path("/data/%252e%252e/secret").is_err());
        assert!(normalized_path("/data/%5csecret").is_err());
        assert_eq!(normalized_path("//b//file.js").unwrap(), "/b/file.js");
    }
    #[test]
    fn actual_http_serves_embedded_client_and_isolated_engines_only() {
        let (temp, info, runtime) = fixture();
        let config = ServerConfig { online_ready: true, log_file: temp.path().join("logs/browser.log"), ..Default::default() };
        let server = start(info, runtime, client(), config).unwrap();
        let (headers, body) = request(&server, "GET", "/", "", b"");
        assert!(headers.starts_with("HTTP/1.1 200"));
        assert!(headers.to_lowercase().contains("cross-origin-embedder-policy: require-corp"));
        assert_eq!(body, b"trusted client index");
        for path in ["/play/", "/index.html"] { assert_eq!(request(&server, "GET", path, "", b"").1, b"trusted client index"); }
        assert_eq!(request(&server, "GET", "/b/8b0b5899ed/loader.js", "", b"").1, b"trusted loader");
        for path in ["/b/8b0b5899ed/game.wasm", "/b/8b0b5899ed/game-multiplayer.wasm", "/game.wasm", "/b/8b0b5899ed/%2567ame.wasm"] {
            assert!(request(&server, "GET", path, "", b"").0.starts_with("HTTP/1.1 410"), "{path}");
        }
        assert_eq!(request(&server, "GET", "/engine/online/game.wasm", "Range: bytes=0-7\r\n", b"").1, b"\0asm\x01\0\0\0");
        let (headers, body) = request(&server, "HEAD", "/data/sample.bin", "", b"");
        assert!(headers.to_lowercase().contains("content-length: 10"));
        assert!(body.is_empty());
        let (headers, body) = request(&server, "GET", "/data/sample.bin", "Range: bytes=3-5\r\n", b"");
        assert!(headers.starts_with("HTTP/1.1 206")); assert_eq!(body, b"345");
        let (headers, _) = request(&server, "GET", "/data/sample.bin", "Range: bytes=40-\r\n", b"");
        assert!(headers.starts_with("HTTP/1.1 416")); assert!(headers.to_lowercase().contains("content-range: bytes */10"));
        assert!(request(&server, "GET", "/data/%252e%252e/index.html", "", b"").0.starts_with("HTTP/1.1 403"));
        let (headers, _) = request(&server, "GET", "/play/?debug=1", "", b"");
        assert!(headers.starts_with("HTTP/1.1 307")); assert!(headers.to_lowercase().contains("location: /play/"));
        let (headers, _) = request(&server, "GET", "/multiplayer/?name=test&server=example%3A1234&debug=1", "", b"");
        assert!(headers.to_lowercase().contains("location: /?online=1&name=test&server=example%3a1234"));
        let body = request(&server, "GET", "/api/local-config", "", b"").1;
        let config: Value = serde_json::from_slice(&body).unwrap(); assert_eq!(config["debug"], false); assert_eq!(config["map"], "gta5");
        let body = request(&server, "GET", "/api/remote-config", "", b"").1;
        let remote: Value = serde_json::from_slice(&body).unwrap(); assert!(remote["config"]["oltitle"].is_null());
        assert_eq!(remote["source"], "unavailable");
        let port = server.port(); drop(server);
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err(), "dropping launcher must stop its HTTP listener");
    }
    #[test]
    fn actual_batch_matches_lengths_and_gzip_and_logs_stay_external() {
        let (temp, info, runtime) = fixture();
        let log = temp.path().join("logs/browser.log");
        let server = start(info.clone(), runtime.clone(), client(), ServerConfig { log_file: log.clone(), ..Default::default() }).unwrap();
        let input = br#"[["sample.bin",1,3],["sample.bin",8,20]]"#;
        let (headers, body) = request(&server, "POST", "/data/batch", "", input);
        assert!(headers.starts_with("HTTP/1.1 200")); assert!(headers.to_lowercase().contains("x-run-lengths: 3,2")); assert_eq!(body, b"12389");
        let (headers, body) = request(&server, "POST", "/data/batch?gz=1", "", input);
        assert!(headers.to_lowercase().contains("content-encoding: gzip"));
        let mut decoder = flate2::read::GzDecoder::new(&body[..]); let mut decoded = Vec::new(); decoder.read_to_end(&mut decoded).unwrap(); assert_eq!(decoded, b"12389");
        assert!(request(&server, "POST", "/data/batch", "", br#"[["../index.html",0,1]]"#).0.starts_with("HTTP/1.1 400"));
        assert!(request(&server, "POST", "/log", "", b"test log").0.starts_with("HTTP/1.1 204"));
        assert!(fs::read_to_string(log).unwrap().contains("test log"));
        assert!(request(&server, "POST", "/log", "Origin: http://evil.invalid\r\n", b"evil log").0.starts_with("HTTP/1.1 403"));
        assert!(start(info.clone(), runtime, client(), ServerConfig { log_file: info.root.join("new/log.txt"), ..Default::default() }).is_err());
        assert!(!info.root.join("new").exists());
    }
    #[test]
    fn saved_origin_port_is_reused_and_busy_port_falls_back() {
        fn assert_send<T: Send>() {} assert_send::<ServerHandle>();
        let (temp, info, runtime) = fixture();
        let config = ServerConfig { log_file: temp.path().join("log.txt"), ..Default::default() };
        let first = start(info.clone(), runtime.clone(), client(), config.clone()).unwrap();
        let preferred_port = Some(first.port());
        let busy = start(info.clone(), runtime.clone(), client(), ServerConfig { preferred_port, ..config.clone() }).unwrap();
        assert_ne!(busy.port(), first.port());
        drop(first);
        let restarted = start(info, runtime, client(), ServerConfig { preferred_port, ..config }).unwrap();
        assert_eq!(Some(restarted.port()), preferred_port);
    }
    #[test]
    fn updated_remote_metadata_reaches_running_game_without_restart() {
        let (temp, info, runtime) = fixture();
        let remote = Arc::new(RwLock::new(json!({"config":{"oltitle":"https://gtav.2t.hk"},"source":"remote","stale":false})));
        let server = start(info, runtime, client(), ServerConfig { remote_configuration: remote.clone(),
            log_file: temp.path().join("log.txt"), ..Default::default() }).unwrap();
        *remote.write().unwrap() = json!({"config":{"oltitle":"维护公告"},"source":"remote","stale":false});
        let body = request(&server, "GET", "/api/remote-config", "", b"").1;
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["config"]["oltitle"], "维护公告");
    }
}
