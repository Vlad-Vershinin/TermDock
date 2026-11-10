// Plugin manifest (plugin.json) as the UI reads it. Rust validates the basics (id, apiVersion,
// main, permissions); `contributes` is checked here and bad entries are skipped.

import type { Lang } from "../i18n";

/** A display text: a plain string or one per UI language. */
export type LText = string | Partial<Record<Lang, string>>;

export const PERMISSIONS = [
  "terminal.read",
  "terminal.write",
  "server.exec",
  "files.read",
  "files.write",
  "servers.read",
  "clipboard.write",
  "openUrl",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Permissions that let a plugin act on servers; shown in red when installing. */
export const DANGEROUS: Permission[] = ["terminal.write", "server.exec", "files.write"];

export interface Manifest {
  id: string;
  name: LText;
  version: string;
  description?: LText;
  author?: string | null;
  homepage?: string | null;
  apiVersion: number;
  main: string;
  permissions: Permission[];
  contributes?: unknown;
}

export interface PluginInfo {
  id: string;
  manifest: Manifest | null;
  enabled: boolean;
  granted: Permission[];
  error: string | null;
  path: string;
}

export type MenuWhere = "tab" | "server" | "file" | "session";
export type PanelLocation = "sidebar" | "session" | "dialog";

export interface PluginCommand {
  pluginId: string;
  id: string;
  title: LText;
}

export interface MenuEntry {
  pluginId: string;
  command: string;
  /** file menu only: show for local or remote files (both when unset). */
  side?: "local" | "remote";
}

export interface PluginPanel {
  pluginId: string;
  id: string;
  title: LText;
  location: PanelLocation;
  /** HTML file inside the plugin. */
  entry: string;
  /** Dialog panels: size in CSS pixels. */
  width?: number;
  height?: number;
}

export interface Keybinding {
  pluginId: string;
  command: string;
  /** e.g. "Ctrl+Alt+H"; Ctrl also matches Cmd on macOS. */
  key: string;
}

export interface Contributions {
  commands: PluginCommand[];
  menus: Record<MenuWhere, MenuEntry[]>;
  panels: PluginPanel[];
  keybindings: Keybinding[];
}

/** Picks the text for the UI language (falls back to English, then any). */
export function ltext(v: LText | undefined | null, lang: Lang): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v[lang] ?? v.en ?? Object.values(v).find((x) => typeof x === "string") ?? "";
}

const isText = (v: unknown): v is LText =>
  typeof v === "string" || (!!v && typeof v === "object" && Object.values(v).every((x) => typeof x === "string"));
const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][\w.-]{0,63}$/.test(v);
const isRelPath = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !v.startsWith("/") && !v.split(/[\\/]/).includes("..");
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

/** The usable part of `contributes` for one plugin. */
export function readContributions(m: Manifest): Contributions {
  const c = (m.contributes && typeof m.contributes === "object" ? m.contributes : {}) as Record<string, unknown>;
  const commands: PluginCommand[] = list(c.commands)
    .filter((x) => isId(x.id) && isText(x.title))
    .map((x) => ({ pluginId: m.id, id: x.id as string, title: x.title as LText }));
  const known = new Set(commands.map((x) => x.id));

  const menusRaw = (c.menus && typeof c.menus === "object" ? c.menus : {}) as Record<string, unknown>;
  const menus = { tab: [], server: [], file: [], session: [] } as Contributions["menus"];
  for (const where of Object.keys(menus) as MenuWhere[]) {
    menus[where] = list(menusRaw[where])
      .filter((x) => typeof x.command === "string" && known.has(x.command))
      .map((x) => ({
        pluginId: m.id,
        command: x.command as string,
        side: x.side === "local" || x.side === "remote" ? x.side : undefined,
      }));
  }

  const panels: PluginPanel[] = list(c.panels)
    .filter((x) => isId(x.id) && isText(x.title) && isRelPath(x.entry) && ["sidebar", "session", "dialog"].includes(x.location as string))
    .map((x) => ({
      pluginId: m.id,
      id: x.id as string,
      title: x.title as LText,
      location: x.location as PanelLocation,
      entry: x.entry as string,
      width: typeof x.width === "number" ? x.width : undefined,
      height: typeof x.height === "number" ? x.height : undefined,
    }));

  const keybindings: Keybinding[] = list(c.keybindings)
    .filter((x) => typeof x.command === "string" && known.has(x.command) && typeof x.key === "string" && parseKey(x.key))
    .map((x) => ({ pluginId: m.id, command: x.command as string, key: x.key as string }));

  return { commands, menus, panels, keybindings };
}

interface KeySpec {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** "Ctrl+Alt+H" → spec; null when malformed or without a modifier (plain keys belong to the terminal). */
export function parseKey(s: string): KeySpec | null {
  const parts = s.split("+").map((p) => p.trim().toLowerCase());
  const key = parts.pop();
  if (!key) return null;
  const spec = { ctrl: false, alt: false, shift: false, key };
  for (const p of parts) {
    if (p === "ctrl" || p === "cmd" || p === "mod") spec.ctrl = true;
    else if (p === "alt" || p === "option") spec.alt = true;
    else if (p === "shift") spec.shift = true;
    else return null;
  }
  const fKey = /^f([1-9]|1[0-2])$/.test(key);
  return spec.ctrl || spec.alt || fKey ? spec : null;
}

/** Whether a keydown matches "Ctrl+Alt+H" (letters and digits by physical key, like app shortcuts). */
export function matchKey(e: KeyboardEvent, s: string): boolean {
  const k = parseKey(s);
  if (!k) return false;
  if (k.ctrl !== (e.ctrlKey || e.metaKey) || k.alt !== e.altKey || k.shift !== e.shiftKey) return false;
  if (/^[a-z]$/.test(k.key)) return e.code === `Key${k.key.toUpperCase()}`;
  if (/^[0-9]$/.test(k.key)) return e.code === `Digit${k.key}`;
  return e.key.toLowerCase() === k.key;
}
