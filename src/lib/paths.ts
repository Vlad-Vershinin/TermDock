// Path helpers for both sides. Remote paths are always POSIX; local paths may be Windows.

const isWin = (p: string) => /^[A-Za-z]:/.test(p) || p.includes("\\");

export function joinPath(dir: string, name: string, remote: boolean): string {
  const sep = !remote && isWin(dir) ? "\\" : "/";
  if (dir === "") return name;
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** Parent directory. On Windows the parent of "C:\" is "" (the drive list). */
export function parentPath(p: string, remote: boolean): string {
  if (!remote && isWin(p)) {
    const trimmed = p.replace(/\\+$/, "");
    if (/^[A-Za-z]:$/.test(trimmed)) return "";
    const i = trimmed.lastIndexOf("\\");
    const parent = trimmed.slice(0, i);
    return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
  }
  if (p === "/" || p === "") return "/";
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDate(sec?: number | null): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatMode(mode?: number | null): string {
  if (mode == null) return "";
  const chars = "rwxrwxrwx";
  let s = "";
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : "-";
  return s;
}
