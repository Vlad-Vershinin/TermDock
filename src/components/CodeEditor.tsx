import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, Text } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, insertTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, LanguageDescription } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { errorText, ReadTextOptions, TextEncoding, TextFile } from "../lib/api";
import { detectLanguage, editorLook, encodingLabel, ENCODINGS, languageLabel } from "../lib/codemirror";
import { useUi } from "../lib/ui";
import { IClose, ISave } from "./Icons";

export interface EditorProps {
  /** Shown in the header, e.g. "user@host:/etc/nginx/nginx.conf"; also used to pick the language. */
  title: string;
  load: (opts: ReadTextOptions) => Promise<TextFile>;
  save: (text: string, enc: TextEncoding) => Promise<void>;
  onClose: () => void;
  onSaved?: () => void;
}

const sameEnc = (a: TextEncoding, b: TextEncoding) => a.encoding.toLowerCase() === b.encoding.toLowerCase() && a.bom === b.bom;

/** Text editor for config files and scripts: syntax highlighting, search/replace, encodings, unsaved-changes guard. */
export default function CodeEditor({ title, load, save, onClose, onSaved }: EditorProps) {
  const ui = useUi();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [lines, setLines] = useState(0);
  const [wrap, setWrap] = useState(() => localStorage.getItem("td.editorWrap") === "1");
  const [crlf, setCrlf] = useState(false);
  const [lossy, setLossy] = useState(false);
  /** Encoding the file is in on disk / encoding it will be saved in. */
  const [fileEnc, setFileEnc] = useState<TextEncoding>({ encoding: "UTF-8", bom: false });
  const [saveEnc, setSaveEnc] = useState<TextEncoding>({ encoding: "UTF-8", bom: false });

  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const original = useRef<Text>(Text.empty);
  const allowLarge = useRef(false);
  const langComp = useRef(new Compartment()).current;
  const wrapComp = useRef(new Compartment()).current;
  const [lang] = useState<LanguageDescription | null>(() => detectLanguage(title));

  /** Reads the file, asking before opening anything over 5 MB. Null means the user declined. */
  const read = async (encoding?: string): Promise<TextFile | null> => {
    try {
      return await load({ encoding, allowLarge: allowLarge.current });
    } catch (e) {
      const m = /^TOO_BIG\|(\d+)$/.exec(errorText(e));
      if (!m) throw e;
      const mb = (Number(m[1]) / 1024 / 1024).toFixed(1).replace(".", ",");
      if (!(await ui.confirm(`Файл большой (${mb} МБ). Открыть всё равно?`, "Редактор может работать медленнее."))) return null;
      allowLarge.current = true;
      return load({ encoding, allowLarge: true });
    }
  };

  const makeState = (text: string) =>
    EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        EditorState.tabSize.of(4),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          // Tab inserts a tab (or indents the selection), like the old textarea editor.
          { key: "Tab", run: insertTab, shift: indentLess },
          { key: "Mod-h", run: openSearchPanel, preventDefault: true },
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
        ]),
        editorLook,
        langComp.of(lang?.support ?? []),
        wrapComp.of(wrap ? EditorView.lineWrapping : []),
        EditorView.contentAttributes.of({ spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            setDirty(!u.state.doc.eq(original.current));
            setLines(u.state.doc.lines);
          }
          if (u.docChanged || u.selectionSet) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            setCursor({ line: line.number, col: head - line.from + 1 });
          }
        }),
      ],
    });

  /** Puts a freshly read file into the editor (resets undo history). */
  const show = (f: TextFile) => {
    // CodeMirror splits on \r\n itself; remember CRLF files to write them back as they were.
    setCrlf(f.text.includes("\r\n"));
    const state = makeState(f.text);
    original.current = state.doc;
    if (view.current) view.current.setState(state);
    else view.current = new EditorView({ state, parent: host.current! });
    setLines(state.doc.lines);
    setCursor({ line: 1, col: 1 });
    setDirty(false);
    setLossy(f.lossy);
    setFileEnc({ encoding: f.encoding, bom: f.bom });
    setSaveEnc({ encoding: f.encoding, bom: f.bom });
    setStatus("ready");
    if (f.lossy)
      ui.toast(`Часть байтов не подходит к кодировке ${encodingLabel(f.encoding, f.bom)} и показана как «�». При сохранении они будут потеряны.`, "error");
    requestAnimationFrame(() => view.current?.focus());
  };

  useEffect(() => {
    read()
      .then((f) => (f ? show(f) : onClose()))
      .catch((e) => {
        setError(errorText(e));
        setStatus("error");
      });
    if (lang && !lang.support)
      lang.load().then((s) => view.current?.dispatch({ effects: langComp.reconfigure(s) }), () => {});
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap, wrapComp]);

  const canSave = status === "ready" && (dirty || !sameEnc(saveEnc, fileEnc));

  const doSave = async () => {
    const v = view.current;
    if (!v || !canSave || saving) return;
    setSaving(true);
    const doc = v.state.doc;
    try {
      const text = doc.toString();
      await save(crlf ? text.replace(/\n/g, "\r\n") : text, saveEnc);
      original.current = doc;
      setDirty(!v.state.doc.eq(doc));
      setFileEnc(saveEnc);
      setLossy(false);
      ui.toast("Сохранено", "success");
      onSaved?.();
    } catch (e) {
      ui.toast(`Не удалось сохранить: ${errorText(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty && !(await ui.confirm("Закрыть без сохранения?", "Изменения в файле будут потеряны.", true))) return;
    onClose();
  };

  /** Re-reads the original bytes and decodes them in another encoding. */
  const reopen = async (encoding: string) => {
    if (dirty && !(await ui.confirm("Открыть файл заново?", "Несохранённые изменения будут потеряны."))) return;
    try {
      const f = await read(encoding);
      if (f) show(f);
    } catch (e) {
      if (view.current && status === "ready") ui.toast(errorText(e), "error");
      else {
        setError(errorText(e));
        setStatus("error");
      }
    }
  };

  const reopenMenu = (el: HTMLElement) =>
    ui.menu(el, [
      { header: "Открыть заново в кодировке" },
      ...ENCODINGS.filter((e) => !(e.encoding === "UTF-8" && e.bom)).map((e) => ({
        label: e.label,
        icon: status === "ready" && e.encoding.toLowerCase() === fileEnc.encoding.toLowerCase() ? "✓" : undefined,
        onClick: () => reopen(e.encoding),
      })),
    ]);

  const saveMenu = (el: HTMLElement) =>
    ui.menu(el, [
      { header: "Сохранять в кодировке" },
      ...ENCODINGS.map((e) => ({
        label: e.label,
        icon: sameEnc(e, saveEnc) ? "✓" : undefined,
        onClick: () => {
          setSaveEnc({ encoding: e.encoding, bom: e.bom });
          view.current?.focus();
        },
      })),
    ]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="editor"
        onKeyDown={(e) => {
          // CodeMirror marks keys it handled (e.g. Esc closing the search panel) as defaultPrevented.
          if (e.defaultPrevented) return;
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
            e.preventDefault();
            doSave();
          }
        }}
      >
        <div className="editor-head">
          <span className="editor-title" title={title}>
            {dirty && <span className="dirty-dot" title="Есть несохранённые изменения" />}
            {title}
          </span>
          <div className="spacer" />
          <label className="check small">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(e) => {
                setWrap(e.target.checked);
                localStorage.setItem("td.editorWrap", e.target.checked ? "1" : "0");
              }}
            />
            Перенос строк
          </label>
          <button className="btn btn-sm btn-primary" onClick={doSave} disabled={!canSave || saving} title="Сохранить (Ctrl+S)">
            <ISave size={13} /> Сохранить
          </button>
          <button className="icon-btn" onClick={close} title="Закрыть (Esc)">
            <IClose size={14} />
          </button>
        </div>
        <div className="editor-body">
          {status === "error" && <div className="pane-empty err">{error}</div>}
          {status === "loading" && <div className="pane-loading" />}
          <div className="editor-cm" ref={host} hidden={status !== "ready"} />
        </div>
        <div className="editor-foot">
          {status === "ready" && (
            <>
              <span>
                Стр {cursor.line}, стлб {cursor.col}
              </span>
              <span>{lines} строк</span>
              <span>{crlf ? "CRLF" : "LF"}</span>
              <span>{languageLabel(lang)}</span>
              <button
                className="foot-btn"
                onClick={(e) => saveMenu(e.currentTarget)}
                title={`Файл в кодировке ${encodingLabel(fileEnc.encoding, fileEnc.bom)}. Нажмите, чтобы выбрать кодировку для сохранения`}
              >
                {sameEnc(saveEnc, fileEnc)
                  ? encodingLabel(saveEnc.encoding, saveEnc.bom)
                  : `${encodingLabel(fileEnc.encoding, fileEnc.bom)} → ${encodingLabel(saveEnc.encoding, saveEnc.bom)}`}
                {lossy && <span className="err"> (есть ошибки)</span>}
              </button>
            </>
          )}
          <button className="foot-btn" onClick={(e) => reopenMenu(e.currentTarget)} title="Открыть файл заново в другой кодировке">
            Открыть в…
          </button>
          <div className="spacer" />
          <span className="muted">Ctrl+S — сохранить · Ctrl+F / Ctrl+H — поиск и замена · Esc — закрыть</span>
        </div>
      </div>
    </div>
  );
}
