import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "../lib/open";
import "@xterm/xterm/css/xterm.css";
import { api, configJumpText, errorText, Server } from "../lib/api";
import { DropDetail } from "../lib/dnd";
import { paneEvents, paneRegistry } from "../lib/sessions";
import { clampFontSize, DEFAULT_SETTINGS, terminalFont, useSettings } from "../lib/settings";
import { useTransfers } from "../lib/transfers";
import { MenuItem, useUi } from "../lib/ui";
import { t as trNow, useT } from "../lib/i18n";
import { FilePanel } from "./FilePanel";
import { IClose, IFolder, IPlay, IPlugin, IRefresh, IScript, ISplitDown, ISplitRight, IStep } from "./Icons";
import { useScriptMenu, useScripts } from "./Scripts";
import { commandBlock } from "../lib/scripts";
import { localCallback, urlLinkProvider } from "../lib/termlinks";
import { Telemetry } from "./Telemetry";
import { Ports } from "./Ports";
import { PluginPanelFrame, usePlugins } from "../lib/plugins/host";
import { ltext } from "../lib/plugins/types";

const MOUSE_OFF = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l";

export type SessionStatus = "connecting" | "connected" | "closed" | "error";

interface Props {
  paneId: string;
  server: Server;
  /** The tab holding this pane is shown. */
  visible: boolean;
  /** This pane has keyboard focus within its tab. */
  focused: boolean;
  /** The tab is split into several panes. */
  split: boolean;
  onFocus: () => void;
  onStatus: (s: SessionStatus) => void;
  onSplit: (dir: "row" | "column") => void;
  onClose: () => void;
}

