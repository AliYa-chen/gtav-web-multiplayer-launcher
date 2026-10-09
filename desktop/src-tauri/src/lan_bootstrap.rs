//! HTTP certificate installation guide. Never serves game files or any private key.
use crate::http_server::private_lan_address;
use std::io::Cursor;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const GUIDE: &str = include_str!("lan-guide.html");
const PROBE: &[u8] = include_bytes!("lan-probe.js");

pub struct BootstrapHandle {
    port: u16,
    url: String,
    running: Arc<AtomicBool>,
    server: Option<Arc<Server>>,
    dispatcher: Option<JoinHandle<()>>,
}
impl BootstrapHandle {
    pub fn url(&self) -> String { self.url.clone() }
}
impl Drop for BootstrapHandle {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Some(server) = self.server.as_ref() { server.unblock(); }
        if let Some(dispatcher) = self.dispatcher.take() { let _ = dispatcher.join(); }
        drop(self.server.take());
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        for _ in 0..25 {
            if TcpStream::connect_timeout(&address, Duration::from_millis(10)).is_err() { break; }
            thread::sleep(Duration::from_millis(2));
        }
    }
}

fn single_header(request: &Request, name: &'static str) -> Option<String> {
    let mut found = request.headers().iter().filter(|header| header.field.equiv(name));
    let value = found.next()?.value.as_str().to_owned();
    if found.next().is_some() { return None; }
    Some(value)
}

fn allowed_request(request: &Request, address: Ipv4Addr, port: u16) -> bool {
    if request.secure() || !request.remote_addr().map(|remote| match remote.ip() {
        IpAddr::V4(ip) => private_lan_address(ip) || ip.is_loopback(),
        IpAddr::V6(ip) => ip.is_loopback(),
    }).unwrap_or(false) { return false; }
    let host = single_header(request, "Host").unwrap_or_default();
    if host != format!("{address}:{port}") && !(port == 80 && host == address.to_string()) { return false; }
    let origins: Vec<_> = request.headers().iter().filter(|header| header.field.equiv("Origin")).collect();
    origins.is_empty() || (origins.len() == 1 && origins[0].value.as_str() == format!("http://{host}"))
}

fn respond(request: Request, code: u16, body: Vec<u8>, content_type: &str, certificate: bool) {
    let mut headers: Vec<_> = [
        ("Content-Type", content_type), ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
        ("X-Frame-Options", "DENY"),
    ].into_iter().map(|(name, value)| Header::from_bytes(name, value).unwrap()).collect();
    if certificate {
        headers.push(Header::from_bytes("Content-Disposition", "attachment; filename=GTA5DATA-LAN-CA.cer").unwrap());
    }
    let length = body.len();
    let _ = request.respond(Response::new(StatusCode(code), headers, Cursor::new(body), Some(length), None));
}

