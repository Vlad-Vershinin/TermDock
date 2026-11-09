// Tiny i18n layer: flat dictionaries (Russian is the source of truth), `{name}` interpolation,
// plural forms via Intl.PluralRules (the count is the `n` param).
import { useCallback } from "react";
import { ru } from "./locales/ru";
import { en } from "./locales/en";
import { useSettings } from "./settings";

export type Lang = "ru" | "en";
export type Key = keyof typeof ru;
/** A plain string, or plural forms keyed by Intl.PluralRules categories ("other" is the fallback). */
export type Entry = string | Partial<Record<Intl.LDMLPluralRule, string>>;
export type Dict = Record<Key, Entry>;
export type Params = Record<string, string | number>;

const dicts: Record<Lang, Dict> = { ru, en };
const rules: Partial<Record<Lang, Intl.PluralRules>> = {};

/** Language names for the switcher, each in its own language (so they stay outside the dictionaries). */
export const LANGUAGE_NAMES: Record<Lang, string> = { ru: "Русский", en: "English" };

let current: Lang = "ru";

/** Current UI language, for code outside React components. */
export const lang = () => current;

/** Called by SettingsProvider whenever the setting changes. */
export function setLang(l: Lang) {
  current = l === "en" ? "en" : "ru";
  document.documentElement.lang = current;
}

export function translate(l: Lang, key: Key, params?: Params): string {
  let e: Entry | undefined = dicts[l][key] ?? ru[key];
  if (typeof e !== "string") {
    const forms: Partial<Record<Intl.LDMLPluralRule, string>> = e ?? {};
    const n = Number(params?.n ?? 0);
    const rule = (rules[l] ??= new Intl.PluralRules(l)).select(n);
    e = forms[rule] ?? forms.other ?? forms.many ?? "";
  }
  if (!params) return e;
  return e.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Translates in the current language (non-hook; components should prefer `useT`). */
export const t = (key: Key, params?: Params) => translate(current, key, params);

export type T = typeof t;

/** `t` bound to the language setting; re-renders the component when the language changes. */
export function useT(): T {
  const l = useSettings().settings.language;
  return useCallback((key: Key, params?: Params) => translate(l, key, params), [l]);
}
