import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tasks as taskApi, type Session, type Task, type TaskRun } from '../ipc';
import { PRIORITY as PRIO, STATUS } from './taskMeta';
import TaskForm from './TaskForm';
import { useUi } from '../ui';
import { useProviderQuota } from '../usageStore';
import { createGraph, escapeXml, type GEdge, type GNode, type GraphHandle } from './graph';
import { ICON_PATHS, Icon } from './icons';
import { AgDot, EmptyArt, Root, StDot, sessionAgents, STATE_LABEL, type AgState, type Agent } from './kit';
import { Modal } from './ui';

// Flow de Trama v2: carriles por agente, grafo de dependencias y lista, con
// inspector y línea de decisiones de Jev. Lee tareas, ejecuciones y actividad
// reales. El modo demostración usa datos en memoria, marcados y separados.
const PRIORITY = PRIO as Record<string, string>;
type Lens = 'exec' | 'deps' | 'list';
type FStatus = 'done' | 'running' | 'waiting' | 'blocked' | 'backlog';
type FTask = { id: string; num: number | null; title: string; status: FStatus; label: string; agent: string; deps: string[]; lvl: number; prio: string; model: string | null; real: Task | null; goal: string };
type FRun = { task: string; at: number; provider: string; model: string | null; outcome: string; reason: string | null; complexity: string | null; confidence: number | null; effort: string | null; source: 'local' | 'shadow' | 'jev' | null; tokens: number | null; duration: number | null };
const ROUTING_SOURCE = { jev: 'Jev', shadow: 'Jev en modo sombra', local: 'reglas locales' };
type FModel = { agents: Agent[]; tasks: FTask[]; runs: FRun[]; demo: boolean };
const LANE_H = 58, COL_W = 186, NODE_W = 170, NODE_H = 50;
const FS: Record<string, FStatus> = { running: 'running', verifying: 'running', waiting_approval: 'waiting', blocked: 'blocked', failed: 'blocked', paused_quota: 'blocked', done: 'done', cancelled: 'done' };
const LAB: Record<FStatus, [string, string]> = { running: ['en marcha', 'en marcha'], waiting: ['espera permiso', 'esperan permiso'], blocked: ['bloqueada', 'bloqueadas'], done: ['completada', 'completadas'], backlog: ['pendiente', 'pendientes'] };
const ST2AG: Record<FStatus, AgState> = { done: 'done', running: 'working', waiting: 'waiting', blocked: 'blocked', backlog: 'idle' };
const NONE: Agent = { id: 'none', session: null, name: 'Sin asignar', engine: '—', h: '#8d939c', state: 'idle', did: 'Tareas sin sesión abierta', branch: null };

function levels(list: { id: string; deps: string[] }[]) {
  const by = new Map(list.map((t) => [t.id, t])), memo = new Map<string, number>();
  const d = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = (by.get(id)?.deps ?? []).filter((x) => by.has(x));
    const v = deps.length ? Math.max(...deps.map((x) => d(x, seen) + 1)) : 0;
    memo.set(id, v);
    return v;
  };
  list.forEach((t) => d(t.id, new Set()));
  return memo;
}

function realModel(tasks: Task[], runs: Record<number, TaskRun[]>, agents: Agent[]): FModel {
  const lanes = new Map(agents.filter((a) => a.session != null).map((a) => [a.session!, a.id]));
  const base = tasks.map((t) => {
    const s = t.sessions.find((x) => !x.closed && lanes.has(x.id));
    const r = runs[t.id]?.[0];
    return { id: String(t.id), num: t.id, title: t.title, status: FS[t.status] ?? 'backlog', label: STATUS[t.status] ?? t.status, agent: s ? lanes.get(s.id)! : 'none', deps: t.dependencies.map(String), lvl: 0, prio: PRIORITY[t.priority] ?? t.priority, model: r?.routing?.model ?? r?.model ?? null, real: t, goal: t.goal };
  });
  const lv = levels(base);
  base.forEach((t) => (t.lvl = lv.get(t.id) ?? 0));
  const flat: FRun[] = Object.entries(runs).flatMap(([id, list]) => list.map((r) => ({
    task: id, at: r.startedMs, provider: r.provider, model: r.routing?.model ?? r.model, outcome: r.outcome, reason: r.routing?.reason ?? null, complexity: r.routing?.complexity ?? null,
    confidence: r.routing?.confidence ?? null, effort: r.routing?.effort ?? null, source: r.routing?.source ?? null, tokens: r.inputTokens, duration: r.durationMs,
  })));
  const used = new Set(base.map((t) => t.agent));
  const lanesShown = agents.filter((a) => a.id === 'pm' || used.has(a.id) || a.state !== 'idle');
  return { agents: used.has('none') ? [...lanesShown, NONE] : lanesShown, tasks: base, runs: flat, demo: false };
}

