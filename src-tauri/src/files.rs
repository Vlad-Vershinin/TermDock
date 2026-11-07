//! Local + remote (SFTP) file browsing and recursive transfers with progress.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    /// Unix seconds.
    pub modified: Option<u64>,
    /// Unix permission bits (remote only).
    pub mode: Option<u32>,
}

fn sort_entries(v: &mut [Entry]) {
    v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
}

pub fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn remote_name(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

// ---------- local ----------

pub fn list_local(path: &str) -> Result<Vec<Entry>, String> {
    #[cfg(windows)]
    if path.is_empty() {
        // Virtual root on Windows: list drives.
        return Ok(('A'..='Z')
            .map(|c| format!("{c}:\\"))
            .filter(|d| Path::new(d).exists())
            .map(|d| Entry { name: d.clone(), path: d, is_dir: true, is_link: false, size: 0, modified: None, mode: None })
            .collect());
    }
    let mut out = vec![];
    for e in std::fs::read_dir(path).map_err(|e| format!("{path}: {e}"))? {
        let Ok(e) = e else { continue };
        let p = e.path();
        let is_link = e.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        let Ok(meta) = std::fs::metadata(&p).or_else(|_| e.metadata()) else { continue };
        out.push(Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            is_link,
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()),
            mode: None,
        });
    }
    sort_entries(&mut out);
    Ok(out)
}

// ---------- remote ----------

pub async fn list_remote(sftp: &SftpSession, path: &str) -> Result<Vec<Entry>, String> {
    let dir = sftp.read_dir(path).await.map_err(|e| format!("{path}: {e}"))?;
    let mut out = vec![];
    for e in dir {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let full = join_remote(path, &name);
        let mut meta = e.metadata();
        let is_link = meta.is_symlink();
        if is_link {
            // Resolve symlinks so linked directories can be opened.
            if let Ok(m) = sftp.metadata(full.clone()).await {
                meta = m;
            }
        }
        let is_dir = meta.is_dir();
        out.push(Entry {
            name,
            path: full,
            is_dir,
            is_link,
            size: if is_dir { 0 } else { meta.size.unwrap_or(0) },
            modified: meta.mtime.map(|t| t as u64),
            mode: meta.permissions,
        });
    }
    sort_entries(&mut out);
    Ok(out)
}

pub async fn remove_remote(sftp: &SftpSession, path: &str) -> Result<(), String> {
    let meta = sftp.symlink_metadata(path).await.map_err(|e| e.to_string())?;
    if meta.is_dir() {
        // Depth-first, iterative to avoid async recursion.
        let mut stack = vec![(path.to_string(), false)];
        while let Some((dir, visited)) = stack.pop() {
            if visited {
                sftp.remove_dir(dir.clone()).await.map_err(|e| format!("{dir}: {e}"))?;
                continue;
            }
            stack.push((dir.clone(), true));
            for e in sftp.read_dir(dir.clone()).await.map_err(|e| e.to_string())? {
                let name = e.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let p = join_remote(&dir, &name);
                if e.metadata().is_dir() {
                    stack.push((p, false));
                } else {
                    sftp.remove_file(p.clone()).await.map_err(|e| format!("{p}: {e}"))?;
                }
            }
        }
        Ok(())
    } else {
        sftp.remove_file(path).await.map_err(|e| e.to_string())
    }
}

// ---------- transfers ----------

#[derive(Default)]
pub struct Transfers {
    cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Transfers {
    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancel.lock().unwrap().insert(id.to_string(), flag.clone());
        flag
    }
    pub fn cancel(&self, id: &str) {
        if let Some(f) = self.cancel.lock().unwrap().get(id) {
            f.store(true, Ordering::Relaxed);
        }
    }
    pub fn finish(&self, id: &str) {
        self.cancel.lock().unwrap().remove(id);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub transferred: u64,
    pub total: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub current: String,
    /// "running" | "done" | "error" | "cancelled"
    pub status: String,
    pub error: Option<String>,
}

struct Reporter {
    app: AppHandle,
    p: Progress,
    last: Instant,
    cancel: Arc<AtomicBool>,
}

impl Reporter {
    fn emit(&mut self, force: bool) {
        if force || self.last.elapsed().as_millis() >= 100 {
            self.last = Instant::now();
            let _ = self.app.emit("transfer-progress", self.p.clone());
        }
    }
    fn check_cancel(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) {
            Err("CANCELLED".into())
        } else {
            Ok(())
        }
    }
}

