//! Plugins: JS/HTML bundles run by the UI in sandboxed iframes.
//!
//! Installed into `<config>/plugins/<id>/` (a folder with `plugin.json`), enabled state and the
//! permissions the user granted live in `plugins.json`, per-plugin data in `plugin-data/<id>.json`.
//! Plugin files reach the iframes through the `tdplugin` URI scheme (`serve`), never through IPC:
//! plugin frames have no access to Tauri commands. Permission checks happen in the UI, which is
//! the only caller of the commands below.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// Plugin API version this build implements (`apiVersion` in plugin.json).
pub const API_VERSION: u32 = 1;

/// Everything a plugin may ask for. Mirrored by `PERMISSIONS` in `src/lib/plugins/types.ts`.
pub const PERMISSIONS: &[&str] = &[
    "terminal.read",
    "terminal.write",
    "server.exec",
    "files.read",
    "files.write",
    "servers.read",
    "clipboard.write",
    "openUrl",
];

const MANIFEST: &str = "plugin.json";
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
const MAX_FILES: usize = 2000;
const MAX_STORAGE_BYTES: usize = 5 * 1024 * 1024;

/// `plugin.json`. Display texts (`name`, `description`, command titles…) may be a string or a
/// `{ "ru": …, "en": … }` object; the UI picks the language. `contributes` is read by the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: Value,
    pub version: String,
    #[serde(default)]
    pub description: Value,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    pub api_version: u32,
    #[serde(default = "default_main")]
    pub main: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: Value,
}