// Demostración: el equipo del Artifact, solo en memoria.
function demoModel(): FModel {
  const A = (id: string, name: string, h: string, state: AgState, did: string): Agent => ({ id, session: null, name, engine: name.split(' · ')[1] ?? '', h, state, did, branch: null });
  const agents = [A('pm', 'Project manager', '#7aa2ff', 'thinking', 'Coordinando · 4 sesiones'), A('res', 'Investigador · Haiku', '#7fd6ff', 'done', 'Terminó: API de git en Rust'), A('sen', 'Senior · Sonnet', '#b09cff', 'working', 'Editando git_ops.rs'), A('cod', 'Programador · Codex', '#8fc4ff', 'waiting', 'Pide editar src/ipc.ts'), A('jun', 'Junior · Haiku', '#7fe3c4', 'working', 'Escribiendo tests de fetch()'), A('aud', 'Auditor · Opus', '#ffc27a', 'idle', 'En espera de t2 y t4')];
  const T = (id: string, title: string, agent: string, status: FStatus, deps: string[], model: string): FTask => ({ id, num: null, title, status, label: LAB[status][0], agent, deps, lvl: 0, prio: 'normal', model, real: null, goal: '' });
  const tasks = [T('t1', 'Investigar comandos git y errores de red', 'res', 'done', [], 'Haiku'), T('t2', 'fetch, pull, push y stash en git_ops.rs', 'sen', 'running', ['t1'], 'Sonnet'), T('t3', 'Contrato IPC en ipc.ts', 'cod', 'waiting', ['t1'], 'Codex'), T('t4', 'Tests de git_ops', 'jun', 'running', ['t2'], 'Haiku'), T('t5', 'Acciones en el panel de Git', 'sen', 'blocked', ['t2', 't3'], 'Sonnet'), T('t6', 'Commits visibles antes de confirmar', 'pm', 'backlog', ['t5'], 'Codex'), T('t7', 'Auditoría de seguridad de los comandos', 'aud', 'backlog', ['t2', 't4'], 'Opus'), T('t8', 'Publicar PR hacia main', 'pm', 'backlog', ['t6', 't7'], 'Codex')];
  const lv = levels(tasks);
  tasks.forEach((t) => (t.lvl = lv.get(t.id) ?? 0));
  const today = new Date(); today.setHours(20, 0, 0, 0);
  const R = (task: string, min: number, model: string, reason: string, complexity: string, confidence: number): FRun => ({ task, at: today.getTime() + min * 60000, provider: model === 'Codex' ? 'codex' : 'claude', model, outcome: 'ok', reason, complexity, confidence, effort: null, source: 'shadow', tokens: null, duration: null });
  const runs = [R('t1', 2, 'Haiku', 'Lectura de documentación sin escritura.', 'sencilla', 0.86), R('t2', 9, 'Sonnet', 'Cambia comandos con efectos en el repositorio y manejo de errores de red.', 'compleja', 0.74), R('t3', 9, 'Codex', 'Reutilizar el contexto del hilo del PM.', 'habitual', 0.81), R('t4', 18, 'Haiku', 'Tests con un patrón que ya existe en el módulo.', 'sencilla', 0.69)];
  return { agents, tasks, runs, demo: true };
}

