# AGENTS.md

Guide for AI coding agents working on **TermDock** — a desktop SSH client: server list, SSH terminals in tabs, a two-pane SFTP file manager, saved scripts, port forwarding. Tauri 2 (Rust) backend + React/TypeScript frontend. Read this first; it saves you a repo-wide search.

## Language rules

- **The UI is bilingual: Russian (default, source of truth) and English** (`language` setting, switches live). Never hardcode user-visible text:
  - Frontend: add a key to **both** `src/lib/locales/ru.ts` and `en.ts` (the `Dict` type makes a missing `en` key a build error) and use `const tr = useT()` in components, or the non-hook `t()` from `lib/i18n.ts` in callbacks/modules outside React. `{name}` params; plurals are objects keyed by `Intl.PluralRules` categories (`one`/`few`/`many`/`other`) with the count in `n`.
  - Rust: user-facing error strings go through `tr!("русский {x}", "english {x}", …)` (`i18n.rs`, a `format!` per language). Protocol codes (`NEED_SECRET`, `HOSTKEY_*`, `JUMP|…`, `CANCELLED`, `TOO_BIG|…`) stay untranslated.
  - Keep Russian consistent with the existing tone; English is concise, standard desktop-app wording. `grep -rnP '[А-Яа-яЁё]' src` should only hit `locales/ru.ts` (and `LANGUAGE_NAMES`).
- **Code, comments, identifiers, commit messages: English.** Comments are short and explain *why*.
- `README.md` (English, the GitHub landing page) and `README.ru.md` (Russian) are user-facing: written for non-technical readers, with GIFs from `docs/media/`. Keep them in sync, and use the app's real button labels from the locale files. Don't turn them into developer docs; developer notes belong here.

## Commands

```bash
npm ci                         # install JS deps (Node 20+, Rust stable needed)
npx tauri dev                  # full app with hot reload (Vite on :1420)
npm run build                  # tsc --noEmit && vite build  — the frontend check
cd src-tauri && cargo check    # backend compile check
cd src-tauri && cargo test     # unit tests (parsers, codecs, SOCKS, ssh config…)
cd src-tauri && cargo clippy --all-targets
npx tauri build --bundles deb,appimage   # Linux packages (CI builds the rest)
```

- There is **no JS test runner and no linter**; `npm run build` (type-check) is the frontend gate.
- Integration tests in `src-tauri/src/ssh_tests.rs` are `#[ignore]` and need a real sshd (`TD_SSH_PORT`, `TD_SSH_PORT2`, `TD_SSH_USER`, `SSH_AUTH_SOCK`, …; see the file header). Run with `cargo test -- --ignored --test-threads=1`.
- Windows can't be built locally from Linux (`aws-lc-sys` doesn't cross-compile). Windows-only code (`#[cfg(windows)]`) is verified by CI on tag pushes — be extra careful with it.
- The frontend only works inside Tauri (`invoke`, `Channel`, events). In a plain browser you must mock `window.__TAURI_INTERNALS__` (`invoke`, `transformCallback`, `metadata`) and `__TAURI_EVENT_PLUGIN_INTERNALS__` to render it — that is how the README GIFs were recorded (Playwright + a fake backend). Don't commit such mocks into `src/`.

## Architecture

```
React UI (src/)  ──invoke / Channel / events──►  Rust commands (src-tauri/src/lib.rs)
                                                   ├─ ssh.rs      russh: connect, auth, host keys, shell, exec, SFTP
                                                   ├─ forward.rs  -L / -R / -D (SOCKS5) over a session
                                                   ├─ files.rs    local+SFTP listing, transfers (up / down / server→server)
                                                   ├─ store.rs    servers.json, folders.json, keychain secrets
                                                   └─ …
```

SSH is implemented in Rust with `russh`/`russh-sftp` — **no external `ssh` binary**. The terminal is xterm.js in the webview; bytes flow through a Tauri `Channel<TermEvent>`.

### Backend (`src-tauri/src/`)

