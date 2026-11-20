import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { jev, type JevUsage } from './ipc';
import { percentLabel, type ProviderQuota, type QuotaWindow } from './usageStore';

const dateTime = new Intl.DateTimeFormat('es-ES', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const tokens = new Intl.NumberFormat('es-ES');
const euros = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 8 });

function Quota({ window }: { window: QuotaWindow }) {
  const remaining = Math.max(0, Math.min(100, 100 - window.percent));
  return (
    <div className="uso-row" title={window.resetsAt ? `Se renueva el ${dateTime.format(window.resetsAt * 1000)}` : undefined}>
      <span>{window.label}</span>
      <span className="bar" aria-hidden="true">
        <i style={{ width: `${remaining}%` }} className={remaining <= 10 ? 'is-hot' : undefined} />
      </span>
      <span className="num">{percentLabel(remaining)}</span>
    </div>
  );
}

export default function UsagePanel({ engine, label, model, quota }: { engine: string | null; label: string | null; model: string | null; quota: ProviderQuota }) {
  const [usage, setUsage] = useState<JevUsage | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [usdPerEuro, setUsdPerEuro] = useState<number | null>(null);
  const needsRate = (usage?.costUsd ?? 0) > 0;

  useEffect(() => {
    let revision = 0;
    const refresh = () => {
      const requested = ++revision;
      jev.usage().then((usage) => {
        if (requested !== revision) return;
        setUsage(usage);
        setUsageFailed(false);
      }, () => {
        if (requested === revision) setUsageFailed(true);
      });
    };
    let active = true;
    const unlisten = listen('tasks-changed', refresh);
    void unlisten.then(() => { if (active) refresh(); });
    return () => {
      active = false;
      revision++;
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!needsRate) return;
    let active = true;
    jev.euroRate().then((rate) => {
      if (active) setUsdPerEuro(rate);
    }, () => {
      if (active) setUsdPerEuro(null);
    });
    return () => { active = false; };
  }, [needsRate]);

  const cost = !usage || usage.costUsd === null || (needsRate && usdPerEuro === null)
    ? null
    : euros.format(usage.costUsd / (usdPerEuro ?? 1));

  const provider = engine === 'codex' || engine === 'claude' ? engine : null;
  const { windows, exhausted, loading } = quota;

  return (
    <section className="uso" aria-label="Uso restante y consumo de Jev">
      {label ? (
          <div>
            <div className="uso-h">{label}{provider && ' · cuota restante'}</div>
            {model && <div className="usage-model">{model}</div>}
            {exhausted && <div className="usage-limit" role="status">Cuota del plan agotada</div>}
            {windows.length > 0 ? windows.map((w, i) => <Quota key={i} window={w} />) :
              !exhausted && <div className="muted">{loading ? 'Consultando cuota…' :
                provider === 'claude' ? 'Claude informa de la cuota al responder a un mensaje.' : 'Cuota no disponible'}</div>}
          </div>
      ) : <div className="muted">Abre una sesión para ver su cuota.</div>}
      <div>
        <div className="uso-h">Jev · consumo registrado</div>
        {usageFailed ? <div className="muted">Consumo no disponible</div> : usage ? (
          <div className="uso-spend">
            <span>{tokens.format(usage.tokens)} tokens</span>
            <span title={cost === null ? undefined : 'Coste estimado según la tarifa de TypeSafe y el cambio de referencia del BCE'}>
              {cost === null ? 'Coste no disponible' : `≈ ${cost}`}
            </span>
          </div>
        ) : <div className="muted">Consultando consumo…</div>}
      </div>
    </section>
  );
}
