import { ReactNode, useEffect, useState } from "react";
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

interface Props {
  tabs: TitleTab[];
  active: string | null;
  left: ReactNode;
  right: ReactNode;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTabMenu: (e: React.MouseEvent, id: string) => void;
  onNewTab: (e: React.MouseEvent<HTMLElement>) => void;
}

const win = () => getCurrentWindow();

/**
 * Custom window frame (the native one is disabled): app tools on the left, session tabs in the
 * middle, tool windows and window controls on the right — like JetBrains IDEs.
 * Empty areas carry `data-tauri-drag-region`, so the window can be dragged / double-click maximized.
 */
export function TitleBar({ tabs, active, left, right, onSelect, onClose, onTabMenu, onNewTab }: Props) {
  const tr = useT();
  const [maximized, setMaximized] = useState(false);

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
            className={`tab ${t.id === active ? "active" : ""}`}
            onMouseDown={(e) => e.button === 0 && onSelect(t.id)}
            onAuxClick={(e) => e.button === 1 && onClose(t.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onTabMenu(e, t.id);
            }}
            title={`${t.title}${t.panes > 1 ? tr("titlebar.panes", { n: t.panes }) : ""}\n${tr("titlebar.tabHint")}`}
          >
            <span className="tab-accent" style={{ background: t.color || "transparent" }} />
            <span className={`status-dot ${t.status}`} />
            <span className="tab-title">{t.title}</span>
            <button
              className="tab-close"
              onMouseDown={(e) => e.stopPropagation()}
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
