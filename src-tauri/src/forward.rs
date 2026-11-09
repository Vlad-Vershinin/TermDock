//! Port forwarding over an SSH session: local (-L), remote (-R) and dynamic SOCKS5 (-D).

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{ChannelOpenHandle, Handle, Msg};
use russh::{Channel, ChannelOpenFailure};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

use crate::ssh::Client;
use crate::store::{Forward, ForwardKind};

const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Runtime state of one forward. Dropping or stopping it aborts the listener and connections.
#[derive(Default)]
struct Run {
    tasks: Mutex<JoinSet<()>>,
    active: AtomicUsize,
}

impl Run {
    fn spawn<F: std::future::Future<Output = ()> + Send + 'static>(&self, f: F) {
        let mut tasks = self.tasks.lock().unwrap();
        while tasks.try_join_next().is_some() {}
        tasks.spawn(f);
    }
}

/// Counts a live connection while it exists (also when its task is aborted).
struct ConnGuard(Arc<Run>);

impl ConnGuard {
    fn new(run: &Arc<Run>) -> Self {
        run.active.fetch_add(1, Ordering::Relaxed);
        Self(run.clone())
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}

struct RemoteTarget {
    dest_host: String,
    dest_port: u16,
    run: Arc<Run>,
}

/// Remote (-R) forwards of a connection, by the port bound on the server. Shared with the
/// connection's `Client` handler, which receives the forwarded-tcpip channels.
#[derive(Default)]
pub struct RemoteForwards {
    map: Mutex<HashMap<u32, RemoteTarget>>,
}

impl RemoteForwards {
    /// Handles a forwarded-tcpip channel opened by the server: dial the local target and pipe.
    pub fn open(&self, channel: Channel<Msg>, port: u32, reply: ChannelOpenHandle) {
        let target = self.map.lock().unwrap().get(&port).map(|t| (t.dest_host.clone(), t.dest_port, t.run.clone()));
        let Some((host, dest_port, run)) = target else {
            // Not ours (e.g. on a jump host connection): dropping `reply` rejects it.
            drop(reply);
            return;
        };
        let guard_run = run.clone();
        run.spawn(async move {
            let _guard = ConnGuard::new(&guard_run);
            let sock = match tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect((host.as_str(), dest_port))).await {
                Ok(Ok(s)) => s,
                _ => return reply.reject(ChannelOpenFailure::ConnectFailed).await,
            };
            reply.accept().await;
            pipe(sock, channel).await;
        });
    }
}

async fn pipe(mut sock: TcpStream, channel: Channel<Msg>) {
    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
    let _ = stream.shutdown().await;
}

struct Entry {
    spec: Forward,
    /// Added at runtime for this session only (not saved with the server).
    temporary: bool,
    status: String,
    /// The port actually bound (differs from spec.bind_port when it was 0).
    bound_port: Option<u32>,
    run: Option<Arc<Run>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatus {
    #[serde(flatten)]
    pub spec: Forward,
    pub temporary: bool,
    /// "active" | "stopped" | "starting" | "error: …"
    pub status: String,
    pub bound_port: Option<u32>,
    pub connections: usize,
}

/// All forwards of one session.
pub struct Forwards {
    handle: Arc<Handle<Client>>,
    remote: Arc<RemoteForwards>,
    list: tokio::sync::Mutex<Vec<Entry>>,
}

impl Forwards {
    pub fn new(handle: Arc<Handle<Client>>, remote: Arc<RemoteForwards>) -> Self {
        Self { handle, remote, list: tokio::sync::Mutex::new(Vec::new()) }
    }

    /// Registers the saved forwards and starts the enabled ones. Failures only mark the forward.
    pub async fn start_saved(&self, specs: Vec<Forward>) {
        {
            let mut list = self.list.lock().await;
            for spec in &specs {
                let status = if spec.enabled { "starting" } else { "stopped" }.to_string();
                list.push(Entry { spec: spec.clone(), temporary: false, status, bound_port: None, run: None });
            }
        }
        for spec in specs.into_iter().filter(|s| s.enabled) {
            self.start(spec).await;
        }
    }

    pub async fn status(&self) -> Vec<ForwardStatus> {
        self.list.lock().await.iter().map(status_of).collect()
    }

    /// Starts a forward (restarting it when it already runs). An unknown id is added as a
    /// temporary, session-only forward.
    pub async fn start(&self, mut spec: Forward) -> ForwardStatus {
        if spec.id.is_empty() {
            spec.id = uuid::Uuid::new_v4().to_string();
        }
        if spec.bind_host.trim().is_empty() {
            spec.bind_host = "127.0.0.1".into();
        }
        self.stop(&spec.id, false).await;
        let mut list = self.list.lock().await;
        let idx = match list.iter().position(|e| e.spec.id == spec.id) {
            Some(i) => i,
            None => {
                list.push(Entry { spec: spec.clone(), temporary: true, status: String::new(), bound_port: None, run: None });
                list.len() - 1
            }
        };
        let (status, bound, run) = match self.launch(&spec).await {
            Ok((port, run)) => ("active".to_string(), Some(port), Some(run)),
            Err(e) => (format!("error: {e}"), None, None),
        };
        let entry = &mut list[idx];
        entry.spec = spec;
        entry.status = status;
        entry.bound_port = bound;
        entry.run = run;
        status_of(entry)
    }

