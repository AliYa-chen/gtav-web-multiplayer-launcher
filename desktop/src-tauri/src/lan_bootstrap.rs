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
                _ => {
                    let requested=target_game_url(request.url(),&https_url);
                    let body=if let Some(target)=requested {
                        let settings=serde_json::to_string(&serde_json::json!({"httpsUrl":target,"fingerprint":fingerprint})).unwrap()
                            .replace('<',"\\u003c").replace('>',"\\u003e").replace('&',"\\u0026");
                        GUIDE.replace("/*__LAN_SETTINGS__*/",&format!("window.LAN_SETTINGS = {settings};"))
                    } else { page.clone() };
                    respond(request, 200, body.into_bytes(), "text/html; charset=utf-8", false)
                },
            }
        }
    }).map_err(|error| format!("无法启动证书安装引导线程：{error}"))?;
    Ok(BootstrapHandle { port, url, running, server: Some(server), dispatcher: Some(dispatcher) })
}

fn target_game_url(request: &str, https_base: &str) -> Option<String> {
    let request=url::Url::parse(&format!("http://launcher.invalid{request}")).ok()?;
    let entry=request.query_pairs().find(|(key,_)|key=="target")?.1;
    if !entry.starts_with('/') || entry.starts_with("//") || entry.contains('\\') || entry.len()>4096 { return None; }
    let target=url::Url::parse(https_base).ok()?.join(&entry).ok()?;
    let allowed=["launcher","mode","map","name","server","preset","seed"];
    if !matches!(target.path(),"/"|"/play/") || target.fragment().is_some()
        || target.query_pairs().any(|(key,_)|!allowed.contains(&key.as_ref())) { return None; }
    let query=target.query_pairs().collect::<std::collections::HashMap<_,_>>();
    if matches!(target.path(),"/"|"/play/") && target.query().is_none() {return crate::launch::game_url(https_base,&entry).ok();}
    if target.path()=="/play/" && !crate::launch::valid_online_query(target.query().unwrap_or_default()) {return None;}
    if target.path()=="/" && query.get("launcher").map(|value|value.as_ref())!=Some("1") && !matches!(query.get("mode").map(|value|value.as_ref()),Some("story"|"sandbox")) { return None; }
    if target.path()=="/" && !matches!(query.get("mode").map(|value|value.as_ref()),Some("story"|"sandbox")) { return None; }
    if let Some(server)=query.get("server") { crate::launch::normalize_server(server).ok()?; }
    crate::launch::game_url(https_base,&entry).ok()
}
