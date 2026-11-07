//! Integration tests against a real sshd. Ignored by default; run with e.g.
//! `TD_SSH_PORT=2222 TD_SSH_USER=tdtest SSH_AUTH_SOCK=... cargo test -- --ignored --test-threads=1`.
//! TD_SSH_PORT2 (optional) is a second sshd used as a jump host.

use super::*;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

pub(crate) fn test_hop(id: &str, port: u16, auth: AuthMethod) -> Hop {
    Hop {
        id: id.into(),
        host: env("TD_SSH_HOST").unwrap_or_else(|| "127.0.0.1".into()),
        port,
        username: env("TD_SSH_USER").unwrap_or_else(|| "tdtest".into()),
        auth,
        key_path: env("TD_SSH_KEY"),
        secret: env("TD_SSH_PASSWORD"),
        accept_fingerprint: None,
    }
}

pub(crate) fn port(name: &str) -> u16 {
    env(name).and_then(|p| p.parse().ok()).unwrap_or_else(|| panic!("{name} is not set"))
}

/// Opens the chain, accepting unknown host keys the way the UI would.
pub(crate) async fn open_accepting(mut hops: Vec<Hop>) -> Result<Chain, String> {
    let known = std::env::temp_dir().join(format!("td-known-{}", uuid::Uuid::new_v4()));
    for _ in 0..=hops.len() {
        match open_chain(&hops, &known).await {
            Err(e) if e.contains("HOSTKEY_UNKNOWN|") => {
                let (id, rest) = match e.strip_prefix("JUMP|") {
                    Some(r) => {
                        let mut it = r.splitn(4, '|');
                        let id = it.next().unwrap().to_string();
                        (id, it.nth(2).unwrap().to_string())
                    }
                    None => (hops.last().unwrap().id.clone(), e.clone()),
                };
                let fp = rest.split('|').nth(1).unwrap().to_string();
                hops.iter_mut().find(|h| h.id == id).unwrap().accept_fingerprint = Some(fp);
            }
            other => {
                let _ = std::fs::remove_file(&known);
                return other;
            }
        }
    }
    Err("host keys not accepted".into())
}

pub(crate) async fn run(handle: &Handle<Client>, cmd: &str) -> String {
    let mut ch = handle.channel_open_session().await.unwrap();
    ch.exec(true, cmd).await.unwrap();
    let mut out = Vec::new();
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tokio::test]
#[ignore]
async fn agent_auth_works() {
    let h = open_accepting(vec![test_hop("t", port("TD_SSH_PORT"), AuthMethod::Agent)]).await.unwrap().handle;
    assert_eq!(run(&h, "whoami").await.trim(), env("TD_SSH_USER").unwrap_or_else(|| "tdtest".into()));
}

#[tokio::test]
#[ignore]
async fn agent_auth_through_jump() {
    let hops = vec![test_hop("j", port("TD_SSH_PORT2"), AuthMethod::Agent), test_hop("t", port("TD_SSH_PORT"), AuthMethod::Agent)];
    let c = open_accepting(hops).await.unwrap();
    assert_eq!(c.jumps.len(), 1);
    assert!(!run(&c.handle, "echo ok").await.is_empty());
}

#[tokio::test]
#[ignore]
async fn agent_rejected_or_missing_gives_clear_error() {
    // A user the agent's keys don't belong to.
    let mut hop = test_hop("t", port("TD_SSH_PORT"), AuthMethod::Agent);
    hop.username = "nobody".into();
    let e = open_accepting(vec![hop]).await.err().unwrap();
    assert!(e.contains("отклонил все ключи"), "{e}");
}

// ---------- port forwarding ----------

use crate::forward::Forwards;
use crate::store::ForwardKind;

/// A tiny HTTP server on 127.0.0.1 answering "hello-<tag>"; returns its port.
async fn http_server(tag: &'static str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf).await;
                let body = format!("hello-{tag}");
                let _ = s.write_all(format!("HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await;
            });
        }
    });
    port
}

