//! Read fonts from the user's verified game resources into the launcher cache.
//! No game font or encryption key is embedded in the launcher.

use aes::cipher::{BlockDecrypt, KeyInit};
use flate2::read::DeflateDecoder;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const ORIGINAL_WASM_SHA256: &str =
    "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0";
// Verified against the original WASM's passive data segment 620 and the copy
// into address 6_583_860 in __wasm_init_memory. AES(unsigned int), function
// 1190, selects address 6_584_016 for the archive's 0x0fff_fff9 key identifier.
// This is a location in a user-supplied, hash-checked file, not key material.
const ORIGINAL_AES_KEY_OFFSET: usize = 55_097_564;
const ARCHIVE_SHA256: &str =
    "09c8a7d79b08e79cc7722313d2ee0f463e7d1d5e366f9d753a518511ce4f5fef";
const FONT_MAX_BYTES: usize = 8 * 1024 * 1024;

const FONTS: [(&str, &str, usize, &str); 4] = [
    (
        "font_lib_efigs.gfx",
        "font_lib_efigs_pc.gfx",
        232_318,
        "28edb604b3b30ca5a32337f146cc9d581d037a76827f8302c1be2edd13e5c59e",
    ),
    (
        "font_lib_chinese.gfx",
        "font_lib_chinese_pc.gfx",
        3_622_655,
        "d1d1b9affbb8cb72b64b4a7dba3d37b667c40b80dca02e71147ae7fb3db035e6",
    ),
    (
        "font_lib_japanese.gfx",
        "font_lib_japanese_pc.gfx",
        1_082_536,
        "bb5dde5eef65f2600898829ff9633375f73ec7cbb91a46e2891d615b81dacb19",
    ),
    (
        "font_lib_korean.gfx",
        "font_lib_korean_pc.gfx",
        439_925,
        "e98c71f36e14a51e17d46528bf99548dde9a4148ce97e3a90fc1f724fe359ffd",
    ),
];

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn verified_file(path: &Path, expected_hash: &str, description: &str) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取{description}：{error}"))?;
    if digest(&bytes) != expected_hash {
        return Err(format!("{description}版本校验失败，请选择匹配的原版游戏数据包"));
    }
    Ok(bytes)
}

fn safe_cache(game_root: &Path, cache: &Path) -> Result<PathBuf, String> {
    let game = fs::canonicalize(game_root).map_err(|e| format!("游戏目录不可读：{e}"))?;
    // Check the closest existing parent before creating anything. Resolve
    // symlinks so a cache symlink cannot write through into the selected game.
    if !cache.is_absolute() || cache.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("字体缓存必须是启动器自己的绝对路径".into());
    }
    let ancestor = cache
        .ancestors()
        .find(|p| p.exists())
        .ok_or("字体缓存没有有效的上级目录")?;
    let resolved = fs::canonicalize(ancestor).map_err(|e| format!("字体缓存路径无效：{e}"))?;
    if resolved.starts_with(&game) {
        return Err("字体缓存不得位于游戏数据目录中".into());
    }
    fs::create_dir_all(cache).map_err(|e| format!("无法建立启动器字体缓存：{e}"))?;
    let result = fs::canonicalize(cache).map_err(|e| format!("字体缓存路径无效：{e}"))?;
    if result.starts_with(game) {
        return Err("字体缓存不得位于游戏数据目录中".into());
    }
    Ok(result)
}

fn decrypt_blocks(bytes: &mut [u8], key: &[u8]) -> Result<(), String> {
    let cipher = aes::Aes256::new_from_slice(key).map_err(|_| "游戏字体解码信息无效")?;
    // The engine decrypts only complete 16-byte blocks. An incomplete final
    // block stays unchanged; there is no PKCS padding in these RPF entries.
    for block in bytes.chunks_exact_mut(16) {
        cipher.decrypt_block(block.into());
    }
    Ok(())
}

#[derive(Debug)]
struct BinaryEntry {
    offset: usize,
    stored_size: usize,
    expanded_size: usize,
    encrypted: bool,
}

fn le24(bytes: &[u8]) -> usize {
    bytes[0] as usize | (bytes[1] as usize) << 8 | (bytes[2] as usize) << 16
}

