import { useMemo, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Server } from "../lib/api";
import { useUi } from "../lib/ui";
import { ICopy, IEdit, IPlay, IPlus, ISplitDown, ISplitRight, ITrash } from "./Icons";
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
  states: Record<string, ServerState>;
  width: number;
  /** forceNew: open another tab even if one is already open for this server. */
  onConnect: (s: Server, forceNew?: boolean) => void;
  /** Opens the server next to the focused pane of the current tab; null when there is no tab. */
  onSplitOpen: ((s: Server, dir: "row" | "column") => void) | null;
  onAdd: () => void;
  onEdit: (s: Server) => void;
  onDelete: (s: Server) => void;
  onResize: (width: number) => void;
}

export function groupServers(servers: Server[], query: string) {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? servers.filter((s) => [s.name, s.host, s.username, s.group ?? ""].some((v) => v.toLowerCase().includes(q)))
    : servers;
  const groups = new Map<string, Server[]>();
  for (const s of filtered) {
    const g = s.group?.trim() || "";
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
}

const STATUS_TEXT: Record<ServerState["status"], string> = {
  idle: "не подключён",
  connecting: "подключение…",
  connected: "подключён",
  closed: "отключён",
  error: "ошибка",
};

export const MIN_SIDEBAR = 200;
export const MAX_SIDEBAR = 560;

export function Sidebar({ servers, states, width, onConnect, onSplitOpen, onAdd, onEdit, onDelete, onResize }: Props) {
  const ui = useUi();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("td.collapsed") ?? "[]")));
  const grouped = useMemo(() => groupServers(servers, query), [servers, query]);
  const online = Object.values(states).filter((s) => s.connected > 0).length;

  const toggle = (g: string) => {
    const next = new Set(collapsed);
    next.has(g) ? next.delete(g) : next.add(g);
    setCollapsed(next);
    localStorage.setItem("td.collapsed", JSON.stringify([...next]));
  };

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

  const menu = (e: React.MouseEvent, s: Server) => {
    e.preventDefault();
    ui.menu(e, [
      { label: "Подключиться", icon: <IPlay size={13} />, onClick: () => onConnect(s) },
      { label: "Открыть в новой вкладке", icon: <ICopy size={13} />, hint: "Ctrl+клик", onClick: () => onConnect(s, true) },
      { label: "Открыть справа в текущей вкладке", icon: <ISplitRight size={13} />, disabled: !onSplitOpen, onClick: () => onSplitOpen?.(s, "row") },
      { label: "Открыть снизу в текущей вкладке", icon: <ISplitDown size={13} />, disabled: !onSplitOpen, onClick: () => onSplitOpen?.(s, "column") },
      "-",
      { label: "Изменить…", icon: <IEdit size={13} />, onClick: () => onEdit(s) },
      { label: "Копировать адрес", icon: <ICopy size={13} />, onClick: () => writeText(`${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ""}`) },
      "-",
      { label: "Удалить", icon: <ITrash size={13} />, danger: true, onClick: () => onDelete(s) },
    ]);
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
        <button className="icon-btn" onClick={onAdd} title="Добавить сервер (Ctrl+Shift+N)">
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
            if (e.key === "Enter" && grouped[0]?.[1][0]) onConnect(grouped[0][1][0]);
            if (e.key === "Escape") setQuery("");
          }}
        />
      </div>
      <div className="server-list">
        {servers.length === 0 && (
          <div className="empty-small">
            Серверов пока нет.
            <br />
            Нажмите +, чтобы добавить.
          </div>
        )}
        {grouped.map(([group, list]) => (
          <div key={group || "_"} className="group">
            {(group || grouped.length > 1) && (
              <div className="group-title" onClick={() => toggle(group)}>
                <span className={`chev ${collapsed.has(group) && !query ? "closed" : ""}`}>▾</span>
                {group || "Без группы"}
                <span className="group-count">
                  {list.some((s) => states[s.id]?.connected) && <span className="status-dot connected tiny" />}
                  {list.length}
                </span>
              </div>
            )}
            {!(collapsed.has(group) && !query) &&
              list.map((s) => {
                const st = states[s.id] ?? { status: "idle", connected: 0, open: 0 };
                return (
                  <div
                    key={s.id}
                    className={`server-item st-${st.status}`}
                    onClick={(e) => onConnect(s, e.ctrlKey || e.shiftKey)}
                    onContextMenu={(e) => menu(e, s)}
                    title={`${s.username}@${s.host}:${s.port}\nКлик — открыть, Ctrl+клик — ещё одна вкладка, ПКМ — действия`}
                  >
                    <span className="server-color" style={{ background: s.color || "#58a6ff" }} />
                    <div className="server-text">
                      <div className="server-name">{s.name}</div>
                      <div className="server-host">
                        {s.username}@{s.host}
                        {s.port !== 22 ? `:${s.port}` : ""}
                      </div>
                    </div>
                    <span className={`server-status ${st.status}`} title={st.open ? `Открыто панелей: ${st.open}, подключено: ${st.connected}` : undefined}>
                      <span className={`status-dot ${st.status}`} />
                      <span className="server-status-text">
                        {STATUS_TEXT[st.status]}
                        {st.connected > 1 ? ` ×${st.connected}` : ""}
                      </span>
                    </span>
                    <div className="server-actions" onClick={(e) => e.stopPropagation()}>
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
              })}
          </div>
        ))}
      </div>
      <div className="sidebar-resizer" onPointerDown={startResize} onDoubleClick={() => onResize(260)} title="Потяните, чтобы изменить ширину (двойной клик — сбросить)" />
    </aside>
  );
}
