mod files;
mod forward;
mod scripts;
mod ssh;
mod sshconfig;
mod stats;
mod store;

use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use files::{Entry, Transfers};
use scripts::{Script, Scripts};
use std::collections::HashMap;

use ssh::{ConnectParams, Hop, Sessions, TermEvent};
use sshconfig::SshConfig;
use store::{AuthMethod, Server, Store};

struct Paths {
    known_hosts: PathBuf,
}

// ---------- servers ----------

#[tauri::command]
fn list_servers(store: State<Store>) -> Vec<Server> {
    store.list()
}

/// Some("") clears the saved secret, Some(x) saves x, None keeps the current one.
fn apply_secret(keychain_id: &str, secret: Option<&str>, has_secret: &mut bool) -> Result<(), String> {
    match secret {
        Some("") => {
            store::delete_secret(keychain_id);
            *has_secret = false;
        }
        Some(s) => {
            store::set_secret(keychain_id, s)?;
            *has_secret = true;
        }
        None => {}
    }
    Ok(())
}

/// `secret` / `jump_secret` (for a custom jump host): see `apply_secret`.
#[tauri::command]
fn save_server(store: State<Store>, mut server: Server, secret: Option<String>, jump_secret: Option<String>) -> Result<Server, String> {
    if server.id.is_empty() {
        server.id = uuid::Uuid::new_v4().to_string();
    }
    if server.host.trim().is_empty() || server.username.trim().is_empty() {
        return Err("Укажите хост и пользователя".into());
    }
    let previous = store.get(&server.id);
    server.has_secret = previous.as_ref().map(|p| p.has_secret).unwrap_or(false);
    // The agent holds the keys itself: nothing to keep in the keychain.
    let secret = if server.auth == store::AuthMethod::Agent { Some(String::new()) } else { secret };
    apply_secret(&server.id, secret.as_deref(), &mut server.has_secret)?;

    let jump_id = store::jump_secret_id(&server.id);
    let had_jump_secret = previous.as_ref().and_then(|p| p.jump.as_ref()).is_some_and(|j| j.has_secret);
    match server.jump.as_mut() {
        Some(j) if j.server_id.as_deref().is_some_and(|id| !id.is_empty()) => {
            if j.server_id.as_deref() == Some(server.id.as_str()) {
                return Err("Сервер не может быть посредником для самого себя".into());
            }
            store::delete_secret(&jump_id);
        }
        Some(j) if j.is_custom() => {
            j.server_id = None;
            j.host = j.host.trim().to_string();
            j.username = j.username.trim().to_string();
            if j.username.is_empty() {
                return Err("Укажите пользователя сервера-посредника".into());
            }
            if j.port == 0 {
                j.port = 22;
            }
            j.has_secret = had_jump_secret;
            let jump_secret = if j.auth == store::AuthMethod::Agent { Some(String::new()) } else { jump_secret };
            apply_secret(&jump_id, jump_secret.as_deref(), &mut j.has_secret)?;
        }
        _ => {
            server.jump = None;
            store::delete_secret(&jump_id);
        }
    }
    store.upsert(server)
}

#[tauri::command]
fn delete_server(store: State<Store>, id: String) -> Result<(), String> {
    store::delete_secret(&id);
    store::delete_secret(&store::jump_secret_id(&id));
    store.remove(&id)
}

#[tauri::command]
fn list_folders(store: State<Store>) -> Vec<String> {
    store.folders()
}

#[tauri::command]
fn save_folders(store: State<Store>, names: Vec<String>) -> Result<Vec<String>, String> {
    store.set_folders(names)?;
    Ok(store.folders())
}

#[tauri::command]
fn rename_folder(store: State<Store>, from: String, to: String) -> Result<(), String> {
    store.rename_folder(&from, &to)
}

