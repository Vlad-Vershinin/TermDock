import { useEffect, useRef, useState } from "react";
import { api, errorText, Stats } from "../lib/api";
import { formatSize } from "../lib/paths";
import { T, useT } from "../lib/i18n";

const INTERVAL = 3000;

function level(p: number) {
  return p >= 90 ? "crit" : p >= 70 ? "warn" : "ok";
}

function Meter({ label, percent, text, short, title }: { label: string; percent: number | null; text: string; short?: string; title?: string }) {
  const p = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <span className={`meter ${percent == null ? "" : level(p)}`} title={title}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar">
        <span style={{ width: `${p}%` }} />
      </span>
      <span className={`meter-val ${short ? "full" : ""}`}>{text}</span>
      {short && <span className="meter-val short">{short}</span>}
    </span>
  );
}

function uptimeText(tr: T, sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? tr("telemetry.uptimeDays", { d, h }) : h ? tr("telemetry.uptimeHours", { h, m }) : tr("telemetry.uptimeMinutes", { m });
}

const pct = (used: number, total: number) => (total ? (100 * used) / total : 0);

/** Per-core load: labelled rows for a few cores, a grid of tiny columns for many. */
function Cores({ cores }: { cores: number[] }) {
  const tr = useT();
  const dense = cores.length > 16;
  return (
    <>
      <div className="tp-sub">{tr("telemetry.cores")}</div>
      <div className={`tp-cores ${dense ? "dense" : ""}`}>
        {cores.map((c, i) => {
          const p = Math.max(0, Math.min(100, c));
          const title = tr("telemetry.core", { i, p: Math.round(p) });
          return dense ? (
            <span key={i} className={`tp-core-cell ${level(p)}`} title={title}>
              <span style={{ height: `${p}%` }} />
            </span>
          ) : (
            <span key={i} className="tp-core" title={title}>
              <span className="tp-core-n">{i}</span>
              <span className={`meter-bar wide ${level(p)}`}>
                <span style={{ width: `${p}%` }} />
              </span>
              <span className="tp-core-v">{Math.round(p)}%</span>
            </span>
          );
        })}
      </div>
    </>
  );
}

/** Compact CPU / RAM / disk meters for a connected session, with a details popover. */
export function Telemetry({ sessionId, visible }: { sessionId: string | null; visible: boolean }) {
  const tr = useT();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Popover position (fixed: the session bar clips overflowing content).
  const [open, setOpen] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setStats(null);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !visible) return;
    let stop = false;
    let timer: number | undefined;
    let failures = 0;
    const tick = async (first: boolean) => {
      try {
        const s = await api.stats(sessionId);
        if (stop) return;
        failures = 0;
        setStats(s);
        setError(null);
      } catch (e) {
        if (stop) return;
        failures++;
        setError(errorText(e));
        if (failures >= 3) return; // unsupported system / no permissions: stop polling
      }
      // The first sample has no CPU delta yet; take the second one sooner.
      timer = window.setTimeout(() => tick(false), first ? 1000 : INTERVAL);
    };
    tick(true);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [sessionId, visible]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [open]);

  if (!sessionId) return null;
  if (!stats) return error ? <span className="telemetry muted" title={error}>{tr("telemetry.none")}</span> : <span className="telemetry muted">…</span>;

  const root = stats.disks[0];
  return (
    <div className="telemetry-wrap" ref={ref}>
      <button className={`telemetry ${open ? "on" : ""}`} onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
        }} title={tr("telemetry.title")}>
        <Meter label="CPU" percent={stats.cpu ?? null} text={stats.cpu == null ? "…" : `${Math.round(stats.cpu)}%`} />
        <Meter label="RAM" percent={pct(stats.memUsed, stats.memTotal)} text={`${formatSize(stats.memUsed)} / ${formatSize(stats.memTotal)}`}
          short={`${Math.round(pct(stats.memUsed, stats.memTotal))}%`}
          title={tr("telemetry.memUsed", { used: formatSize(stats.memUsed), total: formatSize(stats.memTotal) })}
        />
        {root && <Meter label={tr("telemetry.disk")} percent={pct(root.used, root.total)} text={`${Math.round(pct(root.used, root.total))}%`} title={`${root.mount}: ${tr("telemetry.of", { used: formatSize(root.used), total: formatSize(root.total) })}`} />}
      </button>
      {open && (
        <div className="telemetry-pop" style={open}>
          <div className="tp-head">
            <b>{stats.hostname ?? tr("telemetry.server")}</b>
            {stats.os && <span className="muted">{stats.os}</span>}
          </div>
          <div className="tp-grid">
            <span className="muted">{tr("telemetry.cpu")}</span>
            <span>
              {stats.cpu == null ? "…" : `${stats.cpu.toFixed(1)}%`}
              {stats.cpus ? <span className="muted"> · {tr("telemetry.cpuCount", { n: stats.cpus })}</span> : null}
            </span>
            {stats.load && (
              <>
                <span className="muted">Load average</span>
                <span>{stats.load.map((x) => x.toFixed(2)).join("  ")}</span>
              </>
            )}
            <span className="muted">{tr("telemetry.memory")}</span>
            <span>
              {tr("telemetry.of", { used: formatSize(stats.memUsed), total: formatSize(stats.memTotal) })} <span className="muted">({Math.round(pct(stats.memUsed, stats.memTotal))}%)</span>
            </span>
            {stats.swapTotal > 0 && (
              <>
                <span className="muted">Swap</span>
                <span>
                  {tr("telemetry.of", { used: formatSize(stats.swapUsed), total: formatSize(stats.swapTotal) })}
                </span>
              </>
            )}
            {stats.uptime != null && (
              <>
                <span className="muted">{tr("telemetry.uptime")}</span>
                <span>{uptimeText(tr, stats.uptime)}</span>
              </>
            )}
          </div>
          {stats.cores && stats.cores.length > 1 && <Cores cores={stats.cores} />}
          {stats.disks.length > 0 && (
            <>
              <div className="tp-sub">{tr("telemetry.disks")}</div>
              {stats.disks.map((d) => (
                <div key={d.fs + d.mount} className="tp-disk" title={d.fs}>
                  <span className="tp-mount">{d.mount}</span>
                  <span className={`meter-bar wide ${level(pct(d.used, d.total))}`}>
                    <span style={{ width: `${pct(d.used, d.total)}%` }} />
                  </span>
                  <span className="muted">
                    {formatSize(d.used)} / {formatSize(d.total)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
