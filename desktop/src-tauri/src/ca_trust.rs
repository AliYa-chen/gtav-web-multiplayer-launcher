//! 仅在用户点击按钮后安装公共 CA；私钥不参与系统信任、命令参数或临时文件。
use rustls_pki_types::{pem::PemObject, CertificateDer};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;

const MAX_CERTIFICATE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub installed: bool,
    pub trusted: bool,
    pub fingerprint: String,
    pub message: String,
}

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

pub fn check_status() -> Result<Status, String> {
    let der = public_certificate_der()?;
    let fingerprint = fingerprint_from_der(&der);
    platform::status(&der, &fingerprint)
}

fn fingerprint_from_der(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
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
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn user_keychain_from_output(output: &[u8]) -> Result<PathBuf, String> {
        let invalid = || "无法读取当前用户的默认钥匙串，请在钥匙串访问中将“登录”设为默认钥匙串后重试。".to_string();
        if output.len() > 16 * 1024 { return Err(invalid()); }
        let value = std::str::from_utf8(output).map_err(|_| invalid())?.trim();
        let value = if value.starts_with('"') {
            value.strip_prefix('"').and_then(|value| value.strip_suffix('"')).ok_or_else(invalid)?
        } else { value };
        let path = PathBuf::from(value);
        if value.is_empty() || value.contains('"') || value.chars().any(char::is_control)
            || !path.is_absolute() || path.starts_with("/Library/Keychains") {
            return Err(invalid());
        }
        Ok(path)
    }

    fn default_user_keychain() -> Result<PathBuf, String> {
        let output = Command::new("/usr/bin/security")
            .args(["default-keychain", "-d", "user"])
            .output().map_err(|error| format!("无法读取当前用户的默认钥匙串：{error}"))?;
        if !output.status.success() {
            return Err(format!("无法读取当前用户的默认钥匙串：{}", command_diagnostic(&output)));
        }
        user_keychain_from_output(&output.stdout)
    }

    fn install_command(path: &Path, keychain: &Path) -> Command {
        let mut command = Command::new("/usr/bin/security");
        // 不加 -d：在当前用户信任域安装；授权由 security 自行请求，不能以 root 身份执行。
        command.args(["add-trusted-cert", "-r", "trustRoot", "-k"]).arg(keychain).arg(path);
        command
    }

    fn exact_certificate_in_listing(output: &[u8], der: &[u8]) -> bool {
        CertificateDer::pem_slice_iter(output).any(|certificate| {
            certificate.map(|certificate| certificate.as_ref() == der).unwrap_or(false)
        })
    }

    fn command_diagnostic(output: &std::process::Output) -> String {
        let source = if output.stderr.is_empty() { &output.stdout } else { &output.stderr };
        let message: String = String::from_utf8_lossy(source)
            .chars().filter(|char| !char.is_control() || char.is_whitespace()).take(500).collect();
        let message = message.split_whitespace().collect::<Vec<_>>().join(" ");
        if message.is_empty() {
            format!("系统工具退出状态：{}", output.status)
        } else { message }
    }

    fn verify_certificate(path: &Path, keychain: &Path) -> Result<(), String> {
        // 交由 Security.framework 处理用户/管理员信任域、SSL policy 和显式拒绝。
        // 不指定 -r：传入公共 CA 不能把它当作临时信任锚，必须已在系统中受信任。
        let output = Command::new("/usr/bin/security")
            .args(["verify-cert", "-p", "ssl", "-L", "-l", "-k"])
            .arg(keychain)
            .arg("-c")
            .arg(path).output().map_err(|error| format!("无法验证 CA 的系统信任：{error}"))?;
        if output.status.success() { Ok(()) } else { Err(command_diagnostic(&output)) }
    }

    fn certificate_installed_in_keychain(keychain: &Path, der: &[u8]) -> Result<bool, String> {
        // 只查当前用户默认钥匙串；系统钥匙串中的旧安装不算本次用户安装完成。
        let found = Command::new("/usr/bin/security")
            .args(["find-certificate", "-a", "-p"])
            .arg(keychain)
            .output().map_err(|error| format!("无法读取本机钥匙串：{error}"))?;
        // errSecItemNotFound：钥匙串没有证书时属于未安装，不能把它当成检测故障。
        if found.status.code() == Some(44) { return Ok(false); }
        if !found.status.success() { return Err(command_diagnostic(&found)); }
        Ok(found.stdout.len() <= 16 * 1024 * 1024 && exact_certificate_in_listing(&found.stdout, der))
    }

    fn trusted_exact_certificate(path: &Path, keychain: &Path, der: &[u8]) -> Result<(), String> {
        if !certificate_installed_in_keychain(keychain, der)? {
            return Err("当前用户默认钥匙串中未找到启动器的精确 CA 证书。".into());
        }
        // trust-settings-export 中的 NSData/NSDate 不能转为 JSON；直接验证真实 SSL 信任。
        verify_certificate(path, keychain)
    }

    pub fn status(der: &[u8], fingerprint: &str) -> Result<super::Status, String> {
        let keychain = default_user_keychain()?;
        let certificate = temporary_public_certificate(der)?;
        let installed = certificate_installed_in_keychain(&keychain, der)?;
        if !installed {
            return Ok(Status {
                installed: false,
                trusted: false,
                fingerprint: fingerprint.to_owned(),
                message: "当前用户默认钥匙串中尚未找到 BinGo Root CA，请点击安装或下载 CA 证书。".into(),
            });
        }
        match verify_certificate(certificate.path(), &keychain) {
            Ok(()) => Ok(Status {
                installed: true,
                trusted: true,
                fingerprint: fingerprint.to_owned(),
                message: "BinGo Root CA 已安装到当前用户默认钥匙串，并通过系统 SSL 信任验证。".into(),
            }),
            Err(error) => Ok(Status {
                installed: true,
                trusted: false,
                fingerprint: fingerprint.to_owned(),
                message: format!("BinGo Root CA 已安装，但尚未通过系统 SSL 信任验证：{error}"),
            }),
        }
    }

    pub fn install(path: &Path, der: &[u8]) -> Result<String, String> {
        let keychain = default_user_keychain()?;
        if trusted_exact_certificate(path, &keychain, der).is_ok() {
            return Ok("CA 已安装到当前用户默认钥匙串并通过系统信任验证，可刷新浏览器进入 HTTPS 游戏。".into());
        }
        let output = install_command(path, &keychain)
            .output()
            .map_err(|error| format!("无法请求钥匙串授权，请下载 CA 后手动安装并信任。系统错误：{error}"))?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            if error.contains("-128") || error.to_ascii_lowercase().contains("canceled") {
                return Err(
                    "已取消钥匙串授权，CA 未完成安装。可重试，或下载证书后手动安装并信任。".into(),
                );
            }
            return Err(format!(
                "系统未能完成 CA 安装，请下载证书后导入“登录”钥匙串并设为始终信任。系统错误：{}",
                command_diagnostic(&output)
            ));
        }
        trusted_exact_certificate(path, &keychain, der).map_err(|error| format!(
            "安装命令已完成，但系统 SSL 信任验证未通过。请检查当前用户默认钥匙串中的 CA 信任设置。系统错误：{error}"
        ))?;
        Ok("CA 已安装到当前用户默认钥匙串并通过系统信任验证。请刷新浏览器；若仍有证书错误，请重启浏览器。".into())
    }

}

