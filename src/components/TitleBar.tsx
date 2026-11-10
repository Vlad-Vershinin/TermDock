import { ReactNode, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ICapClose, ICapMax, ICapMin, ICapRestore, IClose, IPlus } from "./Icons";
import { SessionStatus } from "./SessionView";
import { useT } from "../lib/i18n";

export interface TitleTab {
  id: string;
  title: string;
  status: SessionStatus;
  color?: string | null;
  panes: number;
}

/** Where a tab dropped onto a terminal goes, relative to the pane under the pointer. */
export type DropSide = "left" | "right" | "top" | "bottom";

interface Props {
  tabs: TitleTab[];
  active: string | null;
  left: ReactNode;
  right: ReactNode;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTabMenu: (e: React.MouseEvent, id: string) => void;
  onNewTab: (e: React.MouseEvent<HTMLElement>) => void;
  /** Moves a tab to another position in the strip. */
  onReorder: (id: string, index: number) => void;
  /** Moves a tab's panes into another tab, next to the pane under the pointer. */
  onMerge: (id: string, paneId: string, side: DropSide) => void;
  /** Tab whose name is being edited. */
  renaming: string | null;
  onRenameStart: (id: string) => void;
  /** null: cancelled; "": back to the automatic name. */
  onRename: (id: string, title: string | null) => void;
}

const win = () => getCurrentWindow();

/**
 * Custom window frame (the native one is disabled): app tools on the left, session tabs in the
 * middle, tool windows and window controls on the right — like JetBrains IDEs.
 * Empty areas carry `data-tauri-drag-region`, so the window can be dragged / double-click maximized.
 */
export function TitleBar({ tabs, active, left, right, onSelect, onClose, onTabMenu, onNewTab, onReorder, onMerge, renaming, onRenameStart, onRename }: Props) {
  const tr = useT();
  const [maximized, setMaximized] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // The drag handlers live for the whole gesture; they read the latest props through a ref.
  const latest = useRef({ tabs, onSelect, onReorder, onMerge });
  latest.current = { tabs, onSelect, onReorder, onMerge };

  /**
   * A click selects the tab. A drag along the strip reorders tabs live; a drag down onto a
   * terminal shows where the tab's panes would go and moves them there on release.
   */
  const startTabDrag = (e: React.PointerEvent, id: string, title: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("input, .tab-close")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let ghost: HTMLDivElement | null = null;
    let target: { el: HTMLElement; paneId: string; side: DropSide } | null = null;

    const setTarget = (t: typeof target) => {
      if (target?.el !== t?.el || target?.side !== t?.side) {
        if (target) delete target.el.dataset.drop;
        if (t) t.el.dataset.drop = t.side;
      }
      target = t;
    };
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        setDraggingId(id);
        document.body.classList.add("tab-dragging");
      }
      const bar = strip.current!.getBoundingClientRect();
      const inStrip = ev.clientY < bar.bottom + 8;
      if (inStrip) {
        ghost?.remove();
        ghost = null;
        setTarget(null);
        // Index among the other tabs: how many of them have their middle left of the pointer.
        const others = [...strip.current!.querySelectorAll<HTMLElement>("[data-tab]")].filter((el) => el.dataset.tab !== id);
        const index = others.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left + r.width / 2 < ev.clientX;
        }).length;
        const { tabs: list, onReorder: reorder } = latest.current;
        if (list.findIndex((t) => t.id === id) !== index) reorder(id, index);
        return;
      }
      if (!ghost) {
        ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.textContent = title;
        document.body.appendChild(ghost);
      }
      ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
      setTarget(dropTarget(ev.clientX, ev.clientY, id));
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", esc, true);
      ghost?.remove();
      document.body.classList.remove("tab-dragging");
      setDraggingId(null);
      const t = target;
      setTarget(null);
      if (!dragging) return commit && latest.current.onSelect(id);
      if (commit && t) latest.current.onMerge(id, t.paneId, t.side);
    };
    const up = () => finish(true);
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", esc, true);
  };

  useEffect(() => {
    const w = win();
    w.isMaximized().then(setMaximized).catch(() => {});
    const un = w.onResized(() => w.isMaximized().then(setMaximized).catch(() => {}));
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("maximized", maximized);
  }, [maximized]);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tb-left">{left}</div>
      <div
        ref={strip}
        className="tb-tabs"
        data-tauri-drag-region
        onWheel={(e) => {
          // Vertical wheel scrolls the tab strip horizontally.
          if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t) => (
          <div
            key={t.id}
            data-tab={t.id}
            className={`tab ${t.id === active ? "active" : ""} ${t.id === draggingId ? "dragged" : ""}`}
            onPointerDown={(e) => startTabDrag(e, t.id, t.title)}
            onDoubleClick={(e) => !(e.target as HTMLElement).closest(".tab-close") && onRenameStart(t.id)}
            onAuxClick={(e) => e.button === 1 && onClose(t.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onTabMenu(e, t.id);
            }}
            title={`${t.title}${t.panes > 1 ? tr("titlebar.panes", { n: t.panes }) : ""}\n${tr("titlebar.tabHint")}`}
          >
            <span className="tab-accent" style={{ background: t.color || "transparent" }} />
            <span className={`status-dot ${t.status}`} />
            {renaming === t.id ? (
              <TabNameInput value={t.title} onDone={(v) => onRename(t.id, v)} />
            ) : (
              <span className="tab-title">{t.title}</span>
            )}
            <button
              className="tab-close"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              title={tr("titlebar.closeTab")}
            >
              <IClose size={11} />
            </button>
          </div>
        ))}
        <button className="icon-btn tb-new" onClick={onNewTab} title={tr("titlebar.newTab")}>
          <IPlus size={14} />
        </button>
        <div className="tb-drag" data-tauri-drag-region />
      </div>
      <div className="tb-right">{right}</div>
      <div className="win-controls">
        <button className="win-btn" onClick={() => win().minimize()} title={tr("titlebar.minimize")}>
          <ICapMin />
        </button>
        <button className="win-btn" onClick={() => win().toggleMaximize()} title={maximized ? tr("titlebar.restore") : tr("titlebar.maximize")}>
          {maximized ? <ICapRestore /> : <ICapMax />}
        </button>
        <button className="win-btn close" onClick={() => win().close()} title={tr("common.close")}>
          <ICapClose />
        </button>
      </div>
    </header>
  );
}

