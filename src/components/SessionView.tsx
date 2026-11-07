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
import { IClose, IFolder, IPlay, IRefresh, IScript, ISplitDown, ISplitRight, IStep } from "./Icons";
import { useScriptMenu, useScripts } from "./Scripts";
import { commandBlock } from "../lib/scripts";
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
    },
    [onStatus],
  );

  // ---- connection ----
  // Typed secrets, hops to remember and confirmed fingerprints are keyed by hop id
  // (a server id, or jumpHopId(...) for a custom jump host).
  const connect = useCallback(
    async (opts: { secrets?: Record<string, string>; remember?: string[]; accept?: Record<string, string> } = {}) => {
      const t = term.current!;
      updateStatus("connecting");
      const j = server.jump;
      const via = j?.serverId ? " через сервер-посредник" : j?.host ? ` через ${j.username}@${j.host}${j.port && j.port !== 22 ? `:${j.port}` : ""}` : "";
      t.write(`\r\n\x1b[90mПодключение к ${server.username}@${server.host}:${server.port}${via}…\x1b[0m\r\n`);
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
              t.write(new Uint8Array(e.data));
            }
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
        onConnectedRef.current();
      } catch (e) {
        if (disposed.current) return;
        const raw = errorText(e);
        // Errors from a jump host: JUMP|<hop id>|<user@host>|<auth>|<code>
        const jm = raw.match(/^JUMP\|([^|]*)\|([^|]*)\|([^|]*)\|([\s\S]*)$/);
        const hop = jm
          ? { id: jm[1], label: jm[2], isKey: jm[3] === "key", jump: true, msg: jm[4] }
          : { id: server.id, label: `${server.username}@${server.host}`, isKey: server.auth === "key", jump: false, msg: raw };
        const host = hop.label.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
        const what = hop.jump ? "сервера-посредника " : "";
        const msg = hop.msg;
        if (msg === "NEED_SECRET" || (msg === "AUTH_FAILED" && !hop.isKey)) {
          const r = await ui.dialog({
            title: hop.isKey ? `Пароль от ключа ${what}${hop.label}` : `Пароль ${what}${hop.label}`,
            message: msg === "AUTH_FAILED" ? <span className="err">Неверный пароль, попробуйте ещё раз.</span> : undefined,
            fields: [
              { name: "secret", label: hop.isKey ? "Passphrase" : "Пароль", type: "password" },
              { name: "remember", label: "Сохранить в системном хранилище паролей", type: "checkbox", value: true },
            ],
            okText: "Подключиться",
          });
          if (r) {
            const remember = (opts.remember ?? []).filter((x) => x !== hop.id);
            if (r.remember) remember.push(hop.id);
            return connect({ ...opts, secrets: { ...opts.secrets, [hop.id]: String(r.secret) }, remember });
          }
          t.write("\x1b[90mОтменено.\x1b[0m\r\n");
          return updateStatus("closed");
        }
        if (msg.startsWith("HOSTKEY_UNKNOWN|") || msg.startsWith("HOSTKEY_CHANGED|")) {
          const [kind, fp, alg] = msg.split("|");
          const changed = kind === "HOSTKEY_CHANGED";
          const ok = await ui.dialog({
            title: changed ? "⚠ Ключ сервера изменился!" : hop.jump ? "Новый сервер-посредник" : "Новый сервер",
            danger: changed,
            message: (
              <>
                {changed ? (
                  <p className="err">
                    Ключ {hop.jump ? "сервера-посредника" : "сервера"} {host} не совпадает с сохранённым. Это может означать переустановку
                    сервера — или атаку «человек посередине». Продолжайте, только если уверены.
                  </p>
                ) : (
                  <p>
                    Подлинность {hop.jump ? "сервера-посредника" : "сервера"} {host} ещё не подтверждена. Сверьте отпечаток ключа:
                  </p>
                )}
                <code className="fingerprint">
                  {alg ? `${alg} ` : ""}
                  {fp}
                </code>
              </>
            ),
            okText: changed ? "Доверять новому ключу" : "Доверять и подключиться",
          });
          if (ok) return connect({ ...opts, accept: { ...opts.accept, [hop.id]: fp } });
          t.write("\x1b[90mОтменено.\x1b[0m\r\n");
          return updateStatus("closed");
        }
        const text = msg === "AUTH_FAILED" ? (hop.jump ? `Сервер-посредник ${hop.label} отклонил ключ` : "Сервер отклонил ключ") : msg;
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
      refit.current();
    };

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
      if (termEl.current && termEl.current.offsetWidth > 0) refit.current();
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
      refit.current();
      // Don't steal focus from the file panel / bar of this pane when it was clicked.
      if (focused && !rootRef.current?.contains(document.activeElement)) term.current?.focus();
    });
  }, [visible, focused, showFiles, split]);

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
  }, [paneId, server.id, sendText]);

  // The server's connect script: runs once the login banner / prompt has settled.
  const onConnectedRef = useRef(() => {});
  onConnectedRef.current = () => {
    const id = server.connectScript;
    if (!id) return;
    const script = scripts.find((x) => x.id === id);
    if (!script) return ui.toast(`Скрипт при подключении к «${server.name}» не найден — выберите другой в настройках сервера`, "error");
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
      {steps && (
        <div className="step-bar">
          <IStep size={13} />
          <span className="step-name">
            {steps.name}: шаг {steps.next + 1} из {steps.list.length}
          </span>
          <code className="step-next" title={steps.list[steps.next]}>
            {steps.list[steps.next]}
          </code>
          <button className="btn btn-sm btn-primary" onClick={() => stepActions.current.next()} title="Отправить эту команду (Ctrl+Shift+Enter)">
            <IStep size={12} /> Следующая
          </button>
          <button className="btn btn-sm" onClick={() => stepActions.current.rest()} title="Отправить все оставшиеся команды одним блоком">
            <IPlay size={12} /> Все остальные
          </button>
          <button className="icon-btn" onClick={() => stepActions.current.stop()} title="Прервать пошаговый запуск">
            <IClose size={13} />
          </button>
        </div>
      )}
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
