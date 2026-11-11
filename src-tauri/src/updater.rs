//! App updates from GitHub releases: check the latest release, download the package that matches
//! how this copy was installed, verify it against the SHA-256 digest GitHub publishes for every
//! release asset, install it and restart.
//!
//! Install methods: the NSIS setup (passive, restarts the app itself), MSI (`msiexec /passive`),
//! AppImage (the file is replaced in place), deb / rpm / pacman packages (through `pkexec`, which
//! asks for the admin password). Anything else (dev builds, other CPUs, a build from source) only
//! gets a link to the release page.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

const LATEST_URL: &str = "https://api.github.com/repos/Vlad-Vershinin/TermDock/releases/latest";

#[derive(Debug, Deserialize, Clone)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize, Clone)]
struct GhAsset {
    name: String,
    size: u64,
    browser_download_url: String,
    /// "sha256:<hex>"; GitHub computes it on upload.
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Nsis,
    Msi,
    Appimage,
    Deb,
    Rpm,
    Pacman,
    Manual,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    /// The latest release is newer than this copy.
    pub available: bool,
    /// Release notes (Markdown).
    pub notes: String,
    pub url: String,
    pub published_at: Option<String>,
    /// How the update would be installed; `manual` = only the release page.
    pub method: Method,
    pub asset: Option<String>,
    pub size: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Progress {
    Download { received: u64, total: u64 },
    Install,
}

#[derive(Default)]
pub struct Updater {
    busy: AtomicBool,
    cancel: AtomicBool,
}

/// "v1.10.2" → [1, 10, 2]; a pre-release suffix is ignored.
fn parse_version(v: &str) -> Vec<u64> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let v = v.split(['-', '+']).next().unwrap_or("");
    let mut out: Vec<u64> = v.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    while out.len() < 3 {
        out.push(0);
    }
    out
}

fn is_newer(latest: &str, current: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

fn asset_for(method: Method, assets: &[GhAsset]) -> Option<&GhAsset> {
    let suffix = match method {
        Method::Nsis => "-setup.exe",
        Method::Msi => ".msi",
        Method::Appimage => ".AppImage",
        Method::Deb => ".deb",
        Method::Rpm => ".rpm",
        Method::Pacman => ".pkg.tar.zst",
        Method::Manual => return None,
    };
    assets.iter().find(|a| a.name.ends_with(suffix))
}

/// The running executable; on Linux a replaced binary reads as "/usr/bin/x (deleted)".
fn current_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let s = exe.to_string_lossy();
    Some(match s.strip_suffix(" (deleted)") {
        Some(p) => PathBuf::from(p),
        None => exe,
    })
}

/// How this copy was installed (computed once).
pub fn method() -> Method {
    static METHOD: OnceLock<Method> = OnceLock::new();
    *METHOD.get_or_init(detect)
}

