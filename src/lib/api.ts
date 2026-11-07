import { Channel, invoke } from "@tauri-apps/api/core";

export type AuthMethod = "password" | "key";

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath?: string | null;
  group?: string | null;
  color?: string | null;
  remoteDir?: string | null;
  hasSecret: boolean;
}

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  modified?: number | null;
  mode?: number | null;
}

export type TermEvent = { type: "data"; data: number[] } | { type: "closed"; reason: string };

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

export const api = {
  listServers: () => invoke<Server[]>("list_servers"),
  /** secret: undefined = keep, "" = forget, string = save */
  saveServer: (server: Server, secret?: string) => invoke<Server>("save_server", { server, secret }),
  deleteServer: (id: string) => invoke<void>("delete_server", { id }),
  reorderServers: (ids: string[]) => invoke<void>("reorder_servers", { ids }),

  connect: (args: {
    serverId: string;
    secret?: string;
    remember?: boolean;
    acceptFingerprint?: string;
    cols: number;
    rows: number;
    onEvent: (e: TermEvent) => void;
  }) => {
    const events = new Channel<TermEvent>();
    events.onmessage = args.onEvent;
    return invoke<string>("ssh_connect", {
      serverId: args.serverId,
      secret: args.secret,
      remember: args.remember,
      acceptFingerprint: args.acceptFingerprint,
      cols: args.cols,
      rows: args.rows,
      events,
    });
  },
  write: (sessionId: string, data: Uint8Array) => invoke<void>("ssh_write", { sessionId, data: Array.from(data) }),
  resize: (sessionId: string, cols: number, rows: number) => invoke<void>("ssh_resize", { sessionId, cols, rows }),
  disconnect: (sessionId: string) => invoke<void>("ssh_disconnect", { sessionId }),

  localHome: () => invoke<string>("local_home"),
  localList: (path: string) => invoke<Entry[]>("local_list", { path }),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),
  localRemove: (path: string) => invoke<void>("local_remove", { path }),
  localRename: (from: string, to: string) => invoke<void>("local_rename", { from, to }),

  remoteHome: (sessionId: string) => invoke<string>("remote_home", { sessionId }),
  remoteList: (sessionId: string, path: string) => invoke<Entry[]>("remote_list", { sessionId, path }),
  remoteMkdir: (sessionId: string, path: string) => invoke<void>("remote_mkdir", { sessionId, path }),
  remoteRemove: (sessionId: string, path: string) => invoke<void>("remote_remove", { sessionId, path }),
  remoteRename: (sessionId: string, from: string, to: string) => invoke<void>("remote_rename", { sessionId, from, to }),

  upload: (sessionId: string, transferId: string, localPaths: string[], remoteDir: string) =>
    invoke<void>("upload", { sessionId, transferId, localPaths, remoteDir }),
  download: (sessionId: string, transferId: string, remotePaths: string[], localDir: string) =>
    invoke<void>("download", { sessionId, transferId, remotePaths, localDir }),
  cancelTransfer: (transferId: string) => invoke<void>("cancel_transfer", { transferId }),
};

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
