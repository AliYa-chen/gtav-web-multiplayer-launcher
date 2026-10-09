//! Build launcher-owned runtime engines from the player's read-only original.
//! The embedded JSON contains hashes, export indexes and three bounded patches;
//! it contains no complete game engine. No Python or external process is used.

use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const SPEC_JSON: &str = include_str!("../assets/engine-spec.json");
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
struct EngineSpec {
    format_version: u32,
    original_sha256: String,
    original_bytes: usize,
    online_sha256: String,
    online_bytes: usize,
    imported_functions: u32,
    exports: Vec<EngineExport>,
    patches: Vec<BodyPatch>,
}

#[derive(Deserialize)]
struct EngineExport {
    name: String,
    function_index: u32,
}

#[derive(Deserialize)]
struct BodyPatch {
    label: String,
    function_index: u32,
    original_body_offset: usize,
    original_body_bytes: usize,
    original_body_sha256: String,
    operation: String,
    offset: usize,
    bytes_hex: String,
    expected_prefix_hex: String,
    expected_tail_hex: String,
}

fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn fail(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}：{error}")
}

/// Generate offline/game.wasm and online/game.wasm only in an external cache.
/// Existing copies are accepted only after their complete hashes are checked.
pub fn prepare(original: &Path, runtime: &Path) -> Result<(), String> {
    let spec: EngineSpec =
        serde_json::from_str(SPEC_JSON).map_err(|e| fail("启动器内置引擎补丁描述损坏", e))?;
    if spec.format_version != 1 || spec.patches.len() != 3 {
        return Err("启动器引擎补丁版本不受支持。".into());
    }
    let original = fs::canonicalize(original).map_err(|e| fail("无法读取玩家原引擎", e))?;
    let game_root = original_game_root(&original)?;
    let runtime = resolve_destination(runtime)?;
    if runtime.starts_with(&game_root) || game_root.starts_with(&runtime) {
        return Err("运行缓存必须位于玩家游戏资源目录之外；未修改任何游戏资源。".into());
    }
    let source_metadata = fs::metadata(&original).map_err(|e| fail("读取原引擎信息失败", e))?;
    if !source_metadata.is_file() || source_metadata.len() != spec.original_bytes as u64 {
        return Err("游戏引擎版本不兼容：原 game.wasm 的大小与受支持版本不符（SHA-256 校验未通过）；未生成运行副本。".into());
    }
    let source = fs::read(&original).map_err(|e| fail("读取原引擎失败", e))?;
    if source.len() != spec.original_bytes || digest(&source) != spec.original_sha256 {
        return Err(
            "游戏引擎版本不兼容：原 game.wasm 的 SHA-256 与受支持版本不符；未生成运行副本。".into(),
        );
    }
    fs::create_dir_all(&runtime).map_err(|e| fail("创建启动器运行缓存失败", e))?;
    let runtime = fs::canonicalize(&runtime).map_err(|e| fail("解析运行缓存目录失败", e))?;
    if runtime.starts_with(&game_root) || game_root.starts_with(&runtime) {
        return Err("运行缓存指向游戏资源目录，已拒绝写入。".into());
    }
    let online_path = runtime.join("online/game.wasm");
    let offline_path = runtime.join("offline/game.wasm");
    let online_cached = cached(
        &online_path,
        &runtime,
        &spec.online_sha256,
        spec.online_bytes,
    )?;
    let offline_cached = cached(
        &offline_path,
        &runtime,
        &spec.original_sha256,
        spec.original_bytes,
    )?;
    if !online_cached {
        let online = build_online(&source, &spec)?;
        if online.len() != spec.online_bytes || digest(&online) != spec.online_sha256 {
            return Err("在线引擎构建校验失败：结果与已审计参考构建器不同，未发布副本。".into());
        }
        publish(&online_path, &runtime, &online)?;
    }
    if !offline_cached {
        publish(&offline_path, &runtime, &source)?;
    }
    for (mode, path, sha, bytes) in [
        (
            "offline",
            &offline_path,
            &spec.original_sha256,
            spec.original_bytes,
        ),
        (
            "online",
            &online_path,
            &spec.online_sha256,
            spec.online_bytes,
        ),
    ] {
        let report = json!({
            "original": {"path": original.to_string_lossy(), "sha256": spec.original_sha256,
                         "bytes": spec.original_bytes},
            "prototype": {"path": path.to_string_lossy(), "sha256": sha, "bytes": bytes},
            "deployment": {"mode": mode, "path": format!("/engine/{mode}/game.wasm"),
                           "runtime_path": path.to_string_lossy(), "patched": mode == "online",
                           "original_engine_changed": false, "game_resources_changed": false},
            "launcher_spec_sha256": digest(SPEC_JSON.as_bytes()),
        });
        let mut encoded =
            serde_json::to_vec_pretty(&report).map_err(|e| fail("生成引擎校验记录失败", e))?;
        encoded.push(b'\n');
        publish(&path.with_extension("json"), &runtime, &encoded)?;
    }
    Ok(())
}

