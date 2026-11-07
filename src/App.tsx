import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, errorText, Server } from "./lib/api";
import { clearHover, dropAt, hoverAt } from "./lib/dnd";
import { isDraggingOut, isOwnDragPath } from "./lib/dragout";
import { TransfersPanel, TransfersProvider, useTransfers } from "./lib/transfers";
import { MenuItem, UiProvider, useUi } from "./lib/ui";
import { ServerDialog } from "./components/ServerDialog";
import { SessionStatus } from "./components/SessionView";
import { groupServers, MAX_SIDEBAR, MIN_SIDEBAR, ServerState, Sidebar } from "./components/Sidebar";
import { ScriptsPanel, ScriptsProvider, useScripts } from "./components/Scripts";
import { PaneHandlers, PaneState, SplitDir, Tab, TabView } from "./components/TabView";
import { TitleBar, TitleTab, WindowEdges } from "./components/TitleBar";
import { IClose, ICopy, IHome, IKey, ILock, IPlay, IPlus, IScript, ISidebar, ISplitDown, ISplitRight, ITransfer } from "./components/Icons";

const MAX_PANES = 4;

export default function App() {
  return (
    <UiProvider>
      <TransfersProvider>
        <ScriptsProvider>
          <Main />
        </ScriptsProvider>
      </TransfersProvider>
    </UiProvider>
  );
}

const newPane = (serverId: string): PaneState => ({ id: crypto.randomUUID(), serverId, status: "connecting" });

const STATUS_RANK: Record<ServerState["status"], number> = { connected: 4, connecting: 3, error: 2, closed: 1, idle: 0 };

function readNumber(key: string, def: number) {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : def;
}

