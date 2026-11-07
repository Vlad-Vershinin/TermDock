import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, Entry, errorText, Server } from "../lib/api";
import { beginDrag, DropDetail } from "../lib/dnd";
import { baseName, formatDate, formatMode, formatSize, joinPath, parentPath } from "../lib/paths";
import { useTransfers } from "../lib/transfers";
import { useUi } from "../lib/ui";
import { IArchive, IDownload, IEdit, IEye, IFile, IFileCode, IFolder, IFolderPlus, IImage, IMonitor, IRefresh, IServer, ITrash, IUp, IUpload } from "./Icons";

type Side = "local" | "remote";

interface Adapter {
  list: (p: string) => Promise<Entry[]>;
  mkdir: (p: string) => Promise<void>;
  remove: (p: string) => Promise<void>;
  rename: (a: string, b: string) => Promise<void>;
}

function usePane(adapter: Adapter | null, side: Side) {
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem(`td.hidden.${side}`) === "1");
  const reqId = useRef(0);

  const load = useCallback(
    async (path: string, keepSelection = false): Promise<boolean> => {
      if (!adapter) return false;
      const my = ++reqId.current;
      setLoading(true);
      try {
        const list = await adapter.list(path);
        if (my !== reqId.current) return false;
        setEntries(list);
        setDir(path);
        setError(null);
        if (!keepSelection) setSelected(new Set());
        if (side === "local") localStorage.setItem("td.localDir", path);
        return true;
      } catch (e) {
        if (my === reqId.current) setError(errorText(e));
        return false;
      } finally {
        if (my === reqId.current) setLoading(false);
      }
    },
    [adapter, side],
  );

  const refresh = useCallback(() => {
    if (dir !== null) load(dir, true);
  }, [dir, load]);

  const visible = useMemo(() => (showHidden ? entries : entries.filter((e) => !e.name.startsWith("."))), [entries, showHidden]);

  return {
    side,
    adapter,
    dir,
    entries: visible,
    loading,
    error,
    selected,
    setSelected,
    load,
    refresh,
    showHidden,
    toggleHidden: () => {
      localStorage.setItem(`td.hidden.${side}`, showHidden ? "0" : "1");
      setShowHidden(!showHidden);
    },
  };
}

type Pane = ReturnType<typeof usePane>;

interface PanelProps {
  tabId: string;
  server: Server;
  sessionId: string | null;
  onRemoteDir: (dir: string | null) => void;
}

