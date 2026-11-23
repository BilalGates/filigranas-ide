import { useEffect, useRef, useState, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import { jev, type JevStatus, type JevStatusbar, type JevUsage as Usage } from '../ipc';
import { Icon } from './icons';

const tokens = new Intl.NumberFormat('es-ES');
const euros = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 4 });

const MODE: Record<JevStatus['settings']['mode'], string> = {
  local: 'Desactivado · enrutado local',
  active: 'Activo · decide el modelo de cada tarea',
  shadow: 'Observación · recomienda sin decidir',
};
const SHORT: Record<JevStatusbar['mode'], string> = { local: 'local', shadow: 'sombra', active: 'activo' };
const POLICY: Record<JevStatus['settings']['policy'], string> = { economy: 'Económica', balanced: 'Equilibrada', quality: 'Calidad' };

/** Jev en la barra de estado: modo e intentos del día; al abrirlo, tokens, coste y enrutado. */
export default function JevUsage({ open, onOpen, onSettings, onTools, buttonRef }: {
  open: boolean; onOpen: (open: boolean) => void; onSettings: () => void; onTools: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [bar, setBar] = useState<JevStatusbar | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<JevStatus | null>(null);
  const [usdPerEuro, setUsdPerEuro] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef(onOpen);
  toggle.current = onOpen;

  useEffect(() => {
    let revision = 0;
    let active = true;
    const refresh = () => {
      const requested = ++revision;
      jev.usage().then((u) => { if (requested === revision) { setUsage(u); setFailed(false); } }, () => { if (requested === revision) setFailed(true); });
    };
    const unlisten = listen('tasks-changed', refresh);
    void unlisten.then(() => { if (active) refresh(); });
    return () => { active = false; revision++; void unlisten.then((off) => off()); };
  }, []);

  useEffect(() => {
    let version = 0;
    const refresh = () => {
      const request = ++version;
      jev.statusbar().then((v) => { if (request === version) setBar(v); }, () => { if (request === version) setBar(null); });
    };
    refresh();
    const off = listen('tasks-changed', refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => { version++; window.clearInterval(timer); void off.then((stop) => stop()); };
  }, []);

  const needsRate = (usage?.costUsd ?? 0) > 0;
  useEffect(() => {
    if (!needsRate) return;
    let active = true;
    jev.euroRate().then((r) => { if (active) setUsdPerEuro(r); }, () => { if (active) setUsdPerEuro(null); });
    return () => { active = false; };
  }, [needsRate]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    jev.status().then((s) => { if (active) setStatus(s); }, () => { if (active) setStatus(null); });
    const out = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) toggle.current(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') toggle.current(false); };
    document.addEventListener('pointerdown', out); document.addEventListener('keydown', esc);
    return () => { active = false; document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc); };
  }, [open]);

  const cost = !usage || usage.costUsd === null ? null
    : usage.costUsd === 0 ? euros.format(0)
    : usdPerEuro === null ? null : euros.format(usage.costUsd / usdPerEuro);

  return (
    <div className="eng-wrap" ref={root}>
      <button ref={buttonRef} className={`status-action eng-btn${open ? ' is-on' : ''}`} onClick={() => onOpen(!open)} aria-expanded={open}
        aria-label={`Jev${bar ? ` ${SHORT[bar.mode]} · ${bar.used} de ${bar.limit} intentos hoy` : ''}${usage ? ` · ${tokens.format(usage.tokens)} tokens` : ''}`} title="Jev: intentos de las últimas 24 horas">
        <Icon name="route" size={13} />Jev{bar && <span className="mut">{SHORT[bar.mode]}</span>}{bar && <span className="num">{bar.used}/{bar.limit}</span>}
      </button>
      {open && (
        <section className="eng-pop" role="dialog" aria-label="Consumo de Jev">
          <header><span className="eng-mark jev" /><h2>Jev</h2><span className="grow" /><button className="icon" onClick={() => onOpen(false)} aria-label="Cerrar"><Icon name="close" size={12} /></button></header>
          <div className="eng-sec">
            <div className="eng-lab">Consumo</div>
            {bar && <p className="eng-big"><b>{bar.used}</b> de {bar.limit} intentos en las últimas 24 horas</p>}
            {failed ? <p className="eng-note">Consumo no disponible.</p> : !usage ? <p className="eng-note">Consultando consumo…</p> : <>
              <p className="eng-big"><b>{tokens.format(usage.tokens)}</b> tokens en total · {cost === null ? 'coste no disponible' : <b>≈ {cost}</b>}</p>
              <p className="eng-note">Suma de las llamadas a la API de Jev para enrutar tareas. Coste estimado con la tarifa de TypeSafe y el cambio de referencia del BCE.</p>
            </>}
          </div>
          <div className="eng-sec">
            <div className="eng-lab">Enrutado</div>
            {!status ? <p className="eng-note">Consultando estado…</p> : !status.supported ? <p className="eng-note">Jev no está disponible en este equipo.</p> : (
              <ul className="eng-models">
                <li><span className="grow">Modo</span><span>{MODE[status.settings.mode]}</span></li>
                <li><span className="grow">Política</span><span>{POLICY[status.settings.policy]}</span></li>
                {status.settings.model && <li><span className="grow">Modelo</span><span>{status.settings.model}</span></li>}
                {status.settings.lightModel && <li><span className="grow">Modelo ligero</span><span>{status.settings.lightModel}</span></li>}
              </ul>
            )}
          </div>
          <div className="row eng-actions">
            <button className="usage-tools" onClick={() => { onOpen(false); onTools(); }}><Icon name="tools" size={14} /> Herramientas</button>
            <button className="usage-tools" onClick={() => { onOpen(false); onSettings(); }}><Icon name="settings" size={14} /> Configurar Jev</button>
          </div>
        </section>
      )}
    </div>
  );
}
