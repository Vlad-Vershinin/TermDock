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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::textcodec::{self, Decoded};

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

/// One planned step of a transfer. `S`/`D` are the source/destination path types
/// (PathBuf for the local side, String for a remote one).
enum Item<S, D> {
    Dir(D),
    File { src: S, dst: D, size: u64, mode: Option<u32> },
}

fn plan_upload(local: &Path, remote_dir: &str, out: &mut Vec<Item<PathBuf, String>>) -> Result<(), String> {
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| tr!("Некорректный путь", "Invalid path"))?;
    let remote = join_remote(remote_dir, &name);
    let meta = std::fs::metadata(local).map_err(|e| format!("{}: {e}", local.display()))?;
    if meta.is_dir() {
        out.push(Item::Dir(remote.clone()));
        for e in std::fs::read_dir(local).map_err(|e| e.to_string())?.flatten() {
            plan_upload(&e.path(), &remote, out)?;
        }
    } else {
        out.push(Item::File { src: local.to_path_buf(), dst: remote, size: meta.len(), mode: None });
    }
    Ok(())
}

/// Walks a remote tree; `join(dir, name)` builds destination paths (local or remote).
async fn plan_remote<D: Clone>(sftp: &SftpSession, remote: &str, dst_dir: D, join: impl Fn(&D, &str) -> D, out: &mut Vec<Item<String, D>>) -> Result<(), String> {
    // Iterative walk (async recursion would need boxing).
    let mut stack = vec![(remote.to_string(), dst_dir)];
    while let Some((rpath, ddir)) = stack.pop() {
        let meta = sftp.metadata(rpath.clone()).await.map_err(|e| format!("{rpath}: {e}"))?;
        let dst = join(&ddir, &remote_name(&rpath));
        if meta.is_dir() {
            out.push(Item::Dir(dst.clone()));
            for e in sftp.read_dir(rpath.clone()).await.map_err(|e| e.to_string())? {
                let n = e.file_name();
                if n != "." && n != ".." {
                    stack.push((join_remote(&rpath, &n), dst.clone()));
                }
            }
        } else {
            out.push(Item::File { src: rpath, dst, size: meta.size.unwrap_or(0), mode: meta.permissions });
        }
    }
    Ok(())
}

fn new_reporter<S, D>(app: AppHandle, id: &str, cancel: Arc<AtomicBool>, items: &[Item<S, D>]) -> Reporter {
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

/// Streams `src` into `dst` chunk by chunk, reporting progress and honouring cancel.
async fn pump<R, W>(r: &mut Reporter, src: &mut R, dst: &mut W, src_name: &str, dst_name: &str) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    loop {
        r.check_cancel()?;
        let n = src.read(&mut buf).await.map_err(|e| format!("{src_name}: {e}"))?;
        if n == 0 {
            return Ok(());
        }
        dst.write_all(&buf[..n]).await.map_err(|e| format!("{dst_name}: {e}"))?;
        r.p.transferred += n as u64;
        r.emit(false);
    }
}

/// Creates a remote directory, ignoring "already exists".
async fn ensure_remote_dir(sftp: &SftpSession, d: &str) -> Result<(), String> {
    if sftp.create_dir(d).await.is_err() && !sftp.try_exists(d).await.unwrap_or(false) {
        return Err(tr!("Не удалось создать каталог {d}", "Couldn't create folder {d}"));
    }
    Ok(())
}

