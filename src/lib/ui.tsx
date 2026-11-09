import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { IChevronRight } from "../components/Icons";

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

// ---------- context menu ----------

export type MenuItem =
  | { label: string; icon?: ReactNode; hint?: string; danger?: boolean; disabled?: boolean; onClick: () => void }
  /** Opens a nested menu to the side (on hover, click or ArrowRight). */
  | { label: string; icon?: ReactNode; disabled?: boolean; submenu: MenuItem[] }
  | { header: string }
  | "-";

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface Ui {
  toast: (text: string, kind?: Toast["kind"]) => void;
  dialog: (spec: DialogSpec) => Promise<DialogResult>;
  confirm: (title: string, message?: ReactNode, danger?: boolean) => Promise<boolean>;
  prompt: (title: string, label: string, value?: string) => Promise<string | null>;
  /** Opens a context menu at the pointer (or below an element when `at` is an element). */
  menu: (at: { clientX: number; clientY: number } | HTMLElement, items: MenuItem[]) => void;
}

const UiContext = createContext<Ui>(null!);
export const useUi = () => useContext(UiContext);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [current, setCurrent] = useState<{ spec: DialogSpec; resolve: (r: DialogResult) => void } | null>(null);
  const queue = useRef<{ spec: DialogSpec; resolve: (r: DialogResult) => void }[]>([]);
  const [menuState, setMenuState] = useState<MenuState | null>(null);

  const menu = useCallback((at: { clientX: number; clientY: number } | HTMLElement, items: MenuItem[]) => {
    if (at instanceof HTMLElement) {
      const r = at.getBoundingClientRect();
      setMenuState({ x: r.left, y: r.bottom + 2, items });
    } else setMenuState({ x: at.clientX, y: at.clientY, items });
  }, []);

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
    <UiContext.Provider value={{ toast, dialog, confirm, prompt, menu }}>
      {children}
      {menuState && <MenuView state={menuState} onClose={() => setMenuState(null)} />}
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

/** One opened submenu: index of its item in the parent panel and that item's rect. */
type OpenSub = { index: number; rect: DOMRect; focus: boolean };

// Delay before hover opens/closes a submenu, so a diagonal pointer path doesn't flicker it.
const SUB_DELAY = 180;

function MenuView({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState<OpenSub[]>([]);
  const pathRef = useRef(path);
  pathRef.current = path;
  const timer = useRef<number | undefined>(undefined);

  // Stable anchor: the root panel repositions (and refocuses) only when the menu is reopened.
  const rootAnchor = useMemo(() => ({ x: state.x, y: state.y }), [state]);

  useEffect(() => setPath([]), [state]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const focusItem = (level: number, index: number) =>
    root.current?.querySelector<HTMLButtonElement>(`[data-level="${level}"] [data-index="${index}"]`)?.focus();

  // Closes the deepest submenu and returns focus to the item that opened it.
  const closeLast = () => {
    const p = pathRef.current;
    if (!p.length) return false;
    window.clearTimeout(timer.current);
    setPath(p.slice(0, -1));
    focusItem(p.length - 1, p[p.length - 1].index);
    return true;
  };

  useEffect(() => {
    const down = (e: MouseEvent) => !root.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!closeLast()) onClose();
      }
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const schedule = (fn: () => void) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, SUB_DELAY);
  };

  const open = (level: number, index: number, el: HTMLElement, focus: boolean) => {
    window.clearTimeout(timer.current);
    const p = pathRef.current;
    if (p[level]?.index === index && p.length === level + 1 && !focus) return;
    setPath([...p.slice(0, level), { index, rect: el.getBoundingClientRect(), focus }]);
  };

  // Item lists of every visible panel: the root menu plus each opened submenu.
  const panels: MenuItem[][] = [state.items];
  for (const s of path) {
    const it = panels[panels.length - 1][s.index];
    if (typeof it !== "object" || !("submenu" in it)) break;
    panels.push(it.submenu);
  }

  return (
    <div ref={root}>
      {panels.map((items, level) => (
        <MenuPanel
          key={level === 0 ? "0" : `${level}:${path[level - 1].index}`}
          items={items}
          level={level}
          anchor={level === 0 ? rootAnchor : path[level - 1].rect}
          autoFocus={level === 0 || path[level - 1].focus}
          openIndex={path[level]?.index}
          onEnter={() => level > 0 && window.clearTimeout(timer.current)}
          onHover={(index, el) => {
            const it = items[index];
            if (typeof it === "object" && "submenu" in it && !it.disabled) schedule(() => open(level, index, el, false));
            else if (pathRef.current.length > level) schedule(() => setPath(pathRef.current.slice(0, level)));
            else window.clearTimeout(timer.current);
          }}
          onOpen={(index, el) => open(level, index, el, true)}
          onBack={() => level > 0 && closeLast()}
          onClose={onClose}
        />
      ))}
    </div>
  );
}

