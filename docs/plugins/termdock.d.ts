// Types of the TermDock plugin API (apiVersion 1): the global `termdock` object available in a
// plugin's main script and in its panels. Add to your editor with:
//   /// <reference path="./termdock.d.ts" />
// or copy it next to your plugin and list it in jsconfig.json / tsconfig.json.

declare namespace TermDock {
  type Lang = "ru" | "en";
  /** A display text: a plain string or one per UI language. */
  type LText = string | Partial<Record<Lang, string>>;

  type Permission =
    | "terminal.read"
    | "terminal.write"
    | "server.exec"
    | "files.read"
    | "files.write"
    | "servers.read"
    | "clipboard.write"
    | "openUrl"
    | "notifications"
    | "sessions.open"
    | "sessions.shell";

  /** An open terminal pane (one SSH session). */
  interface Session {
    /** Stable id of the pane; pass it to terminal / server / files calls. */
    paneId: string;
    serverId: string;
    serverName: string;
    host: string;
    port: number;
    username: string;
    status: "connecting" | "connected" | "closed" | "error";
    /** The pane has keyboard focus in the visible tab. */
    focused: boolean;
    /** Terminal title (OSC 0/2); sessions.list / sessions.active, plugins with terminal.read only. */
    title?: string;
  }

  /** What `sessions.onBeforeShell` gets: the session about to open. */
  interface ShellTarget {
    paneId: string;
    serverId: string;
    serverName: string;
    host: string;
    port: number;
    username: string;
  }

  /** How a command shows in menus and the palette (`commands.setState`). */
  interface CommandState {
    title?: LText;
    /** Draws a check mark (true) or an empty slot (false) instead of the plugin icon. */
    checked?: boolean;
    /** false: hidden from the palette, greyed out in menus. */
    enabled?: boolean;
  }

  /** What a command receives, depending on where it was run from. */
  interface CommandContext {
    /** Palette, keybinding, tab and session menus: the session; file menu: the pane of the file panel. */
    paneId?: string | null;
    /** Tab menu: all panes of the tab. */
    paneIds?: string[];
    /** Server menu: the server. */
    serverId?: string;
    /** File menu: which side, the selected paths and the open folder. */
    side?: "local" | "remote";
    paths?: string[];
    dir?: string | null;
  }

  interface FileEntry {
    name: string;
    path: string;
    isDir: boolean;
    isLink: boolean;
    size: number;
    /** Unix time in seconds. */
    modified?: number | null;
    /** Unix permission bits. */
    mode?: number | null;
  }

  interface ExecResult {
    /** Exit code (null when the server didn't report one). */
    code: number | null;
    stdout: string;
    stderr: string;
  }

  interface Server {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    group: string | null;
    color: string | null;
  }

  interface Events {
    /** Terminal output (UTF-8 text with escape sequences), batched ~50 ms. Needs terminal.read. */
    "terminal.output": { paneId: string; text: string };
    "session.connected": Session;
    /** Login output has settled and the connect script was sent: safe to type into the terminal. */
    "session.ready": Session;
    /** A program set the terminal title (OSC 0/2). Needs terminal.read. */
    "terminal.title": { paneId: string; title: string };
    /** Another page of this plugin called `termdock.post`; from = "main" or a panel id. */
    "message": { from: string; data: unknown };
    "session.closed": { paneId: string };
    /** The focused session changed (null: the home screen). */
    "session.focus": Session | null;
    /** Another frame of this plugin changed its storage. */
    "storage.changed": { key: string };
    "language": Lang;
    /** Panels: the context changed (e.g. the session of a session panel). */
    "context": Record<string, unknown>;
  }

  interface Api {
    /** Resolves when the app has sent the plugin's info (calls may be made earlier). */
    readonly ready: Promise<void>;
    readonly plugin: { id: string; name: string; version: string } | null;
    readonly language: Lang;
    /** Permissions the user granted. */
    readonly permissions: Permission[];
    /** Session panels: `{ paneId }`; other frames: `{}`. */
    readonly context: { paneId?: string } & Record<string, unknown>;

    on<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): () => void;

