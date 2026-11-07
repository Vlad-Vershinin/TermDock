import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, Script } from "../lib/api";
import { fillVariables, scriptInput, scriptVariables } from "../lib/scripts";
import { paneRegistry } from "../lib/sessions";
import { useUi } from "../lib/ui";
import { IClose, IEdit, IPlay, IPlus, IScript, ITrash } from "./Icons";

interface ScriptsCtx {
  scripts: Script[];
  edit: (s: Script | null) => void;
  remove: (s: Script) => Promise<void>;
  /** Runs a script in the given terminal pane (asks for {{variables}} first). */
  run: (s: Script, paneId: string | null | undefined) => Promise<void>;
}

const Ctx = createContext<ScriptsCtx>(null!);
export const useScripts = () => useContext(Ctx);

export function ScriptsProvider({ children }: { children: ReactNode }) {
  const ui = useUi();
  const [scripts, setScripts] = useState<Script[]>([]);
  const [editing, setEditing] = useState<Script | null | undefined>(undefined);

  useEffect(() => {
    api.listScripts().then(setScripts).catch((e) => ui.toast(errorText(e), "error"));
  }, [ui]);

  const remove = useCallback(
    async (s: Script) => {
      if (!(await ui.confirm("Удалить скрипт?", `«${s.name}» будет удалён.`, true))) return;
      try {
        await api.deleteScript(s.id);
        setScripts((l) => l.filter((x) => x.id !== s.id));
      } catch (e) {
        ui.toast(errorText(e), "error");
      }
    },
    [ui],
  );

  const run = useCallback(
    async (s: Script, paneId: string | null | undefined) => {
      const pane = paneRegistry.get(paneId);
      if (!pane) return ui.toast("Откройте терминал сервера, чтобы выполнить скрипт", "error");
      let body = s.body;
      const vars = scriptVariables(body);
      if (vars.length) {
        const r = await ui.dialog({
          title: `Запуск «${s.name}»`,
          fields: vars.map((v) => ({ name: v.name, label: v.name, value: v.def })),
          okText: "Выполнить",
        });
        if (!r) return;
        body = fillVariables(body, Object.fromEntries(vars.map((v) => [v.name, String(r[v.name] ?? "")])));
      }
      if (!pane.send(scriptInput(s, body))) return ui.toast("Терминал не подключён", "error");
      pane.focus();
    },
    [ui],
  );

  const value = useMemo(() => ({ scripts, edit: setEditing, remove, run }), [scripts, remove, run]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {editing !== undefined && (
        <ScriptDialog
          script={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(s) => {
            setScripts((l) => (l.some((x) => x.id === s.id) ? l.map((x) => (x.id === s.id ? s : x)) : [...l, s]));
            setEditing(undefined);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

/** Menu items for running scripts (title bar / session bar dropdowns). */
export function useScriptMenu() {
  const { scripts, run, edit } = useScripts();
  return (paneId: string | null | undefined) => [
    ...(scripts.length ? [{ header: "Выполнить скрипт" }] : []),
    ...scripts.map((s) => ({ label: s.name, icon: <IPlay size={13} />, hint: s.mode === "bash" ? "bash" : undefined, onClick: () => run(s, paneId) })),
    ...(scripts.length ? (["-"] as const) : []),
    { label: "Новый скрипт…", icon: <IPlus size={13} />, onClick: () => edit(null) },
  ];
}

// ---------- tool window ----------

export function ScriptsPanel({ paneId, target, onClose }: { paneId: string | null; target: string | null; onClose: () => void }) {
  const ui = useUi();
  const { scripts, edit, remove, run } = useScripts();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = q ? scripts.filter((s) => [s.name, s.description ?? "", s.body].some((v) => v.toLowerCase().includes(q))) : scripts;

  return (
    <aside className="toolwin">
      <div className="toolwin-head">
        <IScript /> <span className="toolwin-title">Скрипты</span>
        <div className="spacer" />
        <button className="icon-btn" title="Новый скрипт" onClick={() => edit(null)}>
          <IPlus />
        </button>
        <button className="icon-btn" title="Скрыть (Alt+2)" onClick={onClose}>
          <IClose size={13} />
        </button>
      </div>
      {scripts.length > 0 && (
        <div className="toolwin-search">
          <input placeholder="Поиск скриптов" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
        </div>
      )}
      <div className="toolwin-body">
        {scripts.length === 0 ? (
          <div className="empty-small">
            Сохраняйте часто повторяемые наборы команд и запускайте их на любом сервере в один клик — без алиасов на каждом сервере.
            <br />
            <button className="btn btn-sm btn-primary" style={{ marginTop: 12 }} onClick={() => edit(null)}>
              <IPlus size={13} /> Создать скрипт
            </button>
          </div>
        ) : (
          list.map((s) => (
            <div
              key={s.id}
              className="script-item"
              onDoubleClick={() => run(s, paneId)}
              onContextMenu={(e) =>
                ui.menu(e, [
                  { label: "Выполнить", icon: <IPlay size={13} />, disabled: !paneId, onClick: () => run(s, paneId) },
                  { label: "Изменить", icon: <IEdit size={13} />, onClick: () => edit(s) },
                  { label: "Дублировать", icon: <IPlus size={13} />, onClick: () => edit({ ...s, id: "", name: `${s.name} (копия)` }) },
                  "-",
                  { label: "Удалить", icon: <ITrash size={13} />, danger: true, onClick: () => remove(s) },
                ])
              }
              title={s.body}
            >
              <button className="icon-btn run" title={paneId ? `Выполнить в ${target}` : "Нет активного терминала"} disabled={!paneId} onClick={() => run(s, paneId)}>
                <IPlay size={14} />
              </button>
              <div className="script-text">
                <div className="script-name">
                  {s.name}
                  {s.mode === "bash" && <span className="tag">bash</span>}
                </div>
                <div className="script-desc">{s.description || s.body.split("\n")[0]}</div>
              </div>
              <div className="script-actions">
                <button className="icon-btn" title="Изменить" onClick={() => edit(s)}>
                  <IEdit size={13} />
                </button>
                <button className="icon-btn danger" title="Удалить" onClick={() => remove(s)}>
                  <ITrash size={13} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="toolwin-foot">{target ? <>Выполняется в: <b>{target}</b></> : "Нет активного терминала"}</div>
    </aside>
  );
}

// ---------- editor dialog ----------

function ScriptDialog({ script, onClose, onSaved }: { script: Script | null; onClose: () => void; onSaved: (s: Script) => void }) {
  const ui = useUi();
  const [s, setS] = useState<Script>(() => script ?? { id: "", name: "", description: "", body: "", mode: "terminal" });
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);
  const vars = scriptVariables(s.body);

  const save = async () => {
    if (!s.name.trim()) return ui.toast("Укажите название", "error");
    if (!s.body.trim()) return ui.toast("Скрипт пустой", "error");
    setSaving(true);
    try {
      onSaved(await api.saveScript({ ...s, name: s.name.trim(), description: s.description?.trim() || null }));
    } catch (e) {
      ui.toast(errorText(e), "error");
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal modal-wide"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      >
        <h3>{script?.id ? "Изменить скрипт" : "Новый скрипт"}</h3>
        <div className="grid2">
          <label className="field">
            <span>Название</span>
            <input ref={nameRef} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Обновить систему" />
          </label>
          <label className="field">
            <span>Описание</span>
            <input value={s.description ?? ""} onChange={(e) => setS({ ...s, description: e.target.value })} placeholder="необязательно" />
          </label>
        </div>
        <div className="field">
          <span>Как выполнять</span>
          <div className="segmented">
            <button type="button" className={s.mode === "terminal" ? "on" : ""} onClick={() => setS({ ...s, mode: "terminal" })}>
              Ввести в терминал
            </button>
            <button type="button" className={s.mode === "bash" ? "on" : ""} onClick={() => setS({ ...s, mode: "bash" })}>
              Как bash-скрипт
            </button>
          </div>
          <p className="hint" style={{ marginTop: 2 }}>
            {s.mode === "terminal"
              ? "Команды вводятся в текущий shell построчно, как будто вы их набрали: cd, export и т.п. сохраняются в сессии."
              : "Скрипт целиком выполняется отдельным процессом bash: работают set -e, функции, циклы; состояние shell не меняется."}
          </p>
        </div>
        <label className="field">
          <span>Команды</span>
          <textarea
            className="code-input"
            spellCheck={false}
            rows={12}
            value={s.body}
            onChange={(e) => setS({ ...s, body: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                document.execCommand("insertText", false, "  ");
              }
            }}
            placeholder={"sudo apt update\nsudo apt -y upgrade\ndocker compose -f {{path:/opt/app}}/docker-compose.yml up -d"}
          />
        </label>
        <p className="hint">
          Переменные: <code>{"{{имя}}"}</code> или <code>{"{{имя:значение по умолчанию}}"}</code> — их спросят перед запуском.
          {vars.length > 0 && <> Найдено: {vars.map((v) => v.name).join(", ")}.</>}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            Сохранить
          </button>
        </div>
      </form>
    </div>
  );
}
