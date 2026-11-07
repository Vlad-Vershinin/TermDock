import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, AuthMethod, configJumpText, errorText, Jump, Server, SshConfigInfo } from "../lib/api";
import { useUi } from "../lib/ui";
import { useScripts } from "./Scripts";

export const COLORS = ["#58a6ff", "#3fb950", "#d29922", "#ff7b72", "#bc8cff", "#39c5cf", "#f778ba", "#8b949e"];

const empty: Server = { id: "", name: "", host: "", port: 22, username: "root", auth: "password", keyPath: "", group: "", color: COLORS[0], remoteDir: "", hasSecret: false };

const emptyJump: Jump = { serverId: null, host: "", port: 22, username: "root", auth: "password", keyPath: "", hasSecret: false };

type JumpMode = "none" | "saved" | "custom";

interface Props {
  server: Server | null;
  /** All saved servers (candidates for the jump host). */
  servers: Server[];
  folders: string[];
  /** Folder preselected for a new server. */
  folder?: string;
  onClose: () => void;
  onSaved: (s: Server, connect: boolean) => void;
}

// Accept "user@host:port" (or "ssh user@host") in a host field; parsed when leaving the field.
function parseHost<T extends { host: string; username: string; port: number }>(s0: T): T {
  const m = s0.host.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
  return m && (m[1] || m[3]) ? { ...s0, host: m[2], username: m[1] ?? s0.username, port: m[3] ? Number(m[3]) : s0.port } : s0;
}

/** Whether connecting to `s` goes through the server `id` (directly or via other jump hosts). */
function goesThrough(s: Server, id: string, all: Server[], depth = 0): boolean {
  if (s.id === id) return true;
  const via = s.jump?.serverId && all.find((x) => x.id === s.jump!.serverId);
  return !!via && depth < 10 && goesThrough(via, id, all, depth + 1);
}

