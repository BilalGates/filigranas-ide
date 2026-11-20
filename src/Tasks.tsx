import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { EFFORT_LABEL } from './Conversation';
import { pr, sessions as sessionApi, tasks, type DiffTarget, type Session, type Task, type TaskEdit, type TaskRun } from './ipc';
import Publish, { CHECK_STATE } from './Publish';
import CodeHealth from './CodeHealth';
import Larry from './Larry';
import Pending from './Pending';

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

const SECTIONS = {
  summary: 'Resumen', health: 'Code Health', commits: 'Commits', pulls: 'Pull requests', branches: 'Ramas',
};

export type WorkSection = keyof typeof SECTIONS;
export type WorkTarget = { project: string; section: WorkSection; task?: number; session?: number | null; allPending?: boolean };

type Props = {
  project: string;
  checkout: string;
  hidden: boolean;
  sessions: Session[];
  focus: WorkTarget | null;
  onAuto: (task: Task) => void;
  onDirect: (engine: string, task: number) => void;
  onSession: (id: number) => void;
  onDiff: (change: DiffTarget) => void;
  onFile: (path: string, session: number | null, root: string | null) => void;
  onConflicts: (files: string[]) => void;
  onBranchesChanged: () => void;
  onWorktree: (project: string, id: number | null) => void;
};

type ScopeSession = Pick<Session, 'id' | 'name' | 'engine' | 'worktree' | 'branch'>;
type Scope = {
  key: string;
  owner: number | null;
  live: Session | null;
  orphan: boolean;
  history: ScopeSession[];
};
const CHECKOUT = 'checkout';

function buildScopes(list: Task[], open: Session[], orphans: Session[]) {
  const scopes = new Map<string, Scope>();
  const keys = new Map<number, string>();
  const owner = new Map<number, number>();
  for (const task of list) {
    for (const session of task.sessions) owner.set(session.id, task.id);
  }
  const add = (session: ScopeSession) => {
    const key = session.worktree ?? `session:${session.id}`;
    const scope = scopes.get(key) ?? { key, owner: null, live: null, orphan: false, history: [] };
    if (!keys.has(session.id)) scope.history.push(session);
    keys.set(session.id, key);
    scopes.set(key, scope);
    return scope;
  };
  for (const task of list) {
    for (const session of task.sessions) add(session);
  }
  for (const session of [...orphans, ...open]) {
    const scope = add(session);
    scope.live = session;
  }
  const orphanIds = new Set(orphans.map((session) => session.id));
  for (const scope of scopes.values()) {
    scope.history.sort((a, b) => b.id - a.id);
    scope.owner = owner.get(scope.live?.id ?? scope.history[0].id)
      ?? scope.history.flatMap((session) => owner.get(session.id) ?? [])[0] ?? null;
    scope.orphan = !!scope.live && orphanIds.has(scope.live.id);
  }
  return { scopes: [...scopes.values()], keys };
}