fn original_game_root(original: &Path) -> Result<PathBuf, String> {
    let parent = original.parent().ok_or("原引擎路径没有父目录")?;
    // Expected layout: any-name/b/<build-id>/game.wasm. If called with another
    // layout, protect the whole source directory rather than guessing a root.
    if parent
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|n| n == "b")
    {
        Ok(parent
            .parent()
            .and_then(Path::parent)
            .ok_or("原引擎目录结构不完整")?
            .to_path_buf())
    } else {
        Ok(parent.to_path_buf())
    }
}

/// Resolve existing symlinks before creating the missing portion of a path.
fn resolve_destination(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| fail("读取当前目录失败", e))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let mut ancestor = normalized.clone();
    let mut missing = Vec::new();
    while !ancestor.exists() {
        // A dangling symlink is not a legitimate missing cache directory.
        if fs::symlink_metadata(&ancestor).is_ok() {
            return Err("运行缓存包含无法解析的符号链接。".into());
        }
        missing.push(
            ancestor
                .file_name()
                .ok_or("运行缓存路径不完整")?
                .to_os_string(),
        );
        if !ancestor.pop() {
            return Err("无法找到运行缓存的父目录。".into());
        }
    }
    let mut resolved =
        fs::canonicalize(&ancestor).map_err(|e| fail("解析运行缓存父目录失败", e))?;
    for part in missing.into_iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

fn check_output(path: &Path, runtime: &Path) -> Result<(), String> {
    let resolved = resolve_destination(path)?;
    if !resolved.starts_with(runtime) || resolved == runtime {
        return Err("运行文件通过符号链接指向缓存目录之外，已拒绝写入。".into());
    }
    Ok(())
}

fn cached(path: &Path, runtime: &Path, sha: &str, bytes: usize) -> Result<bool, String> {
    check_output(path, runtime)?;
    match fs::metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.len() != bytes as u64 => return Ok(false),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(fail("读取已有运行副本信息失败", e)),
    }
    match fs::read(path) {
        Ok(data) => Ok(data.len() == bytes && digest(&data) == sha),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(fail("读取已有运行副本失败", e)),
    }
}

fn publish(path: &Path, runtime: &Path, bytes: &[u8]) -> Result<(), String> {
    check_output(path, runtime)?;
    let parent = path.parent().ok_or("运行文件路径不完整")?;
    fs::create_dir_all(parent).map_err(|e| fail("创建运行副本目录失败", e))?;
    check_output(path, runtime)?;
    let serial = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(".launcher-{}-{serial}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| fail("创建临时运行副本失败", e))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| fail("写入运行副本失败", e))?;
        drop(file);
        #[cfg(target_os = "windows")]
        if path.exists() {
            fs::remove_file(path).map_err(|e| fail("替换旧缓存失败", e))?;
        }
        fs::rename(&temporary, path).map_err(|e| fail("发布运行副本失败", e))
    })();
    let _ = fs::remove_file(&temporary);
    result
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    end: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8], start: usize, end: usize) -> Result<Self, String> {
        if start > end || end > data.len() {
            return Err("WASM 区域边界无效。".into());
        }
        Ok(Self {
            data,
            pos: start,
            end,
        })
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(count).ok_or("WASM 长度溢出")?;
        if end > self.end {
            return Err("WASM 数据被截断。".into());
        }
        let result = &self.data[self.pos..end];
        self.pos = end;
        Ok(result)
    }
    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn leb(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for shift in (0..35).step_by(7) {
            let byte = self.byte()?;
            if shift == 28 && byte & 0xf0 != 0 {
                return Err("WASM LEB 长度溢出。".into());
            }
            value |= u32::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("WASM LEB 编码无效。".into())
    }
    fn name(&mut self) -> Result<String, String> {
        let len = self.leb()? as usize;
        String::from_utf8(self.take(len)?.to_vec()).map_err(|e| fail("WASM 导出名称无效", e))
    }
    fn finished(&self) -> Result<(), String> {
        if self.pos == self.end {
            Ok(())
        } else {
            Err("WASM 节包含未解析的尾部数据。".into())
        }
    }
}