export function ServerDialog({ server, servers, folders, folder, onClose, onSaved }: Props) {
  const ui = useUi();
  const { scripts, edit: editScript } = useScripts();
  const [s, setS] = useState<Server>(() => ({ ...empty, group: folder ?? "", ...server }));
  const [secret, setSecret] = useState("");
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jumpMode, setJumpMode] = useState<JumpMode>(() => (server?.jump?.serverId ? "saved" : server?.jump?.host ? "custom" : "none"));
  const [jump, setJump] = useState<Jump>(() => ({ ...emptyJump, ...server?.jump }));
  const [jumpSecret, setJumpSecret] = useState("");
  const [jumpForget, setJumpForget] = useState(false);
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [jumpOpen] = useState(jumpMode !== "none");
  const set = <K extends keyof Server>(k: K, v: Server[K]) => setS((x) => ({ ...x, [k]: v }));
  // What ~/.ssh/config says about the typed host (HostName / ProxyJump hints).
  const [sshCfg, setSshCfg] = useState<SshConfigInfo | null>(null);
  useEffect(() => {
    const host = parseHost(s).host.trim();
    if (!host) return setSshCfg(null);
    let stop = false;
    const t = setTimeout(() => {
      api.sshConfigLookup(host, Number(s.port) || 22).then((c) => !stop && setSshCfg(c), () => !stop && setSshCfg(null));
    }, 300);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [s.host, s.port]);
  const setJ = <K extends keyof Jump>(k: K, v: Jump[K]) => setJump((x) => ({ ...x, [k]: v }));

  // A server can't go through itself, or through a server that already goes through it.
  const jumpCandidates = servers.filter((x) => !s.id || !goesThrough(x, s.id, servers));
  const folderOptions = [...new Set([...folders, ...extraFolders, ...(s.group?.trim() ? [s.group.trim()] : [])])];

  const pickKey = async (apply: (path: string) => void) => {
    const f = await openDialog({ title: "Приватный ключ SSH", multiple: false });
    if (typeof f === "string") apply(f);
  };

  const pickFolder = async (v: string) => {
    if (v !== "\0new") return set("group", v);
    const name = (await ui.prompt("Новая папка", "Название папки"))?.trim();
    if (!name) return;
    setExtraFolders((l) => [...l, name]);
    set("group", name);
  };

  const buildJump = (): Jump | null => {
    if (jumpMode === "saved") return jump.serverId ? { ...emptyJump, serverId: jump.serverId } : null;
    if (jumpMode === "custom") {
      const j = parseHost(jump);
      return j.host.trim() ? { ...j, serverId: null, host: j.host.trim(), username: j.username.trim(), port: Number(j.port) || 22 } : null;
    }
    return null;
  };

  const save = async (connect: boolean) => {
    if (jumpMode === "saved" && !jump.serverId) return ui.toast("Выберите сервер-посредник", "error");
    if (jumpMode === "custom" && !jump.host.trim()) return ui.toast("Укажите хост сервера-посредника", "error");
    setBusy(true);
    try {
      const p = parseHost(s);
      const toSave: Server = {
        ...p,
        name: s.name.trim() || p.host.trim(),
        host: p.host.trim(),
        username: p.username.trim(),
        port: Number(p.port) || 22,
        group: s.group?.trim() || null,
        jump: buildJump(),
      };
      const js = jumpMode === "custom" ? (jumpForget ? "" : jumpSecret || undefined) : undefined;
      const saved = await api.saveServer(toSave, forget ? "" : secret ? secret : undefined, js);
      onSaved(saved, connect);
    } catch (e) {
      ui.toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const isKey = s.auth === "key";

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal modal-wide"
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h3>{server?.id ? "Редактировать сервер" : "Новый сервер"}</h3>
        <div className="grid2">
          <label className="field span2">
            <span>Хост</span>
            <input autoFocus value={s.host} onChange={(e) => set("host", e.target.value)} onBlur={() => setS(parseHost)} placeholder="192.168.1.10 или user@example.com:2222" spellCheck={false} />
            {sshCfg && (sshCfg.hostname || sshCfg.port !== (Number(s.port) || 22)) && (
              <span className="hint">
                Из ~/.ssh/config: адрес {sshCfg.hostname ?? parseHost(s).host.trim()}
                {sshCfg.port !== 22 ? `:${sshCfg.port}` : ""}
              </span>
            )}
          </label>
          <label className="field">
            <span>Пользователь</span>
            <input value={s.username} onChange={(e) => set("username", e.target.value)} spellCheck={false} />
          </label>
          <label className="field">
            <span>Порт</span>
            <input type="number" min={1} max={65535} value={s.port} onChange={(e) => set("port", Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Название</span>
            <input value={s.name} onChange={(e) => set("name", e.target.value)} placeholder={s.host || "prod-web-1"} />
          </label>
          <label className="field">
            <span>Папка</span>
            <select value={s.group?.trim() ?? ""} onChange={(e) => pickFolder(e.target.value)}>
              <option value="">Без папки</option>
              {folderOptions.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              <option value={"\0new"}>+ Новая папка…</option>
            </select>
          </label>
        </div>

        <AuthSwitch value={s.auth} onChange={(m) => set("auth", m)} />

        {isKey && (
          <label className="field">
            <span>Приватный ключ</span>
            <div className="row">
              <input value={s.keyPath ?? ""} onChange={(e) => set("keyPath", e.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
              <button type="button" className="btn" onClick={() => pickKey((f) => set("keyPath", f))}>
                Обзор…
              </button>
            </div>
          </label>
        )}
        {s.auth === "agent" ? (
          <p className="hint">{AGENT_HINT}</p>
        ) : (
          <>
            <label className="field">
              <span>{isKey ? "Passphrase ключа (если есть)" : "Пароль"}</span>
              <input
                type="password"
                value={secret}
                disabled={forget}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={s.hasSecret ? "•••••• сохранён — оставьте пустым, чтобы не менять" : isKey ? "необязательно" : "оставьте пустым, чтобы спрашивать при подключении"}
              />
            </label>
            {s.hasSecret && (
              <label className="check">
                <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} />
                Забыть сохранённый {isKey ? "passphrase" : "пароль"}
              </label>
            )}
            <p className="hint">Пароли хранятся в системном хранилище (Windows Credential Manager / GNOME Keyring / KWallet), не в файле настроек.</p>
          </>
        )}

        <details open={jumpOpen}>
          <summary>Подключение через сервер-посредник{jumpMode !== "none" ? " — включено" : ""}</summary>
          <p className="hint">Как ssh -J: сначала подключение к серверу-посреднику (bastion), через него — к этому серверу.</p>
          {sshCfg?.error && <p className="hint err">~/.ssh/config: {sshCfg.error}</p>}
          {sshCfg && sshCfg.jumps.length > 0 && (
            <p className="hint" title={sshCfg.jumps.map((j) => `${j.alias}: ${j.label}`).join("\n")}>
              Из ~/.ssh/config: через {configJumpText(sshCfg)}
              {jumpMode === "none" ? " — будет использовано при подключении «Напрямую»." : " — не используется: настройка посредника здесь важнее."}
            </p>
          )}
          <div className="segmented">
            {(
              [
                ["none", "Напрямую"],
                ["saved", "Сохранённый сервер"],
                ["custom", "Другой сервер"],
              ] as const
            ).map(([m, label]) => (
              <button type="button" key={m} className={jumpMode === m ? "on" : ""} onClick={() => setJumpMode(m)}>
                {label}
              </button>
            ))}
          </div>
          {jumpMode === "saved" && (
            <label className="field">
              <span>Сервер-посредник</span>
              <select value={jump.serverId ?? ""} onChange={(e) => setJ("serverId", e.target.value || null)}>
                <option value="">— выберите —</option>
                {jumpCandidates.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.username}@{x.host}
                    {x.port !== 22 ? `:${x.port}` : ""}){x.jump ? " — сам через посредника" : ""}
                  </option>
                ))}
              </select>
              {jumpCandidates.length === 0 && <span className="hint">Нет других сохранённых серверов — выберите «Другой сервер».</span>}
            </label>
          )}
          {jumpMode === "custom" && (
            <JumpFields
              jump={jump}
              set={setJ}
              onBlurHost={() => setJump(parseHost)}
              onPickKey={() => pickKey((f) => setJ("keyPath", f))}
              secret={jumpSecret}
              setSecret={setJumpSecret}
              forget={jumpForget}
              setForget={setJumpForget}
            />
          )}
        </details>

        <details open={!!server?.connectScript}>
          <summary>Скрипт при подключении{s.connectScript ? " — включён" : ""}</summary>
          <label className="field">
            <span>Выполнять после каждого подключения</span>
            <select value={s.connectScript ?? ""} onChange={(e) => set("connectScript", e.target.value || null)}>
              <option value="">— не выполнять —</option>
              {scripts.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.mode === "bash" ? " (bash)" : x.steps ? " (по шагам)" : ""}
                </option>
              ))}
              {s.connectScript && !scripts.some((x) => x.id === s.connectScript) && <option value={s.connectScript}>(скрипт удалён)</option>}
            </select>
          </label>
          <p className="hint">
            Скрипт запускается в терминале, когда сервер закончит выводить приветствие, — например <code>sudo apt update</code>. Скрипты
            создаются в панели «Скрипты» (Alt+2){" "}
            <button type="button" className="link-btn" onClick={() => editScript(null)}>
              или прямо сейчас
            </button>
            .
          </p>
        </details>

        <details>
          <summary>Дополнительно</summary>
          <label className="field">
            <span>Папка на сервере для файловой панели</span>
            <input value={s.remoteDir ?? ""} onChange={(e) => set("remoteDir", e.target.value)} placeholder="домашняя папка" spellCheck={false} />
          </label>
          <div className="field">
            <span>Цвет</span>
            <div className="colors">
              {COLORS.map((c) => (
                <button type="button" key={c} className={`color ${s.color === c ? "on" : ""}`} style={{ background: c }} onClick={() => set("color", c)} />
              ))}
            </div>
          </div>
        </details>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn" disabled={busy || !s.host.trim()}>
            Сохранить
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !s.host.trim()} onClick={() => save(true)}>
            Сохранить и подключиться
          </button>
        </div>
      </form>
    </div>
  );
}

