// CodeMirror setup for the built-in editor: theme, language detection, Russian UI phrases.
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";

// ---------- language ----------

/** Config files that language-data doesn't recognise by name (checked before its own rules). */
const BY_NAME: [RegExp, string][] = [
  [/^(\.?(bashrc|bash_profile|bash_logout|bash_aliases|profile|zshrc|zprofile|zshenv|kshrc|mkshrc))$/i, "Shell"],
  [/\.(zsh|command)$/i, "Shell"],
  [/^(dockerfile|containerfile)([.-].+)?$|\.dockerfile$/i, "Dockerfile"],
  [/^\.env(\..+)?$|\.env$/i, "Properties files"],
  // systemd units
  [/\.(service|socket|timer|target|mount|automount|path|slice|scope|swap|network|netdev|link)$/i, "Properties files"],
  [/\.(cfg|cnf)$/i, "Properties files"],
];

/** Picks a language by file path; the parser itself is a lazily loaded chunk. */
export function detectLanguage(path: string): LanguageDescription | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const byName = (n: string) => LanguageDescription.matchLanguageName(languages, n, false);
  // Files under /etc/nginx are nginx configs whatever their name (sites-available/default, conf.d/*.conf).
  if (/[\\/]nginx[\\/]/i.test(path) && !/\.(json|ya?ml|js|lua|html?)$/i.test(name)) return byName("Nginx");
  for (const [re, lang] of BY_NAME) if (re.test(name)) return byName(lang);
  return (
    LanguageDescription.matchFilename(languages, name) ??
    LanguageDescription.matchFilename(languages, name.toLowerCase()) ??
    (/\.(conf|config)$/i.test(name) ? byName("Properties files") : null)
  );
}

/** Footer name of the language. */
export const languageLabel = (lang: LanguageDescription | null) =>
  !lang ? "Обычный текст" : lang.name === "Properties files" ? "INI / Properties" : lang.name;

// ---------- theme ----------

