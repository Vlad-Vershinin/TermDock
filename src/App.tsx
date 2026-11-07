import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, errorText, Server } from "./lib/api";
import { clearHover, dropAt, hoverAt } from "./lib/dnd";
import { TransfersPanel, TransfersProvider, useTransfers } from "./lib/transfers";
import { UiProvider, useUi } from "./lib/ui";
import { ServerDialog } from "./components/ServerDialog";
import { SessionStatus, SessionView } from "./components/SessionView";
import { groupServers, Sidebar } from "./components/Sidebar";
import { IClose, IKey, ILock, IPlus, ITransfer } from "./components/Icons";

interface Tab {
  id: string;
  serverId: string;
  title: string;
  status: SessionStatus;
}

export default function App() {
  return (
    <UiProvider>
      <TransfersProvider>
        <Main />
      </TransfersProvider>
    </UiProvider>
  );
}

function Main() {
  const ui = useUi();
  const { transfers } = useTransfers();
  const [servers, setServers] = useState<Server[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [editing, setEditing] = useState<Server | null | undefined>(undefined); // undefined = closed
  const [showTransfers, setShowTransfers] = useState(false);

  useEffect(() => {
    api.listServers().then(setServers).catch((e) => ui.toast(errorText(e), "error"));
  }, [ui]);

  // Files dropped from the OS file manager: route to the drop zone under the cursor.
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === "leave") return clearHover();
      const dpr = window.devicePixelRatio || 1;
      const x = p.position.x / dpr;
      const y = p.position.y / dpr;
      if (p.type === "over" || p.type === "enter") hoverAt(x, y, { kind: "os", paths: [] });
      else if (p.type === "drop") dropAt(x, y, { kind: "os", paths: p.paths });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const openSession = useCallback(
    (s: Server, forceNew = false) => {
      const existing = tabs.filter((t) => t.serverId === s.id);
      if (existing.length && !forceNew) return setActive(existing[existing.length - 1].id);
      const id = crypto.randomUUID();
      const title = existing.length ? `${s.name} (${existing.length + 1})` : s.name;
      setTabs((t) => [...t, { id, serverId: s.id, title, status: "connecting" }]);
      setActive(id);
    },
    [tabs],
  );

  const closeTab = useCallback(
    (id: string) => {
      setTabs((list) => {
        const i = list.findIndex((t) => t.id === id);
        const next = list.filter((t) => t.id !== id);
        if (active === id) setActive(next[Math.min(i, next.length - 1)]?.id ?? null);
        return next;
      });
    },
    [active],
  );

  const setStatus = useCallback((id: string, status: SessionStatus) => {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, status } : t)));
  }, []);

  const statusHandlers = useMemo(() => {
    const m: Record<string, (s: SessionStatus) => void> = {};
    for (const t of tabs) m[t.id] = (s) => setStatus(t.id, s);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.map((t) => t.id).join(","), setStatus]);

  const deleteServer = async (s: Server) => {
    if (!(await ui.confirm("Удалить сервер?", `«${s.name}» будет удалён из списка вместе с сохранённым паролем.`, true))) return;
    try {
      await api.deleteServer(s.id);
      setServers((l) => l.filter((x) => x.id !== s.id));
      setTabs((l) => l.filter((t) => t.serverId !== s.id));
      setActive((a) => (tabs.some((t) => t.id === a && t.serverId === s.id) ? null : a));
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  const onSaved = (s: Server, connect: boolean) => {
    setServers((l) => (l.some((x) => x.id === s.id) ? l.map((x) => (x.id === s.id ? s : x)) : [...l, s]));
    setEditing(undefined);
    if (connect) openSession(s, true);
  };

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      let handled = true;
      if (e.code === "KeyK" && e.shiftKey) document.getElementById("server-search")?.focus();
      else if (e.code === "KeyN" && e.shiftKey) setEditing(null);
      else if (e.code === "KeyW" && e.shiftKey && active) closeTab(active);
      else if (e.key === "Tab" && tabs.length) {
        const i = tabs.findIndex((t) => t.id === active);
        const n = (i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
        setActive(tabs[n].id);
      } else if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const t = tabs[Number(e.code.slice(5)) - 1];
        if (t) setActive(t.id);
      } else handled = false;
      if (handled) {
        // Keep the shortcut away from the terminal.
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tabs, active, closeTab]);

  const openCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of tabs) m[t.serverId] = (m[t.serverId] ?? 0) + 1;
    return m;
  }, [tabs]);

  const groups = useMemo(() => [...new Set(servers.map((s) => s.group?.trim()).filter((g): g is string => !!g))], [servers]);
  const running = transfers.filter((t) => t.progress.status === "running").length;

  return (
    <div className="app">
      <Sidebar
        servers={servers}
        openCounts={openCounts}
        onConnect={openSession}
        onAdd={() => setEditing(null)}
        onEdit={(s) => setEditing(s)}
        onDelete={deleteServer}
        onHome={() => setActive(null)}
        homeActive={active === null}
      />
      <main className="main">
        <div className="tabbar">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === active ? "active" : ""}`}
              onClick={() => setActive(t.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
              title={t.title}
            >
              <span className={`status-dot ${t.status}`} />
              <span className="tab-title">{t.title}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                title="Закрыть (Ctrl+Shift+W)"
              >
                <IClose size={12} />
              </button>
            </div>
          ))}
          <div className="spacer" />
          <button className={`btn btn-sm transfers-btn ${showTransfers ? "on" : ""}`} onClick={() => setShowTransfers(!showTransfers)} title="Передачи файлов">
            <ITransfer /> Передачи{running ? <span className="badge">{running}</span> : null}
          </button>
        </div>
        <div className="content">
          {active === null && <Home servers={servers} onConnect={openSession} onAdd={() => setEditing(null)} />}
          {tabs.map((t) => {
            const server = servers.find((s) => s.id === t.serverId);
            return server ? <SessionView key={t.id} tabId={t.id} server={server} active={t.id === active} onStatus={statusHandlers[t.id]} /> : null;
          })}
          {showTransfers && <TransfersPanel onClose={() => setShowTransfers(false)} />}
        </div>
      </main>
      {editing !== undefined && <ServerDialog server={editing} groups={groups} onClose={() => setEditing(undefined)} onSaved={onSaved} />}
    </div>
  );
}

function Home({ servers, onConnect, onAdd }: { servers: Server[]; onConnect: (s: Server) => void; onAdd: () => void }) {
  const grouped = groupServers(servers, "");
  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-head">
          <div>
            <h1>Серверы</h1>
            <p className="muted">Выберите сервер, чтобы открыть терминал и файловую панель.</p>
          </div>
          <button className="btn btn-primary" onClick={onAdd}>
            <IPlus /> Добавить сервер
          </button>
        </div>
        {servers.length === 0 ? (
          <div className="home-empty">
            <img src="/logo.svg" alt="" />
            <h2>Добро пожаловать в TermDock</h2>
            <p className="muted">Добавьте первый сервер — и подключайтесь к нему в один клик.</p>
            <button className="btn btn-primary" onClick={onAdd}>
              Добавить сервер
            </button>
          </div>
        ) : (
          grouped.map(([group, list]) => (
            <section key={group || "_"}>
              {grouped.length > 1 && <h4 className="home-group">{group || "Без группы"}</h4>}
              <div className="cards">
                {list.map((s) => (
                  <button key={s.id} className="card" onClick={() => onConnect(s)}>
                    <span className="card-stripe" style={{ background: s.color || "#58a6ff" }} />
                    <div className="card-name">{s.name}</div>
                    <div className="card-host">
                      {s.username}@{s.host}
                      {s.port !== 22 ? `:${s.port}` : ""}
                    </div>
                    <div className="card-meta">{s.auth === "key" ? <><IKey size={12} /> ключ</> : <><ILock size={12} /> {s.hasSecret ? "пароль сохранён" : "пароль"}</>}</div>
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
        <div className="shortcuts">
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> поиск</span>
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> новый сервер</span>
          <span><kbd>Ctrl</kbd>+<kbd>Tab</kbd> след. вкладка</span>
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C/V</kbd> копировать/вставить</span>
          <span>Перетащите файлы из проводника в терминал или панель сервера — они загрузятся</span>
        </div>
      </div>
    </div>
  );
}
