// Files and images in the OS clipboard, for pasting them onto a server (screenshots especially).
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "./api";

/** "screenshot-2026-11-19_16-45-53" in local time. */
function screenshotName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `screenshot-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Local paths to upload: files copied in the file manager, else a clipboard image saved as PNG. */
export async function clipboardFiles(): Promise<string[]> {
  const files = await api.clipboardPaths(null);
  return files.length ? files : api.clipboardPaths(screenshotName());
}

/** What a paste into the terminal should do: copied files win over text, text over an image. */
export async function readPaste(): Promise<{ text: string } | { files: string[] } | null> {
  const files = await api.clipboardPaths(null).catch(() => []);
  if (files.length) return { files };
  const text = await readText().catch(() => "");
  if (text) return { text };
  const image = await api.clipboardPaths(screenshotName()).catch(() => []);
  return image.length ? { files: image } : null;
}

/** A path typed into a POSIX shell: quoted only when it needs to be. */
export function shellQuote(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}
