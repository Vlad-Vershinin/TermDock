//! Global app settings: `settings.json` in the app config dir.
//! Every field has a default, so old / partial files keep loading.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    // ---- interface ----
    /// "ru" | "en".
    pub language: String,
    /// Webview zoom, percent.
    pub ui_scale: u32,

    // ---- terminal ----
    /// Empty = the built-in monospace font stack.
    pub term_font_family: String,
    pub term_font_size: u32,
    pub term_line_height: f64,
    /// "block" | "bar" | "underline".
    pub term_cursor_style: String,
    pub term_cursor_blink: bool,
    pub term_scrollback: u32,
    pub term_copy_on_select: bool,
    /// "copyPaste" (copy the selection, otherwise paste) | "paste" | "none".
    pub term_right_click: String,

    // ---- files ----
    /// Where "download to the downloads folder" saves; empty = the OS Downloads folder.
    pub download_dir: String,
    /// Ask for a folder on every such download.
    pub ask_download_dir: bool,
    /// Show dot-files in new file panes.
    pub show_hidden: bool,
    /// Folder the local pane opens in: "last" (last visited) | "downloads".
    pub local_start_dir: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: "ru".into(),
            ui_scale: 100,
            term_font_family: String::new(),
            term_font_size: 14,
            term_line_height: 1.0,
            term_cursor_style: "block".into(),
            term_cursor_blink: true,
            term_scrollback: 10_000,
            term_copy_on_select: false,
            term_right_click: "copyPaste".into(),
            download_dir: String::new(),
            ask_download_dir: false,
            show_hidden: false,
            local_start_dir: "last".into(),
        }
    }
}

fn one_of(v: &mut String, allowed: &[&str], def: &str) {
    if !allowed.contains(&v.as_str()) {
        *v = def.into();
    }
}

impl Settings {
    /// Clamps numbers and replaces unknown enum values, so the UI never gets nonsense.
    pub fn sanitize(mut self) -> Self {
        let d = Self::default();
        one_of(&mut self.language, &["ru", "en"], &d.language);
        self.ui_scale = self.ui_scale.clamp(70, 200);
        self.term_font_family = self.term_font_family.trim().to_string();
        self.term_font_size = self.term_font_size.clamp(8, 32);
        self.term_line_height = if self.term_line_height.is_finite() { self.term_line_height.clamp(1.0, 2.0) } else { d.term_line_height };
        one_of(&mut self.term_cursor_style, &["block", "bar", "underline"], &d.term_cursor_style);
        self.term_scrollback = self.term_scrollback.min(1_000_000);
        one_of(&mut self.term_right_click, &["copyPaste", "paste", "none"], &d.term_right_click);
        self.download_dir = self.download_dir.trim().to_string();
        one_of(&mut self.local_start_dir, &["last", "downloads"], &d.local_start_dir);
        self
    }
}

pub struct SettingsStore {
    path: PathBuf,
    value: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("settings.json");
        let value = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default()
            .sanitize();
        Self { path, value: Mutex::new(value) }
    }

    pub fn get(&self) -> Settings {
        self.value.lock().unwrap().clone()
    }

    pub fn save(&self, s: Settings) -> Result<Settings, String> {
        let s = s.sanitize();
        let json = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &self.path)).map_err(|e| format!("Не удалось сохранить настройки: {e}"))?;
        *self.value.lock().unwrap() = s.clone();
        Ok(s)
    }
}

/// Expands a leading `~` to the home directory.
fn expand_home(p: &str) -> PathBuf {
    if p == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(p));
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(h) = dirs::home_dir() {
            return h.join(rest);
        }
    }
    PathBuf::from(p)
}

/// Download folder: the server's own, else the global setting, else the OS Downloads folder
/// (or home when the OS has none).
pub fn resolve_download_dir(server_dir: Option<&str>, global: &str) -> PathBuf {
    let pick = [server_dir.unwrap_or(""), global].into_iter().map(str::trim).find(|d| !d.is_empty());
    match pick {
        Some(d) => expand_home(d),
        None => dirs::download_dir().or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from(".")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_partial_files_load_with_defaults() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings::default());
        let s: Settings = serde_json::from_str(r#"{"termFontSize": 18, "unknownKey": 1}"#).unwrap();
        assert_eq!(s.term_font_size, 18);
        assert_eq!(s.term_scrollback, 10_000);
    }

    #[test]
    fn sanitize_clamps_and_fixes_enums() {
        let s = Settings {
            term_font_size: 100,
            term_line_height: 0.2,
            term_cursor_style: "beam".into(),
            language: "de".into(),
            ui_scale: 10,
            term_right_click: "x".into(),
            ..Default::default()
        }
        .sanitize();
        assert_eq!(s.term_font_size, 32);
        assert_eq!(s.term_line_height, 1.0);
        assert_eq!(s.term_cursor_style, "block");
        assert_eq!(s.language, "ru");
        assert_eq!(s.ui_scale, 70);
        assert_eq!(s.term_right_click, "copyPaste");
    }

    #[test]
    fn save_and_reload_roundtrip() {
        let dir = std::env::temp_dir().join(format!("td-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::load(&dir);
        assert_eq!(store.get(), Settings::default());
        store.save(Settings { term_font_size: 16, download_dir: " /tmp/dl ".into(), ..Default::default() }).unwrap();
        let again = SettingsStore::load(&dir);
        assert_eq!(again.get().term_font_size, 16);
        assert_eq!(again.get().download_dir, "/tmp/dl");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_dir_precedence() {
        assert_eq!(resolve_download_dir(Some("/srv/a"), "/global"), PathBuf::from("/srv/a"));
        assert_eq!(resolve_download_dir(Some("  "), "/global"), PathBuf::from("/global"));
        assert_eq!(resolve_download_dir(None, "/global"), PathBuf::from("/global"));
        if let Some(h) = dirs::home_dir() {
            assert_eq!(resolve_download_dir(None, "~/dl"), h.join("dl"));
        }
        assert!(!resolve_download_dir(None, "").as_os_str().is_empty());
    }
}
