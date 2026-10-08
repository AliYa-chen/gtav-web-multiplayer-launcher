//! 仅在用户点击按钮后安装公共 CA；私钥不参与系统信任、命令参数或临时文件。
use rustls_pki_types::{pem::PemObject, CertificateDer};
use sha2::{Digest, Sha256};
use std::io::Write;

const MAX_CERTIFICATE_BYTES: usize = 256 * 1024;

pub fn public_certificate_der() -> Result<Vec<u8>, String> {
    decode_public_ca(crate::lan_ca_embedded::CERTIFICATE_PEM)
}

pub fn fingerprint() -> Result<String, String> {
    let der = public_certificate_der()?;
    Ok(Sha256::digest(&der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":"))
}

fn decode_public_ca(pem: &[u8]) -> Result<Vec<u8>, String> {
    if pem.is_empty() || pem.len() > MAX_CERTIFICATE_BYTES {
        return Err("内置 CA 公共证书缺失或过大，请更新启动器。".into());
    }
    let certificates = CertificateDer::pem_slice_iter(pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "内置 CA 公共证书无法解析，请更新启动器。".to_string())?;
    if certificates.len() != 1 {
        return Err("内置 CA 必须包含一个公共根证书。".into());
    }
    let der = certificates.into_iter().next().unwrap().to_vec();
    let (_, parsed) = x509_parser::parse_x509_certificate(&der)
        .map_err(|_| "内置 CA 公共证书无法解析，请更新启动器。".to_string())?;
    let is_ca = parsed
        .basic_constraints()
        .map_err(|_| "内置 CA 的签发用途无效。".to_string())?
        .map(|value| value.value.ca)
        .unwrap_or(false);
    let can_sign = parsed
        .key_usage()
        .map_err(|_| "内置 CA 的签发用途无效。".to_string())?
        .map(|value| value.value.key_cert_sign())
        .unwrap_or(false);
    if !is_ca || !can_sign || parsed.subject() != parsed.issuer() || !parsed.validity().is_valid() {
        return Err("内置 CA 不是有效的自签根证书，请更新启动器。".into());
    }
    parsed
        .verify_signature(None)
        .map_err(|_| "内置 CA 自签名无效，请更新启动器。".to_string())?;
    Ok(der)
}

/// 创建不可预测、独占的公共证书临时文件；所有返回路径都会由 NamedTempFile 清理。
fn temporary_public_certificate(der: &[u8]) -> Result<tempfile::NamedTempFile, String> {
    let mut file = tempfile::Builder::new()
        .prefix("gta5data-public-ca-")
        .suffix(".cer")
        .tempfile()
        .map_err(|_| "无法暂存公共 CA 证书，请下载证书后手动安装并信任。".to_string())?;
    file.write_all(der)
        .and_then(|_| file.flush())
        .map_err(|_| "无法写入公共 CA 证书，请下载证书后手动安装并信任。".to_string())?;
    Ok(file)
}

