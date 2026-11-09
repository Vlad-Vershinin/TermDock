import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, errorText, Forward, ForwardKind, ForwardStatus } from "../lib/api";
import { useUi } from "../lib/ui";
import { IClose, ICopy, ILink, IPlay, IPlus } from "./Icons";
import { Key, T, t as trNow, useT } from "../lib/i18n";

export const KIND_LABELS: Record<ForwardKind, Key> = { local: "ports.kind.local", remote: "ports.kind.remote", dynamic: "ports.kind.dynamic" };

export const KIND_HINTS: Record<ForwardKind, Key> = {
  local: "ports.hint.local",
  remote: "ports.hint.remote",
  dynamic: "ports.hint.dynamic",
};

export const newForward = (): Forward => ({ id: crypto.randomUUID(), kind: "local", bindHost: "127.0.0.1", bindPort: 8080, destHost: "127.0.0.1", destPort: 80, enabled: true });

const hostPort = (h: string, p: number | string) => `${h.includes(":") ? `[${h}]` : h}:${p}`;
const shownHost = (h: string) => (h === "127.0.0.1" || h === "::1" || h === "" ? "localhost" : h);

/** "localhost:8080 → db:5432" */
export function forwardText(f: Forward, boundPort?: number | null) {
  const bind = hostPort(shownHost(f.bindHost), boundPort ?? f.bindPort);
  if (f.kind === "dynamic") return `SOCKS ${bind}`;
  const dest = hostPort(f.destHost, f.destPort);
  return f.kind === "local" ? `${bind} → ${dest}` : `${trNow("ports.serverSide")} ${bind} → ${dest}`;
}