fn parse_entries(archive: &[u8], key: &[u8]) -> Result<HashMap<String, BinaryEntry>, String> {
    if archive.len() < 16 || &archive[..4] != b"7FPR" {
        return Err("字体归档不是受支持的 PC RPF7 格式".into());
    }
    let count = u32::from_le_bytes(archive[4..8].try_into().unwrap()) as usize;
    let names_size = u32::from_le_bytes(archive[8..12].try_into().unwrap()) as usize;
    let encryption = u32::from_le_bytes(archive[12..16].try_into().unwrap());
    if count != 44 || names_size != 960 || encryption != 0x0fff_fff9 {
        return Err("字体归档布局不匹配，暂不支持这个游戏数据版本".into());
    }
    let entries_size = count * 16;
    let table_size = entries_size + names_size;
    let mut directory = archive
        .get(16..16 + table_size)
        .ok_or("字体归档目录不完整")?
        .to_vec();
    decrypt_blocks(&mut directory, key)?;
    let names = &directory[entries_size..];
    let mut result = HashMap::new();
    for entry in directory[..entries_size].chunks_exact(16) {
        // Root/directory entries use the 0x7fffff marker in bytes 5..8.
        if le24(&entry[5..8]) == 0x7f_ffff {
            continue;
        }
        let name_offset = u16::from_le_bytes(entry[..2].try_into().unwrap()) as usize;
        let name_bytes = names.get(name_offset..).ok_or("字体归档文件名越界")?;
        let name_end = name_bytes.iter().position(|b| *b == 0).ok_or("字体归档文件名不完整")?;
        let name = std::str::from_utf8(&name_bytes[..name_end]).map_err(|_| "字体归档文件名无效")?;
        if !FONTS.iter().any(|(_, wanted, _, _)| *wanted == name) {
            continue;
        }
        // A resource entry has bit 23 set in its sector offset. Fonts are
        // binary entries, never resource entries.
        let sector = le24(&entry[5..8]);
        if sector & 0x80_0000 != 0 {
            return Err(format!("字体归档条目类型异常：{name}"));
        }
        let stored_size = le24(&entry[2..5]);
        let expanded_size = u32::from_le_bytes(entry[8..12].try_into().unwrap()) as usize;
        let encryption = u32::from_le_bytes(entry[12..16].try_into().unwrap());
        if expanded_size > FONT_MAX_BYTES || stored_size == 0 || stored_size > FONT_MAX_BYTES || encryption > 1 {
            return Err(format!("字体归档条目大小或编码异常：{name}"));
        }
        let offset = sector * 512;
        if offset < 16 + table_size || offset.checked_add(stored_size).is_none_or(|end| end > archive.len()) {
            return Err(format!("字体归档条目越界：{name}"));
        }
        let value = BinaryEntry { offset, stored_size, expanded_size, encrypted: encryption == 1 };
        if result.insert(name.to_string(), value).is_some() {
            return Err(format!("字体归档存在重复条目：{name}"));
        }
    }
    Ok(result)
}

fn unpack(archive: &[u8], entry: &BinaryEntry, key: &[u8]) -> Result<Vec<u8>, String> {
    let mut packed = archive[entry.offset..entry.offset + entry.stored_size].to_vec();
    if entry.encrypted {
        decrypt_blocks(&mut packed, key)?;
    }
    let mut out = Vec::with_capacity(entry.expanded_size);
    DeflateDecoder::new(packed.as_slice())
        .take(FONT_MAX_BYTES as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("无法解压玩家自己的字体归档：{e}"))?;
    if out.len() != entry.expanded_size {
        return Err("字体归档解压长度校验失败".into());
    }
    Ok(out)
}

fn cache_font(cache: &Path, name: &str, bytes: &[u8], expected_size: usize, expected_hash: &str) -> Result<PathBuf, String> {
    if bytes.len() != expected_size || digest(bytes) != expected_hash {
        return Err(format!("游戏字体内容校验失败：{name}"));
    }
    let target = cache.join(name);
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!("字体缓存目标不是普通文件：{name}"));
        }
        if fs::read(&target).is_ok_and(|cached| digest(&cached) == expected_hash) {
            return Ok(target);
        }
    }
    // The target is confined to a canonical launcher cache. Only launcher
    // cache files are ever replaced; the selected game is read-only.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时钟无效，无法建立字体缓存")?
        .as_nanos();
    let temporary = cache.join(format!(".{name}.{}.{nonce}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)
        .map_err(|e| format!("无法写入启动器字体缓存：{e}"))?;
    use std::io::Write;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法写入启动器字体缓存：{error}"));
    }
    drop(file);
    if target.exists() {
        fs::remove_file(&target).map_err(|e| format!("无法替换启动器字体缓存：{e}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法保存启动器字体缓存：{error}"));
    }
    Ok(target)
}

pub fn prepare(game_root: &Path, original_wasm: &Path, cache: &Path) -> Result<HashMap<String, PathBuf>, String> {
    let wasm = verified_file(original_wasm, ORIGINAL_WASM_SHA256, "原版引擎")?;
    let mut key = wasm.get(ORIGINAL_AES_KEY_OFFSET..ORIGINAL_AES_KEY_OFFSET + 32)
        .ok_or("原版引擎的字体解码信息不完整")?.to_vec();
    let archive = verified_file(
        &game_root.join("data/x64/data/cdimages/scaleform_platform_pc.rpf"),
        ARCHIVE_SHA256,
        "原版字体归档",
    )?;
    let entries = parse_entries(&archive, &key)?;
    let base_font = verified_file(
        &game_root.join("data/common/data/Scaleform/gfxfontlib.gfx"),
        "02581078a1f648f94c4bcaf8f9a0aa365a773f5535a6b956b3984095968ba275",
        "原版通用字体",
    )?;
    let cache = safe_cache(game_root, cache)?;
    let mut result = HashMap::new();
    result.insert("gfxfontlib.gfx".into(), cache_font(
        &cache, "gfxfontlib.gfx", &base_font, 100_867,
        "02581078a1f648f94c4bcaf8f9a0aa365a773f5535a6b956b3984095968ba275",
    )?);
    for (alias, archive_name, size, hash) in FONTS {
        let entry = entries.get(archive_name).ok_or_else(|| format!("原版字体归档缺少 {archive_name}"))?;
        let bytes = unpack(&archive, entry, &key)?;
        let target = cache_font(&cache, alias, &bytes, size, hash)?;
        result.insert(alias.into(), target);
    }
    key.fill(0);
    Ok(result)
}