export default function Tasks({
  project, checkout, hidden, sessions, focus, onAuto, onDirect, onSession, onDiff, onFile, onConflicts,
  onBranchesChanged, onWorktree,
}: Props) {
  const [list, setList] = useState<Task[] | null>(null);
  const [orphans, setOrphans] = useState<Session[] | null>(null);
  const [selected, setSelected] = useState<number | null>();
  const [section, setSection] = useState<WorkSection>('summary');
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const [allPending, setAllPending] = useState(false);
  const [healthTarget, setHealthTarget] = useState<number | null>(null);
  const [appliedFocus, setAppliedFocus] = useState<WorkTarget | null>(null);
  const [edit, setEdit] = useState<TaskEdit | null>(null);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [history, setHistory] = useState<{ task: number | null; runs: TaskRun[] }>({ task: null, runs: [] });
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState<number | null>(null);
  const listRequest = useRef(0);
  const branchRequest = useRef(0);
  const items = list ?? [];
  const taskId = selected === undefined ? items[0]?.id ?? null : selected;
  const task = items.find((item) => item.id === taskId);
  const runs = history.task === taskId ? history.runs : [];
  const topology = useMemo(
    () => buildScopes(list ?? [], sessions.filter((session) => session.project === project), orphans ?? []),
    [list, sessions, project, orphans],
  );
  const scopes = topology.scopes.filter((scope) => scope.owner === taskId);
  const chosenKey = scopeKey ?? (taskId == null ? CHECKOUT : scopes.length === 1 ? scopes[0].key : null);
  const scope = scopes.find((candidate) => candidate.key === chosenKey);
  const evidence = scope?.history.find((session) => session.id === healthTarget) ?? scope?.live ?? scope?.history[0];
  const evidenceClosed = !!evidence && (!scope?.live || scope.orphan || scope.live.id !== evidence.id);
  const isCheckout = taskId == null && chosenKey === CHECKOUT;
  const pending = (allPending ? topology.scopes : scopes).filter((candidate) => candidate.orphan);
  const targetReady = focus == null || focus === appliedFocus;

  const chooseScope = (key: string | null, evidence?: number) => {
    setScopeKey(key);
    setHealthTarget(evidence ?? null);
  };

  useEffect(() => {
    if (!focus || hidden || focus === appliedFocus || list == null) return;
    if (focus.session != null && orphans == null && !topology.keys.has(focus.session)) return;
    if (focus.task !== undefined) {
      setSelected(focus.task);
      chooseScope(null);
    } else if (focus.session !== undefined) {
      const key = focus.session == null ? CHECKOUT : topology.keys.get(focus.session);
      const match = topology.scopes.find((candidate) => candidate.key === key);
      if (focus.session != null && !match) {
        setError('La sesión solicitada ya no está disponible en este proyecto.');
        setSelected(null);
        chooseScope(CHECKOUT);
        setSection('summary');
        setEdit(null);
        setAppliedFocus(focus);
        return;
      }
      setSelected(match?.owner ?? null);
      chooseScope(key ?? null, focus.session ?? undefined);
    }
    setAppliedFocus(focus);
    setSection(focus.section);
    setAllPending(!!focus.allPending);
    setFilter('');
    setSearch('');
    setEdit(null);
    setError(null);
  }, [focus, appliedFocus, hidden, list, orphans, topology]);

  const liveWorktree = targetReady && scope?.live?.worktree ? scope.live.id : null;
  useEffect(() => {
    onWorktree(project, liveWorktree);
  }, [project, liveWorktree, onWorktree]);

  const refresh = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const next = await tasks.list(project);
      if (request !== listRequest.current) return;
      setList(next);
      setLoadError(null);
    } catch (e) {
      if (request === listRequest.current) setLoadError(String(e));
    }
  }, [project]);

  const refreshBranches = useCallback(async () => {
    const request = ++branchRequest.current;
    try {
      const next = await sessionApi.orphans(project);
      if (request === branchRequest.current) setOrphans(next);
    } catch (e) {
      if (request === branchRequest.current) setError(String(e));
    }
  }, [project]);

  useEffect(() => {
    if (hidden) return;
    void refresh();
    let timer: number | undefined;
    const unlisten = listen('tasks-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 100);
    });
    return () => {
      window.clearTimeout(timer);
      void unlisten.then((off) => off());
    };
  }, [hidden, refresh]);

  useEffect(() => {
    if (!hidden) void refreshBranches();
  }, [sessions, hidden, refreshBranches]);

  useEffect(() => {
    if (hidden) return;
    const unlisten = listen<{ project: string }>('sessions-changed', ({ payload }) => {
      if (payload.project === project) void refresh();
    });
    return () => { void unlisten.then((off) => off()); };
  }, [hidden, project, refresh]);

  useEffect(() => {
    if (hidden || taskId == null) return;
    let active = true;
    const load = () => tasks.runs(project, taskId).then(
      (runs) => { if (active) setHistory({ task: taskId, runs }); },
      (e) => { if (active) setError(String(e)); },
    );
    void load();
    let timer: number | undefined;
    const unlisten = listen('tasks-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 100);
    });
    return () => {
      active = false;
      window.clearTimeout(timer);
      void unlisten.then((off) => off());
    };
  }, [project, taskId, hidden]);

  useEffect(() => {
    if (!hidden) tasks.parallelLimit(project).then(setLimit, (e) => setError(String(e)));
  }, [hidden, project]);

  const branchChanged = () => {
    void refreshBranches();
    void refresh();
    onBranchesChanged();
  };

  const selectTask = (id: number | null) => {
    setSelected(id);
    setSection('summary');
    setAllPending(false);
    chooseScope(null);
    setEdit(null);
    setError(null);
  };

  const showScope = (session: ScopeSession, next: WorkSection) => {
    chooseScope(topology.keys.get(session.id) ?? null, session.id);
    setSection(next);
  };

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
      selectTask(id);
    });
  };

  const field = <K extends keyof TaskEdit>(key: K, value: TaskEdit[K]) => setEdit((draft) => draft && { ...draft, [key]: value });
  const label = (id: number) => items.find((item) => item.id === id)?.title ?? `#${id}`;
  const available = sessions.filter((s) => !task?.sessions.some((link) => link.id === s.id));
  const blocked = !!task && (task.waitingFor.length > 0 || ['backlog', 'blocked', 'done', 'cancelled'].includes(task.status));
  const query = search.trim().toLocaleLowerCase();
  const visible = items.filter((item) =>
    (!filter || item.status === filter) && (!query || `#${item.id} ${item.title} ${item.goal}`.toLocaleLowerCase().includes(query)),
  ).sort(
    (a, b) => Object.keys(PRIORITY).indexOf(a.priority) - Object.keys(PRIORITY).indexOf(b.priority) || b.id - a.id,
  );

  return (
    <section className="coach tasks" aria-label="Trabajo del proyecto" hidden={hidden}>
      <div className="task-body">
        <nav className="task-list" aria-label="Lista de tareas">
          <div className="work-list-tools">
            <button className="co-btn is-primary" disabled={busy} onClick={() => { setError(null); setEdit({ ...EMPTY }); }}>Nueva tarea</button>
            <input type="search" aria-label="Buscar tareas" placeholder="Buscar tareas" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="chip-select" aria-label="Filtrar tareas por estado" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">Todos los estados</option>
              {Object.entries(STATUS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
          <div className="work-task-rows">
            <button className="task-row work-unassigned" disabled={busy} aria-current={taskId == null} onClick={() => selectTask(null)}>
              <span>Sin tarea</span>
              <small className="muted">Checkout y ramas del proyecto</small>
            </button>
            {list == null && !loadError && <p className="muted">Cargando tareas…</p>}
            {list != null && visible.length === 0 && <p className="muted">{query || filter ? 'Sin coincidencias' : 'Aún no hay tareas'}</p>}
            {visible.map((item) => (
              <button key={item.id} className="task-row" disabled={busy} aria-current={taskId === item.id} onClick={() => selectTask(item.id)}>
                <small className="muted">#{item.id} · {item.waitingFor.length ? 'bloqueada por dependencia' : STATUS[item.status]}</small>
                <span>{item.parentId != null ? '↳ ' : ''}{item.title}</span>
              </button>
            ))}
          </div>
          {limit != null && <label className="task-limit-control">Límite simultáneo <input className="task-limit" aria-label="Máximo de tareas simultáneas"
            key={limit} type="number" min={1} step={1} defaultValue={limit} onBlur={(e) => {
              const value = e.target.valueAsNumber;
              if (value === limit) return;
              if (!e.target.validity.valid || !Number.isInteger(value)) { e.target.value = String(limit); return; }
              const element = e.target;
              tasks.parallelLimit(project, value).then(setLimit, (error) => { element.value = String(limit); setError(String(error)); });
            }} /></label>}
        </nav>
        <div className="task-detail">
          {(error || loadError) && <div className="co-error" role="alert">{error || loadError}</div>}
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
                {items.some((item) => item.id !== edit.id) && <label>Tarea padre<select value={edit.parentId ?? ''} onChange={(e) => field('parentId', e.target.value ? Number(e.target.value) : null)}>
                  <option value="">ninguna</option>
                  {items.filter((item) => item.id !== edit.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select></label>}
              </div>
              {items.some((item) => item.id !== edit.id) && (
                <fieldset className="task-deps"><legend>Depende de</legend>
                  {items.filter((item) => item.id !== edit.id).map((item) => (
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
          ) : !targetReady || list == null ? (
            <div className="work-empty muted">{loadError || error ? <button className="co-btn" onClick={() => {
              setError(null);
              void refresh();
              void refreshBranches();
            }}>Reintentar</button> : 'Cargando ficha…'}</div>
          ) : taskId != null && !task ? (
            <p className="work-empty muted">La tarea #{taskId} ya no está disponible en este proyecto.</p>
          ) : (
            <>
              <header className="work-fiche">
                <div className="task-title">
                  <div>
                    {task && <small className="muted">#{task.id} · {STATUS[task.status]} · prioridad {PRIORITY[task.priority as keyof typeof PRIORITY]}</small>}
                    <h2>{task?.title ?? 'Sin tarea'}</h2>
                  </div>
                  {task && <button className="co-btn" onClick={() => setEdit(task)}>Editar</button>}
                </div>
                <nav className="work-sections" aria-label="Secciones de la ficha">
                  {(Object.entries(SECTIONS) as [WorkSection, string][]).map(([key, name]) => (
                    <button key={key} aria-current={section === key ? 'true' : undefined} onClick={() => setSection(key)}>{name}</button>
                  ))}
                </nav>
              </header>
              {section !== 'summary' && (
                <div className="work-operations">
                  <div className="work-scope">
                    <label>Ámbito <select className="chip-select" value={scope ? scope.key : isCheckout ? CHECKOUT : ''} onChange={(e) => chooseScope(e.target.value || null)}>
                      {!scope && !isCheckout && <option value="">{scopes.length ? 'Elige una rama o sesión' : 'Sin sesiones vinculadas'}</option>}
                      {taskId == null && <option value={CHECKOUT}>Checkout del proyecto · {checkout}</option>}
                      {scopes.map((candidate) => {
                        const session = candidate.live ?? candidate.history[0];
                        const label = session.branch ? `${session.branch} · ${session.name}` : session.name;
                        return <option key={candidate.key} value={candidate.key}>{label}{candidate.orphan || !candidate.live ? ' · cerrada' : ''}</option>;
                      })}
                    </select></label>
                    {scope?.live?.base && <span className="muted">Destino {scope.live.base}</span>}
                  </div>
                  {!scope && !isCheckout && <p className="work-empty muted">
                    {scopes.length ? 'Selecciona el ámbito en el que quieres trabajar.' : 'Crea o vincula una sesión desde Resumen.'}
                  </p>}
                  {(scope || isCheckout) && section === 'health' && <>
                      {!!scope && scope.history.length > 1 && <div className="work-scope">
                        <label>Sesión de evidencia <select className="chip-select" value={evidence?.id} onChange={(e) => setHealthTarget(Number(e.target.value))}>
                          {scope.history.map((session) => <option key={session.id} value={session.id}>{session.name} · #{session.id}</option>)}
                        </select></label>
                      </div>}
                      <CodeHealth key={evidence?.id ?? CHECKOUT} project={project} session={evidence ?? null} closed={evidenceClosed} onFile={onFile} />
                  </>}
                  {section === 'commits' && (isCheckout || scope?.live?.worktree ? (
                    <Larry key={chosenKey} project={project} session={scope?.live ?? null} onDiff={onDiff} onDone={() => setSection('summary')} />
                  ) : scope && <p className="work-empty muted">Selecciona una rama con copia de trabajo. Los commits registrados siguen en Resumen.</p>)}
                  {section === 'pulls' && (isCheckout || scope?.live?.worktree ? (
                    <Publish key={scope?.live?.id ?? CHECKOUT} project={project} session={scope?.live?.id ?? null} hidden={hidden} />
                  ) : scope && <p className="work-empty muted">Las PR observadas de esta sesión están en Resumen. Para preparar una PR hace falta una copia de trabajo.</p>)}
                  {section === 'branches' && (scope?.live?.worktree ? (
                    <Pending key={scope.live.id} session={scope.live} closed={scope.orphan} onDiff={onDiff} onChanged={branchChanged} onConflicts={onConflicts} />
                  ) : isCheckout ? (
                    <div className="work-branch-list">
                      <h3>Ramas de sesiones cerradas</h3>
                      {orphans == null && <button className="co-btn" onClick={() => void refreshBranches()}>Consultar ramas</button>}
                      {orphans && !pending.length && <p className="muted">No hay ramas de sesiones cerradas{allPending ? '' : ' sin tarea'}.</p>}
                      {pending.map((candidate) => (
                        <button key={candidate.key} className="task-row" onClick={() => {
                          setSelected(candidate.owner);
                          setAllPending(false);
                          chooseScope(candidate.key);
                        }}>
                          <span>{candidate.live?.branch} → {candidate.live?.base}</span>
                          <small className="muted">{candidate.owner == null ? 'Sin tarea' : label(candidate.owner)} · {candidate.live?.name}</small>
                        </button>
                      ))}
                    </div>
                  ) : scope && <p className="work-empty muted">Esta sesión no tiene una copia de trabajo disponible.</p>)}
                </div>
              )}
              {section === 'summary' && (task ? <div className="work-summary">
              <p className="task-text">{task.goal}</p>
              <dl className="task-facts">
                <dt>Criterios</dt><dd className="task-text">{task.criteria}</dd>
                {task.parentId != null && <><dt>Tarea padre</dt><dd><button className="co-link" onClick={() => selectTask(task.parentId)}>{label(task.parentId)}</button></dd></>}
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
                    <span className="muted"> {s.engine}{s.closed ? ' · cerrada' : ''}</span>
                    <button className="co-link" onClick={() => showScope(s, 'health')}>Code Health</button>
                  </li>)}
                </ul>
              )}
              {scopes.some((candidate) => candidate.history[0].branch) && (
                <section className="work-linked-branches" aria-label="Ramas vinculadas">
                  <h3>Ramas</h3>
                  {scopes.map((candidate) => {
                    const session = candidate.live ?? candidate.history[0];
                    if (!session.branch) return null;
                    const github = task.sessions.find((link) => link.branch === session.branch)?.github;
                    return <div key={candidate.key} className="work-branch">
                      <div className="task-actions">
                        <button className="co-link" onClick={() => showScope(session, 'branches')}>{session.branch}</button>
                        {candidate.live?.base && <span className="muted">→ {candidate.live.base}</span>}
                        {candidate.live?.worktree && <>
                          <button className="co-link" onClick={() => showScope(session, 'commits')}>Larry</button>
                          <button className="co-link" onClick={() => showScope(session, 'pulls')}>Gestionar PR</button>
                        </>}
                      </div>
                      {!!github?.commits.length && <details><summary>{github.commits.length} commits de Larry</summary><ul>
                        {github.commits.map((commit) => <li key={commit.oid} title={commit.oid}>{commit.oid.slice(0, 12)} {commit.subject}</li>)}
                      </ul></details>}
                      {github?.pulls.map((pull) => <div key={pull.url}>
                        <button className="co-link" onClick={() => pr.open(pull.url).catch((e) => setError(String(e)))}>PR #{pull.number}</button>
                        <span className="muted"> · {pull.state.toLowerCase()}{pull.isDraft ? ' · borrador' : ''} · CI {CHECK_STATE[pull.checksState]} · {new Date(pull.observedAt * 1000).toLocaleString()}</span>
                      </div>)}
                    </div>;
                  })}
                </section>
              )}
              {runs.length > 0 && <section className="task-runs" aria-label="Métricas observadas">
                <h3>Últimos turnos</h3>
                {runs.map((run) => <ObservedRun key={run.id} run={run} />)}
              </section>}
              </div> : <div className="work-summary">
                <p>Checkout del proyecto · <strong>{checkout}</strong></p>
                <div className="work-branch-list">
                  {scopes.map((candidate) => {
                    const session = candidate.live ?? candidate.history[0];
                    return <button key={candidate.key} className="task-row" onClick={() => showScope(session, session.worktree ? 'branches' : 'health')}>
                      <span>{session.branch ?? session.name}</span>
                      {session.branch && <small className="muted">{session.name}{candidate.orphan ? ' · cerrada' : ''}</small>}
                    </button>;
                  })}
                </div>
              </div>)}
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
