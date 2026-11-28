import { useEffect, useRef, useState } from 'react';
import { coordinator, providers, tasks as taskApi, type Session, type TaskRun } from '../ipc';
import { useUi } from '../ui';
import { percentLabel, reportCodex, useProviderQuota, type QuotaWindow } from '../usageStore';
import ProviderLogo from '../ProviderLogo';
import { Icon } from './icons';
import { pmActivityKey } from './workspaceContext';

// Cuota de la cuenta y actividad del proyecto, con gestión en el proveedor.
export type Engine = import('../providers').ExecutionProvider;
const NAME: Record<Engine, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
const tokens = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });
const when = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const MANAGE: Record<Engine, { action: string; note: string }> = {
  codex: { action: 'Gestionar créditos y restablecimientos', note: 'Consulta tus créditos y canjea un restablecimiento si tu cuenta dispone de él.' },
  claude: { action: 'Gestionar uso adicional', note: 'Consulta o activa créditos de uso para continuar al alcanzar el límite de tu plan.' },
  agy: { action: 'Ver opciones de cuota y créditos', note: 'Consulta las opciones de tu plan y cómo usar créditos de IA en Antigravity.' },
};

export default function EngineUsage({ project, projectName, sessions, pmEngine, hasPm, open, onOpen, onSession, onSettings }: {
  project: string | null;
  projectName: string | null;
  sessions: Session[];
  pmEngine: Engine;
  hasPm: boolean;
  open: Engine | null;
  onOpen: (e: Engine | null) => void;
  onSession: (v: number | 'coach') => void;
  onSettings: () => void;
}) {
  return (
    <div className="eng-usage">
      {(['claude', 'codex', 'agy'] as Engine[]).map((e) => (
        <EngineButton key={e} engine={e} project={project} projectName={projectName} sessions={sessions} pm={hasPm && pmEngine === e}
          open={open === e} onToggle={() => onOpen(open === e ? null : e)} onClose={() => onOpen(null)} onSession={onSession} onSettings={onSettings} />
      ))}
    </div>
  );
}

