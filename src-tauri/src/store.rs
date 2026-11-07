//! Saved servers: stored as JSON in the app config dir.
//! Secrets (passwords, key passphrases) go to the OS keychain, never to the JSON file.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const KEYRING_SERVICE: &str = "TermDock";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
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
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// Remote directory to open in the file panel (defaults to home).
    #[serde(default)]
    pub remote_dir: Option<String>,
    /// Whether a secret (password / passphrase) is saved in the keychain.
    #[serde(default)]
    pub has_secret: bool,
}

pub struct Store {
    path: PathBuf,
    servers: Mutex<Vec<Server>>,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("servers.json");
        let servers = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, servers: Mutex::new(servers) }
    }

    pub fn list(&self) -> Vec<Server> {
        self.servers.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<Server> {
        self.servers.lock().unwrap().iter().find(|s| s.id == id).cloned()
    }

    pub fn upsert(&self, server: Server) -> Result<Server, String> {
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
        self.persist(&list)
    }

    pub fn reorder(&self, ids: &[String]) -> Result<(), String> {
        let mut list = self.servers.lock().unwrap();
        list.sort_by_key(|s| ids.iter().position(|i| i == &s.id).unwrap_or(usize::MAX));
        self.persist(&list)
    }

    fn persist(&self, list: &[Server]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

pub fn set_secret(server_id: &str, secret: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, server_id)
        .and_then(|e| e.set_password(secret))
        .map_err(|e| format!("Не удалось сохранить пароль в системное хранилище: {e}"))
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
