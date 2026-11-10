import { useRef } from "react";
import { SessionStatus } from "./SessionView";

export type SplitDir = "row" | "column";

export interface PaneState {
  id: string;
  serverId: string;
  status: SessionStatus;
}

export interface Tab {
  id: string;
  /** Name set by the user; otherwise the tab is named after its servers. */
  title?: string;
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
  visible: boolean;
  /** Persistent container of a pane's SessionView (rendered by App through a portal). */
  host: (paneId: string) => HTMLElement;
  onSizes: (sizes: number[]) => void;
}

export function TabView({ tab, visible, host, onSizes }: Props) {
  const ref = useRef<HTMLDivElement>(null);
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
    <div ref={ref} className={`tabview ${tab.dir}`} style={{ display: visible ? "flex" : "none" }} data-tab-id={tab.id} data-dir={tab.dir}>
      {tab.panes.map((p, i) => (
        // SessionViews are not rendered here: App portals them into persistent containers that
        // are only moved between wrappers, so splitting, closing neighbours or moving a pane to
        // another tab never remounts one (that would drop its SSH connection).
        <div key={p.id} className="pane-wrap" style={{ flex: `${tab.sizes[i] ?? 1} 1 0` }} data-pane-id={p.id}>
          {i > 0 ? <div className="pane-splitter" onPointerDown={startResize(i)} /> : null}
          <PaneSlot host={host(p.id)} />
        </div>
      ))}
    </div>
  );
}

function PaneSlot({ host }: { host: HTMLElement }) {
  return <div className="pane-slot" ref={(el) => void (el && host.parentElement !== el && el.appendChild(host))} />;
}