function EngineButton({ engine, project, projectName, sessions, pm, open, onToggle, onClose, onSession, onSettings }: {
  engine: Engine; project: string | null; projectName: string | null; sessions: Session[]; pm: boolean; open: boolean;
  onToggle: () => void; onClose: () => void; onSession: (v: number | 'coach') => void; onSettings: () => void;
}) {
  const quota = useProviderQuota(engine, null, false);
  const { activity } = useUi();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const mine = sessions.filter((s) => s.engine === engine);
  const working = mine.filter((s) => activity[String(s.id)] === 'trabajando');
  const pmState = project ? activity[pmActivityKey(project)] : activity.coach;
  const pmWorking = pm && pmState === 'trabajando';
  const waiting = mine.filter((s) => activity[String(s.id)] === 'permiso').length + (pm && pmState === 'permiso' ? 1 : 0);
  const live = working.length + (pmWorking ? 1 : 0);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close.current(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close.current(); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>('.eng-pop header button')?.focus();
  }, [open]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function refresh() {
    setRefreshing(true); setError(null);
    try { reportCodex(await coordinator.rateLimits()); }
    catch { setError('No se pudo actualizar la cuota. Los datos anteriores se conservan.'); }
    finally { setRefreshing(false); }
  }
  async function manage() {
    setError(null);
    try { await providers.openUsage(engine); }
    catch { setError('No se pudo abrir la gestión del proveedor. Inténtalo de nuevo.'); }
  }
  const used = quota.used;
  return (
    <div className="eng-wrap" ref={root}>
      <button ref={trigger} aria-label={`Uso de ${NAME[engine]}`} className={`status-action eng-btn${open ? ' is-on' : ''}${quota.near ? ' is-near' : ''}`} onClick={onToggle} aria-expanded={open}
        title={`${NAME[engine]} · ${quota.status}${used == null ? '' : ` · ${percentLabel(used)} utilizado · ${quota.representative?.label ?? 'ventana informada'}`}${live ? ` · ${live} trabajando` : ''}`}>
        <ProviderLogo engine={engine} size={14} />
        <span className={`eng-meter${used == null ? ' is-unknown' : ''}`} aria-hidden="true">{used != null && <i style={{ width: `${Math.max(0, Math.min(100, used))}%` }} />}</span>
        <span className="num">{used == null ? '—' : percentLabel(used)}</span>
      </button>
      {open && (
        <section className="eng-pop eng-dashboard" role="dialog" aria-label={`Uso de ${NAME[engine]}`}>
          <header><div className="eng-provider-logo"><ProviderLogo engine={engine} size={24} /></div><div><h2>{NAME[engine]}</h2><p className="eng-note">Uso y disponibilidad</p></div><span className="grow" /><button className="icon" onClick={() => { onClose(); trigger.current?.focus(); }} aria-label="Cerrar"><Icon name="close" size={12} /></button></header>
          <div className="eng-sec eng-quota-section">
            <div className="eng-section-heading"><div className="eng-lab">Cuota del proveedor</div><span className={`eng-status${quota.near ? ' is-warning' : ''}`}>{quota.status}</span></div>
            {quota.exhausted && <div className="usage-limit" role="status">{engine === 'agy' ? 'Cuota agotada en el último modelo utilizado' : 'Cuota del plan agotada'}</div>}
            <div className="eng-windows">{quota.windows.length ? quota.windows.map((w) => <Window key={w.label} w={w} />)
              : <div className="eng-empty"><Icon name="info" size={20} /><strong>Cuota todavía no disponible</strong><p className="eng-note">{quota.loading ? 'Consultando cuota…' : engine === 'claude' ? 'Se actualizará cuando Claude informe de sus límites al responder. No necesitas enviar un mensaje solo para consultar este panel.' : engine === 'agy' ? 'Antigravity no ha informado de un consumo agregado. Los tokens de tareas se muestran por separado.' : 'Actualiza para consultar los límites de tu cuenta.'}</p></div>}</div>
            {quota.provider?.message && <p className="eng-note">{quota.provider.message}</p>}
            {quota.provider?.quotaModel && <p className="eng-note">Modelo afectado: {quota.provider.quotaModel}. Las demás cuotas no están confirmadas.</p>}
            <div className="eng-observation"><span>{quota.observedAt ? `${quota.stale ? 'Datos desactualizados' : 'Última lectura'} · ${when.format(quota.observedAt * 1000)}` : 'Sin lectura confirmada'}</span>{engine === 'codex' && <button disabled={refreshing} onClick={() => void refresh()}><Icon name="refresh" size={12} />{refreshing ? 'Actualizando…' : 'Actualizar'}</button>}</div>
            <p className="eng-note">Cuota de la cuenta, compartida entre proyectos. La barra inferior muestra la ventana con mayor consumo.</p>
          </div>
          <div className="eng-manage">
            <button onClick={() => void manage()}>{MANAGE[engine].action}<span aria-hidden="true">↗</span></button>
            <p className="eng-note">{MANAGE[engine].note} Se abre en el navegador del sistema.</p>
            {error && <p className="eng-error" role="alert">{error}</p>}
          </div>
          <div className="eng-sec">
            <div className="eng-lab">Ahora{projectName ? ` en ${projectName}` : ''}</div>
            <div className="eng-stats"><div><b>{mine.length + (pm ? 1 : 0)}</b><span>Sesiones abiertas</span></div><div><b>{live}</b><span>Trabajando</span></div><div className={waiting ? 'amb' : undefined}><b>{waiting}</b><span>Esperan permiso</span></div></div>
            {(pm || mine.length > 0) && (
              <ul className="eng-list">
                {pm && <li><button onClick={() => { onSession('coach'); onClose(); }}><span className={`dot${pmWorking ? ' is-trabajando' : pmState === 'permiso' ? ' is-permiso' : ''}`} />Project manager<span className="grow" /><span className="eng-note">{pmWorking ? 'trabajando' : pmState === 'permiso' ? 'espera permiso' : 'en espera'}</span></button></li>}
                {mine.map((s) => { const st = activity[String(s.id)]; return (
                  <li key={s.id}><button onClick={() => { onSession(s.id); onClose(); }}><span className={`dot${st === 'trabajando' ? ' is-trabajando' : st === 'permiso' ? ' is-permiso' : ''}`} />{s.name}<span className="grow" /><span className="eng-note">{st === 'trabajando' ? 'trabajando' : st === 'permiso' ? 'espera permiso' : s.branch ?? 'en espera'}</span></button></li>); })}
              </ul>
            )}
          </div>
          {project && <Worked project={project} engine={engine} />}
          <button className="usage-tools" onClick={() => { onClose(); onSettings(); }}><Icon name="tools" size={14} /> Herramientas, Jev y presupuestos</button>
        </section>
      )}
    </div>
  );
}