fn default_main() -> String {
    "main.js".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PluginState {
    enabled: bool,
    granted: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// Folder name (equals `manifest.id` for a valid plugin).
    pub id: String,
    pub manifest: Option<Manifest>,
    pub enabled: bool,
    /// Permissions the user granted (always a subset of `manifest.permissions`).
    pub granted: Vec<String>,
    /// Why the plugin can't be loaded (bad manifest…); it is then never enabled.
    pub error: Option<String>,
    pub path: String,
}

pub struct Plugins {
    dir: PathBuf,
    data_dir: PathBuf,
    state_path: PathBuf,
    state: Mutex<HashMap<String, PluginState>>,
}

impl Plugins {
    pub fn load(config_dir: &Path) -> Self {
        let dir = config_dir.join("plugins");
        let data_dir = config_dir.join("plugin-data");
        let _ = fs::create_dir_all(&dir);
        let state_path = config_dir.join("plugins.json");
        let state = fs::read_to_string(&state_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { dir, data_dir, state_path, state: Mutex::new(state) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn save_state(&self, state: &HashMap<String, PluginState>) -> Result<(), String> {
        let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        fs::write(&self.state_path, json).map_err(|e| e.to_string())
    }

    /// Every folder in the plugins directory, valid or not (a broken one is shown with its error).
    pub fn list(&self) -> Vec<PluginInfo> {
        let mut out: Vec<PluginInfo> = fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| {
                let id = e.file_name().to_string_lossy().into_owned();
                (!id.starts_with('.')).then(|| self.info(&id))
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    fn info(&self, id: &str) -> PluginInfo {
        let path = self.dir.join(id);
        let st = self.state.lock().unwrap().get(id).cloned().unwrap_or_default();
        let (manifest, error) = match read_manifest_dir(&path).and_then(|m| {
            if m.id != id {
                return Err(tr!("id в plugin.json («{}») не совпадает с именем папки", "The id in plugin.json (\"{}\") doesn't match the folder name", m.id));
            }
            Ok(m)
        }) {
            Ok(m) => (Some(m), None),
            Err(e) => (None, Some(e)),
        };
        let granted = match &manifest {
            Some(m) => st.granted.into_iter().filter(|p| m.permissions.contains(p)).collect(),
            None => Vec::new(),
        };
        PluginInfo { id: id.to_string(), enabled: st.enabled && manifest.is_some(), manifest, granted, error, path: path.to_string_lossy().into_owned() }
    }

    /// Reads the manifest of a plugin folder or `.zip` without installing it (for the
    /// confirmation dialog with its permissions).
    pub fn inspect(&self, source: &Path) -> Result<Manifest, String> {
        if is_zip(source) {
            let mut archive = open_zip(source)?;
            let prefix = zip_root(&mut archive)?;
            let mut text = String::new();
            archive
                .by_name(&format!("{prefix}{MANIFEST}"))
                .map_err(|e| e.to_string())?
                .take(1024 * 1024)
                .read_to_string(&mut text)
                .map_err(|e| tr!("plugin.json не читается: {e}", "plugin.json can't be read: {e}"))?;
            parse_manifest(&text)
        } else {
            read_manifest_dir(source)
        }
    }

    /// Copies (or unpacks) a plugin into the plugins folder, replacing an installed one with the
    /// same id. It is enabled with `granted` ∩ requested permissions.
    pub fn install(&self, source: &Path, granted: Vec<String>) -> Result<PluginInfo, String> {
        let manifest = self.inspect(source)?;
        let id = manifest.id.clone();
        let dest = self.dir.join(&id);
        if source.canonicalize().ok() == dest.canonicalize().ok() {
            // Already in place (a plugin developed right in the plugins folder): just enable it.
            return self.set_enabled(&id, true, Some(granted));
        }
        let staging = self.dir.join(format!(".install-{}", uuid::Uuid::new_v4()));
        let res = if is_zip(source) { unpack_zip(source, &staging) } else { copy_dir(source, &staging) }.and_then(|_| {
            // The unpacked copy must be valid on its own (main file present…).
            read_manifest_dir(&staging).map(|_| ())
        });
        if let Err(e) = res {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| {
                let _ = fs::remove_dir_all(&staging);
                tr!("Не удалось удалить старую версию: {e}", "Couldn't remove the old version: {e}")
            })?;
        }
        fs::rename(&staging, &dest).map_err(|e| e.to_string())?;
        self.set_enabled(&id, true, Some(granted))
    }

    /// `granted`: None keeps the current grants.
    pub fn set_enabled(&self, id: &str, enabled: bool, granted: Option<Vec<String>>) -> Result<PluginInfo, String> {
        let info = self.info(id);
        let Some(m) = &info.manifest else {
            return Err(info.error.unwrap_or_else(|| tr!("Плагин не найден", "Plugin not found")));
        };
        let mut state = self.state.lock().unwrap();
        let st = state.entry(id.to_string()).or_default();
        st.enabled = enabled;
        if let Some(g) = granted {
            st.granted = g.into_iter().filter(|p| m.permissions.contains(p)).collect();
        }
        self.save_state(&state)?;
        drop(state);
        Ok(self.info(id))
    }

    pub fn uninstall(&self, id: &str) -> Result<(), String> {
        check_id(id)?;
        let path = self.dir.join(id);
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        }
        let _ = fs::remove_file(self.data_dir.join(format!("{id}.json")));
        let mut state = self.state.lock().unwrap();
        state.remove(id);
        self.save_state(&state)
    }

    pub fn storage_get(&self, id: &str) -> Result<Value, String> {
        check_id(id)?;
        let text = match fs::read_to_string(self.data_dir.join(format!("{id}.json"))) {
            Ok(t) => t,
            Err(_) => return Ok(Value::Object(Default::default())),
        };
        Ok(serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(Default::default())))
    }

    pub fn storage_set(&self, id: &str, value: &Value) -> Result<(), String> {
        check_id(id)?;
        let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
        if json.len() > MAX_STORAGE_BYTES {
            return Err(tr!("Данные плагина больше {} МБ", "Plugin data is over {} MB", MAX_STORAGE_BYTES / 1024 / 1024));
        }
        fs::create_dir_all(&self.data_dir).map_err(|e| e.to_string())?;
        fs::write(self.data_dir.join(format!("{id}.json")), json).map_err(|e| e.to_string())
    }

    /// A `tdplugin` request: `/<id>/<file>` of an enabled plugin, the generated `/<id>/__host.html`
    /// (runtime + the plugin's main script) or the shared `/__termdock/…` files.
    pub fn serve(&self, url_path: &str) -> Response {
        let path = percent_decode(url_path);
        let path = path.trim_start_matches('/');
        let (first, rest) = path.split_once('/').unwrap_or((path, ""));
        if first == "__termdock" {
            return match rest {
                "runtime.js" => Response::ok("text/javascript", RUNTIME_JS.as_bytes().to_vec()),
                "theme.css" => Response::ok("text/css", THEME_CSS.as_bytes().to_vec()),
                _ => Response::not_found(),
            };
        }
        let info = self.info(first);
        let (Some(m), true) = (&info.manifest, info.enabled) else { return Response::not_found() };
        let root = self.dir.join(first);
        if rest == "__host.html" {
            let html = format!(
                "<!doctype html><html><head><meta charset=\"utf-8\"><script src=\"/__termdock/runtime.js\"></script></head><body><script src=\"/{first}/{}\"></script></body></html>",
                m.main
            );
            return Response::ok("text/html; charset=utf-8", html.into_bytes());
        }
        let Some(file) = safe_join(&root, rest) else { return Response::not_found() };
        let Ok(bytes) = fs::read(&file) else { return Response::not_found() };
        let mime = mime_type(&file);
        if mime.starts_with("text/html") {
            return Response::ok(mime, inject_runtime(&String::from_utf8_lossy(&bytes)).into_bytes());
        }
        Response::ok(mime, bytes)
    }
}

pub struct Response {
    pub status: u16,
    pub mime: &'static str,
    pub body: Vec<u8>,
}

impl Response {
    fn ok(mime: &'static str, body: Vec<u8>) -> Self {
        Self { status: 200, mime, body }
    }
    fn not_found() -> Self {
        Self { status: 404, mime: "text/plain", body: b"not found".to_vec() }
    }
}

/// CSP of every plugin document: own files only, no network, no nested frames. Both URL forms of
/// the scheme are listed (`tdplugin://localhost` on Linux/macOS, `http://tdplugin.localhost` on Windows).
pub const PLUGIN_CSP: &str = "default-src 'none'; \
    script-src tdplugin: http://tdplugin.localhost 'unsafe-inline'; \
    style-src tdplugin: http://tdplugin.localhost 'unsafe-inline'; \
    img-src tdplugin: http://tdplugin.localhost data: blob:; \
    font-src tdplugin: http://tdplugin.localhost data:; \
    media-src tdplugin: http://tdplugin.localhost data: blob:; \
    connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

const RUNTIME_JS: &str = include_str!("plugin_runtime/runtime.js");
const THEME_CSS: &str = include_str!("plugin_runtime/theme.css");

/// Plugin pages get the runtime (`window.termdock`) and the app theme before their own code.
fn inject_runtime(html: &str) -> String {
    let tags = "<link rel=\"stylesheet\" href=\"/__termdock/theme.css\"><script src=\"/__termdock/runtime.js\"></script>";
    let lower = html.to_ascii_lowercase();
    if let Some(i) = lower.find("<head>") {
        let at = i + "<head>".len();
        return format!("{}{tags}{}", &html[..at], &html[at..]);
    }
    if let Some(i) = lower.find("<head ") {
        if let Some(end) = lower[i..].find('>') {
            let at = i + end + 1;
            return format!("{}{tags}{}", &html[..at], &html[at..]);
        }
    }
    format!("{tags}{html}")
}

fn check_id(id: &str) -> Result<(), String> {
    let ok = (2..=64).contains(&id.len())
        && id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(tr!(
            "Неверный id плагина «{}»: нужны 2–64 символа a-z, 0-9, «-», «_», «.»",
            "Invalid plugin id \"{}\": use 2–64 characters a-z, 0-9, \"-\", \"_\", \".\"",
            id
        ))
    }
}

/// A relative path inside the plugin (no `..`, not absolute).
fn relative_ok(p: &str) -> bool {
    !p.is_empty() && Path::new(p).components().all(|c| matches!(c, Component::Normal(_)))
}

pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_json::from_str(text).map_err(|e| tr!("Ошибка в plugin.json: {e}", "Error in plugin.json: {e}"))?;
    check_id(&m.id)?;
    if m.api_version > API_VERSION || m.api_version == 0 {
        return Err(tr!(
            "Плагин рассчитан на API версии {}, а эта версия TermDock поддерживает {}. Обновите TermDock.",
            "The plugin needs API version {}, this TermDock supports {}. Update TermDock.",
            m.api_version,
            API_VERSION
        ));
    }
    if m.version.trim().is_empty() {
        return Err(tr!("В plugin.json не указана версия", "plugin.json has no version"));
    }
    if !relative_ok(&m.main) {
        return Err(tr!("Неверный путь main в plugin.json: {}", "Invalid main path in plugin.json: {}", m.main));
    }
    if let Some(p) = m.permissions.iter().find(|p| !PERMISSIONS.contains(&p.as_str())) {
        return Err(tr!("Неизвестное разрешение «{}»", "Unknown permission \"{}\"", p));
    }
    Ok(m)
}

fn read_manifest_dir(dir: &Path) -> Result<Manifest, String> {
    let text = fs::read_to_string(dir.join(MANIFEST)).map_err(|_| tr!("В папке нет plugin.json", "The folder has no plugin.json"))?;
    let m = parse_manifest(&text)?;
    if !dir.join(&m.main).is_file() {
        return Err(tr!("Нет главного файла плагина {}", "The plugin's main file {} is missing", m.main));
    }
    Ok(m)
}

/// `rel` inside `root`, following no links out of it.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    if !relative_ok(rel) {
        return None;
    }
    let p = root.join(rel).canonicalize().ok()?;
    let root = root.canonicalize().ok()?;
    (p.starts_with(&root) && p.is_file()).then_some(p)
}

