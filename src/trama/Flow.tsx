import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tasks as taskApi, type Session, type Task, type TaskRun } from '../ipc';
import { PRIORITY as PRIO, STATUS } from '../Tasks';
const PRIORITY = PRIO as Record<string, string>;
import { useUi } from '../ui';
import { createGraph, escapeXml, type GEdge, type GNode, type GraphHandle } from './graph';
import { Icon } from './icons';
import { Empty, ErrorNote, Seg } from './ui';

// Flow: supervisión de tareas reales del proyecto. Las tres lentes leen los
// mismos datos (tasks_list, task_runs y la actividad de las sesiones); no se
// muestran progresos ni porcentajes que el núcleo no proporciona.
type Lens = 'ejecucion' | 'dependencias' | 'lista';
type Phase = 'pendiente' | 'marcha' | 'revision' | 'bloqueo' | 'hecha';
const PHASES: { id: Phase; label: string; status: string[] }[] = [
  { id: 'pendiente', label: 'Pendiente', status: ['backlog', 'ready'] },
  { id: 'marcha', label: 'En marcha', status: ['running', 'waiting_approval', 'verifying'] },
  { id: 'revision', label: 'Revisión', status: ['review', 'ready_to_merge'] },
  { id: 'bloqueo', label: 'Bloqueada', status: ['blocked', 'failed', 'paused_quota'] },
  { id: 'hecha', label: 'Hecha', status: ['done', 'cancelled'] },
];
const phaseOf = (s: string): Phase => PHASES.find((p) => p.status.includes(s))?.id ?? 'pendiente';
const W = 232, H = 58;

type State = 'working' | 'waiting' | 'blocked' | 'done' | 'idle';