#[tauri::command]
fn delete_folder(store: State<Store>, name: String) -> Result<(), String> {
    store.delete_folder(&name)
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

/// Keychain / prompt id of a jump host taken from ~/.ssh/config.
fn config_hop_id(alias: &str) -> String {
    format!("sshconfig:{alias}")
}

/// Auth for a host from ~/.ssh/config: its IdentityFile, else the agent if one is running,
/// else the first existing default key.
fn config_auth(cfg: &sshconfig::HostConfig, host: &str, user: &str) -> (AuthMethod, Option<String>) {
    let files: Vec<PathBuf> = cfg.identity_files.iter().map(|f| sshconfig::expand_path(f, host, user)).collect();
    if let Some(f) = files.iter().find(|f| f.exists()).or(files.first()) {
        return (AuthMethod::Key, Some(f.to_string_lossy().into_owned()));
    }
    if agent_available() {
        return (AuthMethod::Agent, None);
    }
    let home = dirs::home_dir().unwrap_or_default().join(".ssh");
    match ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| home.join(n)).find(|p| p.exists()) {
        Some(p) => (AuthMethod::Key, Some(p.to_string_lossy().into_owned())),
        // Nothing found: the agent attempt gives a clear error.
        None => (AuthMethod::Agent, None),
    }
}

fn agent_available() -> bool {
    #[cfg(windows)]
    {
        std::path::Path::new(r"\\.\pipe\openssh-ssh-agent").exists()
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("SSH_AUTH_SOCK").is_some_and(|s| !s.is_empty())
    }
}

/// Hops for a ProxyJump value: each entry is resolved again through the config. Like `ssh -J`,
/// only the first entry's own ProxyJump is followed (the rest go through the previous entry).
fn config_jumps(cfg: &SshConfig, value: &str, seen: &mut Vec<String>) -> Result<Vec<Hop>, String> {
    let mut hops = Vec::new();
    for (i, spec) in sshconfig::parse_proxy_jump(value).into_iter().enumerate() {
        let alias = spec.host.to_lowercase();
        if seen.contains(&alias) {
            return Err(format!("ProxyJump в ~/.ssh/config ссылается по кругу (на «{}»)", spec.host));
        }
        seen.push(alias);
        let hc = cfg.resolve(&spec.host);
        if i == 0 {
            if let Some(pj) = &hc.proxy_jump {
                hops.extend(config_jumps(cfg, pj, seen)?);
            }
        }
        let host = hc.hostname.clone().unwrap_or_else(|| spec.host.clone());
        let username = spec.user.clone().or(hc.user.clone()).unwrap_or_else(sshconfig::local_user);
        let (auth, key_path) = config_auth(&hc, &host, &username);
        let id = config_hop_id(&spec.host);
        hops.push(Hop {
            secret: if auth == AuthMethod::Key { store::get_secret(&id) } else { None },
            id,
            port: spec.port.or(hc.port).unwrap_or(22),
            host,
            username,
            auth,
            key_path,
            accept_fingerprint: None,
        });
    }
    Ok(hops)
}

/// What ~/.ssh/config says about a server's host: the real address and, when `with_jumps`,
/// the ProxyJump chain.
struct ConfigRoute {
    host: String,
    port: u16,
    jumps: Vec<Hop>,
}

fn config_route(cfg: &SshConfig, host: &str, port: u16, with_jumps: bool) -> Result<ConfigRoute, String> {
    let hc = cfg.resolve(host);
    // HostName replaces the alias. The app's own port wins, except the default 22: then the
    // config's Port applies (the dialog always has some port, 22 means "not chosen").
    // The user is always the app's own (it is required in the dialog).
    let real_port = if port == 22 { hc.port.unwrap_or(22) } else { port };
    let jumps = match (&hc.proxy_jump, with_jumps) {
        (Some(pj), true) => config_jumps(cfg, pj, &mut vec![host.to_lowercase()])?,
        _ => Vec::new(),
    };
    Ok(ConfigRoute { host: hc.hostname.unwrap_or_else(|| host.to_string()), port: real_port, jumps })
}