/** Fields of one forward (used in the server dialog and in the session's "add" form). */
export function ForwardFields({ f, onChange }: { f: Forward; onChange: (f: Forward) => void }) {
  const tr = useT();
  const set = <K extends keyof Forward>(k: K, v: Forward[K]) => onChange({ ...f, [k]: v });
  return (
    <div className="fw-fields">
      <label className="field">
        <span>{tr("ports.type")}</span>
        <select value={f.kind} onChange={(e) => set("kind", e.target.value as ForwardKind)}>
          {(Object.keys(KIND_LABELS) as ForwardKind[]).map((k) => (
            <option key={k} value={k}>
              {tr(KIND_LABELS[k])}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{f.kind === "remote" ? tr("ports.bindOnServer") : tr("ports.bindOnComputer")}</span>
        <input value={f.bindHost} onChange={(e) => set("bindHost", e.target.value)} placeholder="127.0.0.1" spellCheck={false} />
      </label>
      <label className="field">
        <span>{tr("common.port")}</span>
        <input type="number" min={0} max={65535} value={f.bindPort} onChange={(e) => set("bindPort", Number(e.target.value))} />
      </label>
      {f.kind !== "dynamic" ? (
        <>
          <label className="field">
            <span>{f.kind === "local" ? tr("ports.destServer") : tr("ports.destComputer")}</span>
            <input value={f.destHost} onChange={(e) => set("destHost", e.target.value)} placeholder="127.0.0.1" spellCheck={false} />
          </label>
          <label className="field">
            <span>{tr("common.port")}</span>
            <input type="number" min={1} max={65535} value={f.destPort} onChange={(e) => set("destPort", Number(e.target.value))} />
          </label>
        </>
      ) : (
        <span className="fw-span hint">{tr("ports.socksHint")}</span>
      )}
    </div>
  );
}

const statusText = (tr: T, s: ForwardStatus) =>
  s.status === "active"
    ? s.connections
      ? `${tr("ports.active")} · ${tr("ports.connections", { n: s.connections })}`
      : tr("ports.active")
    : s.status === "stopped"
      ? tr("ports.stopped")
      : s.status === "starting"
        ? tr("ports.starting")
        : s.status.replace(/^error: /, "");

/** "Ports" button in the session bar: status of the forwards and runtime start / stop / add. */
export function Ports({ sessionId, visible }: { sessionId: string | null; visible: boolean }) {
  const ui = useUi();
  const tr = useT();
  const [list, setList] = useState<ForwardStatus[]>([]);
  const [open, setOpen] = useState<{ top: number; right: number } | null>(null);
  const [draft, setDraft] = useState<Forward | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = () => {
    if (sessionId) api.forwards(sessionId).then(setList, () => {});
  };

  useEffect(() => {
    setList([]);
    if (!sessionId || !visible) return;
    refresh();
    // Faster while the popover is open (connection counts), slow otherwise (errors in the badge).
    const timer = window.setInterval(refresh, open ? 1500 : 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, visible, !!open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && (setOpen(null), setDraft(null));
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [open]);

  if (!sessionId) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      ui.toast(errorText(e), "error");
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const toggle = (s: ForwardStatus) => {
    const { temporary: _t, status: _s, boundPort: _b, connections: _c, ...spec } = s;
    return act(() => (s.status === "active" ? api.forwardStop(sessionId, s.id) : api.forwardStart(sessionId, spec)));
  };

  const add = () =>
    draft &&
    act(async () => {
      // A new id makes it a session-only forward.
      const st = await api.forwardStart(sessionId, { ...draft, id: "" });
      if (st.status.startsWith("error: ")) ui.toast(st.status.replace(/^error: /, ""), "error");
      else setDraft(null);
    });

  const active = list.filter((s) => s.status === "active").length;
  const failed = list.some((s) => s.status.startsWith("error: "));

  return (
    <div className="telemetry-wrap" ref={ref}>
      <button
        className={`btn btn-sm ${open ? "on" : ""} ${failed ? "fw-failed" : ""}`}
        title={failed ? tr("ports.titleErrors") : tr("ports.title")}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
          setDraft(null);
        }}
      >
        <ILink size={13} /> <span className="btn-label">{tr("ports.button")}</span>
        {list.length > 0 && <span className="fw-count">{active}</span>}
      </button>
      {open && (
        <div className="telemetry-pop fw-pop" style={open}>
          <div className="tp-head">
            <b>{tr("ports.title")}</b>
            <span className="muted">{tr("ports.sessionNote")}</span>
          </div>
          {list.length === 0 && !draft && <p className="muted">{tr("ports.empty")}</p>}
          {list.map((s) => {
            const addr = s.kind !== "remote" && s.boundPort ? hostPort(shownHost(s.bindHost), s.boundPort) : null;
            return (
              <div key={s.id} className="fw-row">
                <span className={`status-dot ${s.status === "active" ? "connected" : s.status.startsWith("error") ? "error" : "closed"}`} />
                <div className="fw-main">
                  <div className="fw-addr" title={tr(KIND_HINTS[s.kind])}>
                    {forwardText(s, s.boundPort)}
                    {s.temporary && <span className="muted"> · {tr("ports.temporary")}</span>}
                  </div>
                  <div className={`fw-status ${s.status.startsWith("error") ? "err" : "muted"}`}>
                    {tr(KIND_LABELS[s.kind])} · {statusText(tr, s)}
                  </div>
                </div>
                {addr && (
                  <button className="icon-btn" title={tr("ports.copyAddr", { addr })} onClick={() => writeText(addr).then(() => ui.toast(tr("ports.copied", { addr })))}>
                    <ICopy size={13} />
                  </button>
                )}
                <button className="btn btn-sm" disabled={busy} onClick={() => toggle(s)} title={s.status === "active" ? tr("ports.stopHint") : tr("ports.startHint")}>
                  {s.status === "active" ? tr("ports.stop") : <><IPlay size={11} /> {tr("ports.start")}</>}
                </button>
                {s.temporary && (
                  <button className="icon-btn" disabled={busy} title={tr("ports.remove")} onClick={() => act(() => api.forwardStop(sessionId, s.id, true))}>
                    <IClose size={13} />
                  </button>
                )}
              </div>
            );
          })}
          {draft ? (
            <div className="fw-add">
              <ForwardFields f={draft} onChange={setDraft} />
              <p className="hint">{tr(KIND_HINTS[draft.kind])}</p>
              <div className="row fw-actions">
                <button className="btn btn-sm" onClick={() => setDraft(null)}>
                  {tr("common.cancel")}
                </button>
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={add}>
                  {tr("ports.startHint")}
                </button>
              </div>
            </div>
          ) : (
            <button className="link-btn fw-add-btn" onClick={() => setDraft(newForward())}>
              <IPlus size={12} /> {tr("ports.add")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
