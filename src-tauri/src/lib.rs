mod files;
mod scripts;
mod ssh;
mod stats;
mod store;

use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use files::{Entry, Transfers};
use scripts::{Script, Scripts};
use ssh::{ConnectParams, Sessions, TermEvent};
use store::{Server, Store};

struct Paths {
    known_hosts: PathBuf,
}

// ---------- servers ----------

#[tauri::command]
fn list_servers(store: State<Store>) -> Vec<Server> {
    store.list()
}

/// `secret`: Some("") clears the saved secret, Some(x) saves x, None keeps the current one.
#[tauri::command]
fn save_server(store: State<Store>, mut server: Server, secret: Option<String>) -> Result<Server, String> {
    if server.id.is_empty() {
        server.id = uuid::Uuid::new_v4().to_string();
    }
    if server.host.trim().is_empty() || server.username.trim().is_empty() {
        return Err("Укажите хост и пользователя".into());
    }
    let previous = store.get(&server.id);
    server.has_secret = previous.map(|p| p.has_secret).unwrap_or(false);
    match secret.as_deref() {
        Some("") => {
            store::delete_secret(&server.id);
            server.has_secret = false;
        }
        Some(s) => {
            store::set_secret(&server.id, s)?;
            server.has_secret = true;
        }
        None => {}
    }
    store.upsert(server)
}

#[tauri::command]
fn delete_server(store: State<Store>, id: String) -> Result<(), String> {
    store::delete_secret(&id);
    store.remove(&id)
}

#[tauri::command]
fn reorder_servers(store: State<Store>, ids: Vec<String>) -> Result<(), String> {
    store.reorder(&ids)
}

// ---------- scripts ----------

#[tauri::command]
fn list_scripts(scripts: State<Scripts>) -> Vec<Script> {
    scripts.list()
}

#[tauri::command]
fn save_script(scripts: State<Scripts>, script: Script) -> Result<Script, String> {
    scripts.upsert(script)
}

#[tauri::command]
fn delete_script(scripts: State<Scripts>, id: String) -> Result<(), String> {
    scripts.remove(&id)
}

// ---------- ssh ----------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ssh_connect(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    paths: State<'_, Paths>,
    server_id: String,
    secret: Option<String>,
    remember: Option<bool>,
    accept_fingerprint: Option<String>,
    cols: u32,
    rows: u32,
    events: Channel<TermEvent>,
) -> Result<String, String> {
    let mut server = store.get(&server_id).ok_or("Сервер не найден")?;
    let typed = secret.clone();
    let secret = secret.or_else(|| if server.has_secret { store::get_secret(&server.id) } else { None });
    let params = ConnectParams {
        server: server.clone(),
        secret,
        accept_fingerprint,
        cols,
        rows,
        known_hosts: paths.known_hosts.clone(),
    };
    let id = ssh::connect(&sessions, params, events).await?;
    // Remember a password typed in the prompt only after it actually worked.
    if let (Some(s), Some(true)) = (typed, remember) {
        if store::set_secret(&server.id, &s).is_ok() {
            server.has_secret = true;
            let _ = store.upsert(server);
        }
    }
    Ok(id)
}

#[tauri::command]
fn ssh_write(sessions: State<Sessions>, session_id: String, data: Vec<u8>) -> Result<(), String> {
    sessions.get(&session_id)?.write(data)
}

#[tauri::command]
fn ssh_resize(sessions: State<Sessions>, session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    sessions.get(&session_id)?.resize(cols, rows)
}

#[tauri::command]
async fn ssh_disconnect(sessions: State<'_, Sessions>, session_id: String) -> Result<(), String> {
    if let Some(s) = sessions.remove(&session_id) {
        s.close().await;
    }
    Ok(())
}

#[tauri::command]
async fn remote_stats(sessions: State<'_, Sessions>, session_id: String) -> Result<stats::Stats, String> {
    sessions.get(&session_id)?.stats().await
}

// ---------- files ----------

#[tauri::command]
fn local_home() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into())
}

