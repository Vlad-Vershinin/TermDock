import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../lib/api";
import { Key, useT } from "../lib/i18n";
import { PluginPanelFrame, usePlugins } from "../lib/plugins/host";
import { DANGEROUS, ltext, Manifest, Permission, PluginInfo } from "../lib/plugins/types";
import { useSettings } from "../lib/settings";
import { useUi } from "../lib/ui";
import { focusedPane } from "../lib/sessions";
import { IClose, IFolder, IPlugin, IRefresh } from "./Icons";

const permKey = (p: Permission) => `plugins.perm.${p}` as Key;

/** Asks which of the requested permissions to grant; null when cancelled. */
function useGrantDialog() {
  const ui = useUi();
  const tr = useT();
  const { settings } = useSettings();
  return async (m: Manifest, mode: "install" | "enable"): Promise<Permission[] | null> => {
    const name = ltext(m.name, settings.language);
    const title = mode === "install" ? tr("plugins.installTitle", { name, version: m.version }) : tr("plugins.enableTitle", { name });
    const dangerous = m.permissions.some((p) => DANGEROUS.includes(p));
    const r = await ui.dialog({
      title,
      message: (
        <>
          {m.author ? <p className="muted">{tr("plugins.by", { author: m.author })}</p> : null}
          {m.description ? <p>{ltext(m.description, settings.language)}</p> : null}
          <p>{m.permissions.length ? tr("plugins.permsIntro") : tr("plugins.noPerms")}</p>
          {dangerous ? <p className="hint">{tr("plugins.trustWarning")}</p> : null}
        </>
      ),
      fields: m.permissions.map((p) => ({ name: p, label: `${DANGEROUS.includes(p) ? "⚠ " : ""}${tr(permKey(p))} (${p})`, type: "checkbox", value: true })),
      okText: mode === "install" ? tr("plugins.install") : tr("plugins.enable"),
    });
    if (!r) return null;
    return m.permissions.filter((p) => r[p] === true);
  };
}