const CHUNK: usize = 256 * 1024;

enum Item {
    Dir(String),
    File { local: PathBuf, remote: String, size: u64 },
}

fn plan_upload(local: &Path, remote_dir: &str, out: &mut Vec<Item>) -> Result<(), String> {
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("Некорректный путь")?;
    let remote = join_remote(remote_dir, &name);
    let meta = std::fs::metadata(local).map_err(|e| format!("{}: {e}", local.display()))?;
    if meta.is_dir() {
        out.push(Item::Dir(remote.clone()));
        for e in std::fs::read_dir(local).map_err(|e| e.to_string())?.flatten() {
            plan_upload(&e.path(), &remote, out)?;
        }
    } else {
        out.push(Item::File { local: local.to_path_buf(), remote, size: meta.len() });
    }
    Ok(())
}

async fn plan_download(sftp: &SftpSession, remote: &str, local_dir: &Path, out: &mut Vec<Item>) -> Result<(), String> {
    // Iterative walk (async recursion would need boxing).
    let mut stack = vec![(remote.to_string(), local_dir.to_path_buf())];
    while let Some((rpath, ldir)) = stack.pop() {
        let meta = sftp.metadata(rpath.clone()).await.map_err(|e| format!("{rpath}: {e}"))?;
        let local = ldir.join(remote_name(&rpath));
        if meta.is_dir() {
            out.push(Item::Dir(local.to_string_lossy().into_owned()));
            for e in sftp.read_dir(rpath.clone()).await.map_err(|e| e.to_string())? {
                let n = e.file_name();
                if n != "." && n != ".." {
                    stack.push((join_remote(&rpath, &n), local.clone()));
                }
            }
        } else {
            out.push(Item::File { local, remote: rpath, size: meta.size.unwrap_or(0) });
        }
    }
    Ok(())
}

fn new_reporter(app: AppHandle, id: &str, cancel: Arc<AtomicBool>, items: &[Item]) -> Reporter {
    let (total, files) = items.iter().fold((0u64, 0u32), |(t, n), i| match i {
        Item::File { size, .. } => (t + size, n + 1),
        Item::Dir(_) => (t, n),
    });
    Reporter {
        app,
        last: Instant::now(),
        cancel,
        p: Progress {
            id: id.to_string(),
            transferred: 0,
            total,
            files_done: 0,
            files_total: files,
            current: String::new(),
            status: "running".into(),
            error: None,
        },
    }
}

fn finish(mut r: Reporter, res: Result<(), String>) -> Result<(), String> {
    match &res {
        Ok(()) => r.p.status = "done".into(),
        Err(e) if e == "CANCELLED" => r.p.status = "cancelled".into(),
        Err(e) => {
            r.p.status = "error".into();
            r.p.error = Some(e.clone());
        }
    }
    r.emit(true);
    res
}

