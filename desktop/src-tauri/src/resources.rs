//! Discover and verify player-supplied resources without changing them.
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const BUILD_ID: &str = "8b0b5899ed";
pub const ORIGINAL_WASM_SHA256: &str =
    "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0";
const MAX_SCAN_DEPTH: usize = 4;
const MAX_SCAN_DIRECTORIES: usize = 1024;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct SampleDigest {
    pub file: String,
    pub md5: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ResourceInfo {
    pub root: PathBuf,
    pub data_root: PathBuf,
    pub original_wasm: PathBuf,
    pub manifest_version: String,
    pub original_sha256: String,
    pub manifest_file_count: usize,
    pub sample_md5: Option<SampleDigest>,
}

/// Reject absolute, parent, Windows and NUL paths before touching the filesystem.
pub fn safe_relative(name: &str) -> Result<&Path, String> {
    if name.is_empty()
        || name.contains('\\')
        || name.contains('\0')
        || name.contains(':')
        || name.starts_with('/')
        || name.split('/').any(|part| part == ".." || part == ".")
    {
        return Err(format!("资源路径不能越过已选择目录：{name}"));
    }
    let path = Path::new(name);
    if path.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(format!("资源路径格式无效：{name}"));
    }
    Ok(path)
}

/// Canonicalization also blocks symlink escapes from the chosen read-only root.
pub fn contained_file(root: &Path, name: &str) -> Result<PathBuf, String> {
    let path = root.join(safe_relative(name)?);
    let real = path
        .canonicalize()
        .map_err(|error| format!("无法读取资源 {name}：{error}"))?;
    if !real.starts_with(root) || !real.is_file() {
        return Err(format!("资源不存在或链接指向目录外：{name}"));
    }
    Ok(real)
}