function JumpFields(p: {
  jump: Jump;
  set: <K extends keyof Jump>(k: K, v: Jump[K]) => void;
  onBlurHost: () => void;
  onPickKey: () => void;
  secret: string;
  setSecret: (v: string) => void;
  forget: boolean;
  setForget: (v: boolean) => void;
}) {
  const { jump, set } = p;
  const isKey = jump.auth === "key";
  return (
    <>
      <div className="grid2">
        <label className="field span2">
          <span>Хост посредника</span>
          <input value={jump.host} onChange={(e) => set("host", e.target.value)} onBlur={p.onBlurHost} placeholder="bastion.example.com или user@host:port" spellCheck={false} />
        </label>
        <label className="field">
          <span>Пользователь</span>
          <input value={jump.username} onChange={(e) => set("username", e.target.value)} spellCheck={false} />
        </label>
        <label className="field">
          <span>Порт</span>
          <input type="number" min={1} max={65535} value={jump.port} onChange={(e) => set("port", Number(e.target.value))} />
        </label>
      </div>
      <AuthSwitch value={jump.auth} onChange={(m) => set("auth", m)} />
      {isKey && (
        <label className="field">
          <span>Приватный ключ посредника</span>
          <div className="row">
            <input value={jump.keyPath ?? ""} onChange={(e) => set("keyPath", e.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
            <button type="button" className="btn" onClick={p.onPickKey}>
              Обзор…
            </button>
          </div>
        </label>
      )}
      {jump.auth === "agent" ? (
        <p className="hint">{AGENT_HINT}</p>
      ) : (
        <>
          <label className="field">
            <span>{isKey ? "Passphrase ключа посредника (если есть)" : "Пароль посредника"}</span>
            <input
              type="password"
              value={p.secret}
              disabled={p.forget}
              onChange={(e) => p.setSecret(e.target.value)}
              placeholder={jump.hasSecret ? "•••••• сохранён — оставьте пустым, чтобы не менять" : isKey ? "необязательно" : "оставьте пустым, чтобы спрашивать при подключении"}
            />
          </label>
          {jump.hasSecret && (
            <label className="check">
              <input type="checkbox" checked={p.forget} onChange={(e) => p.setForget(e.target.checked)} />
              Забыть сохранённый {isKey ? "passphrase" : "пароль"} посредника
            </label>
          )}
        </>
      )}
    </>
  );
}

const AGENT_HINT =
  "Ключи берутся из запущенного SSH-агента (ssh-agent; в Windows — служба OpenSSH Authentication Agent или Pageant). Пароль не нужен — добавьте ключ в агент командой ssh-add.";

const AUTH_LABELS: [AuthMethod, string][] = [
  ["password", "Пароль"],
  ["key", "SSH-ключ"],
  ["agent", "SSH-агент"],
];

function AuthSwitch({ value, onChange }: { value: AuthMethod; onChange: (m: AuthMethod) => void }) {
  return (
    <div className="segmented">
      {AUTH_LABELS.map(([m, label]) => (
        <button type="button" key={m} className={value === m ? "on" : ""} onClick={() => onChange(m)}>
          {label}
        </button>
      ))}
    </div>
  );
}