fn detect() -> Method {
    // Releases only ship x86_64 builds; a dev build must never overwrite an installed app.
    if cfg!(debug_assertions) || !cfg!(target_arch = "x86_64") {
        return Method::Manual;
    }
    #[cfg(windows)]
    {
        // The NSIS setup installs per user (into %LOCALAPPDATA%), the MSI into Program Files.
        let (Some(exe), Some(local)) = (current_exe(), dirs::data_local_dir()) else { return Method::Manual };
        return if exe.starts_with(local) { Method::Nsis } else { Method::Msi };
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some_and(|p| Path::new(&p).is_file()) {
            return Method::Appimage;
        }
        let Some(exe) = current_exe() else { return Method::Manual };
        // Ask each package manager whether it owns the binary.
        for (cmd, arg, m) in [("dpkg", "-S", Method::Deb), ("rpm", "-qf", Method::Rpm), ("pacman", "-Qo", Method::Pacman)] {
            let owned = std::process::Command::new(cmd)
                .arg(arg)
                .arg(&exe)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            if owned {
                return m;
            }
        }
    }
    #[allow(unreachable_code)]
    Method::Manual
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("TermDock/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

fn net_err(e: reqwest::Error) -> String {
    tr!("Не удалось связаться с GitHub: {e}", "Couldn't reach GitHub: {e}")
}

async fn latest_release() -> Result<GhRelease, String> {
    let res = client()?
        .get(LATEST_URL)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(net_err)?;
    let status = res.status();
    if !status.is_success() {
        return Err(if status.as_u16() == 403 || status.as_u16() == 429 {
            tr!("GitHub временно ограничил запросы, попробуйте позже", "GitHub is rate-limiting requests, try again later")
        } else {
            tr!("GitHub ответил ошибкой {status}", "GitHub returned {status}")
        });
    }
    let bytes = res.bytes().await.map_err(net_err)?;
    serde_json::from_slice(&bytes).map_err(|e| tr!("Непонятный ответ GitHub: {e}", "Unexpected answer from GitHub: {e}"))
}

fn info(rel: &GhRelease, current: &str) -> UpdateInfo {
    let mut method = method();
    let asset = asset_for(method, &rel.assets);
    if asset.is_none() {
        method = Method::Manual;
    }
    UpdateInfo {
        current: current.to_string(),
        latest: rel.tag_name.trim_start_matches(['v', 'V']).to_string(),
        available: is_newer(&rel.tag_name, current),
        notes: rel.body.clone().unwrap_or_default(),
        url: rel.html_url.clone(),
        published_at: rel.published_at.clone(),
        method,
        asset: asset.map(|a| a.name.clone()),
        size: asset.map(|a| a.size),
    }
}

pub async fn check(current: &str) -> Result<UpdateInfo, String> {
    Ok(info(&latest_release().await?, current))
}

/// Checks a downloaded file against GitHub's "sha256:<hex>" digest.
fn digest_matches(expected: &str, actual: &[u8]) -> bool {
    let Some(hex) = expected.strip_prefix("sha256:") else { return false };
    let actual: String = actual.iter().map(|b| format!("{b:02x}")).collect();
    hex.eq_ignore_ascii_case(&actual)
}

impl Updater {
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Downloads and installs the latest release, then restarts the app (returns only on error).
    pub async fn install(&self, app: &AppHandle, current: &str, progress: &Channel<Progress>) -> Result<(), String> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(tr!("Обновление уже идёт", "An update is already in progress"));
        }
        self.cancel.store(false, Ordering::Relaxed);
        let r = self.run(app, current, progress).await;
        self.busy.store(false, Ordering::SeqCst);
        r
    }

    async fn run(&self, app: &AppHandle, current: &str, progress: &Channel<Progress>) -> Result<(), String> {
        let rel = latest_release().await?;
        if !is_newer(&rel.tag_name, current) {
            return Err(tr!("Уже установлена последняя версия", "You already have the latest version"));
        }
        let method = method();
        let Some(asset) = asset_for(method, &rel.assets) else {
            return Err(tr!("Для этой установки обновление ставится вручную", "This installation has to be updated by hand"));
        };
        let Some(digest) = asset.digest.as_deref() else {
            return Err(tr!("У файла обновления нет контрольной суммы, скачайте его вручную", "The update file has no checksum, download it by hand"));
        };

        let file = download_path(method, &asset.name)?;
        if let Err(e) = self.download(asset, digest, &file, progress).await {
            let _ = std::fs::remove_file(&file);
            return Err(e);
        }
        let _ = progress.send(Progress::Install);
        apply(app, method, &file).await
    }

    async fn download(&self, asset: &GhAsset, digest: &str, file: &Path, progress: &Channel<Progress>) -> Result<(), String> {
        let mut res = client()?
            .get(&asset.browser_download_url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| tr!("Не удалось скачать обновление: {e}", "Couldn't download the update: {e}"))?;
        let write_err = |e: std::io::Error| tr!("Не удалось сохранить {}: {e}", "Couldn't save {}: {e}", file.display());
        let mut out = tokio::fs::File::create(file).await.map_err(write_err)?;
        let mut hash = Sha256::new();
        let (mut received, total) = (0u64, asset.size);
        let mut last = Instant::now();
        let _ = progress.send(Progress::Download { received, total });
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err("CANCELLED".into());
            }
            let chunk = tokio::time::timeout(Duration::from_secs(60), res.chunk())
                .await
                .map_err(|_| tr!("Загрузка обновления зависла", "The update download stalled"))?
                .map_err(|e| tr!("Не удалось скачать обновление: {e}", "Couldn't download the update: {e}"))?;
            let Some(chunk) = chunk else { break };
            hash.update(&chunk);
            out.write_all(&chunk).await.map_err(write_err)?;
            received += chunk.len() as u64;
            if last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                let _ = progress.send(Progress::Download { received, total });
            }
        }
        out.flush().await.map_err(write_err)?;
        drop(out);
        let _ = progress.send(Progress::Download { received, total });
        if received != total || !digest_matches(digest, &hash.finalize()) {
            return Err(tr!("Файл обновления повреждён (контрольная сумма не совпала)", "The update file is corrupted (checksum mismatch)"));
        }
        Ok(())
    }
}

