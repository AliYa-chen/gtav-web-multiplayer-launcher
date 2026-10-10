//! A bounded, HTTPS-only source of display text and release metadata.
//! This module never executes remote content or edits the user's game resources.

use reqwest::{blocking::Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, BTreeSet}, io::Read,
    time::{Duration, SystemTime, UNIX_EPOCH}};
use url::Url;

pub const CONFIG_URL: &str = "https://oss.2t.hk/gtav/";
pub const MAX_CONFIG_BYTES: usize = 256 * 1024;
const MAX_SERVERS: usize = 32;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Announcement {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DownloadInfo {
    pub url: String,
    /// Mandatory SHA-256 of the exact file served by `url`.
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerInfo {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub i18n: BTreeMap<String, ServerTranslation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub address: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_url: Option<String>,
    /// An HTTPS health endpoint can also describe a TLS reverse-proxy prefix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_url: Option<String>,
    /// Exact transport endpoint. Keep its scheme, path and query when joining.
    #[serde(default, alias = "ws_url", skip_serializing_if = "Option::is_none")]
    pub websocket_url: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerTranslation {
    #[serde(default)] pub name: String,
    #[serde(default)] pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub region: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigTranslation {
    #[serde(default)] pub oltitle: String,
    #[serde(default)] pub release_notes: String,
    #[serde(default)] pub announcements: Vec<Announcement>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteConfig {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub i18n: BTreeMap<String, ConfigTranslation>,
    pub oltitle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<ServerInfo>,
    /// Complete normalized list. `server` is its main line, or first entry.
    #[serde(default)]
    pub servers: Vec<ServerInfo>,
    #[serde(default)]
    pub announcements: Vec<Announcement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(default)]
    pub downloads: BTreeMap<String, DownloadInfo>,
    #[serde(default)]
    pub release_notes: String,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self { i18n: BTreeMap::new(), oltitle: String::new(), website: None,
            server: None, servers: Vec::new(), announcements: Vec::new(), latest_version: None,
            downloads: BTreeMap::new(), release_notes: String::new() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSource { Remote, Unavailable }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfigSnapshot {
    pub config: RemoteConfig,
    pub source: ConfigSource,
    pub stale: bool,
    /// UTC Unix seconds of this successful fetch; absent until success or on failure.
    pub fetched_at: Option<u64>,
    pub checked_at: u64,
    pub error: Option<String>,
    /// Never present in release builds; identifies the explicit local debug fixture.
    #[cfg(debug_assertions)]
    #[serde(default)]
    pub debug_local: bool,
}

impl Default for ConfigSnapshot {
    fn default() -> Self {
        Self { config: RemoteConfig::default(), source: ConfigSource::Unavailable, stale: true,
            fetched_at: None, checked_at: now(), error: None,
            #[cfg(debug_assertions)] debug_local: false }
    }
}

#[derive(Default, Deserialize)]
struct RawUpdate {
    #[serde(default, alias = "latestversion", alias = "version")]
    latest_version: Option<String>,
    #[serde(default)]
    downloads: BTreeMap<String, DownloadInfo>,
    #[serde(default, alias = "notes")]
    release_notes: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawServer {
    One(ServerInfo),
    Many(Vec<ServerInfo>),
}

#[derive(Default, Deserialize)]
struct RawConfig {
    #[serde(default)] i18n: BTreeMap<String, ConfigTranslation>,
    #[serde(default)]
    oltitle: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    server: Option<RawServer>,
    #[serde(default)]
    servers: Option<Vec<ServerInfo>>,
    #[serde(default)]
    announcements: Vec<Announcement>,
    #[serde(default, alias = "latestversion")]
    latest_version: Option<String>,
    #[serde(default)]
    downloads: BTreeMap<String, DownloadInfo>,
    #[serde(default, alias = "notes")]
    release_notes: String,
    #[serde(default)]
    update: Option<RawUpdate>,
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

fn text(value: &str, max: usize, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.chars().count() > max || value.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(format!("远程配置中的 {field} 太长或包含无效字符。"));
    }
    Ok(value.to_owned())
}

/// Used for display links and download URLs; credentials and non-HTTPS schemes are rejected.
pub fn https_url(value: &str) -> Result<String, String> {
    if value.len() > 2048 || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("远程配置链接无效。".into());
    }
    let url = Url::parse(value).map_err(|_| "远程配置链接格式无效。".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("远程配置链接必须是无用户名密码的 HTTPS 地址。".into());
    }
    Ok(url.into())
}

/// WebSocket metadata is an endpoint, rather than a display link. Fragments,
/// credentials and browser-normalized backslashes cannot form valid requests.
pub fn websocket_url(value: &str) -> Result<String, String> {
    if value.len() > 2048 || value.contains('\\') ||
        value.chars().any(|c| c.is_control() || c.is_whitespace()) ||
        !value.contains("://") {
        return Err("远程 WebSocket 地址无效。".into());
    }
    let url = Url::parse(value).map_err(|_| "远程 WebSocket 地址格式无效。".to_string())?;
    if !matches!(url.scheme(), "ws" | "wss") || url.host_str().is_none() ||
        url.port() == Some(0) || !url.username().is_empty() || url.password().is_some() ||
        url.fragment().is_some() {
        return Err("远程 WebSocket 地址必须是无用户名密码及片段的 WS 或 WSS 地址。".into());
    }
    Ok(url.into())
}

fn health_url(value: &str) -> Result<String, String> {
    if value.contains('\\') { return Err("远程健康检查地址无效。".into()); }
    #[cfg(debug_assertions)]
    if std::env::var_os("GTA_DEV_CONFIG_PATH").is_some() {
        let url = Url::parse(value).map_err(|_| "本机开发健康检查地址无效。".to_string())?;
        if url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            && value.len() <= 2048 && !value.chars().any(|c| c.is_control() || c.is_whitespace())
            && url.username().is_empty() && url.password().is_none() && url.fragment().is_none() && url.port() != Some(0) {
            return Ok(url.into());
        }
    }
    let value = https_url(value)?;
    let url = Url::parse(&value).map_err(|_| "远程健康检查地址无效。".to_string())?;
    if url.port() == Some(0) || url.fragment().is_some() {
        return Err("远程健康检查地址不能包含无效端口或片段。".into());
    }
    Ok(value)
}

fn clean_title(value: &str) -> Result<String, String> {
    let value = text(value, 160, "oltitle")?;
    if value.contains(['<', '>']) || value.contains(['\n', '\t']) {
        return Err("远程配置中的 oltitle 必须是单行文字或 HTTPS 地址。".into());
    }
    // A URL-like title cannot be used to smuggle an executable or insecure link.
    if Url::parse(&value).is_ok() { https_url(&value)?; }
    Ok(value)
}

fn clean_server(mut server: ServerInfo) -> Result<ServerInfo, String> {
    if server.i18n.len()>2 { return Err("Too many server translations.".into()); }
    for (locale, value) in &mut server.i18n {
        if !matches!(locale.as_str(),"zh-CN"|"en") { return Err("Unsupported translation language.".into()); }
        value.name=text(&value.name,80,"server.i18n.name")?;
        value.role=text(&value.role,80,"server.i18n.role")?;
        value.region=value.region.as_deref().map(|region|text(region,64,"server.i18n.region")).transpose()?;
    }
    server.id = server.id.as_deref().map(|value| -> Result<String, String> {
        let value = text(value, 64, "server.id")?;
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            return Err("远程服务器 ID 只能包含字母、数字、下划线或连字符。".into());
        }
        Ok(value)
    }).transpose()?;
    server.address = text(&server.address, 2048, "server.address")?;
    if server.address.contains("://") {
        server.address = websocket_url(&server.address)?;
    } else {
        if server.address.len() > 256 || server.address.is_empty() ||
            server.address.contains(['/', '\\', '@', '?', '#']) ||
            server.address.chars().any(char::is_whitespace) {
            return Err("远程服务器地址必须是 IP、域名或完整的 WS / WSS 地址。".into());
        }
        let url = Url::parse(&format!("ws://{}", server.address)).map_err(|_| "远程服务器地址格式无效。".to_string())?;
        if url.host_str().is_none() || url.port() == Some(0) || !url.username().is_empty() || url.password().is_some() {
            return Err("远程服务器地址格式无效。".into());
        }
    }
    server.name = text(&server.name, 80, "server.name")?;
    server.role = server.role.as_deref().map(|value| text(value, 80, "server.role")).transpose()?;
    server.region = server.region.as_deref().map(|value| text(value, 64, "server.region")).transpose()?;
    server.status_url = server.status_url.as_deref().map(https_url).transpose()?;
    server.health_url = server.health_url.as_deref().map(health_url).transpose()?;
    server.websocket_url = server.websocket_url.as_deref().map(websocket_url).transpose()?;
    Ok(server)
}

fn resolve_server_endpoint(server: &mut ServerInfo) {
    if server.websocket_url.is_some() { return; }
    if server.address.starts_with("ws://") || server.address.starts_with("wss://") {
        server.websocket_url = Some(server.address.clone());
        return;
    }
    // Only the same server's HTTPS health endpoint can imply TLS and a proxy
    // prefix. The website/status page is not evidence of a game transport.
    let Some(health) = server.health_url.as_ref() else { return; };
    let Ok(mut health) = Url::parse(health) else { return; };
    let Ok(address) = Url::parse(&format!("wss://{}", server.address)) else { return; };
    if address.host_str() != health.host_str() ||
        address.port_or_known_default() != health.port_or_known_default() { return; }
    let Some(prefix) = health.path().trim_end_matches('/').strip_suffix("/health") else { return; };
    let path = format!("{prefix}/ws");
    if health.set_scheme("wss").is_err() { return; }
    health.set_path(&path);
    server.websocket_url = Some(health.into());
}

fn clean_servers(servers: Vec<ServerInfo>) -> Result<Vec<ServerInfo>, String> {
    if servers.len() > MAX_SERVERS { return Err("远程服务器线路超过 32 条限制。".into()); }
    let servers = servers.into_iter().map(clean_server).collect::<Result<Vec<_>, _>>()?;
    let mut ids = BTreeSet::new();
    for server in &servers {
        if let Some(id) = &server.id {
            if !ids.insert(id) { return Err("远程服务器线路 ID 不能重复。".into()); }
        }
    }
    Ok(servers)
}

fn primary_server(servers: &[ServerInfo]) -> Option<&ServerInfo> {
    servers.iter().find(|server| server.id.as_deref() == Some("main")).or_else(|| servers.first())
}

fn merge_server_field(target: &mut Option<String>, legacy: Option<String>, field: &str) -> Result<(), String> {
    let existing = target.as_deref().filter(|value| !value.is_empty());
    let declared = legacy.as_deref().filter(|value| !value.is_empty());
    if let (Some(existing), Some(declared)) = (existing, declared) {
        if existing != declared { return Err(format!("远程配置的 server 与 servers 主线路 {field} 不一致。")); }
    }
    if existing.is_none() && declared.is_some() { *target = legacy; }
    Ok(())
}

fn normalize_servers(server: Option<RawServer>, servers: Option<Vec<ServerInfo>>)
    -> Result<(Option<ServerInfo>, Vec<ServerInfo>), String> {
    // Both names are accepted, but a document cannot silently override one line list
    // with another. Our normalized output includes the selected object plus the list.
    let mut list = match (server, servers) {
        (None, None) => Vec::new(),
        (Some(RawServer::One(server)), None) => clean_servers(vec![server])?,
        (Some(RawServer::Many(list)), None) | (None, Some(list)) => clean_servers(list)?,
        (Some(RawServer::One(server)), Some(list)) => {
            let server = clean_server(server)?;
            let mut list = clean_servers(list)?;
            let index = list.iter().position(|entry| entry.id.as_deref() == Some("main"))
                .or_else(|| (!list.is_empty()).then_some(0))
                .ok_or("远程配置的 server 与 servers 主线路不一致。")?;
            let primary = &mut list[index];
            if primary.address != server.address {
                return Err("远程配置的 server 与 servers 主线路不一致。".into());
            }
            merge_server_field(&mut primary.id, server.id, "ID")?;
            merge_server_field(&mut primary.role, server.role, "角色")?;
            merge_server_field(&mut primary.region, server.region, "地区")?;
            merge_server_field(&mut primary.status_url, server.status_url, "状态地址")?;
            merge_server_field(&mut primary.health_url, server.health_url, "健康检查地址")?;
            merge_server_field(&mut primary.websocket_url, server.websocket_url, "WebSocket 地址")?;
            if !primary.name.is_empty() && !server.name.is_empty() && primary.name != server.name {
                return Err("远程配置的 server 与 servers 主线路名称不一致。".into());
            }
            if primary.name.is_empty() { primary.name = server.name; }
            // A previously absent legacy ID may now have been inserted. Revalidate
            // uniqueness before exposing either the canonical primary or the full list.
            clean_servers(list)?
        }
        (Some(RawServer::Many(first)), Some(second)) => {
            let first = clean_servers(first)?;
            let second = clean_servers(second)?;
            if first != second { return Err("远程配置中的两组服务器线路不一致。".into()); }
            first
        }
    };
    // Resolve after merging so an explicit endpoint always wins over an
    // endpoint inferred from optional legacy health metadata.
    for server in &mut list { resolve_server_endpoint(server); }
    Ok((primary_server(&list).cloned(), list))
}

/// Unknown fields are ignored for forward compatibility. Known fields remain typed and validated.
pub fn parse_config(bytes: &[u8]) -> Result<RemoteConfig, String> {
    if bytes.len() > MAX_CONFIG_BYTES { return Err("远程配置超过 256 KiB 限制。".into()); }
    let raw: RawConfig = serde_json::from_slice(bytes).map_err(|_| "远程配置 JSON 格式或字段类型无效。".to_string())?;
    clean_config(raw)
}

fn clean_config(raw: RawConfig) -> Result<RemoteConfig, String> {
    let (server, servers) = normalize_servers(raw.server, raw.servers)?;
    let update = raw.update.unwrap_or_default();
    let latest_version = raw.latest_version.or(update.latest_version)
        .map(|version| semver::Version::parse(version.trim().trim_start_matches('v'))
            .map(|v| v.to_string()).map_err(|_| "远程版本号必须使用 SemVer 格式，例如 0.1.2。".to_string())).transpose()?;
    let mut downloads = update.downloads;
    downloads.extend(raw.downloads);
    if downloads.len() > 12 { return Err("远程配置包含过多下载平台。".into()); }
    for (platform, download) in &mut downloads {
        if platform.len() > 40 || platform.is_empty() || !platform.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') {
            return Err("远程配置下载平台名称无效。".into());
        }
        download.url = https_url(&download.url)?;
        if download.sha256.len() != 64 || !download.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("每个下载文件必须提供完整的 SHA-256。".into());
        }
        download.sha256.make_ascii_lowercase();
    }
    if raw.announcements.len() > 24 { return Err("远程公告超过 24 条限制。".into()); }
    let mut announcements = raw.announcements;
    for announcement in &mut announcements {
        announcement.title = text(&announcement.title, 120, "announcement.title")?;
        if announcement.title.is_empty() { return Err("远程公告标题不能为空。".into()); }
        announcement.body = text(&announcement.body, 4096, "announcement.body")?;
        announcement.date = announcement.date.as_deref().map(|value| text(value, 40, "announcement.date")).transpose()?;
        announcement.url = announcement.url.as_deref().map(https_url).transpose()?;
    }
    let notes = if raw.release_notes.is_empty() { update.release_notes } else { raw.release_notes };
    let mut translations=raw.i18n;
    if translations.len()>2 { return Err("Too many configuration translations.".into()); }
    for (locale,translation) in &mut translations {
        if !matches!(locale.as_str(),"zh-CN"|"en") { return Err("Unsupported translation language.".into()); }
        translation.oltitle=clean_title(&translation.oltitle)?;
        translation.release_notes=text(&translation.release_notes,8192,"i18n.release_notes")?;
        if translation.announcements.len()>24 { return Err("Too many translated announcements.".into()); }
        for announcement in &mut translation.announcements {
            announcement.title=text(&announcement.title,120,"i18n.announcement.title")?;
            if announcement.title.is_empty() { return Err("Translated announcement title is empty.".into()); }
            announcement.body=text(&announcement.body,4096,"i18n.announcement.body")?;
            announcement.date=announcement.date.as_deref().map(|value|text(value,40,"i18n.announcement.date")).transpose()?;
            announcement.url=announcement.url.as_deref().map(https_url).transpose()?;
        }
    }
    Ok(RemoteConfig {
        i18n: translations,
        oltitle: raw.oltitle.as_deref().map(clean_title).transpose()?.unwrap_or_default(),
        website: raw.website.as_deref().map(https_url).transpose()?,
        server, servers, announcements, latest_version, downloads,
        release_notes: text(&notes, 8192, "release_notes")?,
    })
}

fn read_bounded(reader: impl Read) -> Result<Vec<u8>, String> {
    read_bounded_limit(reader, MAX_CONFIG_BYTES)
}

fn read_bounded_limit(reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader.take((limit + 1) as u64).read_to_end(&mut bytes)
        .map_err(|_| "远程配置读取失败。".to_string())?;
    if bytes.len() > limit { return Err("远程配置超过体积限制。".into()); }
    Ok(bytes)
}

fn client() -> Result<Client, String> {
    Client::builder().timeout(Duration::from_secs(8)).connect_timeout(Duration::from_secs(5))
        .https_only(true).user_agent(concat!("GTA5Data-Launcher/", env!("CARGO_PKG_VERSION")))
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() > 3 { attempt.error("redirect limit") }
            else if attempt.url().scheme() != "https" || !attempt.url().username().is_empty() || attempt.url().password().is_some() {
                attempt.error("unsafe redirect")
            } else { attempt.follow() }
        })).build().map_err(|_| "无法初始化远程配置连接。".to_string())
}

