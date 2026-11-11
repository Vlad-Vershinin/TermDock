import { Channel, invoke } from "@tauri-apps/api/core";
import type { Manifest, PluginInfo } from "./plugins/types";

export type AuthMethod = "password" | "key" | "agent";

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath?: string | null;
  /** Folder name; empty = not in a folder. */
  group?: string | null;
  color?: string | null;
  remoteDir?: string | null;
  /** Local folder for "download to the downloads folder"; empty = the global setting. */
  downloadDir?: string | null;
  hasSecret: boolean;
  /** Connect through this jump host. */
  jump?: Jump | null;
  /** Saved script (id) to run right after connecting. */
  connectScript?: string | null;
  /** Port forwards started with every connection. */
  forwards?: Forward[];
}

export type ForwardKind = "local" | "remote" | "dynamic";

/** Port forward. For "remote" the bind address is on the server and the destination is local. */
export interface Forward {
  id: string;
  kind: ForwardKind;
  bindHost: string;
  bindPort: number;
  destHost: string;
  destPort: number;
  enabled: boolean;
}

export interface ForwardStatus extends Forward {
  /** Added in the session only, not saved with the server. */
  temporary: boolean;
  /** "active" | "stopped" | "starting" | "error: …" */
  status: string;
  /** The port actually bound (when bindPort is 0). */
  boundPort?: number | null;
  connections: number;
}

/** Jump host: a saved server (`serverId`) or one described by the fields below. */
export interface Jump {
  serverId?: string | null;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath?: string | null;
  hasSecret: boolean;
}

/** Keychain / prompt id of a server's custom jump host (matches the Rust side). */
export const jumpHopId = (serverId: string) => `${serverId}#jump`;

/** What ~/.ssh/config defines for a host (see `ssh_config_lookup`). */
export interface SshConfigInfo {
  /** Real address when HostName differs from the typed host. */
  hostname?: string | null;
  port: number;
  /** ProxyJump chain, outermost first. */
  jumps: { alias: string; label: string }[];
  error?: string | null;
}

/** "bastion → gw" for a ProxyJump chain from ~/.ssh/config. */
export const configJumpText = (c: SshConfigInfo) => c.jumps.map((j) => j.alias).join(" → ");

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  modified?: number | null;
  mode?: number | null;
}

/** Output arrives as raw bytes; the end of the session as a JSON object. */
export type TermEvent = { type: "data"; data: Uint8Array } | { type: "closed"; reason: string };

export interface Progress {
  id: string;
  transferred: number;
  total: number;
  filesDone: number;
  filesTotal: number;
  current: string;
  status: "running" | "done" | "error" | "cancelled";
  error?: string | null;
}

export interface Script {
  id: string;
  name: string;
  description?: string | null;
  body: string;
  /** terminal: typed into the shell; bash: run as one bash script */
  mode: "terminal" | "bash";
  /** Terminal mode only: send one line per click instead of the whole script. */
  steps?: boolean;
}

export interface Disk {
  fs: string;
  mount: string;
  total: number;
  used: number;
}

export interface Stats {
  cpu?: number | null;
  cpus?: number | null;
  /** Percent per logical core; empty when unknown. */
  cores?: number[];
  load?: [number, number, number] | null;
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  uptime?: number | null;
  disks: Disk[];
  os?: string | null;
  hostname?: string | null;
}

/** Global app settings (`settings.json`, mirror of `settings::Settings`). */
export interface Settings {
  language: "ru" | "en";
  /** Webview zoom, percent. */
  uiScale: number;
  /** Empty = the built-in monospace font stack. */
  termFontFamily: string;
  termFontSize: number;
  termLineHeight: number;
  termCursorStyle: "block" | "bar" | "underline";
  termCursorBlink: boolean;
  termScrollback: number;
  termCopyOnSelect: boolean;
  /** copyPaste: copy the selection, otherwise paste. */
  termRightClick: "copyPaste" | "paste" | "none";
  /** Empty = the OS Downloads folder. */
  downloadDir: string;
  askDownloadDir: boolean;
  showHidden: boolean;
  localStartDir: "last" | "downloads";
  /** Look for a new release on GitHub at startup and every hour. */
  checkUpdates: boolean;
}

/** How an update is installed; "manual" = only the release page. */
export type UpdateMethod = "nsis" | "msi" | "appimage" | "deb" | "rpm" | "pacman" | "manual";

