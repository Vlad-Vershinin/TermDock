import { useRef } from "react";
import { Server } from "../lib/api";
import { SessionStatus, SessionView } from "./SessionView";

export type SplitDir = "row" | "column";

export interface PaneState {
  id: string;
  serverId: string;
  status: SessionStatus;
}

export interface Tab {
  id: string;
  panes: PaneState[];
  /** row = side by side, column = stacked. */
  dir: SplitDir;
  /** Relative sizes of the panes (flex-grow). */
  sizes: number[];
  /** Focused pane id. */
  focus: string;
}

export interface PaneHandlers {
  onFocus: () => void;
  onStatus: (s: SessionStatus) => void;
  onSplit: (dir: SplitDir) => void;
  onClose: () => void;
}

interface Props {
  tab: Tab;
  servers: Server[];
  visible: boolean;
  handlers: (paneId: string) => PaneHandlers;
  onSizes: (sizes: number[]) => void;
}

export function TabView({ tab, servers, visible, handlers, onSizes }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const split = tab.panes.length > 1;

  const startResize = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = ref.current!.getBoundingClientRect();
    const horizontal = tab.dir === "row";
    const length = horizontal ? rect.width : rect.height;
    const start = horizontal ? e.clientX : e.clientY;
    const sizes = [...tab.sizes];
    const sum = sizes.reduce((a, b) => a + b, 0);
    const pair = sizes[i - 1] + sizes[i];
    const min = sum * 0.12;
    const move = (ev: PointerEvent) => {
      const d = (((horizontal ? ev.clientX : ev.clientY) - start) / length) * sum;
      const a = Math.min(pair - min, Math.max(min, sizes[i - 1] + d));
      const next = [...sizes];
      next[i - 1] = a;
      next[i] = pair - a;
      onSizes(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove(horizontal ? "resizing-x" : "resizing");
    };
    document.body.classList.add(horizontal ? "resizing-x" : "resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={ref} className={`tabview ${tab.dir}`} style={{ display: visible ? "flex" : "none" }}>
      {tab.panes.map((p, i) => {
        const server = servers.find((s) => s.id === p.serverId);
        const h = handlers(p.id);
        // Keep each SessionView at a stable position in its keyed wrapper so splitting / closing
        // neighbours never remounts it (that would drop its SSH connection).
        return (
          <div key={p.id} className="pane-wrap" style={{ flex: `${tab.sizes[i] ?? 1} 1 0` }}>
            {i > 0 ? <div className="pane-splitter" onPointerDown={startResize(i)} /> : null}
            {server ? (
              <SessionView
                paneId={p.id}
                server={server}
                visible={visible}
                focused={tab.focus === p.id}
                split={split}
                onFocus={h.onFocus}
                onStatus={h.onStatus}
                onSplit={h.onSplit}
                onClose={h.onClose}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
