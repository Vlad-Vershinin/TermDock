import { useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Server } from "../lib/api";
import { beginDrag, DropDetail } from "../lib/dnd";
import { MenuItem, useUi } from "../lib/ui";
import { ICopy, IEdit, IFolder, IFolderOut, IFolderPlus, IPlay, IPlus, ISplitDown, ISplitRight, ITrash } from "./Icons";
import { SessionStatus } from "./SessionView";

/** Aggregated connection state of all panes opened for a server. */
export interface ServerState {
  status: SessionStatus | "idle";
  /** Number of live connections. */
  connected: number;
  /** Number of open panes (any state). */
  open: number;
}

interface Props {
  servers: Server[];
  /** Folder names in display order (may include empty folders). */
  folders: string[];
  states: Record<string, ServerState>;
  width: number;
  /** forceNew: open another tab even if one is already open for this server. */
  onConnect: (s: Server, forceNew?: boolean) => void;
  /** Opens the server next to the focused pane of the current tab; null when there is no tab. */
  onSplitOpen: ((s: Server, dir: "row" | "column") => void) | null;
  /** folder: preselected folder for the new server. */
  onAdd: (folder?: string) => void;
  onEdit: (s: Server) => void;
  onDelete: (s: Server) => void;
  onAddFolder: () => void;
  onRenameFolder: (name: string) => void;
  onDeleteFolder: (name: string) => void;
  /** folder: "" = out of any folder. */
  onMove: (ids: string[], folder: string) => void;
  onResize: (width: number) => void;
}

const folderOf = (s: Server) => s.group?.trim() || "";

function matches(s: Server, q: string) {
  return !q || [s.name, s.host, s.username, s.group ?? ""].some((v) => v.toLowerCase().includes(q));
}

