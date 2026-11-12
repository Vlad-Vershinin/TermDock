import { ReactNode, useEffect, useState } from "react";
import { api, Settings } from "../lib/api";
import { DEFAULT_SETTINGS, pickFolder, useSettings } from "../lib/settings";
import { useUi } from "../lib/ui";
import { Key, LANGUAGE_NAMES, useT } from "../lib/i18n";
import { IDownload, IFolder, IMonitor, IPlugin, ITerminal } from "./Icons";
import { useUpdates } from "../lib/updates";
import { getVersion } from "@tauri-apps/api/app";

const MONO_FONTS = [
  "JetBrains Mono",
  "Cascadia Mono",
  "Cascadia Code",
  "Fira Code",
  "Source Code Pro",
  "Hack",
  "Consolas",
  "Menlo",
  "SF Mono",
  "DejaVu Sans Mono",
  "Ubuntu Mono",
  "Liberation Mono",
  "Noto Sans Mono",
  "Courier New",
];

const UI_FONT_SIZES = [11, 12, 13, 14, 15, 16];

type Section = "interface" | "terminal" | "files" | "updates" | "plugins";
const SECTIONS: { id: Section; label: Key; icon: ReactNode }[] = [
  { id: "interface", label: "settings.interface", icon: <IMonitor size={15} /> },
  { id: "terminal", label: "settings.terminal", icon: <ITerminal size={15} /> },
  { id: "files", label: "settings.files", icon: <IFolder size={15} /> },
  { id: "updates", label: "settings.updates", icon: <IDownload size={15} /> },
  { id: "plugins", label: "plugins.title", icon: <IPlugin size={15} /> },
];
const SECTION_KEY = "td.settingsSection";

function readSection(): Section {
  try {
    const v = localStorage.getItem(SECTION_KEY);
    if (SECTIONS.some((x) => x.id === v)) return v as Section;
  } catch {
    /* default below */
  }
  return "interface";
}

const UI_SCALES = [80, 90, 100, 110, 125, 150, 175];
const LINE_HEIGHTS = [1, 1.1, 1.2, 1.3, 1.4, 1.5];

