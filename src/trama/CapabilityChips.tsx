import { useCallback, useEffect, useState } from 'react';
import { capabilities, extensions, TASK_KINDS, type CapabilitySession, type Extension } from '../ipc';
import { KIND_NAMES, ORIGIN_NAMES } from './capabilityLabels';
import './extensions.css';

const CHANGED = 'filigranas:capabilities-changed';
const notify = () => window.dispatchEvent(new Event(CHANGED));

function useSessionCapabilities(session: number) {
  const [data, setData] = useState<CapabilitySession | null>(null);
  const load = useCallback(() => capabilities.session(session, null).then(setData, () => setData(null)), [session]);
  useEffect(() => {
    void load();
    window.addEventListener(CHANGED, load);
    return () => window.removeEventListener(CHANGED, load);
  }, [load]);
  return data;
}

const engineKey = (engine: string) => (engine === 'claude' || engine === 'codex' ? engine : 'agy');

/**
 * Indicadores discretos de las capacidades del próximo turno: solicitadas por
 * el usuario (eliminables), obligatorias por política y automáticas. No
 * activan ni ejecutan nada por sí mismas: el backend resuelve al enviar.
 */
export function CapabilityChips({ session }: { session: number }) {
  const data = useSessionCapabilities(session);
  if (!data) return null;
  const requested = new Map(data.requested);
  const shown = data.preview.choices.filter((c) => c.state !== 'skipped');
  if (!shown.length) return null;
  return <span className="cap-chips" aria-label="Capacidades del próximo turno">
    {shown.map((c) => {
      const mine = requested.get(c.id) === 'usuario';
      const tone = c.state === 'blocked' ? 'is-blocked' : c.origin === 'politica' ? 'is-policy' : c.origin === 'automatica' ? 'is-auto' : '';
      const title = `${c.name} ${c.version} · ${ORIGIN_NAMES[c.origin] ?? c.origin}${c.state === 'blocked' ? ` · bloqueada: ${c.reason}` : ''}`;
      return <span key={c.id} className={`cap-chip ${tone}`} title={title}>
        {c.name}
        {mine && <button type="button" aria-label={`Quitar ${c.name}`} onClick={() => capabilities.request(session, c.id, false).then(notify)}>×</button>}
      </span>;
    })}
  </span>;
}

/** Entrada del menú «+»: elegir capacidades compatibles y el tipo de trabajo. */
export function CapabilityMenu({ session, engine, onClose }: { session: number; engine: string; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Extension[]>([]);
  const data = useSessionCapabilities(session);
  useEffect(() => { if (open) extensions.list().then(setItems, () => setItems([])); }, [open]);
  if (!open) return <button className="menu-item" type="button" onClick={() => setOpen(true)}>Capacidades…</button>;
  const requested = new Set((data?.requested ?? []).map(([id]) => id));
  const usable = items.filter((x) => x.installed && x.enabled && x.providers[engineKey(engine)] !== 'none');
  const kind = data?.kind ?? '';
  return <div className="cap-menu" role="group" aria-label="Capacidades de la tarea">
    <label>Tipo <select className="in" value={kind} aria-label="Tipo de trabajo"
      onChange={(e) => capabilities.setKind(session, e.currentTarget.value || null).then(notify)}>
      <option value="">Automático{data?.preview.kind ? ` (${KIND_NAMES[data.preview.kind] ?? data.preview.kind})` : ''}</option>
      {TASK_KINDS.map((k) => <option key={k} value={k}>{KIND_NAMES[k]}</option>)}
    </select></label>
    {usable.length === 0 && <p className="cap-hint">No hay extensiones instaladas y compatibles con este motor. Instálalas en Ajustes › Extensiones.</p>}
    {usable.map((x) => <label key={x.id} title={x.description}>
      <input type="checkbox" checked={requested.has(x.id)} onChange={(e) => capabilities.request(session, x.id, e.currentTarget.checked).then(notify)} />
      {x.name} <span className="mono cap-hint">{x.version}</span>
    </label>)}
    <p className="cap-hint">Las obligatorias y automáticas las añade Filigranas según el rol y el tipo de trabajo.</p>
    <button className="menu-item" type="button" onClick={() => { setOpen(false); onClose(); }}>Hecho</button>
  </div>;
}