pub fn install() -> Result<String, String> {
    let der = public_certificate_der()?;
    let certificate = temporary_public_certificate(&der)?;
    platform::install(certificate.path(), &der)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    // POSIX shell 单引号以及 AppleScript 字符串分别转义；两层均只接收公共证书路径。
    fn shell_literal(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }

    fn applescript_literal(value: &str) -> String {
        format!(
            "\"{}\"",
            value
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\r', "\\r")
                .replace('\n', "\\n")
                .replace('\t', "\\t")
        )
    }

    fn install_script(path: &str) -> String {
        let shell_command = [
            "/usr/bin/security",
            "add-trusted-cert",
            "-d",
            "-r",
            "trustRoot",
            "-k",
            "/Library/Keychains/System.keychain",
            path,
        ]
        .map(shell_literal)
        .join(" ");
        format!(
            "do shell script {} with administrator privileges",
            applescript_literal(&shell_command)
        )
    }

    fn matching_sha1(output: &[u8], der: &[u8]) -> Option<String> {
        let text = std::str::from_utf8(output).ok()?;
        let mut sha1 = None;
        let mut pem = String::new();
        let mut collecting = false;
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("SHA-1 hash: ") {
                sha1 = (value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
                    .then(|| value.to_ascii_uppercase());
            }
            if line == "-----BEGIN CERTIFICATE-----" {
                collecting = true;
                pem.clear();
            }
            if collecting {
                pem.push_str(line);
                pem.push('\n');
            }
            if line == "-----END CERTIFICATE-----" && collecting {
                collecting = false;
                if CertificateDer::from_pem_slice(pem.as_bytes())
                    .ok()
                    .as_ref()
                    .map(|certificate| certificate.as_ref() == der)
                    .unwrap_or(false)
                {
                    return sha1;
                }
                sha1 = None;
            }
        }
        None
    }

    fn administrator_trusts_root(json: &[u8], sha1: &str) -> bool {
        let value: serde_json::Value = match serde_json::from_slice(json) {
            Ok(value) => value,
            Err(_) => return false,
        };
        let entry = value
            .get("trustList")
            .and_then(serde_json::Value::as_object)
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case(sha1))
            })
            .map(|(_, entry)| entry);
        let settings = match entry
            .and_then(|entry| entry.get("trustSettings"))
            .and_then(serde_json::Value::as_array)
        {
            Some(settings) => settings,
            None => return false,
        };
        // macOS 空设置数组表示根证书完全信任；显式设置必须是无策略限制的 trustRoot。
        settings.is_empty()
            || settings.iter().any(|setting| {
                setting
                    .get("kSecTrustSettingsResult")
                    .and_then(serde_json::Value::as_u64)
                    == Some(1)
                    && setting.get("kSecTrustSettingsPolicy").is_none()
                    && setting.get("kSecTrustSettingsPolicyName").is_none()
                    && setting.get("kSecTrustSettingsPolicyString").is_none()
                    && setting.get("kSecTrustSettingsApplication").is_none()
                    && setting.get("kSecTrustSettingsKeyUsage").is_none()
            })
    }

    fn trusted_exact_certificate(path: &Path, der: &[u8]) -> bool {
        let found = match Command::new("/usr/bin/security")
            .args([
                "find-certificate",
                "-a",
                "-Z",
                "-p",
                "/Library/Keychains/System.keychain",
            ])
            .output()
        {
            Ok(output) if output.status.success() && output.stdout.len() <= 16 * 1024 * 1024 => {
                output
            }
            _ => return false,
        };
        let sha1 = match matching_sha1(&found.stdout, der) {
            Some(sha1) => sha1,
            None => return false,
        };
        let settings_file = match tempfile::Builder::new()
            .prefix("gta5data-admin-trust-")
            .suffix(".plist")
            .tempfile()
        {
            Ok(file) => file,
            Err(_) => return false,
        };
        // 明确读取管理员信任域，不能让登录钥匙串中另一份同名证书冒充系统安装成功。
        let exported = Command::new("/usr/bin/security")
            .args(["trust-settings-export", "-d"])
            .arg(settings_file.path())
            .output();
        if !exported
            .map(|output| output.status.success())
            .unwrap_or(false)
        {
            return false;
        }
        let converted = Command::new("/usr/bin/plutil")
            .args(["-convert", "json", "-o", "-", "--"])
            .arg(settings_file.path())
            .output();
        let converted = match converted {
            Ok(output) if output.status.success() && output.stdout.len() <= 16 * 1024 * 1024 => {
                output
            }
            _ => return false,
        };
        if !administrator_trusts_root(&converted.stdout, &sha1) {
            return false;
        }
        // basic 策略通过系统信任链验证原始根证书；仅匹配钥匙串条目并不足以确认信任。
        Command::new("/usr/bin/security")
            .args([
                "verify-cert",
                "-p",
                "basic",
                "-L",
                "-l",
                "-k",
                "/Library/Keychains/System.keychain",
                "-c",
            ])
            .arg(path)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    pub fn install(path: &Path, der: &[u8]) -> Result<String, String> {
        if trusted_exact_certificate(path, der) {
            return Ok("CA 已安装并通过系统信任验证，可刷新浏览器进入 HTTPS 游戏。".into());
        }
        let path_text = path
            .to_str()
            .ok_or_else(|| "证书暂存路径无法使用，请下载 CA 证书后手动安装并信任。".to_string())?;
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", &install_script(path_text)])
            .output()
            .map_err(|_| "无法请求管理员授权，请下载 CA 证书后手动安装并信任。".to_string())?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            if error.contains("-128") || error.to_ascii_lowercase().contains("canceled") {
                return Err(
                    "已取消管理员授权，CA 未完成安装。可重试，或下载证书后手动安装并信任。".into(),
                );
            }
            return Err(
                "系统未能完成 CA 安装，请下载证书后在钥匙串中手动安装并设为始终信任。".into(),
            );
        }
        if !trusted_exact_certificate(path, der) {
            return Err(
                "安装命令已完成，但系统信任验证未通过。请手动检查钥匙串中的 CA 信任设置。".into(),
            );
        }
        Ok("CA 已安装并通过系统信任验证。请刷新浏览器；若仍有证书错误，请重启浏览器。".into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn administrator_script_quotes_special_paths_without_executing_them() {
            let path = "/tmp/公共 CA 'quote' \"double\" $(touch nope) `false` \\ slash.cer";
            let shell = shell_literal(path);
            assert!(shell.starts_with('\'') && shell.ends_with('\''));
            assert!(shell.contains("'\"'\"'quote'\"'\"'"));
            let script = install_script(path);
            assert!(script.starts_with("do shell script \""));
            assert!(script.ends_with(" with administrator privileges"));
            assert!(script.contains("add-trusted-cert"));
            assert!(!script.contains("PRIVATE KEY") && !script.contains("BingoRootCA.key"));
            assert_eq!(
                applescript_literal("a\nb\r\t\\\""),
                "\"a\\nb\\r\\t\\\\\\\"\""
            );
        }

        #[test]
        fn system_certificate_and_administrator_trust_must_match_exactly() {
            let pem = super::super::tests::public_fixture(true);
            let der = decode_public_ca(&pem).unwrap();
            let sha1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
            let listing = format!(
                "SHA-256 hash: unused\nSHA-1 hash: {sha1}\n{}",
                std::str::from_utf8(&pem).unwrap()
            );
            assert_eq!(
                matching_sha1(listing.as_bytes(), &der).as_deref(),
                Some(sha1)
            );
            assert!(matching_sha1(listing.as_bytes(), b"different certificate").is_none());
            let trusted = serde_json::json!({"trustList": {(sha1): {"trustSettings": [{"kSecTrustSettingsResult": 1}]}}});
            let json = serde_json::to_vec(&trusted).unwrap();
            assert!(administrator_trusts_root(&json, sha1));
            assert!(!administrator_trusts_root(
                &json,
                "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
            ));
            for setting in [
                serde_json::json!({"kSecTrustSettingsResult": 3}),
                serde_json::json!({"kSecTrustSettingsResult": 1, "kSecTrustSettingsPolicyName": "ssl"}),
                serde_json::json!({"kSecTrustSettingsResult": 1, "kSecTrustSettingsApplication": "another app"}),
            ] {
                let value =
                    serde_json::json!({"trustList": {(sha1): {"trustSettings": [setting]}}});
                assert!(!administrator_trusts_root(
                    &serde_json::to_vec(&value).unwrap(),
                    sha1
                ));
            }
        }
    }
}