export default function Flow({ project, projectName, agentSessions, pm, focusTask, onOpenSession, onAuto, onDirect, onStartPm }: {
  project: string | null;
  projectName: string | null;
  agentSessions: Session[];
  pm: { engine: string } | null;
  onOpenSession: (id: number | 'coach') => void;
  /** Tarea que hay que seleccionar al abrir Flow (desde Inicio o la paleta). */
  focusTask?: number | null;
  onAuto: (task: Task) => void;
  onDirect: (engine: string, task: number) => void;
  onStartPm: () => void;
}) {
  const { activity } = useUi();
  const [lens, setLensState] = useState<Lens>(() => { try { const v = localStorage.getItem('filigranas.flow.lente'); return v === 'deps' || v === 'list' ? v : 'exec'; } catch { return 'exec'; } });
  const setLens = (l: Lens) => { setLensState(l); try { localStorage.setItem('filigranas.flow.lente', l); } catch { /* */ } };
  const [list, setList] = useState<Task[] | null>(null);
  const [runs, setRuns] = useState<Record<number, TaskRun[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<FStatus | null>(null);
  const [demo, setDemo] = useState(false);
  const [help, setHelp] = useState(false);
  const [inspOpen, setInspOpen] = useState(false);
  const request = useRef(0);
  // Editor de tareas: null cerrado, 0 nueva, n la tarea n.
  const [editing, setEditing] = useState<number | null>(null);
  const [limit, setLimit] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!project) return;
    const id = ++request.current;
    try {
      const t = await taskApi.list(project);
      if (id !== request.current) return;
      setList(t); setError(null);
      const want = t.filter((x) => x.sessions.length || FS[x.status]).slice(0, 30);
      const got = await Promise.allSettled(want.map((x) => taskApi.runs(project, x.id)));
      if (id !== request.current) return;
      const next: Record<number, TaskRun[]> = {};
      got.forEach((r, i) => { if (r.status === 'fulfilled' && r.value.length) next[want[i].id] = r.value; });
      setRuns(next);
    } catch (e) { if (id === request.current) setError(String(e)); }
  }, [project]);
  useEffect(() => {
    if (!project) return;
    void load();
    const timer = window.setInterval(load, 8000);
    return () => { request.current++; window.clearInterval(timer); };
  }, [project, load]);

  useEffect(() => {
    setLimit(null);
    if (project) taskApi.parallelLimit(project).then(setLimit, (e) => setError(String(e)));
  }, [project]);
  useEffect(() => {
    if (focusTask == null || !list) return;
    if (list.some((t) => t.id === focusTask)) { setSel(String(focusTask)); setInspOpen(true); }
  }, [focusTask, list]);
  const onEditTask = (id: number) => setEditing(id);
  const link = (task: number, session: number) => {
    if (!project) return;
    taskApi.link(project, task, session).then(() => load(), (e) => setError(String(e)));
  };

  const agents = useMemo(() => sessionAgents(agentSessions.filter((session) => session.project === project), activity, pm), [agentSessions, activity, pm, project]);
  const model = useMemo<FModel | null>(() => demo ? demoModel() : list ? realModel(list, runs, agents) : null, [demo, list, runs, agents]);
  const c = useMemo(() => { const k: Record<FStatus, number> = { done: 0, running: 0, waiting: 0, blocked: 0, backlog: 0 }; model?.tasks.forEach((t) => k[t.status]++); return k; }, [model]);
  const pick = (id: string | null) => { setSel(id); if (id) setInspOpen(true); };

  if (!project) return <Root label="Flow"><div className="flow-empty"><div className="empty big"><EmptyArt /><h3>Elige un proyecto</h3><p>Flow supervisa las tareas y agentes del proyecto abierto.</p></div></div></Root>;
  const empty = model && !model.demo && model.tasks.length === 0;
  const title = model?.demo ? 'Demostración · git local' : projectName ?? '';
  return (
    <Root label="Flow">
      <div className={`flow${inspOpen ? ' insp-open' : ''}`}>
        <div className="flowh">
          <h2 className="vt">{title}</h2>
          {model?.demo && <span className="simtag">demostración · no son datos tuyos</span>}
          {model && model.tasks.length > 0 && (
            <div className="ovw" role="group" aria-label="Estado de la ejecución">
              <div className="ovbar" aria-hidden="true">{model.tasks.slice(0, 40).map((t) => <i key={t.id} className={`s-${t.status}`} style={t.status === 'running' ? { background: model.agents.find((a) => a.id === t.agent)?.h } : undefined} />)}</div>
              {(['running', 'waiting', 'blocked', 'done', 'backlog'] as FStatus[]).map((s) => c[s] ? (
                <button key={s} className={`ovc s-${s}${filter === s ? ' on' : ''}`} aria-pressed={filter === s} onClick={() => setFilter(filter === s ? null : s)}>
                  <StDot st={ST2AG[s]} h="#b09cff" s={11} /><b>{c[s]}</b> {c[s] === 1 ? LAB[s][0] : LAB[s][1]}
                </button>
              ) : null)}
            </div>
          )}
          <span className="grow" />
          <div className="seg" role="group" aria-label="Vista">
            {([['exec', 'lanes', 'Ejecución'], ['deps', 'graph', 'Dependencias'], ['list', 'list', 'Lista']] as [Lens, string, string][]).map(([id, ic, l]) => (
              <button key={id} className={lens === id ? 'on' : ''} aria-pressed={lens === id} aria-label={l} onClick={() => setLens(id)}><Icon name={ic} size={14} /><span className="hide-s">{l}</span></button>
            ))}
          </div>
          {!demo && limit != null && <label className="flow-limit" title="Tareas que pueden ejecutarse a la vez en este proyecto">
            Simultáneas <input className="in" type="number" min={1} step={1} key={limit} defaultValue={limit} aria-label="Máximo de tareas simultáneas" onBlur={(e) => {
              const value = e.target.valueAsNumber;
              if (value === limit) return;
              const element = e.target;
              if (!element.validity.valid || !Number.isInteger(value)) { element.value = String(limit); return; }
              taskApi.parallelLimit(project, value).then(setLimit, (err) => { element.value = String(limit); setError(String(err)); });
            }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </label>}
          {demo ? <button className="btn sm" onClick={() => { setDemo(false); setSel(null); setFilter(null); }}><Icon name="close" size={12} /> Salir de la demo</button>
            : <button className="btn sm" onClick={() => onEditTask(0)}><Icon name="plus" size={12} /> Tarea</button>}
          <button className="tbtn narrow-only" onClick={() => setInspOpen(!inspOpen)} aria-label="Inspector"><Icon name="panel" size={16} /></button>
        </div>
        <div className="stage" id="stage">
          {error && <div className="flow-err" role="alert"><Icon name="warn" size={14} /> {error} <button className="btn sm" onClick={() => void load()}>Reintentar</button></div>}
          {!model ? (!error && <div className="flow-loading" role="status" aria-label="Cargando tareas"><span className="spin" /></div>)
            : empty ? <FlowStart agents={model.agents} onCreate={() => onEditTask(0)} onPm={onStartPm} onHelp={() => setHelp(true)} onDemo={() => { setDemo(true); setSel('t2'); setFilter(null); }} />
            : lens === 'list' ? <FlowList m={model} sel={sel} filter={filter} onSel={pick} />
            : <FlowGraph m={model} lens={lens} sel={sel} filter={filter} onSel={pick} onOpen={(id) => { const t = model.tasks.find((x) => x.id === id); if (t?.num) onEditTask(t.num); }} />}
        </div>
        <aside className="insp" id="finsp" aria-label="Inspector">
          {model && <Inspector m={model} sel={sel} onSel={pick} onOpenSession={onOpenSession} onEditTask={onEditTask} onAuto={onAuto} onDirect={onDirect} sessions={agentSessions} onLink={link} />}
        </aside>
        <Route m={model} sel={sel} onSel={pick} />
      </div>
      {help && <FlowHelp onClose={() => setHelp(false)} />}
      {editing != null && <TaskForm key={editing} project={project} all={list ?? []} task={editing ? list?.find((t) => t.id === editing) ?? null : null}
        onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); void load().then(() => { setSel(String(id)); setInspOpen(true); }); }} />}
    </Root>
  );
}

function FlowStart({ agents, onCreate, onPm, onHelp, onDemo }: { agents: Agent[]; onCreate: () => void; onPm: () => void; onHelp: () => void; onDemo: () => void }) {
  return (
    <div className="flow-start">
      <svg className="flow-start-art" viewBox="0 0 640 260" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => <line key={i} x1="0" x2="640" y1={30 + i * 50} y2={30 + i * 50} stroke="rgba(255,255,255,.05)" />)}
        {[[110, 80], [290, 80], [290, 180], [470, 130]].map(([x, y], i) => <rect key={i} x={x - 70} y={y - 20} width="140" height="40" rx="10" fill="rgba(14,16,19,.7)" stroke="rgba(255,255,255,.08)" strokeDasharray="3 4" />)}
        <path d="M180 80 C 220 80 200 80 220 80 M180 80 C 220 80 200 180 220 180 M360 80 C 400 80 380 130 400 130 M360 180 C 400 180 380 130 400 130" fill="none" stroke="rgba(220,226,236,.18)" strokeDasharray="2 5" />
      </svg>
      <div className="flow-start-card pane">
        <h3>Este proyecto aún no tiene tareas</h3>
        <p>Cuando el Project manager reparte el trabajo, cada tarea aparece aquí en el carril de su agente, con sus dependencias, permisos y decisiones de Jev.</p>
        {agents.length > 0 && <div className="row wrap" style={{ gap: 10 }}>{agents.filter((a) => a.id !== 'none').map((a) => <span key={a.id} className="agline"><AgDot a={a} /><b>{a.name}</b><span className="mut2">{STATE_LABEL[a.state]}</span></span>)}</div>}
        <div className="row wrap">
          <button className="btn pearl" onClick={onPm}><Icon name="agent" size={13} /> Pedir al PM que planifique</button>
          <button className="btn" onClick={onCreate}><Icon name="plus" size={13} /> Crear una tarea</button>
          <button className="btn ghost" onClick={onHelp}><Icon name="info" size={13} /> Cómo funciona Flow</button>
        </div>
        <button className="lnk flow-demo" onClick={onDemo}>Ver una demostración con datos de ejemplo <span className="simtag">no se guarda</span></button>
      </div>
    </div>
  );
}

function FlowHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Cómo funciona Flow" onClose={onClose} wide>
      <div className="tr-col" style={{ gap: 10, lineHeight: 1.55 }}>
        <p><b>Ejecución</b> muestra un carril por agente (Project manager y sesiones abiertas). Cada tarea se coloca en el carril de la sesión que la trabaja y en la columna de su nivel de dependencias.</p>
        <p><b>Dependencias</b> ordena las tareas por niveles: las de un mismo nivel pueden ejecutarse en paralelo dentro del límite del proyecto.</p>
        <p><b>Lista</b> resume todas las tareas para filtrarlas y abrirlas. «Tarea» y «Editar» abren el editor aquí mismo; el número de tareas simultáneas se ajusta en la barra superior.</p>
        <p>Las líneas indican dependencia, delegación del PM, ejecución en curso, espera de permiso o bloqueo. Abajo, la línea de Jev registra qué modelo eligió para cada ejecución y por qué. Flow no inventa progreso: solo muestra estados que el núcleo registra.</p>
      </div>
      <div className="acts"><button className="tr-btn pearl" onClick={onClose}>Entendido</button></div>
    </Modal>
  );
}

function nodeSvg(n: GNode, m: FModel) {
  if (n.kind === 'agent') {
    const a = n.a as Agent;
    const c = a.state === 'waiting' ? '#ffb25e' : a.state === 'idle' ? 'rgba(220,226,236,.4)' : a.state === 'done' ? '#6fe0b3' : a.state === 'blocked' ? '#ff6b5d' : a.h;
    const [role, mdl] = a.name.split(' · ');
    return `<rect class="body lane" x="-70" y="-20" width="140" height="40" rx="9"/><circle cx="-56" cy="0" r="9" fill="none" stroke="${c}" stroke-opacity=".4" class="${a.state === 'working' ? 'svgbreath' : a.state === 'waiting' ? 'svgbeat' : a.state === 'thinking' ? 'svgthink' : ''}"/><circle cx="-56" cy="0" r="3.8" fill="${a.state === 'idle' ? 'none' : c}" stroke="${c}" stroke-width="1.3"/><text x="-40" y="-2">${escapeXml((role ?? '').slice(0, 15))}</text><text class="s" x="-40" y="13">${escapeXml(mdl ?? a.engine)}</text>`;
  }
  const t = n.t as FTask, a = m.agents.find((x) => x.id === t.agent) ?? NONE;
  const c = t.status === 'done' ? '#6fe0b3' : t.status === 'waiting' ? '#ffb25e' : t.status === 'running' ? a.h : t.status === 'blocked' ? '#ff6b5d' : 'rgba(220,226,236,.45)';
  const w = n.w, h = n.h, x = -w / 2, y = -h / 2, title = t.title.length > 20 ? `${t.title.slice(0, 19)}…` : t.title;
  const badge = t.status === 'waiting' ? `<g class="badge" transform="translate(${w / 2 - 14},${y + 1})"><rect x="-26" y="-9" width="40" height="18" rx="9" fill="#2a1f10" stroke="#ffb25e" stroke-opacity=".6"/><text x="-6" y="4" text-anchor="middle" class="bt" style="fill:#ffc98a">permiso</text></g>`
    : t.status === 'done' ? `<g transform="translate(${w / 2 - 16},0)" class="okmark"><circle r="8" fill="rgba(111,224,179,.14)"/><path d="M-3.5,0.5L-1,3L3.8,-2.5" fill="none" stroke="#6fe0b3" stroke-width="1.6" stroke-linecap="round"/></g>` : '';
  const sub = `${t.num != null ? `#${t.num}` : t.id}${t.model ? ` · ${t.model}` : a.id !== 'none' ? ` · ${a.engine}` : ''}${t.status === 'blocked' ? ' · espera' : ''}`;
  return `${t.status === 'running' ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${a.h}" fill-opacity=".07"/>` : ''}<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>