async fn create_remote(sftp: &SftpSession, path: &str) -> Result<russh_sftp::client::fs::File, String> {
    sftp.open_with_flags(path, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
        .await
        .map_err(|e| format!("{path}: {e}"))
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
                Item::Dir(d) => ensure_remote_dir(&sftp, d).await?,
                Item::File { src: local, dst: remote, .. } => {
                    r.p.current = remote.clone();
                    r.emit(true);
                    let mut src = tokio::fs::File::open(local).await.map_err(|e| format!("{}: {e}", local.display()))?;
                    let mut dst = create_remote(&sftp, remote).await?;
                    pump(&mut r, &mut src, &mut dst, &local.to_string_lossy(), remote).await?;
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
        plan_remote(&sftp, rp, PathBuf::from(&local_dir), |d: &PathBuf, n| d.join(n), &mut items).await?;
    }
    let mut r = new_reporter(app, &id, cancel, &items);
    r.emit(true);
    let res = async {
        for item in &items {
            r.check_cancel()?;
            match item {
                Item::Dir(d) => tokio::fs::create_dir_all(d).await.map_err(|e| format!("{}: {e}", d.display()))?,
                Item::File { src: remote, dst: local, .. } => {
                    r.p.current = remote.clone();
                    r.emit(true);
                    let mut src = sftp.open(remote.clone()).await.map_err(|e| format!("{remote}: {e}"))?;
                    if let Some(parent) = local.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    let mut dst = tokio::fs::File::create(local).await.map_err(|e| format!("{}: {e}", local.display()))?;
                    pump(&mut r, &mut src, &mut dst, remote, &local.to_string_lossy()).await?;
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

/// Rejects copies that would overwrite their own source or nest a folder in itself.
/// Only meaningful when source and destination are the same server.
fn check_same_server(remotes: &[String], dst_dir: &str) -> Result<(), String> {
    let dst = dst_dir.trim_end_matches('/');
    for rp in remotes {
        let src = rp.trim_end_matches('/');
        let parent = src.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        if parent == dst {
            return Err(tr!("{src}: файл уже находится в этой папке", "{src}: already in this folder"));
        }
        if dst == src || dst.starts_with(&format!("{src}/")) {
            return Err(tr!("{src}: нельзя скопировать папку внутрь самой себя", "{src}: can't copy a folder into itself"));
        }
    }
    Ok(())
}

/// Copies remote files/folders from one SFTP session to another (or within one),
/// streaming the data through this machine without temp files.
#[allow(clippy::too_many_arguments)]
pub async fn copy_remote(
    app: AppHandle,
    src_sftp: Arc<SftpSession>,
    dst_sftp: Arc<SftpSession>,
    same_session: bool,
    id: String,
    cancel: Arc<AtomicBool>,
    remotes: Vec<String>,
    dst_dir: String,
) -> Result<(), String> {
    if same_session {
        check_same_server(&remotes, &dst_dir)?;
    }
    let mut items = vec![];
    for rp in &remotes {
        plan_remote(&src_sftp, rp, dst_dir.clone(), |d: &String, n| join_remote(d, n), &mut items).await?;
    }
    let mut r = new_reporter(app, &id, cancel, &items);
    r.emit(true);
    let res = async {
        for item in &items {
            r.check_cancel()?;
            match item {
                Item::Dir(d) => ensure_remote_dir(&dst_sftp, d).await?,
                Item::File { src: from, dst: to, mode, .. } => {
                    r.p.current = from.clone();
                    r.emit(true);
                    let mut src = src_sftp.open(from.clone()).await.map_err(|e| format!("{from}: {e}"))?;
                    let mut dst = create_remote(&dst_sftp, to).await?;
                    pump(&mut r, &mut src, &mut dst, from, to).await?;
                    dst.shutdown().await.map_err(|e| format!("{to}: {e}"))?;
                    if let Some(m) = mode {
                        // Best effort: keep the permission bits (e.g. executables).
                        let attrs = russh_sftp::protocol::FileAttributes { permissions: Some(m & 0o7777), ..Default::default() };
                        let _ = dst_sftp.set_metadata(to.clone(), attrs).await;
                    }
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

/// Files larger than this open only after the user confirms (UI gets `TOO_BIG|<bytes>`).
const MAX_EDIT: u64 = 5 * 1024 * 1024;
/// Hard limit for the built-in editor.
const MAX_EDIT_LARGE: u64 = 100 * 1024 * 1024;

fn check_size(path: &str, size: u64, allow_large: bool) -> Result<(), String> {
    if size > MAX_EDIT_LARGE {
        Err(tr!(
            "{path}: файл слишком большой для встроенного редактора ({} МБ, максимум 100 МБ)",
            "{path}: the file is too large for the built-in editor ({} MB, 100 MB max)",
            size / 1024 / 1024
        ))
    } else if size > MAX_EDIT && !allow_large {
        Err(format!("TOO_BIG|{size}"))
    } else {
        Ok(())
    }
}

fn decode_text(path: &str, bytes: &[u8], encoding: Option<&str>) -> Result<Decoded, String> {
    textcodec::decode(bytes, encoding).map_err(|e| format!("{path}: {e}"))
}

pub async fn read_local_text(path: &str, encoding: Option<&str>, allow_large: bool) -> Result<Decoded, String> {
    let meta = tokio::fs::metadata(path).await.map_err(|e| format!("{path}: {e}"))?;
    check_size(path, meta.len(), allow_large)?;
    let bytes = tokio::fs::read(path).await.map_err(|e| format!("{path}: {e}"))?;
    decode_text(path, &bytes, encoding)
}

pub async fn read_remote_text(sftp: &SftpSession, path: &str, encoding: Option<&str>, allow_large: bool) -> Result<Decoded, String> {
    let meta = sftp.metadata(path).await.map_err(|e| format!("{path}: {e}"))?;
    check_size(path, meta.size.unwrap_or(0), allow_large)?;
    let bytes = sftp.read(path).await.map_err(|e| format!("{path}: {e}"))?;
    // Size may be unknown (or the file grew) — check what was actually read.
    check_size(path, bytes.len() as u64, allow_large)?;
    decode_text(path, &bytes, encoding)
}

fn encode_text(path: &str, content: &str, encoding: &str, bom: bool) -> Result<Vec<u8>, String> {
    textcodec::encode(content, encoding, bom).map_err(|e| format!("{path}: {e}"))
}

/// Encodes first, so an unrepresentable character never truncates the file.
pub async fn write_local_text(path: &str, content: &str, encoding: &str, bom: bool) -> Result<(), String> {
    let bytes = encode_text(path, content, encoding, bom)?;
    tokio::fs::write(path, bytes).await.map_err(|e| format!("{path}: {e}"))
}

/// Overwrites (truncates) the file, keeping its permissions.
pub async fn write_remote_text(sftp: &SftpSession, path: &str, content: &str, encoding: &str, bom: bool) -> Result<(), String> {
    let bytes = encode_text(path, content, encoding, bom)?;
    let mut f = sftp
        .open_with_flags(path, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
        .await
        .map_err(|e| format!("{path}: {e}"))?;
    f.write_all(&bytes).await.map_err(|e| format!("{path}: {e}"))?;
    f.shutdown().await.map_err(|e| format!("{path}: {e}"))
}

/// Creates an empty file; fails if it already exists.
pub async fn create_remote_file(sftp: &SftpSession, path: &str) -> Result<(), String> {
    if sftp.try_exists(path).await.unwrap_or(false) {
        return Err(tr!("{path}: уже существует", "{path}: already exists"));
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
        .map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { tr!("{path}: уже существует", "{path}: already exists") } else { format!("{path}: {e}") })
}

#[cfg(test)]
mod tests {
    use super::check_same_server;

    #[test]
    fn same_server_guard() {
        let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(check_same_server(&v(&["/a/f.txt"]), "/a").is_err());
        assert!(check_same_server(&v(&["/a/f.txt"]), "/a/").is_err());
        assert!(check_same_server(&v(&["/a/d"]), "/a/d/sub").is_err());
        assert!(check_same_server(&v(&["/a/d"]), "/a/d").is_err());
        assert!(check_same_server(&v(&["/f"]), "/").is_err());
        assert!(check_same_server(&v(&["/a/d"]), "/a/dd").is_ok());
        assert!(check_same_server(&v(&["/a/f.txt"]), "/b").is_ok());
    }
}
