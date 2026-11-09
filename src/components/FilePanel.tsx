import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, Entry, errorText, ReadTextOptions, Server, TextEncoding, TextFile } from "../lib/api";
import { beginDrag, DropDetail } from "../lib/dnd";
import { remotePaneRegistry } from "../lib/sessions";
import { pickFolder, useSettings } from "../lib/settings";
import { dragOutLocal, dragOutRemote } from "../lib/dragout";
import { baseName, formatDate, formatMode, formatSize, joinPath, parentPath } from "../lib/paths";
import { useTransfers } from "../lib/transfers";
import { MenuItem, useUi } from "../lib/ui";
import { Editor } from "./Editor";
import { IArchive, ICopy, ICopyServer, IDownload, IEdit, IEye, IFile, IFileCode, IFilePlus, IFolder, IFolderDown, IFolderPlus, IImage, IMonitor, IRefresh, IServer, ITerminal, ITrash, IUp, IUpload } from "./Icons";

type Side = "local" | "remote";

interface Adapter {
  list: (p: string) => Promise<Entry[]>;
  mkdir: (p: string) => Promise<void>;
  remove: (p: string) => Promise<void>;
  rename: (a: string, b: string) => Promise<void>;
  createFile: (p: string) => Promise<void>;
  readText: (p: string, opts?: ReadTextOptions) => Promise<TextFile>;
  writeText: (p: string, text: string, enc: TextEncoding) => Promise<void>;
}

function usePane(adapter: Adapter | null, side: Side, defaultHidden: boolean) {
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The pane's eye button toggles just this pane; changing the setting resets every pane to it.
  const [showHidden, setShowHidden] = useState(defaultHidden);
  useEffect(() => setShowHidden(defaultHidden), [defaultHidden]);
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
    toggleHidden: () => setShowHidden(!showHidden),
  };
}

type Pane = ReturnType<typeof usePane>;

interface PanelProps {
  tabId: string;
  server: Server;
  sessionId: string | null;
  onRemoteDir: (dir: string | null) => void;
  /** cd into a remote directory in the terminal. */
  onCd: (dir: string) => void;
}