    commands: {
      /** Handles a command declared in plugin.json. Returning a rejected promise shows the error to the user. */
      register(id: string, handler: (context: CommandContext) => unknown): () => void;
      /** Runs one of this plugin's own commands (from any of its pages); resolves with the handler's result. */
      execute(id: string, context?: CommandContext): Promise<unknown>;
      /** Changes how the command shows; with `serverId`, for that server only. */
      setState(id: string, state: CommandState, options?: { serverId?: string }): Promise<void>;
    };

    /** Sends data to this plugin's other pages (their "message" event). JSON up to 1 MB. */
    post(data: unknown): Promise<void>;

    ui: {
      toast(message: string, kind?: "info" | "success" | "error"): Promise<void>;
      confirm(title: string, message?: string): Promise<boolean>;
      /** null when cancelled. */
      prompt(title: string, label?: string, value?: string): Promise<string | null>;
      /** Opens a panel declared in plugin.json. Session panels open under `paneId` (default: the focused session). */
      openPanel(panelId: string, paneId?: string): Promise<void>;
      /** Closes the panel this code runs in. */
      closePanel(): Promise<void>;
      /** A system notification while TermDock is in the background, a toast otherwise. Needs notifications. */
      notify(title: string, body?: string): Promise<void>;
    };

    sessions: {
      list(): Promise<Session[]>;
      /** The focused session, or null. */
      active(): Promise<Session | null>;
      /**
       * Opens a connection to a saved server: a new tab, or `split` next to `nearPaneId` (default: the
       * focused pane). Resolves with the new paneId. Needs sessions.open; `command` also needs sessions.shell.
       */
      open(serverId: string, options?: { command?: string; split?: "row" | "column"; nearPaneId?: string }): Promise<string>;
      /**
       * Before every connection and reconnect: return a command to run instead of the login shell
       * (a string or { command }), or null for the usual shell. Answer within 2 s. Background code
       * only; needs sessions.shell. The connect script doesn't run in such sessions.
       */
      onBeforeShell(fn: (target: ShellTarget) => string | { command: string } | null | undefined | Promise<string | { command: string } | null | undefined>): () => void;
    };

    terminal: {
      /** Types into the shell. "\r" is Enter. Needs terminal.write. */
      send(paneId: string, data: string): Promise<void>;
    };

    server: {
      /**
       * Runs a command on the server over a separate channel, not in the terminal. Output is limited
       * to 10 MB, `timeout` (ms) to 1 s…10 min, 30 s by default. Needs server.exec.
       * `stdin` (up to 1 MB) is written to the command: `exec(id, "sh -s", { stdin: script })` runs a
       * POSIX script without the login shell (fish, csh…) parsing it first.
       */
      exec(paneId: string, command: string, options?: { timeout?: number; stdin?: string }): Promise<ExecResult>;
    };

    files: {
      /** Needs files.read. */
      home(paneId: string): Promise<string>;
      /** Needs files.read. */
      list(paneId: string, path: string): Promise<FileEntry[]>;
      /** Decoded text (encoding detected); files over 5 MB are refused. Needs files.read. */
      readText(paneId: string, path: string): Promise<string>;
      /** Writes UTF-8 text (creates or replaces the file). Needs files.write. */
      writeText(paneId: string, path: string, content: string): Promise<void>;
    };

    servers: {
      /** All saved servers, without secrets or key paths. Needs servers.read. */
      list(): Promise<Server[]>;
    };

    /** The plugin's own data (JSON values, up to 5 MB in total), kept across restarts. */
    storage: {
      get<T = unknown>(key: string): Promise<T | null>;
      set(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<void>;
      all(): Promise<Record<string, unknown>>;
    };

    clipboard: {
      /** Needs clipboard.write. */
      writeText(text: string): Promise<void>;
    };

    /** Opens an http(s) link in the browser. Needs openUrl. */
    openUrl(url: string): Promise<void>;

    i18n: {
      /** Picks the UI language from `{ ru, en }`; a string is returned as is. */
      t(text: LText): string;
    };
  }
}

declare const termdock: TermDock.Api;
interface Window {
  termdock: TermDock.Api;
}