fn mime_type(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_zip(p: &Path) -> bool {
    p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"))
}

fn open_zip(p: &Path) -> Result<zip::ZipArchive<fs::File>, String> {
    let f = fs::File::open(p).map_err(|e| e.to_string())?;
    zip::ZipArchive::new(f).map_err(|e| tr!("Не удалось открыть архив: {e}", "Couldn't open the archive: {e}"))
}

/// Where plugin.json sits in the archive: at the root, or in a single top folder
/// (what zipping a folder usually produces). Returns the prefix ("" or "folder/").
fn zip_root(archive: &mut zip::ZipArchive<fs::File>) -> Result<String, String> {
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    if names.iter().any(|n| n == MANIFEST) {
        return Ok(String::new());
    }
    names
        .iter()
        .filter_map(|n| n.strip_suffix(MANIFEST).filter(|p| p.ends_with('/') && p.matches('/').count() == 1))
        .min()
        .map(str::to_string)
        .ok_or_else(|| tr!("В архиве нет plugin.json", "The archive has no plugin.json"))
}

fn unpack_zip(src: &Path, dest: &Path) -> Result<(), String> {
    let mut archive = open_zip(src)?;
    let prefix = zip_root(&mut archive)?;
    if archive.len() > MAX_FILES {
        return Err(too_big());
    }
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name rejects absolute paths and `..`.
        let Some(name) = entry.enclosed_name() else { continue };
        let Ok(rel) = name.strip_prefix(&prefix) else { continue };
        if rel.as_os_str().is_empty() || entry.is_symlink() {
            continue;
        }
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = fs::File::create(&out).map_err(|e| e.to_string())?;
        // Count real bytes, not the header's size: the header can lie.
        let left = MAX_TOTAL_BYTES.saturating_sub(total) + 1;
        let n = std::io::copy(&mut (&mut entry).take(left), &mut file).map_err(|e| e.to_string())?;
        total += n;
        if total > MAX_TOTAL_BYTES {
            return Err(too_big());
        }
    }
    Ok(())
}

fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    let mut total = 0u64;
    let mut count = 0usize;
    fn walk(src: &Path, dest: &Path, total: &mut u64, count: &mut usize) -> Result<(), String> {
        fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            // Version control and dependency folders are not part of a plugin.
            if matches!(name.to_str(), Some(".git" | "node_modules")) {
                continue;
            }
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            let to = dest.join(&name);
            *count += 1;
            if *count > MAX_FILES {
                return Err(too_big());
            }
            if kind.is_dir() {
                walk(&entry.path(), &to, total, count)?;
            } else if kind.is_file() {
                *total += entry.metadata().map(|m| m.len()).unwrap_or(0);
                if *total > MAX_TOTAL_BYTES {
                    return Err(too_big());
                }
                fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
            }
            // Symlinks are skipped: they could point anywhere on the disk.
        }
        Ok(())
    }
    walk(src, dest, &mut total, &mut count)
}

fn too_big() -> String {
    tr!(
        "Плагин слишком большой (больше {} МБ или {} файлов)",
        "The plugin is too big (over {} MB or {} files)",
        MAX_TOTAL_BYTES / 1024 / 1024,
        MAX_FILES
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(extra: &str) -> String {
        format!(r#"{{"id":"hello-world","name":"Hello","version":"1.0.0","apiVersion":1{extra}}}"#)
    }

    #[test]
    fn manifest_validation() {
        assert!(parse_manifest(&manifest("")).is_ok());
        assert_eq!(parse_manifest(&manifest("")).unwrap().main, "main.js");
        assert!(parse_manifest(&manifest(r#","permissions":["terminal.read"]"#)).is_ok());
        assert!(parse_manifest(&manifest(r#","permissions":["root"]"#)).is_err());
        assert!(parse_manifest(&manifest(r#","main":"../evil.js""#)).is_err());
        assert!(parse_manifest(&manifest(r#","main":"/etc/passwd""#)).is_err());
        assert!(parse_manifest(r#"{"id":"Bad Id","name":"x","version":"1","apiVersion":1}"#).is_err());
        assert!(parse_manifest(r#"{"id":"ok","name":"x","version":"1","apiVersion":99}"#).is_err());
    }

    #[test]
    fn ids() {
        assert!(check_id("my-plugin.v2").is_ok());
        for bad in ["", "a", "-x", "Upper", "a/b", "..", "a b"] {
            assert!(check_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn runtime_injection() {
        assert!(inject_runtime("<html><head><title>x</title></head>").starts_with("<html><head><link"));
        assert!(inject_runtime("<HTML><HEAD lang=\"en\">x").contains("<HEAD lang=\"en\"><link"));
        assert!(inject_runtime("<p>hi</p>").starts_with("<link"));
    }

    #[test]
    fn decoding_and_paths() {
        assert_eq!(percent_decode("/a%20b/c%2Fd"), "/a b/c/d");
        assert_eq!(percent_decode("/bad%2"), "/bad%2");
        assert!(relative_ok("panel/index.html"));
        assert!(!relative_ok("../x"));
        assert!(!relative_ok(""));
    }

    #[test]
    fn install_serve_uninstall() {
        let tmp = std::env::temp_dir().join(format!("td-plugins-{}", uuid::Uuid::new_v4()));
        let src = tmp.join("src");
        fs::create_dir_all(src.join("ui")).unwrap();
        fs::write(src.join(MANIFEST), manifest(r#","permissions":["terminal.read","server.exec"]"#)).unwrap();
        fs::write(src.join("main.js"), "1").unwrap();
        fs::write(src.join("ui/panel.html"), "<head></head>").unwrap();
        let config = tmp.join("config");
        let p = Plugins::load(&config);

        // Granting something not requested is ignored.
        let info = p.install(&src, vec!["terminal.read".into(), "openUrl".into()]).unwrap();
        assert!(info.enabled);
        assert_eq!(info.granted, vec!["terminal.read"]);
        assert_eq!(p.list().len(), 1);

        assert_eq!(p.serve("/hello-world/main.js").status, 200);
        assert!(String::from_utf8(p.serve("/hello-world/ui/panel.html").body).unwrap().contains("runtime.js"));
        assert!(String::from_utf8(p.serve("/hello-world/__host.html").body).unwrap().contains("/hello-world/main.js"));
        assert_eq!(p.serve("/hello-world/../plugins.json").status, 404);
        assert_eq!(p.serve("/hello-world/%2e%2e/plugins.json").status, 404);
        assert_eq!(p.serve("/__termdock/runtime.js").status, 200);

        // Disabled plugins are not served.
        p.set_enabled("hello-world", false, None).unwrap();
        assert_eq!(p.serve("/hello-world/main.js").status, 404);

        p.storage_set("hello-world", &serde_json::json!({"a": 1})).unwrap();
        assert_eq!(p.storage_get("hello-world").unwrap()["a"], 1);

        p.uninstall("hello-world").unwrap();
        assert!(p.list().is_empty());
        assert_eq!(p.storage_get("hello-world").unwrap(), serde_json::json!({}));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn zip_in_a_top_folder() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!("td-plugins-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let zpath = tmp.join("p.zip");
        let mut w = zip::ZipWriter::new(fs::File::create(&zpath).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("hello/plugin.json", opts).unwrap();
        w.write_all(manifest("").as_bytes()).unwrap();
        w.start_file("hello/main.js", opts).unwrap();
        w.write_all(b"1").unwrap();
        w.start_file("../evil.js", opts).unwrap();
        w.write_all(b"1").unwrap();
        w.finish().unwrap();

        let p = Plugins::load(&tmp.join("config"));
        assert_eq!(p.inspect(&zpath).unwrap().id, "hello-world");
        p.install(&zpath, vec![]).unwrap();
        assert!(tmp.join("config/plugins/hello-world/main.js").is_file());
        assert!(!tmp.join("config/plugins/evil.js").exists());
        assert!(!tmp.join("config/evil.js").exists());
        let _ = fs::remove_dir_all(&tmp);
    }
}
