//! 固定 CA 内置于启动器；运行时仅给所选局域网 IP 签发短期网站证书。
//! 浏览器下载公共根证书。CA 与网站私钥从不通过 HTTP 或日志暴露。
use rcgen::{Certificate, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, SanType};
use rustls_pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4, TcpListener, UdpSocket};
use time::{Duration, OffsetDateTime};

const MAX_PEM_BYTES: usize = 256 * 1024;
use crate::lan_ca_embedded::{CERTIFICATE_PEM as CA_CERTIFICATE, PRIVATE_KEY_PEM as CA_PRIVATE_KEY};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Settings {
    pub port: u16,
    pub http_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
}
impl Default for Settings {
    fn default() -> Self { Self { port: 8443, http_port: 8442, address: None } }
}

pub struct PreparedLan {
    pub settings: Settings,
    pub config: crate::http_server::LanConfig,
    /// DER 格式公共根证书，可下载为 .cer；从不包含 CA 私钥。
    pub ca_certificate: Vec<u8>,
    pub fingerprint: String,
}
impl std::fmt::Debug for PreparedLan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedLan").field("settings", &self.settings)
            .field("config", &self.config).field("fingerprint", &self.fingerprint).finish()
    }
}

pub fn private_address(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
        || (ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1]))
}

pub fn addresses() -> Vec<String> {
    // UDP connect 只查询路由所选网卡，不发送网络数据。
    let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) { Ok(s) => s, Err(_) => return vec![] };
    if socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).is_err() { return vec![]; }
    match socket.local_addr() {
        Ok(std::net::SocketAddr::V4(a)) if private_address(*a.ip()) => vec![a.ip().to_string()],
        _ => vec![],
    }
}

/// 网站证书和私钥只保留在内存；不写配置目录，也不触碰游戏资源。
pub fn prepare(settings: Settings, address: &str)
    -> Result<PreparedLan, String> {
    let ip = validate_local_settings(&settings, address)?;
    prepare_with_ca(settings, ip, CA_CERTIFICATE, CA_PRIVATE_KEY)
}

pub fn validate_local_settings(settings: &Settings, address: &str) -> Result<Ipv4Addr, String> {
    let ip = validate_settings(settings, address)?;
    TcpListener::bind(SocketAddrV4::new(ip, 0))
        .map_err(|_| "此局域网 IP 不属于本机网卡，请重新选择。".to_string())?;
    Ok(ip)
}

/// 额外客户端拥有独立的浏览器存储源和安装引导，仍共享同一份资源。
pub fn additional_settings() -> Result<Settings, String> {
    let game = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| format!("无法分配客户端端口：{e}"))?;
    let guide = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| format!("无法分配证书引导端口：{e}"))?;
    Ok(Settings {
        port: game.local_addr().map_err(|e| e.to_string())?.port(),
        http_port: guide.local_addr().map_err(|e| e.to_string())?.port(),
        address: None,
    })
}

fn validate_settings(settings: &Settings, address: &str) -> Result<Ipv4Addr, String> {
    validate_ports(settings)?;
    let ip: Ipv4Addr = address.trim().parse()
        .map_err(|_| "请选择本机的局域网 IPv4 地址。".to_string())?;
    if !private_address(ip) {
        return Err("共享地址必须是本机的局域网 IPv4 地址，不能使用公网或回环地址。".into());
    }
    Ok(ip)
}

pub fn validate_ports(settings: &Settings) -> Result<(), String> {
    if settings.port == 0 || settings.http_port == 0 || settings.port == settings.http_port {
        return Err("HTTPS 游戏端口和 HTTP 引导端口必须为不同的 1 至 65535 之间的端口。".into());
    }
    Ok(())
}

fn prepare_with_ca(settings: Settings, ip: Ipv4Addr, certificate: &[u8], private_key: &[u8])
    -> Result<PreparedLan, String> {
    let ca = load_ca(certificate, private_key)?;
    let key = KeyPair::generate().map_err(|_| "无法生成 HTTPS 私钥。".to_string())?;
    let mut params = CertificateParams::default();
    params.distinguished_name.push(DnType::CommonName, format!("GTA5DATA LAN {ip}"));
    params.subject_alt_names = vec![SanType::IpAddress(IpAddr::V4(ip))];
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
    params.not_after = (OffsetDateTime::now_utc() + Duration::days(90)).min(ca.not_after);
    let cert = params.signed_by(&key, &ca.cert, &ca.key)
        .map_err(|_| "无法签发当前局域网 IP 的 HTTPS 证书。".to_string())?;
    validate_certificate(cert.der(), &key, &ca.der, ip)?;
    let fingerprint = fingerprint(ca.der.as_ref());
    let chain = format!("{}{}", cert.pem(), ca.pem).into_bytes();
    Ok(PreparedLan { config: crate::http_server::LanConfig {
        address: ip, tls_certificate: chain, tls_private_key: key.serialize_pem().into_bytes(),
        bootstrap_origin: url::Url::parse(&format!("http://{ip}:{}", settings.http_port))
            .map_err(|_| "HTTP 引导地址无效。".to_string())?.origin().ascii_serialization(),
        ca_fingerprint: fingerprint.clone(),
    }, settings, ca_certificate: ca.der.to_vec(), fingerprint })
}

