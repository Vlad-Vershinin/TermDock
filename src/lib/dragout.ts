// Dragging files out of the app into the OS file manager (Explorer, Nautilus, Dolphin…).
//
// The internal pointer-based drag (dnd.ts) hands over here when the pointer leaves the
// window; we then start a native OS drag via tauri-plugin-drag.
//
// A native drag can only start while the mouse button is still held (on Windows a drag
// started after release drops instantly on whatever is under the cursor). So for remote
// files we download them into a temp folder first and start the drag only if the button is
// still held when the download ends (checked both from pointer events and from the OS).
// If it was released earlier, the files stay cached and the next drag of the same selection
// starts immediately — the toast tells the user to drag again.

import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { invoke } from "@tauri-apps/api/core";
import { errorText } from "./api";
import { t as tr } from "./i18n";
import { joinPath } from "./paths";

type Toast = (text: string, kind?: "info" | "success" | "error") => void;

/** Rust creates per-drag folders under `<tmp>/TermDock-drag/`. */
const TEMP_MARK = "TermDock-drag";
/** Downloads reused by a repeated drag of the same selection. */
const CACHE_TTL = 10 * 60 * 1000;

/** Paths of the native drag in progress (or that just ended). */
let active: string[] = [];
let dragging = false;
let pending = false;
const cache = new Map<string, { paths: string[]; at: number }>();

/** True while our own native drag runs — the window's OS drop handler must not react to it. */
export const isDraggingOut = () => dragging;

/** Our own dragged-out files dropped back onto the window must not be uploaded again. */
export function isOwnDragPath(p: string) {
  return active.includes(p) || p.split(/[\\/]/).includes(TEMP_MARK);
}

async function startOsDrag(paths: string[], toast: Toast) {
  active = paths;
  dragging = true;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    dragging = false;
    window.removeEventListener("pointerdown", end, true);
    // The window's drop event may arrive after the plugin's callback; keep filtering a bit.
    setTimeout(() => active === paths && (active = []), 2000);
  };
  // Fallback in case the platform never reports the end of the drag.
  window.addEventListener("pointerdown", end, true);
  try {
    // Windows: resolves when the drag ends. Linux/macOS: right after it starts.
    await startDrag({ item: paths, icon: DRAG_ICON, mode: "copy" }, end);
  } catch (e) {
    end();
    toast(tr("dragout.startFailed", { error: errorText(e) }), "error");
  }
}

export function dragOutLocal(paths: string[], toast: Toast) {
  if (paths.length) void startOsDrag(paths, toast);
}

