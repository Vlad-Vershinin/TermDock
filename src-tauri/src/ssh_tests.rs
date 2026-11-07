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
pub(crate) async fn open_accepting(mut hops: Vec<Hop>) -> Result<(Vec<Handle<Client>>, Handle<Client>), String> {
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
    let (_, h) = open_accepting(vec![test_hop("t", port("TD_SSH_PORT"), AuthMethod::Agent)]).await.unwrap();
    assert_eq!(run(&h, "whoami").await.trim(), env("TD_SSH_USER").unwrap_or_else(|| "tdtest".into()));
}

#[tokio::test]
#[ignore]
async fn agent_auth_through_jump() {
    let hops = vec![test_hop("j", port("TD_SSH_PORT2"), AuthMethod::Agent), test_hop("t", port("TD_SSH_PORT"), AuthMethod::Agent)];
    let (jumps, h) = open_accepting(hops).await.unwrap();
    assert_eq!(jumps.len(), 1);
    assert!(!run(&h, "echo ok").await.is_empty());
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