fn fetch() -> Result<RemoteConfig, String> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("GTA_DEV_CONFIG_PATH") { return read_development_config(std::path::Path::new(&path)); }
    let response = client()?.get(CONFIG_URL).send().map_err(|error| {
        if error.is_timeout() { "远程配置请求超时。".to_string() }
        else { "无法连接远程配置服务。".to_string() }
    })?;
    if !response.status().is_success() { return Err(format!("远程配置服务返回 HTTP {}。", response.status().as_u16())); }
    if response.content_length().is_some_and(|length| length > MAX_CONFIG_BYTES as u64) {
        return Err("远程配置超过 256 KiB 限制。".into());
    }
    parse_config(&read_bounded(response)?)
}

/// An explicit debug-only fixture never falls back to the public endpoint and
/// never offers a launcher update. The selected file and every ancestor must
/// be ordinary filesystem entries; it is opened read-only and bounded.
#[cfg(debug_assertions)]
fn read_development_config(path: &std::path::Path) -> Result<RemoteConfig, String> {
    if !path.is_absolute() || path.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err("本机开发配置必须使用不含父目录跳转的绝对路径。".into());
    }
    for ancestor in path.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).map_err(|_| "本机开发配置路径无法读取。".to_string())?;
        if metadata.file_type().is_symlink() || (ancestor == path && !metadata.is_file())
            || (ancestor != path && !metadata.is_dir()) {
            return Err("本机开发配置不能包含符号链接或特殊文件。".into());
        }
        if ancestor == path && metadata.len() > MAX_CONFIG_BYTES as u64 {
            return Err("本机开发配置超过 256 KiB 限制。".into());
        }
    }
    let file = std::fs::File::open(path).map_err(|_| "本机开发配置无法只读打开。".to_string())?;
    let mut config = parse_config(&read_bounded(file)?)?;
    config.latest_version = None;
    config.downloads.clear();
    Ok(config)
}

