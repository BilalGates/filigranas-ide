import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { EFFORT_LABEL } from './Conversation';
import { pr, tasks, type Session, type Task, type TaskEdit, type TaskRun } from './ipc';
import { CHECK_STATE } from './Publish';

const STATUS: Record<string, string> = {
  backlog: 'pendiente', ready: 'lista', running: 'en marcha', waiting_approval: 'espera permiso',
  verifying: 'verificación', review: 'revisión', ready_to_merge: 'lista para integrar', done: 'completada',
  blocked: 'bloqueada', paused_quota: 'pausada por cuota', failed: 'fallida', cancelled: 'cancelada',
};
const MANUAL = ['backlog', 'ready', 'blocked', 'verifying', 'review', 'ready_to_merge', 'done', 'failed', 'cancelled'];
const PRIORITY = { urgent: 'urgente', high: 'alta', normal: 'normal', low: 'baja' };
const RISK = { low: 'bajo', normal: 'normal', high: 'alto', critical: 'crítico' };
const TESTS = { passed: 'correctas', failed: 'fallidas', not_applicable: 'no aplican' };
const OUTCOME: Record<string, string> = {
  running: 'en marcha', completed: 'terminado', failed: 'fallido', cancelled: 'cancelado',
  interrupted: 'interrumpido', paused_quota: 'pausado por cuota',
};
const EMPTY: TaskEdit = {
  id: null, parentId: null, title: '', goal: '', criteria: '', priority: 'normal', risk: 'normal',
  status: 'backlog', verification: '', tests: null, dependencies: [],
};
const ROUTE_REASON: Record<string, string> = {
  credential: 'credencial inaccesible', rate_limit: 'límite de TypeSafe', timeout: 'plazo agotado',
  unavailable: 'TypeSafe no disponible', invalid_response: 'respuesta inválida', capability: 'capacidad del modelo',
  policy: 'política local', confidence: 'confianza insuficiente', busy: 'consulta en curso', budget: 'límite local de consultas',
};
const ROUTE_ADVICE: Record<string, string> = {
  simple: 'sencilla', standard: 'habitual', complex: 'compleja', critical: 'crítica', independent: 'independiente',
  reuse: 'reutilizar el contexto', recover: 'recuperar archivos y evidencias', summarize: 'resumir con Codex', handoff: 'preparar un relevo',
  inspect: 'inspeccionar el estado local', retry_after_checks: 'valorar un reintento tras verificar el estado', ask_user: 'consultar al usuario',
};

type Props = {
  project: string;
  hidden: boolean;
  sessions: Session[];
  focus: { id: number } | null;
  onAuto: (task: Task) => void;
  onDirect: (engine: string, task: number) => void;
  onSession: (id: number) => void;
  onPublish: (session: Session) => void;
};