    /// Stops a forward; `remove` also drops it from the list.
    pub async fn stop(&self, id: &str, remove: bool) {
        let mut list = self.list.lock().await;
        let Some(i) = list.iter().position(|e| e.spec.id == id) else { return };
        let entry = &mut list[i];
        if let Some(run) = entry.run.take() {
            run.tasks.lock().unwrap().abort_all();
            if entry.spec.kind == ForwardKind::Remote {
                if let Some(port) = entry.bound_port {
                    self.remote.map.lock().unwrap().remove(&port);
                    let _ = self.handle.cancel_tcpip_forward(entry.spec.bind_host.clone(), port).await;
                }
            }
        }
        entry.status = "stopped".into();
        entry.bound_port = None;
        if remove {
            list.remove(i);
        }
    }

    /// Aborts every listener and connection (the session is closing).
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.list.lock().await.iter().map(|e| e.spec.id.clone()).collect();
        for id in ids {
            self.stop(&id, false).await;
        }
    }

    async fn launch(&self, spec: &Forward) -> Result<(u32, Arc<Run>), String> {
        let run = Arc::new(Run::default());
        match spec.kind {
            ForwardKind::Local | ForwardKind::Dynamic => {
                if spec.kind == ForwardKind::Local && (spec.dest_host.trim().is_empty() || spec.dest_port == 0) {
                    return Err(tr!("не указан адрес назначения", "no destination address"));
                }
                let listener = TcpListener::bind((spec.bind_host.as_str(), spec.bind_port)).await.map_err(|e| bind_error(spec, e))?;
                let port = listener.local_addr().map(|a| a.port() as u32).unwrap_or(spec.bind_port as u32);
                let (handle, spec, r) = (self.handle.clone(), spec.clone(), run.clone());
                run.spawn(accept_loop(listener, handle, spec, r));
                Ok((port, run))
            }
            ForwardKind::Remote => {
                if spec.dest_host.trim().is_empty() || spec.dest_port == 0 {
                    return Err(tr!("не указан адрес назначения", "no destination address"));
                }
                let target = || RemoteTarget { dest_host: spec.dest_host.clone(), dest_port: spec.dest_port, run: run.clone() };
                // Register before asking, so early connections are not rejected.
                if spec.bind_port != 0 {
                    self.remote.map.lock().unwrap().insert(spec.bind_port as u32, target());
                }
                let res = tokio::time::timeout(DIAL_TIMEOUT, self.handle.tcpip_forward(spec.bind_host.clone(), spec.bind_port as u32)).await;
                match res {
                    Ok(Ok(p)) => {
                        let port = if spec.bind_port == 0 { p } else { spec.bind_port as u32 };
                        self.remote.map.lock().unwrap().insert(port, target());
                        Ok((port, run))
                    }
                    other => {
                        self.remote.map.lock().unwrap().remove(&(spec.bind_port as u32));
                        Err(match other {
                            Err(_) => tr!("сервер не ответил на запрос проброса", "the server didn't answer the forwarding request"),
                            _ => tr!(
                                "сервер отказал в пробросе порта {} (порт занят или запрещено настройкой AllowTcpForwarding)",
                                "the server refused to forward port {} (the port is busy or AllowTcpForwarding forbids it)",
                                spec.bind_port
                            ),
                        })
                    }
                }
            }
        }
    }
}

impl Drop for Forwards {
    fn drop(&mut self) {
        // Safety net: tasks hold the session handle, so never leave them running.
        for e in self.list.get_mut() {
            if let Some(run) = &e.run {
                run.tasks.lock().unwrap().abort_all();
            }
        }
    }
}

fn status_of(e: &Entry) -> ForwardStatus {
    ForwardStatus {
        spec: e.spec.clone(),
        temporary: e.temporary,
        status: e.status.clone(),
        bound_port: e.bound_port,
        connections: e.run.as_ref().map(|r| r.active.load(Ordering::Relaxed)).unwrap_or(0),
    }
}

fn bind_error(spec: &Forward, e: std::io::Error) -> String {
    let addr = format!("{}:{}", spec.bind_host, spec.bind_port);
    match e.kind() {
        std::io::ErrorKind::AddrInUse => tr!("порт {addr} уже занят другой программой", "port {addr} is already used by another program"),
        std::io::ErrorKind::PermissionDenied => tr!(
            "нет прав открыть порт {addr} (порты ниже 1024 требуют прав администратора)",
            "no permission to open port {addr} (ports below 1024 need administrator rights)"
        ),
        std::io::ErrorKind::AddrNotAvailable => tr!("адрес {} недоступен на этом компьютере", "address {} isn't available on this computer", spec.bind_host),
        _ => tr!("не удалось открыть порт {addr}: {e}", "couldn't open port {addr}: {e}"),
    }
}

