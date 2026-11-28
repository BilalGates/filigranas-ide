import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { capabilities, type CapabilityUsage } from '../ipc';
import { KIND_NAMES, ORIGIN_NAMES, POLICY_NAMES, ROLE_NAMES, STATE_NAMES, STATE_TONE, shortSha } from './capabilityLabels';
import { Icon } from './icons';
import './extensions.css';

/**
 * Capacidades de las últimas ejecuciones de una tarea, con su estado real:
 * seleccionada, cargada (huella inyectada), aplicación evidenciada (artefactos
 * o herramientas observadas) y verificada. Nada procede de la autodeclaración.
 */
export function CapabilitiesPanel({ runs, title = 'Capacidades' }: { runs: number[]; title?: string }) {
  const [items, setItems] = useState<CapabilityUsage[] | null>(null);
  const key = runs.join(',');
  const load = useCallback(() => {
    if (!key) { setItems([]); return; }
    capabilities.runs(key.split(',').map(Number)).then(setItems, () => setItems([]));
  }, [key]);
  useEffect(() => {
    load();
    let stop: (() => void) | undefined;
    let alive = true;
    void listen('tasks-changed', load).then((un) => { if (alive) stop = un; else un(); }).catch(() => {});
    return () => { alive = false; stop?.(); };
  }, [load]);
  if (!items || !items.length) return null;
  const verify = (u: CapabilityUsage, verdict: 'passed' | 'failed') => capabilities.verify(u.runId, u.ext, verdict, null).then(load);
  return <div className="sec cap-panel" aria-label={title}>
    <div className="row"><Icon name="facets" size={14} /><b>{title}</b></div>
    {items.map((u) => <div key={`${u.runId}:${u.ext}`} className="cap-row">
      <div className="cap-top">
        <b>{u.name}</b>
        <span className={`chip ${STATE_TONE[u.state]}`}>{STATE_NAMES[u.state]}</span>
        <span className="chip">{POLICY_NAMES[u.policy] ?? u.policy}</span>
        {u.stale && <span className="chip amber">evidencia obsoleta</span>}
      </div>
      <div className="cap-meta">
        {ORIGIN_NAMES[u.origin] ?? u.origin} · {u.origin === 'politica' || u.origin === 'automatica' ? 'decisión de reglas locales' : 'selección manual'}{u.version ? ` · ${u.version}` : ''}{u.commit ? ` @ ${shortSha(u.commit)}` : ''}
        {u.role ? ` · ${ROLE_NAMES[u.role] ?? u.role}` : ''}{u.kind ? ` · ${KIND_NAMES[u.kind] ?? u.kind}` : ''}
        {u.tokens ? ` · ≈${u.tokens.toLocaleString('es')} tokens` : ''} · ejecución #{u.runId}
      </div>
      {u.reason && <div className="cap-meta">{u.reason}</div>}
      {(u.evidence.length > 0 || u.tools.length > 0) && <ul>
        {u.evidence.map((e, i) => <li key={`e${i}`}>{e}</li>)}
        {u.tools.map((t, i) => <li key={`t${i}`} className="mono">{t}</li>)}
      </ul>}
      {u.verification && <div className="cap-meta">Verificación: {u.verification}</div>}
      {u.state === 'evidenced' && <div className="cap-verify">
        <button className="btn sm" onClick={() => void verify(u, 'passed')}><Icon name="check" size={11} /> Aceptar</button>
        <button className="btn sm ghost" onClick={() => void verify(u, 'failed')}>Rechazar</button>
      </div>}
    </div>)}
  </div>;
}