export default function Flow({ project, projectName, agentSessions, onOpenSession, onEditTask, onAuto, onDirect }: {
  project: string | null;
  projectName: string | null;
  agentSessions: Session[];
  onOpenSession: (id: number) => void;
  onEditTask: (id: number) => void;
  onAuto: (task: Task) => void;
  onDirect: (engine: string, task: number) => void;
}) {
  const { activity } = useUi();
  const [lens, setLensState] = useState<Lens>(() => {
    try { const v = localStorage.getItem('filigranas.flow.lente'); return v === 'dependencias' || v === 'lista' ? v : 'ejecucion'; } catch { return 'ejecucion'; }
  });
  const setLens = (l: Lens) => { setLensState(l); try { localStorage.setItem('filigranas.flow.lente', l); } catch { /* */ } };
  const [list, setList] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [hideDone, setHideDone] = useState(false);

  const load = useCallback(() => {
    if (!project) return;
    taskApi.list(project).then((t) => { setList(t); setError(null); }).catch((e) => setError(String(e)));
  }, [project]);
  useEffect(() => {
    setList(null); setSelected(null); load();
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  const stateOf = useCallback((t: Task): State => {
    const live = t.sessions.filter((s) => !s.closed).map((s) => activity[String(s.id)]);
    if (live.includes('permiso') || t.status === 'waiting_approval') return 'waiting';
    if (live.includes('trabajando') || t.status === 'running' || t.status === 'verifying') return 'working';
    if (t.status === 'blocked' || t.status === 'failed' || t.status === 'paused_quota' || t.waitingFor.length) return 'blocked';
    if (t.status === 'done' || t.status === 'cancelled') return 'done';
    return 'idle';
  }, [activity]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter((t) => (!hideDone || phaseOf(t.status) !== 'hecha') && (!q || `#${t.id} ${t.title} ${t.goal}`.toLowerCase().includes(q)));
  }, [list, query, hideDone]);
  const task = list?.find((t) => t.id === selected) ?? null;
  const counts = useMemo(() => {
    const c = { working: 0, waiting: 0, blocked: 0, done: 0, idle: 0 };
    for (const t of list ?? []) c[stateOf(t)]++;
    return c;
  }, [list, stateOf]);

  if (!project) {
    return <section className="tr-dest" aria-label="Flow"><Empty icon="flow" title="Elige un proyecto">Flow supervisa las tareas del proyecto abierto en el Workspace.</Empty></section>;
  }
  return (
    <section className="tr-dest tr-flow" aria-label="Flow">
      <header className="tr-head">
        <div>
          <h1>Flow</h1>
          <div className="sub">{projectName} · {list ? `${list.length} tareas` : 'cargando…'}</div>
        </div>
        <div className="flow-sum" aria-label="Resumen">
          <span className="tr-chip sky"><span className="dot is-trabajando" /> {counts.working} en marcha</span>
          <span className="tr-chip amber">{counts.waiting} esperan permiso</span>
          <span className="tr-chip coral">{counts.blocked} bloqueadas</span>
          <span className="tr-chip mint">{counts.done} hechas</span>
        </div>
        <span className="grow" />
        <input type="search" className="tr-input flow-q" placeholder="Filtrar tareas" value={query} onChange={(e) => setQuery(e.currentTarget.value)} aria-label="Filtrar tareas" />
        <button className={`tr-btn sm${hideDone ? ' on' : ''}`} aria-pressed={hideDone} onClick={() => setHideDone(!hideDone)}>Ocultar hechas</button>
        <Seg label="Lente" value={lens} onChange={setLens} items={[{ id: 'ejecucion', label: 'Ejecución', icon: 'lanes' }, { id: 'dependencias', label: 'Dependencias', icon: 'graph' }, { id: 'lista', label: 'Lista', icon: 'list' }]} />
      </header>
      {error && <div style={{ padding: '10px 18px 0' }}><ErrorNote error={error} onRetry={load} /></div>}
      <div className={`tr-split${task ? '' : ' no-insp'}`}>
        <div className="flow-main">
          {list === null && !error ? <div className="tr-loading"><div className="tr-skel" style={{ height: 120 }} /></div>
            : list && list.length === 0 ? <Empty icon="tasks" title="Sin tareas" action={<button className="tr-btn" onClick={() => onEditTask(0)}><Icon name="plus" size={13} /> Crear tarea</button>}>El project manager o tú podéis crear tareas; aquí verás su ejecución y dependencias.</Empty>
            : lens === 'lista' ? <FlowList tasks={visible} selected={selected} onSelect={setSelected} stateOf={stateOf} />
            : <FlowGraph lens={lens} tasks={visible} all={list ?? []} selected={selected} onSelect={setSelected} stateOf={stateOf} onOpen={(id) => onEditTask(id)} />}
        </div>
        {task && (
          <Inspector key={task.id} project={project} task={task} all={list ?? []} state={stateOf(task)} agentSessions={agentSessions}
            onClose={() => setSelected(null)} onSelect={setSelected} onOpenSession={onOpenSession} onEditTask={onEditTask} onAuto={onAuto} onDirect={onDirect} />
        )}
      </div>
    </section>
  );
}

function nodeSvg(t: Task, state: State) {
  const title = t.title.length > 28 ? `${t.title.slice(0, 27)}…` : t.title;
  const live = t.sessions.filter((s) => !s.closed);
  const who = live.length ? live.map((s) => s.engine).join(' · ') : '';
  const color = { working: '#9db6ff', waiting: '#ffb25e', blocked: '#ff6b5d', done: '#6fe0b3', idle: '#5c6168' }[state];
  return `<rect class="gcard" x="${-W / 2}" y="${-H / 2}" width="${W}" height="${H}" rx="10"/>
<circle class="ring" cx="${-W / 2 + 16}" cy="-8" r="4.2" fill="${color}" ${state === 'idle' ? 'fill-opacity=".6"' : ''}/>
${state === 'waiting' ? `<circle cx="${-W / 2 + 16}" cy="-8" r="7.5" fill="none" stroke="${color}" stroke-opacity=".45"/>` : ''}
<text class="gt" x="${-W / 2 + 28}" y="-4">${escapeXml(title)}</text>
<text class="gs" x="${-W / 2 + 28}" y="14">#${t.id} · ${escapeXml(STATUS[t.status] ?? t.status)}${who ? ` · ${escapeXml(who)}` : ''}</text>
${(t.priority === 'high' || t.priority === 'urgent') ? `<path d="M${W / 2 - 16},-${H / 2 - 9}l4,7h-8z" fill="#ffb25e" fill-opacity=".85"/>` : ''}`;
}

function layout(lens: Lens, tasks: Task[]) {
  const nodes: GNode[] = [];
  let under = '';
  if (lens === 'ejecucion') {
    const colW = W + 48;
    PHASES.forEach((p, i) => {
      const items = tasks.filter((t) => phaseOf(t.status) === p.id).sort((a, b) => b.updatedAt - a.updatedAt);
      const x = i * colW;
      under += `<rect class="lane" x="${x - colW / 2 + 8}" y="-46" width="${colW - 16}" height="${Math.max(3, items.length) * (H + 14) + 70}" rx="14"/><text class="lanet" x="${x - colW / 2 + 22}" y="-22">${p.label} · ${items.length}</text>`;
      items.forEach((t, j) => nodes.push({ id: String(t.id), x, y: 16 + j * (H + 14), w: W, h: H, aria: `#${t.id} ${t.title}` }));
    });
  } else {
    const ids = new Set(tasks.map((t) => t.id));
    const depth = new Map<number, number>();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const d = (id: number, seen = new Set<number>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const deps = (byId.get(id)?.dependencies ?? []).filter((x) => ids.has(x));
      const v = deps.length ? Math.max(...deps.map((x) => d(x, seen) + 1)) : 0;
      depth.set(id, v);
      return v;
    };
    tasks.forEach((t) => d(t.id));
    const cols = new Map<number, Task[]>();
    tasks.forEach((t) => { const k = depth.get(t.id)!; cols.set(k, [...(cols.get(k) ?? []), t]); });
    for (const [k, col] of cols) {
      col.sort((a, b) => a.id - b.id).forEach((t, j) => nodes.push({ id: String(t.id), x: k * (W + 80), y: (j - (col.length - 1) / 2) * (H + 26), w: W, h: H, aria: `#${t.id} ${t.title}` }));
    }
  }
  return { nodes, under: () => under };
}

function edges(tasks: Task[], all: Task[]): GEdge[] {
  const shown = new Set(tasks.map((t) => String(t.id)));
  const out: GEdge[] = [];
  for (const t of tasks) for (const dep of t.dependencies) {
    if (!shown.has(String(dep))) continue;
    const src = all.find((x) => x.id === dep);
    const done = src?.status === 'done';
    const waiting = t.waitingFor.includes(dep);
    const exec = src && (src.status === 'running' || src.status === 'verifying');
    out.push({ from: String(dep), to: String(t.id), cls: done ? 'e-done' : exec ? 'e-exec' : waiting ? (t.status === 'blocked' ? 'e-block' : 'e-wait') : 'e-dep', marker: done ? 'done' : 'dep' });
  }
  for (const t of tasks) if (t.parentId && shown.has(String(t.parentId))) out.push({ from: String(t.parentId), to: String(t.id), cls: 'e-parent' });
  return out;
}

function FlowGraph({ lens, tasks, all, selected, onSelect, stateOf, onOpen }: {
  lens: Lens; tasks: Task[]; all: Task[]; selected: number | null; onSelect: (id: number | null) => void; stateOf: (t: Task) => State; onOpen: (id: number) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const graph = useRef<GraphHandle | null>(null);
  const cb = useRef({ onSelect, onOpen });
  cb.current = { onSelect, onOpen };
  const byId = useMemo(() => new Map(tasks.map((t) => [String(t.id), t])), [tasks]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const stateRef = useRef(stateOf);
  stateRef.current = stateOf;

  useEffect(() => {
    const { nodes, under } = layout(lens, tasks);
    const e = edges(tasks, all);
    const node = (n: GNode) => { const t = byIdRef.current.get(n.id)!; return t ? nodeSvg(t, stateRef.current(t)) : ''; };
    const decorate = (list: GNode[]) => list.map((n) => { const t = byId.get(n.id)!; return { ...n, cls: `s-${stateOf(t)}` }; });
    if (!graph.current) {
      graph.current = createGraph(svg.current!, {
        nodes: decorate(nodes), edges: e, node, under, label: lens === 'ejecucion' ? 'Ejecución de tareas' : 'Dependencias entre tareas',
        selected: selected == null ? null : String(selected), pad: [60, 40, 40, 40],
        onSelect: (id) => cb.current.onSelect(id == null ? null : Number(id)),
        onOpen: (id) => cb.current.onOpen(Number(id)),
        onKey: (key, sel) => {
          const list = graph.current!.nodes;
          const cur = list.find((n) => n.id === sel) ?? list[0];
          if (!cur) return null;
          const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
          if (!dir) return null;
          let best: GNode | null = null, bd = 1e9;
          for (const n of list) {
            if (n.id === cur.id) continue;
            const dx = n.x - cur.x, dy = n.y - cur.y;
            if (dir[0] && Math.sign(dx) !== dir[0]) continue;
            if (dir[1] && Math.sign(dy) !== dir[1]) continue;
            const dist = Math.abs(dx) + Math.abs(dy) * (dir[0] ? 3 : 0.5) + Math.abs(dx) * (dir[1] ? 3 : 0);
            if (dist < bd) { bd = dist; best = n; }
          }
          return best?.id ?? (sel ? null : cur.id);
        },
      });
    } else {
      graph.current.morph(decorate(nodes), e, under);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens, tasks.map((t) => `${t.id}:${t.status}:${t.dependencies.join(',')}`).join('|')]);

  // cambios de estado sin cambio de disposición: solo se redibujan los nodos
  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    for (const n of g.nodes) { const t = byId.get(n.id); if (t) { n.cls = `s-${stateOf(t)}`; g.update(n.id); } }
  }, [byId, stateOf]);
  useEffect(() => {
    const g = graph.current;
    if (g && g.selected !== (selected == null ? null : String(selected))) g.select(selected == null ? null : String(selected), true);
  }, [selected]);
  useEffect(() => {
    const el = svg.current!;
    let t = 0;
    const ro = new ResizeObserver(() => { window.clearTimeout(t); t = window.setTimeout(() => graph.current?.fit(true), 120); });
    ro.observe(el);
    return () => { ro.disconnect(); window.clearTimeout(t); graph.current?.destroy(); graph.current = null; };
  }, []);

  return (
    <div className="flow-graph">
      <svg ref={svg} className="tr-graph" />
      <div className="tr-zoom">
        <button className="tr-btn sm icon ghost" onClick={() => graph.current?.zoom(1.2)} aria-label="Acercar"><Icon name="zin" size={14} /></button>
        <button className="tr-btn sm icon ghost" onClick={() => graph.current?.zoom(0.83)} aria-label="Alejar"><Icon name="zout" size={14} /></button>
        <button className="tr-btn sm icon ghost" onClick={() => graph.current?.fit(true)} aria-label="Encajar"><Icon name="fit" size={14} /></button>
      </div>
      <div className="tr-legend" aria-label="Leyenda">
        <span><i style={{ color: 'rgb(220 226 236 / .5)' }} />depende de</span>
        <span><i style={{ color: '#6fe0b3' }} />dependencia hecha</span>
        <span><i style={{ color: '#9db6ff', borderTopStyle: 'dashed' }} />en ejecución</span>
        <span><i style={{ color: '#ffb25e', borderTopStyle: 'dashed' }} />espera</span>
        <span><i style={{ color: '#ff6b5d', borderTopStyle: 'dotted' }} />bloquea</span>
      </div>
    </div>
  );
}

function FlowList({ tasks, selected, onSelect, stateOf }: { tasks: Task[]; selected: number | null; onSelect: (id: number) => void; stateOf: (t: Task) => State }) {
  return (
    <div className="tr-body">
      <table className="flow-table">
        <thead><tr><th>Tarea</th><th>Estado</th><th>Prioridad</th><th>Depende de</th><th>Sesiones</th><th>Actualizada</th></tr></thead>
        <tbody>
          {PHASES.flatMap((p) => tasks.filter((t) => phaseOf(t.status) === p.id).map((t) => {
            const st = stateOf(t);
            return (
              <tr key={t.id} aria-selected={selected === t.id} tabIndex={0} onClick={() => onSelect(t.id)} onKeyDown={(e) => e.key === 'Enter' && onSelect(t.id)}>
                <td><span className={`dot${st === 'working' ? ' is-trabajando' : st === 'waiting' ? ' is-permiso' : ''}`} style={{ marginRight: 8 }} /><span className="mono mut">#{t.id}</span> {t.title}</td>
                <td><span className={`tr-chip ${{ working: 'sky', waiting: 'amber', blocked: 'coral', done: 'mint', idle: '' }[st]}`}>{STATUS[t.status] ?? t.status}</span></td>
                <td className="mut">{PRIORITY[t.priority] ?? t.priority}</td>
                <td className="mono mut">{t.dependencies.length ? t.dependencies.map((d) => `#${d}`).join(' ') : '—'}</td>
                <td className="mut">{t.sessions.filter((s) => !s.closed).map((s) => s.name).join(', ') || '—'}</td>
                <td className="mono mut">{new Date(t.updatedAt < 1e12 ? t.updatedAt * 1000 : t.updatedAt).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              </tr>
            );
          }))}
        </tbody>
      </table>
    </div>
  );
}

function Inspector({ project, task, all, state, agentSessions, onClose, onSelect, onOpenSession, onEditTask, onAuto, onDirect }: {
  project: string; task: Task; all: Task[]; state: State; agentSessions: Session[];
  onClose: () => void; onSelect: (id: number) => void; onOpenSession: (id: number) => void; onEditTask: (id: number) => void; onAuto: (t: Task) => void; onDirect: (engine: string, task: number) => void;
}) {
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    taskApi.runs(project, task.id).then((r) => alive && setRuns(r)).catch((e) => alive && setRunError(String(e)));
    return () => { alive = false; };
  }, [project, task.id, task.updatedAt]);
  const blocked = task.waitingFor.length > 0;
  const dependents = all.filter((t) => t.dependencies.includes(task.id));
  const tone = { working: 'sky', waiting: 'amber', blocked: 'coral', done: 'mint', idle: '' }[state];
  const sec = (ms: number) => ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
  return (
    <aside className="tr-insp" aria-label={`Tarea #${task.id}`}>
      <div className="sec">
        <div className="tr-row" style={{ justifyContent: 'space-between' }}>
          <span className={`tr-chip ${tone}`}>{STATUS[task.status] ?? task.status}</span>
          <button className="tr-btn sm icon ghost" onClick={onClose} aria-label="Cerrar inspector"><Icon name="close" size={13} /></button>
        </div>
        <h3 style={{ marginTop: 10 }}><span className="mono mut">#{task.id}</span> {task.title}</h3>
        {task.goal && <p className="mut" style={{ margin: '6px 0 0', lineHeight: 1.5 }}>{task.goal}</p>}
      </div>
      <div className="sec tr-col">
        <div className="tr-row tr-wrap">
          <button className="tr-btn sm" onClick={() => onEditTask(task.id)}><Icon name="edit" size={13} /> Editar</button>
          <button className="tr-btn sm" disabled={blocked} onClick={() => onAuto(task)} title={blocked ? 'Tiene dependencias pendientes' : undefined}><Icon name="pm" size={13} /> Hablar con el PM</button>
          <button className="tr-btn sm" disabled={blocked} onClick={() => onDirect('codex', task.id)}>Chat Codex</button>
          <button className="tr-btn sm" disabled={blocked} onClick={() => onDirect('claude', task.id)}>Chat Claude</button>
        </div>
      </div>
      <div className="sec">
        <div className="tr-lab">Datos</div>
        <dl className="tr-kv">
          <dt>Prioridad</dt><dd>{PRIORITY[task.priority] ?? task.priority}</dd>
          <dt>Riesgo</dt><dd>{task.risk}</dd>
          <dt>Verificación</dt><dd>{task.verification}{task.tests ? ` · ${task.tests}` : ''}</dd>
          {task.criteria && <><dt>Criterios</dt><dd>{task.criteria}</dd></>}
        </dl>
      </div>
      <div className="sec">
        <div className="tr-lab">Dependencias</div>
        {task.dependencies.length === 0 && dependents.length === 0 ? <p className="mut" style={{ margin: 0 }}>Ninguna.</p> : (
          <ul className="tr-list">
            {task.dependencies.map((d) => { const t = all.find((x) => x.id === d); return (
              <li key={`d${d}`}><button className="tr-li" onClick={() => onSelect(d)}>
                <Icon name={task.waitingFor.includes(d) ? 'lock' : 'check'} size={12} /><span className="t">depende de #{d} {t?.title ?? ''}</span><span className="meta">{t ? STATUS[t.status] : ''}</span>
              </button></li>); })}
            {dependents.map((t) => (
              <li key={`r${t.id}`}><button className="tr-li" onClick={() => onSelect(t.id)}><Icon name="chev" size={12} /><span className="t">desbloquea #{t.id} {t.title}</span><span className="meta">{STATUS[t.status]}</span></button></li>
            ))}
          </ul>
        )}
      </div>
      <div className="sec">
        <div className="tr-lab">Sesiones</div>
        {task.sessions.length === 0 ? <p className="mut" style={{ margin: 0 }}>Sin sesiones vinculadas.</p> : (
          <ul className="tr-list">
            {task.sessions.map((s) => {
              const open = !s.closed && agentSessions.some((x) => x.id === s.id);
              return (
                <li key={s.id}>
                  <button className="tr-li" disabled={!open} onClick={() => onOpenSession(s.id)} title={open ? 'Abrir en el Workspace' : 'Sesión cerrada'}>
                    <Icon name="chat" size={12} /><span className="t">{s.name} · {s.engine}</span><span className="meta">{s.branch ?? (s.closed ? 'cerrada' : '')}</span>
                  </button>
                  {s.github?.pulls.map((p) => <div key={p.number} className="mut mono" style={{ fontSize: 11, padding: '0 10px 4px 32px' }}>PR #{p.number} · {p.state}</div>)}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="sec">
        <div className="tr-lab">Ejecuciones y decisiones de Jev</div>
        {runError ? <ErrorNote error={runError} /> : runs === null ? <div className="tr-skel" /> : runs.length === 0 ? <p className="mut" style={{ margin: 0 }}>Aún no se ha ejecutado.</p> : (
          <div className="tr-col">
            {runs.map((r) => (
              <div key={r.id} className="flow-run">
                <div className="tr-row"><b>{r.provider}</b><span className="mono mut">{r.model ?? ''}</span><span className="grow" /><span className={`tr-chip ${r.outcome === 'running' ? 'sky' : r.outcome === 'done' || r.outcome === 'ok' ? 'mint' : r.outcome === 'failed' ? 'coral' : ''}`}>{r.outcome}</span></div>
                <div className="mono mut" style={{ fontSize: 11 }}>
                  {new Date(r.startedMs).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {r.durationMs != null && ` · ${sec(r.durationMs)}`}
                  {r.inputTokens != null && ` · ${r.inputTokens.toLocaleString('es-ES')} entrada`}
                  {r.outputTokens != null && ` · ${r.outputTokens.toLocaleString('es-ES')} salida`}
                  {r.costEstimateUsd != null && ` · ~${r.costEstimateUsd.toFixed(2)} US$`}
                  {r.retry && ' · reintento'}
                </div>
                {r.routing && (
                  <div className="flow-jev">
                    <span className="tr-chip violet"><Icon name="route" size={11} /> {r.routing.source === 'jev' ? 'Jev' : r.routing.source === 'shadow' ? 'Jev (sombra)' : 'local'}</span>
                    {r.routing.effort && <span className="tr-chip">esfuerzo {r.routing.effort}</span>}
                    {r.routing.complexity && <span className="tr-chip">complejidad {r.routing.complexity}</span>}
                    {r.routing.confidence != null && <span className="tr-chip">confianza {r.routing.confidence.toFixed(2)}</span>}
                    {r.routing.reason && <p>{r.routing.reason}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
