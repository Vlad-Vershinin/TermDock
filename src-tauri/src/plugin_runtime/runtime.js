// TermDock plugin runtime: defines `window.termdock` inside a plugin's sandboxed frame.
// It only talks to the app through postMessage; the app checks the plugin's permissions.
// Protocol (all messages carry td: 1):
//   frame → app: hello | call {id, method, params} | commandResult {id, result | error} | hookResult {id, result | error}
//   app → frame: init {data} | result {id, result | error} | event {name, data} | command {id, command, context}
//                | hook {id, name, data} (the app waits briefly for the answer)
(() => {
  "use strict";
  if (window.termdock) return;
  const app = window.parent;
  const post = (msg) => app.postMessage(Object.assign({ td: 1 }, msg), "*");

  let seq = 0;
  const pending = new Map();
  const commands = new Map();
  const listeners = new Map();
  const hooks = new Map();
  const info = { plugin: null, language: "en", permissions: [], context: {} };
  let markReady;
  const ready = new Promise((r) => (markReady = r));
  let outputSubscribed = false;

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      post({ kind: "call", id, method, params: params === undefined ? null : params });
    });

  const emit = (name, data) => {
    for (const fn of listeners.get(name) || []) {
      try {
        fn(data);
      } catch (e) {
        console.error(`[termdock] "${name}" listener failed`, e);
      }
    }
  };

  const errorText = (e) => (e && e.message) || String(e);

  window.addEventListener("message", async (e) => {
    if (e.source !== app) return;
    const m = e.data;
    if (!m || m.td !== 1) return;
    if (m.kind === "result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error != null) p.reject(new Error(m.error));
      else p.resolve(m.result);
    } else if (m.kind === "init") {
      Object.assign(info, m.data);
      markReady();
    } else if (m.kind === "event") {
      if (m.name === "language") info.language = m.data;
      if (m.name === "context") info.context = m.data;
      emit(m.name, m.data);
    } else if (m.kind === "hook") {
      const fn = hooks.get(m.name);
      try {
        const result = fn ? await fn(m.data) : null;
        post({ kind: "hookResult", id: m.id, result: result === undefined ? null : result });
      } catch (err) {
        post({ kind: "hookResult", id: m.id, error: errorText(err) });
      }
    } else if (m.kind === "command") {
      const fn = commands.get(m.command);
      try {
        if (!fn) throw new Error(`Command "${m.command}" is not registered`);
        const result = await fn(m.context || {});
        post({ kind: "commandResult", id: m.id, result: result === undefined ? null : result });
      } catch (err) {
        post({ kind: "commandResult", id: m.id, error: errorText(err) });
      }
    }
  });

  const text = (v) => {
    if (v == null || typeof v === "string") return v == null ? "" : v;
    return v[info.language] || v.en || v.ru || Object.values(v)[0] || "";
  };

  const termdock = {
    /** Resolves once the app has sent the plugin's info (the calls below may be made earlier). */
    ready,
    get plugin() {
      return info.plugin;
    },
    get language() {
      return info.language;
    },
    get permissions() {
      return info.permissions.slice();
    },
    /** Where a panel is shown: `{ paneId }` for session panels, `{}` otherwise. */
    get context() {
      return info.context;
    },
    /** Subscribes to an event; returns a function that unsubscribes. */
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      if (name === "terminal.output" && !outputSubscribed) {
        outputSubscribed = true;
        call("terminal.subscribe").catch((e) => console.error("[termdock] terminal.output:", errorText(e)));
      }
      return () => listeners.get(name).delete(fn);
    },
    commands: {
      /** Handles a command declared in plugin.json (`contributes.commands`). */
      register(id, fn) {
        commands.set(id, fn);
        return () => commands.delete(id);
      },
      /** Runs one of this plugin's commands (from any of its frames), as if the user picked it. */
      execute: (id, context) => call("commands.execute", { id, context: context || {} }),
      /** Changes how a command shows in menus and the palette; `options.serverId` = for one server only. */
      setState: (id, state, options) => call("commands.setState", { id, state, serverId: options && options.serverId }),
    },
    /** Sends data to this plugin's other frames (background code, panels): their "message" event. */
    post: (data) => call("frames.post", { data: data === undefined ? null : data }),
    ui: {
      toast: (message, kind) => call("ui.toast", { message: String(message), kind: kind || "info" }),
      confirm: (title, message) => call("ui.confirm", { title, message }),
      prompt: (title, label, value) => call("ui.prompt", { title, label, value }),
      /** Opens a panel declared in plugin.json; `paneId` picks the session for session panels. */
      openPanel: (panel, paneId) => call("ui.openPanel", { panel, paneId }),
      /** Closes this panel (a dialog or sidebar panel). */
      closePanel: () => call("ui.closePanel"),
      /** A system notification when TermDock is in the background, a toast otherwise. */
      notify: (title, body) => call("ui.notify", { title: String(title), body: body == null ? null : String(body) }),
    },
    sessions: {
      list: () => call("sessions.list"),
      active: () => call("sessions.active"),
      /** Opens a session to a saved server (new tab, or `split` next to a pane); resolves with its paneId. */
      open: (serverId, options) => {
        const o = options || {};
        return call("sessions.open", { serverId, command: o.command, split: o.split, nearPaneId: o.nearPaneId });
      },
      /**
       * Before each session (and reconnect) opens: return a command to run instead of the login
       * shell (a string or { command }), or nothing for the usual shell. Answer within 2 s.
       * Background frame only; needs sessions.shell.
       */
      onBeforeShell(fn) {
        hooks.set("session.beforeShell", async (target) => {
          const r = await fn(target);
          if (typeof r === "string") return { command: r };
          return r && typeof r.command === "string" ? { command: r.command } : null;
        });
        return () => hooks.delete("session.beforeShell");
      },
    },
    terminal: {
      /** Types text into a session's shell ("\r" = Enter). */
      send: (paneId, data) => call("terminal.send", { paneId, data: String(data) }),
    },
    server: {
      /** Runs a command on the server in the background (not in the terminal). */
      exec: (paneId, command, options) => {
        const o = options || {};
        return call("server.exec", { paneId, command, timeout: o.timeout, stdin: o.stdin == null ? null : String(o.stdin) });
      },
    },
    files: {
      home: (paneId) => call("files.home", { paneId }),
      list: (paneId, path) => call("files.list", { paneId, path }),
      readText: (paneId, path) => call("files.readText", { paneId, path }),
      writeText: (paneId, path, content) => call("files.writeText", { paneId, path, content: String(content) }),
    },
    servers: {
      list: () => call("servers.list"),
    },
    storage: {
      get: (key) => call("storage.get", { key }),
      set: (key, value) => call("storage.set", { key, value: value === undefined ? null : value }),
      delete: (key) => call("storage.delete", { key }),
      all: () => call("storage.all"),
    },
    clipboard: {
      writeText: (value) => call("clipboard.writeText", { text: String(value) }),
    },
    openUrl: (url) => call("openUrl", { url: String(url) }),
    i18n: {
      /** Picks the UI language from `{ ru: "…", en: "…" }` (a plain string is returned as is). */
      t: text,
    },
  };

  window.termdock = Object.freeze(termdock);
  post({ kind: "hello" });
})();