async fn curl(args: &[&str]) -> String {
    let out = tokio::process::Command::new("curl").args(["-s", "--max-time", "10"]).args(args).output().await.unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn fwd(kind: ForwardKind, bind_port: u16, dest_port: u16) -> Forward {
    Forward { id: format!("{kind:?}-{bind_port}"), kind, bind_port, dest_host: "127.0.0.1".into(), dest_port, ..Default::default() }
}

/// Runs through the jump host when TD_SSH_PORT2 is set: forwards must work through it too.
#[tokio::test]
#[ignore]
async fn local_dynamic_and_remote_forwards() {
    let mut hops = vec![test_hop("t", port("TD_SSH_PORT"), AuthMethod::Agent)];
    if env("TD_SSH_PORT2").is_some() {
        hops.insert(0, test_hop("j", port("TD_SSH_PORT2"), AuthMethod::Agent));
    }
    let Chain { jumps: _jumps, handle, remote } = open_accepting(hops).await.unwrap();
    let handle = Arc::new(handle);
    let fw = Forwards::new(handle.clone(), remote);
    let http = http_server("srv").await;

    // -L: local port → 127.0.0.1:<http> as seen from the server.
    let l = fw.start(fwd(ForwardKind::Local, 0, http)).await;
    assert_eq!(l.status, "active", "{}", l.status);
    let lp = l.bound_port.unwrap().to_string();
    assert_eq!(curl(&[&format!("http://127.0.0.1:{lp}/")]).await, "hello-srv");

    // -D: SOCKS5, the name is resolved on the server.
    let d = fw.start(Forward { dest_host: String::new(), ..fwd(ForwardKind::Dynamic, 0, 0) }).await;
    assert_eq!(d.status, "active", "{}", d.status);
    let socks = format!("127.0.0.1:{}", d.bound_port.unwrap());
    assert_eq!(curl(&["--socks5-hostname", &socks, &format!("http://localhost:{http}/")]).await, "hello-srv");
    assert_eq!(curl(&["--socks5", &socks, &format!("http://127.0.0.1:{http}/")]).await, "hello-srv");
    // A closed port on the server side: curl gets a proper SOCKS failure, not a hang.
    let refused = tokio::process::Command::new("curl")
        .args(["-s", "--max-time", "10", "--socks5-hostname", &socks, "http://127.0.0.1:1/"])
        .status()
        .await
        .unwrap();
    assert_eq!(refused.code(), Some(97), "curl: SOCKS connection failed");

    // -R: a port on the server → our local HTTP server.
    let local_http = http_server("local").await;
    let r = fw.start(fwd(ForwardKind::Remote, 0, local_http)).await;
    assert_eq!(r.status, "active", "{}", r.status);
    let rp = r.bound_port.unwrap();
    let out = run(&handle, &format!("curl -s --max-time 10 http://127.0.0.1:{rp}/")).await;
    assert_eq!(out, "hello-local");

    // A busy port is reported per forward, the session keeps working.
    let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let bp = busy.local_addr().unwrap().port();
    let b = fw.start(fwd(ForwardKind::Local, bp, http)).await;
    assert!(b.status.starts_with("error: ") && b.status.contains("занят"), "{}", b.status);
    assert_eq!(run(&handle, "echo alive").await.trim(), "alive");
    assert_eq!(fw.status().await.len(), 4);

    // Stopping frees the local port and cancels the remote one.
    fw.stop(&l.spec.id, false).await;
    assert!(tokio::net::TcpStream::connect(format!("127.0.0.1:{lp}")).await.is_err());
    fw.stop(&r.spec.id, true).await;
    let out = run(&handle, &format!("curl -s --max-time 5 http://127.0.0.1:{rp}/ || echo refused")).await;
    assert_eq!(out.trim(), "refused");
    assert_eq!(fw.status().await.len(), 3);

    fw.stop_all().await;
    assert!(tokio::net::TcpStream::connect(socks).await.is_err());
}
