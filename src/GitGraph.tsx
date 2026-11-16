import type { LogRow } from './ipc';

const ROW = 24;
const LANE = 14;
const ORIGIN = 8;
const COLORS = ['var(--blue)', 'var(--ac)', 'var(--gold)', 'var(--add)'];

const x = (lane: number) => ORIGIN + lane * LANE;
const curve = (x1: number, y1: number, x2: number, y2: number) =>
  x1 === x2 ? `M ${x1} ${y1} V ${y2}` : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;

type Segment = { d: string; color: string };
type Dot = { x: number; y: number; color: string; head: boolean };
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
    const mid = index * ROW + ROW / 2;
    const known = lanes.findIndex((lane) => lane?.hash === row.hash);
    const col = known < 0 ? free() : known;
    const color = lanes[col]?.color ?? fresh();
    const target = (lane: number) => (lanes[lane]?.hash === row.hash ? col : lane);

    lanes.forEach((lane, j) => lane && lines.push({ d: curve(x(lane.from), mid - ROW, x(target(j)), mid), color: lane.color }));
    merges.forEach((m) => lines.push({ d: curve(x(m.from), mid - ROW, x(target(m.lane)), mid), color: m.color }));
    dots.push({ x: x(col), y: mid, color, head: /(^|, )HEAD\b/.test(row.refs) });

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
    width = Math.max(width, lanes.length, col + 1);
  });

  // Padres que quedan fuera del límite del historial: la línea sigue hasta el borde.
  const end = rows.length * ROW;
  lanes.forEach((lane, j) => lane && lines.push({ d: curve(x(lane.from), end - ROW / 2, x(j), end), color: lane.color }));
  merges.forEach((m) => lines.push({ d: curve(x(m.from), end - ROW / 2, x(m.lane), end), color: m.color }));

  return { lines, dots, width: ORIGIN * 2 + (width - 1) * LANE };
}

/** Dibuja todo el historial en un único SVG, detrás de las filas. */
export default function GitGraph({ graph, rows }: { graph: Graph; rows: number }) {
  return (
    <svg className="git-graph-svg" width={graph.width} height={rows * ROW} fill="none" aria-hidden="true">
      {graph.lines.map((line, index) => (
        <path key={index} d={line.d} stroke={line.color} strokeWidth="1.5" strokeLinecap="round" />
      ))}
      {graph.dots.map((dot, index) =>
        dot.head ? (
          // HEAD: anillo hueco, para encontrarlo de un vistazo.
          <circle key={index} cx={dot.x} cy={dot.y} r="4" fill="var(--pane)" stroke={dot.color} strokeWidth="1.8" />
        ) : (
          <circle key={index} cx={dot.x} cy={dot.y} r="3.5" fill={dot.color} />
        ),
      )}
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