async fn accept_loop(listener: TcpListener, handle: Arc<Handle<Client>>, spec: Forward, run: Arc<Run>) {
    loop {
        let Ok((sock, peer)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let (handle, spec, r) = (handle.clone(), spec.clone(), run.clone());
        run.spawn(async move {
            let _guard = ConnGuard::new(&r);
            let (ip, port) = (peer.ip().to_string(), peer.port() as u32);
            if spec.kind == ForwardKind::Dynamic {
                socks5(sock, &handle, ip, port).await;
            } else if let Ok(ch) = handle.channel_open_direct_tcpip(spec.dest_host.clone(), spec.dest_port as u32, ip, port).await {
                pipe(sock, ch).await;
            }
        });
    }
}

/// Minimal SOCKS5 (RFC 1928): no authentication, CONNECT only; the target is opened as a
/// direct-tcpip channel, so names are resolved on the server side.
async fn socks5(mut sock: TcpStream, handle: &Handle<Client>, ip: String, port: u32) {
    let Some((host, dest_port)) = socks5_request(&mut sock).await else { return };
    match tokio::time::timeout(DIAL_TIMEOUT, handle.channel_open_direct_tcpip(host, dest_port as u32, ip, port)).await {
        Ok(Ok(ch)) => {
            if sock.write_all(&socks5_reply(0)).await.is_ok() {
                pipe(sock, ch).await;
            }
        }
        // The server could not reach the target.
        Ok(Err(russh::Error::ChannelOpenFailure(ChannelOpenFailure::ConnectFailed))) => {
            let _ = sock.write_all(&socks5_reply(5)).await;
        }
        Ok(Err(russh::Error::ChannelOpenFailure(ChannelOpenFailure::AdministrativelyProhibited))) => {
            let _ = sock.write_all(&socks5_reply(2)).await;
        }
        Ok(Err(_)) => {
            let _ = sock.write_all(&socks5_reply(1)).await;
        }
        Err(_) => {
            let _ = sock.write_all(&socks5_reply(4)).await;
        }
    }
}

fn socks5_reply(code: u8) -> [u8; 10] {
    [5, code, 0, 1, 0, 0, 0, 0, 0, 0]
}

/// Reads the greeting and the request; answers protocol errors itself. Returns the target.
async fn socks5_request<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(sock: &mut S) -> Option<(String, u16)> {
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await.ok()?;
    if head[0] != 5 {
        return None;
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await.ok()?;
    if !methods.contains(&0) {
        let _ = sock.write_all(&[5, 0xff]).await;
        return None;
    }
    sock.write_all(&[5, 0]).await.ok()?;

    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await.ok()?;
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await.ok()?;
            Ipv4Addr::from(a).to_string()
        }
        4 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await.ok()?;
            Ipv6Addr::from(a).to_string()
        }
        3 => {
            let len = sock.read_u8().await.ok()?;
            let mut name = vec![0u8; len as usize];
            sock.read_exact(&mut name).await.ok()?;
            String::from_utf8(name).ok()?
        }
        _ => {
            let _ = sock.write_all(&socks5_reply(8)).await; // address type not supported
            return None;
        }
    };
    let port = sock.read_u16().await.ok()?;
    if req[0] != 5 || req[1] != 1 {
        let _ = sock.write_all(&socks5_reply(7)).await; // command not supported
        return None;
    }
    Some((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn request(bytes: &[u8]) -> (Option<(String, u16)>, Vec<u8>) {
        let (mut client, mut server) = tokio::io::duplex(1024);
        client.write_all(bytes).await.unwrap();
        let res = socks5_request(&mut server).await;
        drop(server);
        let mut out = Vec::new();
        client.read_to_end(&mut out).await.unwrap();
        (res, out)
    }

    #[tokio::test]
    async fn socks5_parses_address_types() {
        let (r, out) = request(&[5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 1, 0, 80]).await;
        assert_eq!(r, Some(("10.0.0.1".into(), 80)));
        assert_eq!(out, [5, 0]);

        let mut domain = vec![5, 1, 0, 5, 1, 0, 3, 11];
        domain.extend_from_slice(b"example.com");
        domain.extend_from_slice(&443u16.to_be_bytes());
        assert_eq!(request(&domain).await.0, Some(("example.com".into(), 443)));

        let mut v6 = vec![5, 1, 0, 5, 1, 0, 4];
        v6.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        v6.extend_from_slice(&[0, 22]);
        assert_eq!(request(&v6).await.0, Some(("::1".into(), 22)));
    }

    #[tokio::test]
    async fn socks5_rejects_unsupported() {
        // Only username/password offered.
        assert_eq!(request(&[5, 1, 2]).await, (None, vec![5, 0xff]));
        // BIND command.
        let (r, out) = request(&[5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 80]).await;
        assert_eq!(r, None);
        assert_eq!(out[..2], [5, 0]);
        assert_eq!(out[2..4], [5, 7]);
    }
}
