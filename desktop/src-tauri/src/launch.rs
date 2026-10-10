//! Launcher-owned entry preferences. Never writes into game resources.
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct LaunchPreferences {
    pub mode: String,
    pub name: String,
    pub server: String,
    pub preset: String,
    pub map: String,
}
impl Default for LaunchPreferences {
    fn default() -> Self { Self { mode: "online".into(), name: "玩家1".into(), server: String::new(), preset: "npc_male".into(), map: "gtav".into() } }
}
impl LaunchPreferences {
    pub fn validate(mut self) -> Result<Self, String> {
        if !matches!(self.mode.as_str(), "online" | "story" | "sandbox") { return Err("启动模式无效。".into()); }
        if !matches!(self.map.as_str(), "gtav" | "env_test") { return Err("沙盒地图无效。".into()); }
        if !matches!(self.preset.as_str(), "npc_male" | "npc_female" | "freemode_male" | "freemode_female") { return Err("角色预设无效。".into()); }
        self.name = self.name.trim().into();
        if self.name.is_empty() || self.name.chars().count() > 24 || self.name.chars().any(char::is_control) {
            if self.mode=="online" {return Err("请输入 1 至 24 个字符的昵称。".into());}
            self.name=Self::default().name;
        }
        if self.mode=="online" && !self.server.trim().is_empty() { self.server = normalize_server(&self.server)?; }
        Ok(self)
    }
    pub fn entry_path(&self, seed: u32) -> Result<String, String> {
        let mut url = Url::parse("https://launcher.invalid/").unwrap();
        if self.mode == "online" { url.set_path("/play/"); }
        let mut query = url.query_pairs_mut();
        query.append_pair("launcher", "1");
        if self.mode == "online" {
            if self.server.is_empty() { return Err("请选择服务器线路或输入有效地址。".into()); }
            query.append_pair("name", &self.name).append_pair("server", &self.server)
                .append_pair("preset", &self.preset).append_pair("seed", &seed.to_string());
        } else {
            query.append_pair("mode", &self.mode);
            if self.mode == "sandbox" { query.append_pair("map", &self.map); }
        }
        drop(query);
        Ok(format!("{}?{}", url.path(), url.query().unwrap()))
    }
}
pub fn normalize_server(value: &str) -> Result<String, String> {
    let input=value.trim();
    if input.is_empty() || input.len()>2048 || input.chars().any(char::is_whitespace) || input.starts_with('/') { return Err("请输入有效的服务器 IP 或地址。".into()); }
    let explicit=input.contains("://");
    let address=if explicit { input.to_owned() } else { format!("wss://{input}") };
    let mut url=Url::parse(&address).map_err(|_|"服务器地址格式无效。")?;
    let allowed_transport = url.scheme() == "wss";
    #[cfg(debug_assertions)]
    let allowed_transport = allowed_transport || (std::env::var_os("GTA_DEV_CONFIG_PATH").is_some()
        && url.scheme() == "ws" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")));
    if !allowed_transport || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return Err("请输入不含用户名、密码或片段的 wss:// 地址。".into()); }
    if url.path()=="/" { url.set_path("/ws"); }
    Ok(url.into())
}
pub fn server_endpoint(server: &crate::remote_config::ServerInfo) -> Result<String, String> {
    if let Some(explicit)=&server.websocket_url { return normalize_server(explicit); }
    let address=normalize_server(&server.address)?;
    if !server.address.contains("://") {
        if let Some(health)=&server.health_url {
            if let (Ok(mut health),Ok(target))=(Url::parse(health),Url::parse(&address)) {
                if health.scheme()=="https" && health.host_str()==target.host_str() && health.port_or_known_default()==target.port_or_known_default()
                    && health.username().is_empty() && health.password().is_none() && health.fragment().is_none() {
                    let path=health.path().trim_end_matches('/').to_string();
                    if let Some(prefix)=path.strip_suffix("/health") { health.set_scheme("wss").unwrap();health.set_path(&format!("{prefix}/ws"));return normalize_server(health.as_str()); }
                }
            }
        }
    }
    Ok(address)
}

pub fn configured_server(config: &crate::remote_config::RemoteConfig, requested: &str) -> Option<crate::remote_config::ServerInfo> {
    let input=requested.trim();
    if input.is_empty() {return config.server.clone();}
    config.servers.iter().find(|server|server.address==input || server_endpoint(server).ok().as_deref()==Some(input)).cloned()
}
pub fn game_url(base: &str, entry: &str) -> Result<String,String> {
    let base=Url::parse(base).map_err(|_|"游戏入口地址无效。")?;
    let url=base.join(entry).map_err(|_|"游戏入口地址无效。")?;
    if url.origin()!=base.origin() || !matches!(url.path(),"/"|"/play/") { return Err("游戏入口地址无效。".into()); }
    Ok(url.into())
}
pub fn guide_url(base: &str, entry: &str) -> Result<String,String> {
    let mut url=Url::parse(base).map_err(|_|"游戏入口地址无效。")?;
    url.query_pairs_mut().append_pair("target",entry);
    Ok(url.into())
}
pub fn valid_online_query(query: &str) -> bool {
    let mut pairs=std::collections::HashMap::new();
    for (key,value) in url::form_urlencoded::parse(query.as_bytes()) {
        if !matches!(key.as_ref(),"launcher"|"mode"|"name"|"server"|"preset"|"seed") || pairs.insert(key.into_owned(),value.into_owned()).is_some() {return false;}
    }
    if pairs.get("launcher").map(String::as_str)!=Some("1")
        || pairs.get("mode").is_some_and(|mode|mode!="online") {return false;}
    // Entry identity is removed from the URL after saving the session. Keep
    // only its display marker on refresh, without accepting partial identity.
    if ["name","server","preset","seed"].iter().all(|key|!pairs.contains_key(*key)) {return true;}
    if pairs.len()!=5+usize::from(pairs.contains_key("mode")) {return false;}
    let value=LaunchPreferences { name:pairs.get("name").cloned().unwrap_or_default(), server:pairs.get("server").cloned().unwrap_or_default(),preset:pairs.get("preset").cloned().unwrap_or_default(),..Default::default() };
    !value.server.is_empty() && value.validate().is_ok() && pairs.get("seed").and_then(|value|value.parse::<u32>().ok()).is_some()
}
