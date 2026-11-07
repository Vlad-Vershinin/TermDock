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

use crate::store::AuthMethod;

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
    /// Connections to jump hosts, outermost first. Kept alive for the lifetime of the session.
    jumps: Vec<Handle<Client>>,
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

/// One SSH connection in the chain: jump hosts first, the target server last.
pub struct Hop {
    /// Key for secrets / accepted fingerprints sent by the UI (and the keychain id).
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub key_path: Option<String>,
    pub secret: Option<String>,
    pub accept_fingerprint: Option<String>,
}

impl Hop {
    fn label(&self) -> String {
        let port = if self.port == 22 { String::new() } else { format!(":{}", self.port) };
        format!("{}@{}{port}", self.username, self.host)
    }
}

pub struct ConnectParams {
    pub hops: Vec<Hop>,
    pub cols: u32,
    pub rows: u32,
    pub known_hosts: PathBuf,
}

async fn authenticate(handle: &mut Handle<Client>, hop: &Hop) -> Result<(), String> {
    let user = hop.username.clone();
    let secret = hop.secret.clone();
    let ok = match hop.auth {
        AuthMethod::Password => {
            let password = secret.clone().ok_or("NEED_SECRET")?;
            let res = handle.authenticate_password(&user, &password).await.map_err(|e| e.to_string())?;
            if res.success() {
                true
            } else {
                // Many servers only allow keyboard-interactive for passwords.
                keyboard_interactive(handle, &user, &password).await?
            }
        }
        AuthMethod::Key => {
            let path = hop.key_path.clone().filter(|p| !p.trim().is_empty()).ok_or("Не указан путь к ключу")?;
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
        AuthMethod::Agent => return agent_auth(handle, &user).await,
    };
    if ok {
        Ok(())
    } else {
        Err("AUTH_FAILED".into())
    }
}

type Agent = keys::agent::client::AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>;

/// Connects to the user's ssh-agent: SSH_AUTH_SOCK on Unix; on Windows the OpenSSH agent pipe,
/// then Pageant.
pub async fn connect_agent() -> Result<Agent, String> {
    #[cfg(unix)]
    {
        let sock = std::env::var_os("SSH_AUTH_SOCK").filter(|s| !s.is_empty());
        let sock = sock.ok_or("SSH-агент не запущен: переменная SSH_AUTH_SOCK не задана")?;
        match keys::agent::client::AgentClient::connect_uds(&sock).await {
            Ok(a) => Ok(a.dynamic()),
            Err(keys::Error::IO(e)) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) => {
                Err("SSH-агент не запущен: его сокет (SSH_AUTH_SOCK) не отвечает".into())
            }
            Err(e) => Err(format!("Не удалось подключиться к SSH-агенту: {e}")),
        }
    }
    #[cfg(windows)]
    {
        use keys::agent::client::AgentClient;
        if let Ok(a) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            return Ok(a.dynamic());
        }
        match AgentClient::connect_pageant().await {
            Ok(a) => Ok(a.dynamic()),
            Err(_) => Err("SSH-агент не запущен: не найдены ни служба OpenSSH Authentication Agent, ни Pageant".into()),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err("SSH-агент не поддерживается на этой системе".into())
    }
}