// Colours follow the JetBrains "New UI" dark scheme to match the rest of the app.
const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "13px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: '"JetBrains Mono", "Cascadia Mono", "Fira Code", Consolas, "DejaVu Sans Mono", monospace',
      lineHeight: "20px",
    },
    ".cm-content": { padding: "8px 0 30px", caretColor: "#fff" },
    ".cm-line": { padding: "0 12px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#fff" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "#214283" },
    ".cm-activeLine": { backgroundColor: "#26282e" },
    ".cm-selectionMatch": { backgroundColor: "#3b514d" },
    ".cm-searchMatch": { backgroundColor: "#32593d", outline: "1px solid #3d7a50" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#2e6b45" },
    "&.cm-focused .cm-matchingBracket": { backgroundColor: "#43454a", outline: "1px solid #5c6066" },
    "&.cm-focused .cm-nonmatchingBracket": { color: "var(--err)" },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "#5c6066", border: "none", borderRight: "1px solid var(--line)" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 8px", minWidth: "40px" },
    ".cm-activeLineGutter": { backgroundColor: "#26282e", color: "#a1a3ab" },
    ".cm-foldGutter .cm-gutterElement": { padding: "0 4px 0 0", color: "#6f737a" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--bg-3)", border: "none", color: "var(--muted)" },
    ".cm-specialChar": { color: "var(--err)" },
    ".cm-tooltip": { backgroundColor: "var(--bg-1)", border: "1px solid var(--border-2)", color: "var(--text)" },
    // search / replace panel
    ".cm-panels": { backgroundColor: "var(--bg-1)", color: "var(--text)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
    ".cm-panel.cm-search": { padding: "6px 30px 6px 10px", fontSize: "12px", fontFamily: "inherit" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": { margin: "2px 4px 2px 0", fontSize: "12px" },
    ".cm-textfield": {
      height: "26px",
      padding: "0 8px",
      borderRadius: "var(--radius)",
      border: "1px solid var(--border-2)",
      backgroundColor: "var(--bg-input)",
      color: "var(--text)",
      outline: "none",
      userSelect: "text",
    },
    ".cm-textfield:focus": { borderColor: "var(--accent)" },
    ".cm-button": {
      height: "26px",
      padding: "0 10px",
      borderRadius: "var(--radius)",
      border: "1px solid var(--border-2)",
      backgroundImage: "none",
      backgroundColor: "var(--bg-3)",
      color: "var(--text)",
      cursor: "pointer",
    },
    ".cm-button:hover": { backgroundColor: "var(--bg-2)" },
    ".cm-panel.cm-search label": { color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: "4px" },
    ".cm-panel.cm-search [name=close]": { color: "var(--muted)", fontSize: "16px", top: "6px", right: "8px", cursor: "pointer" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "#cf8e6d" },
  { tag: [t.bool, t.null, t.atom, t.self], color: "#cf8e6d" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#6aab73" },
  { tag: [t.escape, t.character], color: "#cf8e6d" },
  { tag: [t.number, t.integer, t.float], color: "#2aacb8" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#7a7e85", fontStyle: "italic" },
  { tag: t.docComment, color: "#5f826b", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#56a8f5" },
  { tag: [t.definition(t.variableName)], color: "#bcbec4" },
  { tag: [t.propertyName, t.attributeName], color: "#c77dbb" },
  { tag: [t.definition(t.propertyName)], color: "#c77dbb" },
  { tag: [t.typeName, t.className, t.namespace], color: "#bcbec4" },
  { tag: [t.tagName, t.angleBracket], color: "#d5b778" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "#b3ae60" },
  { tag: [t.heading], color: "#56a8f5", fontWeight: "bold" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#56a8f5", textDecoration: "underline" },
  { tag: [t.variableName, t.special(t.variableName)], color: "#bcbec4" },
  { tag: [t.labelName, t.constant(t.variableName)], color: "#c77dbb" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#bcbec4" },
  { tag: t.invalid, color: "var(--err)" },
  { tag: t.inserted, color: "#6aab73" },
  { tag: t.deleted, color: "#f75464" },
]);

const phrases = EditorState.phrases.of({
  Find: "Найти",
  Replace: "Заменить на",
  next: "далее",
  previous: "назад",
  all: "все",
  "match case": "регистр",
  regexp: "рег. выражение",
  "by word": "слово целиком",
  replace: "заменить",
  "replace all": "заменить все",
  close: "закрыть",
  "current match": "текущее совпадение",
  "replaced $ matches": "заменено совпадений: $",
  "replaced match on line $": "заменено совпадение в строке $",
  "on line": "в строке",
  "Go to line": "Перейти к строке",
  go: "перейти",
  "Folded lines": "Свёрнутые строки",
  "Unfolded lines": "Развёрнутые строки",
  "Fold line": "Свернуть",
  "Unfold line": "Развернуть",
  folded: "свёрнуто",
  unfolded: "развёрнуто",
});

export const editorLook: Extension = [theme, syntaxHighlighting(highlight), phrases];

// ---------- encodings ----------

/** Encodings offered in the editor footer. `encoding` is the backend name. */
export const ENCODINGS: { label: string; encoding: string; bom: boolean }[] = [
  { label: "UTF-8", encoding: "UTF-8", bom: false },
  { label: "UTF-8 с BOM", encoding: "UTF-8", bom: true },
  { label: "UTF-16 LE", encoding: "UTF-16LE", bom: true },
  { label: "UTF-16 BE", encoding: "UTF-16BE", bom: true },
  { label: "Windows-1251 (кириллица)", encoding: "windows-1251", bom: false },
  { label: "KOI8-R", encoding: "KOI8-R", bom: false },
  { label: "KOI8-U", encoding: "KOI8-U", bom: false },
  { label: "CP866 (DOS)", encoding: "IBM866", bom: false },
  { label: "ISO-8859-5", encoding: "ISO-8859-5", bom: false },
  { label: "Windows-1252 (западная)", encoding: "windows-1252", bom: false },
  { label: "ISO-8859-1 (Latin-1)", encoding: "ISO-8859-1", bom: false },
  { label: "Windows-1250 (центр. Европа)", encoding: "windows-1250", bom: false },
  { label: "Shift_JIS", encoding: "Shift_JIS", bom: false },
  { label: "GBK", encoding: "GBK", bom: false },
];

/** Short footer label, e.g. "UTF-8 с BOM", "windows-1251". */
export function encodingLabel(encoding: string, bom: boolean): string {
  const e = ENCODINGS.find((x) => x.encoding.toLowerCase() === encoding.toLowerCase() && x.bom === bom);
  const base = e ? e.label.replace(/ \(.*\)$/, "") : encoding;
  // UTF-16 without BOM isn't in the list, but can come from "reopen as".
  return !e && bom ? `${base} с BOM` : !e && /^utf-16/i.test(encoding) ? `${base} без BOM` : base;
}
