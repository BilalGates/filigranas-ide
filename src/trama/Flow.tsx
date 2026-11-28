import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { sessions as sessionApi, tasks as taskApi, type Session, type Task, type TaskRun, type TaskFlow } from '../ipc';
import { PRIORITY as PRIO } from './taskMeta';
import TaskForm from './TaskForm';
import { useUi } from '../ui';
import { createGraph, dependencyLevels, escapeXml, type GEdge, type GNode, type GraphHandle } from './graph';
import { ICON_PATHS, Icon } from './icons';
import { AgDot, EmptyArt, Root, StDot, sessionAgents, STATE_LABEL, type AgState, type Agent } from './kit';
import { flowStatus, flowProgress, placeInspector, taskSelection, inspectorKey, type FlowStatus, flowPositions } from './flowModel';
import './flow.css';
const PRIORITY = PRIO as Record<string, string>;
type Lens = 'exec' | 'deps' | 'list';
type FStatus = FlowStatus;
type FTask = {
    id: string;
    num: number | null;
    title: string;
    status: FStatus;
    label: string;
    agent: string;
    deps: string[];
    lvl: number;
    prio: string;
    model: string | null;
    real: Task | null;
    goal: string;
    progress?: number;
    files?: string;
};
type FRun = {
    id: number;
    raw: TaskRun;
    task: string;
    at: number;
    provider: string;
    model: string | null;
    outcome: string;
    reason: string | null;
    complexity: string | null;
    confidence: number | null;
    effort: string | null;
    source: NonNullable<TaskRun['routing']>['source'] | null;
    tokens: number | null;
    duration: number | null;
    cost?: number | null;
    routerModel?: string | null;
    routerCost?: number | null;
    context?: string | null;
    event?: string;
};
type FModel = {
    agents: Agent[];
    tasks: FTask[];
    runs: FRun[];
    demo: false;
    decisions?: Record<string, {
        scores: [
            string,
            number
        ][];
        cost: string;
        escalation?: string;
    }>;
};
const ROUTING_SOURCE: Record<NonNullable<FRun['source']>, string> = { jev: 'Jev', shadow: 'Jev en modo sombra', local: 'reglas locales', manual: 'elección manual', api_error: 'Jev no disponible (error de API)', unconfigured: 'Jev sin configurar' };
const LANE_H = 76, COL_W = 306, NODE_W = 280, NODE_H = 58;
const LAB: Record<FStatus, [
    string,
    string
]> = {
    running: ['en marcha', 'en marcha'], verifying: ['en verificación', 'en verificación'], waiting: ['espera permiso', 'esperan permiso'], blocked: ['bloqueada', 'bloqueadas'], failed: ['fallida', 'fallidas'], cancelled: ['cancelada', 'canceladas'], done: ['completada', 'completadas'], backlog: ['pendiente', 'pendientes'], review: ['en revisión', 'en revisión'], ready_to_merge: ['lista para integrar', 'listas para integrar'], paused_quota: ['pausada por cuota', 'pausadas por cuota'], queued: ['en cola', 'en cola'], pending: ['en cola', 'en cola'], waiting_dependencies: ['espera dependencias', 'esperan dependencias'], interrupted: ['interrumpida', 'interrumpidas'],
};
const ST2AG: Record<FStatus, AgState> = { done: 'done', running: 'working', verifying: 'thinking', waiting: 'waiting', blocked: 'blocked', failed: 'blocked', cancelled: 'idle', backlog: 'idle', review: 'thinking', ready_to_merge: 'idle', paused_quota: 'blocked', queued: 'idle', pending: 'idle', waiting_dependencies: 'blocked', interrupted: 'paused' };
const NONE: Agent = { id: 'none', session: null, name: 'Sin asignar', engine: '—', h: '#8d939c', state: 'idle', did: 'Sin sesión vinculada', branch: null };
function realModel(tasks: Task[], runs: Record<number, TaskRun[]>, agents: Agent[]): FModel {
    const assignedAgents = [...agents];
    const lanes = new Map(agents.filter((a) => a.session != null).map((a) => [a.session!, a.id]));
    const base: FTask[] = tasks.map((t) => {
        const session = t.sessions.find((s) => !s.closed && lanes.has(s.id));
        const run = runs[t.id]?.[0];
        let agent = session ? lanes.get(session.id)! : 'none';
        if (!session && t.agent) {
            agent = `assigned:${t.agent}:${t.role ?? ''}`;
            if (!assignedAgents.some((a) => a.id === agent)) assignedAgents.push({
                id: agent, session: null, name: t.role ? `${t.role} · ${t.agent}` : t.agent,
                engine: t.agent, h: '#9db6ff', state: 'idle', did: 'Asignación registrada · sin sesión vinculada', branch: null,
            });
        }
        return { id: String(t.id), num: t.id, title: t.title, status: flowStatus(t.status, t.phase), label: LAB[flowStatus(t.status, t.phase)][0], agent, deps: t.dependencies.map(String), lvl: 0, prio: PRIORITY[t.priority] ?? t.priority, model: run?.model ?? run?.routing?.executionModel ?? null, real: t, goal: t.goal };
    });
    const levels = dependencyLevels(base);
    base.forEach((t) => t.lvl = levels.get(t.id) ?? 0);
    const ids = new Set(base.map((t) => t.id));
    const flat: FRun[] = Object.entries(runs).filter(([id]) => ids.has(id)).flatMap(([id, list]) => list.map((r) => ({ id: r.id, raw: r, task: id, at: r.dispatchedMs ?? r.startedMs, provider: r.provider, model: r.model ?? r.routing?.executionModel ?? null, outcome: r.outcome, reason: r.routing?.reason ?? null, complexity: r.routing?.complexity ?? null, confidence: r.routing?.confidence ?? null, effort: r.routing?.effort ?? null, source: r.routing?.source ?? null, tokens: r.inputTokens, duration: r.durationMs, cost: r.costEstimateUsd, routerModel: r.routing?.model, routerCost: r.routing?.costEstimateUsd, context: r.routing?.eventAdvice ?? r.routing?.context })));
    const used = new Set(base.map((t) => t.agent));
    return { agents: [...assignedAgents.filter((a) => used.has(a.id)), ...(used.has('none') ? [NONE] : [])], tasks: base, runs: flat, demo: false };
}
export type FlowProps = {
    project: string | null;
    projectName: string | null;
    initialTask?: number | null;
    focusTask?: number | null;
    agentSessions: Session[];
    pm: {
        engine: string;
    } | null;
    onOpenSession: (id: number | 'coach') => void;
    onAuto: (task: Task) => void;
    onDirect: (engine: string, task: number) => void;
    onStartPm: () => void;
    onOpenDelivery?: (task: number) => void;
    onCompactWorkspace?: () => void;
    onSendToPm?: (task: Task) => void | Promise<void>;
};
export default function Flow({ project, projectName, initialTask, focusTask, agentSessions, pm, onOpenSession, onAuto, onDirect, onStartPm, onOpenDelivery, onCompactWorkspace, onSendToPm }: FlowProps) {
    const { activity } = useUi();
    const focusRequest = useRef<string | null>(null);
    const [loaded, setLoaded] = useState<{
        project: string;
        data: TaskFlow;
    } | null>(null);
    const snapshot = loaded?.project === project ? loaded.data : null;
    const [error, setError] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
    const [plan, setPlan] = useState('all'), [filter, setFilter] = useState<FStatus | null>(null);
    const [selection, setSelection] = useState<{
        project: string | null;
        id: string;
    } | null>(initialTask == null ? null : { project, id: String(initialTask) });
    const [editing, setEditing] = useState<number | null>(null), [limit, setLimit] = useState<{
        project: string;
        value: number;
    } | null>(null);
    const [lens, setLensState] = useState<Lens>(() => {
        try {
            const l = localStorage.getItem('filigranas.flow.lente');
            return l === 'deps' || l === 'list' ? l : 'exec';
        }
        catch {
            return 'exec';
        }
    });
    const setLens = (l: Lens) => {
        setLensState(l);
        try {
            localStorage.setItem('filigranas.flow.lente', l);
        }
        catch { /* private storage */ }
    };
    const [height, setHeight] = useState(() => {
        try {
            return Math.max(18, Math.min(60, Number(localStorage.getItem('filigranas.flow.activity')) || 30));
        }
        catch {
            return 30;
        }
    });
    const root = useRef<HTMLDivElement>(null), inspector = useRef<HTMLElement>(null), focusReturn = useRef<Element | null>(null);
    const agents = useMemo(() => sessionAgents(agentSessions.filter((s) => s.project === project), activity, pm, project), [agentSessions, project, activity, pm]);
    const selectedTasks = useMemo(() => (snapshot?.tasks ?? []).filter((t) => plan === 'all' || (plan === 'legacy' ? t.planId == null : String(t.planId) === plan)), [snapshot, plan]);
    const model = useMemo(() => snapshot ? realModel(selectedTasks, snapshot.runs, agents) : null, [snapshot, selectedTasks, agents]);
    const sel = taskSelection(project, selection, model?.tasks.map((t) => t.id) ?? [], model?.agents.map((a) => `L-${a.id}`) ?? [], [...(model?.runs.map((r) => `run:${r.id}`) ?? []), ...(model?.tasks.flatMap((t) => t.deps.map((d) => `dep:${d}:${t.id}`)) ?? [])]);
    const pick = (id: string | null) => { focusReturn.current = document.activeElement; setSelection(id ? { project, id } : null); };
    const progress = flowProgress(model?.tasks ?? []);
    const counts = useMemo(() => { const c = Object.fromEntries(Object.keys(LAB).map((s) => [s, 0])) as Record<FStatus, number>; model?.tasks.forEach((t) => c[t.status]++); return c; }, [model]);
    useEffect(() => { setPlan('all'); setFilter(null); setEditing(null); setError(null); }, [project]);
    useEffect(() => {
        if (!project)
            return;
        let alive = true, busy = false, queued = false, timer = 0;
        const load = async () => {
            timer = 0;
            if (!alive || document.hidden)
                return;
            if (busy) {
                queued = true;
                return;
            }
            busy = true;
            try {
                const data = await taskApi.flow(project);
                if (alive) {
                    setLoaded({ project, data });
                    setError(null);
                }
            }
            catch (e) {
                if (alive)
                    setError(String(e));
            }
            finally {
                busy = false;
                if (queued) {
                    queued = false;
                    schedule();
                }
            }
        };
        const schedule = () => {
            if (alive && !timer)
                timer = window.setTimeout(load, 140);
        };
        schedule();
        const off = listen('tasks-changed', schedule);
        document.addEventListener('visibilitychange', schedule);
        return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', schedule); void off.then((f) => f()); };
    }, [project, refresh]);
    useEffect(() => {
        if (!project)
            return;
        let alive = true;
        void taskApi.parallelLimit(project).then((value) => {
            if (alive)
                setLimit({ project, value });
        }, (e) => {
            if (alive)
                setError(String(e));
        });
        return () => { alive = false; };
    }, [project]);
    useEffect(() => {
        const id = focusTask ?? initialTask;
        if (id != null && focusRequest.current !== `${project}:${id}` && snapshot?.tasks.some((t) => t.id === id)) {
            focusRequest.current = `${project}:${id}`;
            setPlan('all');
            setSelection({ project, id: String(id) });
        }
    }, [focusTask, initialTask, project, snapshot]);
    useEffect(() => {
        const box = inspector.current, container = root.current;
        if (!sel || !box || !container)
            return;
        let frame = 0;
        const position = () => { const anchor = [...container.querySelectorAll('[data-gid],[data-flow-anchor]')].find((e) => e.getAttribute('data-gid') === sel || e.getAttribute('data-flow-anchor') === sel); const r = container.getBoundingClientRect(), a = anchor?.getBoundingClientRect(); const p = placeInspector(r.width, r.height, box.offsetWidth, box.offsetHeight, a ? { x: a.left - r.left, y: a.top - r.top, width: a.width, height: a.height } : null); box.style.left = `${p.x}px`; box.style.top = `${p.y}px`; };
        const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
        position();
        box.focus({ preventScroll: true });
        const mutation = new MutationObserver(schedule);
        mutation.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['transform', 'viewBox'] });
        const observer = new ResizeObserver(schedule);
        observer.observe(container);
        observer.observe(box);
        container.addEventListener('scroll', schedule, true);
        const close = () => {
            setSelection(null);
            if (focusReturn.current instanceof HTMLElement || focusReturn.current instanceof SVGElement)
                focusReturn.current.focus({ preventScroll: true });
        };
        const key = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
            else if (e.target === box && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                const next = inspectorKey(e.key, model?.tasks.map((t) => t.id) ?? [], sel);
                setSelection(next ? { project, id: next } : null);
            }
        };
        const outside = (e: PointerEvent) => {
            if (!box.contains(e.target as Node) && !(e.target as Element).closest('[data-gid],[data-flow-anchor]'))
                close();
        };
        document.addEventListener('keydown', key);
        document.addEventListener('pointerdown', outside);
        return () => { cancelAnimationFrame(frame); mutation.disconnect(); observer.disconnect(); container.removeEventListener('scroll', schedule, true); document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
    }, [sel]);
    const resize = (value: number) => {
        const next = Math.max(18, Math.min(60, value));
        setHeight(next);
        try {
            localStorage.setItem('filigranas.flow.activity', String(next));
        }
        catch { /* private storage */ }
    };
    if (!project)
        return <Root label="Flow"><div className="flow-empty"><div className="empty big"><EmptyArt /><h3>Elige un proyecto</h3><p>Flow supervisa las tareas del proyecto abierto.</p></div></div></Root>;
    return <Root label="Flow"><div ref={root} className="flow flow-continuous" style={{ gridTemplateRows: `auto minmax(0,1fr) 6px minmax(100px,${height}%)` }}>
  <header className="flowh"><h2>{projectName}</h2><select className="in flow-plan" aria-label="Plan actual o histórico" value={plan} onChange={(e) => { setPlan(e.target.value); pick(null); }}><option value="all">Todos los planes</option>{(['active', 'history'] as const).map((group) => <optgroup key={group} label={group === 'active' ? 'Planes con tareas pendientes' : 'Histórico / sin tareas'}>{snapshot?.plans.filter((p) => snapshot.tasks.some((t) => t.planId === p.id && !['done', 'cancelled'].includes(t.status)) === (group === 'active')).map((p) => <option key={p.id} value={p.id}>{p.title} · {new Date(p.createdAt * 1000).toLocaleDateString()}</option>)}</optgroup>)}<option value="legacy">Sin plan · histórico</option></select>
  <span className="flow-progress" role="status" aria-label={`${progress.done} de ${progress.total} tareas completadas, ${progress.percent}%`}>{progress.done}/{progress.total} · {progress.percent}%</span><span className="grow"/>
  <div className="seg" aria-label="Vista" role="group">{([['exec', 'lanes', 'Ejecución'], ['deps', 'graph', 'Dependencias'], ['list', 'list', 'Lista']] as const).map(([id, icon, label]) => <button key={id} aria-pressed={lens === id} className={lens === id ? 'on' : ''} onClick={() => setLens(id)}><Icon name={icon} size={14}/>{label}</button>)}</div>
  {limit?.project === project && <label className="flow-limit">Concurrencia <input className="in" type="number" min={1} step={1} aria-label="Máximo de tareas simultáneas" key={`${project}:${limit.value}`} defaultValue={limit.value} onBlur={(e) => {
                const el = e.currentTarget, value = el.valueAsNumber;
                if (!el.validity.valid || !Number.isInteger(value)) {
                    el.value = String(limit.value);
                    return;
                }
                if (value !== limit.value)
                    void taskApi.parallelLimit(project, value).then((value) => setLimit({ project, value }), (err) => { el.value = String(limit.value); setError(String(err)); });
            }} onKeyDown={(e) => {
                if (e.key === 'Enter')
                    e.currentTarget.blur();
            }}/></label>}
  <button className="btn sm" onClick={() => setEditing(0)}><Icon name="plus" size={12}/> Tarea</button>
  <div className="flow-counts" role="group" aria-label="Estados de las tareas">{(Object.keys(LAB) as FStatus[]).filter((s) => counts[s] > 0).map((s) => <button key={s} className={`ovc s-${s}`} aria-pressed={filter === s} onClick={() => setFilter(filter === s ? null : s)}><StDot st={ST2AG[s]} s={10}/><b>{counts[s]}</b> {LAB[s][counts[s] === 1 ? 0 : 1]}</button>)}<span>{model?.runs.filter((r) => r.outcome === 'running').length ?? 0} ejecuciones activas registradas</span></div>
  </header>
  <div className="stage">{error && <div role="alert" className="flow-err">{error}<button className="btn sm" onClick={() => setRefresh((n) => n + 1)}>Reintentar</button></div>}{!model ? <p role="status">Cargando tareas…</p> : !model.tasks.length ? <div className="empty big"><EmptyArt /><h3>Sin tareas en esta selección</h3><div className="row"><button className="btn" onClick={() => setEditing(0)}>Crear tarea</button><button className="btn" onClick={onStartPm}>Planificar con el PM</button></div></div> : lens === 'list' ? <FlowList m={model} sel={sel} filter={filter} onSel={pick}/> : <FlowGraph m={model} lens={lens} sel={sel} filter={filter} onSel={pick} onOpen={(id) => {
                const t = model.tasks.find((t) => t.id === id);
                if (t?.num)
                    setEditing(t.num);
            }}/>}</div>
  <div className="flow-divider" role="separator" tabIndex={0} aria-label="Altura de actividad" aria-orientation="horizontal" aria-valuemin={18} aria-valuemax={60} aria-valuenow={Math.round(height)} onKeyDown={(e) => {
            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                resize(e.key === 'Home' ? 18 : e.key === 'End' ? 60 : height + (e.key === 'ArrowUp' ? 2 : -2));
            }
        }} onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                const r = root.current!.getBoundingClientRect();
                resize(100 * (r.bottom - e.clientY) / r.height);
            }
        }} onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}/>
  <Route key={`${project}:${plan}`} m={model} sel={sel} onSel={pick}/>
  {onCompactWorkspace && <button className="tbtn flow-compact" style={{ bottom: `calc(${height}% + 18px)` }} aria-label="Compactar Workspace" onClick={onCompactWorkspace}><Icon name="panel" size={16}/></button>}
  {sel && model && <aside ref={inspector} className="flow-inspector" role="dialog" aria-label="Detalle de la selección" tabIndex={-1}>{sel.startsWith('dep:') ? <DependencyDetail m={model} id={sel} onSel={pick}/> : sel.startsWith('run:') ? <RunDetail run={model.runs.find((r) => `run:${r.id}` === sel)} onTask={pick} onClose={() => pick(null)}/> : <><Inspector m={model} sel={sel} onSel={pick} onOpenSession={onOpenSession} onEditTask={setEditing} onAuto={onAuto} onDirect={onDirect} sessions={agentSessions.filter((s) => s.project === project)} onLink={(task, session) => { void taskApi.link(project, task, session).then(() => setRefresh((n) => n + 1), (e) => setError(String(e))); }}/>{(() => { const t = model.tasks.find((t) => t.id === sel)?.real; return t && <div className="sec"><ExactPrompt prompt={t.prompt}/>{onOpenDelivery && <button className="btn sm" onClick={() => onOpenDelivery(t.id)}>Abrir Entrega</button>}{onSendToPm && <button className="btn sm" onClick={() => { void Promise.resolve().then(() => onSendToPm(t)).catch((e) => setError(String(e))); }}>Enviar al PM</button>}</div>; })()}</>}</aside>}
 </div>{editing != null && <TaskForm key={`${project}:${editing}`} project={project} planId={/^\d+$/.test(plan) ? Number(plan) : null} task={editing ? snapshot?.tasks.find((t) => t.id === editing) ?? null : null} all={snapshot?.tasks ?? []} onSendToPm={onSendToPm} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); setRefresh((n) => n + 1); setSelection({ project, id: String(id) }); }}/>}</Root>;
}
function nodeSvg(n: GNode, m: FModel) {
    if (n.kind === 'agent') {
        const a = n.a as Agent;
        const c = a.state === 'waiting' ? '#ffb25e' : a.state === 'idle' ? 'rgba(220,226,236,.4)' : a.state === 'done' ? '#6fe0b3' : a.state === 'blocked' ? '#ff6b5d' : a.h;
        const [role, mdl] = a.name.split(' · ');
        return `<rect class="body lane" x="-95" y="-18" width="190" height="36" rx="9"/><circle cx="-79" cy="0" r="9" fill="none" stroke="${c}" stroke-opacity=".35" class="${a.state === 'working' ? 'svgbreath' : a.state === 'waiting' ? 'svgbeat' : a.state === 'thinking' ? 'svgthink' : ''}"/><circle cx="-79" cy="0" r="3.6" fill="${a.state === 'idle' ? 'none' : c}" stroke="${c}"/><text x="-63" y="-2">${escapeXml((role ?? a.name).slice(0, 22))}</text><text class="s" x="-63" y="12">${escapeXml((mdl ?? a.engine).slice(0, 25))}</text>`;
    }
    const t = n.t as FTask, a = m.agents.find((x) => x.id === t.agent) ?? NONE;
    const c = t.status === 'done' ? '#6fe0b3' : t.status === 'waiting' ? '#ffb25e' : t.status === 'running' ? a.h : t.status === 'blocked' ? '#ff6b5d' : 'rgba(220,226,236,.45)';
    const w = n.w, h = n.h, x = -w / 2, y = -h / 2, title = t.title.length > 30 ? `${t.title.slice(0, 29)}…` : t.title;
    const badge = t.status === 'waiting' ? `<g class="badge" transform="translate(${w / 2 - 14},${y + 1})"><rect x="-26" y="-9" width="40" height="18" rx="9" fill="#2a1f10" stroke="#ffb25e" stroke-opacity=".6"/><text x="-6" y="4" text-anchor="middle" class="bt" style="fill:#ffc98a">permiso</text></g>`
        : t.status === 'done' ? `<g transform="translate(${w / 2 - 16},0)" class="okmark"><circle r="8" fill="rgba(111,224,179,.14)"/><path d="M-3.5,0.5L-1,3L3.8,-2.5" fill="none" stroke="#6fe0b3" stroke-width="1.6" stroke-linecap="round"/></g>` : '';
    const sub = `${t.num != null ? `#${t.num}` : t.id}${t.model ? ` · ${t.model}` : a.id !== 'none' ? ` · ${a.engine}` : ''} · ${t.label}`;
    const progress = t.progress ?? (t.status === 'done' ? 100 : 0);
    const progressLine = progress > 0 ? `<line x1="${x + 12}" y1="${y + h - 6}" x2="${x + 12 + (w - 24) * progress / 100}" y2="${y + h - 6}" stroke="${c}" stroke-width="2" stroke-dasharray="2 3"/>` : '';
    return `${t.status === 'running' ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${a.h}" fill-opacity=".07"/>` : ''}<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>