| File | Responsibility |
|---|---|
| `lib.rs` | All `#[tauri::command]` fns, `resolve_hops`, app setup/state, the `invoke_handler` list |
| `ssh.rs` | `Client` handler (host-key check), `Hop` chain through jump hosts (`open_chain`), `authenticate` (password / key / agent), `SshSession` (shell write loop, lazy SFTP channel, `exec`, stats) |
| `sshconfig.rs` | `~/.ssh/config` parser (Host patterns, HostName, Port, IdentityFile, ProxyJump, Include) |
| `forward.rs` | Port forwards per session: listeners, SOCKS5, status, stop/start |
| `files.rs` | Local/remote listing, recursive transfers with progress + cancel, text file read/write |
| `i18n.rs` | UI language for backend messages (set from settings) and the `tr!(ru, en, args…)` macro |
| `textcodec.rs` | Editor encodings: detect (BOM / UTF-8 / chardetng), decode, encode back |
| `stats.rs` | Server telemetry: one script per OS flavour (Linux / macOS / FreeBSD / Windows PowerShell) + parsers |
| `store.rs` | `Server`, `Jump`, `Forward`, `AuthMethod`; JSON persistence; OS keychain via `keyring` |
| `scripts.rs` | Saved scripts (`scripts.json`) |
| `settings.rs` | Global app settings (`settings.json`, every field `#[serde(default)]`, `sanitize()` clamps), download-folder resolution, `first_run` (fresh install: the UI picks English unless the OS locale is Russian) |
| `dragout.rs` | Temp folders / helpers for dragging files out to the OS |
| `plugins.rs` | Plugins: `plugin.json` validation, install from folder / `.zip` (path, symlink, size checks), enabled state + granted permissions (`plugins.json`), per-plugin storage, the `tdplugin://` scheme (`serve`, strict CSP) |
| `updater.rs` | App updates: GitHub `releases/latest`, install method detection (NSIS / MSI / AppImage / deb / rpm / pacman / manual), download with SHA-256 check against the asset `digest`, install + restart |
| `plugin_runtime/` | `runtime.js` (`window.termdock` inside plugin frames, postMessage RPC) and `theme.css`, served at `tdplugin://…/__termdock/` |

### Frontend (`src/`)

| File | Responsibility |
|---|---|
| `App.tsx` | Tabs & split panes state, global shortcuts, OS file-drop routing, `Home` screen |
| `components/TitleBar.tsx` | Custom window frame (`decorations: false`): tabs, tool buttons, window controls |
| `components/TabView.tsx` / `SessionView.tsx` | Split layout; one `SessionView` = one SSH session (xterm + status bar + file panel) |
| `components/FilePanel.tsx` | Two panes (local / remote), selection, context menus, drag & drop, move/copy |
| `components/Editor.tsx` → `CodeEditor.tsx` | Lazy-loaded CodeMirror 6 editor; `lib/codemirror.ts` has languages, theme, encoding list |
| `components/Sidebar.tsx`, `ServerDialog.tsx` | Server list with folders; add/edit dialog (auth, jump host, connect script, port forwards) |
| `components/Scripts.tsx`, `Telemetry.tsx`, `Ports.tsx` | Scripts panel/dialog, CPU/RAM/disk widget, port-forward popover |
| `components/SettingsDialog.tsx` | Settings dialog (gear in the title bar, Ctrl+,): Interface / Terminal / Files; changes apply at once |
| `lib/api.ts` | **Typed wrappers for every Rust command** + shared TS types (mirror of Rust structs) |
| `lib/i18n.ts` | `useT()` / `t()` (non-hook), `setLang` (called by `SettingsProvider`, also sets `<html lang>`), plural + `{param}` formatting |
| `lib/locales/ru.ts`, `en.ts` | Flat UI string dictionaries; `ru` defines the keys, `en: Dict` must match |
| `lib/ui.tsx` | `useUi()`: `toast`, `dialog`, `confirm`, `prompt`, `menu` (context menu) |
| `lib/dnd.ts` | Custom pointer-based drag & drop (not HTML5 DnD) |
| `lib/dragout.ts` | Drag files out of the window into the OS file manager (tauri-plugin-drag) |
| `lib/settings.tsx` | `useSettings()`: `settings` + `update(patch)` (live, debounced save to `settings.json`); `DEFAULT_SETTINGS` mirrors Rust |
| `lib/transfers.tsx` | Transfer queue + `transfer-progress` event listener; Transfers panel ("Показать в папке" / "Открыть" for local files) |
| `lib/plugins/host.tsx` | `PluginsProvider` / `usePlugins()`: hidden host frames, message routing, permission checks for every call, events to plugins, commands, menus, keybindings, panel state; `PluginFrame` (the sandboxed iframe) |
| `lib/plugins/types.ts` | Manifest types, `PERMISSIONS` (mirror of Rust), `readContributions`, localized texts (`ltext`), key matching |
| `components/Plugins.tsx` | Plugin manager dialog (install with permission prompt), command palette (Ctrl+Shift+P), plugin sidebar panel |
| `lib/updates.tsx` | `UpdatesProvider` / `useUpdates()`: background check (5 s after start, then hourly, `checkUpdates` setting), title bar button, update dialog with release notes and progress, "skip this version" (`td.update.skip`) |
| `lib/termlinks.ts` | Terminal link provider (joins URLs split by soft or hard line breaks), OAuth `redirect_uri=localhost:PORT` detection for auto port-forward |
| `lib/sessions.ts` | `paneRegistry` (terminals for scripts and plugins), `paneEvents` (output / status / focus for the plugin host), `focusedPane`, `remotePaneRegistry` (SFTP panes for server→server copy) |
| `lib/scripts.ts` | `{{var:default}}` substitution, whole-vs-step run input (`commandBlock`) |
| `styles.css` | All styling; JetBrains-like dark theme via CSS variables on `:root` |

