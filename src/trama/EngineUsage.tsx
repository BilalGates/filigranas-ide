import { useEffect, useRef, useState } from 'react';
import { tasks as taskApi, type Session, type TaskRun } from '../ipc';
import { useUi } from '../ui';
import { percentLabel, useProviderQuota, type QuotaWindow } from '../usageStore';
import { Icon } from './icons';

// Uso por motor en la barra de estado: un botón para Claude y otro para Codex.
// Cada uno muestra su cuota restante, las sesiones abiertas y trabajando, y
// el trabajo registrado en las ejecuciones de tareas del proyecto.
export type Engine = 'claude' | 'codex';
const NAME: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' };
const tokens = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });
const when = new Intl.DateTimeFormat('es-ES', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

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
      {(['claude', 'codex'] as Engine[]).map((e) => (
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
  const quota = useProviderQuota(engine, null);
  const { activity } = useUi();
  const root = useRef<HTMLDivElement>(null);
  const mine = sessions.filter((s) => s.engine === engine);
  const working = mine.filter((s) => activity[String(s.id)] === 'trabajando');
  const pmWorking = pm && activity.coach === 'trabajando';
  const waiting = mine.filter((s) => activity[String(s.id)] === 'permiso').length + (pm && activity.coach === 'permiso' ? 1 : 0);
  const live = working.length + (pmWorking ? 1 : 0);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc); };
  }, [open, onClose]);
  const left = quota.remaining;
  return (
    <div className="eng-wrap" ref={root}>
      <button className={`status-action eng-btn${open ? ' is-on' : ''}${quota.near ? ' is-near' : ''}`} onClick={onToggle} aria-expanded={open}
        title={`${NAME[engine]} · ${left == null ? 'cuota desconocida' : `${percentLabel(left)} restante`}${live ? ` · ${live} trabajando` : ''}`}>
        {live > 0 ? <span className="dot is-trabajando" /> : waiting > 0 ? <span className="dot is-permiso" /> : <span className={`eng-mark ${engine}`} />}
        <span>{NAME[engine]}</span>
        <span className="eng-dots" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <i key={i} className={left != null && i < Math.round(left / 10) ? (left <= 15 ? 'low' : 'on') : ''} />)}</span>
        <span className="num">{quota.exhausted ? 'agotada' : left == null ? '—' : percentLabel(left)}</span>
      </button>
      {open && (
        <section className="eng-pop" role="dialog" aria-label={`Uso de ${NAME[engine]}`}>
          <header><span className={`eng-mark ${engine}`} /><h2>{NAME[engine]}</h2><span className="grow" /><button className="icon" onClick={onClose} aria-label="Cerrar"><Icon name="close" size={12} /></button></header>
          <div className="eng-sec">
            <div className="eng-lab">Cuota restante</div>
            {quota.exhausted && <div className="usage-limit" role="status">Cuota del plan agotada</div>}
            {quota.windows.length ? quota.windows.map((w) => <Window key={w.label} w={w} />)
              : <p className="eng-note">{quota.loading ? 'Consultando cuota…' : engine === 'claude' ? 'Claude informa de su cuota al responder a un mensaje.' : 'La CLI todavía no ha informado de la cuota.'}</p>}
          </div>
          <div className="eng-sec">
            <div className="eng-lab">Ahora{projectName ? ` en ${projectName}` : ''}</div>
            <p className="eng-big"><b>{mine.length + (pm ? 1 : 0)}</b> {mine.length + (pm ? 1 : 0) === 1 ? 'sesión abierta' : 'sesiones abiertas'} · <b>{live}</b> trabajando{waiting ? <> · <span className="amb">{waiting} {waiting === 1 ? 'espera' : 'esperan'} permiso</span></> : null}</p>
            {(pm || mine.length > 0) && (
              <ul className="eng-list">
                {pm && <li><button onClick={() => { onSession('coach'); onClose(); }}><span className={`dot${pmWorking ? ' is-trabajando' : activity.coach === 'permiso' ? ' is-permiso' : ''}`} />Project manager<span className="grow" /><span className="eng-note">{pmWorking ? 'trabajando' : activity.coach === 'permiso' ? 'espera permiso' : 'en espera'}</span></button></li>}
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
  const remaining = Math.max(0, Math.min(100, 100 - w.percent));
  return (
    <div className="uso-row" title={w.resetsAt ? `Se renueva el ${when.format(w.resetsAt * 1000)}` : undefined}>
      <span>{w.label}</span>
      <span className="bar" aria-hidden="true"><i style={{ width: `${remaining}%` }} className={remaining <= 10 ? 'is-hot' : undefined} /></span>
      <span className="num">{percentLabel(remaining)}</span>
    </div>
  );
}

/** Trabajo registrado por este motor en las ejecuciones de tareas del proyecto (últimos 7 días). */
function Worked({ project, engine }: { project: string; engine: Engine }) {
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await taskApi.list(project);
        const want = list.filter((t) => t.sessions.length || t.status !== 'backlog').slice(0, 40);
        const got = await Promise.allSettled(want.map((t) => taskApi.runs(project, t.id)));
        if (alive) setRuns(got.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
      } catch { if (alive) setRuns([]); }
    })();
    return () => { alive = false; };
  }, [project]);
  const since = Date.now() - 7 * 86400000;
  const mine = (runs ?? []).filter((r) => r.provider === engine && r.startedMs >= since);
  const byModel = new Map<string, { n: number; tin: number; tout: number; ms: number }>();
  for (const r of mine) {
    const k = r.model ?? r.routing?.model ?? 'modelo predeterminado';
    const v = byModel.get(k) ?? { n: 0, tin: 0, tout: 0, ms: 0 };
    v.n++; v.tin += r.inputTokens ?? 0; v.tout += r.outputTokens ?? 0; v.ms += r.durationMs ?? 0;
    byModel.set(k, v);
  }
  const total = [...byModel.values()].reduce((a, v) => ({ n: a.n + v.n, tin: a.tin + v.tin, tout: a.tout + v.tout, ms: a.ms + v.ms }), { n: 0, tin: 0, tout: 0, ms: 0 });
  return (
    <div className="eng-sec">
      <div className="eng-lab">Trabajo registrado · 7 días</div>
      {runs === null ? <p className="eng-note">Leyendo ejecuciones…</p> : !mine.length ? <p className="eng-note">Ninguna ejecución de tareas con {NAME[engine]} en este proyecto.</p> : <>
        <p className="eng-big"><b>{total.n}</b> {total.n === 1 ? 'ejecución' : 'ejecuciones'} · <b>{tokens.format(total.tin + total.tout)}</b> tokens{total.ms ? <> · <b>{Math.round(total.ms / 60000)}</b> min</> : null}</p>
        <ul className="eng-models">{[...byModel.entries()].sort((a, b) => b[1].n - a[1].n).map(([m, v]) => <li key={m}><span className="mono">{m}</span><span className="grow" /><span>{v.n} · {tokens.format(v.tin + v.tout)} tokens</span></li>)}</ul>
      </>}
      <p className="eng-note">Cuenta las ejecuciones de tareas; las conversaciones directas no registran tokens aquí.</p>
    </div>
  );
}
