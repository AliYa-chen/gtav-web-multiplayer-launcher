//! A bounded, HTTPS-only source of display text and release metadata.
//! This module never executes remote content or edits the user's game resources.

use reqwest::{blocking::Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::{Read, Write}, path::Path,
    sync::atomic::{AtomicU64, Ordering}, time::{Duration, SystemTime, UNIX_EPOCH}};
use url::Url;

pub const CONFIG_URL: &str = "https://oss.2t.hk/gtav/";
pub const MAX_CONFIG_BYTES: usize = 256 * 1024;
const CACHE_FORMAT: u32 = 1;
static CACHE_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
    pub address: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteConfig {
    pub oltitle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<ServerInfo>,
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
        Self { oltitle: "https://gtav.2t.hk".into(), website: Some("https://gtav.2t.hk/".into()),
            server: None, announcements: Vec::new(), latest_version: None,
            downloads: BTreeMap::new(), release_notes: String::new() }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSource { Remote, Cache, Default }

#[derive(Clone, Debug, Serialize)]
pub struct ConfigSnapshot {
    pub config: RemoteConfig,
    pub source: ConfigSource,
    pub stale: bool,
    /// UTC Unix seconds of the last successful remote fetch, absent for defaults.
    pub fetched_at: Option<u64>,
    pub checked_at: u64,
    pub error: Option<String>,
}

impl Default for ConfigSnapshot {
    fn default() -> Self {
        Self { config: RemoteConfig::default(), source: ConfigSource::Default, stale: true,
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

#[derive(Default, Deserialize)]
struct RawConfig {
    #[serde(default)]
    oltitle: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    server: Option<ServerInfo>,
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

#[derive(Serialize, Deserialize)]
struct CachedConfig { format: u32, fetched_at: u64, config: RemoteConfig }

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

fn clean_title(value: &str) -> Result<String, String> {
    let value = text(value, 160, "oltitle")?;
    if value.is_empty() || value.contains(['<', '>']) || value.contains(['\n', '\t']) {
        return Err("远程配置中的 oltitle 必须是单行文字或 HTTPS 地址。".into());
    }
    // A URL-like title cannot be used to smuggle an executable or insecure link.
    if Url::parse(&value).is_ok() { https_url(&value)?; }
    Ok(value)
}

fn clean_server(mut server: ServerInfo) -> Result<ServerInfo, String> {
    server.address = text(&server.address, 256, "server.address")?;
    if server.address.is_empty() || server.address.contains(['/', '\\', '@', '?', '#']) ||
        server.address.chars().any(char::is_whitespace) {
        return Err("远程服务器地址必须是 IP 或域名，可带端口。".into());
    }
    let url = Url::parse(&format!("ws://{}", server.address)).map_err(|_| "远程服务器地址格式无效。".to_string())?;
    if url.host_str().is_none() || url.port() == Some(0) || !url.username().is_empty() || url.password().is_some() {
        return Err("远程服务器地址格式无效。".into());
    }
    server.name = text(&server.name, 80, "server.name")?;
    server.status_url = server.status_url.as_deref().map(https_url).transpose()?;
    Ok(server)
}

/// Unknown fields are ignored for forward compatibility. Known fields remain typed and validated.
pub fn parse_config(bytes: &[u8]) -> Result<RemoteConfig, String> {
    if bytes.len() > MAX_CONFIG_BYTES { return Err("远程配置超过 256 KiB 限制。".into()); }
    let raw: RawConfig = serde_json::from_slice(bytes).map_err(|_| "远程配置 JSON 格式或字段类型无效。".to_string())?;
    clean_config(raw)
}

fn clean_config(raw: RawConfig) -> Result<RemoteConfig, String> {
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
        oltitle: clean_title(raw.oltitle.as_deref().unwrap_or("https://gtav.2t.hk"))?,
        website: raw.website.as_deref().map(https_url).transpose()?,
        server: raw.server.map(clean_server).transpose()?, announcements, latest_version, downloads,
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
        if error.is_timeout() { "远程配置请求超时，将使用本地配置。".to_string() }
        else { "无法连接远程配置服务，将使用本地配置。".to_string() }
    })?;
    if !response.status().is_success() { return Err(format!("远程配置服务返回 HTTP {}。", response.status().as_u16())); }
    if response.content_length().is_some_and(|length| length > MAX_CONFIG_BYTES as u64) {
        return Err("远程配置超过 256 KiB 限制。".into());
    }
    parse_config(&read_bounded(response)?)
}

fn read_cache(path: &Path) -> Result<CachedConfig, String> {
    // Normalized URLs and the cache envelope can exceed the network payload size.
    // Keep the disk read bounded separately, then revalidate every known field.
    let bytes = read_bounded_limit(fs::File::open(path).map_err(|_| "远程配置缓存不存在。".to_string())?, MAX_CONFIG_BYTES * 2)?;
    let cache: CachedConfig = serde_json::from_slice(&bytes).map_err(|_| "远程配置缓存无效。".to_string())?;
    if cache.format != CACHE_FORMAT { return Err("远程配置缓存版本无效。".into()); }
    // Revalidate cached content through the same untrusted-data boundary.
    let raw = serde_json::from_value(serde_json::to_value(&cache.config).map_err(|_| "远程配置缓存无效。".to_string())?)
        .map_err(|_| "远程配置缓存无效。".to_string())?;
    let config = clean_config(raw)?;
    Ok(CachedConfig { config, ..cache })
}

fn save_cache(path: &Path, config: &RemoteConfig, fetched_at: u64) -> Result<(), String> {
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).ok_or("远程配置缓存目录无效。")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建远程配置缓存目录。".to_string())?;
    let bytes = serde_json::to_vec(&CachedConfig { format: CACHE_FORMAT, fetched_at, config: config.clone() })
        .map_err(|_| "无法保存远程配置缓存。".to_string())?;
    let sequence = CACHE_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_extension(format!("tmp-{}-{sequence}", std::process::id()));
    let written = (|| {
        let mut file = fs::File::create(&temporary).map_err(|_| "无法保存远程配置缓存。".to_string())?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "无法保存远程配置缓存。".to_string())?;
        fs::rename(&temporary, path).map_err(|_| "无法更新远程配置缓存。".to_string())
    })();
    if written.is_err() { let _ = fs::remove_file(temporary); }
    written
}

fn fallback(path: &Path, error: String, checked_at: u64) -> ConfigSnapshot {
    match read_cache(path) {
        Ok(cache) => ConfigSnapshot { config: cache.config, source: ConfigSource::Cache, stale: true,
            fetched_at: Some(cache.fetched_at), checked_at, error: Some(error) },
        Err(_) => ConfigSnapshot { config: RemoteConfig::default(), source: ConfigSource::Default, stale: true,
            fetched_at: None, checked_at, error: Some(error) },
    }
}

/// Blocking, at most eight seconds of networking. Call from a background worker.
/// `cache_path` must be provided by the launcher app cache directory, never a game path.
pub fn load(cache_path: &Path) -> ConfigSnapshot {
    let checked_at = now();
    match fetch() {
        Ok(config) => {
            let error = save_cache(cache_path, &config, checked_at).err();
            ConfigSnapshot { config, source: ConfigSource::Remote, stale: false,
                fetched_at: Some(checked_at), checked_at, error }
        }
        Err(error) => fallback(cache_path, error, checked_at),
    }
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
    fn last_valid_cache_survives_network_failure_and_bad_cache_uses_defaults() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("remote-config.json");
        let config = parse_config(r#"{"oltitle":"维护公告"}"#.as_bytes()).unwrap();
        save_cache(&path, &config, 123).unwrap();
        let snapshot = fallback(&path, "请求失败".into(), 456);
        assert_eq!(snapshot.source, ConfigSource::Cache);
        assert_eq!(snapshot.fetched_at, Some(123)); assert!(snapshot.stale);
        fs::write(&path, b"not JSON").unwrap();
        let snapshot = fallback(&path, "请求失败".into(), 456);
        assert_eq!(snapshot.source, ConfigSource::Default); assert!(snapshot.fetched_at.is_none());
    }

    #[test]
    fn cached_links_are_revalidated() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("remote-config.json");
        let mut config = RemoteConfig::default(); config.website = Some("javascript:alert(1)".into());
        save_cache(&path, &config, 123).unwrap();
        assert_eq!(fallback(&path, "请求失败".into(), 456).source, ConfigSource::Default);
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