## Recipes

**Add a backend command:** write `#[tauri::command]` in `lib.rs` → add it to `tauri::generate_handler![…]` at the bottom → add a typed wrapper to `api` in `src/lib/api.ts` (names: Rust `snake_case`, args camelCase on the JS side). Custom commands need no capability entry; **plugin** commands do (`src-tauri/capabilities/default.json`).

**Add a field to `Server`:** `store.rs` (`#[serde(default)]` — old `servers.json` files must keep loading) → `Server` interface in `api.ts` → `ServerDialog.tsx`. Keep serde `camelCase`.

**Add a plugin API method:** `plugin_runtime/runtime.js` (the `termdock.*` function, a `call("x.y", params)`) → `handleCall` in `lib/plugins/host.tsx` (validate params with `str()`, check the permission via `NEEDS`) → `docs/plugins/termdock.d.ts` and both `docs/plugins/README*.md`. A new permission goes into `PERMISSIONS` in `plugins.rs` **and** `types.ts`, `DANGEROUS` if it can change a server, and `plugins.perm.*` locale keys. Keep `apiVersion` at 1 for additive changes; bump it (and `API_VERSION`) only for breaking ones. To test in a browser, serve `examples/plugins` with a small HTTP server that mimics `Plugins::serve` (runtime injection, `__host.html`, the CSP) and make the mocked `__TAURI_INTERNALS__.convertFileSrc(p, "tdplugin")` point at it; the mock must skip subframes (`window !== window.top`), or plugin frames would see a fake Tauri.

**Run something in a terminal:** go through `paneRegistry` (`send` / `runSteps`), don't reach into xterm from other components.

**Long operation with progress:** follow `files.rs` `Reporter` + `transfer-progress` events and the `Transfers` cancel flags.

## Conventions and gotchas