// No Debug implementation: the signer includes the CA private key.
struct CaMaterial {
    cert: Certificate, key: KeyPair, der: CertificateDer<'static>, pem: String,
    not_after: OffsetDateTime,
}

fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

fn load_ca(certificate: &[u8], private_key: &[u8]) -> Result<CaMaterial, String> {
    if certificate.is_empty() || private_key.is_empty() {
        return Err("此启动器未内置局域网 CA，请使用包含局域网共享功能的启动器。".into());
    }
    if certificate.len() > MAX_PEM_BYTES || private_key.len() > MAX_PEM_BYTES {
        return Err("内置局域网 CA 超过大小限制，请更新启动器。".into());
    }
    let certificates = CertificateDer::pem_slice_iter(certificate).collect::<Result<Vec<_>, _>>()
        .map_err(|_| "内置 CA 不是有效 PEM 格式。".to_string())?;
    if certificates.len() != 1 { return Err("内置 CA 必须包含一个公共根证书。".into()); }
    let der = certificates.into_iter().next().unwrap();
    let key_text = std::str::from_utf8(private_key).map_err(|_| "内置 CA 私钥不是有效 PEM 文本。".to_string())?;
    let key = KeyPair::from_pem(key_text)
        .map_err(|_| "内置 CA 私钥损坏或格式不受支持，请更新启动器。".to_string())?;
    validate_key(&der, &key)?;
    let (_, parsed) = x509_parser::parse_x509_certificate(&der)
        .map_err(|_| "内置 CA 证书损坏，请更新启动器。".to_string())?;
    if parsed.subject() != parsed.issuer() || !parsed.validity().is_valid() {
        return Err("内置 CA 已过期或不是自签根证书，请更新启动器。".into());
    }
    parsed.verify_signature(None).map_err(|_| "内置 CA 的自签名无效，请更新启动器。".to_string())?;
    let params = CertificateParams::from_ca_cert_der(&der).map_err(|_| "内置 CA 参数无法解析。".to_string())?;
    if !matches!(params.is_ca, IsCa::Ca(_)) || !params.key_usages.contains(&KeyUsagePurpose::KeyCertSign) {
        return Err("内置身份不是可签发网站证书的 CA。".into());
    }
    let not_after = params.not_after;
    if not_after <= OffsetDateTime::now_utc() + Duration::days(1) {
        return Err("内置 CA 即将过期，请更新启动器后再开启共享。".into());
    }
    // 签发只需原 CA 的 DN、公钥标识和私钥；传输、下载与指纹均使用原始根证书。
    let cert = params.self_signed(&key).map_err(|_| "无法载入内置 CA 签发身份。".to_string())?;
    let pem = std::str::from_utf8(certificate).map_err(|_| "内置 CA 不是有效 PEM 文本。".to_string())?.to_owned();
    Ok(CaMaterial { cert, key, der, pem, not_after })
}

fn validate_key(cert: &CertificateDer<'_>, key: &KeyPair) -> Result<(), String> {
    let (_, parsed) = x509_parser::parse_x509_certificate(cert)
        .map_err(|_| "局域网证书无法解析。".to_string())?;
    if parsed.public_key().raw != key.public_key_der() {
        return Err("局域网证书与私钥不匹配，请更新启动器。".into());
    }
    Ok(())
}

fn validate_certificate(cert: &CertificateDer<'_>, key: &KeyPair, ca: &CertificateDer<'_>, ip: Ipv4Addr)
    -> Result<(), String> {
    validate_key(cert, key)?;
    let parsed = webpki::EndEntityCert::try_from(cert).map_err(|_| "HTTPS 证书格式无效。".to_string())?;
    parsed.verify_is_valid_for_subject_name(&ServerName::IpAddress(IpAddr::V4(ip).into()))
        .map_err(|_| "HTTPS 证书未覆盖当前局域网 IP。".to_string())?;
    let anchor = webpki::anchor_from_trusted_cert(ca).map_err(|_| "内置 CA 无法作为信任根。".to_string())?;
    parsed.verify_for_usage(webpki::ALL_VERIFICATION_ALGS, &[anchor], &[], UnixTime::now(),
        webpki::KeyUsage::server_auth(), None, None)
        .map_err(|_| "HTTPS 证书已过期或与内置 CA 不匹配。".to_string())?;
    // 核对 tiny_http 使用的 PKCS#8 私钥也可被 TLS 实现载入。
    let key_der = PrivateKeyDer::from_pem_slice(key.serialize_pem().as_bytes())
        .map_err(|_| "HTTPS 私钥格式无效。".to_string())?;
    rustls::ServerConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
        .with_safe_default_protocol_versions().map_err(|_| "无法初始化 HTTPS 协议。".to_string())?
        .with_no_client_auth().with_single_cert(vec![cert.clone().into_owned()], key_der)
        .map_err(|_| "无法载入 HTTPS 证书和私钥。".to_string())?;
    Ok(())
}
