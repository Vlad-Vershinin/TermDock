import { listen } from "@tauri-apps/api/event";
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api, errorText, Progress } from "./api";
import { baseName, formatSize } from "./paths";
import { useUi } from "./ui";
import { IClose, IDownload, IUpload } from "../components/Icons";

export interface Transfer {
  id: string;
  direction: "up" | "down";
  label: string;
  server: string;
  dest: string;
  progress: Progress;
  startedAt: number;
}

interface Ctx {
  transfers: Transfer[];
  start: (args: { direction: "up" | "down"; sessionId: string; server: string; sources: string[]; dest: string }) => Promise<boolean>;
  cancel: (id: string) => void;
  clearFinished: () => void;
}

const TransfersContext = createContext<Ctx>(null!);
export const useTransfers = () => useContext(TransfersContext);

export function TransfersProvider({ children }: { children: ReactNode }) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const { toast } = useUi();

  useEffect(() => {
    const un = listen<Progress>("transfer-progress", (e) => {
      setTransfers((list) => list.map((t) => (t.id === e.payload.id ? { ...t, progress: e.payload } : t)));
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const start: Ctx["start"] = useCallback(
    async ({ direction, sessionId, server, sources, dest }) => {
      const id = crypto.randomUUID();
      const label = sources.length === 1 ? baseName(sources[0]) : `${sources.length} объектов`;
      const progress: Progress = { id, transferred: 0, total: 0, filesDone: 0, filesTotal: 0, current: "", status: "running" };
      setTransfers((l) => [{ id, direction, label, server, dest, progress, startedAt: Date.now() }, ...l]);
      try {
        if (direction === "up") await api.upload(sessionId, id, sources, dest);
        else await api.download(sessionId, id, sources, dest);
        toast(`${direction === "up" ? "Загружено" : "Скачано"}: ${label}`, "success");
        return true;
      } catch (e) {
        const msg = errorText(e);
        // The backend also emits a final progress event; this covers errors before the first one.
        setTransfers((l) =>
          l.map((t) =>
            t.id === id && t.progress.status === "running"
              ? { ...t, progress: { ...t.progress, status: msg === "CANCELLED" ? "cancelled" : "error", error: msg } }
              : t,
          ),
        );
        if (msg !== "CANCELLED") toast(`Ошибка передачи ${label}: ${msg}`, "error");
        return false;
      }
    },
    [toast],
  );

  const cancel = useCallback((id: string) => {
    api.cancelTransfer(id);
  }, []);

  const clearFinished = useCallback(() => setTransfers((l) => l.filter((t) => t.progress.status === "running")), []);

  return <TransfersContext.Provider value={{ transfers, start, cancel, clearFinished }}>{children}</TransfersContext.Provider>;
}

export function TransfersPanel({ onClose }: { onClose: () => void }) {
  const { transfers, cancel, clearFinished } = useTransfers();
  return (
    <div className="transfers-panel">
      <div className="transfers-head">
        <strong>Передачи</strong>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={clearFinished}>
          Очистить
        </button>
        <button className="icon-btn" onClick={onClose} title="Закрыть">
          <IClose size={13} />
        </button>
      </div>
      {transfers.length === 0 && <div className="empty-small">Пока ничего не передавалось</div>}
      <div className="transfers-list">
        {transfers.map((t) => {
          const p = t.progress;
          const pct = p.total > 0 ? Math.min(100, (p.transferred / p.total) * 100) : p.status === "done" ? 100 : 0;
          const secs = (Date.now() - t.startedAt) / 1000;
          const speed = secs > 0.5 ? p.transferred / secs : 0;
          return (
            <div key={t.id} className={`transfer transfer-${p.status}`}>
              <div className="transfer-row">
                <span className="transfer-dir">{t.direction === "up" ? <IUpload /> : <IDownload />}</span>
                <span className="transfer-label" title={t.label}>
                  {t.label}
                </span>
                {p.status === "running" && (
                  <button className="icon-btn" title="Отменить" onClick={() => cancel(t.id)}>
                    <IClose size={13} />
                  </button>
                )}
              </div>
              <div className="progress">
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="transfer-meta">
                {p.status === "running" && (
                  <>
                    {formatSize(p.transferred)} / {formatSize(p.total)} · {p.filesDone}/{p.filesTotal} файл. ·{" "}
                    {formatSize(speed)}/с
                  </>
                )}
                {p.status === "done" && <>Готово · {formatSize(p.total)} · {t.server}</>}
                {p.status === "cancelled" && <>Отменено</>}
                {p.status === "error" && <span className="err">{p.error}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
