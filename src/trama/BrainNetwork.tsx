import { useEffect, useMemo, useRef } from 'react';
import type { BrainEdge, BrainGraphData, BrainNodeKind } from '../ipc';
import { createGraph, escapeXml, type GraphHandle } from './graph';
import { Icon } from './icons';

type Node = BrainGraphData['nodes'][number];
const entity = { project: 'Proyecto', task: 'Tarea', pr: 'Pull request' } as const;
const relation: Record<BrainEdge['kind'], string> = {
  project_member: 'Proyecto', scope: 'Ámbito', task_source: 'Fuente', run_source: 'Turno de origen',
  pull_source: 'PR de origen', parent: 'Tarea padre o hija', dependency: 'Dependencia', pull: 'Pull request',
};

export function NetworkConnections({ data, selected, onSelect }: {
  data: BrainGraphData; selected: string; onSelect: (key: string) => void;
}) {
  const neighbors = data.edges.flatMap((edge) => {
    const key = edge.from === selected ? edge.to : edge.to === selected ? edge.from : null;
    const node = key && data.nodes.find((item) => item.key === key);
    return node ? [{ node, kind: edge.kind }] : [];
  });
  return <div className="sec">
    <h3>Conexiones</h3>
    {neighbors.length ? neighbors.map(({ node, kind }) => (
      <button key={`${node.key}:${kind}`} className="orow" onClick={() => onSelect(node.key)}>
        <Icon name={glyph[lane(node.kind)]} size={13} /><span className="grow">{node.title}</span><span className="mut2">{relation[kind]}</span>
      </button>
    )) : <p className="mut2">No hay conexiones en este filtro.</p>}
  </div>;
}

const glyph = { project: 'folder', task: 'flow', pr: 'review', memory: 'brain' } as const;
const lane = (kind: BrainNodeKind) => kind === 'project' ? 'project' : kind === 'task' ? 'task' : kind === 'pr' ? 'pr' : 'memory';

export const brainNetworkLabel = (kind: BrainNodeKind) => {
  const group = lane(kind);
  return group === 'memory' ? 'Recuerdo' : entity[group];
};

export function BrainNetwork({ data, selected, onSelect, onOpen }: {
  data: BrainGraphData; selected: string | null; onSelect: (key: string | null) => void; onOpen: (node: Node) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const handle = useRef<GraphHandle | null>(null);
  const callbacks = useRef({ onSelect, onOpen });
  callbacks.current = { onSelect, onOpen };
  const model = useMemo(() => {
    const projects = new Map<string | null, Node[]>();
    const makeNode = (node: Node, x: number, y: number) => ({ id: node.key, node, x, y, w: 160, h: 32,
      aria: `${brainNetworkLabel(node.kind)}: ${node.title}`, cls: node.matched ? '' : 'related' });
    for (const node of data.nodes) {
      const list = projects.get(node.project) ?? [];
      list.push(node);
      projects.set(node.project, list);
    }
    const groups = [...projects.values()];
    const total = Math.max(1, ...groups.map((group) => group.length));
    const step = 390 + Math.ceil(total / 8) * 150;
    const columns = Math.ceil(Math.sqrt(groups.length));
    const nodes = groups.flatMap((group, index) => {
      const x = (index % columns) * step, y = Math.floor(index / columns) * step;
      const hub = group.find((node) => node.kind === 'project');
      const satellites = group.filter((node) => node !== hub);
      const orbit = satellites.map((node, i) => {
        const ring = Math.floor(i / 8);
        const count = Math.min(8, satellites.length - ring * 8);
        const angle = 2 * Math.PI * (i % 8) / count - Math.PI / 2 + (ring % 2) * Math.PI / 8;
        const radius = 155 + ring * 96;
        return makeNode(node, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
      });
      return hub ? [makeNode(hub, x, y), ...orbit] : orbit;
    });
    const edges = data.edges.map((edge) => ({ ...edge, cls: edge.kind === 'project_member' ? 'r-apply' : 'r-origin', marker: 'dep' }));
    return { nodes, edges, byKey: new Map(data.nodes.map((node) => [node.key, node])) };
  }, [data]);

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const graph = createGraph(el, {
      nodes: model.nodes, edges: model.edges,
      edgePath: (_edge, a, b) => {
        const dx = b.x - a.x, dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || 1;
        return `M${a.x + 8 * dx / length},${a.y + 8 * dy / length} L${b.x - 8 * dx / length},${b.y - 8 * dy / length}`;
      },
      label: 'Red de Brain. Usa las flechas para navegar e Intro para abrir.',
      minFit: 0.25, maxFit: 1, pad: [70, 24, 48, 24],
      node: (n) => {
        const item = n.node as Node;
        const label = item.title.length > 24 ? `${item.title.slice(0, 23)}…` : item.title;
        const kind = lane(item.kind);
        return `<title>${escapeXml(item.title)}</title><rect class="network-hit" x="-74" y="-16" width="148" height="38" rx="7"/><circle class="network-node network-${kind}" r="${kind === 'project' ? 8 : 5}"/><text text-anchor="middle" y="19">${escapeXml(label)}</text>`;
      },
      onSelect: (key) => callbacks.current.onSelect(key),
      onOpen: (key) => { const item = model.byKey.get(key); if (item) callbacks.current.onOpen(item); },
      onKey: (key, current) => {
        const index = model.nodes.findIndex((node) => node.id === current);
        if (index === -1) return model.nodes[0]?.id;
        const node = model.nodes[index];
        const target = model.nodes.filter((other) => key === 'ArrowRight' ? other.x > node.x : key === 'ArrowLeft' ? other.x < node.x : other.x === node.x && (key === 'ArrowDown' ? other.y > node.y : other.y < node.y));
        return target.sort((a, b) => Math.hypot(a.x - node.x, a.y - node.y) - Math.hypot(b.x - node.x, b.y - node.y))[0]?.id;
      },
    });
    handle.current = graph;
    const ro = new ResizeObserver(() => graph.fit(false));
    ro.observe(el);
    return () => { ro.disconnect(); graph.destroy(); handle.current = null; };
  }, [model]);

  useEffect(() => { if (handle.current?.selected !== selected) handle.current?.select(selected, true); }, [model, selected]);

  return <>
    <svg ref={svg} className="g brg mapmode brain-network" />
    <div className="gtools">
      <button className="tbtn" onClick={() => handle.current?.zoom(1.2)} aria-label="Acercar"><Icon name="zin" size={15} /></button>
      <button className="tbtn" onClick={() => handle.current?.zoom(0.83)} aria-label="Alejar"><Icon name="zout" size={15} /></button>
      <button className="tbtn" onClick={() => handle.current?.fit(true)} aria-label="Encajar red"><Icon name="fit" size={15} /></button>
      <span className="ghint">Selecciona un nodo para ver sus enlaces</span>
    </div>
  </>;
}
