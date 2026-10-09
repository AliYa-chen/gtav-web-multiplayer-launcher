//! Launcher-owned language settings shared by every HTTP/HTTPS client.
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct LanguageConfig {
    pub preference: String,
    pub resolved: String,
    pub revision: u64,
}
pub type SharedLanguage = Arc<RwLock<LanguageConfig>>;

pub fn resolve(value: &str) -> &'static str {
    if value.trim().to_ascii_lowercase().starts_with("zh") { "zh-CN" } else { "en" }
}

fn system_language() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "-g", "AppleLanguages"]).output() {
            if output.status.success() {
                let value = String::from_utf8_lossy(&output.stdout);
                if let Some(first) = value.split(['(', ')', ',', '"', '\n', ' '])
                    .find(|part| part.contains('-') || part == &"en" || part == &"zh") { return resolve(first).into(); }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(output) = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "(Get-UICulture).Name"])
            .creation_flags(0x08000000).output() {
            if output.status.success() { return resolve(&String::from_utf8_lossy(&output.stdout)).into(); }
        }
    }
    // Native UI preferences take priority over a terminal's locale.
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() && value != "C" && value != "POSIX" { return resolve(&value).into(); }
        }
    }
    "en".into()
}
impl Default for LanguageConfig {
    fn default() -> Self { Self { preference: "system".into(), resolved: system_language(), revision: 1 } }
}
impl LanguageConfig {
    pub fn with_preference(preference: &str, revision: u64) -> Result<Self, String> {
        if !matches!(preference, "system" | "zh-CN" | "en") { return Err("Unsupported language preference.".into()); }
        Ok(Self { preference: preference.into(), resolved: if preference == "system" { system_language() } else { preference.into() }, revision })
    }
    pub fn text<'a>(&self, chinese: &'a str, english: &'a str) -> &'a str {
        if self.resolved == "zh-CN" { chinese } else { english }
    }
}
pub fn shared() -> SharedLanguage { Arc::new(RwLock::new(LanguageConfig::default())) }
pub fn snapshot(shared: &SharedLanguage) -> LanguageConfig {
    shared.read().unwrap_or_else(|error| error.into_inner()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supported_preferences_and_system_fallback_are_bounded() {
        assert_eq!(resolve("zh-Hant-TW"), "zh-CN"); assert_eq!(resolve("EN-us"), "en");
        assert_eq!(resolve("fr-FR"), "en");
        assert!(LanguageConfig::with_preference("../../data",2).is_err());
        assert_eq!(LanguageConfig::with_preference("en",2).unwrap().resolved,"en");
        assert_eq!(LanguageConfig::with_preference("zh-CN",3).unwrap().revision,3);
    }
    #[test]
    fn all_ports_observe_one_live_language_setting() {
        let language=shared();let another=language.clone();
        *language.write().unwrap()=LanguageConfig::with_preference("en",2).unwrap();
        assert_eq!(snapshot(&another).resolved,"en");assert_eq!(snapshot(&another).revision,2);
    }
}