#[cfg(any(target_os = "windows", test))]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod windows_platform {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn powershell_literal(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    // EncodedCommand 接收 UTF-16LE 的 Base64，避免 UAC 启动的参数拼接再次解释路径。
    fn encoded_command(script: &str) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let value = ((chunk[0] as u32) << 16)
                | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
                | chunk.get(2).copied().unwrap_or(0) as u32;
            result.push(ALPHABET[((value >> 18) & 63) as usize] as char);
            result.push(ALPHABET[((value >> 12) & 63) as usize] as char);
            result.push(if chunk.len() > 1 {
                ALPHABET[((value >> 6) & 63) as usize] as char
            } else {
                '='
            });
            result.push(if chunk.len() > 2 {
                ALPHABET[(value & 63) as usize] as char
            } else {
                '='
            });
        }
        result
    }

    fn powershell() -> Result<PathBuf, String> {
        std::env::var_os("SystemRoot")
            .map(|root| PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe"))
            .filter(|path| path.is_file())
            .ok_or_else(|| {
                "找不到系统证书安装工具，请下载 CA 证书后手动导入受信任的根证书颁发机构。".into()
            })
    }

    fn elevated_install_script(path: &str, executable: &str) -> String {
        let child = format!(
            "& (Join-Path $env:SystemRoot 'System32/certutil.exe') -addstore -f Root {}; exit $LASTEXITCODE",
            powershell_literal(path)
        );
        format!(
            "try {{ $p = Start-Process -FilePath {} -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','{}') -Verb RunAs -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode }} catch {{ if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) {{ exit 1223 }}; exit 1 }}",
            powershell_literal(executable), encoded_command(&child)
        )
    }

    fn verification_script(path: &str) -> String {
        format!(
            "$ErrorActionPreference = 'Stop'; try {{ $expected = [Convert]::ToBase64String([IO.File]::ReadAllBytes({})); $store = New-Object Security.Cryptography.X509Certificates.X509Store('Root','LocalMachine'); $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly); $match = @($store.Certificates | Where-Object {{ [Convert]::ToBase64String($_.RawData) -eq $expected }}); $store.Close(); if ($match.Count -gt 0) {{ exit 0 }}; exit 1 }} catch {{ exit 1 }}",
            powershell_literal(path)
        )
    }

    fn trusted_exact_certificate(executable: &Path, path: &str) -> bool {
        Command::new(executable)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &encoded_command(&verification_script(path)),
            ])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    pub fn install(path: &Path, _der: &[u8]) -> Result<String, String> {
        let executable = powershell()?;
        let path_text = path
            .to_str()
            .ok_or_else(|| "证书暂存路径无法使用，请下载 CA 后手动安装并信任。".to_string())?;
        let executable_text = executable
            .to_str()
            .ok_or_else(|| "系统工具路径无法使用，请手动安装并信任 CA。".to_string())?;
        if trusted_exact_certificate(&executable, path_text) {
            return Ok("CA 已在系统受信任根证书库中，可刷新浏览器进入 HTTPS 游戏。".into());
        }
        let script = elevated_install_script(path_text, executable_text);
        let output = Command::new(&executable)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &encoded_command(&script),
            ])
            .output()
            .map_err(|_| "无法请求管理员授权，请下载 CA 后手动安装并信任。".to_string())?;
        if output.status.code() == Some(1223) {
            return Err(
                "已取消管理员授权，CA 未完成安装。可重试，或下载证书后手动安装并信任。".into(),
            );
        }
        if !output.status.success() {
            return Err(
                "系统未能完成 CA 安装，请下载证书后手动导入受信任的根证书颁发机构。".into(),
            );
        }
        if !trusted_exact_certificate(&executable, path_text) {
            return Err(
                "安装命令已完成，但未能确认 CA 已在系统受信任根证书库中，请手动检查。".into(),
            );
        }
        Ok(
            "CA 已安装并核验系统受信任根证书库。请刷新浏览器；若仍有证书错误，请重启浏览器。"
                .into(),
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn powershell_quotes_unicode_special_paths_and_uses_uac() {
            let path = "C:\\Users\\公共 CA 'quote' $env\\root.cer";
            assert_eq!(
                powershell_literal(path),
                "'C:\\Users\\公共 CA ''quote'' $env\\root.cer'"
            );
            let script = elevated_install_script(path, "C:\\Windows\\powershell.exe");
            assert!(script.contains("-Verb RunAs -Wait -PassThru"));
            assert!(script.contains("exit $p.ExitCode"));
            assert!(!script.contains("PRIVATE KEY") && !script.contains("BingoRootCA.key"));
            assert!(verification_script(path).contains("'Root','LocalMachine'"));
        }

        #[test]
        fn encoded_command_is_utf16le_base64_without_shell_metacharacters() {
            assert_eq!(encoded_command("a"), "YQA=");
            assert_eq!(encoded_command("ab"), "YQBiAA==");
            assert_eq!(encoded_command("abc"), "YQBiAGMA");
            assert!(encoded_command("公共 'CA' $ ` \\")
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte)));
        }
    }
}