<circle cx="${x + 16}" cy="${y + 18}" r="7.5" fill="none" stroke="${c}" stroke-opacity=".35" class="${t.status === 'running' ? 'svgbreath' : t.status === 'waiting' ? 'svgbeat' : ''}"/><circle cx="${x + 16}" cy="${y + 18}" r="3.6" fill="${t.status === 'backlog' || t.status === 'blocked' ? 'none' : c}" stroke="${c}" stroke-width="1.4"/>
<text x="${x + 30}" y="${y + 22}">${escapeXml(title)}</text><text class="s" x="${x + 30}" y="${y + 38}">${escapeXml(sub)}</text>
<line x1="${x + 12}" y1="${y + h - 5}" x2="${x + w - 12}" y2="${y + h - 5}" stroke="rgba(255,255,255,.08)" stroke-width="2" stroke-dasharray="2 3"/>${badge}`;
}

function graphModel(m: FModel, lens: Lens) {
  const nodes: GNode[] = [], edges: GEdge[] = [];
  const byL: Record<number, FTask[]> = {};
  m.tasks.forEach((t) => { (byL[t.lvl] = byL[t.lvl] || []).push(t); });
  // altura de cada carril según cuántas tareas comparten nivel en él
  const stack = new Map<string, number>();
  m.tasks.forEach((t) => { const k = `${t.agent}:${t.lvl}`; stack.set(k, (stack.get(k) ?? 0) + 1); });
  const laneY = new Map<string, number>();
  let yAcc = 0;
  const lanes = [...m.agents, ...(m.tasks.some((t) => !m.agents.some((a) => a.id === t.agent)) ? [NONE] : [])];
  lanes.forEach((a) => {
    laneY.set(a.id, yAcc);
    const rows = Math.max(1, ...[...stack.entries()].filter(([k]) => k.startsWith(`${a.id}:`)).map(([, v]) => v));
    yAcc += LANE_H + (rows - 1) * (NODE_H + 12);
  });
  if (lens === 'exec') m.agents.forEach((a) => nodes.push({ id: `L-${a.id}`, kind: 'agent', a, x: 70, y: laneY.get(a.id)!, w: 140, h: 40, aria: a.name }));
  const x0 = lens === 'exec' ? 190 : 0;
  const slot = new Map<string, number>();
  m.tasks.forEach((t) => {
    let y: number;
    if (lens === 'exec') {
      const key = `${t.agent}:${t.lvl}`, k = slot.get(key) ?? 0; slot.set(key, k + 1);
      y = (laneY.get(t.agent) ?? yAcc) + k * (NODE_H + 12);
    } else { const col = byL[t.lvl]; y = (col.indexOf(t) - (col.length - 1) / 2) * 72; }
    nodes.push({ id: t.id, kind: 'task', t, x: x0 + t.lvl * COL_W + NODE_W / 2, y, w: NODE_W, h: NODE_H, aria: `${t.title}, ${t.label}`, cls: `t-${t.status}` });
  });
  const ids = new Set(m.tasks.map((t) => t.id));
  m.tasks.forEach((t) => t.deps.forEach((d) => {
    if (!ids.has(d)) return;
    const s = m.tasks.find((x) => x.id === d)!;
    const blk = t.status === 'blocked' && s.status !== 'done';
    edges.push({ from: d, to: t.id, kind: s.status === 'done' ? 'done' : blk ? 'block' : 'dep', cls: s.status === 'done' ? 'e-done' : blk ? 'e-block' : 'e-dep', marker: s.status === 'done' ? 'done' : blk ? undefined : 'dep' });
  }));
  if (lens === 'exec') {
    if (m.agents.some((a) => a.id === 'pm')) {
      const delegated = new Set(m.tasks.filter((t) => t.agent !== 'pm' && t.agent !== 'none').map((t) => t.agent));
      delegated.forEach((id) => edges.push({ from: 'L-pm', to: `L-${id}`, kind: 'deleg', cls: 'e-deleg', marker: 'del' }));
    }
    m.tasks.forEach((t) => {
      const a = m.agents.find((x) => x.id === t.agent);
      if (t.status === 'running' || t.status === 'waiting') edges.push({ from: `L-${t.agent}`, to: t.id, kind: t.status === 'running' ? 'exec' : 'wait', cls: t.status === 'running' ? 'e-exec' : 'e-wait', color: t.status === 'running' ? a?.h : undefined });
      else edges.push({ from: `L-${t.agent}`, to: t.id, kind: 'own', cls: 'e-own' });
    });
  }
  const span = Math.max(4, ...m.tasks.map((t) => t.lvl)) + 1;
  const under = lens === 'exec'
    ? () => `<g class="lane">${lanes.map((a) => { const y = laneY.get(a.id)! - LANE_H / 2; return `<line x1="-20" x2="${190 + span * COL_W}" y1="${y}" y2="${y}"/>`; }).join('')}</g>`
    : () => { const mx = Math.max(1, ...Object.values(byL).map((c) => c.length)); return `<g class="lane">${Object.keys(byL).map((l) => `<text x="${+l * COL_W + NODE_W / 2}" y="${-mx * 36 - 14}" text-anchor="middle">Nivel ${+l + 1}${byL[+l].length > 1 ? ` · ${byL[+l].length} en paralelo` : ''}</text>`).join('')}</g>`; };
  return { nodes, edges, under };
}
const edgePath = (e: GEdge, a: GNode, b: GNode) => {
  if (e.kind === 'deleg') { const x = a.x - a.w / 2 - 6; return `M${x},${a.y} C${x - 38},${a.y} ${x - 38},${b.y} ${x},${b.y}`; }
  if (e.kind === 'exec' || e.kind === 'wait' || e.kind === 'own') { const x1 = a.x + a.w / 2, x2 = b.x - b.w / 2 - 2; return `M${x1},${a.y} C${(x1 + x2) / 2},${a.y} ${(x1 + x2) / 2},${b.y} ${x2},${b.y}`; }
  return null;
};
const edgeDecor = (e: GEdge, a: GNode, b: GNode) => {
  if (e.kind !== 'block' && e.kind !== 'wait') return '';
  const mx = (a.x + a.w / 2 + b.x - b.w / 2) / 2, my = (a.y + b.y) / 2;
  return e.kind === 'block' ? `<g class="edeco blk" transform="translate(${mx},${my})"><circle r="7" fill="#0d0f12" stroke="#ff6b5d" stroke-width="1.2"/><path d="M-3.5,3.5L3.5,-3.5" stroke="#ff6b5d" stroke-width="1.2"/></g>`
    : `<g class="edeco wait" transform="translate(${mx},${my})"><circle r="9" fill="#17130d" stroke="#ffb25e" stroke-width="1.2"/><g transform="translate(-6,-6) scale(.5)" stroke="#ffb25e" fill="none" stroke-width="2.4">${ICON_PATHS.lock}</g></g>`;
};

function FlowGraph({ m, lens, sel, filter, onSel, onOpen }: { m: FModel; lens: Lens; sel: string | null; filter: FStatus | null; onSel: (id: string | null) => void; onOpen: (id: string) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const g = useRef<GraphHandle | null>(null);
  const mref = useRef(m);
  mref.current = m;
  const cb = useRef({ onSel, onOpen });
  cb.current = { onSel, onOpen };
  const sig = JSON.stringify([lens, m.demo, m.agents.map((a) => [a.id, a.engine]), m.tasks.map((t) =>
    [t.id, t.status, t.label, t.agent, t.deps, t.title, t.model])]);
  useEffect(() => {
    const { nodes, edges, under } = graphModel(mref.current, lens);
    if (!g.current) {
      g.current = createGraph(svg.current!, {
        nodes, edges, under, node: (n) => nodeSvg(n, mref.current), edgePath, edgeDecor, selected: sel, pad: [46, 24, 24, 40], maxFit: 1.1,
        label: 'Grafo de ejecución: flechas para recorrer, Intro para enfocar',
        onSelect: (id) => cb.current.onSel(id), onOpen: (id) => cb.current.onOpen(id),
        onKey: (k, s) => {
          const T = mref.current.tasks;
          if (!s) return T[0]?.id ?? null;
          const t = T.find((x) => x.id === s);
          if (!t) return null;
          if (k === 'ArrowRight') return T.find((x) => x.deps.includes(s))?.id ?? null;
          if (k === 'ArrowLeft') return t.deps[0] ?? null;
          const all = g.current!.nodes.filter((n) => n.kind === 'task').sort((a, b) => a.y - b.y || a.x - b.x);
          const j = all.findIndex((n) => n.id === s);
          return (k === 'ArrowDown' ? all[j + 1] : all[j - 1])?.id ?? null;
        },
      });
    } else g.current.morph(nodes, edges, under);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useEffect(() => { g.current?.nodes.forEach((n) => { if (n.kind === 'agent') { n.a = mref.current.agents.find((a) => `L-${a.id}` === n.id) ?? n.a; g.current!.update(n.id); } }); }, [m.agents]);
  useEffect(() => { g.current?.highlight(filter ? new Set(m.tasks.filter((t) => t.status === filter).map((t) => t.id)) : null); }, [filter, m.tasks]);
  useEffect(() => { if (g.current && g.current.selected !== sel) { g.current.select(sel, true); if (sel) g.current.focus(sel); } }, [sel]);
  useEffect(() => {
    let t = 0;
    const ro = new ResizeObserver(() => { window.clearTimeout(t); t = window.setTimeout(() => g.current?.fit(true), 120); });
    ro.observe(svg.current!);
    return () => { ro.disconnect(); window.clearTimeout(t); g.current?.destroy(); g.current = null; };
  }, []);
  const legend: [string, string][] = [['e-dep', 'dependencia'], ['e-deleg', 'delegación'], ['e-exec', 'ejecución'], ['e-wait', 'permiso'], ['e-block', 'bloqueo'], ['e-done', 'terminada']];
  return (
    <>
      <svg ref={svg} className="g flowg" />
      <div className="gtools" role="toolbar" aria-label="Zoom">
        <button className="tbtn" onClick={() => g.current?.zoom(1.2)} aria-label="Acercar"><Icon name="zin" size={15} /></button>
        <button className="tbtn" onClick={() => g.current?.zoom(0.83)} aria-label="Alejar"><Icon name="zout" size={15} /></button>
        <button className="tbtn" onClick={() => g.current?.fit(true)} aria-label="Encajar"><Icon name="fit" size={15} /></button>
        <span className="gsep" /><span className="ghint">Arrastra o usa dos dedos · pellizca para zoom · ←→ recorre dependencias</span>
      </div>
      <div className="legend" aria-label="Leyenda">
        {legend.filter(([k]) => lens === 'exec' || !['e-deleg', 'e-exec', 'e-wait'].includes(k)).map(([k, l]) => (
          <span key={k}><svg width="26" height="8" aria-hidden="true"><path className={`ge ${k} lg`} d="M1 4H25" style={k === 'e-exec' ? { stroke: '#b09cff' } : undefined} /></svg>{l}</span>
        ))}
      </div>
    </>
  );
}

function FlowList({ m, sel, filter, onSel }: { m: FModel; sel: string | null; filter: FStatus | null; onSel: (id: string) => void }) {
  const L = m.tasks.filter((t) => !filter || t.status === filter);
  return (
    <div className="scr" style={{ height: '100%' }}>
      <table className="tlist">
        <thead><tr><th /><th>Tarea</th><th>Agente · modelo</th><th>Depende de</th><th>Prioridad</th><th>Estado</th></tr></thead>
        <tbody>
          {L.map((t) => { const a = m.agents.find((x) => x.id === t.agent) ?? NONE; return (
            <tr key={t.id} className={sel === t.id ? 'sel' : ''} tabIndex={0} onClick={() => onSel(t.id)} onKeyDown={(e) => e.key === 'Enter' && onSel(t.id)}>
              <td><StDot st={ST2AG[t.status]} h={a.h} /></td>
              <td><span className="mono mut">{t.num != null ? `#${t.num}` : t.id}</span> {t.title}</td>
              <td>{a.name}{t.model ? <span className="mut"> · {t.model}</span> : null}</td>
              <td>{t.deps.length ? t.deps.map((d) => <span key={d} className={`chip ${m.tasks.find((x) => x.id === d)?.status === 'done' ? 'mint' : ''}`}>{m.demo ? d : `#${d}`}</span>) : <span className="mut">—</span>}</td>
              <td>{t.prio}</td>
              <td><span className={`chip tiny s-${t.status}`}>{t.label}</span></td>
            </tr>); })}
        </tbody>
      </table>
      {!L.length && <div className="empty sm">Ninguna tarea con ese estado.</div>}
      <p className="sample" style={{ padding: '10px 14px' }}>Las tareas sin dependencias pendientes pueden ejecutarse en paralelo dentro del límite del proyecto.</p>
    </div>
  );
}

