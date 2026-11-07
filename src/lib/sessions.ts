// Live terminal panes, so app-level features (scripts, the title bar) can talk to them.

export interface PaneHandle {
  serverId: string;
  /** Sends raw input to the shell. Returns false when the pane is not connected. */
  send: (text: string) => boolean;
  /** Starts a step-by-step run: sends the first command, the rest one per click. False when not connected. */
  runSteps: (name: string, steps: string[]) => boolean;
  focus: () => void;
}

const panes = new Map<string, PaneHandle>();

export const paneRegistry = {
  set: (id: string, h: PaneHandle) => void panes.set(id, h),
  delete: (id: string) => void panes.delete(id),
  get: (id: string | null | undefined) => (id ? panes.get(id) : undefined),
};

// Remote file panes with an open SFTP session, for server-to-server copies.

export interface RemotePaneHandle {
  serverId: string;
  serverName: string;
  sessionId: string;
  /** Folder currently open in the pane (null while loading). */
  dir: () => string | null;
  refresh: () => void;
}

const remotePanes = new Map<string, RemotePaneHandle>();

export const remotePaneRegistry = {
  set: (paneId: string, h: RemotePaneHandle) => void remotePanes.set(paneId, h),
  delete: (paneId: string) => void remotePanes.delete(paneId),
  get: (paneId: string) => remotePanes.get(paneId),
  /** All registered panes except `paneId`, in registration order. */
  others: (paneId: string) => [...remotePanes].filter(([id]) => id !== paneId).map(([id, h]) => ({ paneId: id, ...h })),
};
