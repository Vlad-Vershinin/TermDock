// Shared by the background code and the panel: builds and runs tmux commands on the server.
// Chats are windows of one tmux session, so Claude keeps running when the SSH connection drops.
(function () {
  const SESSION = "claude";
  const t = (x) => termdock.i18n.t(x);

  // A single-quoted POSIX word: safe for any value (quotes, $, `, ! included).
  const q = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";

  // A path for sh: a leading ~ becomes "$HOME" (tilde isn't expanded inside quotes).
  function path(v) {
    if (v === "~") return '"$HOME"';
    if (v.startsWith("~/")) return '"$HOME"/' + q(v.slice(2));
    return q(v);
  }

  function required(value, what) {
    const v = String(value || "").trim();
    if (!v || /[\r\n]/.test(v)) throw new Error(t({ ru: `${what}: укажите значение в одну строку`, en: `${what}: enter a single-line value` }));
    return v;
  }

  // The script goes to `sh -s` through stdin, so the user's login shell (fish, csh…) never parses it.
  async function sh(paneId, script) {
    const r = await termdock.server.exec(paneId, "sh -s", { stdin: script, timeout: 20000 });
    if (r.code !== 0 && r.code !== null) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
    return r.stdout;
  }

  const FMT = "#{window_id}|#{window_index}|#{window_active}|#{session_attached}|#{pane_current_command}|#{window_name}|#{pane_current_path}";

  // { tmux: false } when tmux isn't installed; otherwise the chats (possibly none).
  async function list(paneId) {
    const out = await sh(paneId, `command -v tmux >/dev/null 2>&1 || { echo NO_TMUX; exit 0; }\ntmux list-windows -t ${q("=" + SESSION)} -F ${q(FMT)} 2>/dev/null\ntrue\n`);
    if (out.trim() === "NO_TMUX") return { tmux: false, attached: 0, chats: [] };
    const chats = out
      .split("\n")
      .filter((l) => l.startsWith("@"))
      .map((l) => {
        const [id, index, active, attached, command, name, ...rest] = l.split("|");
        return { id, index: Number(index), active: active === "1", attached: Number(attached) || 0, command, name, path: rest.join("|") };
      });
    return { tmux: true, attached: chats.length ? chats[0].attached : 0, chats };
  }

  // Creates a chat window (and the session if needed) and starts Claude in it. Typing the command
  // into the window's shell (instead of running it directly) loads the user's PATH from their rc
  // files, and keeps the window open with a shell when Claude exits.
  async function create(paneId, { name, dir, command }) {
    name = required(name, t({ ru: "Название", en: "Name" }));
    dir = required(dir, t({ ru: "Папка", en: "Folder" }));
    command = required(command, t({ ru: "Команда", en: "Command" }));
    const opts = `-n ${q(name)} -c ${path(dir)} -P -F '#{window_id}'`;
    const out = await sh(
      paneId,
      [
        `command -v tmux >/dev/null 2>&1 || { echo "tmux is not installed" >&2; exit 1; }`,
        `if tmux has-session -t ${q("=" + SESSION)} 2>/dev/null; then w=$(tmux new-window -t ${q(SESSION + ":")} ${opts}); else w=$(tmux new-session -d -s ${q(SESSION)} ${opts}); fi || exit 1`,
        `tmux send-keys -t "$w" -l ${q(command)} && tmux send-keys -t "$w" Enter && echo "$w"`,
      ].join("\n") + "\n",
    );
    return out.trim();
  }

  const winId = (id) => {
    if (!/^@\d+$/.test(id)) throw new Error("bad window id");
    return id;
  };
  const select = (paneId, id) => sh(paneId, `tmux select-window -t ${q(winId(id))}\n`);
  const kill = (paneId, id) => sh(paneId, `tmux kill-window -t ${q(winId(id))}\n`);

  // Typed into a terminal that already runs a shell. -d drops clients of a connection that died
  // but wasn't noticed by the server yet; otherwise tmux would size the window to the stale client.
  const ATTACH = `tmux attach -d -t ${SESSION}\r`;

  // Run instead of the login shell on connect (sessions.onBeforeShell): attach when there are
  // chats, then (or right away) the user's usual login shell, so a tmux detach leaves a working
  // terminal. Wrapped in sh -c '…' because the command itself is parsed by the login shell.
  const SHELL_COMMAND = `sh -c 'tmux has-session -t "=${SESSION}" 2>/dev/null && tmux attach -d -t "${SESSION}"; exec "\${SHELL:-sh}" -l'`;

  window.claudeTmux = { SESSION, list, create, select, kill, required, ATTACH, SHELL_COMMAND };
})();
