//! SSH sessions: connection, authentication, host key checking, interactive shell.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle, Msg};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelWriteHalf};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::mpsc;

use crate::store::{AuthMethod, Server};

/// What happened with the server's host key during the handshake.
#[derive(Default, Clone)]
enum HostKeyVerdict {
    #[default]
    None,
    Unknown { fingerprint: String, algorithm: String },
    Changed { fingerprint: String },
}

pub struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    accept_fingerprint: Option<String>,
    verdict: Arc<Mutex<HostKeyVerdict>>,
}

fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = server_key.public_key();
        let fp = fingerprint(&key);

        // 1) The app's own known_hosts, 2) the user's ~/.ssh/known_hosts (read-only).
        let mut changed = false;
        for check in [
            keys::check_known_hosts_path(&self.host, self.port, &key, &self.known_hosts),
            keys::check_known_hosts(&self.host, self.port, &key),
        ] {
            match check {
                Ok(true) => return Ok(true),
                Err(keys::Error::KeyChanged { .. }) => changed = true,
                _ => {}
            }
        }

        if self.accept_fingerprint.as_deref() == Some(fp.as_str()) {
            // The user confirmed this exact key in the UI.
            if changed {
                remove_known_host(&self.known_hosts, &self.host, self.port);
            }
            let _ = keys::known_hosts::learn_known_hosts_path(&self.host, self.port, &key, &self.known_hosts);
            return Ok(true);
        }

        *self.verdict.lock().unwrap() = if changed {
            HostKeyVerdict::Changed { fingerprint: fp }
        } else {
            HostKeyVerdict::Unknown { fingerprint: fp, algorithm: key.algorithm().to_string() }
        };
        Ok(false)
    }
}

/// Drops the app-local known_hosts entries for a host (used when the user accepts a changed key).
fn remove_known_host(path: &PathBuf, host: &str, port: u16) {
    let Ok(content) = std::fs::read_to_string(path) else { return };
    let pattern = if port == 22 { host.to_string() } else { format!("[{host}]:{port}") };
    let kept: Vec<&str> = content
        .lines()
        .filter(|l| l.split_whitespace().next().map(|h| !h.split(',').any(|p| p == pattern)).unwrap_or(true))
        .collect();
    let _ = std::fs::write(path, kept.join("\n") + "\n");
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    Data { data: Vec<u8> },
    Closed { reason: String },
}

#[derive(Default, Serialize)]
pub struct ExecOutput {
    pub code: Option<u32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub struct SshSession {
    handle: Arc<Handle<Client>>,
    input: mpsc::UnboundedSender<Input>,
    sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
    /// Previous /proc/stat sample (idle, total) for CPU usage deltas.
    cpu_prev: Mutex<Option<(u64, u64)>>,
}

enum Input {
    Data(Vec<u8>),
    Resize(u32, u32),
}

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, Arc<SshSession>>>,
}

impl Sessions {
    pub fn get(&self, id: &str) -> Result<Arc<SshSession>, String> {
        self.map.lock().unwrap().get(id).cloned().ok_or_else(|| "Сессия не найдена или закрыта".to_string())
    }
    fn insert(&self, id: String, s: Arc<SshSession>) {
        self.map.lock().unwrap().insert(id, s);
    }
    pub fn remove(&self, id: &str) -> Option<Arc<SshSession>> {
        self.map.lock().unwrap().remove(id)
    }
}

pub struct ConnectParams {
    pub server: Server,
    pub secret: Option<String>,
    pub accept_fingerprint: Option<String>,
    pub cols: u32,
    pub rows: u32,
    pub known_hosts: PathBuf,
}

async fn authenticate(handle: &mut Handle<Client>, server: &Server, secret: Option<String>) -> Result<(), String> {
    let user = server.username.clone();
    let ok = match server.auth {
        AuthMethod::Password => {
            let password = secret.ok_or("NEED_SECRET")?;
            let res = handle.authenticate_password(&user, &password).await.map_err(|e| e.to_string())?;
            if res.success() {
                true
            } else {
                // Many servers only allow keyboard-interactive for passwords.
                keyboard_interactive(handle, &user, &password).await?
            }
        }
        AuthMethod::Key => {
            let path = server.key_path.clone().filter(|p| !p.trim().is_empty()).ok_or("Не указан путь к ключу")?;
            let path = expand_tilde(&path);
            let key = match keys::load_secret_key(&path, secret.as_deref()) {
                Ok(k) => k,
                Err(keys::Error::KeyIsEncrypted) if secret.is_none() => return Err("NEED_SECRET".into()),
                Err(e) => return Err(format!("Не удалось прочитать ключ {}: {e}", path.display())),
            };
            let hash = handle.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
            let res = handle
                .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| e.to_string())?;
            res.success()
        }
    };
    if ok {
        Ok(())
    } else {
        Err("AUTH_FAILED".into())
    }
}

