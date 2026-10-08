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
pub struct Settings { pub port: u16, pub http_port: u16 }
impl Default for Settings {
    fn default() -> Self { Self { port: 8443, http_port: 8442 } }
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
    let ip = validate_settings(&settings, address)?;
    TcpListener::bind(SocketAddrV4::new(ip, 0))
        .map_err(|_| "此局域网 IP 不属于本机网卡，请重新选择。".to_string())?;
    prepare_with_ca(settings, ip, CA_CERTIFICATE, CA_PRIVATE_KEY)
}

fn validate_settings(settings: &Settings, address: &str) -> Result<Ipv4Addr, String> {
    if settings.port == 0 || settings.http_port == 0 || settings.port == settings.http_port {
        return Err("HTTPS 游戏端口和 HTTP 引导端口必须为不同的 1 至 65535 之间的端口。".into());
    }
    let ip: Ipv4Addr = address.trim().parse()
        .map_err(|_| "请选择本机的局域网 IPv4 地址。".to_string())?;
    if !private_address(ip) {
        return Err("共享地址必须是本机的局域网 IPv4 地址，不能使用公网或回环地址。".into());
    }
    Ok(ip)
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

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::BasicConstraints;

    fn ca_fixture() -> (Vec<u8>, Vec<u8>) {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.distinguished_name.push(DnType::CommonName, "Disposable test LAN CA");
        params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
        params.not_after = OffsetDateTime::now_utc() + Duration::days(3650);
        let cert = params.self_signed(&key).unwrap();
        (cert.pem().into_bytes(), key.serialize_pem().into_bytes())
    }
    fn prepared(settings: Settings, ip: &str, cert: &[u8], key: &[u8]) -> PreparedLan {
        let ip = validate_settings(&settings, ip).unwrap();
        prepare_with_ca(settings, ip, cert, key).unwrap()
    }
    fn leaf(value: &PreparedLan) -> (CertificateDer<'static>, KeyPair) {
        let der = CertificateDer::pem_slice_iter(&value.config.tls_certificate).next().unwrap().unwrap();
        let key = KeyPair::from_pem(std::str::from_utf8(&value.config.tls_private_key).unwrap()).unwrap();
        (der, key)
    }

    #[test]
    fn embedded_issuer_remains_identical_across_restarts_ports_and_ip_changes() {
        let (cert, key) = ca_fixture();
        let first = prepared(Settings::default(), "192.168.1.5", &cert, &key);
        let restarted = prepared(Settings { port: 9000, http_port: 9001 }, "192.168.1.5", &cert, &key);
        assert_eq!(first.fingerprint, restarted.fingerprint);
        assert_eq!(first.ca_certificate, restarted.ca_certificate);
        assert_ne!(first.config.tls_private_key, restarted.config.tls_private_key);
        let changed = prepared(Settings::default(), "192.168.1.6", &cert, &key);
        assert_eq!(first.ca_certificate, changed.ca_certificate);
        let (der, leaf_key) = leaf(&changed);
        let ca = CertificateDer::from(changed.ca_certificate.clone());
        validate_certificate(&der, &leaf_key, &ca, "192.168.1.6".parse().unwrap()).unwrap();
        assert!(validate_certificate(&der, &leaf_key, &ca, "192.168.1.5".parse().unwrap()).is_err());
        let (_, parsed) = x509_parser::parse_x509_certificate(&der).unwrap();
        let validity = parsed.validity();
        assert!(validity.not_after.timestamp() - validity.not_before.timestamp() <= 91 * 86400);
        assert_eq!(restarted.config.bootstrap_origin, "http://192.168.1.5:9001");
    }

    #[test]
    fn public_ca_download_and_debug_never_include_private_keys() {
        let (cert, key) = ca_fixture();
        let first = prepared(Settings::default(), "10.1.2.3", &cert, &key);
        let (_, parsed) = x509_parser::parse_x509_certificate(&first.ca_certificate).unwrap();
        assert!(parsed.basic_constraints().unwrap().unwrap().value.ca);
        let key_der = KeyPair::from_pem(std::str::from_utf8(&key).unwrap()).unwrap().serialize_der();
        assert!(!first.ca_certificate.windows(key_der.len()).any(|chunk| chunk == key_der));
        let debug = format!("{first:?}");
        assert!(!debug.contains("BEGIN PRIVATE KEY") && !debug.contains("BEGIN CERTIFICATE"));
    }

    #[test]
    fn wrong_ca_private_key_corruption_and_unrelated_root_are_rejected() {
        let (cert, key) = ca_fixture();
        let (other_cert, other_key) = ca_fixture();
        assert!(load_ca(&cert, &other_key).is_err());
        let first = prepared(Settings::default(), "10.1.2.3", &cert, &key);
        let (der, leaf_key) = leaf(&first);
        let other = CertificateDer::pem_slice_iter(&other_cert).next().unwrap().unwrap();
        assert!(validate_certificate(&der, &leaf_key, &other, "10.1.2.3".parse().unwrap()).is_err());
        for certificate in [b"".as_slice(), b"corrupt cert".as_slice(), &vec![b'x'; MAX_PEM_BYTES + 1]] {
            assert!(load_ca(certificate, &key).is_err());
        }
        assert!(load_ca(&cert, b"corrupt key").is_err());
        let chain = std::str::from_utf8(&first.config.tls_certificate).unwrap();
        let end = chain.find("-----END CERTIFICATE-----").unwrap() + "-----END CERTIFICATE-----".len();
        // One matching leaf/key pair must still be rejected as a CA.
        assert!(load_ca(&chain.as_bytes()[..end], &first.config.tls_private_key).is_err());
    }

    #[test]
    fn invalid_addresses_ports_and_foreign_interfaces_do_not_write_anything() {
        let root = tempfile::tempdir().unwrap();
        let game = root.path().join("game");
        std::fs::create_dir(&game).unwrap();
        std::fs::write(game.join("original.data"), b"untouched game").unwrap();
        let cert = root.path().join("config/lan-ca");
        for address in ["0.0.0.0", "127.0.0.1", "8.8.8.8", "::1", "192.168.1.1:8443"] {
            assert!(prepare(Settings::default(), address).is_err());
        }
        for settings in [Settings { port: 0, http_port: 8442 }, Settings { port: 8443, http_port: 0 }, Settings { port: 8443, http_port: 8443 }] {
            assert!(prepare(settings, "192.168.1.1").is_err());
        }
        let foreign = ["10.231.249.199", "172.30.249.199", "192.168.254.199"].into_iter()
            .find(|ip| TcpListener::bind((*ip, 0)).is_err()).unwrap();
        assert!(prepare(Settings::default(), foreign).is_err());
        assert!(!cert.exists());
        assert_eq!(std::fs::read(game.join("original.data")).unwrap(), b"untouched game");
        assert_eq!(std::fs::read_dir(&game).unwrap().count(), 1);
    }

    #[test]
    fn successful_prepare_does_not_write_game_or_certificate_cache() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("original.data"), b"untouched game").unwrap();
        if let Some(ip) = addresses().first() {
            prepare(Settings::default(), ip).unwrap();
        } else {
            let (cert, key) = ca_fixture();
            prepared(Settings::default(), "10.1.2.3", &cert, &key);
        }
        assert_eq!(std::fs::read(root.path().join("original.data")).unwrap(), b"untouched game");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn settings_drop_all_legacy_domain_and_certificate_fields() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "hostname":"legacy.test", "port":8443, "certificate_path":"path", "private_key_path":"key"
        })).unwrap();
        assert_eq!(serde_json::to_value(settings).unwrap(), serde_json::json!({"port":8443,"http_port":8442}));
    }

    #[test]
    fn bundled_ca_can_sign_browser_valid_ip_certificates_when_present() {
        prepare_with_ca(Settings::default(), "192.168.1.2".parse().unwrap(), CA_CERTIFICATE, CA_PRIVATE_KEY).unwrap();
    }

    #[test]
    fn default_http_port_uses_browser_canonical_origin() {
        let (cert, key) = ca_fixture();
        let value = prepared(Settings { port: 443, http_port: 80 }, "192.168.1.2", &cert, &key);
        assert_eq!(value.config.bootstrap_origin, "http://192.168.1.2");
    }
}