- **Secrets never go into JSON files.** Passwords / passphrases live in the OS keychain (service `TermDock`, keyed by server id; a custom jump host uses `<server id>#jump`; ssh-config hops use `sshconfig:<alias>`). Don't log secrets or put them in error text.
- **Error protocol as plain strings** (matched in `SessionView.tsx`): `NEED_SECRET`, `AUTH_FAILED`, `HOSTKEY_UNKNOWN|<fp>|<alg>`, `HOSTKEY_CHANGED|<fp>`, `JUMP|<hop id>|<user@host>|<auth>|<code>` (the same codes, but from a jump host), `CANCELLED`, `TOO_BIG|<bytes>`. If you add a prompt-worthy error, extend this scheme rather than inventing a new channel.
- **Hop ids** key typed secrets and accepted fingerprints sent by the UI (`secrets`, `accept`, `remember` in `ssh_connect`).
- **No `React.StrictMode`** (`main.tsx`): its double mount would open every SSH session twice.
- **Drag & drop is custom** (`dnd.ts`): drop zones are `data-dropzone` / `data-accept` elements, folder rows carry `data-dropdir`. Tauri's native file-drop is enabled for OS → app; HTML5 DnD is unreliable alongside it.
- **Terminal panes stay mounted** when their tab is hidden (`visible` prop); don't unmount `SessionView` to hide it.
- **`SessionView`s are portaled, not rendered by `TabView`.** `App.tsx` renders every pane through `createPortal` into a persistent container (`paneHost(paneId)`); `TabView` only moves that container into its pane slot. This is what lets a pane move to another tab (drag a tab onto a terminal) without remounting and dropping its connection. Pane handlers resolve their tab at call time for the same reason.
- **Plugin security model — don't weaken it.** Plugin pages are `<iframe sandbox="allow-scripts allow-forms">` (never add `allow-same-origin`, `allow-popups`, `allow-top-navigation`, `allow-modals`) loaded from `tdplugin://`, whose responses carry `PLUGIN_CSP` (`connect-src 'none'`: no network). Tauri injects its IPC scripts (and the invoke key) into the main frame only, so plugin frames can't call commands; the app CSP only adds `frame-src` for the scheme. The host identifies a plugin by the message's **source frame**, never by message content, and checks `NEEDS` before acting. Plugins get `paneId`s, never backend session ids, secrets or key paths. Only enabled plugins are served.
- **`useUi()` returns a new object on every render.** Long-lived callbacks (like the plugin host's `reload`) must read it through a ref; depending on it re-ran effects on every toast/menu and remounted all plugin frames.
- **Updates depend on release file names.** `updater.rs` picks the asset by suffix (`-setup.exe`, `.msi`, `.AppImage`, `.deb`, `.rpm`, `.pkg.tar.zst`) and refuses one without GitHub's `digest`. Renaming bundles or the repo (`LATEST_URL`) breaks updates for every installed copy. Network access is backend-only (`reqwest`); the app CSP still blocks it in the webview. Debug builds always report the `manual` method, so `tauri dev` never installs over a real install.
- **Telemetry commands run on a separate exec channel**, never in the user's shell, and must not print into the terminal. Remote scripts must survive csh/fish login shells (`sh -c '…'`, no `'`/`!`/backslashes).
- **Persisted UI state** uses `localStorage` keys prefixed `td.` (`td.sidebar`, `td.split`, `td.showFiles`, …). User preferences (terminal font, downloads folder, …) belong in `settings.json` via `useSettings()` instead: add the field to `settings.rs` (default + `sanitize`), `Settings` in `api.ts`, `DEFAULT_SETTINGS` and `SettingsDialog.tsx`.
- **CSP** (`tauri.conf.json`) allows only `ipc:` connections and `'self'` assets — no network fetches, no CDN fonts/scripts from the app.
- Remote paths are always POSIX; local paths may be Windows (`lib/paths.ts`).
- Keep diffs focused: no drive-by reformatting; match the surrounding style (Rust: rustfmt-ish, 4 spaces; TS/TSX: 2 spaces, double quotes).

## Data locations (runtime)

`servers.json`, `folders.json`, `scripts.json`, `settings.json`, `plugins.json`, `known_hosts`, `plugins/<id>/`, `plugin-data/<id>.json` in the app config dir: `~/.config/dev.termdock.app/` (Linux), `%APPDATA%\dev.termdock.app\` (Windows). The app also reads (never writes) the user's `~/.ssh/known_hosts` and `~/.ssh/config`.

## Git & releases

- **Commits:** Conventional Commits, English, lowercase: `type(scope): description`, imperative, no trailing period, < 72 chars. Types: feat, fix, refactor, perf, test, docs, chore, build, ci. Scope = affected area (`frontend`, `backend`, `readme`, `terminal`, `scripts`, `release`…); tightly coupled areas joined with ` | `, e.g. `feat(backend | frontend): add …`. One logical change per commit; stage explicit paths.
- Don't commit `node_modules`, `dist`, `src-tauri/target`, `src-tauri/gen`, `release/` (all git-ignored).
- **Release** (done by tagging; CI does the rest):
  1. Bump the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `packaging/arch/PKGBUILD` (`pkgver`).
  2. Rewrite `.github/release-notes.md` for the new version (it becomes the GitHub release body; file names in its install tables include the version). It is bilingual: English first (`## What's new in X.Y.Z` … `## Install`), then `---` and the Russian text (`## Что нового в X.Y.Z` … `## Установка`) inside `<details><summary>🇷🇺 На русском</summary>`. The update dialog shows the section in the UI language (`notesSection` in `lib/updates.tsx`), so keep these headings.
  3. Commit `chore(release): bump version to X.Y.Z`, tag `vX.Y.Z`, push `main` and the tag.
  4. `.github/workflows/build.yml` builds Windows (NSIS, MSI), Linux (deb, rpm, AppImage) and Arch packages and publishes the release (~15 min).
  5. Installed copies see the release within an hour (`updater.rs`) and show its "what's new" section in the update dialog.

## Known limitations (don't "fix" by accident)

No `Match` / `ProxyCommand` in ssh config; session-only port forwards are lost on reconnect; telemetry unsupported on OpenBSD/NetBSD; the Windows agent paths (named pipe, Pageant) and native drag-out are not covered by local tests.
