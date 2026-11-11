import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errorText, Settings } from "./api";
import { useUi } from "./ui";
import { setLang } from "./i18n";

/** Same defaults as `settings::Settings::default()` on the Rust side. */
export const DEFAULT_SETTINGS: Settings = {
  language: "ru",
  uiScale: 100,
  termFontFamily: "",
  termFontSize: 14,
  termLineHeight: 1,
  termCursorStyle: "block",
  termCursorBlink: true,
  termScrollback: 10000,
  termCopyOnSelect: false,
  termRightClick: "copyPaste",
  downloadDir: "",
  askDownloadDir: false,
  showHidden: false,
  localStartDir: "last",
  checkUpdates: true,
};

export const TERM_FONT_DEFAULT = '"JetBrains Mono", "Cascadia Mono", "Fira Code", Consolas, "DejaVu Sans Mono", "Ubuntu Mono", monospace';

/** xterm fontFamily for a setting value: the chosen font first, the built-in stack as fallback. */
export function terminalFont(family: string): string {
  const f = family.trim();
  if (!f) return TERM_FONT_DEFAULT;
  return `${/[\s,]/.test(f) && !/^["']/.test(f) ? `"${f}"` : f}, ${TERM_FONT_DEFAULT}`;
}

export const clampFontSize = (n: number) => Math.max(8, Math.min(32, Math.round(n)));

/** Picks a local folder; resolves to null when cancelled. */
export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  const f = await openDialog({ title, directory: true, multiple: false, defaultPath: defaultPath || undefined });
  return typeof f === "string" ? f : null;
}

interface Ctx {
  settings: Settings;
  /** Applies at once; saved to settings.json shortly after (debounced). */
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<Ctx>(null!);
export const useSettings = () => useContext(SettingsContext);

// Pre-settings localStorage keys, folded into settings.json once.
const LEGACY_KEYS = ["td.fontSize", "td.hidden.local", "td.hidden.remote"];

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { toast } = useUi();
  const [settings, setSettings] = useState<Settings | null>(null);
  const current = useRef<Settings>(DEFAULT_SETTINGS);
  const timer = useRef<number | undefined>(undefined);

  const persist = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api.saveSettings(current.current).catch((e) => toast(errorText(e), "error"));
    }, 300);
  }, [toast]);

  const update = useCallback(
    (patch: Partial<Settings>) => {
      current.current = { ...current.current, ...patch };
      setSettings(current.current);
      persist();
    },
    [persist],
  );

  useEffect(() => {
    Promise.all([api.getSettings().catch(() => DEFAULT_SETTINGS), api.settingsFirstRun().catch(() => false)])
      .then(([s, firstRun]) => {
        const patch: Partial<Settings> = {};
        // Fresh install on a non-Russian system: start in English.
        if (firstRun && !/^ru\b/i.test(navigator.language)) patch.language = "en";
        const fs = Number(localStorage.getItem("td.fontSize"));
        if (fs > 0) patch.termFontSize = clampFontSize(fs);
        if (LEGACY_KEYS.slice(1).some((k) => localStorage.getItem(k) === "1")) patch.showHidden = true;
        current.current = { ...DEFAULT_SETTINGS, ...s, ...patch };
        setSettings(current.current);
        if (Object.keys(patch).length) persist();
        LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
      });
  }, [persist]);

  const scale = settings?.uiScale;
  useEffect(() => {
    if (scale) getCurrentWebview().setZoom(scale / 100).catch(() => {});
  }, [scale]);

  // Set synchronously, before the children render, so non-hook `t()` calls already see the new language.
  if (settings) setLang(settings.language);

  // Render nothing until loaded: terminals and file panes read their initial options from here.
  if (!settings) return null;
  return <SettingsContext.Provider value={{ settings, update }}>{children}</SettingsContext.Provider>;
}
