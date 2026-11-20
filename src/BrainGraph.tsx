import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { brain, pr, type BrainEdge, type BrainGraphData, type BrainNodeKind, type Project } from './ipc';

import BrainNetwork, { projectColor } from './BrainNetwork';

const LABEL: Record<BrainNodeKind, string> = {
  decision: 'Decisión', preference: 'Preferencia', fact: 'Hecho', constraint: 'Restricción',
  evidence: 'Evidencia', outcome: 'Resultado', task: 'Tarea', pr: 'PR', project: 'Proyecto',
};
const RELATION: Record<BrainEdge['kind'], readonly [string, string]> = {
  project_member: ['Pertenece al proyecto', 'Contiene'],
  scope: ['Ámbito de tarea', 'Recuerdo de esta tarea'],
  task_source: ['Tarea fuente', 'Recuerdo basado en esta tarea'],
  run_source: ['Tarea del turno fuente', 'Recuerdo basado en un turno de esta tarea'],
  pull_source: ['PR fuente', 'Recuerdo basado en esta PR'],
  dependency: ['Depende de', 'Requisito de'],
  parent: ['Tarea padre', 'Subtarea'],
  pull: ['PR de la rama', 'Tarea vinculada por la rama'],
};

function dateBoundary(value: string, end = false) {
  if (!value) return null;
  const stamp = new Date(`${value}T00:00:00`);
  if (end) stamp.setDate(stamp.getDate() + 1);
  return Math.floor(stamp.getTime() / 1000);
}

type Props = {
  projects: Project[];
  hidden: boolean;
  onMemories: (project: string | null) => void;
  onTask: (project: string, id: number) => void;
  onMemory: (project: string | null, id: number) => void;
};

