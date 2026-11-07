import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, errorText, Forward, ForwardKind, ForwardStatus } from "../lib/api";
import { useUi } from "../lib/ui";
import { IClose, ICopy, ILink, IPlay, IPlus } from "./Icons";

export const KIND_LABELS: Record<ForwardKind, string> = { local: "Локальный", remote: "Удалённый", dynamic: "SOCKS-прокси" };

export const KIND_HINTS: Record<ForwardKind, string> = {
  local: "Локальный (-L): порт на вашем компьютере → адрес на стороне сервера. Например, база данных, доступная только с сервера.",
  remote: "Удалённый (-R): порт на сервере → адрес на вашем компьютере. Например, показать серверу локальный веб-сервер.",
  dynamic: "SOCKS-прокси (-D): порт на компьютере, через который можно пустить браузер — сайты откроются так, как их видит сервер.",
};

export const newForward = (): Forward => ({ id: crypto.randomUUID(), kind: "local", bindHost: "127.0.0.1", bindPort: 8080, destHost: "127.0.0.1", destPort: 80, enabled: true });

const hostPort = (h: string, p: number | string) => `${h.includes(":") ? `[${h}]` : h}:${p}`;
const shownHost = (h: string) => (h === "127.0.0.1" || h === "::1" || h === "" ? "localhost" : h);

/** "localhost:8080 → db:5432" */
export function forwardText(f: Forward, boundPort?: number | null) {
  const bind = hostPort(shownHost(f.bindHost), boundPort ?? f.bindPort);
  if (f.kind === "dynamic") return `SOCKS ${bind}`;
  const dest = hostPort(f.destHost, f.destPort);
  return f.kind === "local" ? `${bind} → ${dest}` : `сервер ${bind} → ${dest}`;
}

/** Fields of one forward (used in the server dialog and in the session's "add" form). */
export function ForwardFields({ f, onChange }: { f: Forward; onChange: (f: Forward) => void }) {
  const set = <K extends keyof Forward>(k: K, v: Forward[K]) => onChange({ ...f, [k]: v });
  const side = f.kind === "remote" ? "сервере" : "компьютере";
  return (
    <div className="fw-fields">
      <label className="field">
        <span>Тип</span>
        <select value={f.kind} onChange={(e) => set("kind", e.target.value as ForwardKind)}>
          {(Object.keys(KIND_LABELS) as ForwardKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Адрес на {side}</span>
        <input value={f.bindHost} onChange={(e) => set("bindHost", e.target.value)} placeholder="127.0.0.1" spellCheck={false} />
      </label>
      <label className="field">
        <span>Порт</span>
        <input type="number" min={0} max={65535} value={f.bindPort} onChange={(e) => set("bindPort", Number(e.target.value))} />
      </label>
      {f.kind !== "dynamic" ? (
        <>
          <label className="field">
            <span>{f.kind === "local" ? "Куда (со стороны сервера)" : "Куда (на компьютере)"}</span>
            <input value={f.destHost} onChange={(e) => set("destHost", e.target.value)} placeholder="127.0.0.1" spellCheck={false} />
          </label>
          <label className="field">
            <span>Порт</span>
            <input type="number" min={1} max={65535} value={f.destPort} onChange={(e) => set("destPort", Number(e.target.value))} />
          </label>
        </>
      ) : (
        <span className="fw-span hint">Адрес назначения выбирает программа, которая подключается к прокси.</span>
      )}
    </div>
  );
}

const statusText = (s: ForwardStatus) =>
  s.status === "active" ? (s.connections ? `работает · соединений: ${s.connections}` : "работает") : s.status === "stopped" ? "выключен" : s.status === "starting" ? "запуск…" : s.status.replace(/^error: /, "");

/** "Порты" button in the session bar: status of the forwards and runtime start / stop / add. */
export function Ports({ sessionId, visible }: { sessionId: string | null; visible: boolean }) {
  const ui = useUi();
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
        title={failed ? "Проброс портов — есть ошибки" : "Проброс портов"}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
          setDraft(null);
        }}
      >
        <ILink size={13} /> <span className="btn-label">Порты</span>
        {list.length > 0 && <span className="fw-count">{active}</span>}
      </button>
      {open && (
        <div className="telemetry-pop fw-pop" style={open}>
          <div className="tp-head">
            <b>Проброс портов</b>
            <span className="muted">Работает, пока открыта эта сессия.</span>
          </div>
          {list.length === 0 && !draft && <p className="muted">Пробросов нет. Постоянные пробросы настраиваются в свойствах сервера.</p>}
          {list.map((s) => {
            const addr = s.kind !== "remote" && s.boundPort ? hostPort(shownHost(s.bindHost), s.boundPort) : null;
            return (
              <div key={s.id} className="fw-row">
                <span className={`status-dot ${s.status === "active" ? "connected" : s.status.startsWith("error") ? "error" : "closed"}`} />
                <div className="fw-main">
                  <div className="fw-addr" title={KIND_HINTS[s.kind]}>
                    {forwardText(s, s.boundPort)}
                    {s.temporary && <span className="muted"> · только сейчас</span>}
                  </div>
                  <div className={`fw-status ${s.status.startsWith("error") ? "err" : "muted"}`}>
                    {KIND_LABELS[s.kind]} · {statusText(s)}
                  </div>
                </div>
                {addr && (
                  <button className="icon-btn" title={`Скопировать адрес ${addr}`} onClick={() => writeText(addr).then(() => ui.toast(`Скопировано: ${addr}`))}>
                    <ICopy size={13} />
                  </button>
                )}
                <button className="btn btn-sm" disabled={busy} onClick={() => toggle(s)} title={s.status === "active" ? "Остановить" : "Запустить"}>
                  {s.status === "active" ? "Стоп" : <><IPlay size={11} /> Пуск</>}
                </button>
                {s.temporary && (
                  <button className="icon-btn" disabled={busy} title="Убрать" onClick={() => act(() => api.forwardStop(sessionId, s.id, true))}>
                    <IClose size={13} />
                  </button>
                )}
              </div>
            );
          })}
          {draft ? (
            <div className="fw-add">
              <ForwardFields f={draft} onChange={setDraft} />
              <p className="hint">{KIND_HINTS[draft.kind]}</p>
              <div className="row fw-actions">
                <button className="btn btn-sm" onClick={() => setDraft(null)}>
                  Отмена
                </button>
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={add}>
                  Запустить
                </button>
              </div>
            </div>
          ) : (
            <button className="link-btn fw-add-btn" onClick={() => setDraft(newForward())}>
              <IPlus size={12} /> Добавить…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