/// Jump hosts first, the server itself last. Saved jump servers may have their own jump hosts.
/// A server without a jump host in the app gets its ProxyJump from ~/.ssh/config, if any.
fn resolve_hops(store: &Store, server: &Server, seen: &mut Vec<String>) -> Result<Vec<Hop>, String> {
    if seen.contains(&server.id) {
        return Err(format!("Серверы-посредники ссылаются друг на друга по кругу (на «{}»)", server.name));
    }
    seen.push(server.id.clone());
    let mut hops = match &server.jump {
        Some(j) if j.server_id.as_deref().is_some_and(|id| !id.is_empty()) => {
            let via = store
                .get(j.server_id.as_deref().unwrap())
                .ok_or_else(|| format!("Сервер-посредник для «{}» не найден", server.name))?;
            resolve_hops(store, &via, seen)?
        }
        Some(j) if j.is_custom() => {
            let id = store::jump_secret_id(&server.id);
            vec![Hop {
                secret: if j.has_secret { store::get_secret(&id) } else { None },
                id,
                host: j.host.clone(),
                port: if j.port == 0 { 22 } else { j.port },
                username: j.username.clone(),
                auth: j.auth.clone(),
                key_path: j.key_path.clone(),
                accept_fingerprint: None,
            }]
        }
        _ => Vec::new(),
    };
    // The app's own jump setting always wins over ProxyJump from ~/.ssh/config.
    let route = config_route(&SshConfig::load(), &server.host, server.port, hops.is_empty())?;
    hops.extend(route.jumps);
    hops.push(Hop {
        id: server.id.clone(),
        secret: if server.has_secret { store::get_secret(&server.id) } else { None },
        host: route.host,
        port: route.port,
        username: server.username.clone(),
        auth: server.auth.clone(),
        key_path: server.key_path.clone(),
        accept_fingerprint: None,
    });
    Ok(hops)
}

