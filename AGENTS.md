# AGENTS.md

Guide for AI coding agents working on **TermDock** — a desktop SSH client: server list, SSH terminals in tabs, a two-pane SFTP file manager, saved scripts, port forwarding. Tauri 2 (Rust) backend + React/TypeScript frontend. Read this first; it saves you a repo-wide search.

## Language rules

- **The UI is bilingual: Russian (default, source of truth) and English** (`language` setting, switches live). Never hardcode user-visible text:
  - Frontend: add a key to **both** `src/lib/locales/ru.ts` and `en.ts` (the `Dict` type makes a missing `en` key a build error) and use `const tr = useT()` in components, or the non-hook `t()` from `lib/i18n.ts` in callbacks/modules outside React. `{name}` params; plurals are objects keyed by `Intl.PluralRules` categories (`one`/`few`/`many`/`other`) with the count in `n`.
  - Rust: user-facing error strings go through `tr!("русский {x}", "english {x}", …)` (`i18n.rs`, a `format!` per language). Protocol codes (`NEED_SECRET`, `HOSTKEY_*`, `JUMP|…`, `CANCELLED`, `TOO_BIG|…`) stay untranslated.
  - Keep Russian consistent with the existing tone; English is concise, standard desktop-app wording. `grep -rnP '[А-Яа-яЁё]' src` should only hit `locales/ru.ts` (and `LANGUAGE_NAMES`).
- **Code, comments, identifiers, commit messages: English.** Comments are short and explain *why*.
- `README.md` is user-facing (Russian, written for non-technical readers, with GIFs from `docs/media/`). Don't turn it into developer docs; developer notes belong here.

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
| `lib/termlinks.ts` | Terminal link provider (joins URLs split by soft or hard line breaks), OAuth `redirect_uri=localhost:PORT` detection for auto port-forward |
| `lib/sessions.ts` | `paneRegistry` (terminals for scripts) and `remotePaneRegistry` (SFTP panes for server→server copy) |
| `lib/scripts.ts` | `{{var:default}}` substitution, whole-vs-step run input (`commandBlock`) |
| `styles.css` | All styling; JetBrains-like dark theme via CSS variables on `:root` |

## Recipes

**Add a backend command:** write `#[tauri::command]` in `lib.rs` → add it to `tauri::generate_handler![…]` at the bottom → add a typed wrapper to `api` in `src/lib/api.ts` (names: Rust `snake_case`, args camelCase on the JS side). Custom commands need no capability entry; **plugin** commands do (`src-tauri/capabilities/default.json`).

**Add a field to `Server`:** `store.rs` (`#[serde(default)]` — old `servers.json` files must keep loading) → `Server` interface in `api.ts` → `ServerDialog.tsx`. Keep serde `camelCase`.

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
- **Telemetry commands run on a separate exec channel**, never in the user's shell, and must not print into the terminal. Remote scripts must survive csh/fish login shells (`sh -c '…'`, no `'`/`!`/backslashes).
- **Persisted UI state** uses `localStorage` keys prefixed `td.` (`td.sidebar`, `td.split`, `td.showFiles`, …). User preferences (terminal font, downloads folder, …) belong in `settings.json` via `useSettings()` instead: add the field to `settings.rs` (default + `sanitize`), `Settings` in `api.ts`, `DEFAULT_SETTINGS` and `SettingsDialog.tsx`.
- **CSP** (`tauri.conf.json`) allows only `ipc:` connections and `'self'` assets — no network fetches, no CDN fonts/scripts from the app.
- Remote paths are always POSIX; local paths may be Windows (`lib/paths.ts`).
- Keep diffs focused: no drive-by reformatting; match the surrounding style (Rust: rustfmt-ish, 4 spaces; TS/TSX: 2 spaces, double quotes).

## Data locations (runtime)

`servers.json`, `folders.json`, `scripts.json`, `settings.json`, `known_hosts` in the app config dir: `~/.config/dev.termdock.app/` (Linux), `%APPDATA%\dev.termdock.app\` (Windows). The app also reads (never writes) the user's `~/.ssh/known_hosts` and `~/.ssh/config`.

## Git & releases

- **Commits:** Conventional Commits, English, lowercase: `type(scope): description`, imperative, no trailing period, < 72 chars. Types: feat, fix, refactor, perf, test, docs, chore, build, ci. Scope = affected area (`frontend`, `backend`, `readme`, `terminal`, `scripts`, `release`…); tightly coupled areas joined with ` | `, e.g. `feat(backend | frontend): add …`. One logical change per commit; stage explicit paths.
- Don't commit `node_modules`, `dist`, `src-tauri/target`, `src-tauri/gen`, `release/` (all git-ignored).
- **Release** (done by tagging; CI does the rest):
  1. Bump the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `packaging/arch/PKGBUILD` (`pkgver`).
  2. Rewrite `.github/release-notes.md` for the new version (it becomes the GitHub release body; file names in its install table include the version).
  3. Commit `chore(release): bump version to X.Y.Z`, tag `vX.Y.Z`, push `main` and the tag.
  4. `.github/workflows/build.yml` builds Windows (NSIS, MSI), Linux (deb, rpm, AppImage) and Arch packages and publishes the release (~15 min).

## Known limitations (don't "fix" by accident)

No `Match` / `ProxyCommand` in ssh config; session-only port forwards are lost on reconnect; telemetry unsupported on OpenBSD/NetBSD; the Windows agent paths (named pipe, Pageant) and native drag-out are not covered by local tests.
