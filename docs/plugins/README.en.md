# TermDock plugins

> 🇷🇺 [Русская версия](README.md)

A plugin adds its own commands, panels and automation to TermDock. It is a plain folder with HTML/JavaScript: no bundler and no dependencies, a text editor is enough.

What a plugin can do:

- **commands**: in the palette (`Ctrl+Shift+P`), in the tab, server, file and session menus, on a hotkey;
- **react to the terminal**: read the output, type text (e.g. answer prompts automatically);
- **work with the server**: run commands in the background (like the load widget does), read and write files over SFTP;
- **draw its own UI**: a panel on the right, a panel under the terminal, a separate window;
- **keep its own data**: settings, history, anything JSON.

Plugins run in an isolated sandbox: they can't see passwords, keys or files on your computer, and can't go online. Anything that touches servers needs a **permission** the user confirms when installing.

**Contents**

- [Quick start](#quick-start)
- [How a plugin works](#how-a-plugin-works)
- [plugin.json](#pluginjson)
- [API: the termdock object](#api-the-termdock-object)
- [Permissions](#permissions)
- [Security and limits](#security-and-limits)
- [Debugging](#debugging)
- [Sharing a plugin](#sharing-a-plugin)
- [Examples](#examples)

---

## Quick start

1. Create a folder `my-plugin` with two files.

   `plugin.json`:

   ```json
   {
     "id": "my-plugin",
     "name": { "ru": "Мой плагин", "en": "My plugin" },
     "version": "1.0.0",
     "apiVersion": 1,
     "main": "main.js",
     "contributes": {
       "commands": [{ "id": "hello", "title": { "ru": "Поздороваться", "en": "Say hello" } }],
       "menus": { "session": [{ "command": "hello" }] },
       "keybindings": [{ "command": "hello", "key": "Ctrl+Alt+H" }]
     }
   }
   ```

   `main.js`:

   ```js
   termdock.commands.register("hello", async (ctx) => {
     const session = (await termdock.sessions.list()).find((s) => s.paneId === ctx.paneId);
     termdock.ui.toast(`Hello, ${session ? session.serverName : "world"}!`);
   });
   ```

2. In TermDock: the puzzle button in the title bar → **“Manage plugins…”** → **“Install from folder…”** → pick `my-plugin`.
3. Press `Ctrl+Alt+H`, or open the palette with `Ctrl+Shift+P` and find “Say hello”.

**A faster dev loop.** Installing copies the folder. To have your edits picked up, keep the plugin right in the plugins folder: “Manage plugins” → **“Plugins folder”** opens it (`~/.config/dev.termdock.app/plugins/` on Linux, `%APPDATA%\dev.termdock.app\plugins\` on Windows). Put your folder there, enable the plugin with its checkbox, and press **“Reload”** after changes.

---

## How a plugin works

```
my-plugin/
  plugin.json      id, name, permissions, commands, panels
  main.js          background code: runs while the plugin is enabled
  panel.html       (optional) panel pages
  panel.js
  icon.svg, …      any other plugin files
```

- **Background code** (`main` in plugin.json) is loaded into a hidden frame when TermDock starts. Register commands and subscribe to events here.
- **Panels** are plain HTML pages. TermDock adds the `termdock` object and its theme (dark colours, fonts, button and input styles) to each, so a page looks native right away. Add your own styles on top; the theme's CSS variables: `--bg`, `--bg-1`, `--text`, `--muted`, `--accent`, `--line`, `--ok`, `--warn`, `--err`, `--mono`. Buttons have `primary` and `danger` classes.
- The background code and each panel are **separate pages** with no shared variables. They talk through [storage](#plugin-data-storage): when one page changes the data, the others get a `storage.changed` event.
- Load scripts and styles **from the plugin's files** (`<script src="panel.js">`); inline `<script>…</script>` works too. Nothing can be loaded from the internet: put dependencies into the plugin folder.
- All `termdock.*` calls except `on`, `commands.register` and `i18n.t` are **asynchronous** and return a `Promise`. When an action fails (no permission, the session is closed), the promise rejects with a readable error.

---

## plugin.json

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique id: 2–64 characters `a-z`, `0-9`, `-`, `_`, `.`. Becomes the folder name once installed. |
| `name` | yes | Name. A string or `{ "ru": "…", "en": "…" }`. |
| `version` | yes | Plugin version, e.g. `"1.2.0"`. |
| `apiVersion` | yes | TermDock API version. Currently `1`. TermDock refuses plugins that need a newer one. |
| `main` | no | Background code file, `main.js` by default. |
| `description` | no | Description (string or `{ ru, en }`), shown in the plugin list and when installing. |
| `author`, `homepage` | no | Author and a link. |
| `permissions` | no | [Permissions](#permissions). Without any, a plugin can only show commands, panels and notifications. |
| `contributes` | no | What the plugin adds to the UI (below). |

Every UI text (`name`, `description`, `title`) can be a string or an object with translations: `{ "ru": "Обновить", "en": "Refresh" }`. TermDock shows the current language.

### contributes.commands

```json
"commands": [
  { "id": "deploy", "title": { "ru": "Задеплоить", "en": "Deploy" } }
]
```

The command shows up in the palette (`Ctrl+Shift+P`). The background code registers its handler: `termdock.commands.register("deploy", fn)`.

### contributes.menus

```json
"menus": {
  "tab":     [{ "command": "deploy" }],
  "session": [{ "command": "deploy" }],
  "server":  [{ "command": "ping" }],
  "file":    [{ "command": "checksum", "side": "remote" }]
}
```

| Menu | Where | What the command gets (`ctx`) |
|---|---|---|
| `tab` | right-click a tab | `paneId` (the tab's focused pane), `paneIds` (all panes) |
| `session` | the “Plugins” button in the bar above the terminal | `paneId` |
| `server` | right-click a server in the list | `serverId` |
| `file` | right-click a file | `paneId`, `side` (`"local"` / `"remote"`), `paths`, `dir` |
| palette and hotkeys | — | `paneId` of the focused session (or `null`) |

File menu items can have `"side": "local"` or `"remote"` to show up only for files on the computer or on the server.

### contributes.keybindings

```json
"keybindings": [{ "command": "deploy", "key": "Ctrl+Alt+D" }]
```

A modifier (`Ctrl`, `Alt`) or an `F1`–`F12` key is required: plain keys belong to the terminal. On macOS `Ctrl` also matches `Cmd`. TermDock's own shortcuts take precedence.

### contributes.panels

```json
"panels": [
  { "id": "rules", "title": "Rules", "location": "sidebar", "entry": "rules.html" },
  { "id": "info",  "title": "Server", "location": "session", "entry": "info.html" },
  { "id": "about", "title": "About", "location": "dialog", "entry": "about.html", "width": 420, "height": 260 }
]
```

| `location` | Shown | Opened by |
|---|---|---|
| `sidebar` | on the right, like the Scripts panel | the puzzle button in the title bar, `termdock.ui.openPanel(id)` |
| `session` | under a session's terminal, in place of the files | the “Plugins” button in the session bar, `termdock.ui.openPanel(id, paneId)` |
| `dialog` | a window over the app (`width`, `height` in pixels) | the puzzle button, `termdock.ui.openPanel(id)` |

A session panel knows its session: `termdock.context.paneId`.

---

## API: the termdock object

`termdock` exists in the background code and in every panel. Types for editor hints: [termdock.d.ts](termdock.d.ts).

### Basics

| | |
|---|---|
| `termdock.ready` | Promise: TermDock has sent the plugin's info. Before it, `plugin`, `language` and `context` are not filled in yet (calls can be made). |
| `termdock.plugin` | `{ id, name, version }` |
| `termdock.language` | UI language: `"ru"` or `"en"` |
| `termdock.permissions` | Granted permissions (the user may have unchecked some) |
| `termdock.context` | `{ paneId }` for a session panel, `{}` otherwise |
| `termdock.i18n.t(text)` | Picks a translation: `t({ ru: "Да", en: "Yes" })` |

### Events: termdock.on(event, listener)

Returns a function that unsubscribes.

| Event | Data | When |
|---|---|---|
| `terminal.output` | `{ paneId, text }` | Terminal output (text with colour escape sequences), in batches every ~50 ms. **Needs `terminal.read`.** |
| `session.connected` | `Session` | A session connected |
| `session.closed` | `{ paneId }` | A session disconnected or was closed |
| `session.focus` | `Session` or `null` | The user switched to another session (or to the home screen) |
| `storage.changed` | `{ key }` | Another page of this plugin changed its data |
| `language` | `"ru"` / `"en"` | The UI language changed |
| `context` | object | The panel's context changed |

`Session` is `{ paneId, serverId, serverName, host, port, username, status, focused }`. `paneId` is the stable id of a terminal pane: pass it to every session function.

### Commands

```js
termdock.commands.register("deploy", async (ctx) => {
  // ctx depends on where the command was run from (see contributes.menus)
});
```

If the handler throws or returns a rejected promise, TermDock shows the error to the user.

### UI: termdock.ui

| Function | Result |
|---|---|
| `toast(text, kind?)` | Notification; `kind`: `"info"`, `"success"`, `"error"` |
| `confirm(title, message?)` | `true` / `false` |
| `prompt(title, label?, value?)` | A string, or `null` when cancelled |
| `openPanel(panelId, paneId?)` | Opens a panel from plugin.json |
| `closePanel()` | Closes the panel the code runs in |

TermDock prefixes notifications and dialog titles with the plugin's name, so the user always sees who is asking.

### Sessions and the terminal

| Function | Permission | |
|---|---|---|
| `sessions.list()` | — | All open sessions (`Session[]`) |
| `sessions.active()` | — | The focused session or `null` |
| `terminal.send(paneId, text)` | `terminal.write` | Types into the terminal, `"\r"` is Enter |

```js
// Restart nginx in the focused session
const s = await termdock.sessions.active();
if (s) await termdock.terminal.send(s.paneId, "sudo systemctl restart nginx\r");
```

### Commands on the server: termdock.server.exec

```js
const r = await termdock.server.exec(paneId, "df -h /", { timeout: 15000 });
// r = { code: 0, stdout: "…", stderr: "" }
```

Needs **`server.exec`**. The command runs on a separate SSH channel: it doesn't show up in the terminal and doesn't interfere with the user's typing. The timeout is 30 seconds by default (1 second to 10 minutes), output up to 10 MB. The session must be connected.

The server runs the command through the user's login shell. If that may be `fish` or `csh`, wrap complex commands in `sh -c '…'`.

### Files on the server: termdock.files

| Function | Permission | |
|---|---|---|
| `files.home(paneId)` | `files.read` | Home folder |
| `files.list(paneId, path)` | `files.read` | Folder contents: `{ name, path, isDir, isLink, size, modified, mode }[]` |
| `files.readText(paneId, path)` | `files.read` | File text (encoding detected), up to 5 MB |
| `files.writeText(paneId, path, text)` | `files.write` | Writes the file as UTF-8 (creates or replaces it) |

Server paths are always POSIX (`/etc/nginx/nginx.conf`).

### Server list: termdock.servers.list()

Needs **`servers.read`**. Returns the saved servers: `{ id, name, host, port, username, group, color }[]`. Passwords, keys and key paths are never included.

### Plugin data: termdock.storage

The plugin's own storage: any JSON values, up to 5 MB in total. Kept across restarts, deleted with the plugin.

```js
await termdock.storage.set("rules", [{ when: "[Y/n]", reply: "y" }]);
const rules = (await termdock.storage.get("rules")) || [];
await termdock.storage.delete("rules");
const everything = await termdock.storage.all();
```

When one page of the plugin changes the data, the others get `storage.changed`: that is how a settings panel tells the background code to re-read the rules.

### Other

| Function | Permission | |
|---|---|---|
| `clipboard.writeText(text)` | `clipboard.write` | Copies to the clipboard |
| `openUrl(url)` | `openUrl` | Opens an `http(s)` link in the browser |

---

## Permissions

A plugin lists the permissions it needs in `permissions`. When installing, TermDock shows them and the user may uncheck any. Dangerous ones are marked with ⚠. A call without the granted permission is rejected with an error: check `termdock.permissions` and tell the user what is missing.

| Permission | Allows |
|---|---|
| `terminal.read` | The `terminal.output` event: seeing everything printed in terminals |
| `terminal.write` ⚠ | `terminal.send`: typing text and commands |
| `server.exec` ⚠ | `server.exec`: running commands on servers in the background |
| `files.read` | Reading files and folders on servers |
| `files.write` ⚠ | Writing files on servers |
| `servers.read` | Seeing the list of saved servers (no passwords) |
| `clipboard.write` | Copying to the clipboard |
| `openUrl` | Opening links in the browser |

Without any permission a plugin can still add commands, menus, hotkeys and panels, show notifications and dialogs, see the list of open sessions and keep its own data.

Ask only for what you really need: a short permission list is the main reason a user decides to install a plugin.

---

## Security and limits

Each plugin page runs in an **isolated frame** (`sandbox` without `allow-same-origin`) with its own security policy:

- **no access to TermDock**: not its window, storage or internal Tauri commands; everything goes through `termdock`, and TermDock checks each action against the granted permissions;
- **no network**: `fetch`, `XMLHttpRequest`, WebSocket and loading scripts or images from the internet are blocked;
- **no** `localStorage`, cookies, `alert` / `confirm` / `prompt`, popups or navigation: use `termdock.storage`, `termdock.ui.*` and `termdock.openUrl`;
- the plugin **can't see** passwords, passphrases, keys or files on the user's computer.

Limits:

| | |
|---|---|
| Plugin size | up to 50 MB and 2000 files |
| Plugin data (`storage`) | up to 5 MB |
| `server.exec` | output up to 10 MB, timeout 1 s to 10 min |
| `files.readText` | files up to 5 MB |
| `terminal.output` | batched every ~50 ms, at most 1 MB per session per batch |

Even isolated, a plugin with `terminal.write`, `server.exec` or `files.write` can do anything on a server that you can. Install plugins only from sources you trust.

---

## Debugging

- **Errors in commands** are shown as notifications with the plugin's name.
- **Console.** Run TermDock from source in dev mode (`npx tauri dev`) and open the developer tools (usually `Ctrl+Shift+I`, also `F12` on Windows). Plugin frames are in the console's context list (`tdplugin://localhost/<id>/…`, on Windows `http://tdplugin.localhost/<id>/…`), with their `console.log` output and errors.
- **Reload.** “Manage plugins” → **“Reload”** reloads the code of all plugins. Open panels reload too.
- **Not loading?** An error in plugin.json is shown right away when installing. A plugin placed directly in the plugins folder still shows up in the list, with the problem in red.

---

## Sharing a plugin

Zip the plugin folder (plugin.json may sit at the root of the archive or in one folder inside): it installs with **“Install from .zip…”**. For an update, bump `version`: installing over the old version replaces it, and the plugin's data (`storage`) is kept.

---

## Examples

[`examples/plugins`](../../examples/plugins) has three ready plugins. Install them, or use them as a starting point:

| Plugin | Shows |
|---|---|
| [hello-world](../../examples/plugins/hello-world) | Commands in menus, the palette and on a hotkey, command context, storage, a dialog panel |
| [auto-reply](../../examples/plugins/auto-reply) | Reading terminal output and typing replies, a sidebar settings panel, a panel and background code talking through `storage.changed` |
| [server-info](../../examples/plugins/server-info) | A panel under the terminal, `server.exec`, reading a file over SFTP |