/// `secrets` / `accept`: typed passwords and confirmed host key fingerprints, keyed by hop id
/// (a server id, `<server id>#jump` for a custom jump host, `sshconfig:<alias>` for a jump host
/// from ~/.ssh/config). `remember`: hop ids whose typed
/// secret should be saved once the connection works.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ssh_connect(
    store: State<'_, Store>,
    sessions: State<'_, Sessions>,
    paths: State<'_, Paths>,
    server_id: String,
    secrets: Option<HashMap<String, String>>,
    remember: Option<Vec<String>>,
    accept: Option<HashMap<String, String>>,
    cols: u32,
    rows: u32,
    events: Channel<TermEvent>,
) -> Result<String, String> {
    let server = store.get(&server_id).ok_or("Сервер не найден")?;
    let typed = secrets.unwrap_or_default();
    let accept = accept.unwrap_or_default();
    let mut hops = resolve_hops(&store, &server, &mut Vec::new())?;
    for hop in hops.iter_mut() {
        if let Some(s) = typed.get(&hop.id) {
            hop.secret = Some(s.clone());
        }
        hop.accept_fingerprint = accept.get(&hop.id).cloned();
    }
    let params = ConnectParams { hops, cols, rows, known_hosts: paths.known_hosts.clone(), forwards: server.forwards.clone() };
    let id = ssh::connect(&sessions, params, events).await?;
    // Remember passwords typed in the prompt only after they actually worked.
    for hop_id in remember.unwrap_or_default() {
        let Some(secret) = typed.get(&hop_id) else { continue };
        if store::set_secret(&hop_id, secret).is_err() {
            continue;
        }
        if let Some(mut s) = store.get(&hop_id) {
            s.has_secret = true;
            let _ = store.upsert(s);
        } else if let Some(mut owner) = hop_id.strip_suffix("#jump").and_then(|o| store.get(o)) {
            if let Some(j) = owner.jump.as_mut() {
                j.has_secret = true;
            }
            let _ = store.upsert(owner);
        }
    }
    Ok(id)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigJump {
    alias: String,
    label: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigLookup {
    /// Real address when HostName differs from the typed host.
    hostname: Option<String>,
    port: u16,
    /// ProxyJump chain, outermost first (empty when not set).
    jumps: Vec<ConfigJump>,
    error: Option<String>,
}

/// What ~/.ssh/config defines for a host (for hints in the UI); None when nothing relevant.
#[tauri::command]
fn ssh_config_lookup(host: String, port: Option<u16>) -> Option<ConfigLookup> {
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    let port = port.unwrap_or(22);
    let out = match config_route(&SshConfig::load(), host, port, true) {
        Ok(r) => ConfigLookup {
            hostname: (r.host != host).then_some(r.host),
            port: r.port,
            jumps: r
                .jumps
                .iter()
                .map(|h| ConfigJump {
                    alias: h.id.strip_prefix("sshconfig:").unwrap_or(&h.id).to_string(),
                    label: h.label(),
                })
                .collect(),
            error: None,
        },
        Err(e) => ConfigLookup { hostname: None, port, jumps: Vec::new(), error: Some(e) },
    };
    (out.hostname.is_some() || out.port != port || !out.jumps.is_empty() || out.error.is_some()).then_some(out)
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
async fn ssh_forwards(sessions: State<'_, Sessions>, session_id: String) -> Result<Vec<forward::ForwardStatus>, String> {
    Ok(sessions.get(&session_id)?.forwards().status().await)
}

/// Starts (or restarts) a forward in a live session; one with a new id is session-only.
#[tauri::command]
async fn ssh_forward_start(sessions: State<'_, Sessions>, session_id: String, forward: store::Forward) -> Result<forward::ForwardStatus, String> {
    Ok(sessions.get(&session_id)?.forwards().start(forward).await)
}

/// Stops a forward; `remove` also drops it from the session's list.
#[tauri::command]
async fn ssh_forward_stop(sessions: State<'_, Sessions>, session_id: String, id: String, remove: Option<bool>) -> Result<(), String> {
    sessions.get(&session_id)?.forwards().stop(&id, remove.unwrap_or(false)).await;
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
            list_folders,
            save_folders,
            rename_folder,
            delete_folder,
            list_scripts,
            save_script,
            delete_script,
            ssh_connect,
            ssh_config_lookup,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_forwards,
            ssh_forward_start,
            ssh_forward_stop,
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

#[cfg(test)]
mod tests {
    use super::*;
    use ssh::tests::{open_accepting, port, run, test_hop};

    /// Needs the sshd pair of ssh_tests (TD_SSH_PORT target, TD_SSH_PORT2 jump), a running agent
    /// and TD_SSH_ENC_KEY: a passphrase-protected key (passphrase in TD_SSH_ENC_PASS).
    #[tokio::test]
    #[ignore]
    async fn proxy_jump_from_ssh_config() {
        let enc = std::env::var("TD_SSH_ENC_KEY").unwrap();
        let text = format!(
            "Host td-target\n  HostName 127.0.0.1\n  Port {}\n  ProxyJump td-b1,td-bastion\n\
             Host td-b1\n  HostName 127.0.0.1\n  Port {}\n  User tdtest\n\
             Host td-bastion\n  HostName 127.0.0.1\n  Port {}\n  User tdtest\n  IdentityFile {enc}\n",
            port("TD_SSH_PORT"),
            port("TD_SSH_PORT2"),
            port("TD_SSH_PORT"),
        );
        let cfg = SshConfig::parse(&text);
        let route = config_route(&cfg, "td-target", 22, true).unwrap();
        assert_eq!((route.host.as_str(), route.port), ("127.0.0.1", port("TD_SSH_PORT")));
        let ids: Vec<_> = route.jumps.iter().map(|h| h.id.clone()).collect();
        assert_eq!(ids, ["sshconfig:td-b1", "sshconfig:td-bastion"]);
        assert_eq!(route.jumps[0].auth, AuthMethod::Agent, "no IdentityFile + running agent");
        assert_eq!(route.jumps[1].auth, AuthMethod::Key);

        let mut target = test_hop("target", route.port, AuthMethod::Agent);
        target.host = route.host.clone();
        let mut hops = route.jumps;
        hops[1].secret = None;
        hops.push(target);

        // The encrypted IdentityFile asks for its passphrase, tagged with the config hop id.
        let e = open_accepting(hops.clone()).await.err().unwrap();
        assert!(e.starts_with("JUMP|sshconfig:td-bastion|") && e.ends_with("|key|NEED_SECRET"), "{e}");
        hops[1].secret = Some(std::env::var("TD_SSH_ENC_PASS").unwrap());
        let c = open_accepting(hops).await.unwrap();
        assert_eq!(c.jumps.len(), 2);
        assert_eq!(run(&c.handle, "whoami").await.trim(), "tdtest");
    }

    #[test]
    fn config_loop_is_detected() {
        let cfg = SshConfig::parse("Host a\n  ProxyJump b\nHost b\n  ProxyJump a\n");
        let e = config_route(&cfg, "a", 22, true).err().unwrap();
        assert!(e.contains("по кругу"), "{e}");
    }

    #[test]
    fn app_port_wins_unless_default() {
        let cfg = SshConfig::parse("Host x\n  HostName real.example\n  Port 2200\n");
        assert_eq!(config_route(&cfg, "x", 22, true).unwrap().port, 2200);
        assert_eq!(config_route(&cfg, "x", 2022, true).unwrap().port, 2022);
        assert_eq!(config_route(&cfg, "x", 22, true).unwrap().host, "real.example");
        assert!(config_route(&cfg, "x", 22, false).unwrap().jumps.is_empty());
    }
}