function Window({ w }: { w: QuotaWindow }) {
  const used = Math.max(0, Math.min(100, w.percent));
  const left = w.resetsAt == null ? null : Math.max(0, Math.ceil((w.resetsAt * 1000 - Date.now()) / 60000));
  const duration = left == null ? null : left >= 1440 ? `${Math.floor(left / 1440)} d ${Math.floor(left % 1440 / 60)} h` : left >= 60 ? `${Math.floor(left / 60)} h ${left % 60} min` : `${left} min`;
  const label = w.label === '5 h' ? 'Ventana de 5 horas' : w.label === 'semana' ? 'Consumo semanal' : w.label;
  return (
    <div className={`eng-window${used >= 90 ? ' is-hot' : ''}`}>
      <div className="eng-window-top"><strong>{label}</strong><span><b>{percentLabel(used)}</b> utilizado</span></div>
      <div className="eng-quota-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-valuetext={`${percentLabel(used)} utilizado`}><i style={{ width: `${used}%` }} /></div>
      <div className="eng-window-bottom"><span>{percentLabel(100 - used)} disponible</span>{duration && <strong>Se renueva en {duration}</strong>}</div>
      <p className="eng-note">{w.resetsAt ? <>Renovación · <time dateTime={new Date(w.resetsAt * 1000).toISOString()}>{when.format(w.resetsAt * 1000)}</time></> : 'Fecha de renovación no informada'}</p>
    </div>
  );
}

/** Trabajo registrado por este motor en las ejecuciones de tareas del proyecto (últimos 7 días). */
function Worked({ project, engine }: { project: string; engine: Engine }) {
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  useEffect(() => {
    let alive = true;
    setRuns(null); setIncomplete(false);
    (async () => {
      try {
        const list = await taskApi.list(project);
        const want = list.filter((t) => t.sessions.length || t.status !== 'backlog').slice(0, 40);
        const got = await Promise.allSettled(want.map((t) => taskApi.runs(project, t.id)));
        if (alive) {
          setRuns(got.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
          setIncomplete(got.some((r) => r.status === 'rejected') || list.filter((t) => t.sessions.length || t.status !== 'backlog').length > want.length);
        }
      } catch { if (alive) { setRuns([]); setIncomplete(true); } }
    })();
    return () => { alive = false; };
  }, [project]);
  const since = Date.now() - 7 * 86400000;
  const mine = (runs ?? []).filter((r) => r.provider === engine && r.startedMs >= since);
  const byModel = new Map<string, { n: number; tin: number; tout: number; ms: number; known: number }>();
  for (const r of mine) {
    const k = r.model ?? r.routing?.executionModel ?? 'modelo no informado';
    const v = byModel.get(k) ?? { n: 0, tin: 0, tout: 0, ms: 0, known: 0 };
    v.n++; if (r.inputTokens != null || r.outputTokens != null) v.known++; v.tin += r.inputTokens ?? 0; v.tout += r.outputTokens ?? 0; v.ms += r.durationMs ?? 0;
    byModel.set(k, v);
  }
  const total = [...byModel.values()].reduce((a, v) => ({ n: a.n + v.n, tin: a.tin + v.tin, tout: a.tout + v.tout, ms: a.ms + v.ms, known: a.known + v.known }), { n: 0, tin: 0, tout: 0, ms: 0, known: 0 });
  return (
    <div className="eng-sec">
      <div className="eng-lab">Trabajo registrado · 7 días</div>
      {runs === null ? <p className="eng-note">Leyendo ejecuciones…</p> : !mine.length ? <p className="eng-note">{incomplete ? 'No se pudo confirmar la actividad del proyecto.' : `Ninguna ejecución de tareas con ${NAME[engine]} en este proyecto.`}</p> : <>
        <p className="eng-big"><b>{total.n}</b> {total.n === 1 ? 'ejecución' : 'ejecuciones'} · <b>{total.known ? tokens.format(total.tin + total.tout) : '—'}</b> {total.known === total.n ? 'tokens' : total.known ? 'tokens informados (subtotal)' : 'tokens no disponibles'}{total.ms ? <> · <b>{Math.round(total.ms / 60000)}</b> min</> : null}</p>
        <ul className="eng-models">{[...byModel.entries()].sort((a, b) => b[1].n - a[1].n).map(([m, v]) => <li key={m}><span className="mono">{m}</span><span className="grow" /><span>{v.n} · {v.known ? `${tokens.format(v.tin + v.tout)} tokens${v.known < v.n ? ' (subtotal)' : ''}` : 'tokens no disponibles'}</span></li>)}</ul>
      </>}
      {incomplete && mine.length > 0 && <p className="eng-note">Actividad parcial: algunas tareas no se han podido consultar o quedan fuera de las 40 consultadas.</p>}
      <p className="eng-note">Cuenta las ejecuciones de tareas; las conversaciones directas no registran tokens aquí.</p>
    </div>
  );
}
