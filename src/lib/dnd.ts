// Drag & drop without HTML5 DnD: with Tauri's native file drop enabled, HTML5 drag events
// inside the webview are unreliable (notably on Windows), so we track the pointer ourselves.
//
// Drop targets are elements with `data-dropzone="<zoneId>"`. Folder rows inside a zone can
// carry `data-dropdir="<path>"` to receive the drop into that folder.
// Targets get a `td-drop` CustomEvent with a DropDetail.

export type DragSource =
  | { kind: "local" | "remote"; tabId: string; paths: string[] }
  | { kind: "os"; paths: string[] }
  /** Servers dragged in the sidebar (into / out of folders). */
  | { kind: "server"; ids: string[]; paths?: undefined };

export interface DropDetail {
  source: DragSource;
  /** Folder row under the pointer, if any. */
  dir?: string;
}

function findTarget(x: number, y: number) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const zone = el?.closest<HTMLElement>("[data-dropzone]") ?? null;
  const dirEl = el?.closest<HTMLElement>("[data-dropdir]") ?? null;
  return { zone, dirEl: dirEl && zone?.contains(dirEl) ? dirEl : null };
}

let highlighted: HTMLElement[] = [];
function highlight(els: (HTMLElement | null)[]) {
  for (const h of highlighted) h.classList.remove("drop-hover");
  highlighted = els.filter((e): e is HTMLElement => !!e);
  for (const h of highlighted) h.classList.add("drop-hover");
}

/** Highlights (and on drop, notifies) the zone under a point. Used for both internal and OS drags. */
export function hoverAt(x: number, y: number, source: DragSource | null) {
  const { zone, dirEl } = findTarget(x, y);
  if (!zone || !source || !accepts(zone, source)) return highlight([]);
  highlight([zone, dirEl]);
}

export function dropAt(x: number, y: number, source: DragSource) {
  const { zone, dirEl } = findTarget(x, y);
  highlight([]);
  if (!zone || !accepts(zone, source)) return;
  const detail: DropDetail = { source, dir: dirEl?.dataset.dropdir };
  zone.dispatchEvent(new CustomEvent<DropDetail>("td-drop", { detail }));
}

export function clearHover() {
  highlight([]);
}

function accepts(zone: HTMLElement, source: DragSource) {
  const accept = (zone.dataset.accept ?? "").split(",");
  return accept.includes(source.kind);
}

/** Pointer at (or past) the window border. While the button is held the webview keeps the
 * mouse captured, so moves past the border are still reported and a small margin suffices. */
function atWindowEdge(ev: PointerEvent, margin: number) {
  return ev.clientX <= margin || ev.clientY <= margin || ev.clientX >= window.innerWidth - margin || ev.clientY >= window.innerHeight - margin;
}

/** Call from a row's onPointerDown. Starts a drag after the pointer moves a few pixels.
 * With `onLeaveWindow`, a drag reaching the window border is cancelled and handed over to it
 * (used to start a native drag into the OS file manager). */
export function beginDrag(e: React.PointerEvent, getSource: () => DragSource, label: string, onLeaveWindow?: (source: DragSource) => void) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let source: DragSource | null = null;

  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      source = getSource();
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = label;
      document.body.appendChild(ghost);
      document.body.classList.add("dragging");
    }
    if (onLeaveWindow && atWindowEdge(ev, 2)) return leave();
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
    hoverAt(ev.clientX, ev.clientY, source);
  };
  // Fallback when no move past the border is reported: the pointer left the document near an edge.
  const out = (ev: PointerEvent) => {
    if (!ev.relatedTarget && atWindowEdge(ev, 8)) leave();
  };
  const leave = () => {
    const s = source;
    if (!ghost || !s || !onLeaveWindow) return;
    // Cancel the internal drag like Escape does, then hand over.
    source = null;
    clearHover();
    up(new PointerEvent("pointerup"));
    onLeaveWindow(s);
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointerout", out);
    window.removeEventListener("keydown", esc);
    if (ghost) {
      ghost.remove();
      document.body.classList.remove("dragging");
      if (source) dropAt(ev.clientX, ev.clientY, source);
      // A drag that ends on the row it started from must not also count as a click.
      const stop = (ce: MouseEvent) => ce.stopPropagation();
      window.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
    }
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    source = null;
    clearHover();
    up(new PointerEvent("pointerup"));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  if (onLeaveWindow) window.addEventListener("pointerout", out);
  window.addEventListener("keydown", esc);
}