export function PluginsDialog({ onClose }: { onClose: () => void }) {
  const ui = useUi();
  const tr = useT();
  const { settings } = useSettings();
  const lang = settings.language;
  const { plugins, reload } = usePlugins();
  const grant = useGrantDialog();
  const [busy, setBusy] = useState(false);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      ui.toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const install = (zip: boolean) =>
    run(async () => {
      const picked = await openDialog(
        zip ? { title: tr("plugins.pickZip"), filters: [{ name: "ZIP", extensions: ["zip"] }], multiple: false } : { title: tr("plugins.pickFolder"), directory: true, multiple: false },
      );
      if (typeof picked !== "string") return;
      const m = await api.pluginInspect(picked);
      const granted = await grant(m, "install");
      if (!granted) return;
      await api.pluginInstall(picked, granted);
      await reload();
      ui.toast(tr("plugins.installed", { name: ltext(m.name, lang) }), "success");
    });

  const toggle = (p: PluginInfo, on: boolean) =>
    run(async () => {
      if (!on) await api.pluginSetEnabled(p.id, false);
      else {
        // A plugin copied into the folder by hand has no grants yet: ask, like an install does.
        const askedBefore = p.granted.length > 0 || p.manifest!.permissions.length === 0;
        const granted = askedBefore ? undefined : await grant(p.manifest!, "enable");
        if (granted === null) return;
        await api.pluginSetEnabled(p.id, true, granted);
      }
      await reload();
    });

  const uninstall = (p: PluginInfo) =>
    run(async () => {
      const name = ltext(p.manifest?.name, lang) || p.id;
      if (!(await ui.confirm(tr("plugins.uninstallTitle", { name }), tr("plugins.uninstallText"), true))) return;
      await api.pluginUninstall(p.id);
      await reload();
    });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide plugins" tabIndex={-1} ref={(el) => void (el && !el.contains(document.activeElement) && el.focus())} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h3>{tr("plugins.title")}</h3>
        <p className="hint">{tr("plugins.docsHint")}</p>
        <div className="row plugins-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => install(false)}>
            {tr("plugins.installFolder")}
          </button>
          <button className="btn" disabled={busy} onClick={() => install(true)}>
            {tr("plugins.installZip")}
          </button>
          <div className="spacer" />
          <button className="btn" onClick={() => run(async () => api.openLocalPath(await api.pluginsDir()))} title={tr("plugins.openFolder")}>
            <IFolder size={13} /> {tr("plugins.openFolder")}
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await reload();
                ui.toast(tr("plugins.reloaded"), "success");
              })
            }
          >
            <IRefresh size={13} /> {tr("plugins.reload")}
          </button>
        </div>
        <div className="plugin-list">
          {plugins.length === 0 && <div className="muted plugin-empty">{tr("plugins.empty")}</div>}
          {plugins.map((p) => {
            const m = p.manifest;
            return (
              <div key={p.id} className={`plugin-row ${p.enabled ? "" : "off"}`}>
                <IPlugin size={18} />
                <div className="plugin-main">
                  <div className="plugin-name">
                    {ltext(m?.name, lang) || p.id} <span className="muted">{m?.version}</span>
                    {m?.author ? <span className="muted"> · {tr("plugins.by", { author: m.author })}</span> : null}
                  </div>
                  {m?.description ? <div className="plugin-desc">{ltext(m.description, lang)}</div> : null}
                  {p.error ? (
                    <div className="plugin-error">{tr("plugins.broken", { error: p.error })}</div>
                  ) : (
                    <div className="plugin-perms muted">
                      {p.granted.length ? tr("plugins.permissions", { list: p.granted.map((x) => tr(permKey(x))).join(", ") }) : tr("plugins.permissionsNone")}
                    </div>
                  )}
                </div>
                <label className="check plugin-toggle">
                  <input type="checkbox" checked={p.enabled} disabled={busy || !m} onChange={(e) => toggle(p, e.target.checked)} />
                  {tr("plugins.enabled")}
                </label>
                <button className="btn btn-sm" disabled={busy} onClick={() => uninstall(p)}>
                  {tr("plugins.uninstall")}
                </button>
              </div>
            );
          })}
        </div>
        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn btn-primary" onClick={onClose}>
            {tr("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Ctrl+Shift+P: search and run any plugin command (on the focused session). */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const { settings } = useSettings();
  const { contributions, pluginName, runCommand } = usePlugins();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return contributions.commands
      .map((c) => ({ c, title: ltext(c.title, settings.language), plugin: pluginName(c.pluginId) }))
      .filter((x) => words.every((w) => `${x.title} ${x.plugin}`.toLowerCase().includes(w)));
  }, [q, contributions, settings.language, pluginName]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const pick = (i: number) => {
    const x = items[i];
    if (!x) return;
    onClose();
    runCommand(x.c.pluginId, x.c.id, { paneId: focusedPane.get() });
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input
          autoFocus
          value={q}
          placeholder={tr("plugins.palettePlaceholder")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") setSel((s) => Math.min(items.length - 1, s + 1));
            else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
            else if (e.key === "Enter") pick(sel);
            else return;
            e.preventDefault();
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="muted palette-empty">{tr("plugins.paletteEmpty")}</div>}
          {items.map((x, i) => (
            <div key={`${x.c.pluginId}:${x.c.id}`} className={`palette-item ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => (e.preventDefault(), pick(i))}>
              <IPlugin size={13} />
              <span className="palette-title">{x.title}</span>
              <span className="muted">{x.plugin}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The open sidebar panel of a plugin, as a right tool window. */
export function PluginSidebar() {
  const tr = useT();
  const { settings } = useSettings();
  const { sidebarPanel: panel, closeSidebar, pluginName } = usePlugins();
  if (!panel) return null;
  return (
    <aside className="toolwin plugin-sidebar">
      <div className="toolwin-head">
        <IPlugin size={14} />
        <span className="toolwin-title" title={pluginName(panel.pluginId)}>
          {ltext(panel.title, settings.language)}
        </span>
        <div className="spacer" />
        <button className="icon-btn" onClick={closeSidebar} title={tr("plugins.closePanel")}>
          <IClose size={14} />
        </button>
      </div>
      <PluginPanelFrame panel={panel} />
    </aside>
  );
}
