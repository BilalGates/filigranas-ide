import type { LogRow } from '../../ipc';

export const GRAPH_ROW_HEIGHT = 26;
const LANE_STEP = 14;
const LANE_ORIGIN = 10;

const LANE_COLORS = [
  'var(--skyhi)',
  'var(--mint)',
  'var(--violet)',
  'var(--amber)',
  'var(--coral)',
  '#7ec8e3',
];

const laneX = (lane: number) => LANE_ORIGIN + lane * LANE_STEP;
const curvePath = (x1: number, y1: number, x2: number, y2: number) =>
  x1 === x2
    ? `M ${x1} ${y1} V ${y2}`
    : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;

export type GraphSegment = { d: string; color: string };
export type GraphDot = {
  hash: string;
  x: number;
  y: number;
  color: string;
  kind: 'head' | 'merge' | 'commit';
  inset: number;
};
export type CommitGraphLayout = {
  lines: GraphSegment[];
  dots: GraphDot[];
  width: number;
  height: number;
};

type ActiveLane = { hash: string; color: string; from: number } | null;

/**
 * Calcula la topología real de Git (carriles, bifurcaciones, merges y relaciones padre-hijo)
 * a partir de las filas de `git log --topo-order`.
 */
export function layoutCommitGraph(rows: LogRow[], rowHeight = GRAPH_ROW_HEIGHT): CommitGraphLayout {
  const lines: GraphSegment[] = [];
  const dots: GraphDot[] = [];
  let lanes: ActiveLane[] = [];
  let merges: { from: number; lane: number; color: string }[] = [];
  let painted = 0;
  let maxCols = 1;

  const nextColor = () => LANE_COLORS[painted++ % LANE_COLORS.length];
  const freeSlot = () => {
    const idx = lanes.indexOf(null);
    return idx < 0 ? lanes.length : idx;
  };

  rows.forEach((row, index) => {
    const mid = index * rowHeight + rowHeight / 2;
    const prevMid = mid - rowHeight;
    const known = lanes.findIndex((l) => l?.hash === row.hash);
    const col = known < 0 ? freeSlot() : known;
    const color = lanes[col]?.color ?? nextColor();
    const targetCol = (laneIdx: number) => (lanes[laneIdx]?.hash === row.hash ? col : laneIdx);

    lanes.forEach((lane, j) => {
      if (lane) {
        lines.push({
          d: curvePath(laneX(lane.from), prevMid, laneX(targetCol(j)), mid),
          color: lane.color,
        });
      }
    });
    merges.forEach((m) => {
      lines.push({
        d: curvePath(laneX(m.from), prevMid, laneX(targetCol(m.lane)), mid),
        color: m.color,
      });
    });

    const incomingCols = lanes.length;
    lanes = lanes.map((lane, j) => (lane && lane.hash !== row.hash ? { ...lane, from: j } : null));
    merges = [];

    const [firstParent, ...otherParents] = row.parents;
    lanes[col] = firstParent ? { hash: firstParent, color, from: col } : null;

    for (const parent of otherParents) {
      const existing = lanes.findIndex((l) => l?.hash === parent);
      if (existing >= 0) {
        merges.push({ from: col, lane: existing, color: lanes[existing]!.color });
      } else {
        lanes[freeSlot()] = { hash: parent, color: nextColor(), from: col };
      }
    }

    while (lanes.length > 0 && !lanes[lanes.length - 1]) lanes.pop();
    const cols = Math.max(incomingCols, lanes.length, col + 1);
    maxCols = Math.max(maxCols, cols);

    const isHead = /(^|, )HEAD(?: -> |, |$)/.test(row.refs);
    const kind: GraphDot['kind'] = row.parents.length > 1 ? 'merge' : isHead ? 'head' : 'commit';
    dots.push({
      hash: row.hash,
      x: laneX(col),
      y: mid,
      color,
      kind,
      inset: laneX(cols - 1) + LANE_ORIGIN + 6,
    });
  });

  const end = rows.length * rowHeight;
  const lastMid = end - rowHeight / 2;
  lanes.forEach((lane, j) => {
    if (lane) {
      lines.push({ d: curvePath(laneX(lane.from), lastMid, laneX(j), end), color: lane.color });
    }
  });
  merges.forEach((m) => {
    lines.push({ d: curvePath(laneX(m.from), lastMid, laneX(m.lane), end), color: m.color });
  });

  return {
    lines,
    dots,
    width: LANE_ORIGIN * 2 + (maxCols - 1) * LANE_STEP + 6,
    height: end,
  };
}