pub fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut bytes).map_err(|error| format!("引擎校验失败：{error}"))?;
        if count == 0 {
            break;
        }
        hash.update(&bytes[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn looks_like_root(path: &Path) -> bool {
    path.join("b").is_dir()
        && path.join("data").is_dir()
        && path.join("data/manifest.json").is_file()
}

fn find_roots(selected: &Path) -> Result<Vec<PathBuf>, String> {
    let selected = selected.canonicalize().map_err(|error| format!("无法打开所选目录：{error}"))?;
    if !selected.is_dir() {
        return Err("请选择游戏资源目录。".into());
    }
    // Directly selecting b, data, or the build directory is also supported.
    for ancestor in selected.ancestors().take(3) {
        if looks_like_root(ancestor) {
            return Ok(vec![ancestor.to_path_buf()]);
        }
    }
    let mut pending = VecDeque::from([(selected.clone(), 0usize)]);
    let mut seen = HashSet::new();
    let mut roots = Vec::new();
    while let Some((directory, depth)) = pending.pop_front() {
        let real = match directory.canonicalize() {
            Ok(real) if real.starts_with(&selected) => real,
            _ => continue,
        };
        if !seen.insert(real.clone()) {
            continue;
        }
        if seen.len() > MAX_SCAN_DIRECTORIES {
            return Err("所选目录包含太多子目录，请直接选择含 b 和 data 的游戏资源目录。".into());
        }
        if looks_like_root(&real) {
            roots.push(real);
            continue;
        }
        if depth >= MAX_SCAN_DEPTH {
            continue;
        }
        let entries = match fs::read_dir(&real) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Avoid developer caches and OS metadata; no game/domain names are assumed.
            if name.starts_with('.') || matches!(name.as_ref(), "node_modules" | "target") {
                continue;
            }
            if entry.path().is_dir() {
                pending.push_back((entry.path(), depth + 1));
            }
        }
    }
    roots.sort();
    roots.dedup();
    Ok(roots)
}

pub fn inspect_game_resources(selected: &Path) -> Result<ResourceInfo, String> {
    let roots = find_roots(selected)?;
    if roots.is_empty() {
        return Err("未找到游戏资源。请选择同时包含 b、data 和 data/manifest.json 的目录；也可选择其 data 子目录或外层项目目录。无需选择或提供 index.html。".into());
    }
    if roots.len() > 1 {
        let choices = roots.iter().take(8).map(|path| path.display().to_string()).collect::<Vec<_>>().join("\n");
        return Err(format!("找到多个游戏资源目录，无法自动决定。请重新选择其中一个：\n{choices}"));
    }
    inspect_root(&roots[0], ORIGINAL_WASM_SHA256)
}

fn inspect_root(root: &Path, expected_sha256: &str) -> Result<ResourceInfo, String> {
    let root = root.canonicalize().map_err(|error| format!("资源目录无法读取：{error}"))?;
    let data_root = root.join("data").canonicalize().map_err(|error| format!("data 目录无法读取：{error}"))?;
    if !data_root.starts_with(&root) {
        return Err("data 目录不能链接到所选游戏资源目录以外。".into());
    }
    let manifest_path = contained_file(&data_root, "manifest.json")?;
    if manifest_path.metadata().map_err(|e| e.to_string())?.len() > MAX_MANIFEST_BYTES {
        return Err("资源清单过大，无法识别该游戏版本。".into());
    }
    let manifest: Value = serde_json::from_reader(File::open(&manifest_path).map_err(|e| e.to_string())?)
        .map_err(|error| format!("无法读取 data/manifest.json：{error}"))?;
    if manifest.get("mount").and_then(Value::as_str) != Some("/game/") {
        return Err("游戏资源清单不兼容：mount 必须为 /game/。".into());
    }
    let files = manifest.get("files").and_then(Value::as_array)
        .filter(|files| !files.is_empty())
        .ok_or("游戏资源清单不兼容：需要非空的 files 列表。")?;
    let mut missing = Vec::new();
    let mut sample = None;
    for entry in files {
        let row = entry.as_array().filter(|row| row.len() >= 2)
            .ok_or("游戏资源清单中的文件记录格式无效。")?;
        let name = row[0].as_str().ok_or("游戏资源清单中的文件路径格式无效。")?;
        let size = row[1].as_u64().ok_or("游戏资源清单中的文件长度格式无效。")?;
        safe_relative(name)?;
        let path = data_root.join(name);
        if !path.is_file() {
            missing.push(name.to_owned());
            continue;
        }
        let real = contained_file(&data_root, name)?;
        // A small data-file digest aids diagnostics; engine SHA-256 determines compatibility.
        if sample.is_none() && size > 0 && size <= 64 * 1024 {
            let length = real.metadata().map_err(|e| e.to_string())?.len();
            if length <= 64 * 1024 {
                let bytes = fs::read(&real).map_err(|e| format!("资源校验失败：{e}"))?;
                sample = Some(SampleDigest { file: name.to_owned(), md5: format!("{:x}", md5::compute(bytes)) });
            }
        }
    }
    if !missing.is_empty() {
        return Err(format!("游戏资源不完整，清单中的 {} 个文件缺失：{}{}。启动器不会下载或修改游戏数据。", missing.len(), missing.iter().take(8).cloned().collect::<Vec<_>>().join("、"), if missing.len() > 8 { " 等" } else { "" }));
    }
    for name in ["game.wasm", "game.js", "io_worker.js", "wgpu_worker.js"] {
        contained_file(&root, &format!("b/{BUILD_ID}/{name}"))?;
    }
    let original_wasm = contained_file(&root, &format!("b/{BUILD_ID}/game.wasm"))?;
    let original_sha256 = file_sha256(&original_wasm)?;
    if original_sha256 != expected_sha256 {
        return Err(format!("游戏引擎版本不兼容（SHA-256：{original_sha256}）。请选择此启动器支持的完整游戏资源；原文件未修改。"));
    }
    let manifest_version = match manifest.get("version") {
        Some(Value::String(version)) => version.clone(),
        Some(value) => value.to_string(),
        None => String::new(),
    };
    Ok(ResourceInfo { root, data_root, original_wasm, manifest_version, original_sha256, manifest_file_count: files.len(), sample_md5: sample })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("gta-launcher-resource-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn fixture(root: &Path) -> String {
        fs::create_dir_all(root.join(format!("b/{BUILD_ID}"))).unwrap();
        fs::create_dir_all(root.join("data/common")).unwrap();
        fs::write(root.join("data/common/small.txt"), b"game data").unwrap();
        fs::write(root.join("data/manifest.json"), br#"{"mount":"/game/","version":"test","files":[["common/small.txt",9,0]]}"#).unwrap();
        for name in ["game.wasm", "game.js", "io_worker.js", "wgpu_worker.js"] {
            fs::write(root.join(format!("b/{BUILD_ID}/{name}")), b"test engine").unwrap();
        }
        file_sha256(&root.join(format!("b/{BUILD_ID}/game.wasm"))).unwrap()
    }
    #[test]
    fn discovers_arbitrary_domain_and_child_selection_without_index() {
        let tmp = Temp::new();
        let root = tmp.0.join("renamed-project/mirror/custom.example");
        let digest = fixture(&root);
        assert_eq!(find_roots(&tmp.0).unwrap(), vec![root.clone()]);
        assert_eq!(find_roots(&root.join("data")).unwrap(), vec![root.clone()]);
        assert_eq!(find_roots(&root.join("b")).unwrap(), vec![root.clone()]);
        let info = inspect_root(&root, &digest).unwrap();
        assert_eq!(info.manifest_file_count, 1);
        assert!(info.sample_md5.is_some());
    }
    #[test]
    fn ambiguous_roots_are_reported() {
        let tmp = Temp::new();
        fixture(&tmp.0.join("mirror/first")); fixture(&tmp.0.join("mirror/second"));
        assert!(inspect_game_resources(&tmp.0).unwrap_err().contains("多个"));
    }
    #[test]
    fn rejects_manifest_escapes_and_unsupported_engine() {
        let tmp = Temp::new(); fixture(&tmp.0);
        assert!(inspect_root(&tmp.0, "other").unwrap_err().contains("不兼容"));
        fs::write(tmp.0.join("data/manifest.json"), br#"{"mount":"/game/","files":[["../outside",1]]}"#).unwrap();
        assert!(inspect_root(&tmp.0, "other").unwrap_err().contains("越过"));
        for name in ["/etc/passwd", "..", "a/../b", "C:/thing", "x\\y", "x\0y"] { assert!(safe_relative(name).is_err()); }
    }
    #[test]
    fn missing_files_do_not_pass_preflight() {
        let tmp = Temp::new(); let digest = fixture(&tmp.0);
        fs::remove_file(tmp.0.join("data/common/small.txt")).unwrap();
        assert!(inspect_root(&tmp.0, &digest).unwrap_err().contains("缺失"));
    }
    #[cfg(unix)]
    #[test]
    fn rejects_external_symlinks() {
        let tmp = Temp::new(); let other = Temp::new(); let digest = fixture(&tmp.0);
        fs::write(other.0.join("outside"), "game data").unwrap();
        fs::remove_file(tmp.0.join("data/common/small.txt")).unwrap();
        std::os::unix::fs::symlink(other.0.join("outside"), tmp.0.join("data/common/small.txt")).unwrap();
        assert!(inspect_root(&tmp.0, &digest).unwrap_err().contains("目录外"));
    }
}