pub async fn upload(app: AppHandle, sftp: Arc<SftpSession>, id: String, cancel: Arc<AtomicBool>, locals: Vec<String>, remote_dir: String) -> Result<(), String> {
    let mut items = vec![];
    for l in &locals {
        plan_upload(Path::new(l), &remote_dir, &mut items)?;
    }
    let mut r = new_reporter(app, &id, cancel, &items);
    r.emit(true);
    let res = async {
        for item in &items {
            r.check_cancel()?;
            match item {
                Item::Dir(d) => {
                    // Ignore "already exists".
                    if sftp.create_dir(d.clone()).await.is_err() && !sftp.try_exists(d.clone()).await.unwrap_or(false) {
                        return Err(format!("Не удалось создать каталог {d}"));
                    }
                }
                Item::File { local, remote, .. } => {
                    r.p.current = remote.clone();
                    r.emit(true);
                    let mut src = tokio::fs::File::open(local).await.map_err(|e| format!("{}: {e}", local.display()))?;
                    let mut dst = sftp
                        .open_with_flags(remote.clone(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
                        .await
                        .map_err(|e| format!("{remote}: {e}"))?;
                    let mut buf = vec![0u8; CHUNK];
                    loop {
                        r.check_cancel()?;
                        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
                        if n == 0 {
                            break;
                        }
                        dst.write_all(&buf[..n]).await.map_err(|e| format!("{remote}: {e}"))?;
                        r.p.transferred += n as u64;
                        r.emit(false);
                    }
                    dst.shutdown().await.map_err(|e| e.to_string())?;
                    r.p.files_done += 1;
                }
            }
        }
        Ok(())
    }
    .await;
    finish(r, res)
}

pub async fn download(app: AppHandle, sftp: Arc<SftpSession>, id: String, cancel: Arc<AtomicBool>, remotes: Vec<String>, local_dir: String) -> Result<(), String> {
    let mut items = vec![];
    for rp in &remotes {
        plan_download(&sftp, rp, Path::new(&local_dir), &mut items).await?;
    }
    let mut r = new_reporter(app, &id, cancel, &items);
    r.emit(true);
    let res = async {
        for item in &items {
            r.check_cancel()?;
            match item {
                Item::Dir(d) => tokio::fs::create_dir_all(d).await.map_err(|e| format!("{d}: {e}"))?,
                Item::File { local, remote, .. } => {
                    r.p.current = remote.clone();
                    r.emit(true);
                    let mut src = sftp.open(remote.clone()).await.map_err(|e| format!("{remote}: {e}"))?;
                    if let Some(parent) = local.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    let mut dst = tokio::fs::File::create(local).await.map_err(|e| format!("{}: {e}", local.display()))?;
                    let mut buf = vec![0u8; CHUNK];
                    loop {
                        r.check_cancel()?;
                        let n = src.read(&mut buf).await.map_err(|e| format!("{remote}: {e}"))?;
                        if n == 0 {
                            break;
                        }
                        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                        r.p.transferred += n as u64;
                        r.emit(false);
                    }
                    dst.flush().await.map_err(|e| e.to_string())?;
                    r.p.files_done += 1;
                }
            }
        }
        Ok(())
    }
    .await;
    finish(r, res)
}

// ---------- text editing ----------

/// Files larger than this are not opened in the built-in editor.
const MAX_EDIT: u64 = 5 * 1024 * 1024;

fn decode_text(path: &str, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err(format!("{path}: похоже на двоичный файл — встроенный редактор открывает только текст"));
    }
    String::from_utf8(bytes).map_err(|_| format!("{path}: файл не в кодировке UTF-8"))
}

fn too_big(path: &str, size: u64) -> Result<(), String> {
    if size > MAX_EDIT {
        Err(format!("{path}: файл слишком большой для редактора ({} МБ, максимум 5 МБ)", size / 1024 / 1024))
    } else {
        Ok(())
    }
}

pub async fn read_local_text(path: &str) -> Result<String, String> {
    let meta = tokio::fs::metadata(path).await.map_err(|e| format!("{path}: {e}"))?;
    too_big(path, meta.len())?;
    let bytes = tokio::fs::read(path).await.map_err(|e| format!("{path}: {e}"))?;
    decode_text(path, bytes)
}

pub async fn read_remote_text(sftp: &SftpSession, path: &str) -> Result<String, String> {
    let meta = sftp.metadata(path).await.map_err(|e| format!("{path}: {e}"))?;
    too_big(path, meta.size.unwrap_or(0))?;
    let bytes = sftp.read(path).await.map_err(|e| format!("{path}: {e}"))?;
    decode_text(path, bytes)
}

/// Overwrites (truncates) the file, keeping its permissions.
pub async fn write_remote_text(sftp: &SftpSession, path: &str, content: &str) -> Result<(), String> {
    let mut f = sftp
        .open_with_flags(path, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
        .await
        .map_err(|e| format!("{path}: {e}"))?;
    f.write_all(content.as_bytes()).await.map_err(|e| format!("{path}: {e}"))?;
    f.shutdown().await.map_err(|e| format!("{path}: {e}"))
}

/// Creates an empty file; fails if it already exists.
pub async fn create_remote_file(sftp: &SftpSession, path: &str) -> Result<(), String> {
    if sftp.try_exists(path).await.unwrap_or(false) {
        return Err(format!("{path}: уже существует"));
    }
    let mut f = sftp
        .open_with_flags(path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
        .await
        .map_err(|e| format!("{path}: {e}"))?;
    f.shutdown().await.map_err(|e| format!("{path}: {e}"))
}

pub async fn create_local_file(path: &str) -> Result<(), String> {
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map(|_| ())
        .map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { format!("{path}: уже существует") } else { format!("{path}: {e}") })
}