async fn keyboard_interactive(handle: &mut Handle<Client>, user: &str, password: &str) -> Result<bool, String> {
    use russh::client::KeyboardInteractiveAuthResponse as R;
    let mut res = handle
        .authenticate_keyboard_interactive_start(user, None::<String>)
        .await
        .map_err(|e| e.to_string())?;
    for _ in 0..5 {
        match res {
            R::Success => return Ok(true),
            R::Failure { .. } => return Ok(false),
            R::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                res = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(false)
}

pub fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

/// Connects, authenticates and opens an interactive shell. Output is streamed to `events`.
pub async fn connect(sessions: &Sessions, p: ConnectParams, events: Channel<TermEvent>) -> Result<String, String> {
    let verdict = Arc::new(Mutex::new(HostKeyVerdict::None));
    let handler = Client {
        host: p.server.host.clone(),
        port: p.server.port,
        known_hosts: p.known_hosts,
        accept_fingerprint: p.accept_fingerprint,
        verdict: verdict.clone(),
    };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 4,
        ..Default::default()
    });

    let addr = (p.server.host.as_str(), p.server.port);
    let connecting = client::connect(config, addr, handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(15), connecting).await {
        Err(_) => return Err("Таймаут подключения (15 с)".into()),
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            return Err(match verdict.lock().unwrap().clone() {
                HostKeyVerdict::Unknown { fingerprint, algorithm } => format!("HOSTKEY_UNKNOWN|{fingerprint}|{algorithm}"),
                HostKeyVerdict::Changed { fingerprint } => format!("HOSTKEY_CHANGED|{fingerprint}"),
                HostKeyVerdict::None => format!("Ошибка подключения: {e}"),
            })
        }
    };

    authenticate(&mut handle, &p.server, p.secret).await?;

    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel
        .request_pty(false, "xterm-256color", p.cols.max(10), p.rows.max(5), 0, 0, &[])
        .await
        .map_err(|e| e.to_string())?;
    channel.request_shell(false).await.map_err(|e| e.to_string())?;

    let (mut reader, writer) = channel.split();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(write_loop(writer, rx));

    let id = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(SshSession {
        handle: Arc::new(handle),
        input: tx,
        sftp: tokio::sync::Mutex::new(None),
        cpu_prev: Mutex::new(None),
    });
    sessions.insert(id.clone(), session);

    tokio::spawn(async move {
        let mut reason = "Соединение закрыто".to_string();
        while let Some(msg) = reader.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if events.send(TermEvent::Data { data: data.to_vec() }).is_err() {
                        break;
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => reason = format!("Сессия завершена (код {exit_status})"),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = events.send(TermEvent::Closed { reason });
    });

    Ok(id)
}

async fn write_loop(writer: ChannelWriteHalf<Msg>, mut rx: mpsc::UnboundedReceiver<Input>) {
    while let Some(input) = rx.recv().await {
        let res = match input {
            Input::Data(d) => writer.data_bytes(d).await,
            Input::Resize(c, r) => writer.window_change(c, r, 0, 0).await,
        };
        if res.is_err() {
            break;
        }
    }
}

impl SshSession {
    pub fn write(&self, data: Vec<u8>) -> Result<(), String> {
        self.input.send(Input::Data(data)).map_err(|_| "Сессия закрыта".to_string())
    }

    pub fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        self.input.send(Input::Resize(cols, rows)).map_err(|_| "Сессия закрыта".to_string())
    }

    /// Lazily opens one SFTP subsystem channel per session and reuses it.
    pub async fn sftp(&self) -> Result<Arc<SftpSession>, String> {
        let mut guard = self.sftp.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let channel = self.handle.channel_open_session().await.map_err(|e| e.to_string())?;
        channel.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("SFTP недоступен на сервере: {e}"))?;
        sftp.set_timeout(60);
        let sftp = Arc::new(sftp);
        *guard = Some(sftp.clone());
        Ok(sftp)
    }

    /// Runs a command on a separate exec channel (not in the user's shell) and collects its output.
    pub async fn exec(&self, command: &str, timeout: Duration) -> Result<ExecOutput, String> {
        let run = async {
            let mut ch = self.handle.channel_open_session().await.map_err(|e| e.to_string())?;
            ch.exec(true, command).await.map_err(|e| e.to_string())?;
            let mut out = ExecOutput::default();
            while let Some(msg) = ch.wait().await {
                match msg {
                    ChannelMsg::Data { data } => out.stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => out.stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => out.code = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Ok(out)
        };
        tokio::time::timeout(timeout, run).await.map_err(|_| "Таймаут выполнения команды".to_string())?
    }

    /// Basic server telemetry (Linux: /proc + df).
    pub async fn stats(&self) -> Result<crate::stats::Stats, String> {
        let out = self.exec(crate::stats::COMMAND, Duration::from_secs(10)).await?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut stats = crate::stats::parse(&text);
        if let Some((idle, total)) = stats.cpu_sample {
            let mut prev = self.cpu_prev.lock().unwrap();
            if let Some((pi, pt)) = *prev {
                let (di, dt) = (idle.saturating_sub(pi), total.saturating_sub(pt));
                if dt > 0 {
                    stats.cpu = Some(100.0 * (1.0 - di as f32 / dt as f32));
                }
            }
            *prev = Some((idle, total));
        }
        if stats.mem_total == 0 {
            return Err("Телеметрия доступна только для Linux-серверов".into());
        }
        Ok(stats)
    }

    pub async fn close(&self) {
        let _ = self.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
}
