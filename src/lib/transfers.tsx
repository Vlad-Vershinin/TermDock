import { listen } from "@tauri-apps/api/event";
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorText, Progress } from "./api";
import { baseName, formatSize, joinPath } from "./paths";
import { useUi } from "./ui";
import { IClose, ICopyServer, IDownload, IUpload } from "../components/Icons";

export interface Transfer {
  id: string;
  direction: "up" | "down" | "copy";
  label: string;
  /** Server name; "src → dst" for server-to-server copies. */
  server: string;
  dest: string;
  /** Files / folders on this computer: the saved items of a download, the sources of an upload. */
  localPaths: string[];
  progress: Progress;
  startedAt: number;
}

type StartArgs =
  | { direction: "up" | "down"; sessionId: string; server: string; sources: string[]; dest: string }
  /** Server-to-server: `sessionId`/`server` are the source, `dest` is a folder on the destination. */
  | { direction: "copy"; sessionId: string; server: string; sources: string[]; dest: string; dstSessionId: string; dstServer: string };

interface Ctx {
  transfers: Transfer[];
  start: (args: StartArgs) => Promise<boolean>;
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
    async (args) => {
      const { direction, sessionId, sources, dest } = args;
      const server = args.direction === "copy" ? `${args.server} → ${args.dstServer}` : args.server;
      const id = crypto.randomUUID();
      const label = sources.length === 1 ? baseName(sources[0]) : `${sources.length} объектов`;
      const progress: Progress = { id, transferred: 0, total: 0, filesDone: 0, filesTotal: 0, current: "", status: "running" };
      // Downloads land as <dest>/<source name> (the backend overwrites, never renames).
      const localPaths = direction === "up" ? sources : direction === "down" ? sources.map((s) => joinPath(dest, baseName(s), false)) : [];
      setTransfers((l) => [{ id, direction, label, server, dest, localPaths, progress, startedAt: Date.now() }, ...l]);
      try {
        if (args.direction === "copy") await api.copyBetween(sessionId, id, sources, args.dstSessionId, dest);
        else if (direction === "up") await api.upload(sessionId, id, sources, dest);
        else await api.download(sessionId, id, sources, dest);
        const done = direction === "copy" ? `Скопировано (${server})` : direction === "up" ? "Загружено" : "Скачано";
        toast(`${done}: ${label}`, "success");
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
  const { toast } = useUi();
  const reveal = (paths: string[]) => revealItemInDir(paths.length === 1 ? paths[0] : paths).catch((e) => toast(`Не удалось открыть папку: ${errorText(e)}`, "error"));
  const open = (path: string) => api.openLocalPath(path).catch((e) => toast(errorText(e), "error"));
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
                <span className="transfer-dir">{t.direction === "up" ? <IUpload /> : t.direction === "down" ? <IDownload /> : <ICopyServer />}</span>
                <span className="transfer-label" title={t.direction === "copy" ? `${t.label}: ${t.server}` : t.label}>
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
                    {t.direction === "copy" && <>{t.server} · </>}
                    {formatSize(p.transferred)} / {formatSize(p.total)} · {p.filesDone}/{p.filesTotal} файл. ·{" "}
                    {formatSize(speed)}/с
                  </>
                )}
                {p.status === "done" && <>Готово · {formatSize(p.total)} · {t.server}</>}
                {p.status === "cancelled" && <>Отменено</>}
                {p.status === "error" && <span className="err">{p.error}</span>}
              </div>
              {p.status === "done" && t.localPaths.length > 0 && (
                <div className="transfer-actions">
                  <button className="link-btn" onClick={() => reveal(t.localPaths)} title={t.localPaths.join("\n")}>
                    Показать в папке
                  </button>
                  {t.localPaths.length === 1 && (
                    <button className="link-btn" onClick={() => open(t.localPaths[0])} title={t.localPaths[0]}>
                      Открыть
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
