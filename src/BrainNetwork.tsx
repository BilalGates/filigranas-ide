import { useEffect, useRef, useState } from 'react';
import type { BrainGraphData } from './ipc';

type Point = { x: number; y: number; vx: number; vy: number };
type Camera = { x: number; y: number; zoom: number };
const INITIAL: Camera = { x: 0, y: 0, zoom: 1 };
const COLORS = ['#8bafd4', '#cb97ad', '#a5bf9b', '#c4ac79', '#aa9ccc', '#79bcb6'];
export function projectColor(project: string | null) {
  let hash = 0;
  for (const char of project ?? 'global') hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

export default function BrainNetwork({ data, selected, onSelect, projectName, hidden }: {
  data: BrainGraphData; selected: string | null; onSelect: (key: string) => void;
  projectName: (path: string | null) => string; hidden: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const points = useRef(new Map<string, Point>());
  const drag = useRef<{ key: string | null; x: number; y: number; moved: boolean } | null>(null);
  const [positions, setPositions] = useState(new Map<string, Point>());
  const [camera, setCamera] = useState(INITIAL);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [hovered, setHovered] = useState<string | null>(null);
  const [restart, setRestart] = useState(0);
  const focus = hovered ?? selected;
  const neighbors = new Set([focus]);
  for (const edge of data.edges) {
    if (edge.from === focus) neighbors.add(edge.to);
    if (edge.to === focus) neighbors.add(edge.from);
  }
  const coordinate = (x: number, y: number, local = false) => {
    const matrix = (local ? world.current : svg.current)?.getScreenCTM();
    return matrix ? new DOMPoint(x, y).matrixTransform(matrix.inverse()) : new DOMPoint(x, y);
  };
  const fit = () => {
    const list = [...points.current.values()];
    if (!list.length) return;
    const minX = Math.min(...list.map(p => p.x)) - 100;
    const maxX = Math.max(...list.map(p => p.x)) + 100;
    const minY = Math.min(...list.map(p => p.y)) - 60;
    const maxY = Math.max(...list.map(p => p.y)) + 60;
    const zoom = Math.min(2, 1000 / (maxX - minX), 680 / (maxY - minY));
    setCamera({ zoom, x: 500 - (minX + maxX) / 2 * zoom, y: 340 - (minY + maxY) / 2 * zoom });
  };
  const zoomAt = (factor: number, x = 500, y = 340) => setCamera(c => {
    const zoom = Math.max(.2, Math.min(5, c.zoom * factor));
    return { zoom, x: x - (x - c.x) * zoom / c.zoom, y: y - (y - c.y) * zoom / c.zoom };
  });
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const target = svg.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const p = coordinate(event.clientX, event.clientY);
      zoomAt(Math.exp(-event.deltaY * .0015), p.x, p.y);
    };
    target?.addEventListener('wheel', wheel, { passive: false });
    return () => target?.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    const groups = [...new Set(data.nodes.map(n => n.project))];
    const hubs = new Map(groups.map((group, i) => {
      const angle = i / groups.length * Math.PI * 2 - Math.PI / 2;
      const radius = groups.length > 1 ? 220 : 0;
      return [group, { x: 500 + Math.cos(angle) * radius, y: 340 + Math.sin(angle) * radius }];
    }));
    const next = new Map<string, Point>();
    data.nodes.forEach((node, i) => {
      const hub = hubs.get(node.project)!;
      const angle = i * 2.39996;
      const radius = node.kind === 'project' ? 0 : 40 + Math.sqrt(i + 1) * 10;
      const previous = points.current.get(node.key);
      next.set(node.key, previous ?? { x: hub.x + Math.cos(angle) * radius, y: hub.y + Math.sin(angle) * radius, vx: 0, vy: 0 });
    });
    points.current = next;
    setPositions(new Map(next));
    if (hidden || paused) return;
    let frame = 0;
    let request = 0;
    const tick = () => {
      const entries = [...next.entries()];
      const step = () => {
        for (let i = 0; i < entries.length; i++) {
          const [, a] = entries[i];
          for (let j = i + 1; j < entries.length; j++) {
            const [, b] = entries[j];
            const dx = a.x - b.x || .1, dy = a.y - b.y || .1;
            const distance = Math.max(100, dx * dx + dy * dy);
            const force = Math.min(2, 650 / distance);
            const length = Math.sqrt(distance);
            a.vx += dx / length * force; a.vy += dy / length * force;
            b.vx -= dx / length * force; b.vy -= dy / length * force;
          }
        }
        for (const edge of data.edges) {
          const a = next.get(edge.from), b = next.get(edge.to);
          if (!a || !b) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const length = Math.max(1, Math.hypot(dx, dy));
          const force = (length - (edge.kind === 'project_member' ? 110 : 75)) * .006;
          a.vx += dx / length * force; a.vy += dy / length * force;
          b.vx -= dx / length * force; b.vy -= dy / length * force;
        }
        for (const node of data.nodes) {
          const p = next.get(node.key)!, hub = hubs.get(node.project)!;
          if (drag.current?.key === node.key) { p.vx = 0; p.vy = 0; continue; }
          const gravity = node.kind === 'project' ? .05 : .002;
          p.vx = (p.vx + (hub.x - p.x) * gravity) * .78;
          p.vy = (p.vy + (hub.y - p.y) * gravity) * .78;
          p.x += p.vx; p.y += p.vy;
        }
      };
      for (let i = 0; i < (reduced ? 180 : 2); i++) step();
      setPositions(new Map([...next].map(([key, p]) => [key, { ...p }])));
      if (++frame < 180 && !reduced) request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [data, paused, reduced, hidden, restart]);

  return <div className="brain-network">
    <div className="brain-network-tools" aria-label="Controles del grafo">
      <button className="co-btn" onClick={() => zoomAt(1.25)} aria-label="Acercar grafo">+</button>
      <span>{Math.round(camera.zoom * 100)}%</span>
      <button className="co-btn" onClick={() => zoomAt(.8)} aria-label="Alejar grafo">−</button>
      <button className="co-btn" onClick={fit}>Ajustar</button>
      <button className="co-btn" onClick={() => setCamera(INITIAL)}>Centrar</button>
      <button className="co-btn" aria-pressed={paused} onClick={() => setPaused(p => !p)}>{paused ? 'Reanudar' : 'Pausar'}</button>
    </div>
    <svg ref={svg} viewBox="0 0 1000 680" className="brain-network-svg" aria-label="Red de conocimientos de Filigranas" role="group"
      onPointerDown={e => {
        if (e.button !== 0) return;
        const target = (e.target as Element).closest('[data-node]');
        const key = target?.getAttribute('data-node') ?? null;
        const p = coordinate(e.clientX, e.clientY);
        drag.current = { key, x: p.x, y: p.y, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const d = drag.current;
        if (!d) return;
        const p = coordinate(e.clientX, e.clientY);
        if (Math.hypot(p.x - d.x, p.y - d.y) > 3) d.moved = true;
        if (d.key && d.moved) {
          const local = coordinate(e.clientX, e.clientY, true), point = points.current.get(d.key);
          if (point) { point.x = local.x; point.y = local.y; point.vx = 0; point.vy = 0; setPositions(new Map(points.current)); }
        } else if (!d.key && d.moved) {
          const dx = p.x - d.x, dy = p.y - d.y;
          setCamera(c => ({ ...c, x: c.x + dx, y: c.y + dy }));
          d.x = p.x; d.y = p.y;
        }
      }}
      onPointerUp={e => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) onSelect(d.key ?? '');
        if (d?.moved && d.key && !paused) setRestart(n => n + 1);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }} onPointerCancel={() => { drag.current = null; }}>
      <g ref={world} transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
        <g aria-hidden="true">{data.edges.map((edge, i) => {
          const a = positions.get(edge.from), b = positions.get(edge.to);
          if (!a || !b) return null;
          const lit = edge.from === focus || edge.to === focus;
          return <line key={`${edge.from}:${edge.to}:${edge.kind}:${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            className={lit ? 'is-lit' : ''} opacity={focus && !lit ? .12 : edge.kind === 'project_member' ? .24 : .5} />;
        })}</g>
        {data.nodes.map(node => {
          const p = positions.get(node.key);
          if (!p) return null;
          const hub = node.kind === 'project';
          const showLabel = hub || focus === node.key || camera.zoom >= 1.5 || data.nodes.length <= 16;
          const title = hub ? projectName(node.project) : node.title;
          return <g key={node.key} data-node={node.key} transform={`translate(${p.x} ${p.y})`}
            className={`brain-dot${selected === node.key ? ' is-selected' : ''}${hub ? ' is-hub' : ''}`}
            style={{ color: projectColor(node.project), opacity: focus && !neighbors.has(node.key) ? .28 : 1 }}
            role="button" tabIndex={0} aria-label={`${title} · ${projectName(node.project)}`} aria-pressed={selected === node.key}
            onMouseEnter={() => setHovered(node.key)} onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(node.key)} onBlur={() => setHovered(null)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(node.key); } }}>
            <title>{title} · {projectName(node.project)}</title>
            <circle className="brain-dot-halo" r={hub ? 23 : 17} />
            <circle className="brain-dot-core" r={hub ? 9 : node.kind === 'task' ? 5 : 4} strokeDasharray={node.matched ? undefined : '2 2'} />
            {showLabel && <text y={hub ? -19 : 21} textAnchor="middle" className={hub ? 'is-hub-label' : ''}>{title.length > 28 ? `${title.slice(0, 27)}…` : title}</text>}
          </g>;
        })}
      </g>
    </svg>
    <p className="brain-network-hint">Arrastra para explorar · Rueda para ampliar · Selecciona un nodo para ver sus vínculos</p>
  </div>;
}