fn snapshot(result: Result<RemoteConfig, String>, checked_at: u64) -> ConfigSnapshot {
    match result {
        Ok(config) => ConfigSnapshot { config, source: ConfigSource::Remote, stale: false,
            fetched_at: Some(checked_at), checked_at, error: None,
            #[cfg(debug_assertions)] debug_local: std::env::var_os("GTA_DEV_CONFIG_PATH").is_some() },
        Err(error) => ConfigSnapshot { config: RemoteConfig::default(), source: ConfigSource::Unavailable, stale: true,
            fetched_at: None, checked_at, error: Some(error),
            #[cfg(debug_assertions)] debug_local: std::env::var_os("GTA_DEV_CONFIG_PATH").is_some() },
    }
}

/// Blocking, at most eight seconds of networking. Call from a background worker.
/// Every call requests fresh remote data. No metadata is loaded from or saved to disk.
pub fn load() -> ConfigSnapshot {
    let result = fetch();
    #[cfg(debug_assertions)]
    let result = result.map(|mut config| { config.latest_version = None; config.downloads.clear(); config });
    snapshot(result, now())
}

pub fn has_update(current: &str, latest: Option<&str>) -> bool {
    let current = semver::Version::parse(current.trim_start_matches('v'));
    let latest = latest.and_then(|version| semver::Version::parse(version.trim_start_matches('v')).ok());
    matches!((current, latest), (Ok(current), Some(latest)) if latest.cmp_precedence(&current).is_gt())
}

/// Runtime-only mandatory update policy. A failed request cannot undo an update
/// already confirmed in this process; only a fresh validated reply can clear it.
pub fn update_requirement(previous: bool, snapshot: &ConfigSnapshot, current: &str) -> bool {
    if snapshot.source != ConfigSource::Remote || snapshot.stale ||
        snapshot.fetched_at.is_none() || snapshot.error.is_some() {
        return previous;
    }
    has_update(current, snapshot.config.latest_version.as_deref())
}

pub fn download_for_platform<'a>(config: &'a RemoteConfig, platform: &str) -> Option<&'a DownloadInfo> {
    config.downloads.get(platform)
}

/// Used before moving a downloaded launcher archive into its final destination.
/// The current UI opens the download in the system browser; a future in-app
/// downloader must call this before offering a verified local package.
#[allow(dead_code)]
#[allow(dead_code)]
pub fn verify_download(bytes: &[u8], expected_sha256: &str) -> bool {
    use sha2::{Digest, Sha256};
    expected_sha256.len() == 64 && format!("{:x}", Sha256::digest(bytes)).eq_ignore_ascii_case(expected_sha256)
}
