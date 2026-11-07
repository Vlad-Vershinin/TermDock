import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "../lib/open";
import "@xterm/xterm/css/xterm.css";
import { api, errorText, Server } from "../lib/api";
import { DropDetail } from "../lib/dnd";
import { paneRegistry } from "../lib/sessions";
import { useTransfers } from "../lib/transfers";
import { useUi } from "../lib/ui";
import { FilePanel } from "./FilePanel";
import { IClose, IFolder, IRefresh, IScript, ISplitDown, ISplitRight } from "./Icons";
import { useScriptMenu } from "./Scripts";
import { Telemetry } from "./Telemetry";

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

const FONT = '"JetBrains Mono", "Cascadia Mono", "Fira Code", Consolas, "DejaVu Sans Mono", "Ubuntu Mono", monospace';

export function SessionView({ paneId, server, visible, focused, split: inSplit, onFocus, onStatus, onSplit, onClose }: Props) {
  const ui = useUi();
  const scriptMenu = useScriptMenu();
  const transfers = useTransfers();
  const termEl = useRef<HTMLDivElement>(null);
  const termZone = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
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
    },
    [onStatus],
  );

  // ---- connection ----
  const connect = useCallback(
    async (opts: { secret?: string; remember?: boolean; accept?: string } = {}) => {
      const t = term.current!;
      updateStatus("connecting");
      t.write(`\r\n\x1b[90mПодключение к ${server.username}@${server.host}:${server.port}…\x1b[0m\r\n`);
      try {
        fit.current?.fit();
        let id: string | null = null;
        let closedEarly = false;
        id = await api.connect({
          serverId: server.id,
          secret: opts.secret,
          remember: opts.remember,
          acceptFingerprint: opts.accept,
          cols: t.cols,
          rows: t.rows,
          onEvent: (e) => {
            if (disposed.current) return;
            if (e.type === "data") t.write(new Uint8Array(e.data));
            else {
              if (id) api.disconnect(id).catch(() => {});
              else closedEarly = true;
              t.write(`\r\n\x1b[33m${e.reason}. Нажмите Enter, чтобы переподключиться.\x1b[0m\r\n`);
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
      } catch (e) {
        if (disposed.current) return;
        const msg = errorText(e);
        if (msg === "NEED_SECRET" || (msg === "AUTH_FAILED" && server.auth === "password")) {
          const isKey = server.auth === "key";
          const r = await ui.dialog({
            title: isKey ? "Пароль от ключа" : `Пароль для ${server.username}@${server.host}`,
            message: msg === "AUTH_FAILED" ? <span className="err">Неверный пароль, попробуйте ещё раз.</span> : undefined,
            fields: [
              { name: "secret", label: isKey ? "Passphrase" : "Пароль", type: "password" },
              { name: "remember", label: "Сохранить в системном хранилище паролей", type: "checkbox", value: true },
            ],
            okText: "Подключиться",
          });
          if (r) return connect({ ...opts, secret: String(r.secret), remember: !!r.remember });
          t.write("\x1b[90mОтменено.\x1b[0m\r\n");
          return updateStatus("closed");
        }
        if (msg.startsWith("HOSTKEY_UNKNOWN|") || msg.startsWith("HOSTKEY_CHANGED|")) {
          const [kind, fp, alg] = msg.split("|");
          const changed = kind === "HOSTKEY_CHANGED";
          const ok = await ui.dialog({
            title: changed ? "⚠ Ключ сервера изменился!" : "Новый сервер",
            danger: changed,
            message: (
              <>
                {changed ? (
                  <p className="err">
                    Ключ сервера {server.host} не совпадает с сохранённым. Это может означать переустановку сервера — или атаку
                    «человек посередине». Продолжайте, только если уверены.
                  </p>
                ) : (
                  <p>Подлинность сервера {server.host} ещё не подтверждена. Сверьте отпечаток ключа:</p>
                )}
                <code className="fingerprint">
                  {alg ? `${alg} ` : ""}
                  {fp}
                </code>
              </>
            ),
            okText: changed ? "Доверять новому ключу" : "Доверять и подключиться",
          });
          if (ok) return connect({ ...opts, accept: fp });
          t.write("\x1b[90mОтменено.\x1b[0m\r\n");
          return updateStatus("closed");
        }
        const text = msg === "AUTH_FAILED" ? "Сервер отклонил ключ" : msg;
        t.write(`\x1b[31m${text}\x1b[0m\r\n\x1b[90mНажмите Enter, чтобы попробовать снова.\x1b[0m\r\n`);
        updateStatus("error");
      }
    },
    [server, ui, updateStatus],
  );

  // ---- terminal setup ----
  useEffect(() => {
    const t = new Terminal({
      fontFamily: FONT,
      fontSize: Number(localStorage.getItem("td.fontSize")) || 14,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
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
    t.loadAddon(new WebLinksAddon((_e, uri) => openUrl(uri)));
    t.open(termEl.current!);
    term.current = t;
    fit.current = f;
    f.fit();

    const enc = new TextEncoder();
    const send = (s: string) => sessionRef.current && api.write(sessionRef.current, enc.encode(s)).catch(() => {});

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

    const setFont = (size: number) => {
      t.options.fontSize = Math.max(8, Math.min(32, size));
      localStorage.setItem("td.fontSize", String(t.options.fontSize));
      f.fit();
    };

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.code === "KeyC") {
        const sel = t.getSelection();
        if (sel) writeText(sel);
        return false;
      }
      if (mod && e.shiftKey && e.code === "KeyV") {
        readText().then((txt) => txt && t.paste(txt));
        return false;
      }
      if (mod && !e.shiftKey && (e.key === "=" || e.key === "+")) return setFont(t.options.fontSize! + 1), false;
      if (mod && !e.shiftKey && e.key === "-") return setFont(t.options.fontSize! - 1), false;
      if (mod && !e.shiftKey && e.key === "0") return setFont(14), false;
      return true;
    });

    // Right click: copy selection if any, otherwise paste (like PuTTY / Windows Terminal).
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const sel = t.getSelection();
      if (sel) {
        writeText(sel);
        t.clearSelection();
      } else readText().then((txt) => txt && t.paste(txt));
    };
    termEl.current!.addEventListener("contextmenu", onContext);

    const ro = new ResizeObserver(() => {
      if (termEl.current && termEl.current.offsetWidth > 0) f.fit();
    });
    ro.observe(termEl.current!);

    connectRef.current();

    return () => {
      disposed.current = true;
      ro.disconnect();
      if (sessionRef.current) api.disconnect(sessionRef.current);
      sessionRef.current = null;
      t.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectRef = useRef(() => {});
  connectRef.current = () => connect();
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      fit.current?.fit();
      // Don't steal focus from the file panel / bar of this pane when it was clicked.
      if (focused && !rootRef.current?.contains(document.activeElement)) term.current?.focus();
    });
  }, [visible, focused, showFiles, split]);

  // Let app-level features (scripts) type into this terminal.
  useEffect(() => {
    const enc = new TextEncoder();
    paneRegistry.set(paneId, {
      serverId: server.id,
      send: (text) => {
        if (!sessionRef.current) return false;
        api.write(sessionRef.current, enc.encode(text)).catch(() => {});
        return true;
      },
      focus: () => term.current?.focus(),
    });
    return () => paneRegistry.delete(paneId);
  }, [paneId, server.id]);

  // ---- drop onto terminal = upload to the current remote folder ----
  const dropRef = useRef<(d: DropDetail) => void>(() => {});
  dropRef.current = (d) => {
    const sid = sessionRef.current;
    if (!sid) return ui.toast("Нет подключения", "error");
    if (!remoteDir.current) return ui.toast("Откройте панель файлов, чтобы выбрать папку на сервере", "error");
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
    localStorage.setItem("td.showFiles", showFiles ? "0" : "1");
    setShowFiles(!showFiles);
  };

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
          {{ connecting: "подключение…", connected: "подключено", closed: "отключено", error: "ошибка" }[status]}
        </span>
        <div className="spacer" />
        {status === "connected" && <Telemetry sessionId={sessionId} visible={visible} />}
        {status === "connected" && showFiles && remoteDirState && (
          <button className="btn btn-sm" title="Перейти в терминале в папку, открытую в файловой панели" onClick={() => cdTo(remoteDir.current!)}>
            cd сюда
          </button>
        )}
        {(status === "closed" || status === "error") && (
          <button className="btn btn-sm btn-primary" onClick={() => connect()} title="Переподключиться">
            <IRefresh size={13} /> <span className="btn-label">Переподключиться</span>
          </button>
        )}
        <button className="btn btn-sm" disabled={status !== "connected"} onClick={(e) => ui.menu(e.currentTarget, scriptMenu(paneId))} title="Выполнить сохранённый скрипт">
          <IScript /> <span className="btn-label">Скрипты</span>
        </button>
        <button className={`btn btn-sm ${showFiles ? "on" : ""}`} onClick={toggleFiles} title="Показать/скрыть файлы">
          <IFolder /> <span className="btn-label">Файлы</span>
        </button>
        <span className="bar-sep" />
        <button className="icon-btn" onClick={() => onSplit("row")} title="Разделить вправо — ещё одно подключение (Alt+Shift+=)">
          <ISplitRight size={14} />
        </button>
        <button className="icon-btn" onClick={() => onSplit("column")} title="Разделить вниз — ещё одно подключение (Alt+Shift+-)">
          <ISplitDown size={14} />
        </button>
        {inSplit && (
          <button className="icon-btn" onClick={onClose} title="Закрыть панель (Ctrl+Shift+W)">
            <IClose size={14} />
          </button>
        )}
      </div>
      <div className="session-body" ref={body}>
        <div className="term-zone" ref={termZone} data-dropzone={`${paneId}:term`} data-accept="os,local" style={{ flex: showFiles ? `0 0 ${split * 100}%` : "1 1 auto" }}>
          <div className="term" ref={termEl} />
          <div className="drop-overlay">Отпустите, чтобы загрузить в текущую папку сервера</div>
        </div>
        {showFiles && (
          <>
            <div className="splitter" onPointerDown={startResize} />
            <div className="files-zone">
              <FilePanel tabId={paneId} server={server} sessionId={sessionId} onRemoteDir={onRemoteDir} onCd={cdTo} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