#[cfg(target_os = "windows")]
use windows_platform as platform;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use std::path::Path;

    pub fn install(_path: &Path, _der: &[u8]) -> Result<String, String> {
        Err("此系统暂不支持自动安装 CA。请下载公共 CA 证书并手动安装、设置信任。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair, KeyUsagePurpose};

    pub(super) fn public_fixture(is_ca: bool) -> Vec<u8> {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::default();
        if is_ca {
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
        }
        params.self_signed(&key).unwrap().pem().into_bytes()
    }

    #[test]
    fn only_valid_public_root_is_exported_as_der() {
        let pem = public_fixture(true);
        let der = decode_public_ca(&pem).unwrap();
        let (_, parsed) = x509_parser::parse_x509_certificate(&der).unwrap();
        assert!(parsed.basic_constraints().unwrap().unwrap().value.ca);
        assert!(!der.windows(11).any(|part| part == b"PRIVATE KEY"));
        assert!(decode_public_ca(&public_fixture(false)).is_err());
        assert!(decode_public_ca(b"invalid certificate").is_err());
        let doubled = [pem.as_slice(), pem.as_slice()].concat();
        assert!(decode_public_ca(&doubled).is_err());
        assert!(decode_public_ca(&vec![b'x'; MAX_CERTIFICATE_BYTES + 1]).is_err());
    }

    #[test]
    fn temporary_file_contains_only_public_der_and_is_removed_on_drop() {
        let der = decode_public_ca(&public_fixture(true)).unwrap();
        let file = temporary_public_certificate(&der).unwrap();
        let path = file.path().to_owned();
        assert_eq!(std::fs::read(&path).unwrap(), der);
        drop(file);
        assert!(!path.exists());
    }

    #[test]
    fn embedded_bingo_root_is_the_pinned_public_certificate() {
        // Keep the launcher and the HTTP guide on the same, deliberately fixed
        // root.  This is the public SHA-256 fingerprint only; no private key is
        // ever needed by the trust installer or written to disk.
        let der = public_certificate_der().unwrap();
        assert_eq!(
            fingerprint().unwrap(),
            "A4:CA:82:48:CC:03:FF:C2:11:18:FC:56:91:8B:15:6D:AC:BE:41:F0:3E:16:03:81:BB:43:65:17:E3:D5:D6:84"
        );
        assert!(!der
            .windows(b"PRIVATE KEY".len())
            .any(|part| part == b"PRIVATE KEY"));
        assert!(!crate::lan_ca_embedded::CERTIFICATE_PEM
            .windows(b"PRIVATE KEY".len())
            .any(|part| part == b"PRIVATE KEY"));
    }
}
