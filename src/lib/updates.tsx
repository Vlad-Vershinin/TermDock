import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, errorText, UpdateInfo } from "./api";
import { Key, t, useT } from "./i18n";
import { openUrl } from "./open";
import { paneRegistry } from "./sessions";
import { useSettings } from "./settings";
import { useUi } from "./ui";

const FIRST_CHECK_MS = 5_000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const SKIP_KEY = "td.update.skip";

interface Ctx {
  /** The last successful check (null before one finished). */
  info: UpdateInfo | null;
  /** A newer version that the user hasn't chosen to skip. */
  pending: UpdateInfo | null;
  checking: boolean;
  /** Manual check: reports "up to date" and errors, and opens the dialog when there is an update. */
  checkNow: () => Promise<void>;
  showDialog: () => void;
}

const UpdatesContext = createContext<Ctx>(null!);
export const useUpdates = () => useContext(UpdatesContext);

const readSkip = () => {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
};

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const ui = useUi();
  const { settings } = useSettings();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);
  const [skipped, setSkipped] = useState(readSkip);
  // useUi() is a new object on every render: read it through a ref in long-lived callbacks.
  const uiRef = useRef(ui);
  uiRef.current = ui;
  /** Versions already announced with a toast in this run. */
  const announced = useRef(new Set<string>());

  const check = useCallback(async (manual: boolean) => {
    setChecking(true);
    try {
      const i = await api.updateCheck();
      setInfo(i);
      if (!i.available) {
        if (manual) uiRef.current.toast(t("update.upToDate", { version: i.current }), "success");
        return;
      }
      if (manual) setOpen(true);
      else if (readSkip() !== i.latest && !announced.current.has(i.latest)) {
        announced.current.add(i.latest);
        uiRef.current.toast(t("update.found", { version: i.latest }));
      }
    } catch (e) {
      // Background checks stay quiet: no network is a normal state for an SSH client.
      if (manual) uiRef.current.toast(errorText(e), "error");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!settings.checkUpdates) return;
    const first = window.setTimeout(() => check(false), FIRST_CHECK_MS);
    const every = window.setInterval(() => check(false), CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [settings.checkUpdates, check]);

  const skip = (version: string) => {
    try {
      localStorage.setItem(SKIP_KEY, version);
    } catch {
      /* the button simply comes back next run */
    }
    setSkipped(version);
    setOpen(false);
  };

  const pending = info?.available && info.latest !== skipped ? info : null;
  const value: Ctx = { info, pending, checking, checkNow: () => check(true), showDialog: () => setOpen(true) };

  return (
    <UpdatesContext.Provider value={value}>
      {children}
      {open && info?.available ? <UpdateDialog info={info} onClose={() => setOpen(false)} onSkip={() => skip(info.latest)} /> : null}
    </UpdatesContext.Provider>
  );
}

const HOW: Record<UpdateInfo["method"], Key> = {
  nsis: "update.how.installer",
  msi: "update.how.installer",
  appimage: "update.how.appimage",
  deb: "update.how.package",
  rpm: "update.how.package",
  pacman: "update.how.package",
  manual: "update.how.manual",
};

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

type State = { kind: "idle" } | { kind: "download"; received: number; total: number } | { kind: "install" } | { kind: "error"; text: string };

function UpdateDialog({ info, onClose, onSkip }: { info: UpdateInfo; onClose: () => void; onSkip: () => void }) {
  const tr = useT();
  const [state, setState] = useState<State>({ kind: "idle" });
  const busy = state.kind === "download" || state.kind === "install";
  const sessions = paneRegistry.all().filter(([, p]) => p.status() === "connected").length;

  const install = async () => {
    setState({ kind: "download", received: 0, total: info.size ?? 0 });
    try {
      await api.updateInstall((p) => setState(p.phase === "download" ? { kind: "download", received: p.received, total: p.total } : { kind: "install" }));
      // On success the app exits; staying here means the installer took over.
    } catch (e) {
      const text = errorText(e);
      setState(text === "CANCELLED" ? { kind: "idle" } : { kind: "error", text });
    }
  };

  const close = () => !busy && onClose();

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal modal-wide update" tabIndex={-1} ref={(el) => void (el && !el.contains(document.activeElement) && el.focus())} onKeyDown={(e) => e.key === "Escape" && close()}>
        <h3>{tr("update.title", { version: info.latest })}</h3>
        <p className="muted">
          {tr("update.current", { version: info.current })}
          {info.publishedAt ? ` · ${tr("update.published", { date: new Date(info.publishedAt).toLocaleDateString() })}` : ""}
        </p>
        <ReleaseNotes text={info.notes} />
        <p className="hint">{tr(HOW[info.method])}</p>
        {sessions > 0 && info.method !== "manual" ? <p className="hint warn">{tr("update.sessions", { n: sessions })}</p> : null}
        {state.kind === "download" ? (
          <div>
            <div className="progress">
              <div style={{ width: `${state.total ? Math.min(100, (state.received / state.total) * 100) : 0}%` }} />
            </div>
            <span className="muted">{tr("update.downloading", { done: mb(state.received), total: mb(state.total) })}</span>
          </div>
        ) : null}
        {state.kind === "install" ? <p className="muted">{tr("update.installing")}</p> : null}
        {state.kind === "error" ? <p className="update-error">{state.text}</p> : null}
        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={onSkip} title={tr("update.skipHint")}>
            {tr("update.skip")}
          </button>
          <button className="btn" onClick={() => openUrl(info.url)}>
            {tr("update.onGithub")}
          </button>
          <div className="spacer" />
          {state.kind === "download" ? (
            <button className="btn" onClick={() => api.updateCancel()}>
              {tr("common.cancel")}
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={onClose}>
              {tr("update.later")}
            </button>
          )}
          {info.method === "manual" ? (
            <button className="btn btn-primary" onClick={() => openUrl(info.url)}>
              {tr("update.download")}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={install}>
              {tr("update.install")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Inline Markdown: **bold** and `code`. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : (
      part
    ),
  );
}

// Release notes headings (Russian or English). Cyrillic is escaped to keep it in locales/ru.ts only.
const INSTALL_RE = /^##\s+(\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430|Install)/i;
const NEW_RE = { en: /^##\s+What's new/i, ru: /^##\s+\u0427\u0442\u043e \u043d\u043e\u0432\u043e\u0433\u043e/i };

/** The "what's new" part of bilingual release notes in the UI language (English first, Russian below). */
export function notesSection(text: string, lang: "ru" | "en"): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => NEW_RE[lang].test(l));
  const isEnd = (l: string) => INSTALL_RE.test(l) || NEW_RE.en.test(l) || NEW_RE.ru.test(l) || /^(---+|<\/?details>?.*)$/.test(l.trim());
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && isEnd(l));
    return lines.slice(start, end < 0 ? undefined : end);
  }
  const end = lines.findIndex((l) => INSTALL_RE.test(l));
  return end >= 0 ? lines.slice(0, end) : lines;
}

/** The release notes as simple Markdown (headings, lists, paragraphs), without the install table. */
function ReleaseNotes({ text }: { text: string }) {
  const { settings } = useSettings();
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list}</ul>);
    list = [];
  };
  for (const raw of notesSection(text, settings.language)) {
    const l = raw.trim();
    const item = /^[-*]\s+(.*)$/.exec(l);
    if (item) {
      list.push(<li key={list.length}>{inline(item[1])}</li>);
      continue;
    }
    flush();
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) blocks.push(h[1].length <= 2 ? <h4 key={blocks.length}>{inline(h[2])}</h4> : <h5 key={blocks.length}>{inline(h[2])}</h5>);
    else if (l && !l.startsWith("|") && !l.startsWith("<")) blocks.push(<p key={blocks.length}>{inline(l)}</p>);
  }
  flush();
  return blocks.length ? <div className="release-notes">{blocks}</div> : null;
}
