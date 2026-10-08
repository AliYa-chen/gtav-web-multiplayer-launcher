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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub address: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_url: Option<String>,
    /// An HTTPS health endpoint can also describe a TLS reverse-proxy prefix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_url: Option<String>,
    /// Exact transport endpoint. Keep its scheme, path and query when joining.
    #[serde(default, alias = "ws_url", skip_serializing_if = "Option::is_none")]
    pub websocket_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteConfig {
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
        Self { oltitle: String::new(), website: None,
            server: None, servers: Vec::new(), announcements: Vec::new(), latest_version: None,
            downloads: BTreeMap::new(), release_notes: String::new() }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSource { Remote, Unavailable }

#[derive(Clone, Debug, Serialize)]
pub struct ConfigSnapshot {
    pub config: RemoteConfig,
    pub source: ConfigSource,
    pub stale: bool,
    /// UTC Unix seconds of this successful fetch; absent until success or on failure.
    pub fetched_at: Option<u64>,
    pub checked_at: u64,
    pub error: Option<String>,
}

impl Default for ConfigSnapshot {
    fn default() -> Self {
        Self { config: RemoteConfig::default(), source: ConfigSource::Unavailable, stale: true,
            fetched_at: None, checked_at: now(), error: None }
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
    Ok(RemoteConfig {
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

fn snapshot(result: Result<RemoteConfig, String>, checked_at: u64) -> ConfigSnapshot {
    match result {
        Ok(config) => ConfigSnapshot { config, source: ConfigSource::Remote, stale: false,
            fetched_at: Some(checked_at), checked_at, error: None },
        Err(error) => ConfigSnapshot { config: RemoteConfig::default(), source: ConfigSource::Unavailable, stale: true,
            fetched_at: None, checked_at, error: Some(error) },
    }
}

/// Blocking, at most eight seconds of networking. Call from a background worker.
/// Every call requests fresh remote data. No metadata is loaded from or saved to disk.
pub fn load() -> ConfigSnapshot {
    snapshot(fetch(), now())
}

pub fn has_update(current: &str, latest: Option<&str>) -> bool {
    let current = semver::Version::parse(current.trim_start_matches('v'));
    let latest = latest.and_then(|version| semver::Version::parse(version.trim_start_matches('v')).ok());
    matches!((current, latest), (Ok(current), Some(latest)) if latest.cmp_precedence(&current).is_gt())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_minimal_document_remains_supported() {
        let config = parse_config(br#"{"oltitle":"https://gtav.2t.hk"}"#).unwrap();
        assert_eq!(config.oltitle, "https://gtav.2t.hk");
        assert!(config.announcements.is_empty());
        assert!(!has_update("0.1.2", config.latest_version.as_deref()));
    }

    #[test]
    fn nested_release_and_announcements_are_typed() {
        let value = serde_json::json!({"oltitle":"服务维护中", "announcements":[{"title":"测试","body":"正文"}],
            "server":{"address":"183.66.27.21:47485","name":"公共战局"},
            "update":{"latestversion":"v0.2.0","notes":"修复同步", "downloads":{"windows_x64":
                {"url":"https://oss.2t.hk/launcher.exe","sha256":"a".repeat(64)}}}});
        let config = parse_config(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(config.latest_version.as_deref(), Some("0.2.0"));
        assert!(has_update("0.1.2", config.latest_version.as_deref()));
        assert!(download_for_platform(&config, "windows_x64").is_some());
    }

    #[test]
    fn unsafe_links_invalid_hashes_and_wrong_field_types_are_rejected() {
        for value in [serde_json::json!({"oltitle":"javascript:alert(1)"}),
            serde_json::json!({"website":"http://gtav.2t.hk"}),
            serde_json::json!({"website":"https://user:password@gtav.2t.hk"}),
            serde_json::json!({"announcements":[{"title":"标题","url":"file:///tmp/a"}]}),
            serde_json::json!({"downloads":{"windows_x64":{"url":"https://oss.2t.hk/a","sha256":"abc"}}}),
            serde_json::json!({"announcements":"not an array"})] {
            assert!(parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }

    #[test]
    fn oversize_documents_are_rejected_even_without_content_length() {
        let bytes = vec![b' '; MAX_CONFIG_BYTES + 1];
        assert!(read_bounded(bytes.as_slice()).is_err());
        assert!(parse_config(&bytes).is_err());
    }

    #[test]
    fn real_server_array_document_preserves_all_lines_and_release_information() {
        let config = parse_config(include_bytes!("../../../tools/tests/fixtures/remote-launcher-server-array.json")).unwrap();
        assert_eq!(config.servers.len(), 2);
        assert_eq!(config.servers[0].id.as_deref(), Some("main"));
        assert_eq!(config.servers[0].role.as_deref(), Some("主线路"));
        assert_eq!(config.servers[1].id.as_deref(), Some("experimental"));
        assert_eq!(config.servers[1].role.as_deref(), Some("实验线路"));
        assert_eq!(config.servers[1].address, "183.66.27.21:47486");
        assert_eq!(config.server.as_ref(), Some(&config.servers[0]));
        assert_eq!(config.announcements.len(), 2);
        assert!(config.announcements[0].body.contains('\n'));
        assert_eq!(config.latest_version.as_deref(), Some("0.2.1"));
        assert!(config.downloads.is_empty());
    }

    #[test]
    fn server_object_and_plural_list_are_normalized_with_main_priority() {
        let legacy = parse_config(br#"{"server":{"address":"localhost:47485","name":"Legacy"}}"#).unwrap();
        assert_eq!(legacy.servers.len(), 1);
        assert_eq!(legacy.server.as_ref(), Some(&legacy.servers[0]));
        assert!(legacy.servers[0].id.is_none());
        let config = parse_config(br#"{"servers":[{"id":"test","address":"localhost:47486"},{"id":"main","address":"localhost:47485"}]}"#).unwrap();
        assert_eq!(config.server.as_ref(), Some(&config.servers[1]));
        let no_main = parse_config(br#"{"server":[{"id":"test","address":"localhost:47486"},{"address":"localhost:47485"}]}"#).unwrap();
        assert_eq!(no_main.server.as_ref(), Some(&no_main.servers[0]));
        for bytes in [br#"{"server":[]}"#.as_slice(), br#"{"servers":[]}"#.as_slice()] {
            let empty = parse_config(bytes).unwrap();
            assert!(empty.server.is_none()); assert!(empty.servers.is_empty());
        }
    }

    #[test]
    fn normalized_server_configuration_roundtrips_without_losing_lines() {
        let config = parse_config(include_bytes!("../../../tools/tests/fixtures/remote-launcher-server-array.json")).unwrap();
        let serialized = serde_json::to_vec(&config).unwrap();
        assert_eq!(parse_config(&serialized).unwrap(), config);
        let redundant = parse_config(br#"{"server":[{"id":"main","address":"localhost:47485"}],"servers":[{"id":"main","address":"localhost:47485"}]}"#).unwrap();
        assert_eq!(redundant.servers.len(), 1);
        for bytes in [br#"{"server":{"address":"localhost:47485"}}"#.as_slice(),
            br#"{"oltitle":"","server":[{"id":"main","address":"localhost:47485"}]}"#.as_slice()] {
            let missing_title = parse_config(bytes).unwrap();
            assert!(missing_title.oltitle.is_empty());
            assert_eq!(parse_config(&serde_json::to_vec(&missing_title).unwrap()).unwrap(), missing_title);
        }
    }

    #[test]
    fn https_health_metadata_preserves_tls_and_reverse_proxy_path() {
        let config = parse_config(br#"{"servers":[{"id":"main","address":"gtaserver.2t.hk:47485","health_url":"https://gtaserver.2t.hk:47485/47485/health"}]}"#).unwrap();
        let server = config.server.as_ref().unwrap();
        assert_eq!(server.address, "gtaserver.2t.hk:47485");
        assert_eq!(server.health_url.as_deref(), Some("https://gtaserver.2t.hk:47485/47485/health"));
        assert_eq!(server.websocket_url.as_deref(), Some("wss://gtaserver.2t.hk:47485/47485/ws"));
        assert_eq!(parse_config(&serde_json::to_vec(&config).unwrap()).unwrap(), config);

        let default_port = parse_config(br#"{"server":{"address":"gtaserver.2t.hk","health_url":"https://gtaserver.2t.hk/health/"}}"#).unwrap();
        assert_eq!(default_port.server.unwrap().websocket_url.as_deref(), Some("wss://gtaserver.2t.hk/ws"));
    }

    #[test]
    fn explicit_websocket_endpoint_and_alias_preserve_custom_paths_and_queries() {
        for field in ["websocket_url", "ws_url"] {
            let mut line = serde_json::json!({"address":"gtaserver.2t.hk:47485",
                "health_url":"https://gtaserver.2t.hk:47485/47485/health"});
            line[field] = serde_json::json!("wss://gtaserver.2t.hk/session/socket?line=main");
            let config = parse_config(&serde_json::to_vec(&serde_json::json!({"server":line})).unwrap()).unwrap();
            assert_eq!(config.server.unwrap().websocket_url.as_deref(), Some("wss://gtaserver.2t.hk/session/socket?line=main"));
        }
        let merged = parse_config(br#"{"server":{"address":"gtaserver.2t.hk:47485","health_url":"https://gtaserver.2t.hk:47485/47485/health"},"servers":[{"id":"main","address":"gtaserver.2t.hk:47485","websocket_url":"wss://gtaserver.2t.hk/custom/ws"}]}"#).unwrap();
        assert_eq!(merged.server.unwrap().websocket_url.as_deref(), Some("wss://gtaserver.2t.hk/custom/ws"));
    }

    #[test]
    fn full_websocket_address_is_supported_without_a_bare_host_fallback() {
        for address in ["ws://127.0.0.1:47485/ws", "wss://gtaserver.2t.hk:47485/47485/ws?line=main"] {
            let config = parse_config(&serde_json::to_vec(&serde_json::json!({"server":{"address":address}})).unwrap()).unwrap();
            let server = config.server.unwrap();
            assert_eq!(server.address, address);
            assert_eq!(server.websocket_url.as_deref(), Some(address));
        }
        let uppercase = parse_config(br#"{"server":{"address":"WSS://GTASERVER.2T.HK/47485/ws"}}"#).unwrap();
        assert_eq!(uppercase.server.unwrap().websocket_url.as_deref(), Some("wss://gtaserver.2t.hk/47485/ws"));
    }

    #[test]
    fn absent_unrelated_or_differently_routed_health_metadata_does_not_guess_wss() {
        for line in [
            serde_json::json!({"address":"183.66.27.21:47485"}),
            serde_json::json!({"address":"183.66.27.21:47485","health_url":"https://gtaserver.2t.hk:47485/47485/health"}),
            serde_json::json!({"address":"gtaserver.2t.hk:47485","health_url":"https://gtaserver.2t.hk:47486/47486/health"}),
            serde_json::json!({"address":"gtaserver.2t.hk:47485","health_url":"https://gtaserver.2t.hk:47485/status"}),
            serde_json::json!({"address":"gtaserver.2t.hk:47485","status_url":"https://gtaserver.2t.hk:47485/health"}),
        ] {
            let config = parse_config(&serde_json::to_vec(&serde_json::json!({"server":line})).unwrap()).unwrap();
            assert!(config.server.unwrap().websocket_url.is_none());
        }
    }

    #[test]
    fn unsafe_transport_metadata_and_conflicting_aliases_are_rejected() {
        for endpoint in ["https://gtaserver.2t.hk/ws", "wss://user:secret@gtaserver.2t.hk/ws",
            "wss://gtaserver.2t.hk/ws#fragment", "wss://gtaserver.2t.hk:0/ws", "wss:gtaserver.2t.hk",
            "wss://gtaserver.2t.hk\\private/ws", "wss://gtaserver.2t.hk/ws?value=a b"] {
            let value = serde_json::json!({"server":{"address":"gtaserver.2t.hk:47485","websocket_url":endpoint}});
            assert!(parse_config(&serde_json::to_vec(&value).unwrap()).is_err(), "accepted: {endpoint}");
        }
        for endpoint in ["http://gtaserver.2t.hk/health", "https://user:secret@gtaserver.2t.hk/health",
            "https://gtaserver.2t.hk/health#fragment", "https://gtaserver.2t.hk:0/health",
            "https://gtaserver.2t.hk\\private/health"] {
            let value = serde_json::json!({"server":{"address":"gtaserver.2t.hk:47485","health_url":endpoint}});
            assert!(parse_config(&serde_json::to_vec(&value).unwrap()).is_err(), "accepted: {endpoint}");
        }
        let aliases = br#"{"server":{"address":"gtaserver.2t.hk","websocket_url":"wss://gtaserver.2t.hk/ws","ws_url":"wss://gtaserver.2t.hk/other/ws"}}"#;
        assert!(parse_config(aliases).is_err());
    }

    #[test]
    fn legacy_primary_object_merges_missing_metadata_with_full_line_list() {
        let bytes = include_bytes!("../../../tools/tests/fixtures/remote-launcher-server-object-and-lines.json");
        let live = parse_config(bytes).unwrap();
        assert_eq!(live.servers.len(), 2);
        let mut raw: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        raw["server"] = serde_json::json!({"address":"183.66.27.21:47485","name":"公共战局",
            "status_url":"https://gtav.2t.hk","health_url":"https://gtaserver.2t.hk:47485/47485/health"});
        let config = parse_config(&serde_json::to_vec(&raw).unwrap()).unwrap();
        let primary = config.server.as_ref().unwrap();
        assert_eq!(primary, &config.servers[0]);
        assert_eq!(primary.id.as_deref(), Some("main"));
        assert_eq!(primary.role.as_deref(), Some("主线路"));
        assert_eq!(primary.status_url.as_deref(), Some("https://gtav.2t.hk/"));
        assert_eq!(primary.health_url.as_deref(), Some("https://gtaserver.2t.hk:47485/47485/health"));
        assert!(primary.websocket_url.is_none(), "different health and game hosts cannot imply the transport");
        assert_eq!(config.servers[1], live.servers[1]);
        assert_eq!(parse_config(&serde_json::to_vec(&config).unwrap()).unwrap(), config);

        let filled = parse_config(br#"{"server":{"id":"main","name":"Main","role":"Primary","address":"localhost:47485"},"servers":[{"address":"localhost:47485"},{"id":"test","address":"localhost:47486"}]}"#).unwrap();
        assert_eq!(filled.server.as_ref().unwrap().id.as_deref(), Some("main"));
        assert_eq!(filled.servers[0].name, "Main");
        assert_eq!(filled.servers[0].role.as_deref(), Some("Primary"));
        let blank_role = parse_config(br#"{"server":{"address":"localhost:47485","role":""},"servers":[{"address":"localhost:47485","role":"Primary"}]}"#).unwrap();
        assert_eq!(blank_role.servers[0].role.as_deref(), Some("Primary"));
    }

    #[test]
    fn conflicting_legacy_primary_metadata_and_inserted_duplicate_ids_are_rejected() {
        let primary = serde_json::json!({"id":"main","name":"Main","role":"Primary","address":"localhost:47485","status_url":"https://gtav.2t.hk"});
        for (field, value) in [("id", "test"), ("name", "Other"), ("role", "Other"),
            ("address", "localhost:47486"), ("status_url", "https://other.example")] {
            let mut legacy = primary.clone(); legacy[field] = serde_json::Value::String(value.into());
            let document = serde_json::json!({"server":legacy,"servers":[primary.clone()]});
            assert!(parse_config(&serde_json::to_vec(&document).unwrap()).is_err(), "accepted conflict: {field}");
        }
        let duplicate = br#"{"server":{"id":"test","address":"localhost:47485"},"servers":[{"address":"localhost:47485"},{"id":"test","address":"localhost:47486"}]}"#;
        assert!(parse_config(duplicate).is_err());
        for field in ["health_url", "websocket_url"] {
            let (first, second) = if field == "health_url" {
                ("https://gtaserver.2t.hk/health", "https://other.example/health")
            } else { ("wss://gtaserver.2t.hk/ws", "wss://other.example/ws") };
            let mut first_line = serde_json::json!({"address":"gtaserver.2t.hk:47485"});
            let mut second_line = first_line.clone();
            first_line[field] = serde_json::json!(first); second_line[field] = serde_json::json!(second);
            let document = serde_json::json!({"server":first_line,"servers":[second_line]});
            assert!(parse_config(&serde_json::to_vec(&document).unwrap()).is_err(), "accepted conflict: {field}");
        }
    }

    #[test]
    fn server_lists_are_bounded_and_every_entry_is_validated() {
        for value in [
            serde_json::json!({"server":[{"id":"main","address":"localhost:47485"},{"address":"https://bad.example"}]}),
            serde_json::json!({"server":[{"id":"main","address":"localhost:47485"},{"id":"main","address":"localhost:47486"}]}),
            serde_json::json!({"server":[{"id":"","address":"localhost:47485"}]}),
            serde_json::json!({"server":[{"id":"bad id","address":"localhost:47485"}]}),
            serde_json::json!({"server":[{"id":"x".repeat(65),"address":"localhost:47485"}]}),
            serde_json::json!({"server":[{"address":"localhost:0"}]}),
            serde_json::json!({"server":[{"address":"localhost:47485","status_url":"http://example.com"}]}),
            serde_json::json!({"server":[{"address":"localhost:47485","role":0}]}),
            serde_json::json!({"server":"localhost:47485"}),
            serde_json::json!({"servers":{"address":"localhost:47485"}}),
            serde_json::json!({"server":{"address":"localhost:47485"},"servers":[{"address":"localhost:47486"}]}),
            serde_json::json!({"server":[],"servers":[{"address":"localhost:47485"}]}),
        ] { assert!(parse_config(&serde_json::to_vec(&value).unwrap()).is_err(), "accepted: {value}"); }
        let too_many: Vec<_> = (0..=MAX_SERVERS).map(|i| serde_json::json!({"id":format!("line-{i}"),"address":"localhost:47485"})).collect();
        assert!(parse_config(&serde_json::to_vec(&serde_json::json!({"server":too_many})).unwrap()).is_err());
        let maximum: Vec<_> = (0..MAX_SERVERS).map(|i| serde_json::json!({"id":format!("line-{i}"),"address":"localhost:47485"})).collect();
        assert_eq!(parse_config(&serde_json::to_vec(&serde_json::json!({"servers":maximum})).unwrap()).unwrap().servers.len(), MAX_SERVERS);
    }

    #[test]
    fn failed_or_not_yet_fetched_configuration_contains_no_local_fallback_data() {
        let initial = ConfigSnapshot::default();
        assert_eq!(initial.source, ConfigSource::Unavailable);
        assert_eq!(initial.config, RemoteConfig::default());
        assert!(initial.config.oltitle.is_empty()); assert!(initial.config.website.is_none());
        assert!(initial.fetched_at.is_none());
        let success = snapshot(parse_config(include_bytes!("../../../tools/tests/fixtures/remote-launcher-server-array.json")), 123);
        assert_eq!(success.source, ConfigSource::Remote);
        assert_eq!(success.fetched_at, Some(123)); assert!(!success.stale);
        let failed = snapshot(Err("远程配置请求超时。".into()), 456);
        assert_eq!(failed.source, ConfigSource::Unavailable);
        assert_eq!(failed.checked_at, 456); assert!(failed.fetched_at.is_none()); assert!(failed.stale);
        assert_eq!(failed.config, RemoteConfig::default());
        assert!(failed.config.announcements.is_empty()); assert!(failed.config.servers.is_empty());
        assert_eq!(failed.error.as_deref(), Some("远程配置请求超时。"));
    }

    #[test]
    fn versions_compare_numerically_and_account_for_prereleases() {
        assert!(has_update("0.1.2", Some("0.1.10")));
        assert!(has_update("0.2.0-beta.1", Some("0.2.0")));
        assert!(!has_update("0.2.0", Some("0.2.0-beta.1")));
        assert!(!has_update("0.2.0", Some("0.1.2")));
        assert!(!has_update("0.2.0+build.1", Some("0.2.0+build.2")));
        assert!(!has_update("invalid", Some("0.2.0")));
    }

    #[test]
    fn release_hash_checks_exact_content() {
        use sha2::{Digest, Sha256};
        let bytes = b"launcher file"; let hash = format!("{:x}", Sha256::digest(bytes));
        assert!(verify_download(bytes, &hash));
        assert!(!verify_download(b"changed file", &hash));
    }
}