fn download_path(method: Method, name: &str) -> Result<PathBuf, String> {
    if method == Method::Appimage {
        // Next to the AppImage, so the final rename stays on one file system.
        let target = PathBuf::from(std::env::var_os("APPIMAGE").unwrap_or_default());
        let dir = target.parent().ok_or_else(|| tr!("Не найден файл AppImage", "AppImage file not found"))?;
        return Ok(dir.join(format!(".{name}.part")));
    }
    let dir = std::env::temp_dir().join("termdock-update");
    std::fs::create_dir_all(&dir).map_err(|e| tr!("Не удалось создать {}: {e}", "Couldn't create {}: {e}", dir.display()))?;
    Ok(dir.join(name))
}

fn detached(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
}

fn spawn_err(e: std::io::Error) -> String {
    tr!("Не удалось запустить установку: {e}", "Couldn't start the installer: {e}")
}

/// Installs the downloaded file and restarts the app.
async fn apply(app: &AppHandle, method: Method, file: &Path) -> Result<(), String> {
    match method {
        #[cfg(windows)]
        Method::Nsis => {
            // /P: passive (progress only), /UPDATE: keep shortcuts and settings, /R: start the app after.
            detached(std::process::Command::new(file).args(["/P", "/UPDATE", "/R"])).spawn().map_err(spawn_err)?;
        }
        #[cfg(windows)]
        Method::Msi => {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let exe = current_exe().ok_or_else(|| spawn_err(std::io::ErrorKind::NotFound.into()))?;
            // msiexec can't restart the app; cmd waits for it, then starts the new version.
            detached(&mut std::process::Command::new("cmd"))
                .raw_arg(format!("/C start \"\" /wait msiexec /i \"{}\" /passive & start \"\" \"{}\"", file.display(), exe.display()))
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(spawn_err)?;
        }
        #[cfg(unix)]
        Method::Appimage => {
            use std::os::unix::fs::PermissionsExt;
            let target = PathBuf::from(std::env::var_os("APPIMAGE").unwrap_or_default());
            let fail = |e: std::io::Error| tr!("Не удалось заменить {}: {e}", "Couldn't replace {}: {e}", target.display());
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).map_err(fail)?;
            std::fs::rename(file, &target).map_err(fail)?;
            detached(&mut std::process::Command::new(&target)).spawn().map_err(spawn_err)?;
        }
        #[cfg(unix)]
        Method::Deb | Method::Rpm | Method::Pacman => {
            let path = file.to_string_lossy().into_owned();
            let has = |c: &str| std::process::Command::new("sh").args(["-c", &format!("command -v {c}")]).output().is_ok_and(|o| o.status.success());
            let args: Vec<&str> = match method {
                Method::Deb => vec!["apt-get", "install", "-y", &path],
                Method::Pacman => vec!["pacman", "-U", "--noconfirm", &path],
                _ if has("dnf") => vec!["dnf", "install", "-y", &path],
                _ if has("zypper") => vec!["zypper", "--non-interactive", "install", "--allow-unsigned-rpm", &path],
                _ => vec!["rpm", "-U", &path],
            };
            if !has("pkexec") {
                return Err(tr!(
                    "Нет pkexec, чтобы запросить пароль администратора. Установите пакет вручную: {path}",
                    "pkexec isn't available to ask for the admin password. Install the package by hand: {path}"
                ));
            }
            let out = tokio::process::Command::new("pkexec").args(&args).stdin(std::process::Stdio::null()).output().await.map_err(spawn_err)?;
            match out.status.code() {
                Some(0) => {}
                // The password dialog was dismissed or authorization refused.
                Some(126) | Some(127) => return Err("CANCELLED".into()),
                _ => {
                    let err = String::from_utf8_lossy(&out.stderr);
                    let tail: Vec<&str> = err.lines().rev().filter(|l| !l.trim().is_empty()).take(3).collect();
                    let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
                    return Err(tr!("Не удалось установить пакет: {tail}", "Couldn't install the package: {tail}"));
                }
            }
            let _ = std::fs::remove_file(file);
            let exe = current_exe().ok_or_else(|| spawn_err(std::io::ErrorKind::NotFound.into()))?;
            detached(&mut std::process::Command::new(exe)).spawn().map_err(spawn_err)?;
        }
        _ => return Err(tr!("Для этой установки обновление ставится вручную", "This installation has to be updated by hand")),
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GhAsset {
        GhAsset { name: name.into(), size: 1, browser_download_url: String::new(), digest: None }
    }

    #[test]
    fn versions() {
        assert!(is_newer("v1.4.0", "1.3.1"));
        assert!(is_newer("v1.10.0", "1.9.9"));
        assert!(is_newer("2", "1.99.99"));
        assert!(!is_newer("v1.3.1", "1.3.1"));
        assert!(!is_newer("v1.3.0", "1.3.1"));
        assert!(!is_newer("v1.3.1-beta", "1.3.1"));
        assert!(!is_newer("garbage", "1.3.1"));
    }

    #[test]
    fn picks_asset_by_method() {
        let assets: Vec<GhAsset> = [
            "TermDock_1.4.0_x64-setup.exe",
            "TermDock_1.4.0_x64_en-US.msi",
            "TermDock_1.4.0_amd64.deb",
            "TermDock-1.4.0-1.x86_64.rpm",
            "TermDock_1.4.0_amd64.AppImage",
            "termdock-1.4.0-1-x86_64.pkg.tar.zst",
        ]
        .into_iter()
        .map(asset)
        .collect();
        let name = |m| asset_for(m, &assets).map(|a| a.name.as_str());
        assert_eq!(name(Method::Nsis), Some("TermDock_1.4.0_x64-setup.exe"));
        assert_eq!(name(Method::Msi), Some("TermDock_1.4.0_x64_en-US.msi"));
        assert_eq!(name(Method::Deb), Some("TermDock_1.4.0_amd64.deb"));
        assert_eq!(name(Method::Rpm), Some("TermDock-1.4.0-1.x86_64.rpm"));
        assert_eq!(name(Method::Appimage), Some("TermDock_1.4.0_amd64.AppImage"));
        assert_eq!(name(Method::Pacman), Some("termdock-1.4.0-1-x86_64.pkg.tar.zst"));
        assert_eq!(name(Method::Manual), None);
    }

    #[test]
    fn digest() {
        let h = Sha256::digest(b"hello");
        assert!(digest_matches("sha256:2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824", &h));
        assert!(!digest_matches("sha256:00", &h));
        assert!(!digest_matches("md5:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", &h));
    }

    /// Network: downloads a real release asset and checks its digest. `cargo test -- --ignored updater`
    #[tokio::test]
    #[ignore]
    async fn downloads_and_verifies_latest_release() {
        let rel = latest_release().await.unwrap();
        let a = asset_for(Method::Deb, &rel.assets).unwrap().clone();
        let file = std::env::temp_dir().join(format!("td-update-test-{}", std::process::id()));
        let ch = Channel::new(|_| Ok(()));
        let u = Updater::default();
        u.download(&a, a.digest.as_deref().unwrap(), &file, &ch).await.unwrap();
        let bad = GhAsset { digest: Some(format!("sha256:{}", "0".repeat(64))), ..a.clone() };
        assert!(u.download(&bad, bad.digest.as_deref().unwrap(), &file, &ch).await.is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn parses_github_release() {
        let json = r#"{"tag_name":"v1.4.0","html_url":"https://github.com/x/y/releases/tag/v1.4.0","body":"notes",
            "published_at":"2026-11-11T00:00:00Z","assets":[{"name":"TermDock_1.4.0_amd64.deb","size":10,
            "browser_download_url":"https://example/d.deb","digest":"sha256:ab"}]}"#;
        let rel: GhRelease = serde_json::from_str(json).unwrap();
        let i = info(&rel, "1.3.1");
        assert!(i.available);
        assert_eq!(i.latest, "1.4.0");
        assert_eq!(i.notes, "notes");
        // Tests run as a debug build: always the manual method.
        assert_eq!(i.method, Method::Manual);
        assert_eq!(rel.assets[0].digest.as_deref(), Some("sha256:ab"));
    }
}