fn put_leb(mut value: u32, out: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        out.push(byte | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            break;
        }
    }
}

fn put_size(size: usize, out: &mut Vec<u8>) -> Result<(), String> {
    put_leb(u32::try_from(size).map_err(|_| "WASM 节过大")?, out);
    Ok(())
}

fn hex_bytes(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("引擎补丁的十六进制字节长度无效。".into());
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let nibble = |b: u8| match b {
                b'0'..=b'9' => Ok(b - b'0'),
                b'a'..=b'f' => Ok(b - b'a' + 10),
                b'A'..=b'F' => Ok(b - b'A' + 10),
                _ => Err("引擎补丁包含无效字节".to_string()),
            };
            Ok(nibble(pair[0])? * 16 + nibble(pair[1])?)
        })
        .collect()
}

fn build_online(data: &[u8], spec: &EngineSpec) -> Result<Vec<u8>, String> {
    if !data.starts_with(b"\0asm\x01\0\0\0") {
        return Err("原引擎不是受支持的 WASM 模块。".into());
    }
    let mut source = Reader::new(data, 8, data.len())?;
    let mut output = data[..8].to_vec();
    let mut seen_export = false;
    let mut seen_code = false;
    let mut patched = HashSet::new();
    while source.pos < source.end {
        let section_start = source.pos;
        let kind = source.byte()?;
        let size = source.leb()? as usize;
        let payload_start = source.pos;
        let payload = source.take(size)?;
        let replacement = match kind {
            7 => {
                if seen_export {
                    return Err("WASM 包含重复导出节。".into());
                }
                seen_export = true;
                Some(extend_exports(payload, spec)?)
            }
            10 => {
                if seen_code {
                    return Err("WASM 包含重复代码节。".into());
                }
                seen_code = true;
                let mut reader = Reader::new(data, payload_start, source.pos)?;
                let count = reader.leb()?;
                let mut code = data[payload_start..reader.pos].to_vec();
                let last = spec
                    .imported_functions
                    .checked_add(count)
                    .ok_or("WASM 函数数量溢出")?;
                for index in spec.imported_functions..last {
                    let entry_start = reader.pos;
                    let body_size = reader.leb()? as usize;
                    let body_start = reader.pos;
                    let body = reader.take(body_size)?;
                    if let Some(patch) = spec.patches.iter().find(|p| p.function_index == index) {
                        if !patched.insert(index) {
                            return Err("引擎补丁重复匹配函数。".into());
                        }
                        let body = change_body(body, body_start, patch)?;
                        put_size(body.len(), &mut code)?;
                        code.extend_from_slice(&body);
                    } else {
                        code.extend_from_slice(&data[entry_start..reader.pos]);
                    }
                }
                reader.finished()?;
                Some(code)
            }
            _ => None,
        };
        if let Some(payload) = replacement {
            output.push(kind);
            put_size(payload.len(), &mut output)?;
            output.extend_from_slice(&payload);
        } else {
            output.extend_from_slice(&data[section_start..source.pos]);
        }
    }
    if !seen_export || !seen_code || patched.len() != spec.patches.len() {
        return Err("原引擎的导出、代码或三个目标函数未全部匹配。".into());
    }
    Ok(output)
}

fn extend_exports(payload: &[u8], spec: &EngineSpec) -> Result<Vec<u8>, String> {
    let mut reader = Reader::new(payload, 0, payload.len())?;
    let count = reader.leb()?;
    let entries_start = reader.pos;
    let mut names = HashSet::new();
    for _ in 0..count {
        if !names.insert(reader.name()?) {
            return Err("原引擎存在重复导出名称。".into());
        }
        reader.byte()?;
        reader.leb()?;
    }
    reader.finished()?;
    let mut out = Vec::new();
    let additions = u32::try_from(spec.exports.len()).map_err(|_| "导出数量过大")?;
    put_leb(
        count.checked_add(additions).ok_or("导出数量溢出")?,
        &mut out,
    );
    out.extend_from_slice(&payload[entries_start..]);
    for export in &spec.exports {
        if !names.insert(export.name.clone()) {
            return Err(format!("新增导出名称冲突：{}", export.name));
        }
        put_size(export.name.len(), &mut out)?;
        out.extend_from_slice(export.name.as_bytes());
        out.push(0);
        put_leb(export.function_index, &mut out);
    }
    Ok(out)
}