function Main() {
  const ui = useUi();
  const { transfers } = useTransfers();
  const { scripts } = useScripts();
  const [servers, setServers] = useState<Server[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [editing, setEditing] = useState<Server | null | undefined>(undefined); // undefined = closed
  /** Folder preselected when adding a server from a folder's menu. */
  const [newInFolder, setNewInFolder] = useState<string | undefined>(undefined);
  const [folders, setFolders] = useState<string[]>([]);
  const [showTransfers, setShowTransfers] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem("td.sidebar") !== "0");
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, readNumber("td.sidebarWidth", 270))));
  const [scriptsOpen, setScriptsOpen] = useState(() => localStorage.getItem("td.scriptsPanel") === "1");

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(active);
  activeRef.current = active;

  const reloadServers = useCallback(
    () =>
      Promise.all([api.listServers(), api.listFolders()])
        .then(([s, f]) => {
          setServers(s);
          setFolders(f);
        })
        .catch((e) => ui.toast(errorText(e), "error")),
    [ui],
  );
  useEffect(() => {
    reloadServers();
  }, [reloadServers]);

  // Files dropped from the OS file manager: route to the drop zone under the cursor.
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload;
      // Our own drag-out passing over / dropped back onto the window: ignore, no re-upload.
      if (p.type === "leave" || isDraggingOut()) return clearHover();
      const dpr = window.devicePixelRatio || 1;
      const x = p.position.x / dpr;
      const y = p.position.y / dpr;
      if (p.type === "over" || p.type === "enter") hoverAt(x, y, { kind: "os", paths: [] });
      else if (p.type === "drop") {
        const paths = p.paths.filter((f) => !isOwnDragPath(f));
        if (paths.length) dropAt(x, y, { kind: "os", paths });
        else clearHover();
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ---------- tabs & panes ----------

  const updateTab = useCallback((id: string, f: (t: Tab) => Tab) => setTabs((list) => list.map((t) => (t.id === id ? f(t) : t))), []);

  const addTab = useCallback((serverId: string) => {
    const pane = newPane(serverId);
    const tab: Tab = { id: crypto.randomUUID(), panes: [pane], dir: "row", sizes: [1], focus: pane.id };
    setTabs((t) => [...t, tab]);
    setActive(tab.id);
  }, []);

  const openSession = useCallback(
    (s: Server, forceNew = false) => {
      const existing = tabsRef.current.filter((t) => t.panes.some((p) => p.serverId === s.id));
      if (existing.length && !forceNew) {
        const tab = existing[existing.length - 1];
        setActive(tab.id);
        const pane = tab.panes.find((p) => p.serverId === s.id)!;
        updateTab(tab.id, (t) => ({ ...t, focus: pane.id }));
        return;
      }
      addTab(s.id);
    },
    [addTab, updateTab],
  );

  const closeTab = useCallback((id: string) => {
    const list = tabsRef.current;
    const i = list.findIndex((t) => t.id === id);
    const next = list.filter((t) => t.id !== id);
    setTabs(next);
    if (activeRef.current === id) setActive(next[Math.min(i, next.length - 1)]?.id ?? null);
  }, []);

  const closeOtherTabs = useCallback((id: string) => {
    setTabs((l) => l.filter((t) => t.id === id));
    setActive(id);
  }, []);

  /** Adds a pane next to the focused one. serverId defaults to the focused pane's server (= duplicate). */
  const splitTab = useCallback(
    (tabId: string, dir: SplitDir, serverId?: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.panes.length >= MAX_PANES) return ui.toast(`В одной вкладке — не больше ${MAX_PANES} панелей`, "error");
      const fi = Math.max(0, tab.panes.findIndex((p) => p.id === tab.focus));
      const pane = newPane(serverId ?? tab.panes[fi].serverId);
      const panes = [...tab.panes];
      panes.splice(fi + 1, 0, pane);
      const sizes = [...tab.sizes];
      // The focused pane gives half of its space to the new one.
      const half = (sizes[fi] ?? 1) / 2;
      sizes.splice(fi, 1, half, half);
      updateTab(tabId, (t) => ({ ...t, panes, sizes, dir, focus: pane.id }));
      setActive(tabId);
    },
    [ui, updateTab],
  );

  const closePane = useCallback(
    (tabId: string, paneId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.panes.length <= 1) return closeTab(tabId);
      const i = tab.panes.findIndex((p) => p.id === paneId);
      const panes = tab.panes.filter((p) => p.id !== paneId);
      const sizes = [...tab.sizes];
      const [freed] = sizes.splice(i, 1);
      // Give the freed space to the neighbour that takes the closed pane's place.
      const n = Math.min(i, sizes.length - 1);
      sizes[n] += freed;
      const focus = tab.focus === paneId ? panes[n].id : tab.focus;
      updateTab(tabId, (t) => ({ ...t, panes, sizes, focus }));
    },
    [closeTab, updateTab],
  );

  const duplicateTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      const pane = tab?.panes.find((p) => p.id === tab.focus) ?? tab?.panes[0];
      if (pane) addTab(pane.serverId);
    },
    [addTab],
  );

  const focusPane = useCallback(
    (tabId: string, paneId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (tab && tab.focus !== paneId) updateTab(tabId, (t) => ({ ...t, focus: paneId }));
    },
    [updateTab],
  );

  const setPaneStatus = useCallback((paneId: string, status: SessionStatus) => {
    setTabs((list) =>
      list.map((t) => (t.panes.some((p) => p.id === paneId) ? { ...t, panes: t.panes.map((p) => (p.id === paneId ? { ...p, status } : p)) } : t)),
    );
  }, []);

  // Stable per-pane callbacks (SessionView must not re-render / reconnect because of them).
  const handlerCache = useRef(new Map<string, PaneHandlers>());
  const actions = useRef({ focusPane, setPaneStatus, splitTab, closePane });
  actions.current = { focusPane, setPaneStatus, splitTab, closePane };
  const handlers = useCallback((tabId: string, paneId: string) => {
    let h = handlerCache.current.get(paneId);
    if (!h) {
      h = {
        onFocus: () => actions.current.focusPane(tabId, paneId),
        onStatus: (s) => actions.current.setPaneStatus(paneId, s),
        onSplit: (dir) => {
          actions.current.focusPane(tabId, paneId);
          actions.current.splitTab(tabId, dir);
        },
        onClose: () => actions.current.closePane(tabId, paneId),
      };
      handlerCache.current.set(paneId, h);
    }
    return h;
  }, []);
  useEffect(() => {
    const live = new Set(tabs.flatMap((t) => t.panes.map((p) => p.id)));
    for (const id of handlerCache.current.keys()) if (!live.has(id)) handlerCache.current.delete(id);
  }, [tabs]);

  const activeTab = tabs.find((t) => t.id === active) ?? null;
  const focusedPane = activeTab?.panes.find((p) => p.id === activeTab.focus) ?? null;
  const focusedServer = servers.find((s) => s.id === focusedPane?.serverId) ?? null;

  // ---------- servers ----------

  const deleteServer = async (s: Server) => {
    if (!(await ui.confirm("Удалить сервер?", `«${s.name}» будет удалён из списка вместе с сохранённым паролем.`, true))) return;
    try {
      await api.deleteServer(s.id);
      setServers((l) => l.filter((x) => x.id !== s.id));
      const next = tabsRef.current
        .map((t) => {
          const keep = t.panes.map((p, i) => [p, t.sizes[i]] as const).filter(([p]) => p.serverId !== s.id);
          if (keep.length === t.panes.length) return t;
          const panes = keep.map(([p]) => p);
          return { ...t, panes, sizes: keep.map(([, z]) => z), focus: panes.some((p) => p.id === t.focus) ? t.focus : panes[0]?.id };
        })
        .filter((t) => t.panes.length > 0);
      setTabs(next);
      if (!next.some((t) => t.id === activeRef.current)) setActive(next[next.length - 1]?.id ?? null);
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  const onSaved = (s: Server, connect: boolean) => {
    setServers((l) => (l.some((x) => x.id === s.id) ? l.map((x) => (x.id === s.id ? s : x)) : [...l, s]));
    const f = s.group?.trim();
    if (f) setFolders((l) => (l.includes(f) ? l : [...l, f]));
    setEditing(undefined);
    if (connect) openSession(s, true);
  };

  // ---------- tool windows ----------

  const toggleSidebar = useCallback((open?: boolean) => {
    setSidebarOpen((v) => {
      const next = open ?? !v;
      localStorage.setItem("td.sidebar", next ? "1" : "0");
      return next;
    });
  }, []);

  const toggleScripts = useCallback(() => {
    setScriptsOpen((v) => {
      localStorage.setItem("td.scriptsPanel", v ? "0" : "1");
      return !v;
    });
  }, []);

  const resizeSidebar = useCallback((w: number) => {
    setSidebarWidth(w);
    localStorage.setItem("td.sidebarWidth", String(Math.round(w)));
  }, []);

  // ---------- global shortcuts ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".modal-backdrop")) return;
      const mod = e.ctrlKey || e.metaKey;
      const tab = tabsRef.current.find((t) => t.id === activeRef.current);
      const list = tabsRef.current;
      let handled = true;
      if (mod && e.shiftKey && e.code === "KeyK") {
        toggleSidebar(true);
        requestAnimationFrame(() => document.getElementById("server-search")?.focus());
      } else if (mod && e.shiftKey && e.code === "KeyN") {
        setNewInFolder(undefined);
        setEditing(null);
      }
      else if (mod && e.shiftKey && e.code === "KeyW" && tab) closePane(tab.id, tab.focus);
      else if (mod && e.shiftKey && e.code === "KeyD" && tab) duplicateTab(tab.id);
      else if (mod && e.key === "Tab" && list.length) {
        const i = list.findIndex((t) => t.id === activeRef.current);
        const n = (i + (e.shiftKey ? -1 : 1) + list.length) % list.length;
        setActive(list[n].id);
      } else if (mod && e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const t = list[Number(e.code.slice(5)) - 1];
        if (t) setActive(t.id);
      } else if (e.altKey && e.shiftKey && !mod && (e.code === "Equal" || e.code === "NumpadAdd") && tab) splitTab(tab.id, "row");
      else if (e.altKey && e.shiftKey && !mod && (e.code === "Minus" || e.code === "NumpadSubtract") && tab) splitTab(tab.id, "column");
      else if (e.altKey && !e.shiftKey && !mod && e.key.startsWith("Arrow") && tab && tab.panes.length > 1) {
        const i = tab.panes.findIndex((p) => p.id === tab.focus);
        const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
        const n = (i + (back ? -1 : 1) + tab.panes.length) % tab.panes.length;
        focusPane(tab.id, tab.panes[n].id);
      } else if (e.altKey && !e.shiftKey && !mod && e.code === "Digit1") toggleSidebar();
      else if (e.altKey && !e.shiftKey && !mod && e.code === "Digit2") toggleScripts();
      else handled = false;
      if (handled) {
        // Keep the shortcut away from the terminal.
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closePane, duplicateTab, splitTab, focusPane, toggleSidebar, toggleScripts]);

  // ---------- derived ----------

  const serverStates = useMemo(() => {
    const m: Record<string, ServerState> = {};
    for (const t of tabs)
      for (const p of t.panes) {
        const st = (m[p.serverId] ??= { status: "idle", connected: 0, open: 0 });
        st.open++;
        if (p.status === "connected") st.connected++;
        if (STATUS_RANK[p.status] > STATUS_RANK[st.status]) st.status = p.status;
      }
    return m;
  }, [tabs]);

  const titleTabs = useMemo<TitleTab[]>(() => {
    const seen = new Map<string, number>();
    return tabs.map((t) => {
      const names = [...new Set(t.panes.map((p) => servers.find((s) => s.id === p.serverId)?.name ?? "?"))];
      let title = names.join(" | ");
      if (t.panes.length > 1 && names.length === 1) title += ` ×${t.panes.length}`;
      const n = (seen.get(title) ?? 0) + 1;
      seen.set(title, n);
      const focus = t.panes.find((p) => p.id === t.focus) ?? t.panes[0];
      return {
        id: t.id,
        title: n > 1 ? `${title} (${n})` : title,
        status: focus.status,
        color: servers.find((s) => s.id === focus.serverId)?.color,
        panes: t.panes.length,
      };
    });
  }, [tabs, servers]);

  // ---------- folders ----------

  const addServer = (folder?: string) => {
    setNewInFolder(folder);
    setEditing(null);
  };

  const createFolder = async () => {
    const name = (await ui.prompt("Новая папка", "Название папки"))?.trim();
    if (!name) return;
    if (folders.includes(name)) return ui.toast(`Папка «${name}» уже есть`, "error");
    try {
      setFolders(await api.saveFolders([...folders, name]));
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  const renameFolder = async (from: string) => {
    const to = (await ui.prompt("Переименовать папку", "Название папки", from))?.trim();
    if (!to || to === from) return;
    try {
      await api.renameFolder(from, to);
      await reloadServers();
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  const deleteFolder = async (name: string) => {
    const n = servers.filter((s) => s.group?.trim() === name).length;
    const msg = n ? `Серверы из неё (${n}) останутся в списке, без папки.` : undefined;
    if (!(await ui.confirm(`Удалить папку «${name}»?`, msg, true))) return;
    try {
      await api.deleteFolder(name);
      await reloadServers();
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };

  /** folder: "" = out of any folder. */
  const moveToFolder = async (ids: string[], folder: string) => {
    try {
      for (const id of ids) {
        const s = servers.find((x) => x.id === id);
        if (!s || (s.group?.trim() ?? "") === folder) continue;
        const saved = await api.saveServer({ ...s, group: folder || null });
        setServers((l) => l.map((x) => (x.id === saved.id ? saved : x)));
      }
      if (folder) setFolders((l) => (l.includes(folder) ? l : [...l, folder]));
    } catch (e) {
      ui.toast(errorText(e), "error");
    }
  };
  const running = transfers.filter((t) => t.progress.status === "running").length;

  const tabMenu = (e: React.MouseEvent, id: string) => {
    setActive(id);
    ui.menu(e, [
      { label: "Дублировать в новой вкладке", icon: <ICopy size={13} />, hint: "Ctrl+Shift+D", onClick: () => duplicateTab(id) },
      { label: "Разделить вправо", icon: <ISplitRight size={13} />, hint: "Alt+Shift+=", onClick: () => splitTab(id, "row") },
      { label: "Разделить вниз", icon: <ISplitDown size={13} />, hint: "Alt+Shift+-", onClick: () => splitTab(id, "column") },
      "-",
      { label: "Закрыть вкладку", icon: <IClose size={13} />, onClick: () => closeTab(id) },
      { label: "Закрыть другие вкладки", disabled: tabs.length < 2, onClick: () => closeOtherTabs(id) },
    ]);
  };

  const newTabMenu = (e: React.MouseEvent<HTMLElement>) => {
    const items: MenuItem[] = [];
    for (const [group, list] of groupServers(servers, "", folders)) {
      if (group) items.push({ header: group });
      for (const s of list) items.push({ label: s.name, icon: <IPlay size={13} />, hint: s.host, onClick: () => openSession(s, true) });
    }
    if (items.length) items.push("-");
    items.push({ label: "Добавить сервер…", icon: <IPlus size={13} />, hint: "Ctrl+Shift+N", onClick: () => addServer() });
    ui.menu(e.currentTarget, items);
  };

  return (
    <div className="app">
      <TitleBar
        tabs={titleTabs}
        active={active}
        onSelect={setActive}
        onClose={closeTab}
        onTabMenu={tabMenu}
        onNewTab={newTabMenu}
        left={
          <>
            <button className={`tb-brand ${active === null ? "on" : ""}`} onClick={() => setActive(null)} title="Главная">
              <img src="/logo.svg" alt="" />
              <span>TermDock</span>
            </button>
            <button className={`icon-btn tb-tool ${sidebarOpen ? "on" : ""}`} onClick={() => toggleSidebar()} title="Панель серверов (Alt+1)">
              <ISidebar size={15} />
            </button>
            <button className={`icon-btn tb-tool ${active === null ? "on" : ""}`} onClick={() => setActive(null)} title="Все серверы">
              <IHome size={15} />
            </button>
          </>
        }
        right={
          <>
            <button className={`tb-btn ${scriptsOpen ? "on" : ""}`} onClick={toggleScripts} title="Скрипты (Alt+2)">
              <IScript size={14} /> Скрипты{scripts.length ? <span className="muted">{scripts.length}</span> : null}
            </button>
            <button className={`tb-btn ${showTransfers ? "on" : ""}`} onClick={() => setShowTransfers(!showTransfers)} title="Передачи файлов">
              <ITransfer size={14} /> Передачи{running ? <span className="badge">{running}</span> : null}
            </button>
          </>
        }
      />
      <div className="workspace">
        {sidebarOpen && (
          <Sidebar
            servers={servers}
            states={serverStates}
            width={sidebarWidth}
            onResize={resizeSidebar}
            onConnect={openSession}
            onSplitOpen={activeTab ? (s, dir) => splitTab(activeTab.id, dir, s.id) : null}
            folders={folders}
            onAdd={addServer}
            onEdit={(s) => setEditing(s)}
            onDelete={deleteServer}
            onAddFolder={createFolder}
            onRenameFolder={renameFolder}
            onDeleteFolder={deleteFolder}
            onMove={moveToFolder}
          />
        )}
        <main className="content">
          {active === null && <Home servers={servers} folders={folders} states={serverStates} onConnect={openSession} onAdd={() => addServer()} />}
          {tabs.map((t) => (
            <TabView
              key={t.id}
              tab={t}
              servers={servers}
              visible={t.id === active}
              handlers={(paneId) => handlers(t.id, paneId)}
              onSizes={(sizes) => updateTab(t.id, (x) => ({ ...x, sizes }))}
            />
          ))}
          {showTransfers && <TransfersPanel onClose={() => setShowTransfers(false)} />}
        </main>
        {scriptsOpen && (
          <ScriptsPanel
            paneId={focusedPane?.status === "connected" ? focusedPane.id : null}
            target={focusedServer && focusedPane?.status === "connected" ? focusedServer.name : null}
            onClose={toggleScripts}
          />
        )}
      </div>
      {editing !== undefined && <ServerDialog server={editing} servers={servers} folders={folders} folder={editing ? undefined : newInFolder} onClose={() => setEditing(undefined)} onSaved={onSaved} />}
      <WindowEdges />
    </div>
  );
}

function Home({
  servers,
  folders,
  states,
  onConnect,
  onAdd,
}: {
  servers: Server[];
  folders: string[];
  states: Record<string, ServerState>;
  onConnect: (s: Server) => void;
  onAdd: () => void;
}) {
  const grouped = groupServers(servers, "", folders);
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
                {list.map((s) => {
                  const st = states[s.id];
                  return (
                    <button key={s.id} className="card" onClick={() => onConnect(s)}>
                      <span className="card-stripe" style={{ background: s.color || "#58a6ff" }} />
                      <div className="card-name">
                        {st && <span className={`status-dot ${st.status}`} />}
                        {s.name}
                      </div>
                      <div className="card-host">
                        {s.username}@{s.host}
                        {s.port !== 22 ? `:${s.port}` : ""}
                      </div>
                      <div className="card-meta">
                        {s.auth === "key" ? (
                          <>
                            <IKey size={12} /> ключ
                          </>
                        ) : (
                          <>
                            <ILock size={12} /> {s.hasSecret ? "пароль сохранён" : "пароль"}
                          </>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
        <div className="shortcuts">
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> поиск</span>
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> новый сервер</span>
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> дублировать вкладку</span>
          <span><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>=</kbd> / <kbd>-</kbd> разделить вправо / вниз</span>
          <span><kbd>Alt</kbd>+<kbd>←→</kbd> переход между панелями</span>
          <span><kbd>Alt</kbd>+<kbd>1</kbd> / <kbd>2</kbd> серверы / скрипты</span>
          <span><kbd>Ctrl</kbd>+<kbd>Tab</kbd> след. вкладка</span>
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C/V</kbd> копировать/вставить</span>
          <span>ПКМ по файлу, вкладке или серверу — меню действий</span>
        </div>
      </div>
    </div>
  );
}
