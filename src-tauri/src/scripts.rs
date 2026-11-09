//! User scripts (snippets of shell commands), stored as JSON in the app config dir.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub body: String,
    /// "terminal" — typed into the shell line by line; "bash" — run as one bash script (heredoc).
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Terminal mode only: send one line per click instead of the whole script.
    #[serde(default)]
    pub steps: bool,
}

fn default_mode() -> String {
    "terminal".into()
}

pub struct Scripts {
    path: PathBuf,
    list: Mutex<Vec<Script>>,
}

impl Scripts {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("scripts.json");
        let list = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, list: Mutex::new(list) }
    }

    pub fn list(&self) -> Vec<Script> {
        self.list.lock().unwrap().clone()
    }

    pub fn upsert(&self, mut script: Script) -> Result<Script, String> {
        if script.name.trim().is_empty() {
            return Err(tr!("Укажите название скрипта", "Enter a script name"));
        }
        if script.id.is_empty() {
            script.id = uuid::Uuid::new_v4().to_string();
        }
        let mut list = self.list.lock().unwrap();
        match list.iter_mut().find(|s| s.id == script.id) {
            Some(existing) => *existing = script.clone(),
            None => list.push(script.clone()),
        }
        self.persist(&list)?;
        Ok(script)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut list = self.list.lock().unwrap();
        list.retain(|s| s.id != id);
        self.persist(&list)
    }

    fn persist(&self, list: &[Script]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}