/// Tries every identity the agent holds until the server accepts one.
async fn agent_auth(handle: &mut Handle<Client>, user: &str) -> Result<(), String> {
    use keys::agent::AgentIdentity;
    let mut agent = connect_agent().await?;
    let ids = agent
        .request_identities()
        .await
        .map_err(|e| format!("SSH-агент не отвечает: {e}"))?;
    if ids.is_empty() {
        return Err("В SSH-агенте нет ключей — добавьте ключ командой ssh-add".into());
    }
    let hash = handle.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
    for id in ids {
        let res = match id {
            AgentIdentity::PublicKey { key, .. } => handle.authenticate_publickey_with(user, key, hash, &mut agent).await,
            AgentIdentity::Certificate { certificate, .. } => handle.authenticate_certificate_with(user, certificate, hash, &mut agent).await,
        };
        match res {
            Ok(r) if r.success() => return Ok(()),
            Ok(_) => {}
            // The agent may refuse to sign (e.g. a confirm-only key the user declined): try the next one.
            Err(russh::AgentAuthError::Key(_)) => {}
            Err(e) => return Err(format!("Ошибка аутентификации через SSH-агент: {e}")),
        }
    }
    Err("Сервер отклонил все ключи из SSH-агента".into())
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

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Opens one hop: directly, or through a direct-tcpip channel of the previous hop.
async fn open_hop(config: Arc<client::Config>, known_hosts: &std::path::Path, hop: &Hop, via: Option<&Handle<Client>>) -> Result<Handle<Client>, String> {
    let verdict = Arc::new(Mutex::new(HostKeyVerdict::None));
    let handler = Client {
        host: hop.host.clone(),
        port: hop.port,
        known_hosts: known_hosts.to_path_buf(),
        accept_fingerprint: hop.accept_fingerprint.clone(),
        verdict: verdict.clone(),
    };
    let res = match via {
        None => tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, (hop.host.as_str(), hop.port), handler)).await,
        Some(jump) => {
            let channel = tokio::time::timeout(CONNECT_TIMEOUT, jump.channel_open_direct_tcpip(hop.host.clone(), hop.port as u32, "127.0.0.1", 0))
                .await
                .map_err(|_| format!("Таймаут: сервер-посредник не открыл туннель до {}:{}", hop.host, hop.port))?
                .map_err(|e| format!("Сервер-посредник не смог подключиться к {}:{}: {e}", hop.host, hop.port))?;
            tokio::time::timeout(CONNECT_TIMEOUT, client::connect_stream(config, channel.into_stream(), handler)).await
        }
    };
    let mut handle = match res {
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
    authenticate(&mut handle, hop).await?;
    Ok(handle)
}

/// Errors the UI can act on (ask for a password, confirm a host key) are tagged with the jump
/// host they came from: `JUMP|<hop id>|<user@host>|<auth>|<code>`. Other errors are plain text.
fn jump_error(hop: &Hop, e: String) -> String {
    let actionable = e == "NEED_SECRET" || e == "AUTH_FAILED" || e.starts_with("HOSTKEY_");
    if actionable {
        let auth = match hop.auth {
            AuthMethod::Key => "key",
            AuthMethod::Agent => "agent",
            AuthMethod::Password => "password",
        };
        format!("JUMP|{}|{}|{auth}|{e}", hop.id, hop.label())
    } else {
        format!("Сервер-посредник {}: {e}", hop.label())
    }
}

/// Opens and authenticates every hop. Returns the jump host connections (outermost first)
/// and the connection to the target server.
pub async fn open_chain(hops: &[Hop], known_hosts: &std::path::Path) -> Result<(Vec<Handle<Client>>, Handle<Client>), String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 4,
        ..Default::default()
    });

    let last = hops.len().checked_sub(1).ok_or("Не указан сервер")?;
    let mut chain: Vec<Handle<Client>> = Vec::with_capacity(hops.len());
    for (i, hop) in hops.iter().enumerate() {
        match open_hop(config.clone(), known_hosts, hop, chain.last()).await {
            Ok(h) => chain.push(h),
            Err(e) => {
                for h in chain.iter().rev() {
                    let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await;
                }
                return Err(if i < last { jump_error(hop, e) } else { e });
            }
        }
    }
    let handle = chain.pop().unwrap();
    Ok((chain, handle))
}

/// Connects (through the jump hosts, if any), authenticates and opens an interactive shell.
/// Output is streamed to `events`.
pub async fn connect(sessions: &Sessions, p: ConnectParams, events: Channel<TermEvent>) -> Result<String, String> {
    let (jumps, handle) = open_chain(&p.hops, &p.known_hosts).await?;

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
        jumps,
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
        for h in self.jumps.iter().rev() {
            let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        }
    }
}

#[cfg(test)]
#[path = "ssh_tests.rs"]
pub(crate) mod tests;