/** [folder, servers] in folder order; servers without a folder come last under "". Empty groups are skipped. */
export function groupServers(servers: Server[], query: string, folders: string[] = []) {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, Server[]>();
  for (const s of servers.filter((x) => matches(x, q))) {
    const g = folderOf(s);
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const rank = (g: string) => (g === "" ? Infinity : folders.includes(g) ? folders.indexOf(g) : folders.length);
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

const STATUS_TEXT: Record<ServerState["status"], string> = {
  idle: "не подключён",
  connecting: "подключение…",
  connected: "подключён",
  closed: "отключён",
  error: "ошибка",
};

const AUTH_TEXT: Record<string, string> = { password: "пароль", key: "ключ", agent: "агент" };

export const MIN_SIDEBAR = 200;
export const MAX_SIDEBAR = 560;

export function Sidebar(props: Props) {
  const { servers, folders, states, width, onConnect, onSplitOpen, onAdd, onEdit, onDelete, onAddFolder, onRenameFolder, onDeleteFolder, onMove, onResize } = props;
  const ui = useUi();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("td.collapsed") ?? "[]")));
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const online = Object.values(states).filter((s) => s.connected > 0).length;

  const { tree, root, flat } = useMemo(() => {
    const visible = servers.filter((s) => matches(s, q));
    const names = [...folders, ...servers.map(folderOf).filter((f) => f && !folders.includes(f))];
    const tree = [...new Set(names)]
      .map((name) => ({ name, list: visible.filter((s) => folderOf(s) === name) }))
      // While searching, show only folders with matches (or whose name matches).
      .filter((f) => !q || f.list.length > 0 || f.name.toLowerCase().includes(q));
    const root = visible.filter((s) => !folderOf(s));
    return { tree, root, flat: [...tree.flatMap((f) => f.list), ...root] };
  }, [servers, folders, q]);

  const isCollapsed = (f: string) => collapsed.has(f) && !q;
  const toggle = (g: string) => {
    const next = new Set(collapsed);
    next.has(g) ? next.delete(g) : next.add(g);
    setCollapsed(next);
    localStorage.setItem("td.collapsed", JSON.stringify([...next]));
  };

  // Servers dropped onto a folder (or onto the list outside folders = no folder).
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  useEffect(() => {
    const el = listRef.current!;
    const h = (e: Event) => {
      const d = (e as CustomEvent<DropDetail>).detail;
      if (d.source.kind === "server") moveRef.current(d.source.ids, d.dir ?? "");
    };
    el.addEventListener("td-drop", h);
    return () => el.removeEventListener("td-drop", h);
  }, []);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => onResize(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-x");
    };
    document.body.classList.add("resizing-x");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const moveToNewFolder = async (s: Server) => {
    const name = (await ui.prompt("Новая папка", "Название папки"))?.trim();
    if (name) onMove([s.id], name);
  };

  const menu = (e: React.MouseEvent, s: Server) => {
    e.preventDefault();
    e.stopPropagation();
    const current = folderOf(s);
    const targets: MenuItem[] = folders
      .filter((f) => f !== current)
      .map((f) => ({ label: f, icon: <IFolder size={13} />, onClick: () => onMove([s.id], f) }));
    ui.menu(e, [
      { label: "Подключиться", icon: <IPlay size={13} />, onClick: () => onConnect(s) },
      { label: "Открыть в новой вкладке", icon: <ICopy size={13} />, hint: "Ctrl+клик", onClick: () => onConnect(s, true) },
      { label: "Открыть справа в текущей вкладке", icon: <ISplitRight size={13} />, disabled: !onSplitOpen, onClick: () => onSplitOpen?.(s, "row") },
      { label: "Открыть снизу в текущей вкладке", icon: <ISplitDown size={13} />, disabled: !onSplitOpen, onClick: () => onSplitOpen?.(s, "column") },
      "-",
      { label: "Изменить…", icon: <IEdit size={13} />, onClick: () => onEdit(s) },
      { label: "Копировать адрес", icon: <ICopy size={13} />, onClick: () => writeText(`${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ""}`) },
      {
        label: "Переместить в папку",
        icon: <IFolder size={13} />,
        submenu: [
          ...targets,
          ...(current ? [{ label: "Без папки", icon: <IFolderOut size={13} />, onClick: () => onMove([s.id], "") }] : []),
          ...(targets.length || current ? ["-" as const] : []),
          { label: "Новая папка…", icon: <IFolderPlus size={13} />, onClick: () => moveToNewFolder(s) },
        ],
      },
      "-",
      { label: "Удалить", icon: <ITrash size={13} />, danger: true, onClick: () => onDelete(s) },
    ]);
  };

  const folderMenu = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    ui.menu(e, [
      { label: "Добавить сервер в папку…", icon: <IPlus size={13} />, onClick: () => onAdd(name) },
      { label: isCollapsed(name) ? "Развернуть" : "Свернуть", onClick: () => toggle(name) },
      "-",
      { label: "Переименовать…", icon: <IEdit size={13} />, onClick: () => onRenameFolder(name) },
      { label: "Новая папка…", icon: <IFolderPlus size={13} />, onClick: onAddFolder },
      "-",
      { label: "Удалить папку", icon: <ITrash size={13} />, danger: true, onClick: () => onDeleteFolder(name) },
    ]);
  };

  const listMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    ui.menu(e, [
      { label: "Добавить сервер…", icon: <IPlus size={13} />, hint: "Ctrl+Shift+N", onClick: () => onAdd() },
      { label: "Новая папка…", icon: <IFolderPlus size={13} />, onClick: onAddFolder },
    ]);
  };

  const item = (s: Server, nested: boolean) => {
    const st = states[s.id] ?? { status: "idle", connected: 0, open: 0 };
    const via = s.jump?.serverId ? servers.find((x) => x.id === s.jump!.serverId)?.name : s.jump?.host;
    return (
      <div
        key={s.id}
        className={`server-item st-${st.status} ${nested ? "nested" : ""}`}
        onClick={(e) => onConnect(s, e.ctrlKey || e.shiftKey)}
        onContextMenu={(e) => menu(e, s)}
        onPointerDown={(e) => beginDrag(e, () => ({ kind: "server", ids: [s.id] }), s.name)}
        title={`${s.username}@${s.host}:${s.port} · ${AUTH_TEXT[s.auth] ?? s.auth}${via ? `\nЧерез: ${via}` : ""}\nКлик — открыть, Ctrl+клик — ещё одна вкладка, ПКМ — действия.\nПеретащите на папку, чтобы переместить.`}
      >
        <span className="server-color" style={{ background: s.color || "#58a6ff" }} />
        <div className="server-text">
          <div className="server-name">{s.name}</div>
          <div className="server-host">
            {s.username}@{s.host}
            {s.port !== 22 ? `:${s.port}` : ""}
            {via && <span className="server-via"> ↪ {via}</span>}
          </div>
        </div>
        <span className={`server-status ${st.status}`} title={st.open ? `Открыто панелей: ${st.open}, подключено: ${st.connected}` : undefined}>
          <span className={`status-dot ${st.status}`} />
          <span className="server-status-text">
            {STATUS_TEXT[st.status]}
            {st.connected > 1 ? ` ×${st.connected}` : ""}
          </span>
        </span>
        <div className="server-actions" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Новая вкладка" onClick={() => onConnect(s, true)}>
            <ICopy size={14} />
          </button>
          <button className="icon-btn" title="Изменить" onClick={() => onEdit(s)}>
            <IEdit size={14} />
          </button>
          <button className="icon-btn danger" title="Удалить" onClick={() => onDelete(s)}>
            <ITrash size={14} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <span className="toolwin-title">Серверы</span>
        {servers.length > 0 && (
          <span className="muted small" title="Серверов с активным подключением">
            {online} / {servers.length} онлайн
          </span>
        )}
        <div className="spacer" />
        <button className="icon-btn" onClick={onAddFolder} title="Новая папка">
          <IFolderPlus size={15} />
        </button>
        <button className="icon-btn" onClick={() => onAdd()} title="Добавить сервер (Ctrl+Shift+N)">
          <IPlus size={15} />
        </button>
      </div>
      <div className="sidebar-search">
        <input
          id="server-search"
          placeholder="Поиск  Ctrl+Shift+K"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && flat[0]) onConnect(flat[0]);
            if (e.key === "Escape") setQuery("");
          }}
        />
      </div>
      <div className="server-list" ref={listRef} data-dropzone="servers" data-accept="server" onContextMenu={listMenu}>
        {servers.length === 0 && folders.length === 0 && (
          <div className="empty-small">
            Серверов пока нет.
            <br />
            Нажмите +, чтобы добавить.
          </div>
        )}
        {q && flat.length === 0 && servers.length > 0 && <div className="empty-small">Ничего не найдено</div>}
        {tree.map(({ name, list }) => {
          const closed = isCollapsed(name);
          const total = servers.filter((s) => folderOf(s) === name).length;
          return (
            <div key={name} className="group folder" data-dropdir={name}>
              <div className="group-title" onClick={() => toggle(name)} onContextMenu={(e) => folderMenu(e, name)} title="Клик — свернуть/развернуть, ПКМ — действия">
                <span className={`chev ${closed ? "closed" : ""}`}>▾</span>
                <IFolder size={14} />
                <span className="group-name">{name}</span>
                <span className="group-count">
                  {list.some((s) => states[s.id]?.connected) && <span className="status-dot connected tiny" />}
                  {q ? `${list.length} / ${total}` : total}
                </span>
              </div>
              {!closed && list.map((s) => item(s, true))}
              {!closed && total === 0 && <div className="folder-empty">Пусто — перетащите сюда сервер</div>}
            </div>
          );
        })}
        {root.length > 0 && (
          <div className="group root" data-dropdir="">
            {root.map((s) => item(s, false))}
          </div>
        )}
      </div>
      <div className="sidebar-resizer" onPointerDown={startResize} onDoubleClick={() => onResize(260)} title="Потяните, чтобы изменить ширину (двойной клик — сбросить)" />
    </aside>
  );
}