<circle cx="${x + 16}" cy="${y + 18}" r="7.5" fill="none" stroke="${c}" stroke-opacity=".35" class="${t.status === 'running' ? 'svgbreath' : t.status === 'waiting' ? 'svgbeat' : ''}"/><circle cx="${x + 16}" cy="${y + 18}" r="3.6" fill="${t.status === 'backlog' || t.status === 'blocked' ? 'none' : c}" stroke="${c}" stroke-width="1.4"/>
<text x="${x + 30}" y="${y + 22}">${escapeXml(title)}</text><text class="s" x="${x + 30}" y="${y + 38}">${escapeXml(sub.length > 37 ? sub.slice(0, 36) + "…" : sub)}</text>
<line x1="${x + 12}" y1="${y + h - 6}" x2="${x + w - 12}" y2="${y + h - 6}" stroke="rgba(255,255,255,.08)" stroke-width="2" stroke-dasharray="2 3"/>${progressLine}${m.demo ? '' : badge}`;
}
function graphModel(m: FModel, lens: Lens) {
    const nodes: GNode[] = [], edges: GEdge[] = [];
    const byL: Record<number, FTask[]> = {};
    m.tasks.forEach((t) => { (byL[t.lvl] = byL[t.lvl] || []).push(t); });
    const layout = flowPositions(m.tasks, m.agents.map((a) => a.id), lens === 'exec' ? 'exec' : 'deps');
    const lanes = m.agents;
    const laneY = layout.lanes;
    const x0 = lens === 'exec' ? 160 : 40;
    if (lens === 'exec')
        m.agents.forEach((a) => nodes.push({ id: `L-${a.id}`, kind: 'agent', a, x: 0, y: laneY.get(a.id)!, w: 190, h: 40, keep: true, aria: a.name }));
    m.tasks.forEach((t) => { const p = layout.tasks.get(t.id)!; nodes.push({ id: t.id, kind: 'task', t, ...p, w: NODE_W, h: NODE_H, aria: `${t.title}, ${t.label}`, cls: `t-${t.status}` }); });
    const byId = new Map(m.tasks.map((t) => [t.id, t]));
    const demoCritical = new Set(['t1', 't2', 't4', 't7', 't8']);
    m.tasks.forEach((t) => t.deps.forEach((d) => {
        const s = byId.get(d);
        if (!s)
            return;
        const blk = t.status === 'blocked' && s.status !== 'done';
        const live = s.status === 'done' && (t.status === 'running' || t.status === 'waiting');
        if (m.demo) {
            const critical = lens === 'deps' && demoCritical.has(d) && demoCritical.has(t.id);
            edges.push({ from: d, to: t.id, cls: live ? 'live' : blk ? 'blk' : critical ? 'crit' : '' });
            return;
        }
        edges.push({ from: d, to: t.id, kind: s.status === 'done' ? 'done' : blk ? 'block' : 'dep', cls: live ? 'live' : s.status === 'done' ? 'e-done' : blk ? 'e-block' : 'e-dep', marker: s.status === 'done' ? 'done' : blk ? undefined : 'dep' });
    }));
    if (lens === 'exec' && !m.demo) {
        m.tasks.forEach((t) => {
            const a = m.agents.find((x) => x.id === t.agent);
            if (t.status === 'running' || t.status === 'waiting')
                edges.push({ from: `L-${t.agent}`, to: t.id, kind: t.status === 'running' ? 'exec' : 'wait', cls: t.status === 'running' ? 'e-exec' : 'e-wait', color: t.status === 'running' ? a?.h : undefined });
            else
                edges.push({ from: `L-${t.agent}`, to: t.id, kind: 'own', cls: 'e-own' });
        });
    }
    const span = Math.max(4, ...m.tasks.map((t) => t.lvl)) + 1;
    const under = lens === 'exec'
        ? () => `<g class="lane">${lanes.map((a) => { const y = laneY.get(a.id)! + LANE_H / 2; return `<line x1="-20" x2="${220 + span * COL_W}" y1="${y}" y2="${y}"/>`; }).join('')}</g>`
        : () => { const mx = Math.max(1, ...Object.values(byL).map((c) => c.length)); return `<g class="lane">${Object.keys(byL).map((l) => `<text x="${x0 + +l * COL_W + 100}" y="${-mx * 40 - 6}" text-anchor="middle">Nivel ${+l + 1}${byL[+l].length > 1 ? ` · ${byL[+l].length} en paralelo` : ''}</text>`).join('')}</g>`; };
    return { nodes, edges, under };
}
const edgePath = (e: GEdge, a: GNode, b: GNode) => {
    if (e.kind === 'deleg') {
        const x = a.x - a.w / 2 - 6;
        return `M${x},${a.y} C${x - 38},${a.y} ${x - 38},${b.y} ${x},${b.y}`;
    }
    if (e.kind === 'exec' || e.kind === 'wait' || e.kind === 'own') {
        const x1 = a.x + a.w / 2, x2 = b.x - b.w / 2 - 2;
        return `M${x1},${a.y} C${(x1 + x2) / 2},${a.y} ${(x1 + x2) / 2},${b.y} ${x2},${b.y}`;
    }
    return null;
};
const edgeDecor = (e: GEdge, a: GNode, b: GNode) => {
    if (e.kind !== 'block' && e.kind !== 'wait')
        return '';
    const mx = (a.x + a.w / 2 + b.x - b.w / 2) / 2, my = (a.y + b.y) / 2;
    return e.kind === 'block' ? `<g class="edeco blk" transform="translate(${mx},${my})"><circle r="7" fill="#0d0f12" stroke="#ff6b5d" stroke-width="1.2"/><path d="M-3.5,3.5L3.5,-3.5" stroke="#ff6b5d" stroke-width="1.2"/></g>`
        : `<g class="edeco wait" transform="translate(${mx},${my})"><circle r="9" fill="#17130d" stroke="#ffb25e" stroke-width="1.2"/><g transform="translate(-6,-6) scale(.5)" stroke="#ffb25e" fill="none" stroke-width="2.4">${ICON_PATHS.lock}</g></g>`;
};
function FlowGraph({ m, lens, sel, filter, onSel, onOpen }: {
    m: FModel;
    lens: Lens;
    sel: string | null;
    filter: FStatus | null;
    onSel: (id: string | null) => void;
    onOpen: (id: string) => void;
}) {
    const svg = useRef<SVGSVGElement>(null);
    const g = useRef<GraphHandle | null>(null);
    const mref = useRef(m);
    mref.current = m;
    const cb = useRef({ onSel, onOpen });
    cb.current = { onSel, onOpen };
    const sig = JSON.stringify([lens, m.agents.map((a) => a.id), m.tasks.map((t) => [t.id, t.agent, t.deps, t.status, t.title, t.model])]);
    useEffect(() => {
        const { nodes, edges, under } = graphModel(mref.current, lens);
        if (!g.current) {
            g.current = createGraph(svg.current!, {
                nodes, edges, under, node: (n) => nodeSvg(n, mref.current), edgePath, edgeDecor, selected: sel, pad: m.demo ? [40, 10, 10, 10] : [46, 24, 24, 40], maxFit: m.demo ? 1.25 : 1.1, minFit: 0.01, preserveCamera: true,
                label: 'Grafo de ejecución: flechas para recorrer, Intro para enfocar',
                onSelect: (id) => cb.current.onSel(id), onOpen: (id) => cb.current.onOpen(id),
                onKey: (k, s) => {
                    const T = mref.current.tasks;
                    if (!s)
                        return T[0]?.id ?? null;
                    const t = T.find((x) => x.id === s);
                    if (!t)
                        return null;
                    if (k === 'ArrowRight')
                        return T.find((x) => x.deps.includes(s))?.id ?? null;
                    if (k === 'ArrowLeft')
                        return t.deps[0] ?? null;
                    const all = g.current!.nodes.filter((n) => n.kind === 'task').sort((a, b) => a.y - b.y || a.x - b.x);
                    const j = all.findIndex((n) => n.id === s);
                    return (k === 'ArrowDown' ? all[j + 1] : all[j - 1])?.id ?? null;
                },
            });
        }
        else
            g.current.morph(nodes, edges, under);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sig]);
    useEffect(() => {
        g.current?.nodes.forEach((n) => {
            if (n.kind === 'task') {
                n.t = m.tasks.find((t) => t.id === n.id);
                n.cls = `t-${(n.t as FTask)?.status}`;
                g.current!.update(n.id);
            }
        });
    }, [m.tasks]);
    useEffect(() => {
        g.current?.nodes.forEach((n) => {
            if (n.kind === 'agent') {
                n.a = mref.current.agents.find((a) => `L-${a.id}` === n.id) ?? n.a;
                g.current!.update(n.id);
            }
        });
    }, [m.agents]);
    useEffect(() => { g.current?.highlight(filter ? new Set(m.tasks.filter((t) => t.status === filter).map((t) => t.id)) : null); }, [filter, m.tasks]);
    useEffect(() => {
        if (g.current && g.current.selected !== sel) {
            g.current.select(sel, true);
        }
    }, [sel]);
    useEffect(() => {
        return () => { g.current?.destroy(); g.current = null; };
    }, []);
    const legend: [
        string,
        string
    ][] = [['e-dep', 'dependencia'], ['e-exec', 'ejecución'], ['e-wait', 'permiso'], ['e-block', 'bloqueo'], ['e-done', 'terminada']];
    return (<>
      <svg ref={svg} className="g flowg"/>
      <div className="gtools" role="toolbar" aria-label="Zoom">
        <button className="tbtn" onClick={() => g.current?.zoom(1.2)} aria-label="Acercar"><Icon name="zin" size={15}/></button>
        <button className="tbtn" onClick={() => g.current?.zoom(0.83)} aria-label="Alejar"><Icon name="zout" size={15}/></button>
        <button className="tbtn" onClick={() => g.current?.fit(true)} aria-label="Encajar"><Icon name="fit" size={15}/></button>
        <span className="gsep"/><span className="ghint">Arrastra o usa dos dedos · pellizca para zoom · ←→ recorre dependencias</span>
      </div>
      <div className="legend" aria-label="Leyenda">
        {legend.filter(([k]) => lens === 'exec' || !['e-deleg', 'e-exec', 'e-wait'].includes(k)).map(([k, l]) => (<span key={k}><svg width="26" height="8" aria-hidden="true"><path className={`ge ${k} lg`} d="M1 4H25" style={k === 'e-exec' ? { stroke: '#b09cff' } : undefined}/></svg>{l}</span>))}
      </div>
    </>);
}
function FlowList({ m, sel, filter, onSel }: {
    m: FModel;
    sel: string | null;
    filter: FStatus | null;
    onSel: (id: string) => void;
}) {
    const L = m.tasks.filter((t) => !filter || t.status === filter);
    return (<div className="scr" style={{ height: '100%' }}>
      <table className="tlist">
        <thead><tr><th /><th>Tarea</th><th>Agente · modelo</th><th>Depende de</th><th>Prioridad</th><th>Estado</th></tr></thead>
        <tbody>
          {L.map((t) => {
            const a = m.agents.find((x) => x.id === t.agent) ?? NONE;
            return (<tr key={t.id} data-flow-anchor={t.id} className={sel === t.id ? 'sel' : ''} tabIndex={0} onClick={() => onSel(t.id)} onKeyDown={(e) => e.key === 'Enter' && onSel(t.id)}>
              <td><StDot st={ST2AG[t.status]} h={a.h}/></td>
              <td><span className="mono mut">{t.num != null ? `#${t.num}` : t.id}</span> {t.title}</td>
              <td>{a.name}{t.model ? <span className="mut"> · {t.model}</span> : null}</td>
              <td>{t.deps.length ? t.deps.map((d) => <span key={d} className={`chip ${m.tasks.find((x) => x.id === d)?.status === 'done' ? 'mint' : ''}`}>{m.demo ? d : `#${d}`}</span>) : <span className="mut">—</span>}</td>
              <td>{t.prio}</td>
              <td><span className={`chip tiny s-${t.status}`}>{t.label}</span></td>
            </tr>);
        })}
        </tbody>
      </table>
      {!L.length && <div className="empty sm">Ninguna tarea con ese estado.</div>}
      <p className="sample" style={{ padding: '10px 14px' }}>Las tareas sin dependencias pendientes pueden ejecutarse en paralelo dentro del límite del proyecto.</p>
    </div>);
}
function Inspector({ m, sel, onSel, onOpenSession, onEditTask, onAuto, onDirect, sessions, onLink }: {
    sessions: Session[];
    onLink: (task: number, session: number) => void;
    m: FModel;
    sel: string | null;
    onSel: (id: string | null) => void;
    onOpenSession: (id: number | 'coach') => void;
    onEditTask: (id: number) => void;
    onAuto: (t: Task) => void;
    onDirect: (engine: string, task: number) => void;
}) {
    if (sel?.startsWith('L-')) {
        const a = m.agents.find((x) => `L-${x.id}` === sel);
        if (!a)
            return null;
        const mine = m.tasks.filter((t) => t.agent === a.id);
        return (<>
        <div className="sec"><div className="row"><AgDot a={a} s={18}/><h3 className="grow">{a.name}</h3><button className="tbtn" onClick={() => onSel(null)} aria-label="Cerrar"><Icon name="close" size={13}/></button></div><div className="mut2">{a.did}</div></div>
        <div className="sec"><dl className="kv"><dt>Motor</dt><dd>{a.engine}</dd><dt>Estado</dt><dd>{STATE_LABEL[a.state]}</dd>{a.branch && <><dt>Rama</dt><dd className="mono">{a.branch}</dd></>}<dt>Tareas</dt><dd className="row wrap">{mine.length ? mine.map((t) => <button key={t.id} className="chip btnchip" onClick={() => onSel(t.id)}>{t.num != null ? `#${t.num}` : t.id}</button>) : '—'}</dd></dl></div>
        {!m.demo && (a.session != null || a.id === 'pm') && <div className="sec row wrap"><button className="btn sm" onClick={() => onOpenSession(a.session ?? 'coach')}><Icon name="chat" size={12}/> Abrir sesión</button></div>}
      </>);
    }
    const t = sel ? m.tasks.find((x) => x.id === sel) : null;
    if (!t)
        return null;
    const a = m.agents.find((x) => x.id === t.agent) ?? NONE;
    const miss = t.deps.map((d) => m.tasks.find((x) => x.id === d)).filter((d): d is FTask => !!d && d.status !== 'done');
    const runs = m.runs.filter((r) => r.task === t.id).sort((x, y) => y.at - x.at);
    const last = runs.find((run) => run.event !== 'compactar' && run.event !== 'intervención');
    const decision = m.decisions?.[t.id];
    const maxScore = decision ? Math.max(1, ...decision.scores.map(([, score]) => score)) : 1;
    const blocked = !!t.real && (t.real.waitingFor.length > 0 || !['backlog', 'ready', 'blocked', 'failed'].includes(t.real.status));
    return (<>
      <div className="sec">
        <div className="row" style={{ marginBottom: 6 }}><StDot st={ST2AG[t.status]} h={a.h} s={14}/><span className="mono mut2">{t.num != null ? `#${t.num}` : t.id}</span><span className={`chip s-${t.status}`}>{t.label}</span><span className="grow"/><button className="tbtn" onClick={() => onSel(null)} aria-label="Quitar selección"><Icon name="close" size={13}/></button></div>
        <h3>{t.title}</h3>
        {a.session != null && <DelegatedReport session={sessions.find((s) => s.id === a.session)} outcome={runs[0]?.outcome} />}
        {t.goal && <p className="mut2" style={{ margin: '4px 0 0', lineHeight: 1.5 }}>{t.goal}</p>}
        <div className="col" style={{ marginTop: 10, gap: 8 }}>
          {t.status === 'waiting' && <div className="perm compact"><div className="row"><Icon name="lock" size={14}/><b>Falta un permiso</b></div><div className="row">{a.session != null || a.id === 'pm' ? <button className="btn sm warn" onClick={() => onOpenSession(a.session ?? 'coach')}>Ver la petición</button> : <span className="mut2">Ábrela desde la sesión de la tarea.</span>}</div></div>}
          {miss.length > 0 && <div className="why"><b>Espera a {miss.map((d, i) => <span key={d.id}>{i ? ' y ' : ''}<button className="lnk" onClick={() => onSel(d.id)}>{d.num != null ? `#${d.num}` : d.id}</button></span>)}</b>
            <div className="col" style={{ gap: 3, marginTop: 6 }}>{miss.map((d) => <span key={d.id} className="row"><StDot st={ST2AG[d.status]} s={11}/><span>{d.title} · {d.label}</span></span>)}</div></div>}
          {m.demo ? <span className="simtag">demostración: acciones desactivadas</span> : t.real && (<div className="row wrap">
              <button className="btn sm" onClick={() => onEditTask(t.real!.id)}><Icon name="edit" size={12}/> Editar</button>
              {a.session != null && <button className="btn sm" onClick={() => onOpenSession(a.session!)}><Icon name="chat" size={12}/> Sesión</button>}
              <button className="btn sm" disabled={blocked} onClick={() => onAuto(t.real!)}><Icon name="agent" size={12}/> PM</button>
              <button className="btn sm ghost" disabled={blocked} onClick={() => onDirect('codex', t.real!.id)}>Codex</button>
              <button className="btn sm ghost" disabled={blocked} onClick={() => onDirect('claude', t.real!.id)}>Claude</button>
              <button className="btn sm ghost" disabled={blocked} onClick={() => onDirect('agy', t.real!.id)}>Antigravity</button>
              {(() => {
                const free = sessions.filter((s) => !t.real!.sessions.some((l) => l.id === s.id));
                return free.length > 0 && <select className="in flow-link" aria-label="Vincular una sesión abierta" value="" onChange={(e) => {
                        const id = Number(e.target.value);
                        if (id)
                            onLink(t.real!.id, id);
                    }}>
                  <option value="">Vincular sesión…</option>
                  {free.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.engine}</option>)}
                </select>;
            })()}
            </div>)}
        </div>
      </div>
      <div className="sec"><dl className="kv">
        <dt>Agente</dt><dd className="row"><AgDot a={a} s={12}/>{a.name}</dd>
        <dt>Dependencias</dt><dd className="row wrap">{t.deps.length ? t.deps.map((d) => <button key={d} className={`chip btnchip ${m.tasks.find((x) => x.id === d)?.status === 'done' ? 'mint' : ''}`} data-flow-anchor={`dep:${d}:${t.id}`} onClick={() => onSel(`dep:${d}:${t.id}`)}>{m.demo ? d : `#${d}`} · ver vínculo</button>) : '—'}</dd>
        <dt>Desbloquea</dt><dd className="row wrap">{m.tasks.filter((x) => x.deps.includes(t.id)).map((x) => <button key={x.id} className="chip btnchip" onClick={() => onSel(x.id)}>{x.num != null ? `#${x.num}` : x.id}</button>)}{!m.tasks.some((x) => x.deps.includes(t.id)) && '—'}</dd>
        {t.files && <><dt>Reparto</dt><dd className="mono">{t.files}</dd></>}
        <dt>Prioridad</dt><dd>{t.prio}</dd>
        {t.progress != null && <><dt>Avance</dt><dd className="row">
          <span className="dotnum">{t.progress}%</span>
          <span className="prog" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <i key={i} className={i < Math.round(t.progress! / 10) ? 'f' : undefined}/>)}</span>
        </dd></>}
        {t.real?.criteria && <><dt>Criterios</dt><dd>{t.real.criteria}</dd></>}
        {t.real && <><dt>Verificación</dt><dd>{t.real.verification}{t.real.tests ? ` · ${t.real.tests}` : ''}</dd></>}
      </dl></div>
      <div className="sec">
        <div className="row" style={{ marginBottom: 8 }}><Icon name="route" size={14}/><b>{last ? `Por qué ${last.model ?? last.provider}` : 'Decisión de Jev'}</b><span className="grow"/>{last?.complexity && <span className="chip">{last.complexity}</span>}</div>
        <div className="why">{last?.reason ?? (last ? 'Esta ejecución no registró motivo.' : 'Aún no se ha ejecutado: no hay decisión registrada.')}
          {last?.context && <div className="mut" style={{ marginTop: 6 }}>{last.context}</div>}
        </div>
        {decision && <div className="cands" aria-label="Candidatos del ejemplo">{decision.scores.map(([model, score]) => (<div key={model} className={`cand${last?.model === model ? ' pick' : ''}`}><span>{model}</span>
            <span className="barw" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} className={i < Math.round(score / maxScore * 12) ? 'f' : undefined}/>)}</span>
            <span className="mono">{score}</span>
          </div>))}</div>}
        {last && <dl className="kv" style={{ marginTop: 10 }}>
          {!decision && <><dt>Origen</dt><dd>{last.source ? ROUTING_SOURCE[last.source] : 'Sin registrar'}</dd></>}
          <dt>Confianza</dt><dd>{last.confidence != null ? `${Math.round(last.confidence * 100)}%` : '—'}</dd>
          {last.routerModel && <><dt>Modelo de Jev</dt><dd>{last.routerModel}</dd></>}
          {last.routerCost != null && <><dt>Coste de enrutamiento</dt><dd>{last.routerCost} USD</dd></>}
          {last.effort && <><dt>Esfuerzo</dt><dd>{last.effort}</dd></>}
          {(decision || last.cost != null) && <><dt>Coste</dt><dd>{decision?.cost ?? `${last.cost?.toLocaleString('es-ES', { maximumSignificantDigits: 3 })} USD`}</dd></>}
          {decision?.escalation && <><dt>Escalado</dt><dd>{decision.escalation}</dd></>}
        </dl>}
      </div>
      <div className="sec"><span className="lab">Historial</span>
        {runs.length ? <ol className="tev">{runs.slice(0, 8).map((r, i) => <li key={i}><span className="mono mut2">{new Date(r.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</span><span>{r.provider}{r.model ? ` · ${r.model}` : ''} · {r.outcome}{r.tokens ? ` · ${r.tokens.toLocaleString('es-ES')} tokens` : ''}</span></li>)}</ol>
            : <p className="mut2" style={{ margin: '6px 0 0' }}>Sin ejecuciones.</p>}
      </div>
    </>);
}
function ExactPrompt({ prompt }: {
    prompt: string | null | undefined;
}) {
    const [status, setStatus] = useState('');
    useEffect(() => setStatus(''), [prompt]);
    return <section><b>Prompt exacto</b>{prompt == null ? <p className="mut2">No registrado en este historial.</p> : <><pre className="flow-exact">{prompt}</pre><button className="btn sm" onClick={() => { void navigator.clipboard.writeText(prompt).then(() => setStatus('Copiado'), (e) => setStatus(String(e))); }}>Copiar prompt</button><span role="status">{status}</span></>}</section>;
}
function RunDetail({ run, onTask, onClose }: {
    run?: FRun;
    onTask: (id: string) => void;
    onClose: () => void;
}) {
    if (!run)
        return <div className="sec">Ejecución no disponible<button onClick={onClose}>Cerrar</button></div>;
    return <div className="sec"><div className="row"><h3>Ejecución #{run.id}</h3><button className="btn sm" onClick={onClose}>Cerrar</button></div><button className="lnk" onClick={() => onTask(run.task)}>Tarea #{run.task}</button><dl className="kv"><dt>Fecha</dt><dd>{new Date(run.at).toLocaleString()}</dd><dt>Estado</dt><dd>{run.outcome}</dd><dt>Modelo</dt><dd>{run.model ?? run.provider}</dd><dt>Intento</dt><dd>{run.raw.attempt ?? 'No registrado'}</dd><dt>Duración</dt><dd>{run.duration == null ? 'No registrada' : `${run.duration} ms`}</dd><dt>Origen</dt><dd>{run.source ? ROUTING_SOURCE[run.source] : 'No registrado'}</dd><dt>Decisión</dt><dd>{run.reason ?? 'No registrada'}</dd><dt>Contexto</dt><dd>{run.context ?? 'No registrado'}</dd><dt>Skills</dt><dd>No registradas en este contrato</dd><dt>Permisos pendientes</dt><dd>{run.raw.waitingPermissions ?? 'No registrados'}</dd></dl><ExactPrompt prompt={run.raw.prompt}/><b>Resultado / evidencia / error del proveedor</b><pre className="flow-exact">{run.raw.result ?? 'No registrado'}</pre><b>Error registrado</b><pre className="flow-exact">{run.raw.error ?? 'No registrado'}</pre></div>;
}
function Route({ m, sel, onSel }: {
    m: FModel | null;
    sel: string | null;
    onSel: (id: string) => void;
}) {
    const [category, setCategory] = useState('all'), [task, setTask] = useState('all'), [agent, setAgent] = useState('all');
    const runs = (m?.runs ?? []).filter((r) => task === 'all' || r.task === task).filter((r) => agent === 'all' || m?.tasks.find((t) => t.id === r.task)?.agent === agent).filter((r) => category === 'all' || (category === 'jev' ? r.source === 'jev' || r.source === 'shadow' : ['failed', 'error', 'interrupted'].includes(r.outcome))).sort((a, b) => b.at - a.at);
    return <section className="flow-activity" aria-label="Actividad histórica"><header className="row"><b>Actividad</b><span>{runs.length} ejecuciones</span><span className="grow"/><select className="in" aria-label="Filtrar actividad por tarea" value={task} onChange={(e) => setTask(e.target.value)}><option value="all">Todas las tareas</option>{m?.tasks.map((t) => <option key={t.id} value={t.id}>#{t.id} {t.title}</option>)}</select><select className="in" aria-label="Filtrar actividad por agente" value={agent} onChange={(e) => setAgent(e.target.value)}><option value="all">Todos los agentes</option>{m?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select><select className="in" aria-label="Categoría de actividad" value={category} onChange={(e) => setCategory(e.target.value)}><option value="all">Ejecuciones</option><option value="jev">Decisiones Jev</option><option value="error">Errores e interrupciones</option></select></header><div className="scr"><ol>{runs.map((r) => <li key={r.id}><button className={`flow-event ${sel === `run:${r.id}` ? 'on' : ''}`} data-flow-anchor={`run:${r.id}`} onClick={() => onSel(`run:${r.id}`)}><time>{new Date(r.at).toLocaleString()}</time><span>#{r.task} · {r.model ?? r.provider}</span><span>{r.outcome}</span><span>{r.reason ?? 'Sin decisión registrada'}</span></button></li>)}</ol>{!runs.length && <p className="mut2">Sin ejecuciones registradas para estos filtros.</p>}<p className="mut2 flow-history-note">Historial disponible: hasta 30 turnos por tarea. Eventos de Entrega y skills: no disponibles en este contrato.</p></div></section>;
}
function DependencyDetail({ m, id, onSel }: {
    m: FModel;
    id: string;
    onSel: (id: string | null) => void;
}) { const [, from, to] = id.split(':'); const a = m.tasks.find((t) => t.id === from), b = m.tasks.find((t) => t.id === to); return <div className="sec"><div className="row"><h3>Dependencia registrada</h3><button className="btn sm" onClick={() => onSel(null)}>Cerrar</button></div><p>La tarea #{to} depende de #{from}.</p><button className="lnk" onClick={() => onSel(from)}>#{from} · {a?.title ?? 'Fuera del plan seleccionado'}</button><p>{a?.label ?? 'Estado no disponible'}</p><button className="lnk" onClick={() => onSel(to)}>#{to} · {b?.title}</button><p>{b?.real?.waitingFor.includes(Number(from)) ? 'El backend registra esta dependencia como pendiente.' : 'El backend no registra este vínculo como espera pendiente.'}</p></div>; }

function DelegatedReport({ session, outcome }: { session: Session | undefined; outcome?: string }) {
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    let active = true;
    sessionApi.result(session.id).then((text) => { if (active) setResult(text); }, () => { if (active) setResult(null); });
    return () => { active = false; };
  }, [session?.id, outcome]);
  if (!session) return null;
  return <div className="col" style={{ gap: 5, marginTop: 8 }}>
    {session.task && <details><summary>Encargo delegado</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{session.task}</pre></details>}
    {result && <details><summary>Último informe registrado</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{result}</pre></details>}
  </div>;
}
