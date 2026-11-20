import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { brain, pr, type BrainEdge, type BrainGraphData, type BrainNodeKind, type Project } from './ipc';

const LABEL: Record<BrainNodeKind, string> = {
  decision: 'Decisión', preference: 'Preferencia', fact: 'Hecho', constraint: 'Restricción',
  evidence: 'Evidencia', outcome: 'Resultado', task: 'Tarea', pr: 'PR',
};
const RELATION: Record<BrainEdge['kind'], readonly [string, string]> = {
  scope: ['Ámbito de tarea', 'Recuerdo de esta tarea'],
  task_source: ['Tarea fuente', 'Recuerdo basado en esta tarea'],
  run_source: ['Tarea del turno fuente', 'Recuerdo basado en un turno de esta tarea'],
  pull_source: ['PR fuente', 'Recuerdo basado en esta PR'],
  dependency: ['Depende de', 'Requisito de'],
  parent: ['Tarea padre', 'Subtarea'],
  pull: ['PR de la rama', 'Tarea vinculada por la rama'],
};

const COLUMNS = ['Recuerdos', 'Tareas', 'Pull requests'];
const WIDTH = 720;
const COLUMN = 240;
const CARD = 184;
const ROW = 68;
const TOP = 38;
const LEFT = 28;

function column(kind: BrainNodeKind) {
  return kind === 'task' ? 1 : kind === 'pr' ? 2 : 0;
}

function dateBoundary(value: string, end = false) {
  if (!value) return null;
  const stamp = new Date(`${value}T00:00:00`);
  if (end) stamp.setDate(stamp.getDate() + 1);
  return Math.floor(stamp.getTime() / 1000);
}

function layout(nodes: BrainGraphData['nodes']) {
  const count = [0, 0, 0];
  const positions = new Map(nodes.map((node) => {
    const col = column(node.kind);
    return [node.key, { x: LEFT + COLUMN * col, y: TOP + ROW * count[col]++, col }];
  }));
  return { positions, height: TOP + ROW * Math.max(2, ...count) + 6 };
}

type Props = {
  project: string;
  projects: Project[];
  hidden: boolean;
  onMemories: () => void;
  onTask: (project: string, id: number) => void;
  onMemory: (project: string | null, id: number) => void;
};