export function FilePanel({ tabId, server, sessionId, onRemoteDir, onCd }: PanelProps) {
  const ui = useUi();
  const transfers = useTransfers();
  const { settings } = useSettings();

  const localAdapter = useMemo<Adapter>(
    () => ({
      list: api.localList,
      mkdir: api.localMkdir,
      remove: api.localRemove,
      rename: api.localRename,
      createFile: api.localCreateFile,
      readText: api.localReadText,
      writeText: api.localWriteText,
    }),
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
            createFile: (p) => api.remoteCreateFile(sessionId, p),
            readText: (p, o) => api.remoteReadText(sessionId, p, o),
            writeText: (p, t, e) => api.remoteWriteText(sessionId, p, t, e),
          }
        : null,
    [sessionId],
  );

  const local = usePane(localAdapter, "local", settings.showHidden);
  const remote = usePane(remoteAdapter, "remote", settings.showHidden);

  // Downloads folder for this server (per-server override → global setting → OS Downloads).
  const [downloadsDir, setDownloadsDir] = useState<string | null>(null);
  useEffect(() => {
    api.downloadDir(server.downloadDir, settings.downloadDir).then(setDownloadsDir, () => setDownloadsDir(null));
  }, [server.downloadDir, settings.downloadDir]);

  // Initial directories.
  useEffect(() => {
    (async () => {
      const saved = localStorage.getItem("td.localDir");
      const home = await api.localHome();
      if (settings.localStartDir === "downloads") {
        const dl = await api.downloadDir(server.downloadDir, settings.downloadDir).catch(() => null);
        if (dl && (await local.load(dl))) return;
      }
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

  // Expose this remote pane to other panes for server-to-server copies.
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  useEffect(() => {
    if (!sessionId) return;
    remotePaneRegistry.set(tabId, {
      serverId: server.id,
      serverName: server.name || server.host,
      sessionId,
      dir: () => remoteRef.current.dir,
      refresh: () => remoteRef.current.refresh(),
    });
    return () => remotePaneRegistry.delete(tabId);
  }, [tabId, sessionId, server.id, server.name, server.host]);

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

  /** Downloads into the downloads folder (the server's own, else the global one), or asks where. */
  const downloadToDownloads = async (paths: string[]) => {
    if (!sessionId || paths.length === 0) return;
    let dest = downloadsDir ?? (await api.downloadDir(server.downloadDir, settings.downloadDir).catch(() => null));
    if (settings.askDownloadDir || !dest) dest = await pickFolder("Куда сохранить", dest ?? undefined);
    if (!dest) return;
    await transfers.start({ direction: "down", sessionId, server: server.name, sources: paths, dest });
    if (local.dir === dest) local.refresh();
  };

  /** Copies remote paths from one pane's server into a folder of another pane's server. */
  const copyBetween = async (fromPane: string, toPane: string, paths: string[], dir?: string) => {
    const src = remotePaneRegistry.get(fromPane);
    const dst = remotePaneRegistry.get(toPane);
    if (!src || !dst) return ui.toast("Сервер отключён или его панель файлов закрыта", "error");
    const dest = dir ?? dst.dir();
    if (!dest || paths.length === 0) return;
    // Two sessions to one server share a filesystem: never overwrite the source with itself.
    if (src.serverId === dst.serverId) {
      const clash = selfCopyClash(paths, dest);
      if (clash) return ui.toast(clash, "error");
    }
    await transfers.start({ direction: "copy", sessionId: src.sessionId, server: src.serverName, sources: paths, dest, dstSessionId: dst.sessionId, dstServer: dst.serverName });
    remotePaneRegistry.get(toPane)?.refresh();
  };

  const copyMenu = (paths: string[]): MenuItem[] => {
    const others = remotePaneRegistry.others(tabId);
    return [
      { header: "Копировать на другой сервер" },
      ...(others.length === 0
        ? [{ label: "Нет других подключённых серверов", hint: "откройте его в соседней панели или вкладке", disabled: true, onClick: () => {} }]
        : others.map((o) => {
            const dir = o.dir();
            return { label: `${o.serverName}: ${dir ?? "…"}`, icon: <ICopyServer size={13} />, disabled: !dir, onClick: () => copyBetween(tabId, o.paneId, paths) };
          })),
    ];
  };

  // Remote rows dragged out of the window: download to a temp folder, then drag natively (see dragout.ts).
  const dragOutRemoteFiles = (paths: string[]) => {
    if (!sessionId) return;
    const items = remote.entries.filter((e) => paths.includes(e.path));
    const total = items.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0);
    dragOutRemote({
      key: [sessionId, ...items.map((e) => `${e.path}:${e.size}:${e.modified ?? ""}`)].join("|"),
      names: items.map((e) => e.name),
      big: items.some((e) => e.isDir) || items.length > 20 || total > 50 * 1024 * 1024,
      download: (dir) => transfers.start({ direction: "down", sessionId, server: server.name, sources: items.map((e) => e.path), dest: dir }),
      toast: ui.toast,
    });
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
      else if (source.kind === "remote" && source.tabId !== tabId) copyBetween(source.tabId, tabId, source.paths, d.dir);
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
        onDragOut={(paths) => dragOutLocal(paths, ui.toast)}
        transfer={sessionId ? [{ label: "Загрузить на сервер", icon: <IUpload size={13} />, run: upload }] : undefined}
        extra={
          <button className="btn btn-sm" disabled={!sessionId || local.selected.size === 0} onClick={() => upload(selectedPaths(local))} title="Загрузить выбранное на сервер">
            <IUpload size={13} /> <span className="btn-label">Загрузить</span>
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
        onDragOut={dragOutRemoteFiles}
        transfer={[
          { label: "Скачать на компьютер", hint: local.dir ? baseName(local.dir) : undefined, icon: <IDownload size={13} />, run: download },
          {
            label: settings.askDownloadDir ? "Скачать в…" : "Скачать в папку загрузок",
            hint: !settings.askDownloadDir && downloadsDir ? baseName(downloadsDir) : undefined,
            icon: <IFolderDown size={13} />,
            run: downloadToDownloads,
          },
        ]}
        onCd={onCd}
        extraMenu={sessionId ? copyMenu : undefined}
        extra={
          <>
            <button className="btn btn-sm" disabled={remote.selected.size === 0} onClick={() => download(selectedPaths(remote))} title="Скачать выбранное на компьютер">
              <IDownload size={13} /> <span className="btn-label">Скачать</span>
            </button>
            <button className="btn btn-sm" disabled={!sessionId} onClick={pickAndUpload} title="Выбрать файлы на диске и загрузить сюда">
              <IFilePlus size={13} /> <span className="btn-label">Файлы…</span>
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
  /** Upload (local pane) / download actions (remote pane) for the context menu. */
  transfer?: { label: string; hint?: string; icon: React.ReactNode; run: (paths: string[]) => void }[];
  onCd?: (dir: string) => void;
  /** Extra context-menu items for the selected paths (server-to-server copy). */
  extraMenu?: (paths: string[]) => MenuItem[];
  /** Rows dragged out of the window, into the OS file manager. */
  onDragOut?: (paths: string[]) => void;
}

function FilePane({ pane, tabId, title, accept, disabledText, extra, onDrop, onOpenFile, transfer, onCd, extraMenu, onDragOut }: PaneProps) {
  const ui = useUi();
  const [editing, setEditing] = useState<string | null>(null);
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
    if (pane.dir === null || pane.dir === "") return;
    const name = await ui.prompt("Новая папка", "Имя папки");
    if (!name) return;
    try {
      await pane.adapter!.mkdir(joinPath(pane.dir, name, remote));
      pane.refresh();
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  const newFile = async () => {
    if (pane.dir === null || pane.dir === "") return;
    const name = await ui.prompt("Новый файл", "Имя файла (например, config.yml)");
    if (!name) return;
    if (/[\\/]/.test(name)) return ui.toast("Имя не должно содержать / или \\", "error");
    const path = joinPath(pane.dir, name, remote);
    try {
      await pane.adapter!.createFile(path);
      await pane.load(pane.dir, true);
      pane.setSelected(new Set([path]));
      anchor.current = path;
      setEditing(path);
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  const edit = (entry?: Entry) => {
    const target = entry ?? pane.entries.find((x) => pane.selected.has(x.path) && pane.selected.size === 1);
    if (target && !target.isDir) setEditing(target.path);
  };

  const copyPaths = (paths: string[]) => {
    writeText(paths.join("\n"));
    ui.toast(paths.length === 1 ? "Путь скопирован" : `Скопировано путей: ${paths.length}`, "success");
  };

  const dirMenu = (): MenuItem[] => {
    const ok = pane.dir !== null && pane.dir !== "" && !disabledText;
    return [
      { label: "Новый файл…", icon: <IFilePlus size={13} />, disabled: !ok, onClick: newFile },
      { label: "Новая папка…", icon: <IFolderPlus size={13} />, disabled: !ok, onClick: mkdir },
      "-",
      ...(onCd && pane.dir ? [{ label: "Перейти сюда в терминале", icon: <ITerminal size={13} />, onClick: () => onCd(pane.dir!) }, "-" as const] : []),
      { label: "Обновить", icon: <IRefresh size={13} />, hint: "F5", disabled: pane.dir === null, onClick: () => pane.refresh() },
      { label: pane.showHidden ? "Скрыть скрытые файлы" : "Показать скрытые файлы", icon: <IEye size={13} />, onClick: pane.toggleHidden },
    ];
  };

  const rowMenu = (ev: React.MouseEvent, entry: Entry) => {
    ev.preventDefault();
    ev.stopPropagation();
    // Right click on an unselected row selects just that row (like file managers do).
    let sel = pane.selected;
    if (!sel.has(entry.path)) {
      sel = new Set([entry.path]);
      pane.setSelected(sel);
      anchor.current = entry.path;
    }
    const paths = pane.entries.filter((x) => sel.has(x.path)).map((x) => x.path);
    const single = paths.length === 1;
    ui.menu(ev, [
      single && entry.isDir
        ? { label: "Открыть", icon: <IFolder size={13} />, hint: "Enter", onClick: () => pane.load(entry.path) }
        : { label: "Редактировать", icon: <IEdit size={13} />, hint: "F4", disabled: !single, onClick: () => edit(entry) },
      ...(single && entry.isDir && onCd ? [{ label: "Перейти в терминале", icon: <ITerminal size={13} />, onClick: () => onCd(entry.path) }] : []),
      ...(transfer ?? []).map((t) => ({ label: t.label, hint: t.hint, icon: t.icon, onClick: () => t.run(paths) })),
      ...(extraMenu ? ["-" as const, ...extraMenu(paths)] : []),
      "-",
      { label: "Переименовать…", icon: <IEdit size={13} />, hint: "F2", disabled: !single, onClick: rename },
      { label: single ? "Копировать путь" : "Копировать пути", icon: <ICopy size={13} />, onClick: () => copyPaths(paths) },
      "-",
      { label: "Новый файл…", icon: <IFilePlus size={13} />, onClick: newFile },
      { label: "Новая папка…", icon: <IFolderPlus size={13} />, onClick: mkdir },
      "-",
      { label: single ? "Удалить" : `Удалить (${paths.length})`, icon: <ITrash size={13} />, hint: "Del", danger: true, onClick: remove },
    ]);
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
    // Ignore typing in the path box and in dialogs/editor rendered inside the pane.
    if ((e.target as HTMLElement).closest("input, textarea, .modal-backdrop")) return;
    const sel = pane.entries.filter((x) => pane.selected.has(x.path));
    if (e.key === "Enter" && sel.length === 1) openEntry(sel[0]);
    else if (e.key === "Backspace") goUp();
    else if (e.key === "Delete") remove();
    else if (e.key === "F2") rename();
    else if (e.key === "F4") edit();
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
        <button className="icon-btn" title="Новый файл" onClick={newFile} disabled={!pane.dir}>
          <IFilePlus />
        </button>
        <button className="icon-btn" title="Новая папка" onClick={mkdir} disabled={!pane.dir}>
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
      <div
        className="pane-body"
        onMouseDown={(e) => e.target === e.currentTarget && pane.setSelected(new Set())}
        onContextMenu={(e) => {
          e.preventDefault();
          if ((e.target as HTMLElement).closest("tbody tr")) return;
          pane.setSelected(new Set());
          ui.menu(e, dirMenu());
        }}
      >
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
                <th className="col-date">Изменён</th>
                {remote && <th className="col-mode">Права</th>}
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
                  onContextMenu={(ev) => rowMenu(ev, e)}
                  onPointerDown={(ev) => {
                    const paths = pane.selected.has(e.path) ? [...pane.selected] : [e.path];
                    beginDrag(ev, () => ({ kind: pane.side, tabId, paths }), paths.length > 1 ? `${paths.length} объектов` : e.name, onDragOut && (() => onDragOut(paths)));
                  }}
                >
                  <td className="name">
                    <span className="ficon">{e.isDir ? <IFolder className="dir" /> : fileIcon(e.name)}</span>
                    <span className={e.isLink ? "link" : ""}>{e.name}</span>
                  </td>
                  <td className="num">{e.isDir ? "" : formatSize(e.size)}</td>
                  <td className="date col-date">{formatDate(e.modified)}</td>
                  {remote && <td className="mode col-mode">{formatMode(e.mode)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!disabledText && !pane.error && pane.entries.length === 0 && !pane.loading && <div className="pane-empty">Папка пуста</div>}
        {pane.loading && <div className="pane-loading" />}
      </div>
      <div className="drop-overlay">{remote ? "Отпустите, чтобы загрузить на сервер" : "Отпустите, чтобы скачать сюда"}</div>
      {editing && pane.adapter && (
        <Editor
          key={editing}
          title={remote ? `${title}:${editing}` : editing}
          load={(o) => pane.adapter!.readText(editing, o)}
          save={(t, e) => pane.adapter!.writeText(editing, t, e)}
          onSaved={() => pane.refresh()}
          onClose={() => {
            setEditing(null);
            zoneRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/** Error text when copying `paths` into `dest` on the same filesystem would hit the source itself. */
function selfCopyClash(paths: string[], dest: string): string | null {
  const d = dest.replace(/\/+$/, "");
  for (const p of paths) {
    const src = p.replace(/\/+$/, "");
    if (parentPath(src, true).replace(/\/+$/, "") === d) return `${baseName(src)}: уже находится в этой папке`;
    if (d === src || d.startsWith(`${src}/`)) return `${baseName(src)}: нельзя скопировать папку внутрь самой себя`;
  }
  return null;
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return <IImage />;
  if (["zip", "gz", "tgz", "xz", "bz2", "7z", "rar", "tar", "zst", "deb", "rpm"].includes(ext)) return <IArchive />;
  if (["sh", "py", "js", "ts", "rs", "go", "php", "rb", "conf", "yml", "yaml", "json", "toml", "ini", "env", "sql"].includes(ext)) return <IFileCode />;
  return <IFile />;
}
