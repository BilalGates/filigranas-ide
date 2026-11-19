import type { LogRow } from './ipc';

export const GIT_ROW_HEIGHT = 22;
const LANE = 12;
const ORIGIN = 7;
const COLORS = ['amber', 'mint', 'coral', 'violet', 'sky', 'rose'].map((hue) => `var(--git-${hue})`);

const x = (lane: number) => ORIGIN + lane * LANE;
const curve = (x1: number, y1: number, x2: number, y2: number) =>
  x1 === x2 ? `M ${x1} ${y1} V ${y2}` : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;

type Segment = { d: string; color: string };
type Dot = { x: number; y: number; color: string; kind: 'head' | 'merge' | 'commit'; inset: number };
export type Graph = { lines: Segment[]; dots: Dot[]; width: number };

/** Un carril espera a un commit; `from` es la columna de la que sale su tramo hacia la fila siguiente. */
type Lane = { hash: string; color: string; from: number } | null;

/**
 * Asigna una columna a cada commit a partir de sus padres, una fila por commit.
 * Cada tramo va del centro de una fila al de la siguiente, así que las líneas
 * llegan siempre a su círculo y cada rama conserva su color hasta unirse.
 */
export function layoutGraph(rows: LogRow[]): Graph {
  const lines: Segment[] = [];
  const dots: Dot[] = [];
  let lanes: Lane[] = [];
  let merges: { from: number; lane: number; color: string }[] = [];
  let painted = 0;
  let width = 1;
  const fresh = () => COLORS[painted++ % COLORS.length];
  const free = () => {
    const slot = lanes.indexOf(null);
    return slot < 0 ? lanes.length : slot;
  };

  rows.forEach((row, index) => {
    const mid = index * GIT_ROW_HEIGHT + GIT_ROW_HEIGHT / 2;
    const known = lanes.findIndex((lane) => lane?.hash === row.hash);
    const col = known < 0 ? free() : known;
    const color = lanes[col]?.color ?? fresh();
    const target = (lane: number) => (lanes[lane]?.hash === row.hash ? col : lane);

    lanes.forEach((lane, j) => lane && lines.push({ d: curve(x(lane.from), mid - GIT_ROW_HEIGHT, x(target(j)), mid), color: lane.color }));
    merges.forEach((m) => lines.push({ d: curve(x(m.from), mid - GIT_ROW_HEIGHT, x(target(m.lane)), mid), color: m.color }));
    const incoming = lanes.length;

    lanes = lanes.map((lane, j) => (lane && lane.hash !== row.hash ? { ...lane, from: j } : null));
    merges = [];
    const [first, ...others] = row.parents;
    lanes[col] = first ? { hash: first, color, from: col } : null;
    for (const parent of others) {
      const existing = lanes.findIndex((lane) => lane?.hash === parent);
      if (existing >= 0) merges.push({ from: col, lane: existing, color: lanes[existing]!.color });
      else lanes[free()] = { hash: parent, color: fresh(), from: col };
    }
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    const columns = Math.max(incoming, lanes.length, col + 1);
    width = Math.max(width, columns);
    const kind = row.parents.length > 1 ? 'merge' : /(^|, )HEAD(?: -> |, |$)/.test(row.refs) ? 'head' : 'commit';
    dots.push({ x: x(col), y: mid, color, kind, inset: x(columns - 1) + ORIGIN + 3 });
  });

  // Padres que quedan fuera del límite del historial: la línea sigue hasta el borde.
  const end = rows.length * GIT_ROW_HEIGHT;
  const last = end - GIT_ROW_HEIGHT / 2;
  lanes.forEach((lane, j) => lane && lines.push({ d: curve(x(lane.from), last, x(j), end), color: lane.color }));
  merges.forEach((m) => lines.push({ d: curve(x(m.from), last, x(m.lane), end), color: m.color }));

  return { lines, dots, width: ORIGIN * 2 + (width - 1) * LANE };
}

/** Dibuja todo el historial en un único SVG sobre el fondo de las filas. */
export default function GitGraph({ graph, selected }: { graph: Graph; selected: number }) {
  return (
    <svg className="git-graph-svg" width={graph.width} height={graph.dots.length * GIT_ROW_HEIGHT} fill="none" aria-hidden="true">
      {graph.lines.map((line, index) => (
        <path key={index} d={line.d} stroke={line.color} strokeWidth="1.5" strokeLinecap="round" />
      ))}
      {graph.dots.map((dot, index) => {
        const fill = index === selected ? 'var(--git-selected)' : 'var(--git-surface)';
        if (dot.kind === 'merge') {
          return <rect key={index} x={dot.x - 3.5} y={dot.y - 3.5} width="7" height="7" rx="1.4"
            transform={`rotate(45 ${dot.x} ${dot.y})`} fill={fill} stroke={dot.color} strokeWidth="1.6" />;
        }
        if (dot.kind === 'head') {
          return <circle key={index} cx={dot.x} cy={dot.y} r="4" fill={fill} stroke={dot.color} strokeWidth="1.6" />;
        }
        return <circle key={index} cx={dot.x} cy={dot.y} r="2.4" fill={dot.color} />;
      })}
    </svg>
  );
}

type Ref = { name: string; kind: 'head' | 'branch' | 'remote' | 'tag' };

/** Parte la salida de `%D` ("HEAD -> main, origin/main, tag: v1") en etiquetas. */
export function parseRefs(refs: string): Ref[] {
  return refs
    .split(', ')
    .filter((ref) => ref && ref !== 'HEAD' && !ref.endsWith('/HEAD'))
    .map((ref): Ref => {
      if (ref.startsWith('HEAD -> ')) return { name: ref.slice(8), kind: 'head' };
      if (ref.startsWith('tag: ')) return { name: ref.slice(5), kind: 'tag' };
      return { name: ref, kind: /^(origin|upstream)\//.test(ref) ? 'remote' : 'branch' };
    });
}