export default function Tasks({ project, hidden, sessions, focus, onAuto, onDirect, onSession, onPublish }: Props) {
  const [list, setList] = useState<Task[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [edit, setEdit] = useState<TaskEdit | null>(null);
  const [filter, setFilter] = useState('');
  const [history, setHistory] = useState<{ task: number | null; runs: TaskRun[] }>({ task: null, runs: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState<number | null>(null);
  const task = list.find((item) => item.id === selected);
  const runs = history.task === selected ? history.runs : [];

  useEffect(() => {
    if (!focus) return;
    setSelected(focus.id);
    setFilter('');
    setEdit(null);
    setError(null);
  }, [focus]);

  const refresh = useCallback(async () => {
    const items = await tasks.list(project);
    const history = selected == null ? [] : await tasks.runs(project, selected);
    setList(items);
    setHistory({ task: selected, runs: history });
  }, [project, selected]);

  useEffect(() => {
    if (hidden) return;
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => refresh().catch((e) => setError(String(e))), 100);
    };
    const unlisten = listen('tasks-changed', update);
    update();
    return () => {
      window.clearTimeout(timer);
      unlisten.then((off) => off());
    };
  }, [hidden, refresh]);

  useEffect(() => {
    if (!hidden) tasks.parallelLimit(project).then(setLimit, (e) => setError(String(e)));
  }, [hidden, project]);

  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!edit) return;
    void action(async () => {
      const id = await tasks.save(project, edit);
      setEdit(null);
      setSelected(id);
    });
  };

  const field = <K extends keyof TaskEdit>(key: K, value: TaskEdit[K]) => setEdit((draft) => draft && { ...draft, [key]: value });
  const label = (id: number) => list.find((item) => item.id === id)?.title ?? `#${id}`;
  const available = sessions.filter((s) => !task?.sessions.some((link) => link.id === s.id));
  const blocked = !!task && (task.waitingFor.length > 0 || ['backlog', 'blocked', 'done', 'cancelled'].includes(task.status));
  const visible = list.filter((item) => !filter || item.status === filter).sort(
    (a, b) => Object.keys(PRIORITY).indexOf(a.priority) - Object.keys(PRIORITY).indexOf(b.priority) || b.id - a.id,
  );

  return (
    <section className="coach tasks" aria-label="Tareas del proyecto" hidden={hidden}>
      <div className="co-head">
        <span>tareas</span>
        <span className="push" />
        <select className="chip-select" aria-label="Filtrar tareas por estado" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">todos los estados</option>
          {Object.entries(STATUS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        {limit != null && <label className="task-limit-control">límite <input className="task-limit" aria-label="Máximo de tareas simultáneas" title="máximo de tareas simultáneas"
          key={limit} type="number" min={1} step={1} defaultValue={limit} onBlur={(e) => {
            const value = e.target.valueAsNumber;
            if (value === limit) return;
            if (!e.target.validity.valid || !Number.isInteger(value)) { e.target.value = String(limit); return; }
            const element = e.target;
            tasks.parallelLimit(project, value).then(setLimit, (error) => { element.value = String(limit); setError(String(error)); });
          }} /></label>}
        <button className="co-btn" disabled={busy} onClick={() => { setError(null); setEdit({ ...EMPTY }); }}>nueva tarea</button>
      </div>
      <div className="task-body">
        <nav className="task-list" aria-label="Lista de tareas">
          {visible.length === 0 && <span className="muted">sin tareas</span>}
          {visible.map((item) => (
            <button key={item.id} className="task-row" aria-current={selected === item.id} onClick={() => {
              setSelected(item.id); setEdit(null); setError(null);
            }}>
              <span>{item.parentId != null ? '↳ ' : ''}{item.title}</span>
              <small className="muted">{item.waitingFor.length ? 'bloqueada por dependencia' : STATUS[item.status]} · {PRIORITY[item.priority as keyof typeof PRIORITY]}</small>
            </button>
          ))}
        </nav>
        <div className="task-detail">
          {error && <div className="co-error" role="alert">{error}</div>}
          {edit ? (
            <form className="task-form" onSubmit={save}>
              <label>Título<input value={edit.title} required onChange={(e) => field('title', e.target.value)} /></label>
              <label>Objetivo<textarea value={edit.goal} required onChange={(e) => field('goal', e.target.value)} /></label>
              <label>Criterios de aceptación<textarea value={edit.criteria} required onChange={(e) => field('criteria', e.target.value)} /></label>
              <div className="task-options">
                <label>Prioridad<select value={edit.priority} onChange={(e) => field('priority', e.target.value)}>
                  {Object.entries(PRIORITY).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select></label>
                <label>Riesgo<select value={edit.risk} onChange={(e) => field('risk', e.target.value)}>
                  {Object.entries(RISK).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select></label>
                <label>Estado<select value={edit.status} onChange={(e) => field('status', e.target.value)}>
                  {[...new Set([edit.status, ...MANUAL])].map((status) => <option key={status} value={status}>{STATUS[status]}</option>)}
                </select></label>
                {list.some((item) => item.id !== edit.id) && <label>Tarea padre<select value={edit.parentId ?? ''} onChange={(e) => field('parentId', e.target.value ? Number(e.target.value) : null)}>
                  <option value="">ninguna</option>
                  {list.filter((item) => item.id !== edit.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select></label>}
              </div>
              {list.some((item) => item.id !== edit.id) && (
                <fieldset className="task-deps"><legend>Depende de</legend>
                  {list.filter((item) => item.id !== edit.id).map((item) => (
                    <label key={item.id}><input type="checkbox" checked={edit.dependencies.includes(item.id)} onChange={(e) =>
                      field('dependencies', e.target.checked ? [...edit.dependencies, item.id] : edit.dependencies.filter((id) => id !== item.id))
                    } /> {item.title}</label>
                  ))}
                </fieldset>
              )}
              {edit.id != null && <>
                <label>Pruebas<select value={edit.tests ?? ''} onChange={(e) => field('tests', e.target.value || null)}>
                  <option value="">desconocido</option>
                  {Object.entries(TESTS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select></label>
                <label>Evidencia de pruebas, integración o aceptación
                  <textarea value={edit.verification} onChange={(e) => field('verification', e.target.value)} />
                </label>
              </>}
              <div className="task-actions">
                <button className="co-btn is-primary" disabled={busy}>guardar</button>
                <button className="co-btn" type="button" disabled={busy} onClick={() => setEdit(null)}>cancelar</button>
              </div>
            </form>
          ) : task && (
            <>
              <div className="task-title"><h2>{task.title}</h2><button className="co-btn" onClick={() => setEdit(task)}>editar</button></div>
              <p className="task-text">{task.goal}</p>
              <dl className="task-facts">
                <dt>Criterios</dt><dd className="task-text">{task.criteria}</dd>
                {task.parentId != null && <><dt>Tarea padre</dt><dd>{label(task.parentId)}</dd></>}
                {task.dependencies.length > 0 && <><dt>Dependencias</dt><dd>{task.dependencies.map(label).join(', ')}</dd></>}
                {task.waitingFor.length > 0 && <><dt>Espera a</dt><dd>{task.waitingFor.map(label).join(', ')}</dd></>}
                <dt>Pruebas</dt><dd>{task.tests ? TESTS[task.tests as keyof typeof TESTS] : 'desconocido'}</dd>
                {task.verification && <><dt>Evidencia</dt><dd className="task-text">{task.verification}</dd></>}
              </dl>
              <div className="task-actions">
                <button className="co-btn" disabled={blocked} onClick={() => onAuto(task)}>hablar con el PM</button>
                <button className="co-btn" disabled={blocked} onClick={() => onDirect('codex', task.id)}>nuevo chat Codex</button>
                <button className="co-btn" disabled={blocked} onClick={() => onDirect('claude', task.id)}>nuevo chat Claude</button>
                <select className="chip-select" aria-label="Vincular sesión activa" value="" disabled={!available.length || busy} onChange={(e) => {
                  const id = Number(e.target.value);
                  if (id) void action(() => tasks.link(project, task.id, id));
                }}>
                  <option value="">vincular sesión…</option>
                  {available.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.engine}</option>)}
                </select>
              </div>
              {task.sessions.length > 0 && (
                <ul className="task-sessions" aria-label="Sesiones vinculadas">
                  {task.sessions.map((s) => <li key={s.id}>
                    <button className="co-link" disabled={s.closed || !sessions.some((active) => active.id === s.id)} onClick={() => onSession(s.id)}>{s.name}</button>
                    <span className="muted" title={s.worktree ?? undefined}> {s.engine}{s.branch ? ` · ${s.branch}` : ''}{s.closed ? ' · cerrada' : ''}</span>
                    {s.branch && !s.closed && sessions.some((active) => active.id === s.id) && <button className="co-link"
                      onClick={() => { const active = sessions.find((item) => item.id === s.id); if (active) onPublish(active); }}> GitHub</button>}
                    {s.github?.commits.length ? <details><summary>{s.github.commits.length} commits Larry</summary><ul>
                      {s.github.commits.map((commit) => <li key={commit.oid} title={commit.oid}>{commit.oid.slice(0, 12)} {commit.subject}</li>)}
                    </ul></details> : null}
                    {s.github?.pulls.map((pull) => <div key={pull.url}>
                      <button className="co-link" onClick={() => pr.open(pull.url).catch((e) => setError(String(e)))}>PR #{pull.number}</button>
                      <span className="muted"> · {pull.state.toLowerCase()} · CI {CHECK_STATE[pull.checksState]} · {new Date(pull.observedAt * 1000).toLocaleString()}</span>
                    </div>)}
                  </li>)}
                </ul>
              )}
              {runs.length > 0 && <section className="task-runs" aria-label="Métricas observadas">
                <h3>Últimos turnos</h3>
                {runs.map((run) => <ObservedRun key={run.id} run={run} />)}
              </section>}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ObservedRun({ run }: { run: TaskRun }) {
  const number = (n: number | null) => n == null ? 'desconocido' : n.toLocaleString();
  const windows = [run.quotaShort, run.quotaLong].flatMap((window) => window ? [`${window[0].toLocaleString()} % / ${window[1]} min`] : []);
  const start = new Date(run.startedMs).toLocaleString();
  return (
    <details>
      <summary>Turno #{run.id} · {run.sessionId == null ? 'PM · ' : ''}{run.provider} · {run.model ?? 'modelo desconocido'} · {OUTCOME[run.outcome]}{run.retry ? ' · reintento' : ''} · {start}</summary>
      <dl className="task-facts">
        <dt>Duración</dt><dd>{run.durationMs == null ? 'en curso' : `${(run.durationMs / 1000).toLocaleString()} s`}</dd>
        <dt>Tokens API entrada / caché / salida</dt><dd>{number(run.inputTokens)} / {number(run.cachedInputTokens)} / {number(run.outputTokens)}</dd>
        {run.contextTokens != null && <><dt>Ocupación de contexto</dt><dd>{number(run.contextTokens)} tokens</dd></>}
        <dt>Coste estimado por el proveedor</dt><dd>{run.costEstimateUsd == null ? 'desconocido' : `${run.costEstimateUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })} USD`}</dd>
        <dt>Cuota de cuenta usada</dt><dd>{windows.join(' · ') || 'desconocido'}</dd>
      </dl>
      {!!run.memory?.length && <ul aria-label="Referencias de Brain preparadas">
        {run.memory.map((entry) => <li key={entry.id}>Brain #{entry.id} · revisión {entry.version} · {entry.source}</li>)}
      </ul>}
      {run.routing && <ObservedRouting route={run.routing} />}
    </details>
  );
}

function ObservedRouting({ route }: { route: NonNullable<TaskRun['routing']> }) {
  const effort = (value: string | null) => value == null ? 'predeterminado del modelo' : EFFORT_LABEL[value] ?? value;
  const number = (value: number | null) => value?.toLocaleString() ?? 'desconocido';
  return (
    <dl className="task-facts">
      <dt>Enrutamiento</dt>
      <dd>{route.source === 'jev' ? 'Jev' : route.source === 'shadow' ? 'Local con observación Jev' : 'Local'} · esfuerzo {effort(route.effort)}
        {route.reason ? ` · ${ROUTE_REASON[route.reason] ?? route.reason}` : ''}</dd>
      {route.executionModel && <><dt>Modelo Codex seleccionado</dt><dd>{route.executionModel}</dd></>}
      {route.recommendedEffort && <><dt>Recomendación de Jev</dt>
        <dd>{effort(route.recommendedEffort)} · confianza {route.confidence?.toLocaleString(undefined, { style: 'percent' }) ?? 'desconocida'}</dd></>}
      {route.complexity && <><dt>Complejidad</dt><dd>{ROUTE_ADVICE[route.complexity]}</dd></>}
      {route.review && <><dt>Revisión recomendada</dt><dd>{ROUTE_ADVICE[route.review]}</dd></>}
      {route.context && <><dt>Contexto recomendado</dt><dd>{ROUTE_ADVICE[route.context]}</dd></>}
      {route.eventAdvice && <><dt>Fallo anterior sin causa identificada</dt><dd>{ROUTE_ADVICE[route.eventAdvice]}</dd></>}
      {route.model && <><dt>Modelo Jev</dt><dd>{route.model}</dd>
        <dt>Tokens API Jev entrada / salida</dt><dd>{number(route.inputTokens)} / {number(route.outputTokens)}</dd>
        <dt>Coste estimado Jev</dt><dd>{route.costEstimateUsd == null ? 'desconocido' : `${route.costEstimateUsd.toLocaleString(undefined, { maximumFractionDigits: 8 })} USD`}</dd>
        <dt>Cuota TypeSafe</dt><dd>desconocida</dd></>}
      {route.durationMs != null && <><dt>Duración de la consulta</dt><dd>{number(route.durationMs)} ms</dd></>}
    </dl>
  );
}
