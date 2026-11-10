// Plugin host: loads enabled plugins into sandboxed iframes (no same-origin, no IPC) and serves
// their `window.termdock` calls. A message is trusted only by its source frame: the plugin id
// comes from our registry, never from the message. Every call that touches a server, the
// terminal or the clipboard is checked against the permissions the user granted.

import { createContext, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl as openExternal } from "@tauri-apps/plugin-opener";
import { api, errorText } from "../api";
import { Lang, t } from "../i18n";
import { useSettings } from "../settings";
import { MenuItem, useUi } from "../ui";
import { focusedPane, PaneHandle, paneEvents, paneRegistry } from "../sessions";
import { Contributions, ltext, matchKey, MenuWhere, Permission, PluginInfo, PluginPanel, readContributions } from "./types";
import { IPlugin } from "../../components/Icons";

/** Base URL of the plugin scheme: "tdplugin://localhost/" (Linux, macOS) or "http://tdplugin.localhost/" (Windows). */
export const pluginBase = convertFileSrc("", "tdplugin");

const pluginUrl = (pluginId: string, file: string, version: number) => `${pluginBase}${encodeURIComponent(pluginId)}/${file.split("/").map(encodeURIComponent).join("/")}?v=${version}`;

// ---------- frames ----------

interface Frame {
  el: HTMLIFrameElement;
  pluginId: string;
  kind: "host" | "panel";
  panel?: PluginPanel;
  context: Record<string, unknown>;
  /** The runtime said hello: messages can be delivered. */
  ready: boolean;
  queue: unknown[];
  /** Receives "terminal.output" events. */
  output: boolean;
}

const frames = new Set<Frame>();

function post(f: Frame, msg: Record<string, unknown>) {
  const m = { td: 1, ...msg };
  if (!f.ready) {
    // Keep a bounded backlog until the runtime has loaded.
    if (f.queue.length < 500) f.queue.push(m);
    return;
  }
  f.el.contentWindow?.postMessage(m, "*");
}

function broadcast(name: string, data: unknown, filter: (f: Frame) => boolean = () => true) {
  for (const f of frames) if (filter(f)) post(f, { kind: "event", name, data });
}

/** What a plugin sees of a session (never secrets or the backend session id). */
export interface SessionInfo {
  paneId: string;
  serverId: string;
  serverName: string;
  host: string;
  port: number;
  username: string;
  status: string;
  focused: boolean;
}

function sessionInfo(paneId: string, h: PaneHandle): SessionInfo {
  return {
    paneId,
    serverId: h.serverId,
    serverName: h.serverName,
    host: h.host,
    port: h.port,
    username: h.username,
    status: h.status(),
    focused: focusedPane.get() === paneId,
  };
}

// ---------- context ----------

export interface CommandContext {
  /** Session the command is about (the focused one for the palette and keys). */
  paneId?: string | null;
  /** All panes of a tab (tab menu). */
  paneIds?: string[];
  serverId?: string;
  /** File menu: which pane, the selected paths and the open folder. */
  side?: "local" | "remote";
  paths?: string[];
  dir?: string | null;
}

interface PluginsCtx {
  plugins: PluginInfo[];
  /** Bumped on reload: plugin frames are remounted with fresh code. */
  version: number;
  /** Contributions of enabled plugins. */
  contributions: Contributions;
  pluginName: (id: string) => string;
  reload: () => Promise<void>;
  runCommand: (pluginId: string, command: string, context: CommandContext) => void;
  /** Plugin items for a context menu ([] when there are none). */
  menuItems: (where: MenuWhere, context: CommandContext) => MenuItem[];
  /** Runs a plugin keybinding; true when one matched. */
  handleKey: (e: KeyboardEvent) => boolean;
  openPanel: (panel: PluginPanel, paneId?: string | null) => void;
  sidebarPanel: PluginPanel | null;
  closeSidebar: () => void;
  sessionPanel: (paneId: string) => PluginPanel | null;
  setSessionPanel: (paneId: string, panel: PluginPanel | null) => void;
}

const Ctx = createContext<PluginsCtx>(null!);
export const usePlugins = () => useContext(Ctx);

const NEEDS: Record<string, Permission> = {
  "terminal.subscribe": "terminal.read",
  "terminal.send": "terminal.write",
  "server.exec": "server.exec",
  "files.home": "files.read",
  "files.list": "files.read",
  "files.readText": "files.read",
  "files.writeText": "files.write",
  "servers.list": "servers.read",
  "clipboard.writeText": "clipboard.write",
  openUrl: "openUrl",
};

