import { useMemo, useState } from "react";
import { Server } from "../lib/api";
import { ICopy, IEdit, IPlus, ITrash } from "./Icons";

interface Props {
  servers: Server[];
  openCounts: Record<string, number>;
  /** forceNew: open another tab even if one is already open for this server. */
  onConnect: (s: Server, forceNew?: boolean) => void;
  onAdd: () => void;
  onEdit: (s: Server) => void;
  onDelete: (s: Server) => void;
  onHome: () => void;
  homeActive: boolean;
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

export function Sidebar({ servers, openCounts, onConnect, onAdd, onEdit, onDelete, onHome, homeActive }: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("td.collapsed") ?? "[]")));
  const grouped = useMemo(() => groupServers(servers, query), [servers, query]);

  const toggle = (g: string) => {
    const next = new Set(collapsed);
    next.has(g) ? next.delete(g) : next.add(g);
    setCollapsed(next);
    localStorage.setItem("td.collapsed", JSON.stringify([...next]));
  };

  return (
    <aside className="sidebar">
      <div className={`brand ${homeActive ? "on" : ""}`} onClick={onHome} title="Главная">
        <img src="/logo.svg" alt="" />
        <span>TermDock</span>
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
        <button className="icon-btn add" onClick={onAdd} title="Добавить сервер (Ctrl+N)">
          <IPlus size={16} />
        </button>
      </div>
      <div className="server-list">
        {servers.length === 0 && <div className="empty-small">Серверов пока нет.<br />Нажмите +, чтобы добавить.</div>}
        {grouped.map(([group, list]) => (
          <div key={group || "_"} className="group">
            {(group || grouped.length > 1) && (
              <div className="group-title" onClick={() => toggle(group)}>
                <span className={`chev ${collapsed.has(group) && !query ? "closed" : ""}`}>▾</span>
                {group || "Без группы"}
                <span className="group-count">{list.length}</span>
              </div>
            )}
            {!(collapsed.has(group) && !query) &&
              list.map((s) => (
                <div key={s.id} className="server-item" onClick={(e) => onConnect(s, e.ctrlKey || e.shiftKey)} title={`${s.username}@${s.host}:${s.port}\nКлик — открыть, Ctrl+клик — ещё одна вкладка`}>
                  <span className="server-color" style={{ background: s.color || "#58a6ff" }} />
                  <div className="server-text">
                    <div className="server-name">{s.name}</div>
                    <div className="server-host">
                      {s.username}@{s.host}
                      {s.port !== 22 ? `:${s.port}` : ""}
                    </div>
                  </div>
                  {openCounts[s.id] ? <span className="badge">{openCounts[s.id]}</span> : null}
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
              ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
