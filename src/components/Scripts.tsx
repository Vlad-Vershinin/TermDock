import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, Script } from "../lib/api";
import { fillVariables, scriptInput, scriptSteps, scriptVariables } from "../lib/scripts";
import { paneRegistry } from "../lib/sessions";
import { useUi } from "../lib/ui";
import { T, t as trNow, useT } from "../lib/i18n";
import { IClose, IEdit, IPlay, IPlus, IScript, IStep, ITrash } from "./Icons";

interface ScriptsCtx {
  scripts: Script[];
  edit: (s: Script | null) => void;
  remove: (s: Script) => Promise<void>;
  /**
   * Runs a script in the given terminal pane (asks for {{variables}} first).
   * steps: one command per click; defaults to the script's own setting. Bash scripts always run whole.
   */
  run: (s: Script, paneId: string | null | undefined, steps?: boolean) => Promise<void>;
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
      if (!(await ui.confirm(trNow("scripts.deleteTitle"), trNow("scripts.deleteText", { name: s.name }), true))) return;
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
    async (s: Script, paneId: string | null | undefined, steps = !!s.steps) => {
      const pane = paneRegistry.get(paneId);
      if (!pane) return ui.toast(trNow("scripts.openTerminal"), "error");
      let body = s.body;
      const vars = scriptVariables(body);
      if (vars.length) {
        const r = await ui.dialog({
          title: trNow("scripts.runTitle", { name: s.name }),
          fields: vars.map((v) => ({ name: v.name, label: v.name, value: v.def })),
          okText: trNow("scripts.run"),
        });
        if (!r) return;
        body = fillVariables(body, Object.fromEntries(vars.map((v) => [v.name, String(r[v.name] ?? "")])));
      }
      const sent = steps && s.mode !== "bash" ? pane.runSteps(s.name, scriptSteps(body)) : pane.send(scriptInput(s, body));
      if (!sent) return ui.toast(trNow("scripts.notConnected"), "error");
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

const scriptHint = (tr: T, s: Script) => (s.mode === "bash" ? "bash" : s.steps ? tr("scripts.stepsTag") : undefined);

/** Menu items for running scripts (title bar / session bar dropdowns). */
export function useScriptMenu() {
  const { scripts, run, edit } = useScripts();
  const tr = useT();
  return (paneId: string | null | undefined) => [
    ...(scripts.length ? [{ header: tr("scripts.runScript") }] : []),
    ...scripts.map((s) => ({ label: s.name, icon: <IPlay size={13} />, hint: scriptHint(tr, s), onClick: () => run(s, paneId) })),
    ...(scripts.length ? (["-"] as const) : []),
    { label: tr("scripts.newMenu"), icon: <IPlus size={13} />, onClick: () => edit(null) },
  ];
}

// ---------- tool window ----------

export function ScriptsPanel({ paneId, target, onClose }: { paneId: string | null; target: string | null; onClose: () => void }) {
  const ui = useUi();
  const tr = useT();
  const { scripts, edit, remove, run } = useScripts();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = q ? scripts.filter((s) => [s.name, s.description ?? "", s.body].some((v) => v.toLowerCase().includes(q))) : scripts;

  return (
    <aside className="toolwin">
      <div className="toolwin-head">
        <IScript /> <span className="toolwin-title">{tr("app.scripts")}</span>
        <div className="spacer" />
        <button className="icon-btn" title={tr("scripts.new")} onClick={() => edit(null)}>
          <IPlus />
        </button>
        <button className="icon-btn" title={tr("scripts.hide")} onClick={onClose}>
          <IClose size={13} />
        </button>
      </div>
      {scripts.length > 0 && (
        <div className="toolwin-search">
          <input placeholder={tr("scripts.search")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
        </div>
      )}
      <div className="toolwin-body">
        {scripts.length === 0 ? (
          <div className="empty-small">
            {tr("scripts.empty")}
            <br />
            <button className="btn btn-sm btn-primary" style={{ marginTop: 12 }} onClick={() => edit(null)}>
              <IPlus size={13} /> {tr("scripts.create")}
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
                  { label: tr("scripts.runWhole"), icon: <IPlay size={13} />, disabled: !paneId, onClick: () => run(s, paneId, false) },
                  ...(s.mode === "bash" ? [] : [{ label: tr("scripts.runSteps"), icon: <IStep size={13} />, disabled: !paneId, onClick: () => run(s, paneId, true) }]),
                  { label: tr("common.edit"), icon: <IEdit size={13} />, onClick: () => edit(s) },
                  { label: tr("scripts.duplicate"), icon: <IPlus size={13} />, onClick: () => edit({ ...s, id: "", name: tr("scripts.copyName", { name: s.name }) }) },
                  "-",
                  { label: tr("common.delete"), icon: <ITrash size={13} />, danger: true, onClick: () => remove(s) },
                ])
              }
              title={s.body}
            >
              <button className="icon-btn run" title={paneId ? tr("scripts.runIn", { target: target ?? "" }) : tr("scripts.noTerminal")} disabled={!paneId} onClick={() => run(s, paneId)}>
                <IPlay size={14} />
              </button>
              <div className="script-text">
                <div className="script-name">
                  {s.name}
                  {scriptHint(tr, s) && <span className="tag">{scriptHint(tr, s)}</span>}
                </div>
                <div className="script-desc">{s.description || s.body.split("\n")[0]}</div>
              </div>
              <div className="script-actions">
                <button className="icon-btn" title={tr("common.edit")} onClick={() => edit(s)}>
                  <IEdit size={13} />
                </button>
                <button className="icon-btn danger" title={tr("common.delete")} onClick={() => remove(s)}>
                  <ITrash size={13} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="toolwin-foot">{target ? <>{tr("scripts.runsIn")} <b>{target}</b></> : tr("scripts.noTerminal")}</div>
    </aside>
  );
}

// ---------- editor dialog ----------

function ScriptDialog({ script, onClose, onSaved }: { script: Script | null; onClose: () => void; onSaved: (s: Script) => void }) {
  const ui = useUi();
  const tr = useT();
  const [s, setS] = useState<Script>(() => script ?? { id: "", name: "", description: "", body: "", mode: "terminal" });
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);
  const vars = scriptVariables(s.body);

  const save = async () => {
    if (!s.name.trim()) return ui.toast(tr("scripts.nameRequired"), "error");
    if (!s.body.trim()) return ui.toast(tr("scripts.emptyBody"), "error");
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
        <h3>{script?.id ? tr("scripts.editTitle") : tr("scripts.new")}</h3>
        <div className="grid2">
          <label className="field">
            <span>{tr("scripts.name")}</span>
            <input ref={nameRef} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder={tr("scripts.namePlaceholder")} />
          </label>
          <label className="field">
            <span>{tr("scripts.description")}</span>
            <input value={s.description ?? ""} onChange={(e) => setS({ ...s, description: e.target.value })} placeholder={tr("scripts.optional")} />
          </label>
        </div>
        <div className="field">
          <span>{tr("scripts.mode")}</span>
          <div className="segmented">
            <button type="button" className={s.mode === "terminal" ? "on" : ""} onClick={() => setS({ ...s, mode: "terminal" })}>
              {tr("scripts.mode.terminal")}
            </button>
            <button type="button" className={s.mode === "bash" ? "on" : ""} onClick={() => setS({ ...s, mode: "bash" })}>
              {tr("scripts.mode.bash")}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 2 }}>
            {s.mode === "terminal"
              ? tr("scripts.mode.terminalHint")
              : tr("scripts.mode.bashHint")}
          </p>
        </div>
        {s.mode === "terminal" && (
          <div className="field">
            <span>{tr("scripts.runMode")}</span>
            <div className="segmented">
              <button type="button" className={!s.steps ? "on" : ""} onClick={() => setS({ ...s, steps: false })}>
                {tr("scripts.whole")}
              </button>
              <button type="button" className={s.steps ? "on" : ""} onClick={() => setS({ ...s, steps: true })}>
                {tr("scripts.steps")}
              </button>
            </div>
            <p className="hint" style={{ marginTop: 2 }}>
              {s.steps
                ? tr("scripts.stepsHint")
                : tr("scripts.wholeHint")}
            </p>
          </div>
        )}
        <label className="field">
          <span>{tr("scripts.commands")}</span>
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
          {tr("scripts.varsLabel")} <code>{`{{${tr("scripts.varName")}}}`}</code> {tr("scripts.varsOr")} <code>{`{{${tr("scripts.varName")}:${tr("scripts.varDefault")}}}`}</code>{" "}
          {tr("scripts.varsHint")}
          {vars.length > 0 && <> {tr("scripts.varsFound", { list: vars.map((v) => v.name).join(", ") })}</>}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {tr("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {tr("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