function MenuPanel({
  items,
  level,
  anchor,
  autoFocus,
  openIndex,
  onEnter,
  onHover,
  onOpen,
  onBack,
  onClose,
}: {
  items: MenuItem[];
  level: number;
  /** Root: the click point. Submenu: the rect of the item that opened it. */
  anchor: { x: number; y: number } | DOMRect;
  autoFocus: boolean;
  openIndex?: number;
  onEnter: () => void;
  onHover: (index: number, el: HTMLElement) => void;
  onOpen: (index: number, el: HTMLElement) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0, ready: false });

  // Keep the menu inside the window; a submenu goes right of its item, or flips left if it doesn't fit.
  useEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    let x: number, y: number;
    if (anchor instanceof DOMRect) {
      x = anchor.right + width <= W - 4 ? anchor.right : anchor.left - width;
      x = Math.max(4, Math.min(x, W - width - 4));
      // Align the first item with the parent item (panel padding + border), shift up if needed.
      y = Math.max(4, Math.min(anchor.top - 6, H - height - 4));
    } else {
      x = Math.max(4, Math.min(anchor.x, W - width - 4));
      y = anchor.y + height > H - 4 ? Math.max(4, anchor.y - height) : anchor.y;
    }
    setPos({ x, y, ready: true });
    if (level === 0) el.focus();
    else if (autoFocus) el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor]);

  // Arrow-key navigation between enabled items; Right/Left open and close submenus.
  const onKey = (e: React.KeyboardEvent) => {
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const active = document.activeElement as HTMLButtonElement;
    const i = buttons.indexOf(active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[n]?.focus();
    } else if (e.key === "ArrowRight" && i >= 0 && active.dataset.sub) {
      e.preventDefault();
      onOpen(Number(active.dataset.index), active);
    } else if (e.key === "ArrowLeft" && level > 0) {
      e.preventDefault();
      onBack();
    }
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      data-level={level}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, visibility: pos.ready ? "visible" : "hidden" }}
      onKeyDown={onKey}
      onMouseEnter={onEnter}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it === "-" ? (
          <div key={i} className="ctx-sep" />
        ) : "header" in it ? (
          <div key={i} className="ctx-header">
            {it.header}
          </div>
        ) : "submenu" in it ? (
          <button
            key={i}
            data-index={i}
            data-sub="1"
            className={`ctx-item ${openIndex === i ? "open" : ""}`}
            disabled={it.disabled}
            aria-haspopup="menu"
            aria-expanded={openIndex === i}
            onMouseEnter={(e) => onHover(i, e.currentTarget)}
            onClick={(e) => onOpen(i, e.currentTarget)}
          >
            <span className="ctx-icon">{it.icon}</span>
            <span className="ctx-label">{it.label}</span>
            <span className="ctx-arrow">
              <IChevronRight size={12} />
            </span>
          </button>
        ) : (
          <button
            key={i}
            data-index={i}
            className={`ctx-item ${it.danger ? "danger" : ""}`}
            disabled={it.disabled}
            onMouseEnter={(e) => onHover(i, e.currentTarget)}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <span className="ctx-icon">{it.icon}</span>
            <span className="ctx-label">{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