/** The pane under the pointer in another tab, and which side of it the dropped tab would take. */
function dropTarget(x: number, y: number, srcTab: string): { el: HTMLElement; paneId: string; side: DropSide } | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pane-id]");
  const view = el?.closest<HTMLElement>("[data-tab-id]");
  if (!el || !view || view.dataset.tabId === srcTab) return null;
  const r = el.getBoundingClientRect();
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  let side: DropSide;
  if (view.querySelectorAll("[data-pane-id]").length > 1) {
    // Panes of a tab are laid out in one direction: only sides along it.
    side = view.dataset.dir === "column" ? (fy < 0.5 ? "top" : "bottom") : fx < 0.5 ? "left" : "right";
  } else {
    const edges: [number, DropSide][] = [
      [fx, "left"],
      [1 - fx, "right"],
      [fy, "top"],
      [1 - fy, "bottom"],
    ];
    side = edges.reduce((a, b) => (b[0] < a[0] ? b : a))[1];
  }
  return { el, paneId: el.dataset.paneId!, side };
}

function TabNameInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="tab-rename"
      defaultValue={value}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value.trim());
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value.trim())}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      size={Math.max(6, value.length)}
    />
  );
}

type Dir = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

/** Invisible resize handles along the window edges (needed without native decorations on Linux). */
export function WindowEdges() {
  const edges: [string, Dir][] = [
    ["n", "North"],
    ["s", "South"],
    ["e", "East"],
    ["w", "West"],
    ["ne", "NorthEast"],
    ["nw", "NorthWest"],
    ["se", "SouthEast"],
    ["sw", "SouthWest"],
  ];
  return (
    <>
      {edges.map(([cls, dir]) => (
        <div
          key={cls}
          className={`win-edge ${cls}`}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            win().startResizeDragging(dir).catch(() => {});
          }}
        />
      ))}
    </>
  );
}