/** Number input that commits only valid values in range (typing "1" on the way to "16" is not applied). */
function NumberInput({ value, min, max, step, onChange }: { value: number; min: number; max: number; step?: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= min && n <= max) onChange(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

export function SettingsDialog({ onClose, onPlugins }: { onClose: () => void; onPlugins: () => void }) {
  const ui = useUi();
  const tr = useT();
  const { settings: s, update } = useSettings();
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => update({ [k]: v } as Partial<Settings>);
  const updates = useUpdates();
  const [version, setVersion] = useState("");
  useEffect(() => void getVersion().then(setVersion, () => {}), []);
  // What an empty download folder means on this machine.
  const [osDownloads, setOsDownloads] = useState("");
  useEffect(() => {
    if (s.downloadDir) return;
    api.downloadDir(null, "").then(setOsDownloads, () => {});
  }, [s.downloadDir]);

  const chooseDownloadDir = async () => {
    const d = await pickFolder(tr("settings.downloadDir"), s.downloadDir || osDownloads);
    if (d) set("downloadDir", d);
  };

  // The last opened section comes back next time.
  const [section, setSection] = useState<Section>(readSection);
  const pick = (id: Section) => {
    setSection(id);
    try {
      localStorage.setItem(SECTION_KEY, id);
    } catch {
      /* not remembered */
    }
  };

  const resetAll = async () => {
    // The language stays: resetting shouldn't switch the UI to a language the user may not read.
    if (await ui.confirm(tr("settings.resetTitle"), tr("settings.resetText"))) update({ ...DEFAULT_SETTINGS, language: s.language });
  };

  const interfaceSection = (
    <>
        <div className="grid2">
          <label className="field">
            <span>{tr("settings.language")}</span>
            <select value={s.language} onChange={(e) => set("language", e.target.value as Settings["language"])}>
              {Object.entries(LANGUAGE_NAMES).map(([v, name]) => (
                <option key={v} value={v}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{tr("settings.uiScale")}</span>
            <select value={s.uiScale} onChange={(e) => set("uiScale", Number(e.target.value))}>
              {[...new Set([...UI_SCALES, s.uiScale])]
                .sort((a, b) => a - b)
                .map((v) => (
                  <option key={v} value={v}>
                    {v}%
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>{tr("settings.uiFontSize")}</span>
            <select value={s.uiFontSize} onChange={(e) => set("uiFontSize", Number(e.target.value))}>
              {UI_FONT_SIZES.map((v) => (
                <option key={v} value={v}>
                  {v === DEFAULT_SETTINGS.uiFontSize ? tr("settings.uiFontSizeDefault", { n: v }) : tr("settings.uiFontSizePx", { n: v })}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="hint">{tr("settings.uiFontSizeHint")}</p>
    </>
  );
  const terminalSection = (
    <>
        <div className="grid2">
          <label className="field span2">
            <span>{tr("settings.font")}</span>
            <div className="row">
              <input
                list="td-mono-fonts"
                value={s.termFontFamily}
                onChange={(e) => set("termFontFamily", e.target.value)}
                placeholder={tr("settings.fontPlaceholder")}
                spellCheck={false}
              />
              <button type="button" className="btn" disabled={!s.termFontFamily} onClick={() => set("termFontFamily", "")}>
                {tr("settings.default")}
              </button>
            </div>
            <datalist id="td-mono-fonts">
              {MONO_FONTS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <span className="hint">{tr("settings.fontHint")}</span>
          </label>
          <label className="field">
            <span>{tr("settings.fontSize")}</span>
            <NumberInput value={s.termFontSize} min={8} max={32} onChange={(n) => set("termFontSize", Math.round(n))} />
            <span className="hint">{tr("settings.fontSizeHint")}</span>
          </label>
          <label className="field">
            <span>{tr("settings.lineHeight")}</span>
            <select value={s.termLineHeight} onChange={(e) => set("termLineHeight", Number(e.target.value))}>
              {[...new Set([...LINE_HEIGHTS, s.termLineHeight])]
                .sort((a, b) => a - b)
                .map((v) => (
                  <option key={v} value={v}>
                    {v.toFixed(1)}
                  </option>
                ))}
            </select>
          </label>
          <div className="field">
            <span>{tr("settings.cursor")}</span>
            <div className="segmented">
              {(
                [
                  ["block", "settings.cursor.block"],
                  ["bar", "settings.cursor.bar"],
                  ["underline", "settings.cursor.underline"],
                ] as const
              ).map(([v, label]) => (
                <button type="button" key={v} className={s.termCursorStyle === v ? "on" : ""} onClick={() => set("termCursorStyle", v)}>
                  {tr(label)}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>{tr("settings.scrollback")}</span>
            <NumberInput value={s.termScrollback} min={0} max={1000000} step={1000} onChange={(n) => set("termScrollback", Math.round(n))} />
          </label>
          <label className="field span2">
            <span>{tr("settings.rightClick")}</span>
            <select value={s.termRightClick} onChange={(e) => set("termRightClick", e.target.value as Settings["termRightClick"])}>
              <option value="copyPaste">{tr("settings.rightClick.copyPaste")}</option>
              <option value="paste">{tr("settings.rightClick.paste")}</option>
              <option value="none">{tr("settings.rightClick.none")}</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.termCursorBlink} onChange={(e) => set("termCursorBlink", e.target.checked)} />
          {tr("settings.cursorBlink")}
        </label>
        <label className="check">
          <input type="checkbox" checked={s.termCopyOnSelect} onChange={(e) => set("termCopyOnSelect", e.target.checked)} />
          {tr("settings.copyOnSelect")}
        </label>
    </>
  );
  const filesSection = (
    <>
        <label className="field">
          <span>{tr("settings.downloadDir")}</span>
          <div className="row">
            <input value={s.downloadDir} onChange={(e) => set("downloadDir", e.target.value)} placeholder={osDownloads || tr("settings.osDownloads")} spellCheck={false} />
            <button type="button" className="btn" onClick={chooseDownloadDir}>
              {tr("settings.choose")}
            </button>
          </div>
          <span className="hint">
            {tr("settings.downloadDirHint")}
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.askDownloadDir} onChange={(e) => set("askDownloadDir", e.target.checked)} />
          {tr("settings.askDownloadDir")}
        </label>
        <label className="field">
          <span>{tr("settings.localStart")}</span>
          <select value={s.localStartDir} onChange={(e) => set("localStartDir", e.target.value as Settings["localStartDir"])}>
            <option value="last">{tr("settings.localStart.last")}</option>
            <option value="downloads">{tr("settings.localStart.downloads")}</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.showHidden} onChange={(e) => set("showHidden", e.target.checked)} />
          {tr("settings.showHidden")}
        </label>
    </>
  );
  const updatesSection = (
    <>
        <div className="row">
          <span className="muted">{version ? tr("settings.version", { version }) : null}</span>
          <div className="spacer" />
          <button type="button" className="btn" disabled={updates.checking} onClick={updates.checkNow}>
            {updates.checking ? tr("settings.checking") : tr("settings.checkNow")}
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.checkUpdates} onChange={(e) => set("checkUpdates", e.target.checked)} />
          {tr("settings.checkUpdates")}
        </label>
    </>
  );
  const pluginsSection = (
    <>
        <div className="row">
          <span className="hint">{tr("plugins.settingsHint")}</span>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onPlugins}>
            {tr("plugins.manage")}
          </button>
        </div>
    </>
  );

  const content = { interface: interfaceSection, terminal: terminalSection, files: filesSection, updates: updatesSection, plugins: pluginsSection }[section];
  const current = SECTIONS.find((x) => x.id === section)!;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal settings"
        // Nothing inside is autofocused; take focus so Escape reaches onKeyDown.
        tabIndex={-1}
        ref={(el) => {
          if (el && !el.contains(document.activeElement)) el.focus();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
        }}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <nav className="settings-nav">
          <h3>{tr("settings.title")}</h3>
          {SECTIONS.map((x) => (
            <button type="button" key={x.id} className={`settings-nav-item ${x.id === section ? "on" : ""}`} onClick={() => pick(x.id)}>
              {x.icon}
              {tr(x.label)}
            </button>
          ))}
          <div className="spacer" />
          <button type="button" className="btn btn-sm settings-reset" onClick={resetAll}>
            {tr("settings.reset")}
          </button>
        </nav>
        <div className="settings-main">
          <div className="settings-head">
            <h4>{tr(current.label)}</h4>
            <span className="hint">{tr("settings.applyNote")}</span>
          </div>
          <div className="settings-body" key={section}>
            {content}
          </div>
          <div className="modal-actions">
            <div className="spacer" />
            <button type="submit" className="btn btn-primary">
              {tr("settings.done")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