pub fn start(address: Ipv4Addr, port: u16, https_port: u16, ca_certificate: Vec<u8>, fingerprint: String)
    -> Result<BootstrapHandle, String>
{
    start_with_language(address,port,https_port,ca_certificate,fingerprint,crate::language::shared())
}
pub fn start_with_language(address: Ipv4Addr, port: u16, https_port: u16, ca_certificate: Vec<u8>, fingerprint: String,
    language:crate::language::SharedLanguage) -> Result<BootstrapHandle, String> {
    if !private_lan_address(address) || port == 0 || https_port == 0 || port == https_port
        || ca_certificate.is_empty() || fingerprint.is_empty() {
        return Err("证书安装引导的局域网 IP、端口或公共证书无效。".into());
    }
    let server = Arc::new(Server::http((Ipv4Addr::UNSPECIFIED, port))
        .map_err(|error| format!("无法启动 HTTP 证书安装引导：{error}"))?);
    let url = format!("http://{address}:{port}/");
    let https_url = format!("https://{address}:{https_port}/");
    let settings = serde_json::to_string(&serde_json::json!({
        "httpsUrl": https_url, "fingerprint": fingerprint,
    })).unwrap().replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026");
    let page = GUIDE.replace("/*__LAN_SETTINGS__*/", &format!("window.LAN_SETTINGS = {settings};"));
    let running = Arc::new(AtomicBool::new(true));
    let dispatcher_server = server.clone();
    let dispatcher_running = running.clone();
    let dispatcher = thread::Builder::new().name("lan-ca-guide".into()).spawn(move || {
        while dispatcher_running.load(Ordering::Acquire) {
            let request = match dispatcher_server.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(request)) => request, Ok(None) => continue, Err(_) => break,
            };
            if !allowed_request(&request, address, port) {
                respond(request, 403, "仅允许当前局域网 IP 访问证书安装引导。".as_bytes().to_vec(), "text/plain; charset=utf-8", false);
                continue;
            }
            if !matches!(request.method(), Method::Get | Method::Head) {
                respond(request, 405, "此页面仅用于安装公共 CA 证书。".as_bytes().to_vec(), "text/plain; charset=utf-8", false);
                continue;
            }
            let path = request.url().split('?').next().unwrap_or("/").to_owned();
            match path.as_str() {
                "/api/language" => respond(request,200,serde_json::to_vec(&crate::language::snapshot(&language)).unwrap(),"application/json; charset=utf-8",false),
                "/i18n.js" => respond(request,200,crate::CLIENT.get_file("i18n.js").map(|file|file.contents().to_vec()).unwrap_or_default(),"text/javascript; charset=utf-8",false),
                "/lan-guide-i18n.js" => respond(request,200,include_bytes!("lan-guide-i18n.js").to_vec(),"text/javascript; charset=utf-8",false),
                "/ca.cer" => respond(request, 200, ca_certificate.clone(), "application/pkix-cert", true),
                "/lan-probe.js" => respond(request, 200, PROBE.to_vec(), "text/javascript; charset=utf-8", false),
                _ => respond(request, 200, page.as_bytes().to_vec(), "text/html; charset=utf-8", false),
            }
        }
    }).map_err(|error| format!("无法启动证书安装引导线程：{error}"))?;
    Ok(BootstrapHandle { port, url, running, server: Some(server), dispatcher: Some(dispatcher) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn unused_port() -> u16 {
        std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap().local_addr().unwrap().port()
    }
    fn request(port: u16, method: &str, path: &str, host: &str, extra: &str) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: 0\r\n{extra}\r\n").unwrap();
        let mut output = vec![]; stream.read_to_end(&mut output).unwrap();
        let split = output.windows(4).position(|chunk| chunk == b"\r\n\r\n").unwrap();
        (String::from_utf8(output[..split].to_vec()).unwrap(), output[split + 4..].to_vec())
    }
    #[test]
    fn certificate_guide_uses_the_same_live_read_only_language_as_game_pages() {
        let address=Ipv4Addr::new(192,168,1,20);let port=unused_port();let https=unused_port();let language=crate::language::shared();
        let server=start_with_language(address,port,https,b"public".to_vec(),"AA".into(),language.clone()).unwrap();
        let host=format!("{address}:{port}");
        *language.write().unwrap()=crate::language::LanguageConfig::with_preference("en",4).unwrap();
        let (headers,body)=request(port,"GET","/api/language",&host,"");
        assert!(headers.starts_with("HTTP/1.1 200"));
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&body).unwrap()["resolved"],"en");
        let (_,script)=request(port,"GET","/i18n.js",&host,"");assert!(String::from_utf8(script).unwrap().contains("initLanguage"));
        let (_,guide)=request(port,"GET","/lan-guide-i18n.js",&host,"");assert!(String::from_utf8(guide).unwrap().contains("LAN Certificate Setup"));
        assert!(request(port,"POST","/api/language",&host,"").0.starts_with("HTTP/1.1 405"));
        assert_eq!(crate::language::snapshot(&language).revision,4);drop(server);
    }
    #[test]
    fn http_guide_only_shares_public_ca_and_shutdown_releases_port() {
        let address = Ipv4Addr::new(192, 168, 1, 20);
        let port = unused_port(); let https_port = unused_port();
        let public = b"public CA DER test bytes".to_vec();
        let server = start(address, port, https_port, public.clone(), "AA:BB:CC".into()).unwrap();
        assert_eq!(server.url(), format!("http://{address}:{port}/"));
        let host = format!("{address}:{port}");
        let (headers, body) = request(port, "GET", "/ca.cer", &host, "");
        assert_eq!(body, public);
        assert!(headers.starts_with("HTTP/1.1 200"));
        assert!(headers.to_lowercase().contains("content-disposition: attachment; filename=gta5data-lan-ca.cer"));
        for path in ["/", "/play/", "/data/sample.bin", "/engine/online/game.wasm", "/../key.pem", "/api/local-config"] {
            let (headers, body) = request(port, "GET", path, &host, "");
            assert!(headers.starts_with("HTTP/1.1 200"), "{path}");
            let page = String::from_utf8(body).unwrap();
            assert!(page.contains("下载启动器 CA 证书"), "{path}");
            assert!(page.contains(&format!("https://{address}:{https_port}/")));
            assert!(!page.contains("BEGIN PRIVATE KEY"));
        }
        let (headers, body) = request(port, "HEAD", "/ca.cer", &host, "");
        assert!(headers.to_lowercase().contains(&format!("content-length: {}", public.len())));
        assert!(body.is_empty());
        assert!(request(port, "POST", "/data/batch", &host, "").0.starts_with("HTTP/1.1 405"));
        assert!(request(port, "GET", "/", "evil.invalid", "").0.starts_with("HTTP/1.1 403"));
        assert!(request(port, "GET", "/", &host, "Origin: http://evil.invalid\r\n").0.starts_with("HTTP/1.1 403"));
        assert!(request(port, "GET", "/", &host, "Origin: null\r\n").0.starts_with("HTTP/1.1 403"));
        drop(server);
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
        assert!(start(address, port, https_port, public, "AA:BB:CC".into()).is_ok());
    }
    #[test]
    fn invalid_bind_configuration_is_rejected() {
        for (address, port, https_port) in [
            (Ipv4Addr::new(8, 8, 8, 8), 8000, 8443),
            (Ipv4Addr::new(192, 168, 1, 20), 0, 8443),
            (Ipv4Addr::new(192, 168, 1, 20), 8443, 8443),
        ] {
            assert!(start(address, port, https_port, vec![1], "fingerprint".into()).is_err());
        }
    }
}
