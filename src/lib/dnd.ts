// Drag & drop without HTML5 DnD: with Tauri's native file drop enabled, HTML5 drag events
// inside the webview are unreliable (notably on Windows), so we track the pointer ourselves.
//
// Drop targets are elements with `data-dropzone="<zoneId>"`. Folder rows inside a zone can
// carry `data-dropdir="<path>"` to receive the drop into that folder.
// Targets get a `td-drop` CustomEvent with a DropDetail.

export type DragSource = { kind: "local" | "remote"; tabId: string; paths: string[] } | { kind: "os"; paths: string[] };

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

/** Call from a row's onPointerDown. Starts a drag after the pointer moves a few pixels. */
export function beginDrag(e: React.PointerEvent, getSource: () => DragSource, label: string) {
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
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
    hoverAt(ev.clientX, ev.clientY, source);
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", esc);
    if (ghost) {
      ghost.remove();
      document.body.classList.remove("dragging");
      if (source) dropAt(ev.clientX, ev.clientY, source);
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
  window.addEventListener("keydown", esc);
}