export interface UpdateInfo {
  current: string;
  latest: string;
  /** The latest release is newer than this copy. */
  available: boolean;
  /** Release notes (Markdown). */
  notes: string;
  url: string;
  publishedAt: string | null;
  method: UpdateMethod;
  asset: string | null;
  size: number | null;
}

export type UpdateProgress = { phase: "download"; received: number; total: number } | { phase: "install" };

export interface PluginExecOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const api = {
  listServers: () => invoke<Server[]>("list_servers"),
  /** secret: undefined = keep, "" = forget, string = save */
  /** secret / jumpSecret: undefined = keep, "" = forget, string = save */
  saveServer: (server: Server, secret?: string, jumpSecret?: string) => invoke<Server>("save_server", { server, secret, jumpSecret }),
  deleteServer: (id: string) => invoke<void>("delete_server", { id }),
  reorderServers: (ids: string[]) => invoke<void>("reorder_servers", { ids }),

  listScripts: () => invoke<Script[]>("list_scripts"),
  saveScript: (script: Script) => invoke<Script>("save_script", { script }),
  deleteScript: (id: string) => invoke<void>("delete_script", { id }),

  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (value: Settings) => invoke<Settings>("save_settings", { value }),
  settingsFirstRun: () => invoke<boolean>("settings_first_run"),
  /** Resolved downloads folder: the server's own, else the global one, else the OS Downloads (`~` expanded). */
  downloadDir: (serverDir?: string | null, global?: string) => invoke<string>("download_dir", { serverDir: serverDir ?? null, global: global ?? null }),
  openLocalPath: (path: string) => invoke<void>("open_local_path", { path }),

  listFolders: () => invoke<string[]>("list_folders"),
  saveFolders: (names: string[]) => invoke<string[]>("save_folders", { names }),
  renameFolder: (from: string, to: string) => invoke<void>("rename_folder", { from, to }),
  deleteFolder: (name: string) => invoke<void>("delete_folder", { name }),

  /** secrets / accept are keyed by hop id: a server id or `jumpHopId(serverId)`. */
  connect: (args: {
    serverId: string;
    secrets?: Record<string, string>;
    /** Hop ids whose typed secret should be saved after a successful connection. */
    remember?: string[];
    /** Confirmed host key fingerprints. */
    accept?: Record<string, string>;
    cols: number;
    rows: number;
    onEvent: (e: TermEvent) => void;
  }) => {
    const events = new Channel<ArrayBuffer | Uint8Array | number[] | { type: "closed"; reason: string }>();
    events.onmessage = (m) => {
      if (m instanceof ArrayBuffer) args.onEvent({ type: "data", data: new Uint8Array(m) });
      else if (m instanceof Uint8Array) args.onEvent({ type: "data", data: m });
      else if (Array.isArray(m)) args.onEvent({ type: "data", data: Uint8Array.from(m) });
      else args.onEvent(m);
    };
    return invoke<string>("ssh_connect", {
      serverId: args.serverId,
      secrets: args.secrets,
      remember: args.remember,
      accept: args.accept,
      cols: args.cols,
      rows: args.rows,
      events,
    });
  },
  sshConfigLookup: (host: string, port?: number) => invoke<SshConfigInfo | null>("ssh_config_lookup", { host, port }),
  write: (sessionId: string, data: Uint8Array) => invoke<void>("ssh_write", { sessionId, data: Array.from(data) }),
  resize: (sessionId: string, cols: number, rows: number) => invoke<void>("ssh_resize", { sessionId, cols, rows }),
  disconnect: (sessionId: string) => invoke<void>("ssh_disconnect", { sessionId }),

  forwards: (sessionId: string) => invoke<ForwardStatus[]>("ssh_forwards", { sessionId }),
  /** A forward with an unknown (or empty) id is added for this session only. */
  forwardStart: (sessionId: string, forward: Forward) => invoke<ForwardStatus>("ssh_forward_start", { sessionId, forward }),
  forwardStop: (sessionId: string, id: string, remove = false) => invoke<void>("ssh_forward_stop", { sessionId, id, remove }),

  stats: (sessionId: string) => invoke<Stats>("remote_stats", { sessionId }),