export function FilePanel({ tabId, server, sessionId, onRemoteDir }: PanelProps) {
  const ui = useUi();
  const transfers = useTransfers();

  const localAdapter = useMemo<Adapter>(
    () => ({ list: api.localList, mkdir: api.localMkdir, remove: api.localRemove, rename: api.localRename }),
    [],
  );
  const remoteAdapter = useMemo<Adapter | null>(
    () =>
      sessionId
        ? {
            list: (p) => api.remoteList(sessionId, p),
            mkdir: (p) => api.remoteMkdir(sessionId, p),
            remove: (p) => api.remoteRemove(sessionId, p),
            rename: (a, b) => api.remoteRename(sessionId, a, b),
          }
        : null,
    [sessionId],
  );

  const local = usePane(localAdapter, "local");
  const remote = usePane(remoteAdapter, "remote");

  // Initial directories.
  useEffect(() => {
    (async () => {
      const saved = localStorage.getItem("td.localDir");
      const home = await api.localHome();
      if (!(await local.load(saved ?? home)) && saved !== null) local.load(home);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sessionId || !remoteAdapter) return;
    (async () => {
      try {
        const start = server.remoteDir?.trim() || (await api.remoteHome(sessionId));
        await remote.load(start);
      } catch (e) {
        ui.toast(`SFTP: ${errorText(e)}`, "error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, remoteAdapter]);

  useEffect(() => onRemoteDir(remote.dir), [remote.dir, onRemoteDir]);

  const upload = async (paths: string[], dir?: string) => {
    const dest = dir ?? remote.dir;
    if (!sessionId || !dest || paths.length === 0) return;
    await transfers.start({ direction: "up", sessionId, server: server.name, sources: paths, dest });
    remote.refresh();
  };

  const download = async (paths: string[], dir?: string) => {
    const dest = dir ?? local.dir;
    if (!sessionId || dest === null || paths.length === 0) return;
    if (dest === "") return ui.toast("Выберите папку на диске", "error");
    await transfers.start({ direction: "down", sessionId, server: server.name, sources: paths, dest });
    local.refresh();
  };

  const move = async (pane: Pane, paths: string[], dir: string) => {
    const remoteSide = pane.side === "remote";
    try {
      for (const p of paths) {
        if (p === dir || parentPath(p, remoteSide) === dir) continue;
        await pane.adapter!.rename(p, joinPath(dir, baseName(p), remoteSide));
      }
    } catch (e) {
      ui.toast(`Не удалось переместить: ${errorText(e)}`, "error");
    }
    pane.refresh();
  };

  const onDrop = (pane: Pane, d: DropDetail) => {
    const { source } = d;
    if (pane.side === "remote") {
      if (source.kind === "local" || source.kind === "os") upload(source.paths, d.dir);
      else if (source.kind === "remote" && source.tabId === tabId && d.dir) move(pane, source.paths, d.dir);
      else if (source.kind === "remote") ui.toast("Перенос между разными серверами пока не поддерживается", "error");
    } else {
      if (source.kind === "remote") {
        if (source.tabId !== tabId) return ui.toast("Перетащите файлы в панель ПК этой же вкладки", "error");
        download(source.paths, d.dir);
      } else if (source.kind === "local" && d.dir) move(pane, source.paths, d.dir);
    }
  };

  const selectedPaths = (p: Pane) => p.entries.filter((e) => p.selected.has(e.path)).map((e) => e.path);

  const pickAndUpload = async () => {
    const files = await openDialog({ multiple: true, title: "Выберите файлы для загрузки" });
    if (files) upload(Array.isArray(files) ? files : [files]);
  };

  return (
    <div className="file-panel">
      <FilePane
        pane={local}
        tabId={tabId}
        title="Этот компьютер"
        accept="remote,local"
        onDrop={(d) => onDrop(local, d)}
        onOpenFile={(e) => upload([e.path])}
        extra={
          <button className="btn btn-sm" disabled={!sessionId || local.selected.size === 0} onClick={() => upload(selectedPaths(local))} title="Загрузить выбранное на сервер">
            <IUpload size={13} /> Загрузить
          </button>
        }
      />
      <FilePane
        pane={remote}
        tabId={tabId}
        title={`${server.username}@${server.host}`}
        accept="local,os,remote"
        disabledText={sessionId ? undefined : "Нет подключения"}
        onDrop={(d) => onDrop(remote, d)}
        onOpenFile={(e) => download([e.path])}
        extra={
          <>
            <button className="btn btn-sm" disabled={remote.selected.size === 0} onClick={() => download(selectedPaths(remote))} title="Скачать выбранное на компьютер">
              <IDownload size={13} /> Скачать
            </button>
            <button className="btn btn-sm" disabled={!sessionId} onClick={pickAndUpload} title="Выбрать файлы на диске и загрузить сюда">
              Файлы…
            </button>
          </>
        }
      />
    </div>
  );
}

interface PaneProps {
  pane: Pane;
  tabId: string;
  title: string;
  accept: string;
  disabledText?: string;
  extra?: React.ReactNode;
  onDrop: (d: DropDetail) => void;
  onOpenFile: (e: Entry) => void;
}

function FilePane({ pane, tabId, title, accept, disabledText, extra, onDrop, onOpenFile }: PaneProps) {
  const ui = useUi();
  const zoneRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const remote = pane.side === "remote";
  const zoneId = `${tabId}:${pane.side}`;

  useEffect(() => setPathInput(pane.dir ?? ""), [pane.dir]);

  // Latest handler without re-binding the DOM listener.
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  useEffect(() => {
    const el = zoneRef.current!;
    const h = (e: Event) => dropRef.current((e as CustomEvent<DropDetail>).detail);
    el.addEventListener("td-drop", h);
    return () => el.removeEventListener("td-drop", h);
  }, []);

  const select = (e: React.MouseEvent, entry: Entry) => {
    const next = new Set(e.ctrlKey || e.metaKey ? pane.selected : []);
    if (e.shiftKey && anchor.current) {
      const ids = pane.entries.map((x) => x.path);
      const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(entry.path)].sort((x, y) => x - y);
      ids.slice(a, b + 1).forEach((id) => next.add(id));
    } else if ((e.ctrlKey || e.metaKey) && pane.selected.has(entry.path)) {
      next.delete(entry.path);
      anchor.current = entry.path;
    } else {
      next.add(entry.path);
      anchor.current = entry.path;
    }
    pane.setSelected(next);
  };

  const openEntry = (entry: Entry) => (entry.isDir ? pane.load(entry.path) : onOpenFile(entry));

  const goUp = () => pane.dir !== null && pane.load(parentPath(pane.dir, remote));

  const mkdir = async () => {
    if (pane.dir === null) return;
    const name = await ui.prompt("Новая папка", "Имя папки");
    if (!name) return;
    try {
      await pane.adapter!.mkdir(joinPath(pane.dir, name, remote));
      pane.refresh();
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  const rename = async () => {
    const [path] = [...pane.selected];
    if (!path || pane.dir === null) return;
    const name = await ui.prompt("Переименовать", "Новое имя", baseName(path));
    if (!name || name === baseName(path)) return;
    try {
      await pane.adapter!.rename(path, joinPath(parentPath(path, remote), name, remote));
      pane.refresh();
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  const remove = async () => {
    const paths = [...pane.selected];
    if (paths.length === 0) return;
    const what = paths.length === 1 ? `«${baseName(paths[0])}»` : `${paths.length} объектов`;
    if (!(await ui.confirm("Удалить?", `${what} будет удалено ${remote ? "на сервере" : "с диска"} без возможности восстановления.`, true))) return;
    try {
      for (const p of paths) await pane.adapter!.remove(p);
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
    pane.refresh();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const sel = pane.entries.filter((x) => pane.selected.has(x.path));
    if (e.key === "Enter" && sel.length === 1) openEntry(sel[0]);
    else if (e.key === "Backspace") goUp();
    else if (e.key === "Delete") remove();
    else if (e.key === "F2") rename();
    else if (e.key === "F5") pane.refresh();
    else if (e.key === "a" && (e.ctrlKey || e.metaKey)) pane.setSelected(new Set(pane.entries.map((x) => x.path)));
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const ids = pane.entries.map((x) => x.path);
      const cur = anchor.current ? ids.indexOf(anchor.current) : -1;
      const next = ids[Math.max(0, Math.min(ids.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        anchor.current = next;
        pane.setSelected(new Set([next]));
        document.getElementById(`row-${zoneId}-${next}`)?.scrollIntoView({ block: "nearest" });
      }
    } else return;
    e.preventDefault();
  };

  return (
    <div className="pane" ref={zoneRef} data-dropzone={zoneId} data-accept={accept} tabIndex={0} onKeyDown={onKey}>
      <div className="pane-head">
        <span className={`pane-title ${remote ? "remote" : ""}`}>{remote ? <IServer /> : <IMonitor />} {title}</span>
        <div className="spacer" />
        {extra}
      </div>
      <div className="pane-toolbar">
        <button className="icon-btn" title="Вверх (Backspace)" onClick={goUp} disabled={pane.dir === null}>
          <IUp />
        </button>
        <button className="icon-btn" title="Обновить (F5)" onClick={() => pane.refresh()} disabled={pane.dir === null}>
          <IRefresh />
        </button>
        <form
          className="path-form"
          onSubmit={(e) => {
            e.preventDefault();
            pane.load(pathInput.trim());
          }}
        >
          <input className="path-input" value={pathInput} onChange={(e) => setPathInput(e.target.value)} spellCheck={false} placeholder={remote ? "/" : "Диски"} />
        </form>
        <button className="icon-btn" title="Новая папка" onClick={mkdir} disabled={pane.dir === null}>
          <IFolderPlus />
        </button>
        <button className="icon-btn" title="Переименовать (F2)" onClick={rename} disabled={pane.selected.size !== 1}>
          <IEdit />
        </button>
        <button className="icon-btn danger" title="Удалить (Delete)" onClick={remove} disabled={pane.selected.size === 0}>
          <ITrash />
        </button>
        <button className={`icon-btn ${pane.showHidden ? "on" : ""}`} title="Показывать скрытые файлы" onClick={pane.toggleHidden}>
          <IEye />
        </button>
      </div>
      <div className="pane-body" onMouseDown={(e) => e.target === e.currentTarget && pane.setSelected(new Set())}>
        {disabledText ? (
          <div className="pane-empty">{disabledText}</div>
        ) : pane.error ? (
          <div className="pane-empty err">{pane.error}</div>
        ) : (
          <table className="files">
            <thead>
              <tr>
                <th>Имя</th>
                <th className="num">Размер</th>
                <th>Изменён</th>
                {remote && <th>Права</th>}
              </tr>
            </thead>
            <tbody>
              {pane.entries.map((e) => (
                <tr
                  key={e.path}
                  id={`row-${zoneId}-${e.path}`}
                  className={pane.selected.has(e.path) ? "selected" : ""}
                  data-dropdir={e.isDir ? e.path : undefined}
                  onMouseDown={(ev) => {
                    if (ev.button !== 0) return;
                    // Keep a multi-selection when starting a drag from one of its items.
                    if (!pane.selected.has(e.path) || ev.ctrlKey || ev.shiftKey) select(ev, e);
                  }}
                  onClick={(ev) => pane.selected.has(e.path) && pane.selected.size > 1 && !ev.ctrlKey && !ev.shiftKey && select(ev, e)}
                  onDoubleClick={() => openEntry(e)}
                  onPointerDown={(ev) => {
                    const paths = pane.selected.has(e.path) ? [...pane.selected] : [e.path];
                    beginDrag(ev, () => ({ kind: pane.side, tabId, paths }), paths.length > 1 ? `${paths.length} объектов` : e.name);
                  }}
                >
                  <td className="name">
                    <span className="ficon">{e.isDir ? <IFolder className="dir" /> : fileIcon(e.name)}</span>
                    <span className={e.isLink ? "link" : ""}>{e.name}</span>
                  </td>
                  <td className="num">{e.isDir ? "" : formatSize(e.size)}</td>
                  <td className="date">{formatDate(e.modified)}</td>
                  {remote && <td className="mode">{formatMode(e.mode)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!disabledText && !pane.error && pane.entries.length === 0 && !pane.loading && <div className="pane-empty">Папка пуста</div>}
        {pane.loading && <div className="pane-loading" />}
      </div>
      <div className="drop-overlay">{remote ? "Отпустите, чтобы загрузить на сервер" : "Отпустите, чтобы скачать сюда"}</div>
    </div>
  );
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return <IImage />;
  if (["zip", "gz", "tgz", "xz", "bz2", "7z", "rar", "tar", "zst", "deb", "rpm"].includes(ext)) return <IArchive />;
  if (["sh", "py", "js", "ts", "rs", "go", "php", "rb", "conf", "yml", "yaml", "json", "toml", "ini", "env", "sql"].includes(ext)) return <IFileCode />;
  return <IFile />;
}
