import { useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../lib/api";
import { useUi } from "../lib/ui";
import { IClose, ISave } from "./Icons";

interface Props {
  /** Shown in the header, e.g. "user@host:/etc/nginx/nginx.conf". */
  title: string;
  load: () => Promise<string>;
  save: (text: string) => Promise<void>;
  onClose: () => void;
  onSaved?: () => void;
}

/** A plain text editor for config files and scripts: line numbers, Ctrl+S, unsaved-changes guard. */
export function Editor({ title, load, save, onClose, onSaved }: Props) {
  const ui = useUi();
  const [text, setText] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [wrap, setWrap] = useState(() => localStorage.getItem("td.editorWrap") === "1");
  const crlf = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

  useEffect(() => {
    load()
      .then((t) => {
        // <textarea> normalizes line breaks to \n; remember CRLF files to write them back as they were.
        crlf.current = t.includes("\r\n");
        const norm = t.replace(/\r\n/g, "\n");
        setText(norm);
        setOriginal(norm);
        requestAnimationFrame(() => {
          area.current?.focus();
          area.current?.setSelectionRange(0, 0);
        });
      })
      .catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = text !== null && text !== original;
  const lines = useMemo(() => (text ?? "").split("\n").length, [text]);
  // One text node instead of a div per line: stays fast on files with 100k+ lines.
  const gutterText = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join("\n"), [lines]);

  const doSave = async () => {
    if (text === null || saving) return;
    setSaving(true);
    try {
      await save(crlf.current ? text.replace(/\n/g, "\r\n") : text);
      setOriginal(text);
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

  const updateCursor = () => {
    const el = area.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const line = before.split("\n").length;
    setCursor({ line, col: el.selectionStart - before.lastIndexOf("\n") });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === "KeyS") {
      e.preventDefault();
      doSave();
    } else if (e.key === "Tab" && !mod) {
      e.preventDefault();
      // execCommand keeps the native undo stack intact.
      document.execCommand("insertText", false, "\t");
    } else if (e.key === "Enter" && !mod) {
      // Keep the indentation of the current line.
      const el = e.currentTarget;
      const lineStart = el.value.lastIndexOf("\n", el.selectionStart - 1) + 1;
      const indent = /^[ \t]*/.exec(el.value.slice(lineStart, el.selectionStart))![0];
      if (indent) {
        e.preventDefault();
        document.execCommand("insertText", false, "\n" + indent);
      }
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="editor"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
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
          <button className="btn btn-sm btn-primary" onClick={doSave} disabled={!dirty || saving} title="Сохранить (Ctrl+S)">
            <ISave size={13} /> Сохранить
          </button>
          <button className="icon-btn" onClick={close} title="Закрыть (Esc)">
            <IClose size={14} />
          </button>
        </div>
        <div className="editor-body">
          {error ? (
            <div className="pane-empty err">{error}</div>
          ) : text === null ? (
            <div className="pane-loading" />
          ) : (
            <>
              {!wrap && (
                <div className="editor-gutter" ref={gutter} aria-hidden>
                  {gutterText}
                </div>
              )}
              <textarea
                ref={area}
                className={`editor-area ${wrap ? "wrap" : ""}`}
                value={text}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => {
                  setText(e.target.value);
                  updateCursor();
                }}
                onKeyDown={onKey}
                onKeyUp={updateCursor}
                onClick={updateCursor}
                onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
              />
            </>
          )}
        </div>
        <div className="editor-foot">
          <span>
            Стр {cursor.line}, стлб {cursor.col}
          </span>
          <span>{lines} строк</span>
          <span>{crlf.current ? "CRLF" : "LF"}</span>
          <span>UTF-8</span>
          <div className="spacer" />
          <span className="muted">Ctrl+S — сохранить · Esc — закрыть</span>
        </div>
      </div>
    </div>
  );
}