#[cfg(target_os = "windows")]
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

    fn powershell_command(executable: &Path) -> Command {
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut command = Command::new(executable);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW；系统 UAC 授权仍正常显示。
        }
        command
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
        // 只读枚举两个位置现有的证书库，不创建空库，也不只依据 Root 条目推断信任。
        const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new([IO.File]::ReadAllBytes(__CERTIFICATE_PATH__))
    $expected = [Convert]::ToBase64String($certificate.RawData)
    $installed = $false
    $denied = $false
    foreach ($location in @('CurrentUser', 'LocalMachine')) {
        $stores = @(Get-ChildItem -Path ('Cert:\' + $location) -ErrorAction Stop)
        foreach ($entry in $stores) {
            $store = [Security.Cryptography.X509Certificates.X509Store]::new([string]$entry.Name, [Security.Cryptography.X509Certificates.StoreLocation]$location)
            try {
                $flags = [Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly -bor [Security.Cryptography.X509Certificates.OpenFlags]::OpenExistingOnly
                $store.Open($flags)
                foreach ($candidate in $store.Certificates) {
                    if ([Convert]::ToBase64String($candidate.RawData) -eq $expected) {
                        $installed = $true
                        if ($entry.Name -eq 'Disallowed') { $denied = $true }
                    }
                }
            } finally { $store.Close() }
        }
    }
    $trusted = $false
    $errors = @()
    if ($installed -and -not $denied) {
        $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
        try {
            $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
            $chain.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
            [void]$chain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
            if ($chain.ChainPolicy.PSObject.Properties.Name -contains 'DisableCertificateDownloads') {
                $chain.ChainPolicy.DisableCertificateDownloads = $true
            }
            # The pinned input is a validated self-signed root without AIA. Building
            # that single certificate never needs an issuer or a network download,
            # including Windows PowerShell's older .NET Framework implementation.
            $trusted = $chain.Build($certificate)
            $errors = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })
        } finally { $chain.Dispose() }
    }
    @{ installed = [bool]$installed; trusted = [bool]$trusted; denied = [bool]$denied; errors = $errors } | ConvertTo-Json -Compress
    $certificate.Dispose()
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
"#;
        SCRIPT.replace("__CERTIFICATE_PATH__", &powershell_literal(path))
    }

    #[derive(serde::Deserialize)]
    struct NativeStatus {
        installed: bool,
        trusted: bool,
        denied: bool,
        errors: Vec<String>,
    }

    fn command_diagnostic(output: &std::process::Output) -> String {
        let source = if output.stderr.is_empty() { &output.stdout } else { &output.stderr };
        let message = String::from_utf8_lossy(source).split_whitespace()
            .collect::<Vec<_>>().join(" ").chars().take(500).collect::<String>();
        if message.is_empty() { format!("系统工具退出状态：{}", output.status) } else { message }
    }

    fn parse_status_output(output: &std::process::Output, fingerprint: &str) -> Result<super::Status, String> {
        if !output.status.success() {
            return Err(format!("无法读取 Windows 证书信任状态：{}", command_diagnostic(output)));
        }
        if output.stdout.len() > 16 * 1024 { return Err("Windows 证书状态响应超过大小限制。".into()); }
        let status: NativeStatus = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("Windows 证书状态响应无法解析：{error}"))?;
        if (status.trusted && (!status.installed || status.denied)) || (status.denied && !status.installed) {
            return Err("Windows 证书状态响应不一致，请重新检测。".into());
        }
        let message = if status.denied {
            "BinGo Root CA 已安装，但 Windows 的 Disallowed 证书库明确拒绝此 CA，请检查不受信任证书。".into()
        } else if status.trusted {
            "BinGo Root CA 已安装并通过 Windows 系统 SSL 信任验证。".into()
        } else if status.installed {
            let detail = status.errors.join(", ").chars().take(300).collect::<String>();
            if detail.is_empty() {
                "BinGo Root CA 已安装，但尚未通过 Windows 系统 SSL 信任验证，请导入受信任的根证书颁发机构。".into()
            } else { format!("BinGo Root CA 已安装，但尚未通过 Windows 系统 SSL 信任验证：{detail}") }
        } else {
            "尚未找到 BinGo Root CA，请点击安装或下载 CA 证书。".into()
        };
        Ok(super::Status { installed: status.installed, trusted: status.trusted,
            fingerprint: fingerprint.to_owned(), message })
    }

    fn query_status(executable: &Path, path: &str, fingerprint: &str) -> Result<super::Status, String> {
        let output = powershell_command(executable)
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded_command(&verification_script(path))])
            .output().map_err(|error| format!("无法启动 Windows 证书状态查询：{error}"))?;
        parse_status_output(&output, fingerprint)
    }

    pub fn status(der: &[u8], fingerprint: &str) -> Result<super::Status, String> {
        let executable = powershell()?;
        let certificate = super::temporary_public_certificate(der)?;
        let path = certificate.path().to_str().ok_or_else(|| "证书暂存路径无法使用。".to_string())?;
        query_status(&executable, path, fingerprint)
    }

    pub fn install(path: &Path, der: &[u8]) -> Result<String, String> {
        let executable = powershell()?;
        let path_text = path
            .to_str()
            .ok_or_else(|| "证书暂存路径无法使用，请下载 CA 后手动安装并信任。".to_string())?;
        let executable_text = executable
            .to_str()
            .ok_or_else(|| "系统工具路径无法使用，请手动安装并信任 CA。".to_string())?;
        let fingerprint = super::fingerprint_from_der(der);
        let before = query_status(&executable, path_text, &fingerprint)?;
        if before.trusted { return Ok(before.message); }
        let script = elevated_install_script(path_text, executable_text);
        let output = powershell_command(&executable)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &encoded_command(&script),
            ])
            .output()
            .map_err(|error| format!("无法请求管理员授权，请下载 CA 后手动安装并信任。系统错误：{error}"))?;
        if output.status.code() == Some(1223) {
            return Err(
                "已取消管理员授权，CA 未完成安装。可重试，或下载证书后手动安装并信任。".into(),
            );
        }
        if !output.status.success() {
            return Err(format!(
                "系统未能完成 CA 安装，请下载证书后手动导入受信任的根证书颁发机构。系统错误：{}",
                command_diagnostic(&output)
            ));
        }
        let after = query_status(&executable, path_text, &fingerprint)?;
        if !after.trusted { return Err(format!("安装命令已完成。{}", after.message)); }
        Ok(format!("{} 请刷新浏览器；若仍有证书错误，请重启浏览器。", after.message))
    }

}

#[cfg(target_os = "windows")]
use windows_platform as platform;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use std::path::Path;

    pub fn status(_der: &[u8], fingerprint: &str) -> Result<super::Status, String> {
        Ok(super::Status {
            installed: false,
            trusted: false,
            fingerprint: fingerprint.to_owned(),
            message: "此系统暂不支持自动检测 CA 信任，请下载证书后手动安装。".into(),
        })
    }

    pub fn install(_path: &Path, _der: &[u8]) -> Result<String, String> {
        Err("此系统暂不支持自动安装 CA。请下载公共 CA 证书并手动安装、设置信任。".into())
    }
}
