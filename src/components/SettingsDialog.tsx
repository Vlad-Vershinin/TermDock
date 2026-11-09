import { useEffect, useState } from "react";
import { api, Settings } from "../lib/api";
import { DEFAULT_SETTINGS, pickFolder, useSettings } from "../lib/settings";
import { useUi } from "../lib/ui";

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

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ui = useUi();
  const { settings: s, update } = useSettings();
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => update({ [k]: v } as Partial<Settings>);
  // What an empty download folder means on this machine.
  const [osDownloads, setOsDownloads] = useState("");
  useEffect(() => {
    if (s.downloadDir) return;
    api.downloadDir(null, "").then(setOsDownloads, () => {});
  }, [s.downloadDir]);

  const chooseDownloadDir = async () => {
    const d = await pickFolder("Папка для загрузок", s.downloadDir || osDownloads);
    if (d) set("downloadDir", d);
  };

  const resetAll = async () => {
    if (await ui.confirm("Сбросить настройки?", "Все параметры вернутся к значениям по умолчанию.")) update(DEFAULT_SETTINGS);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal modal-wide settings"
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
        }}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h3>Настройки</h3>
        <p className="hint">Изменения применяются сразу.</p>

        <h4 className="settings-section">Интерфейс</h4>
        <div className="grid2">
          <label className="field">
            <span>Язык</span>
            <select value={s.language} onChange={(e) => set("language", e.target.value as Settings["language"])}>
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="field">
            <span>Масштаб интерфейса</span>
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
        </div>

        <h4 className="settings-section">Терминал</h4>
        <div className="grid2">
          <label className="field span2">
            <span>Шрифт</span>
            <div className="row">
              <input
                list="td-mono-fonts"
                value={s.termFontFamily}
                onChange={(e) => set("termFontFamily", e.target.value)}
                placeholder="По умолчанию (JetBrains Mono, Cascadia Mono, Consolas…)"
                spellCheck={false}
              />
              <button type="button" className="btn" disabled={!s.termFontFamily} onClick={() => set("termFontFamily", "")}>
                По умолчанию
              </button>
            </div>
            <datalist id="td-mono-fonts">
              {MONO_FONTS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <span className="hint">Шрифт должен быть установлен в системе; если его нет, используется шрифт по умолчанию.</span>
          </label>
          <label className="field">
            <span>Размер шрифта</span>
            <NumberInput value={s.termFontSize} min={8} max={32} onChange={(n) => set("termFontSize", Math.round(n))} />
            <span className="hint">Также Ctrl+колесо мыши и Ctrl+= / Ctrl+- / Ctrl+0 в терминале.</span>
          </label>
          <label className="field">
            <span>Межстрочный интервал</span>
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
            <span>Курсор</span>
            <div className="segmented">
              {(
                [
                  ["block", "Блок"],
                  ["bar", "Черта"],
                  ["underline", "Подчёркивание"],
                ] as const
              ).map(([v, label]) => (
                <button type="button" key={v} className={s.termCursorStyle === v ? "on" : ""} onClick={() => set("termCursorStyle", v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>История прокрутки, строк</span>
            <NumberInput value={s.termScrollback} min={0} max={1000000} step={1000} onChange={(n) => set("termScrollback", Math.round(n))} />
          </label>
          <label className="field span2">
            <span>Правая кнопка мыши</span>
            <select value={s.termRightClick} onChange={(e) => set("termRightClick", e.target.value as Settings["termRightClick"])}>
              <option value="copyPaste">Копировать выделенное, без выделения — вставить</option>
              <option value="paste">Всегда вставлять</option>
              <option value="none">Ничего не делать</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.termCursorBlink} onChange={(e) => set("termCursorBlink", e.target.checked)} />
          Мигающий курсор
        </label>
        <label className="check">
          <input type="checkbox" checked={s.termCopyOnSelect} onChange={(e) => set("termCopyOnSelect", e.target.checked)} />
          Копировать при выделении
        </label>

        <h4 className="settings-section">Файлы</h4>
        <label className="field">
          <span>Папка для загрузок</span>
          <div className="row">
            <input value={s.downloadDir} onChange={(e) => set("downloadDir", e.target.value)} placeholder={osDownloads || "Папка «Загрузки»"} spellCheck={false} />
            <button type="button" className="btn" onClick={chooseDownloadDir}>
              Выбрать…
            </button>
          </div>
          <span className="hint">
            Сюда сохраняет «Скачать в папку загрузок» из меню файлов сервера. У сервера может быть своя папка — в его настройках, раздел «Дополнительно».
            Перетаскивание в панель «Этот компьютер» по-прежнему сохраняет в открытую там папку.
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.askDownloadDir} onChange={(e) => set("askDownloadDir", e.target.checked)} />
          Спрашивать, куда сохранить, при каждой загрузке
        </label>
        <label className="field">
          <span>Панель «Этот компьютер» открывается</span>
          <select value={s.localStartDir} onChange={(e) => set("localStartDir", e.target.value as Settings["localStartDir"])}>
            <option value="last">в последней открытой папке</option>
            <option value="downloads">в папке загрузок (своей у сервера, если задана)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.showHidden} onChange={(e) => set("showHidden", e.target.checked)} />
          Показывать скрытые файлы
        </label>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={resetAll}>
            Сбросить всё
          </button>
          <div className="spacer" />
          <button type="submit" className="btn btn-primary">
            Готово
          </button>
        </div>
      </form>
    </div>
  );
}