export default function BrainGraph({ project, projects, hidden, onMemories, onTask, onMemory }: Props) {
  const [scope, setScope] = useState<string | null>(project);
  const [kind, setKind] = useState<BrainNodeKind | null>(null);
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [data, setData] = useState<BrainGraphData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [linkError, setLinkError] = useState('');
  const [change, setChange] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const byKey = useMemo(() => new Map(data?.nodes.map((node) => [node.key, node])), [data]);
  const active = selected == null ? undefined : byKey.get(selected);
  const display = useMemo(() => layout(data?.nodes ?? []), [data]);
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
    setData(null);
    setError('');
    setLinkError('');
    if (validDates) {
      brain.graph({ project: scope, kind, from: dateBoundary(fromDay), until: dateBoundary(toDay, true) }).then((graph) => {
        if (!current) return;
        setData(graph);
        setSelected((key) => graph.nodes.some((node) => node.key === key) ? key : graph.nodes[0]?.key ?? null);
      }, (e) => { if (current) setError(String(e)); });
    }
    return () => { current = false; };
  }, [scope, kind, fromDay, toDay, validDates, change, hidden]);

  useEffect(() => {
    const target = canvas.current;
    const ctx = target?.getContext('2d');
    if (!target || !ctx || !data) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    target.width = WIDTH * scale;
    target.height = display.height * scale;
    ctx.scale(scale, scale);
    const lanes = new Map<string, number>();
    for (const edge of data.edges) {
      const a = display.positions.get(edge.from);
      const b = display.positions.get(edge.to);
      if (!a || !b) continue;
      const pair = JSON.stringify([edge.from, edge.to].sort());
      const lane = lanes.get(pair) ?? 0;
      lanes.set(pair, lane + 1);
      const startY = a.y + 21 + lane * 5;
      const endY = b.y + 21 + lane * 5;
      const focused = edge.from === selected || edge.to === selected;
      ctx.lineWidth = focused ? 2 : 1;
      ctx.strokeStyle = focused ? '#84bbff' : 'rgba(133, 170, 219, .44)';
      ctx.setLineDash(edge.kind === 'dependency' || edge.kind === 'parent' ? [4, 3] : []);
      ctx.beginPath();
      if (a.col === b.col) {
        const x = a.x + CARD;
        ctx.moveTo(x, startY);
        ctx.bezierCurveTo(x + 25 + lane * 5, startY, x + 25 + lane * 5, endY, x, endY);
      } else {
        const forward = a.col < b.col;
        const x = forward ? a.x + CARD : a.x;
        const y = forward ? b.x : b.x + CARD;
        const middle = (x + y) / 2;
        ctx.moveTo(x, startY);
        ctx.bezierCurveTo(middle, startY, middle, endY, y, endY);
      }
      ctx.stroke();
    }
  }, [data, display, selected]);

  const select = (key: string, reveal = false) => {
    setSelected(key);
    setLinkError('');
    if (reveal) {
      buttons.current.get(key)?.focus({ preventScroll: true });
      buttons.current.get(key)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };

  const links = active && data ? data.edges.flatMap((edge) => {
    const side = edge.from === active.key ? 0 : edge.to === active.key ? 1 : null;
    if (side == null) return [];
    const node = byKey.get(side === 0 ? edge.to : edge.from);
    return node ? [{ node, label: RELATION[edge.kind][side], key: `${edge.from}:${edge.kind}:${edge.to}` }] : [];
  }) : [];

  return <section className="coach" aria-label="Grafo de Filigranas Brain" hidden={hidden}>
    <div className="co-head"><span className="push" />
      <button className="co-link" onClick={onMemories}>Recuerdos</button>
    </div>
    <div className="co-log p5-panel brain-graph">
      <div className="p5-actions task-form">
        <label>Proyecto<select value={scope ?? ''} onChange={(e) => { setData(null); setSelected(null); setScope(e.target.value || null); }}>
          <option value="">Memoria global</option>
          {projects.filter((item) => !item.archived).map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
        </select></label>
        <label>Tipo de nodo<select value={kind ?? ''} onChange={(e) => { if ((e.target.value || null) !== kind) setData(null); setKind((e.target.value || null) as BrainNodeKind | null); }}>
          <option value="">Todos</option>
          {Object.entries(LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Desde<input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} /></label>
        <label>Hasta<input type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} /></label>
      </div>
      {!validDates && <p role="status">Elige una fecha final igual o posterior al inicio.</p>}
      {!!error && <p className="co-error" role="alert">{error}</p>}
      {!data && validDates && !error && <p role="status" className="muted">Cargando relaciones…</p>}
      {data && !data.nodes.length && <p role="status" className="muted">Sin nodos para estos filtros.</p>}
      {data && data.nodes.length > 0 && <>
        <p className="muted brain-graph-caption">
          {data.nodes.filter((node) => node.matched).length} coincidencias · {data.edges.length} relaciones
          {data.limited ? ' · Acota los filtros para ver más resultados.' : ''}
          {data.nodes.some((node) => !node.matched) && ' · Los nodos relacionados mantienen sus vínculos visibles.'}
        </p>
        <div className="brain-graph-scroll" tabIndex={0} role="region" aria-label="Mapa de relaciones">
          <div className="brain-graph-map" style={{ width: WIDTH, height: display.height }}>
            <canvas ref={canvas} style={{ width: WIDTH, height: display.height }} aria-hidden="true" />
            {COLUMNS.map((title, col) => <div className="brain-graph-column" key={title} style={{ left: LEFT + col * COLUMN }}>{title}</div>)}
            {data.nodes.map((node) => {
              const point = display.positions.get(node.key)!;
              return <button type="button" className="brain-graph-node" key={node.key}
                data-kind={node.kind} data-related={!node.matched}
                aria-pressed={node.key === selected} onClick={() => select(node.key)}
                ref={(element) => { if (element) buttons.current.set(node.key, element); else buttons.current.delete(node.key); }}
                title={node.title} style={{ left: point.x, top: point.y, width: CARD }}>
                <span>{LABEL[node.kind]}{node.kind === 'task' ? ` #${node.id}` : ''}{!node.matched && ' · Relacionado'}</span>
                <strong>{node.title}</strong>
              </button>;
            })}
          </div>
        </div>
        {active && <section className="p5-section brain-graph-details" aria-label="Nodo seleccionado">
          <h2>{active.title}</h2>
          <p className="muted">{LABEL[active.kind]} · {active.kind === 'pr' ? 'Observado' : 'Actualizado'} {new Date(active.date * 1000).toLocaleDateString()}</p>
          <div className="p5-actions">
            {active.kind === 'task' && scope && <button className="co-btn" onClick={() => onTask(scope, active.id)}>Abrir tarea</button>}
            {active.kind === 'pr' && active.url && <button className="co-btn"
              onClick={() => { const url = active.url; if (url) void pr.open(url).catch((e) => setLinkError(String(e))); }}>Abrir PR en GitHub</button>}
            {active.kind !== 'task' && active.kind !== 'pr' && <button className="co-btn" onClick={() => onMemory(scope, active.id)}>
              {active.kind === 'decision' ? 'Abrir decisión' : 'Abrir recuerdo'}
            </button>}
          </div>
          {!!linkError && <p className="co-error" role="alert">{linkError}</p>}
          {links.length > 0 && <ul aria-label="Relaciones del nodo">
            {links.map((item) => <li key={item.key}>{item.label} ·{' '}
              <button className="co-link" onClick={() => select(item.node.key, true)}>{item.node.title}</button>
            </li>)}
          </ul>}
        </section>}
      </>}
    </div>
  </section>;
}
