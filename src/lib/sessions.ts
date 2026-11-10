// Live terminal panes, so app-level features (scripts, plugins, the title bar) can talk to them.

import type { SessionStatus } from "../components/SessionView";

export interface PaneHandle {
  serverId: string;
  serverName: string;
  host: string;
  port: number;
  username: string;
  /** Backend session id while connected. */
  sessionId: () => string | null;
  status: () => SessionStatus;
  /** Sends raw input to the shell. Returns false when the pane is not connected. */
  send: (text: string) => boolean;
  /** Starts a step-by-step run: sends the first command, the rest one per click. False when not connected. */
  runSteps: (name: string, steps: string[]) => boolean;
  focus: () => void;
}

const panes = new Map<string, PaneHandle>();

export const paneRegistry = {
  set: (id: string, h: PaneHandle) => void panes.set(id, h),
  delete: (id: string) => {
    if (panes.delete(id)) paneEvents.emit({ type: "removed", paneId: id });
  },
  get: (id: string | null | undefined) => (id ? panes.get(id) : undefined),
  all: () => [...panes],
};

// What happens in the panes, for listeners outside React (the plugin host).

export type PaneEvent =
  | { type: "status"; paneId: string; status: SessionStatus }
  | { type: "output"; paneId: string; data: Uint8Array }
  | { type: "focus"; paneId: string | null }
  | { type: "removed"; paneId: string };

const paneListeners = new Set<(e: PaneEvent) => void>();

export const paneEvents = {
  on(fn: (e: PaneEvent) => void) {
    paneListeners.add(fn);
    return () => void paneListeners.delete(fn);
  },
  emit(e: PaneEvent) {
    for (const fn of paneListeners) fn(e);
  },
};

let focused: string | null = null;

/** The pane with keyboard focus in the visible tab (null on the home screen). */
export const focusedPane = {
  get: () => focused,
  set(id: string | null) {
    if (id === focused) return;
    focused = id;
    paneEvents.emit({ type: "focus", paneId: id });
  },
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