export default function BrainGraph({ projects, hidden, onMemories, onTask, onMemory }: Props) {
  const [scope, setScope] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<BrainNodeKind | null>(null);
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [data, setData] = useState<BrainGraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [linkError, setLinkError] = useState('');
  const [change, setChange] = useState(0);
  const byKey = useMemo(() => new Map(data?.nodes.map((node) => [node.key, node])), [data]);
  const active = selected == null ? undefined : byKey.get(selected);
  const projectName = (path: string | null) => path == null ? 'Global' : projects.find(p => p.path === path)?.name ?? path.split('/').pop() ?? path;
  const validDates = !fromDay || !toDay || fromDay <= toDay;

  useEffect(() => {
    if (hidden) return;
    const refresh = () => setChange((version) => version + 1);
    const stop = listen('tasks-changed', refresh);
    return () => { void stop.then((off) => off()); };
  }, [hidden]);

  useEffect(() => {
    if (hidden) return;
    let current = true;
    setError('');
    setLinkError('');
    if (!validDates) {
      setLoading(false);
      setData(null);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const graph = await brain.graph({
          query: query.trim() || null, project: scope, kind,
          from: dateBoundary(fromDay), until: dateBoundary(toDay, true),
        });
        if (!current) return;
        setData(graph);
        setSelected(key => graph.nodes.some(node => node.key === key) ? key : null);
      } catch (e) {
        if (current) { setError(String(e)); setData(null); }
      } finally {
        if (current) setLoading(false);
      }
    }, 160);
    return () => { current = false; window.clearTimeout(timer); };
  }, [scope, kind, query, fromDay, toDay, validDates, change, hidden]);

  const select = (key: string) => { setSelected(key); setLinkError(''); };

  const links = active && data ? data.edges.flatMap((edge) => {
    const side = edge.from === active.key ? 0 : edge.to === active.key ? 1 : null;
    if (side == null) return [];
    const node = byKey.get(side === 0 ? edge.to : edge.from);
    return node ? [{ node, label: RELATION[edge.kind][side], key: `${edge.from}:${edge.kind}:${edge.to}` }] : [];
  }) : [];

  return <section className="coach" aria-label="Grafo de Filigranas Brain" hidden={hidden}>
    <div className="co-head brain-tabs">
      <button className="co-link is-active" aria-current="page">Grafo</button>
      <button className="co-link" onClick={() => onMemories(scope)}>Recuerdos</button>
    </div>
    <div className={`co-log p5-panel brain-graph${loading ? ' is-loading' : ''}`} aria-busy={loading}>
      <div className="p5-actions task-form">
        <label>Proyecto<select value={scope ?? ''} onChange={(e) => { setSelected(null); setScope(e.target.value || null); }}>
          <option value="">Todo Filigranas</option>
          {projects.map((item) => <option key={item.path} value={item.path}>{item.name}{item.archived ? ' · Archivado' : ''}</option>)}
        </select></label>
        <label>Buscar<input type="search" value={query} maxLength={300} placeholder="Explorar conocimiento…" onChange={e => setQuery(e.target.value)} /></label>
        <label>Tipo de nodo<select value={kind ?? ''} onChange={(e) => { setKind((e.target.value || null) as BrainNodeKind | null); }}>
          <option value="">Todos</option>
          {Object.entries(LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Desde<input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} /></label>
        <label>Hasta<input type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} /></label>
      </div>
      {!validDates && <p role="status">Elige una fecha final igual o posterior al inicio.</p>}
      {!!error && <p className="co-error" role="alert">{error}</p>}
      {loading && !data && validDates && !error && <p role="status" className="muted">Cargando relaciones…</p>}
      {!loading && data && !data.nodes.length && <p role="status" className="muted">Sin nodos para estos filtros.</p>}
      {validDates && data && data.nodes.length > 0 && <>
        <p className="muted brain-graph-caption">
          {data.nodes.filter((node) => node.matched).length} coincidencias · {data.edges.length} relaciones
          {data.limited ? ' · Acota los filtros para ver más resultados.' : ''}
          {data.nodes.some((node) => !node.matched) && ' · Los nodos relacionados mantienen sus vínculos visibles.'}
        </p>
        <div className="brain-legend" aria-label="Proyectos del grafo">{[...new Set(data.nodes.map(n => n.project))].map(path =>
          <span key={path ?? 'global'}><i style={{ background: projectColor(path) }} />{projectName(path)}</span>)}</div>
        <div className={`brain-graph-stage${active ? ' has-details' : ''}`}>
          <BrainNetwork data={data} selected={selected} onSelect={select} projectName={projectName} hidden={hidden} />
          {active && <section className="p5-section brain-graph-details" aria-label="Nodo seleccionado">
            <button className="co-btn brain-detail-close" onClick={() => select('')} aria-label="Cerrar detalle">×</button>
            <h2>{active.kind === 'project' ? projectName(active.project) : active.title}</h2>
            <p className="muted">{LABEL[active.kind]}{active.kind !== 'project' && ` · ${projectName(active.project)}`}{active.date > 0 && ` · ${active.kind === 'pr' ? 'Observado' : 'Actualizado'} ${new Date(active.date * 1000).toLocaleDateString()}`}</p>
            {active.body && <p className="task-text">{active.body}</p>}
            {active.source && <p className="task-text"><strong>Fuente</strong> · {active.source}</p>}
            <div className="p5-actions">
              {active.kind === 'project' && <button className="co-btn" onClick={() => setScope(active.project)}>Filtrar este proyecto</button>}
              {active.kind === 'task' && active.project && <button className="co-btn" onClick={() => onTask(active.project!, active.id)}>Abrir tarea</button>}
              {active.kind === 'pr' && active.url && <button className="co-btn"
                onClick={() => { const url = active.url; if (url) void pr.open(url).catch((e) => setLinkError(String(e))); }}>Abrir PR en GitHub</button>}
              {active.kind !== 'task' && active.kind !== 'pr' && active.kind !== 'project' && <button className="co-btn" onClick={() => onMemory(active.project, active.id)}>
                {active.kind === 'decision' ? 'Abrir decisión' : 'Abrir recuerdo'}
              </button>}
            </div>
            {!!linkError && <p className="co-error" role="alert">{linkError}</p>}
            {links.length > 0 && <ul aria-label="Relaciones del nodo">
              {links.map((item) => <li key={item.key}>{item.label} ·{' '}
                <button className="co-link" onClick={() => select(item.node.key)}>{item.node.kind === 'project' ? projectName(item.node.project) : item.node.title}</button>
              </li>)}
            </ul>}
          </section>}
        </div>
      </>}
    </div>
  </section>;
}
