// Background code: opens the Claude chats instead of the shell on connect and handles the commands.
// tmux.js is loaded before this file ("main": ["tmux.js", "main.js"]).
const t = termdock.i18n.t;
const tm = window.claudeTmux;

// paneId → serverId of panes we started with the tmux command; a second pane to the same server
// stays a plain shell instead of mirroring the same tmux session.
const started = new Map();

const settings = async () => ({
  command: (await termdock.storage.get("command")) || "claude",
  noAuto: (await termdock.storage.get("noAuto")) || [],
});

// The server menu shows a check mark: on by default, off for the servers in noAuto.
const markedOff = new Set();
async function showAutoState() {
  const { noAuto } = await settings();
  await termdock.commands.setState("auto", { checked: true });
  for (const serverId of new Set([...noAuto, ...markedOff])) {
    const off = noAuto.includes(serverId);
    await termdock.commands.setState("auto", { checked: !off }, { serverId });
    if (off) markedOff.add(serverId);
    else markedOff.delete(serverId);
  }
}
termdock.ready.then(showAutoState);

// Before the session opens: attach to the chats instead of starting a plain shell. No typing into
// the terminal, so nothing races the welcome text or the server's connect script.
termdock.sessions.onBeforeShell(async (s) => {
  const { noAuto } = await settings();
  if (noAuto.includes(s.serverId)) return null;
  const live = await termdock.sessions.list();
  const other = [...started].find(([paneId, server]) => server === s.serverId && paneId !== s.paneId && live.some((x) => x.paneId === paneId && x.status === "connected"));
  if (other) return null;
  started.set(s.paneId, s.serverId);
  return tm.SHELL_COMMAND;
});

termdock.on("session.closed", ({ paneId }) => started.delete(paneId));

async function paneSession(paneId) {
  if (!paneId) throw new Error(t({ ru: "Сначала откройте сессию с сервером.", en: "Open a server session first." }));
  const s = (await termdock.sessions.list()).find((x) => x.paneId === paneId);
  if (!s || s.status !== "connected") throw new Error(t({ ru: "Сессия не подключена.", en: "The session is not connected." }));
  return s;
}

// Shows the chats in this pane: types `tmux attach` unless a client is already attached here.
async function attachHere(s) {
  const { attached } = await tm.list(s.paneId);
  if (attached && started.has(s.paneId)) return;
  await termdock.terminal.send(s.paneId, tm.ATTACH);
  started.set(s.paneId, s.serverId);
}

// Tell the panels to reload their chat list.
const changed = () => termdock.post({ type: "changed" });

// Open the chats in this pane (optionally switching to a window), starting the first chat if there are none.
termdock.commands.register("open", async (ctx) => {
  const s = await paneSession(ctx.paneId);
  const { tmux, chats } = await tm.list(s.paneId);
  if (!tmux) throw new Error(t({ ru: "На сервере не установлен tmux.", en: "tmux is not installed on the server." }));
  if (!chats.length) await tm.create(s.paneId, { name: "claude", dir: "~", command: (await settings()).command });
  if (ctx.windowId) await tm.select(s.paneId, ctx.windowId);
  await attachHere(s);
  changed();
});

termdock.commands.register("new", async (ctx) => {
  const s = await paneSession(ctx.paneId);
  const dirKey = "dir:" + s.serverId;
  const dir = await termdock.ui.prompt(t({ ru: "Новый чат Claude", en: "New Claude chat" }), t({ ru: "Папка проекта на сервере", en: "Project folder on the server" }), (await termdock.storage.get(dirKey)) || "~");
  if (dir === null) return;
  const clean = tm.required(dir, t({ ru: "Папка", en: "Folder" }));
  const base = clean.replace(/\/+$/, "").split("/").pop();
  await tm.create(s.paneId, { name: !base || base === "~" ? "claude" : base, dir: clean, command: (await settings()).command });
  await termdock.storage.set(dirKey, clean);
  // The new window becomes current in the tmux session; show it here.
  await attachHere(s);
  changed();
});

termdock.commands.register("panel", (ctx) => termdock.ui.openPanel("chats", ctx.paneId || undefined));

termdock.commands.register("auto", async (ctx) => {
  const serverId = ctx.serverId || (await paneSession(ctx.paneId)).serverId;
  const { noAuto } = await settings();
  const off = !noAuto.includes(serverId);
  await termdock.storage.set("noAuto", off ? [...noAuto, serverId] : noAuto.filter((x) => x !== serverId));
  await showAutoState();
  changed();
});

// The panel changed a setting (it writes storage itself).
termdock.on("storage.changed", ({ key }) => {
  if (key === "noAuto") showAutoState();
});