function Inspector({ m, sel, onSel, onOpenSession, onEditTask, onAuto, onDirect, sessions, onLink }: {
  sessions: Session[]; onLink: (task: number, session: number) => void;
  m: FModel; sel: string | null; onSel: (id: string | null) => void; onOpenSession: (id: number | 'coach') => void; onEditTask: (id: number) => void; onAuto: (t: Task) => void; onDirect: (engine: string, task: number) => void;
}) {
  if (sel?.startsWith('L-')) {
    const a = m.agents.find((x) => `L-${x.id}` === sel);
    if (!a) return null;
    const mine = m.tasks.filter((t) => t.agent === a.id);
    return (
      <>
        <div className="sec"><div className="row"><AgDot a={a} s={18} /><h3 className="grow">{a.name}</h3><button className="tbtn" onClick={() => onSel(null)} aria-label="Cerrar"><Icon name="close" size={13} /></button></div><div className="mut2">{a.did}</div></div>
        <div className="sec"><dl className="kv"><dt>Motor</dt><dd>{a.engine}</dd><dt>Estado</dt><dd>{STATE_LABEL[a.state]}</dd>{a.branch && <><dt>Rama</dt><dd className="mono">{a.branch}</dd></>}<dt>Tareas</dt><dd className="row wrap">{mine.length ? mine.map((t) => <button key={t.id} className="chip btnchip" onClick={() => onSel(t.id)}>{t.num != null ? `#${t.num}` : t.id}</button>) : '—'}</dd></dl></div>
        {!m.demo && a.id !== 'none' && <div className="sec row wrap"><button className="btn sm" onClick={() => onOpenSession(a.session ?? 'coach')}><Icon name="chat" size={12} /> Abrir sesión</button></div>}
      </>
    );
  }
  const t = sel ? m.tasks.find((x) => x.id === sel) : null;
  if (!t) return (
    <>
      <div className="sec"><h3>Equipo</h3><div className="mut2">Selecciona una tarea o un agente. Doble clic o Intro abre la tarea.</div></div>
      <div className="sec col" style={{ gap: 4 }}>
        {m.agents.length ? m.agents.map((a) => <button key={a.id} className="agline rowbtn" onClick={() => onSel(`L-${a.id}`)}><AgDot a={a} /><b>{a.name}</b><span className="mut2 grow" style={{ textAlign: 'right' }}>{a.did}</span></button>)
          : <span className="mut2">No hay sesiones abiertas en este proyecto.</span>}
      </div>
    </>
  );
  const a = m.agents.find((x) => x.id === t.agent) ?? NONE;
  const miss = t.deps.map((d) => m.tasks.find((x) => x.id === d)).filter((d): d is FTask => !!d && d.status !== 'done');
  const runs = m.runs.filter((r) => r.task === t.id).sort((x, y) => y.at - x.at);
  const last = runs[0];
  const blocked = !!t.real && t.real.waitingFor.length > 0;
  return (
    <>
      <div className="sec">
        <div className="row" style={{ marginBottom: 6 }}><StDot st={ST2AG[t.status]} h={a.h} s={14} /><span className="mono mut2">{t.num != null ? `#${t.num}` : t.id}</span><span className={`chip s-${t.status}`}>{t.label}</span><span className="grow" /><button className="tbtn" onClick={() => onSel(null)} aria-label="Quitar selección"><Icon name="close" size={13} /></button></div>
        <h3>{t.title}</h3>
        {t.goal && <p className="mut2" style={{ margin: '4px 0 0', lineHeight: 1.5 }}>{t.goal}</p>}
        <div className="col" style={{ marginTop: 10, gap: 8 }}>
          {t.status === 'waiting' && <div className="perm compact"><div className="row"><Icon name="lock" size={14} /><b>Falta un permiso</b></div><div className="row">{a.session != null || a.id === 'pm' ? <button className="btn sm warn" onClick={() => onOpenSession(a.session ?? 'coach')}>Ver la petición</button> : <span className="mut2">Ábrela desde la sesión de la tarea.</span>}</div></div>}
          {miss.length > 0 && <div className="why"><b>Espera a {miss.map((d, i) => <span key={d.id}>{i ? ' y ' : ''}<button className="lnk" onClick={() => onSel(d.id)}>{d.num != null ? `#${d.num}` : d.id}</button></span>)}</b>
            <div className="col" style={{ gap: 3, marginTop: 6 }}>{miss.map((d) => <span key={d.id} className="row"><StDot st={ST2AG[d.status]} s={11} /><span>{d.title} · {d.label}</span></span>)}</div></div>}
          {m.demo ? <span className="simtag">demostración: acciones desactivadas</span> : t.real && (
            <div className="row wrap">
              <button className="btn sm" onClick={() => onEditTask(t.real!.id)}><Icon name="edit" size={12} /> Editar</button>
              {a.session != null && <button className="btn sm" onClick={() => onOpenSession(a.session!)}><Icon name="chat" size={12} /> Sesión</button>}
              <button className="btn sm" disabled={blocked} onClick={() => onAuto(t.real!)}><Icon name="agent" size={12} /> PM</button>
              <button className="btn sm ghost" disabled={blocked} onClick={() => onDirect('codex', t.real!.id)}>Codex</button>
              <button className="btn sm ghost" disabled={blocked} onClick={() => onDirect('claude', t.real!.id)}>Claude</button>
              {(() => {
                const free = sessions.filter((s) => !t.real!.sessions.some((l) => l.id === s.id));
                return free.length > 0 && <select className="in flow-link" aria-label="Vincular una sesión abierta" value="" onChange={(e) => { const id = Number(e.target.value); if (id) onLink(t.real!.id, id); }}>
                  <option value="">Vincular sesión…</option>
                  {free.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.engine}</option>)}
                </select>;
              })()}
            </div>
          )}
        </div>
      </div>
      <div className="sec"><dl className="kv">
        <dt>Agente</dt><dd className="row"><AgDot a={a} s={12} />{a.name}</dd>
        <dt>Depende de</dt><dd className="row wrap">{t.deps.length ? t.deps.map((d) => <button key={d} className={`chip btnchip ${m.tasks.find((x) => x.id === d)?.status === 'done' ? 'mint' : ''}`} onClick={() => onSel(d)}>{m.demo ? d : `#${d}`}</button>) : '—'}</dd>
        <dt>Desbloquea</dt><dd className="row wrap">{m.tasks.filter((x) => x.deps.includes(t.id)).map((x) => <button key={x.id} className="chip btnchip" onClick={() => onSel(x.id)}>{x.num != null ? `#${x.num}` : x.id}</button>)}{!m.tasks.some((x) => x.deps.includes(t.id)) && '—'}</dd>
        <dt>Prioridad</dt><dd>{t.prio}</dd>
        {t.real?.criteria && <><dt>Criterios</dt><dd>{t.real.criteria}</dd></>}
        {t.real && <><dt>Verificación</dt><dd>{t.real.verification}{t.real.tests ? ` · ${t.real.tests}` : ''}</dd></>}
      </dl></div>
      <div className="sec">
        <div className="row" style={{ marginBottom: 8 }}><Icon name="route" size={14} /><b>{last ? `Por qué ${last.model ?? last.provider}` : 'Decisión de Jev'}</b><span className="grow" />{last?.complexity && <span className="chip">{last.complexity}</span>}</div>
        <div className="why">{last?.reason ?? (last ? 'Esta ejecución no registró motivo.' : 'Aún no se ha ejecutado: no hay decisión registrada.')}</div>
        {last && <dl className="kv" style={{ marginTop: 10 }}><dt>Origen</dt><dd>{last.source ? ROUTING_SOURCE[last.source] : 'Sin registrar'}</dd><dt>Confianza</dt><dd>{last.confidence != null ? `${Math.round(last.confidence * 100)}%` : '—'}</dd><dt>Esfuerzo</dt><dd>{last.effort ?? '—'}</dd></dl>}
      </div>
      <div className="sec"><span className="lab">Historial</span>
        {runs.length ? <ol className="tev">{runs.slice(0, 8).map((r, i) => <li key={i}><span className="mono mut2">{new Date(r.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</span><span>{r.provider}{r.model ? ` · ${r.model}` : ''} · {r.outcome}{r.tokens ? ` · ${r.tokens.toLocaleString('es-ES')} tokens` : ''}</span></li>)}</ol>
          : <p className="mut2" style={{ margin: '6px 0 0' }}>Sin ejecuciones.</p>}
      </div>
    </>
  );
}

