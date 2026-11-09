//! Saved servers: stored as JSON in the app config dir.
//! Secrets (passwords, key passphrases) go to the OS keychain, never to the JSON file.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const KEYRING_SERVICE: &str = "TermDock";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    #[default]
    Password,
    Key,
    /// Keys from a running ssh-agent (OpenSSH agent / Pageant on Windows).
    Agent,
}

/// Jump host (like ssh -J): either a saved server or a host described right here.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Jump {
    /// A saved server to connect through. When set, the fields below are ignored.
    pub server_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub key_path: Option<String>,
    /// Secret of a custom jump host is stored in the keychain under `jump_secret_id(server)`.
    pub has_secret: bool,
}

impl Jump {
    pub fn is_custom(&self) -> bool {
        self.server_id.as_deref().is_none_or(str::is_empty) && !self.host.trim().is_empty()
    }
}

/// Keychain id of the secret of a server's custom jump host.
pub fn jump_secret_id(server_id: &str) -> String {
    format!("{server_id}#jump")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind {
    /// -L: a local port → an address reachable from the server.
    #[default]
    Local,
    /// -R: a port on the server → an address reachable from this computer.
    Remote,
    /// -D: a local SOCKS5 proxy whose connections go out from the server.
    Dynamic,
}

/// A port forward. For `Remote` the bind address is on the server and the destination is local.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Forward {
    pub id: String,
    pub kind: ForwardKind,
    pub bind_host: String,
    pub bind_port: u16,
    /// Unused for `Dynamic`.
    pub dest_host: String,
    pub dest_port: u16,
    pub enabled: bool,
}

impl Default for Forward {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: ForwardKind::Local,
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            dest_host: String::new(),
            dest_port: 0,
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
    /// Folder name; None or empty = not in a folder.
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// Remote directory to open in the file panel (defaults to home).
    #[serde(default)]
    pub remote_dir: Option<String>,
    /// Local folder for "download to the downloads folder"; overrides the global setting.
    #[serde(default)]
    pub download_dir: Option<String>,
    /// Whether a secret (password / passphrase) is saved in the keychain.
    #[serde(default)]
    pub has_secret: bool,
    /// Connect through this jump host.
    #[serde(default)]
    pub jump: Option<Jump>,
    /// Saved script (id) to run right after connecting.
    #[serde(default)]
    pub connect_script: Option<String>,
    /// Port forwards started with every connection.
    #[serde(default)]
    pub forwards: Vec<Forward>,
}

impl Server {
    pub fn folder(&self) -> Option<&str> {
        self.group.as_deref().map(str::trim).filter(|g| !g.is_empty())
    }
}

pub struct Store {
    path: PathBuf,
    servers: Mutex<Vec<Server>>,
    folders_path: PathBuf,
    /// Folder names in display order (folders may be empty).
    folders: Mutex<Vec<String>>,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("servers.json");
        let servers = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let folders_path = dir.join("folders.json");
        let folders = std::fs::read_to_string(&folders_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, servers: Mutex::new(servers), folders_path, folders: Mutex::new(folders) }
    }

    pub fn list(&self) -> Vec<Server> {
        self.servers.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<Server> {
        self.servers.lock().unwrap().iter().find(|s| s.id == id).cloned()
    }

    pub fn upsert(&self, server: Server) -> Result<Server, String> {
        if let Some(f) = server.folder() {
            let mut folders = self.folders.lock().unwrap();
            if !folders.iter().any(|x| x == f) {
                folders.push(f.to_string());
                write_json(&self.folders_path, &*folders)?;
            }
        }
        let mut list = self.servers.lock().unwrap();
        match list.iter_mut().find(|s| s.id == server.id) {
            Some(existing) => *existing = server.clone(),
            None => list.push(server.clone()),
        }
        self.persist(&list)?;
        Ok(server)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut list = self.servers.lock().unwrap();
        list.retain(|s| s.id != id);
        // Servers that went through the deleted one now connect directly.
        for s in list.iter_mut() {
            if s.jump.as_ref().and_then(|j| j.server_id.as_deref()) == Some(id) {
                s.jump = None;
            }
        }
        self.persist(&list)
    }

    /// Saved folders plus any folder names used by servers but missing from the list.
    pub fn folders(&self) -> Vec<String> {
        let mut out = self.folders.lock().unwrap().clone();
        for s in self.servers.lock().unwrap().iter() {
            if let Some(f) = s.folder() {
                if !out.iter().any(|x| x == f) {
                    out.push(f.to_string());
                }
            }
        }
        out
    }

    /// Replaces the folder list (creation, ordering). Servers are not touched.
    pub fn set_folders(&self, names: Vec<String>) -> Result<(), String> {
        let mut clean: Vec<String> = Vec::new();
        for n in names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
            if !clean.iter().any(|x| x == n) {
                clean.push(n.to_string());
            }
        }
        let mut folders = self.folders.lock().unwrap();
        *folders = clean;
        write_json(&self.folders_path, &*folders)
    }

    /// Renames a folder (or merges it into an existing one) and moves its servers.
    pub fn rename_folder(&self, from: &str, to: &str) -> Result<(), String> {
        let to = to.trim();
        if to.is_empty() {
            return Err(tr!("Укажите название папки", "Enter a folder name"));
        }
        let mut list = self.servers.lock().unwrap();
        for s in list.iter_mut().filter(|s| s.folder() == Some(from)) {
            s.group = Some(to.to_string());
        }
        self.persist(&list)?;
        let mut folders = self.folders.lock().unwrap();
        if folders.iter().any(|x| x == to) {
            folders.retain(|x| x != from);
        } else if let Some(f) = folders.iter_mut().find(|x| *x == from) {
            *f = to.to_string();
        } else {
            folders.push(to.to_string());
        }
        write_json(&self.folders_path, &*folders)
    }

    /// Deletes a folder; its servers stay, without a folder.
    pub fn delete_folder(&self, name: &str) -> Result<(), String> {
        let mut list = self.servers.lock().unwrap();
        for s in list.iter_mut().filter(|s| s.folder() == Some(name)) {
            s.group = None;
        }
        self.persist(&list)?;
        let mut folders = self.folders.lock().unwrap();
        folders.retain(|x| x != name);
        write_json(&self.folders_path, &*folders)
    }

    pub fn reorder(&self, ids: &[String]) -> Result<(), String> {
        let mut list = self.servers.lock().unwrap();
        list.sort_by_key(|s| ids.iter().position(|i| i == &s.id).unwrap_or(usize::MAX));
        self.persist(&list)
    }

    fn persist(&self, list: &[Server]) -> Result<(), String> {
        write_json(&self.path, list)
    }
}

fn write_json<T: Serialize + ?Sized>(path: &PathBuf, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn set_secret(server_id: &str, secret: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, server_id)
        .and_then(|e| e.set_password(secret))
        .map_err(|e| tr!("Не удалось сохранить пароль в системное хранилище: {e}", "Couldn't save the password to the system keychain: {e}"))
}

pub fn get_secret(server_id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, server_id)
        .and_then(|e| e.get_password())
        .ok()
}

pub fn delete_secret(server_id: &str) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, server_id) {
        let _ = e.delete_credential();
    }
}