  localHome: () => invoke<string>("local_home"),
  localList: (path: string) => invoke<Entry[]>("local_list", { path }),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),
  localRemove: (path: string) => invoke<void>("local_remove", { path }),
  localRename: (from: string, to: string) => invoke<void>("local_rename", { from, to }),

  localReadText: (path: string, opts: ReadTextOptions = {}) =>
    invoke<TextFile>("local_read_text", { path, encoding: opts.encoding ?? null, allowLarge: opts.allowLarge ?? false }),
  localWriteText: (path: string, content: string, enc: TextEncoding) =>
    invoke<void>("local_write_text", { path, content, encoding: enc.encoding, bom: enc.bom }),
  localCreateFile: (path: string) => invoke<void>("local_create_file", { path }),

  remoteReadText: (sessionId: string, path: string, opts: ReadTextOptions = {}) =>
    invoke<TextFile>("remote_read_text", { sessionId, path, encoding: opts.encoding ?? null, allowLarge: opts.allowLarge ?? false }),
  remoteWriteText: (sessionId: string, path: string, content: string, enc: TextEncoding) =>
    invoke<void>("remote_write_text", { sessionId, path, content, encoding: enc.encoding, bom: enc.bom }),
  remoteCreateFile: (sessionId: string, path: string) => invoke<void>("remote_create_file", { sessionId, path }),

  remoteHome: (sessionId: string) => invoke<string>("remote_home", { sessionId }),
  remoteList: (sessionId: string, path: string) => invoke<Entry[]>("remote_list", { sessionId, path }),
  remoteMkdir: (sessionId: string, path: string) => invoke<void>("remote_mkdir", { sessionId, path }),
  remoteRemove: (sessionId: string, path: string) => invoke<void>("remote_remove", { sessionId, path }),
  remoteRename: (sessionId: string, from: string, to: string) => invoke<void>("remote_rename", { sessionId, from, to }),

  upload: (sessionId: string, transferId: string, localPaths: string[], remoteDir: string) =>
    invoke<void>("upload", { sessionId, transferId, localPaths, remoteDir }),
  download: (sessionId: string, transferId: string, remotePaths: string[], localDir: string) =>
    invoke<void>("download", { sessionId, transferId, remotePaths, localDir }),
  copyBetween: (srcSessionId: string, transferId: string, remotePaths: string[], dstSessionId: string, dstDir: string) =>
    invoke<void>("copy_between", { srcSessionId, transferId, remotePaths, dstSessionId, dstDir }),
  cancelTransfer: (transferId: string) => invoke<void>("cancel_transfer", { transferId }),

  // ---- plugins ----
  updateCheck: () => invoke<UpdateInfo>("update_check"),
  /** Downloads, verifies and installs the latest release; the app restarts on success. */
  updateInstall: (onProgress: (p: UpdateProgress) => void) => {
    const ch = new Channel<UpdateProgress>();
    ch.onmessage = onProgress;
    return invoke<void>("update_install", { onProgress: ch });
  },
  updateCancel: () => invoke<void>("update_cancel"),
  pluginList: () => invoke<PluginInfo[]>("plugin_list"),
  pluginsDir: () => invoke<string>("plugins_dir"),
  /** Reads plugin.json of a folder or .zip without installing it. */
  pluginInspect: (path: string) => invoke<Manifest>("plugin_inspect", { path }),
  pluginInstall: (path: string, granted: string[]) => invoke<PluginInfo>("plugin_install", { path, granted }),
  /** granted: undefined keeps the current grants. */
  pluginSetEnabled: (id: string, enabled: boolean, granted?: string[]) => invoke<PluginInfo>("plugin_set_enabled", { id, enabled, granted }),
  pluginUninstall: (id: string) => invoke<void>("plugin_uninstall", { id }),
  pluginStorageGet: (id: string) => invoke<Record<string, unknown>>("plugin_storage_get", { id }),
  pluginStorageSet: (id: string, value: Record<string, unknown>) => invoke<void>("plugin_storage_set", { id, value }),
  pluginExec: (sessionId: string, command: string, timeoutSecs?: number) => invoke<PluginExecOutput>("plugin_exec", { sessionId, command, timeoutSecs }),
};

/** Text encoding as the backend names it ("UTF-8", "UTF-16LE", "windows-1251", ...), plus the BOM flag. */
export interface TextEncoding {
  encoding: string;
  bom: boolean;
}

/** A text file decoded for the editor. */
export interface TextFile extends TextEncoding {
  text: string;
  /** Some bytes didn't fit the encoding and were replaced with U+FFFD. */
  lossy: boolean;
}

export interface ReadTextOptions {
  /** Re-decode in this encoding instead of auto-detecting. */
  encoding?: string;
  /** Allow files over 5 MB (up to 100 MB); otherwise the read fails with `TOO_BIG|<bytes>`. */
  allowLarge?: boolean;
}

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