fn change_body(body: &[u8], start: usize, patch: &BodyPatch) -> Result<Vec<u8>, String> {
    let prefix = hex_bytes(&patch.expected_prefix_hex)?;
    let tail = hex_bytes(&patch.expected_tail_hex)?;
    if start != patch.original_body_offset
        || body.len() != patch.original_body_bytes
        || digest(body) != patch.original_body_sha256
        || !body.starts_with(&prefix)
        || !body.ends_with(&tail)
    {
        return Err(format!(
            "原引擎目标函数校验失败：{}；拒绝应用补丁。",
            patch.label
        ));
    }
    let bytes = hex_bytes(&patch.bytes_hex)?;
    match patch.operation.as_str() {
        "insert" => {
            if patch.offset == 0 || patch.offset >= body.len() {
                return Err("引擎回调插入点不在函数体内。".into());
            }
            let mut out = Vec::with_capacity(body.len() + bytes.len());
            out.extend_from_slice(&body[..patch.offset]);
            out.extend_from_slice(&bytes);
            out.extend_from_slice(&body[patch.offset..]);
            Ok(out)
        }
        "replace" if patch.offset == 0 && bytes.len() == body.len() => Ok(bytes),
        _ => Err("引擎补丁操作或替换长度无效。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Vec<u8>, EngineSpec) {
        let mut data = b"\0asm\x01\0\0\0".to_vec();
        data.extend_from_slice(&[1, 4, 1, 0x60, 0, 0, 3, 4, 3, 0, 0, 0]);
        data.extend_from_slice(&[7, 8, 1, 4, b'm', b'a', b'i', b'n', 0, 0]);
        let code_start = data.len() + 2;
        data.extend_from_slice(&[10, 13, 3, 3, 0, 1, 0x0b, 3, 0, 1, 0x0b, 3, 0, 1, 0x0b]);
        let patches = (0..3)
            .map(|index| BodyPatch {
                label: format!("test{index}"),
                function_index: index,
                original_body_offset: code_start + 2 + index as usize * 4,
                original_body_bytes: 3,
                original_body_sha256: digest(&[0, 1, 0x0b]),
                operation: if index == 2 { "replace" } else { "insert" }.into(),
                offset: if index == 2 { 0 } else { 2 },
                bytes_hex: if index == 2 { "00010b" } else { "01" }.into(),
                expected_prefix_hex: "00".into(),
                expected_tail_hex: "0b".into(),
            })
            .collect();
        let spec = EngineSpec {
            format_version: 1,
            original_sha256: digest(&data),
            original_bytes: data.len(),
            online_sha256: String::new(),
            online_bytes: 0,
            imported_functions: 0,
            exports: vec![EngineExport {
                name: "mpTest".into(),
                function_index: 2,
            }],
            patches,
        };
        (data, spec)
    }

    #[test]
    fn applies_three_checked_patches_and_preserves_other_sections() {
        let (source, spec) = fixture();
        let out = build_online(&source, &spec).unwrap();
        assert_eq!(&out[..20], &source[..20]);
        assert!(out.windows(6).any(|s| s == b"mpTest"));
        assert_eq!(
            &out[out.len() - 14..],
            &[3, 4, 0, 1, 1, 0x0b, 4, 0, 1, 1, 0x0b, 3, 0, 1, 0x0b][1..]
        );
    }

    #[test]
    fn rejects_changed_body_offsets_and_existing_export_names() {
        let (source, mut spec) = fixture();
        spec.patches[0].original_body_offset += 1;
        assert!(build_online(&source, &spec)
            .unwrap_err()
            .contains("校验失败"));
        spec.patches[0].original_body_offset -= 1;
        spec.exports[0].name = "main".into();
        assert!(build_online(&source, &spec).unwrap_err().contains("冲突"));
    }

    #[test]
    fn rejects_truncated_and_overflowing_leb() {
        assert!(Reader::new(&[0x80], 0, 1).unwrap().leb().is_err());
        assert!(Reader::new(&[0xff, 0xff, 0xff, 0xff, 0x10], 0, 5)
            .unwrap()
            .leb()
            .is_err());
        for n in [0, 127, 128, 16384, u32::MAX] {
            let mut encoded = Vec::new();
            put_leb(n, &mut encoded);
            assert_eq!(
                Reader::new(&encoded, 0, encoded.len())
                    .unwrap()
                    .leb()
                    .unwrap(),
                n
            );
        }
    }

    #[test]
    fn embedded_spec_contains_three_unique_bodies() {
        let spec: EngineSpec = serde_json::from_str(SPEC_JSON).unwrap();
        assert_eq!(spec.format_version, 1);
        assert_eq!(spec.patches.len(), 3);
        assert_eq!(
            spec.patches
                .iter()
                .map(|p| p.function_index)
                .collect::<HashSet<_>>()
                .len(),
            3
        );
        assert_eq!(spec.original_sha256.len(), 64);
        assert_eq!(spec.online_sha256.len(), 64);
    }

    #[test]
    fn refuses_in_game_output_and_unsupported_source_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        let game = directory.path().join("arbitrary-name");
        let original = game.join("b/build-id/game.wasm");
        fs::create_dir_all(original.parent().unwrap()).unwrap();
        fs::write(&original, b"unsupported engine").unwrap();
        let before = fs::read(&original).unwrap();
        let nested = game.join("runtime");
        assert!(prepare(&original, &nested)
            .unwrap_err()
            .contains("游戏资源目录之外"));
        assert!(!nested.exists());
        let external = directory.path().join("runtime");
        assert!(prepare(&original, &external)
            .unwrap_err()
            .contains("SHA-256"));
        assert!(!external.exists());
        assert_eq!(fs::read(&original).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_cache_symlink_into_read_only_game_directory() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let game = directory.path().join("data-container");
        let original = game.join("b/build-id/game.wasm");
        fs::create_dir_all(original.parent().unwrap()).unwrap();
        fs::write(&original, b"unsupported engine").unwrap();
        let linked = directory.path().join("cache");
        symlink(&game, &linked).unwrap();
        assert!(prepare(&original, &linked.join("runtime"))
            .unwrap_err()
            .contains("游戏资源目录之外"));
        assert!(!game.join("runtime").exists());
        let runtime = directory.path().join("safe-runtime");
        fs::create_dir(&runtime).unwrap();
        symlink(&game, runtime.join("online")).unwrap();
        assert!(publish(
            &runtime.join("online/game.wasm"),
            &runtime,
            b"must not write"
        )
        .is_err());
        assert!(!game.join("game.wasm").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_cache_ancestor_and_child_link_back_to_game() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let game = directory.path().join("game");
        let original = game.join("b/build-id/game.wasm");
        fs::create_dir_all(original.parent().unwrap()).unwrap();
        let original_bytes = b"player original must remain untouched";
        fs::write(&original, original_bytes).unwrap();
        // A cache ancestor can otherwise admit child links back into the source game.
        symlink(original.parent().unwrap(), directory.path().join("online")).unwrap();
        assert!(prepare(&original, directory.path())
            .unwrap_err().contains("游戏资源目录之外"));
        assert_eq!(fs::read(&original).unwrap(), original_bytes);
        assert!(!directory.path().join("offline").exists());
        assert!(!original.with_extension("json").exists());
    }

    /// Maintainers can exercise the production transform without a browser:
    /// GTA_LAUNCHER_TEST_WASM=/path/to/b/<build>/game.wasm cargo test
    /// engine::tests::production_engine_matches_reference -- --ignored
    #[test]
    #[ignore = "requires a player-provided original engine outside the source distribution"]
    fn production_engine_matches_reference() {
        let source = PathBuf::from(
            std::env::var_os("GTA_LAUNCHER_TEST_WASM").expect("set GTA_LAUNCHER_TEST_WASM"),
        );
        let directory = tempfile::tempdir().unwrap();
        let spec: EngineSpec = serde_json::from_str(SPEC_JSON).unwrap();
        prepare(&source, &directory.path().join("runtime")).unwrap();
        for (mode, sha) in [
            ("offline", &spec.original_sha256),
            ("online", &spec.online_sha256),
        ] {
            let path = directory.path().join(format!("runtime/{mode}/game.wasm"));
            assert_eq!(digest(&fs::read(&path).unwrap()), *sha);
            let report: serde_json::Value =
                serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
            assert_eq!(report["prototype"]["sha256"], *sha);
            assert_eq!(report["deployment"]["game_resources_changed"], false);
        }
        // A second launch uses only copies whose complete hashes still match.
        prepare(&source, &directory.path().join("runtime")).unwrap();
    }
}
