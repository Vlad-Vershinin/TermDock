import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errorText, Server } from "../lib/api";
import { useUi } from "../lib/ui";

export const COLORS = ["#58a6ff", "#3fb950", "#d29922", "#ff7b72", "#bc8cff", "#39c5cf", "#f778ba", "#8b949e"];

const empty: Server = { id: "", name: "", host: "", port: 22, username: "root", auth: "password", keyPath: "", group: "", color: COLORS[0], remoteDir: "", hasSecret: false };

interface Props {
  server: Server | null;
  groups: string[];
  onClose: () => void;
  onSaved: (s: Server, connect: boolean) => void;
}

export function ServerDialog({ server, groups, onClose, onSaved }: Props) {
  const ui = useUi();
  const [s, setS] = useState<Server>(() => ({ ...empty, ...server }));
  const [secret, setSecret] = useState("");
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Server>(k: K, v: Server[K]) => setS((x) => ({ ...x, [k]: v }));

  // Accept "user@host:port" (or "ssh user@host") in the host field; parsed when leaving the field.
  const parseHost = (s0: Server): Server => {
    const m = s0.host.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
    return m && (m[1] || m[3]) ? { ...s0, host: m[2], username: m[1] ?? s0.username, port: m[3] ? Number(m[3]) : s0.port } : s0;
  };

  const pickKey = async () => {
    const f = await openDialog({ title: "Приватный ключ SSH", multiple: false });
    if (typeof f === "string") set("keyPath", f);
  };

  const save = async (connect: boolean) => {
    setBusy(true);
    try {
      const p = parseHost(s);
      const toSave = { ...p, name: s.name.trim() || p.host.trim(), host: p.host.trim(), username: p.username.trim(), port: Number(p.port) || 22 };
      const saved = await api.saveServer(toSave, forget ? "" : secret ? secret : undefined);
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
            <span>Группа</span>
            <input value={s.group ?? ""} onChange={(e) => set("group", e.target.value)} list="td-groups" placeholder="Работа, Личное…" />
            <datalist id="td-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
        </div>

        <div className="segmented">
          <button type="button" className={!isKey ? "on" : ""} onClick={() => set("auth", "password")}>
            Пароль
          </button>
          <button type="button" className={isKey ? "on" : ""} onClick={() => set("auth", "key")}>
            SSH-ключ
          </button>
        </div>

        {isKey && (
          <label className="field">
            <span>Приватный ключ</span>
            <div className="row">
              <input value={s.keyPath ?? ""} onChange={(e) => set("keyPath", e.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
              <button type="button" className="btn" onClick={pickKey}>
                Обзор…
              </button>
            </div>
          </label>
        )}
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