export async function dragOutRemote(o: {
  /** Identifies the selection and its state (paths, sizes, mtimes) for the cache. */
  key: string;
  /** Base names of the dragged entries — what the download creates in the target folder. */
  names: string[];
  /** Likely to take a while: warn up front that the user may need to drag again. */
  big: boolean;
  /** Downloads the selection into `dir` (through the transfers panel). */
  download: (dir: string) => Promise<boolean>;
  toast: Toast;
}) {
  if (pending || !o.names.length) return;
  const hit = cache.get(o.key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return startOsDrag(hit.paths, o.toast);

  pending = true;
  let released = false;
  const onUp = () => (released = true);
  const onMove = (e: PointerEvent) => (e.buttons & 1) === 0 && (released = true);
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && (released = true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("keydown", onKey, true);
  try {
    if (o.big) o.toast(tr("dragout.downloading"));
    const dir = await invoke<string>("drag_temp_dir");
    if (!(await o.download(dir))) return; // the transfers panel already reported the error
    const paths = o.names.map((n) => joinPath(dir, n, false));
    cache.set(o.key, { paths, at: Date.now() });
    const held = !released && (await invoke<boolean>("mouse_button_held").catch(() => false));
    if (held) await startOsDrag(paths, o.toast);
    else o.toast(tr("dragout.downloaded"), "success");
  } catch (e) {
    o.toast(tr("dragout.prepareFailed", { error: errorText(e) }), "error");
  } finally {
    pending = false;
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("keydown", onKey, true);
  }
}

/** Drag preview: the 64×64 app icon. */
const DRAG_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAFf0lEQVR42u2bX2wURRjAv9ke14I5rhx/Skkl/BNJUdteiryY3GKiPlHPYPSBairhQY2J9YUXEWpStX2iJAZ9aOSibWJjlLM8mRjcIyaGFFogES2JFvEkRbG9O1vqld6NO3ul3dvdmZ1lK7e77Zds9m7YKfP77ptvvu+bHQEWuQhLCljk4rPysNg2talsBj+bx/moAKgSY6hHuPBv5K7+DIALd9IOs3f1Z1Wbtk9Rm6aP/m8qDRcFjFLylzgq83/9+cfLr/EyIU5wEWZyRxEgkTb40sEbjAOB5EPo3Z7ugGRbAeI7E8cAo1bW4B0Fr3pWttKu3ljgrXtSgNiGKyE3eUqGF90Ir+ovLUOB52IxeYpYcoLegCd3cSaXPmVpFRCPTHR5BF7pQ3zXy83pLq4pUHB4+e+8Az/fJoCwJ9ZT7Bj1FqB4e+/BkzvGuaNMCyDrPJrJj3gRfq6P3785FpuPE4osQMjhqKfhydKYnY5SpwCWIzwvwyNlGmC6AuRwMuhl+AIjBKm5AE9sP35dgtGf+yA9esFRSc2aUBi2bHwBqtdGmBYsU9RTFcADPywdcmRWd2tsULker+uADWsiFI5566IugyyzT17udnx6++v1PjY8ZqTDZnN+cuyq4xVwa3yICY/ARAEsh+cWYcJjk4IIy9u7SWjwCJtaAGOp8wA8YpfE2Ou8uywAc3EIOs2xghyNPLD7QXh48HXlqty30xXwiFkPMInwtLJidw0IK8uVq7rzadjQ+YwzNGCBQ9ClhibhrVpun0sWfQ/uq4Ut/c3gr1lZWguwwKG3AE54IpPnfoeRpl6480dmrq28di1slpVApkdJLYCTQ+cD2ImNXv698ieM7O0psgYyJTb2Pg+hloaSrQK8HMZTgJLVUeunmSz8tv8LGI8NFbVXHRah5qMmKJMVUpIpwMgKuZygLjYwkdF2CZKvnYb8P9m5tsBTW2XfsLOkTrAYHjMCIY58nncATnGCWnhmJGgXvurtCIReCRe1TXz7C6S//LEkTtAMnisZMnOCRMgcJ3OdxAVqufleAsZODpY0GdLCIyvJkLYMZSQVteug5sReWKZa+4kPSL56WlkmtdLYyLcynD8/ZH8lMILnTYYMa3AGoTBZ7tSS/ekv2RH2w3Qyo3v+k+4PYdeuMBfAwMAgHDj4xoLDcyVDtAKkUSislvRXV+DGoW+oA9uxYzs3hJVnmSm9CQe7ImSSDJHg5+6Sd7M9ASkTZ3f4SDu8tP9FLojPevtseUFeDroTNCpdG4TCww0nuId15sxZ5bqvFSETDmMnSKnbu64ixMHh4+2EPALPdoImOzauEQscPloSQduucoUFMDk4kiEafCD4kOPh1wcaTOAxOx1mbVRu237Q8Qqoqz7AhEfWiqLFu7RVVREIN3ZCaHXYkb/8nq0fyPcwNzzbCVK2qIkS1q+L2NqiNq3bY76Ulm+r3UIydD/250sNz1EPWDzwBoGQffhHH8PwpLw9ULGcr1rEG2BlbyP4vh/D8IA9eLYTRHDJ7i//f8Ar5fYVAE80Idvw8nWJHgfkIWXX7DPphYe/2//vG9jeL1/4nGI4QRyXX5GN2JnzfScRPFKPobxiHtpoa0obliKsz+fV37NTAFcH7MEXnkVxugJ8/jhM3zlmx+GRgV74ATnG4WmflU0+Tp0CsyctEl7x9gbwiQ5p1TXmS1I+AbV5Eb7wsjRqBbPX5ckxE9mAj3sNXvZvx9+XVl3kPjHS3JKRcB4i3oAnph8SwcqJER8EogjnE16ArwAUvedDU7MnLd50q9l3SKtbwc7ByU97gq3kpIWAccJN3r4MUIMZvOWArKVlahN53568ci7/p5Vy9zonwM+GtykS5JB1XrvULZgCYOns8JICPCf/AbyzQ2erq2D9AAAAAElFTkSuQmCC";