const panelKey = (p: PluginPanel) => `${p.pluginId}:${p.id}`;

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

export function PluginsProvider({ children }: { children: ReactNode }) {
  const ui = useUi();
  const { settings } = useSettings();
  const language = settings.language as Lang;
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [version, setVersion] = useState(1);
  const [sidebar, setSidebar] = useState<PluginPanel | null>(null);
  const [dialog, setDialog] = useState<{ panel: PluginPanel; paneId: string | null } | null>(null);
  const [sessionPanels, setSessionPanels] = useState<Record<string, PluginPanel | null>>({});

  // The useUi() object changes on every render of its provider; everything long-lived below reads
  // it (and the rest of the state) through this ref, so that plugin frames are never remounted
  // because a toast or a menu was shown.
  const live = useRef({ plugins, enabled: [] as PluginInfo[], contributions: null as unknown as Contributions, language, ui });

  const reload = useCallback(async () => {
    try {
      setPlugins(await api.pluginList());
    } catch (e) {
      live.current.ui.toast(errorText(e), "error");
    }
    // Remount every plugin frame so new code is picked up.
    setVersion((v) => v + 1);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const enabled = useMemo(() => plugins.filter((p) => p.enabled && p.manifest), [plugins]);
  const contributions = useMemo<Contributions>(() => {
    const all: Contributions = { commands: [], menus: { tab: [], server: [], file: [], session: [] }, panels: [], keybindings: [] };
    for (const p of enabled) {
      const c = readContributions(p.manifest!);
      all.commands.push(...c.commands);
      for (const k of Object.keys(all.menus) as MenuWhere[]) all.menus[k].push(...c.menus[k]);
      all.panels.push(...c.panels);
      all.keybindings.push(...c.keybindings);
    }
    return all;
  }, [enabled]);

  live.current = { plugins, enabled, contributions, language, ui };

  const pluginName = useCallback((id: string) => {
    const p = live.current.plugins.find((x) => x.id === id);
    return ltext(p?.manifest?.name, live.current.language) || id;
  }, []);

  // ---- panels ----
  const openPanel = useCallback((panel: PluginPanel, paneId?: string | null) => {
    if (panel.location === "sidebar") setSidebar(panel);
    else if (panel.location === "dialog") setDialog({ panel, paneId: paneId ?? focusedPane.get() });
    else {
      const id = paneId ?? focusedPane.get();
      if (!id) throw new Error(t("plugins.noSession"));
      setSessionPanels((s) => ({ ...s, [id]: panel }));
    }
  }, []);
  const closePanelOf = useCallback((f: Frame) => {
    if (!f.panel) return;
    const key = panelKey(f.panel);
    if (f.panel.location === "sidebar") setSidebar((s) => (s && panelKey(s) === key ? null : s));
    else if (f.panel.location === "dialog") setDialog((d) => (d && panelKey(d.panel) === key ? null : d));
    else {
      const paneId = f.context.paneId as string;
      setSessionPanels((s) => ({ ...s, [paneId]: null }));
    }
  }, []);

  // ---- commands ----
  const commandSeq = useRef(0);
  const pendingCommands = useRef(new Map<number, { pluginId: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>());

  const runCommand = useCallback(
    (pluginId: string, command: string, context: CommandContext) => {
      const host = [...frames].find((f) => f.pluginId === pluginId && f.kind === "host");
      if (!host) return live.current.ui.toast(t("plugins.notLoaded", { name: pluginName(pluginId) }), "error");
      const id = ++commandSeq.current;
      new Promise((resolve, reject) => {
        pendingCommands.current.set(id, { pluginId, resolve, reject });
        post(host, { kind: "command", id, command, context });
      }).catch((e) => live.current.ui.toast(`${pluginName(pluginId)}: ${errorText(e)}`, "error"));
    },
    [pluginName],
  );

  const menuItems = useCallback(
    (where: MenuWhere, context: CommandContext): MenuItem[] => {
      const { contributions: c, language: l } = live.current;
      return c.menus[where]
        .filter((m) => !m.side || !context.side || m.side === context.side)
        .map((m) => {
          const cmd = c.commands.find((x) => x.pluginId === m.pluginId && x.id === m.command)!;
          return { label: ltext(cmd.title, l), icon: <IPlugin size={13} />, hint: pluginName(m.pluginId), onClick: () => runCommand(m.pluginId, m.command, context) };
        });
    },
    [pluginName, runCommand],
  );

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      const kb = live.current.contributions.keybindings.find((k) => matchKey(e, k.key));
      if (!kb) return false;
      runCommand(kb.pluginId, kb.command, { paneId: focusedPane.get() });
      return true;
    },
    [runCommand],
  );

  // ---- calls from plugins ----
  const storage = useRef(new Map<string, Promise<Record<string, unknown>>>());
  const storageWrites = useRef(new Map<string, Promise<unknown>>());
  const store = useCallback((id: string) => {
    let s = storage.current.get(id);
    if (!s) {
      s = api.pluginStorageGet(id).catch(() => ({}));
      storage.current.set(id, s);
    }
    return s;
  }, []);
  /** Read-modify-write of a plugin's data, one at a time per plugin (no lost updates). */
  const mutateStore = useCallback(
    (id: string, change: (data: Record<string, unknown>) => void) => {
      const prev = storageWrites.current.get(id) ?? Promise.resolve();
      const next = prev
        .catch(() => {})
        .then(async () => {
          const data = { ...(await store(id)) };
          change(data);
          await api.pluginStorageSet(id, data);
          storage.current.set(id, Promise.resolve(data));
        });
      storageWrites.current.set(id, next);
      return next;
    },
    [store],
  );

  const handleCall = useCallback(
    async (f: Frame, method: string, params: Record<string, unknown>): Promise<unknown> => {
      const info = live.current.plugins.find((p) => p.id === f.pluginId);
      if (!info?.enabled) throw new Error("plugin is disabled");
      const need = NEEDS[method];
      if (need && !info.granted.includes(need)) throw new Error(t("plugins.denied", { permission: need }));
      const name = pluginName(f.pluginId);
      const pane = () => {
        const id = str(params, "paneId");
        const h = paneRegistry.get(id);
        if (!h) throw new Error(t("plugins.noPane", { id }));
        return h;
      };
      const session = () => {
        const sid = pane().sessionId();
        if (!sid) throw new Error(t("session.notConnected"));
        return sid;
      };

      switch (method) {
        case "ui.toast": {
          const kind = params.kind === "error" || params.kind === "success" ? params.kind : "info";
          // Prefixed, so a plugin can't pass its messages off as the app's.
          live.current.ui.toast(`${name}: ${str(params, "message")}`, kind);
          return null;
        }
        case "ui.confirm":
          return live.current.ui.confirm(`${name}: ${str(params, "title")}`, typeof params.message === "string" ? params.message : undefined);
        case "ui.prompt":
          return live.current.ui.prompt(`${name}: ${str(params, "title")}`, typeof params.label === "string" ? params.label : "", typeof params.value === "string" ? params.value : "");
        case "ui.openPanel": {
          const id = str(params, "panel");
          const panel = live.current.contributions.panels.find((p) => p.pluginId === f.pluginId && p.id === id);
          if (!panel) throw new Error(`Unknown panel "${id}"`);
          openPanel(panel, typeof params.paneId === "string" ? params.paneId : null);
          return null;
        }
        case "ui.closePanel":
          closePanelOf(f);
          return null;
        case "sessions.list":
          return paneRegistry.all().map(([id, h]) => sessionInfo(id, h));
        case "sessions.active": {
          const id = focusedPane.get();
          const h = paneRegistry.get(id);
          return id && h ? sessionInfo(id, h) : null;
        }
        case "terminal.subscribe":
          f.output = true;
          return null;
        case "terminal.send":
          if (!pane().send(str(params, "data"))) throw new Error(t("session.notConnected"));
          return null;
        case "server.exec": {
          const timeout = typeof params.timeout === "number" ? Math.round(params.timeout / 1000) || 1 : undefined;
          return api.pluginExec(session(), str(params, "command"), timeout);
        }
        case "files.home":
          return api.remoteHome(session());
        case "files.list":
          return api.remoteList(session(), str(params, "path"));
        case "files.readText":
          return (await api.remoteReadText(session(), str(params, "path"))).text;
        case "files.writeText":
          await api.remoteWriteText(session(), str(params, "path"), str(params, "content"), { encoding: "UTF-8", bom: false });
          return null;
        case "servers.list":
          return (await api.listServers()).map((s) => ({
            id: s.id,
            name: s.name,
            host: s.host,
            port: s.port,
            username: s.username,
            group: s.group ?? null,
            color: s.color ?? null,
          }));
        case "storage.get":
          return (await store(f.pluginId))[str(params, "key")] ?? null;
        case "storage.all":
          return { ...(await store(f.pluginId)) };
        case "storage.set":
        case "storage.delete": {
          const key = str(params, "key");
          await mutateStore(f.pluginId, (data) => {
            if (method === "storage.set") data[key] = params.value;
            else delete data[key];
          });
          // The plugin's other frames (background code, panels) learn about the change.
          broadcast("storage.changed", { key }, (x) => x.pluginId === f.pluginId && x !== f);
          return null;
        }
        case "clipboard.writeText":
          await writeText(str(params, "text"));
          return null;
        case "openUrl": {
          const url = str(params, "url");
          if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) links can be opened");
          await openExternal(url);
          return null;
        }
        default:
          throw new Error(`Unknown method "${method}"`);
      }
    },
    [pluginName, openPanel, closePanelOf, store, mutateStore],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.td !== 1 || !e.source) return;
      const f = [...frames].find((x) => x.el.contentWindow === e.source);
      if (!f) return;
      if (m.kind === "hello") {
        const info = live.current.plugins.find((p) => p.id === f.pluginId);
        f.ready = true;
        post(f, {
          kind: "init",
          data: {
            plugin: { id: f.pluginId, name: pluginName(f.pluginId), version: info?.manifest?.version ?? "" },
            language: live.current.language,
            permissions: info?.granted ?? [],
            context: f.context,
          },
        });
        for (const q of f.queue.splice(0)) f.el.contentWindow?.postMessage(q, "*");
      } else if (m.kind === "call" && typeof m.method === "string") {
        const params = m.params && typeof m.params === "object" ? m.params : {};
        handleCall(f, m.method, params).then(
          (result) => post(f, { kind: "result", id: m.id, result: result ?? null }),
          (err) => post(f, { kind: "result", id: m.id, error: errorText(err) }),
        );
      } else if (m.kind === "commandResult") {
        const p = pendingCommands.current.get(m.id);
        // Only the plugin that was asked may answer.
        if (!p || p.pluginId !== f.pluginId) return;
        pendingCommands.current.delete(m.id);
        if (m.error != null) p.reject(new Error(String(m.error)));
        else p.resolve(m.result);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleCall, pluginName]);

  // ---- events to plugins ----
  useEffect(() => {
    const decoders = new Map<string, TextDecoder>();
    const buffers = new Map<Frame, Map<string, string>>();
    const connected = new Set<string>();
    let timer: number | undefined;
    const MAX = 1 << 20;
    const flush = () => {
      timer = undefined;
      for (const [f, panes] of buffers) for (const [paneId, text] of panes) post(f, { kind: "event", name: "terminal.output", data: { paneId, text } });
      buffers.clear();
    };
    const off = paneEvents.on((e) => {
      if (e.type === "output") {
        const subs = [...frames].filter((f) => f.output && live.current.plugins.find((p) => p.id === f.pluginId)?.granted.includes("terminal.read"));
        if (!subs.length) return;
        let d = decoders.get(e.paneId);
        if (!d) decoders.set(e.paneId, (d = new TextDecoder()));
        const text = d.decode(e.data, { stream: true });
        for (const f of subs) {
          let panes = buffers.get(f);
          if (!panes) buffers.set(f, (panes = new Map()));
          const next = (panes.get(e.paneId) ?? "") + text;
          panes.set(e.paneId, next.length > MAX ? next.slice(-MAX) : next);
        }
        timer ??= window.setTimeout(flush, 50);
      } else if (e.type === "status") {
        const h = paneRegistry.get(e.paneId);
        if (e.status === "connected" && h) {
          connected.add(e.paneId);
          broadcast("session.connected", sessionInfo(e.paneId, h));
        } else if (e.status !== "connecting" && connected.delete(e.paneId)) {
          broadcast("session.closed", { paneId: e.paneId });
        }
      } else if (e.type === "removed") {
        decoders.delete(e.paneId);
        if (connected.delete(e.paneId)) broadcast("session.closed", { paneId: e.paneId });
      } else if (e.type === "focus") {
        const h = paneRegistry.get(e.paneId);
        broadcast("session.focus", e.paneId && h ? sessionInfo(e.paneId, h) : null);
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    broadcast("language", language);
  }, [language]);

  // Panels of plugins that were disabled or removed close.
  useEffect(() => {
    const ok = (p: PluginPanel | null) => !p || contributions.panels.some((x) => panelKey(x) === panelKey(p));
    setSidebar((s) => (ok(s) ? s : null));
    setDialog((d) => (d && ok(d.panel) ? d : null));
    setSessionPanels((s) => Object.fromEntries(Object.entries(s).filter(([, p]) => ok(p))));
  }, [contributions]);

  const value = useMemo<PluginsCtx>(
    () => ({
      plugins,
      version,
      contributions,
      pluginName,
      reload,
      runCommand,
      menuItems,
      handleKey,
      openPanel,
      sidebarPanel: sidebar,
      closeSidebar: () => setSidebar(null),
      sessionPanel: (paneId) => sessionPanels[paneId] ?? null,
      setSessionPanel: (paneId, panel) => setSessionPanels((s) => ({ ...s, [paneId]: panel })),
    }),
    [plugins, version, contributions, pluginName, reload, runCommand, menuItems, handleKey, openPanel, sidebar, sessionPanels],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="plugin-hosts" aria-hidden>
        {enabled.map((p) => (
          <PluginFrame key={`${p.id}:${version}`} pluginId={p.id} kind="host" src={pluginUrl(p.id, "__host.html", version)} />
        ))}
      </div>
      {dialog && (
        <PluginDialog panel={dialog.panel} paneId={dialog.paneId} title={`${pluginName(dialog.panel.pluginId)}: ${ltext(dialog.panel.title, language)}`} onClose={() => setDialog(null)} />
      )}
    </Ctx.Provider>
  );
}

// ---------- frame components ----------

interface FrameProps {
  pluginId: string;
  kind: Frame["kind"];
  src: string;
  panel?: PluginPanel;
  context?: Record<string, unknown>;
  className?: string;
  title?: string;
}

/**
 * A plugin iframe. `sandbox` without allow-same-origin gives it an opaque origin: no access to
 * the app's DOM, storage or IPC; no popups, top navigation or modal alerts.
 */
export function PluginFrame({ pluginId, kind, src, panel, context, className, title }: FrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const reg = useRef<Frame | null>(null);
  const ctx = context ?? {};
  const ctxKey = JSON.stringify(ctx);
  useLayoutEffect(() => {
    const f: Frame = { el: ref.current!, pluginId, kind, panel, context: ctx, ready: false, queue: [], output: false };
    frames.add(f);
    reg.current = f;
    return () => {
      frames.delete(f);
      reg.current = null;
    };
    // The frame is re-registered only when it is a different document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, kind, src]);
  useEffect(() => {
    const f = reg.current;
    if (!f || JSON.stringify(f.context) === ctxKey) return;
    f.context = ctx;
    post(f, { kind: "event", name: "context", data: ctx });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey]);
  return <iframe ref={ref} src={src} className={className} title={title ?? pluginId} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />;
}

/** A plugin panel (sidebar / session / dialog) showing its HTML entry. */
export function PluginPanelFrame({ panel, paneId }: { panel: PluginPanel; paneId?: string | null }) {
  const { version } = usePlugins();
  const context = useMemo(() => (paneId ? { paneId } : {}), [paneId]);
  return (
    <PluginFrame
      pluginId={panel.pluginId}
      kind="panel"
      panel={panel}
      context={context}
      className="plugin-frame"
      key={version}
      src={pluginUrl(panel.pluginId, panel.entry, version)}
      title={typeof panel.title === "string" ? panel.title : panel.id}
    />
  );
}

function PluginDialog({ panel, paneId, title, onClose }: { panel: PluginPanel; paneId: string | null; title: string; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal plugin-dialog"
        style={{ width: Math.min(panel.width ?? 560, window.innerWidth - 40), height: Math.min(panel.height ?? 420, window.innerHeight - 80) }}
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="plugin-dialog-head">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} title={t("common.close")}>
            ×
          </button>
        </div>
        <PluginPanelFrame panel={panel} paneId={paneId} />
      </div>
    </div>
  );
}