export function SessionView({ paneId, server, visible, focused, split: inSplit, onFocus, onStatus, onSplit, onClose }: Props) {
  const ui = useUi();
  const plugins = usePlugins();
  const pluginPanel = plugins.sessionPanel(paneId);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const tr = useT();
  const { settings, update: updateSettings } = useSettings();
  // The terminal's handlers are bound once; they read the latest settings through refs.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const updateSettingsRef = useRef(updateSettings);
  updateSettingsRef.current = updateSettings;
  const scriptMenu = useScriptMenu();
  const { scripts, run: runScript } = useScripts();
  /** Step-by-step script run in progress: next = index of the command to send next. */
  const [steps, setSteps] = useState<{ name: string; list: string[]; next: number } | null>(null);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  /** Time of the last output from the server (to wait for the login banner before the connect script). */
  const lastOutput = useRef(0);
  const transfers = useTransfers();
  const termEl = useRef<HTMLDivElement>(null);
  const termZone = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  /** Fits the terminal to its box, keeping the content anchored to the bottom when it grows. */
  const refit = useRef<() => void>(() => fit.current?.fit());
  const sessionRef = useRef<string | null>(null);
  const disposed = useRef(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [showFiles, setShowFiles] = useState(() => localStorage.getItem("td.showFiles") !== "0");
  const [split, setSplit] = useState(() => Number(localStorage.getItem("td.split")) || 0.58);
  const remoteDir = useRef<string | null>(null);
  const [remoteDirState, setRemoteDirState] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const updateStatus = useCallback(
    (s: SessionStatus) => {
      setStatus(s);
      onStatus(s);
      paneEvents.emit({ type: "status", paneId, status: s });
    },
    [onStatus, paneId],
  );

  // ---- connection ----
  // Typed secrets, hops to remember and confirmed fingerprints are keyed by hop id
  // (a server id, or jumpHopId(...) for a custom jump host).
  const connect = useCallback(
    async (opts: { secrets?: Record<string, string>; remember?: string[]; accept?: Record<string, string> } = {}) => {
      const t = term.current!;
      updateStatus("connecting");
      const j = server.jump;
      let via = j?.serverId
        ? trNow("session.viaJumpServer")
        : j?.host
          ? trNow("session.via", { via: `${j.username}@${j.host}${j.port && j.port !== 22 ? `:${j.port}` : ""}` })
          : "";
      if (!via) {
        // No jump host in the app: ProxyJump from ~/.ssh/config may apply.
        const cfg = await api.sshConfigLookup(server.host, server.port).catch(() => null);
        if (disposed.current) return;
        if (cfg?.jumps.length) via = trNow("session.viaConfig", { via: configJumpText(cfg) });
      }
      t.write(`\r\n\x1b[90m${trNow("session.connecting", { target: `${server.username}@${server.host}:${server.port}`, via })}\x1b[0m\r\n`);
      try {
        fit.current?.fit();
        let id: string | null = null;
        let closedEarly = false;
        id = await api.connect({
          serverId: server.id,
          secrets: opts.secrets,
          remember: opts.remember,
          accept: opts.accept,
          cols: t.cols,
          rows: t.rows,
          onEvent: (e) => {
            if (disposed.current) return;
            if (e.type === "data") {
              lastOutput.current = Date.now();
              t.write(e.data);
              paneEvents.emit({ type: "output", paneId, data: e.data });
            }
            else {
              if (id) api.disconnect(id).catch(() => {});
              else closedEarly = true;
              t.write(`${MOUSE_OFF}\r\n\x1b[33m${e.reason}. ${trNow("session.enterToReconnect")}\x1b[0m\r\n`);
              if (id && sessionRef.current === id) {
                sessionRef.current = null;
                setSessionId(null);
                updateStatus("closed");
              }
            }
          },
        });
        if (disposed.current || closedEarly) {
          // The tab was closed while connecting, or the server hung up right away.
          if (closedEarly) updateStatus("closed");
          api.disconnect(id).catch(() => {});
          return;
        }
        sessionRef.current = id;
        setSessionId(id);
        updateStatus("connected");
        t.focus();
        onConnectedRef.current();
      } catch (e) {
        if (disposed.current) return;
        const raw = errorText(e);
        // Errors from a jump host: JUMP|<hop id>|<user@host>|<auth>|<code>
        const jm = raw.match(/^JUMP\|([^|]*)\|([^|]*)\|([^|]*)\|([\s\S]*)$/);
        const hop = jm
          ? { id: jm[1], label: jm[2], isKey: jm[3] === "key", isAgent: jm[3] === "agent", jump: true, msg: jm[4] }
          : { id: server.id, label: `${server.username}@${server.host}`, isKey: server.auth === "key", isAgent: server.auth === "agent", jump: false, msg: raw };
        const host = hop.label.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
        const msg = hop.msg;
        if (msg === "NEED_SECRET" || (msg === "AUTH_FAILED" && !hop.isKey && !hop.isAgent)) {
          const r = await ui.dialog({
            title: trNow(hop.isKey ? (hop.jump ? "session.keyPassJump" : "session.keyPass") : hop.jump ? "session.passJump" : "session.pass", { label: hop.label }),
            message: msg === "AUTH_FAILED" ? <span className="err">{trNow("session.wrongPassword")}</span> : undefined,
            fields: [
              { name: "secret", label: hop.isKey ? trNow("session.passphrase") : trNow("session.password"), type: "password" },
              { name: "remember", label: trNow("session.remember"), type: "checkbox", value: true },
            ],
            okText: trNow("sidebar.connect"),
          });
          if (r) {
            const remember = (opts.remember ?? []).filter((x) => x !== hop.id);
            if (r.remember) remember.push(hop.id);
            return connect({ ...opts, secrets: { ...opts.secrets, [hop.id]: String(r.secret) }, remember });
          }
          t.write(`\x1b[90m${trNow("session.cancelled")}\x1b[0m\r\n`);
          return updateStatus("closed");
        }
        if (msg.startsWith("HOSTKEY_UNKNOWN|") || msg.startsWith("HOSTKEY_CHANGED|")) {
          const [kind, fp, alg] = msg.split("|");
          const changed = kind === "HOSTKEY_CHANGED";
          const ok = await ui.dialog({
            title: changed ? trNow("session.keyChangedTitle") : hop.jump ? trNow("session.newJumpServer") : trNow("session.newServer"),
            danger: changed,
            message: (
              <>
                {changed ? (
                  <p className="err">{trNow(hop.jump ? "session.keyChangedJump" : "session.keyChanged", { host })}</p>
                ) : (
                  <p>{trNow(hop.jump ? "session.unknownKeyJump" : "session.unknownKey", { host })}</p>
                )}
                <code className="fingerprint">
                  {alg ? `${alg} ` : ""}
                  {fp}
                </code>
              </>
            ),
            okText: changed ? trNow("session.trustNewKey") : trNow("session.trustAndConnect"),
          });
          if (ok) return connect({ ...opts, accept: { ...opts.accept, [hop.id]: fp } });
          t.write(`\x1b[90m${trNow("session.cancelled")}\x1b[0m\r\n`);
          return updateStatus("closed");
        }
        const text = msg === "AUTH_FAILED" ? (hop.jump ? trNow("session.jumpKeyRejected", { label: hop.label }) : trNow("session.keyRejected")) : msg;
        t.write(`\x1b[31m${text}\x1b[0m\r\n\x1b[90m${trNow("session.enterToRetry")}\x1b[0m\r\n`);
        updateStatus("error");
      }
    },
    [server, ui, updateStatus],
  );

  // ---- terminal setup ----
  useEffect(() => {
    const st = settingsRef.current;
    // Link under the mouse: shown as a tooltip, copied by a right click.
    let hovered: string | null = null;
    const hoverLink = (url: string | null) => {
      hovered = url;
      if (termEl.current) termEl.current.title = url ? trNow("session.linkHint", { url }) : "";
    };
    // An OAuth link whose callback waits on the server's localhost: forward that port first,
    // otherwise the browser's redirect after login lands nowhere.
    const openLink = async (url: string) => {
      const cb = localCallback(url);
      const sid = sessionRef.current;
      if (cb && sid) {
        const st = await api
          .forwardStart(sid, {
            id: `link-callback:${cb.port}`,
            kind: "local",
            bindHost: cb.host === "::1" ? "::1" : "127.0.0.1",
            bindPort: cb.port,
            destHost: cb.host,
            destPort: cb.port,
            enabled: true,
          })
          .catch((e) => ({ status: `error: ${errorText(e)}` }));
        if (st.status === "active") uiRef.current.toast(trNow("session.callbackForwarded", { port: cb.port }));
        else uiRef.current.toast(trNow("session.callbackFailed", { port: cb.port, error: st.status.replace(/^error: /, "") }), "error");
      }
      openUrl(url);
    };

    const t = new Terminal({
      fontFamily: terminalFont(st.termFontFamily),
      fontSize: st.termFontSize,
      lineHeight: st.termLineHeight,
      cursorStyle: st.termCursorStyle,
      cursorBlink: st.termCursorBlink,
      allowProposedApi: true,
      scrollback: st.termScrollback,
      // OSC 8 hyperlinks: xterm's default opens them with window.open, which does nothing in Tauri.
      linkHandler: { activate: (_e, uri) => openLink(uri), hover: (_e, uri) => hoverLink(uri), leave: () => hoverLink(null) },
      theme: {
        background: "#1e1f22",
        foreground: "#d6deeb",
        cursor: "#58a6ff",
        selectionBackground: "#214283",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.registerLinkProvider(urlLinkProvider(t, { open: openLink, hover: hoverLink }));
    t.open(termEl.current!);
    term.current = t;
    fit.current = f;
    f.fit();

    // When the terminal grows taller, xterm.js only pulls lines back from the scrollback if the
    // cursor is on the last row; otherwise it adds blank rows at the bottom. TUIs with the cursor
    // mid-screen (e.g. Claude Code's input box) then stay squeezed in the old height. So, like
    // most terminals, keep the content anchored to the bottom: move the cursor to the last row,
    // resize, and put it back where it was (shifted by the lines pulled from the scrollback).
    // Done inside write callbacks so it lines up with output that is still being parsed.
    refit.current = () => {
      t.write("", () => {
        const d = f.proposeDimensions();
        if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols < 1 || d.rows < 1) return;
        if (d.cols === t.cols && d.rows === t.rows) return;
        const buf = t.buffer.active;
        const { cursorX: x, cursorY: y, baseY } = buf;
        if (d.rows <= t.rows || d.cols !== t.cols || buf.type !== "normal" || baseY === 0 || y >= t.rows - 1) {
          t.resize(d.cols, d.rows);
          return;
        }
        t.write(`\x1b[${t.rows};1H`, () => {
          t.resize(d.cols, d.rows);
          const pulled = baseY - t.buffer.active.baseY;
          t.write(`\x1b[${y + pulled + 1};${x + 1}H`);
        });
      });
    };

    const enc = new TextEncoder();
    const send = (s: string) => sessionRef.current && api.write(sessionRef.current, enc.encode(s)).catch(() => {});

    // A TUI killed mid-run (Ctrl+C on a stuck server, dropped link) can leave mouse reporting on, and
    // every mouse move then lands in the shell as text. Back at the normal screen it is always stale.
    t.buffer.onBufferChange((b) => b.type === "normal" && t.write(MOUSE_OFF));

    t.onData((d) => {
      if (!sessionRef.current) {
        // Enter on a closed session reconnects.
        if (d === "\r" && statusRef.current !== "connecting") connectRef.current();
        return;
      }
      send(d);
    });
    t.onBinary((d) => sessionRef.current && api.write(sessionRef.current, Uint8Array.from(d, (c) => c.charCodeAt(0) & 255)));
    t.onResize(({ cols, rows }) => sessionRef.current && api.resize(sessionRef.current, cols, rows).catch(() => {}));

    // Zoom changes the global setting, so every open terminal follows (applied by the effect below).
    const setFont = (size: number) => updateSettingsRef.current({ termFontSize: clampFontSize(size) });

    t.attachCustomWheelEventHandler((e) => {
      if (!(e.ctrlKey || e.metaKey) || e.deltaY === 0) return true;
      e.preventDefault();
      setFont(settingsRef.current.termFontSize + (e.deltaY < 0 ? 1 : -1));
      return false;
    });

    // Copy on select: once the selection has settled (it changes on every mouse move while dragging).
    let copyTimer: number | undefined;
    t.onSelectionChange(() => {
      if (!settingsRef.current.termCopyOnSelect) return;
      clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        const sel = t.getSelection();
        if (sel) writeText(sel);
      }, 200);
    });

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key === "Enter" && stepsRef.current) return stepActions.current.next(), false;
      if (mod && e.shiftKey && e.code === "KeyC") {
        const sel = t.getSelection();
        if (sel) writeText(sel);
        return false;
      }
      if (mod && e.shiftKey && e.code === "KeyV") {
        readText().then((txt) => txt && t.paste(txt));
        return false;
      }
      if (mod && !e.shiftKey && (e.key === "=" || e.key === "+")) return setFont(settingsRef.current.termFontSize + 1), false;
      if (mod && !e.shiftKey && e.key === "-") return setFont(settingsRef.current.termFontSize - 1), false;
      if (mod && !e.shiftKey && e.key === "0") return setFont(DEFAULT_SETTINGS.termFontSize), false;
      return true;
    });

    // Right click (by default): copy selection if any, otherwise paste (like PuTTY / Windows Terminal).
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      if (hovered) {
        writeText(hovered);
        uiRef.current.toast(trNow("session.linkCopied"));
        return;
      }
      const mode = settingsRef.current.termRightClick;
      if (mode === "none") return;
      const sel = mode === "copyPaste" ? t.getSelection() : "";
      if (sel) {
        writeText(sel);
        t.clearSelection();
      } else readText().then((txt) => txt && t.paste(txt));
    };
    termEl.current!.addEventListener("contextmenu", onContext);

    const ro = new ResizeObserver(() => {
      if (termEl.current && termEl.current.offsetWidth > 0) refit.current();
    });
    ro.observe(termEl.current!);

    connectRef.current();

    return () => {
      disposed.current = true;
      clearTimeout(copyTimer);
      ro.disconnect();
      if (sessionRef.current) api.disconnect(sessionRef.current);
      sessionRef.current = null;
      t.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Settings changed (here, in another pane or in the settings dialog): apply to the live terminal.
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.fontFamily = terminalFont(settings.termFontFamily);
    t.options.fontSize = settings.termFontSize;
    t.options.lineHeight = settings.termLineHeight;
    t.options.cursorStyle = settings.termCursorStyle;
    t.options.cursorBlink = settings.termCursorBlink;
    t.options.scrollback = settings.termScrollback;
    // Hidden tabs are refitted when shown (see below).
    if (visibleRef.current) refit.current();
  }, [settings.termFontFamily, settings.termFontSize, settings.termLineHeight, settings.termCursorStyle, settings.termCursorBlink, settings.termScrollback]);

  const connectRef = useRef(() => {});
  connectRef.current = () => connect();
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      refit.current();
      // Don't steal focus from the file panel / bar of this pane when it was clicked.
      if (focused && !rootRef.current?.contains(document.activeElement)) term.current?.focus();
    });
  }, [visible, focused, showFiles, split, pluginPanel]);

  // ---- scripts ----
  const sendText = useCallback((text: string) => {
    if (!sessionRef.current) return false;
    api.write(sessionRef.current, new TextEncoder().encode(text)).catch(() => {});
    return true;
  }, []);

  const stepActions = useRef({ next: () => {}, rest: () => {}, stop: () => {} });
  stepActions.current = {
    next: () => {
      const st = stepsRef.current;
      if (!st || !sendText(st.list[st.next].replace(/\n/g, "\r") + "\r")) return setSteps(null);
      setSteps(st.next + 1 < st.list.length ? { ...st, next: st.next + 1 } : null);
      term.current?.focus();
    },
    rest: () => {
      const st = stepsRef.current;
      if (st) sendText(commandBlock(st.list.slice(st.next)));
      setSteps(null);
      term.current?.focus();
    },
    stop: () => {
      setSteps(null);
      term.current?.focus();
    },
  };
  // A finished or lost session ends the step-by-step run.
  useEffect(() => {
    if (status !== "connected") setSteps(null);
  }, [status]);

  // Let app-level features (scripts) type into this terminal.
  useEffect(() => {
    paneRegistry.set(paneId, {
      serverId: server.id,
      serverName: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      sessionId: () => sessionRef.current,
      status: () => statusRef.current,
      send: sendText,
      runSteps: (name, list) => {
        if (!sessionRef.current || list.length === 0) return false;
        stepsRef.current = { name, list, next: 0 };
        stepActions.current.next();
        return true;
      },
      focus: () => term.current?.focus(),
    });
    return () => paneRegistry.delete(paneId);
  }, [paneId, server.id, server.name, server.host, server.port, server.username, sendText]);

  // The server's connect script: runs once the login banner / prompt has settled.
  const onConnectedRef = useRef(() => {});
  onConnectedRef.current = () => {
    const id = server.connectScript;
    if (!id) return;
    const script = scripts.find((x) => x.id === id);
    if (!script) return ui.toast(trNow("session.connectScriptMissing", { name: server.name }), "error");
    const session = sessionRef.current;
    const started = Date.now();
    const timer = setInterval(() => {
      if (sessionRef.current !== session || disposed.current) return clearInterval(timer);
      const quiet = Date.now() - Math.max(lastOutput.current, started) > 400;
      if (quiet || Date.now() - started > 5000) {
        clearInterval(timer);
        runScript(script, paneId);
      }
    }, 100);
  };

  // ---- drop onto terminal = upload to the current remote folder ----
  const dropRef = useRef<(d: DropDetail) => void>(() => {});
  dropRef.current = (d) => {
    const sid = sessionRef.current;
    if (!sid) return ui.toast(trNow("session.notConnected"), "error");
    if (!remoteDir.current) return ui.toast(trNow("session.openFilesFirst"), "error");
    if (d.source.kind === "os" || d.source.kind === "local")
      transfers.start({ direction: "up", sessionId: sid, server: server.name, sources: d.source.paths, dest: remoteDir.current });
  };
  useEffect(() => {
    const el = termZone.current!;
    const h = (e: Event) => dropRef.current((e as CustomEvent<DropDetail>).detail);
    el.addEventListener("td-drop", h);
    return () => el.removeEventListener("td-drop", h);
  }, []);

  // ---- splitter ----
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = body.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const v = Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height));
      setSplit(v);
      localStorage.setItem("td.split", String(v));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleFiles = () => {
    // With a plugin panel in the bottom area, "Files" switches back to the files.
    if (pluginPanel) {
      plugins.setSessionPanel(paneId, null);
      if (showFiles) return;
    }
    localStorage.setItem("td.showFiles", showFiles ? "0" : "1");
    setShowFiles(!showFiles);
  };

  const sessionPanels = plugins.contributions.panels.filter((p) => p.location === "session");
  const hasPluginItems = sessionPanels.length > 0 || plugins.contributions.menus.session.length > 0;
  const pluginMenu = (e: React.MouseEvent<HTMLElement>) => {
    const items: MenuItem[] = plugins.menuItems("session", { paneId });
    if (items.length && sessionPanels.length) items.push("-");
    for (const p of sessionPanels) {
      const open = pluginPanel?.pluginId === p.pluginId && pluginPanel.id === p.id;
      items.push({
        label: `${open ? "✓ " : ""}${ltext(p.title, settings.language)}`,
        icon: <IPlugin size={13} />,
        hint: plugins.pluginName(p.pluginId),
        onClick: () => plugins.setSessionPanel(paneId, open ? null : p),
      });
    }
    ui.menu(e.currentTarget, items);
  };
  const showBottom = showFiles || !!pluginPanel;

  const onRemoteDir = useCallback((d: string | null) => {
    remoteDir.current = d;
    setRemoteDirState(d);
  }, []);

  const cdTo = useCallback((dir: string) => {
    if (!sessionRef.current) return;
    api.write(sessionRef.current, new TextEncoder().encode(`cd '${dir.replace(/'/g, "'\\''")}'\r`)).catch(() => {});
    term.current?.focus();
  }, []);

  return (
    <div ref={rootRef} className={`session ${inSplit && focused ? "focused" : ""}`} onMouseDownCapture={onFocus} onFocusCapture={onFocus}>
      <div className="session-bar">
        <span className={`status-dot ${status}`} />
        <span className="session-target">
          {server.username}@{server.host}
          {server.port !== 22 ? `:${server.port}` : ""}
        </span>
        <span className="session-status">
          {tr(`session.status.${status}`)}
        </span>
        <div className="spacer" />
        {status === "connected" && <Telemetry sessionId={sessionId} visible={visible} />}
        {status === "connected" && <Ports sessionId={sessionId} visible={visible} />}
        {status === "connected" && showFiles && remoteDirState && (
          <button className="btn btn-sm" title={tr("session.cdHint")} onClick={() => cdTo(remoteDir.current!)}>
            {tr("session.cdHere")}
          </button>
        )}
        {(status === "closed" || status === "error") && (
          <button className="btn btn-sm btn-primary" onClick={() => connect()} title={tr("session.reconnect")}>
            <IRefresh size={13} /> <span className="btn-label">{tr("session.reconnect")}</span>
          </button>
        )}
        <button className="btn btn-sm" disabled={status !== "connected"} onClick={(e) => ui.menu(e.currentTarget, scriptMenu(paneId))} title={tr("session.runScript")}>
          <IScript /> <span className="btn-label">{tr("app.scripts")}</span>
        </button>
        {hasPluginItems && (
          <button className={`btn btn-sm ${pluginPanel ? "on" : ""}`} onClick={pluginMenu} title={tr("plugins.sessionMenu")}>
            <IPlugin /> <span className="btn-label">{tr("plugins.sessionMenu")}</span>
          </button>
        )}
        <button className={`btn btn-sm ${showFiles && !pluginPanel ? "on" : ""}`} onClick={toggleFiles} title={tr("session.toggleFiles")}>
          <IFolder /> <span className="btn-label">{tr("settings.files")}</span>
        </button>
        <span className="bar-sep" />
        <button className="icon-btn" onClick={() => onSplit("row")} title={tr("session.splitRight")}>
          <ISplitRight size={14} />
        </button>
        <button className="icon-btn" onClick={() => onSplit("column")} title={tr("session.splitDown")}>
          <ISplitDown size={14} />
        </button>
        {inSplit && (
          <button className="icon-btn" onClick={onClose} title={tr("session.closePane")}>
            <IClose size={14} />
          </button>
        )}
      </div>
      {steps && (
        <div className="step-bar">
          <IStep size={13} />
          <span className="step-name">
            {steps.name}: {tr("session.step", { i: steps.next + 1, n: steps.list.length })}
          </span>
          <code className="step-next" title={steps.list[steps.next]}>
            {steps.list[steps.next]}
          </code>
          <button className="btn btn-sm btn-primary" onClick={() => stepActions.current.next()} title={tr("session.stepNextHint")}>
            <IStep size={12} /> {tr("session.stepNext")}
          </button>
          <button className="btn btn-sm" onClick={() => stepActions.current.rest()} title={tr("session.stepRestHint")}>
            <IPlay size={12} /> {tr("session.stepRest")}
          </button>
          <button className="icon-btn" onClick={() => stepActions.current.stop()} title={tr("session.stepStop")}>
            <IClose size={13} />
          </button>
        </div>
      )}
      <div className="session-body" ref={body}>
        <div className="term-zone" ref={termZone} data-dropzone={`${paneId}:term`} data-accept="os,local" style={{ flex: showBottom ? `0 0 ${split * 100}%` : "1 1 auto" }}>
          <div className="term" ref={termEl} />
          <div className="drop-overlay">{tr("session.dropUpload")}</div>
        </div>
        {showBottom && <div className="splitter" onPointerDown={startResize} />}
        {showFiles && (
          // Hidden, not unmounted, under a plugin panel: keeps folders and selection.
          <div className="files-zone" style={pluginPanel ? { display: "none" } : undefined}>
            <FilePanel tabId={paneId} server={server} sessionId={sessionId} onRemoteDir={onRemoteDir} onCd={cdTo} />
          </div>
        )}
        {pluginPanel && (
          <div className="plugin-zone">
            <div className="plugin-zone-head">
              <IPlugin size={13} />
              <span>{ltext(pluginPanel.title, settings.language)}</span>
              {plugins.pluginName(pluginPanel.pluginId) !== ltext(pluginPanel.title, settings.language) && (
                <span className="muted">{plugins.pluginName(pluginPanel.pluginId)}</span>
              )}
              <div className="spacer" />
              <button className="icon-btn" onClick={() => plugins.setSessionPanel(paneId, null)} title={tr("plugins.closePanel")}>
                <IClose size={13} />
              </button>
            </div>
            <PluginPanelFrame panel={pluginPanel} paneId={paneId} />
          </div>
        )}
      </div>
    </div>
  );
}