function Route({ m, sel, onSel }: { m: FModel | null; sel: string | null; onSel: (id: string) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(600);
  const codex = useProviderQuota('codex', null, false), claude = useProviderQuota('claude', null);
  useEffect(() => { const ro = new ResizeObserver(([e]) => setW(e.contentRect.width)); if (svg.current) ro.observe(svg.current); return () => ro.disconnect(); }, []);
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const runs = (m?.runs ?? []).filter((r) => r.at >= day.getTime() || m?.demo).sort((a, b) => a.at - b.at);
  const t0 = runs.length ? runs[0].at - 5 * 60000 : Date.now() - 3600000, t1 = Math.max(t0 + 30 * 60000, (runs.at(-1)?.at ?? Date.now()) + 5 * 60000);
  const X = (t: number) => 24 + ((t - t0) / (t1 - t0)) * (w - 48);
  const M: Record<string, string> = { haiku: '#7fd6ff', sonnet: '#b09cff', opus: '#ffc27a', codex: '#8fc4ff' };
  const color = (r: FRun) => Object.entries(M).find(([k]) => `${r.model ?? r.provider}`.toLowerCase().includes(k))?.[1] ?? '#ccc';
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);
  const q = (label: string, quota: ReturnType<typeof useProviderQuota>) => quota.windows.length
    ? quota.windows.map((win) => { const left = Math.max(0, 100 - win.percent); return <div key={label + win.label} className="qrow"><span>{label} {win.label}</span><span className="qdots">{Array.from({ length: 20 }, (_, i) => <i key={i} className={i < left / 5 ? (left >= 70 ? 'h' : 'f') : ''} />)}</span><span className="mono">{Math.round(left)}%</span></div>; })
    : [<div key={label} className="qrow"><span>{label}</span><span className="qdots unk">{Array.from({ length: 20 }, (_, i) => <i key={i} />)}</span><span className="mut2">desconocida</span></div>];
  return (
    <div className="route">
      <div className="tl">
        <div className="row"><span className="lab"><Icon name="route" size={13} /> Ejecuciones y decisiones de Jev · hoy</span><span className="grow" /><span className="mut2" style={{ fontSize: 12 }}>{runs.length ? `${runs.length} ejecuciones` : 'sin ejecuciones hoy'}</span></div>
        <svg ref={svg} role="img" aria-label="Línea temporal de ejecuciones y decisiones de Jev">
          <line x1="24" x2={w - 24} y1="44" y2="44" stroke="rgba(255,255,255,.1)" strokeDasharray="1 4" />
          {ticks.map((t, i) => <text key={i} x={X(t)} y={100} textAnchor="middle" className="tlt">{new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</text>)}
          {runs.map((r, i) => { const x = X(r.at), y = [28, 58, 82][i % 3], c = color(r), on = sel === r.task; return (
            <g key={i} className={`rt${on ? ' on' : ''}`} tabIndex={0} role="button" aria-label={`${r.task}: ${r.model ?? r.provider}`} onClick={() => onSel(r.task)} onKeyDown={(e) => e.key === 'Enter' && onSel(r.task)}>
              <line x1={x} x2={x} y1="44" y2={y} stroke={c} strokeOpacity=".45" />
              <title>{r.source ? ROUTING_SOURCE[r.source] : 'Origen sin registrar'}</title>
              <path d={`M${x},${y - 6} L${x + 6},${y} L${x},${y + 6} L${x - 6},${y}z`} fill={r.source === 'jev' || r.source === 'shadow' ? c : '#0d0f12'} stroke={c} strokeWidth={on ? 2 : 1.2} />
              <text x={x + 10} y={y + 4} className="tll">{m?.tasks.find((t) => t.id === r.task)?.num != null ? `#${r.task}` : r.task} · {r.model ?? r.provider}</text>
            </g>); })}
        </svg>
      </div>
      <div className="quota"><span className="lab">Cuota disponible</span>{q('Codex', codex)}{q('Claude', claude)}</div>
    </div>
  );
}
