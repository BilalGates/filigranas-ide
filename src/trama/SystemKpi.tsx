import { useEffect, useState } from 'react';
import { api, type SystemMetrics } from '../ipc';

const GB = 1024 ** 3;

function formatGb(bytes: number) {
  const gb = bytes / GB;
  return gb >= 100 ? gb.toFixed(0) : gb.toFixed(1);
}

function level(pct: number, warn: number, high: number) {
  return pct >= high ? 'high' : pct >= warn ? 'warn' : 'ok';
}

/** KPIs compactos de CPU y RAM del equipo en la esquina inferior izquierda. */
export default function SystemKpi() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);

  useEffect(() => {
    let active = true;
    const poll = () => {
      if (document.visibilityState === 'hidden') return;
      api.systemMetrics().then((m) => { if (active) setMetrics(m); }, () => {});
    };
    poll();
    const timer = window.setInterval(poll, 3000);
    const onVis = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  if (!metrics || metrics.ramTotalBytes === 0) {
    return (
      <div className="status-sys" aria-label="Rendimiento del sistema">
        <span className="sys-kpi">
          <span className="sys-dot is-ok" />
          <span className="sys-label">CPU</span>
          <span className="sys-val">—</span>
        </span>
        <span className="sys-kpi">
          <span className="sys-dot is-ok" />
          <span className="sys-label">RAM</span>
          <span className="sys-val">—</span>
        </span>
      </div>
    );
  }

  const cpuPct = Math.round(metrics.cpuPercent);
  const ramPct = Math.round(metrics.ramPercent);
  const cpuLevel = level(metrics.cpuPercent, 65, 85);
  const ramLevel = level(metrics.ramPercent, 75, 90);
  const ramUsed = formatGb(metrics.ramUsedBytes);
  const ramTotal = formatGb(metrics.ramTotalBytes);

  return (
    <div
      className="status-sys"
      aria-label={`CPU ${cpuPct} %, RAM ${ramUsed} de ${ramTotal} GB (${ramPct} %)`}
      title={`Rendimiento del sistema · CPU ${metrics.cpuPercent.toFixed(1)} % · RAM ${ramUsed} / ${ramTotal} GB (${ramPct} %)`}
    >
      <span className={`sys-kpi is-${cpuLevel}`}>
        <span className={`sys-dot is-${cpuLevel}`} aria-hidden="true" />
        <span className="sys-label">CPU</span>
        <span className="sys-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, cpuPct))}%` }} /></span>
        <span className="sys-val">{cpuPct}%</span>
      </span>
      <span className="sys-sep" aria-hidden="true">·</span>
      <span className={`sys-kpi is-${ramLevel}`}>
        <span className={`sys-dot is-${ramLevel}`} aria-hidden="true" />
        <span className="sys-label">RAM</span>
        <span className="sys-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, ramPct))}%` }} /></span>
        <span className="sys-val">{ramUsed}<small>/{ramTotal} GB</small></span>
      </span>
    </div>
  );
}