#[tauri::command]
async fn local_list(path: String) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || files::list_local(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn local_mkdir(path: String) -> Result<(), String> {
    tokio::fs::create_dir_all(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn local_remove(path: String) -> Result<(), String> {
    let meta = tokio::fs::symlink_metadata(&path).await.map_err(|e| e.to_string())?;
    if meta.is_dir() {
        tokio::fs::remove_dir_all(&path).await
    } else {
        tokio::fs::remove_file(&path).await
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn local_rename(from: String, to: String) -> Result<(), String> {
    tokio::fs::rename(&from, &to).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn local_read_text(path: String) -> Result<String, String> {
    files::read_local_text(&path).await
}

#[tauri::command]
async fn local_write_text(path: String, content: String) -> Result<(), String> {
    tokio::fs::write(&path, content).await.map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
async fn local_create_file(path: String) -> Result<(), String> {
    files::create_local_file(&path).await
}

#[tauri::command]
async fn remote_read_text(sessions: State<'_, Sessions>, session_id: String, path: String) -> Result<String, String> {
    let sftp = sessions.get(&session_id)?.sftp().await?;
    files::read_remote_text(&sftp, &path).await
}

#[tauri::command]
async fn remote_write_text(sessions: State<'_, Sessions>, session_id: String, path: String, content: String) -> Result<(), String> {
    let sftp = sessions.get(&session_id)?.sftp().await?;
    files::write_remote_text(&sftp, &path, &content).await
}

#[tauri::command]
async fn remote_create_file(sessions: State<'_, Sessions>, session_id: String, path: String) -> Result<(), String> {
    let sftp = sessions.get(&session_id)?.sftp().await?;
    files::create_remote_file(&sftp, &path).await
}

#[tauri::command]
async fn remote_home(sessions: State<'_, Sessions>, session_id: String) -> Result<String, String> {
    let sftp = sessions.get(&session_id)?.sftp().await?;
    sftp.canonicalize(".").await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn remote_list(sessions: State<'_, Sessions>, session_id: String, path: String) -> Result<Vec<Entry>, String> {
    let sftp = sessions.get(&session_id)?.sftp().await?;
    files::list_remote(&sftp, &path).await
}

#[tauri::command]
async fn remote_mkdir(sessions: State<'_, Sessions>, session_id: String, path: String) -> Result<(), String> {
    let sftp = sessions.get(&session_id)?.sftp().await?;
    sftp.create_dir(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn remote_remove(sessions: State<'_, Sessions>, session_id: String, path: String) -> Result<(), String> {
    let sftp = sessions.get(&session_id)?.sftp().await?;
    files::remove_remote(&sftp, &path).await
}

#[tauri::command]
async fn remote_rename(sessions: State<'_, Sessions>, session_id: String, from: String, to: String) -> Result<(), String> {
    let sftp = sessions.get(&session_id)?.sftp().await?;
    sftp.rename(from, to).await.map_err(|e| e.to_string())
}

/// Starts an upload in the background; progress arrives via the `transfer-progress` event.
#[tauri::command]
async fn upload(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    session_id: String,
    transfer_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<(), String> {
    let sftp = sessions.get(&session_id)?.sftp().await?;
    let cancel = transfers.register(&transfer_id);
    let res = files::upload(app.clone(), sftp, transfer_id.clone(), cancel, local_paths, remote_dir).await;
    app.state::<Transfers>().finish(&transfer_id);
    res
}

#[tauri::command]
async fn download(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    transfers: State<'_, Transfers>,
    session_id: String,
    transfer_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
) -> Result<(), String> {
    let sftp = sessions.get(&session_id)?.sftp().await?;
    let cancel = transfers.register(&transfer_id);
    let res = files::download(app.clone(), sftp, transfer_id.clone(), cancel, remote_paths, local_dir).await;
    app.state::<Transfers>().finish(&transfer_id);
    res
}

#[tauri::command]
fn cancel_transfer(transfers: State<Transfers>, transfer_id: String) {
    transfers.cancel(&transfer_id);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Store::load(dir.clone()));
            app.manage(Scripts::load(dir.clone()));
            app.manage(Paths { known_hosts: dir.join("known_hosts") });
            app.manage(Sessions::default());
            app.manage(Transfers::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_servers,
            save_server,
            delete_server,
            reorder_servers,
            list_scripts,
            save_script,
            delete_script,
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            remote_stats,
            local_home,
            local_list,
            local_mkdir,
            local_remove,
            local_rename,
            local_read_text,
            local_write_text,
            local_create_file,
            remote_read_text,
            remote_write_text,
            remote_create_file,
            remote_home,
            remote_list,
            remote_mkdir,
            remote_remove,
            remote_rename,
            upload,
            download,
            cancel_transfer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TermDock");
}
