import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

// ---------- toasts ----------

type Toast = { id: number; kind: "info" | "error" | "success"; text: string };

// ---------- modal dialogs (promise based) ----------

type Field = { name: string; label: string; type?: "text" | "password" | "checkbox"; value?: string | boolean; placeholder?: string };

interface DialogSpec {
  title: string;
  message?: ReactNode;
  fields?: Field[];
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}

type DialogResult = Record<string, string | boolean> | null;

interface Ui {
  toast: (text: string, kind?: Toast["kind"]) => void;
  dialog: (spec: DialogSpec) => Promise<DialogResult>;
  confirm: (title: string, message?: ReactNode, danger?: boolean) => Promise<boolean>;
  prompt: (title: string, label: string, value?: string) => Promise<string | null>;
}

const UiContext = createContext<Ui>(null!);
export const useUi = () => useContext(UiContext);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [current, setCurrent] = useState<{ spec: DialogSpec; resolve: (r: DialogResult) => void } | null>(null);
  const queue = useRef<{ spec: DialogSpec; resolve: (r: DialogResult) => void }[]>([]);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);

  const dialog = useCallback(
    (spec: DialogSpec) =>
      new Promise<DialogResult>((resolve) => {
        const item = { spec, resolve };
        setCurrent((cur) => {
          if (cur) {
            queue.current.push(item);
            return cur;
          }
          return item;
        });
      }),
    [],
  );

  const close = (r: DialogResult) => {
    current?.resolve(r);
    setCurrent(queue.current.shift() ?? null);
  };

  const confirm = useCallback(
    async (title: string, message?: ReactNode, danger?: boolean) =>
      (await dialog({ title, message, danger, okText: danger ? "Удалить" : "OK" })) !== null,
    [dialog],
  );

  const prompt = useCallback(
    async (title: string, label: string, value = "") => {
      const r = await dialog({ title, fields: [{ name: "v", label, value }] });
      const v = r ? String(r.v).trim() : "";
      return v || null;
    },
    [dialog],
  );

  return (
    <UiContext.Provider value={{ toast, dialog, confirm, prompt }}>
      {children}
      {current && <DialogView key={current.spec.title + Math.random()} spec={current.spec} onClose={close} />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </UiContext.Provider>
  );
}

function DialogView({ spec, onClose }: { spec: DialogSpec; onClose: (r: DialogResult) => void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries((spec.fields ?? []).map((f) => [f.name, f.value ?? (f.type === "checkbox" ? false : "")])),
  );
  const firstInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstInput.current?.focus();
    firstInput.current?.select();
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(null)}>
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          onClose(values);
        }}
        onKeyDown={(e) => e.key === "Escape" && onClose(null)}
      >
        <h3>{spec.title}</h3>
        {spec.message && <div className="modal-message">{spec.message}</div>}
        {(spec.fields ?? []).map((f, i) =>
          f.type === "checkbox" ? (
            <label key={f.name} className="check">
              <input type="checkbox" checked={!!values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
              {f.label}
            </label>
          ) : (
            <label key={f.name} className="field">
              <span>{f.label}</span>
              <input
                ref={i === 0 ? firstInput : undefined}
                type={f.type ?? "text"}
                placeholder={f.placeholder}
                value={String(values[f.name] ?? "")}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              />
            </label>
          ),
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => onClose(null)}>
            {spec.cancelText ?? "Отмена"}
          </button>
          <button type="submit" className={`btn ${spec.danger ? "btn-danger" : "btn-primary"}`} autoFocus={!spec.fields?.length}>
            {spec.okText ?? "OK"}
          </button>
        </div>
      </form>
    </div>
  );
}
