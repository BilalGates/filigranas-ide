// Motor de grafos compartido por Flow y Brain.
// Imperativo a propósito: la cámara (pan, zoom, foco) y las transiciones de
// disposición se aplican sobre el SVG sin pasar por React en cada fotograma.
// Trackpad: dos dedos desplazan, pellizco (ctrl+rueda) acerca.
import { effectiveMotion } from './motion';

export type GNode = { id: string; x: number; y: number; w: number; h: number; keep?: boolean; cls?: string; aria?: string; [k: string]: unknown };
export type GEdge = { from: string; to: string; cls?: string; marker?: string; color?: string; kind?: string };
export type GraphOptions = {
  nodes: GNode[];
  edges: GEdge[];
  node: (n: GNode, selected: boolean) => string;
  under?: () => string;
  edgePath?: (e: GEdge, a: GNode, b: GNode) => string | null;
  edgeDecor?: (e: GEdge, a: GNode, b: GNode) => string;
  selected?: string | null;
  dim?: boolean;
  pad?: [number, number, number, number];
  minFit?: number;
  maxFit?: number;
  label?: string;
  onSelect?: (id: string | null) => void;
  onOpen?: (id: string) => void;
  onKey?: (key: string, selected: string | null) => string | null | undefined;
};
export type GraphHandle = ReturnType<typeof createGraph>;

export const MARKERS = `<marker id="mk-dep" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1L9 5L1 9" fill="none" stroke="rgba(220,226,236,.55)" stroke-width="1.6"/></marker>
<marker id="mk-done" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1L9 5L1 9" fill="none" stroke="#6fe0b3" stroke-width="1.6"/></marker>
<marker id="mk-del" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M2 2L7 5L2 8M5 2l5 3-5 3" fill="none" stroke="#b09cff" stroke-width="1.2"/></marker>
<marker id="mk-rel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><circle cx="5" cy="5" r="2.2" fill="#9db6ff"/></marker>`;

const reduced = () => effectiveMotion() === 'reducido';

export function escapeXml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export function createGraph(svg: SVGSVGElement, o: GraphOptions) {
  const st = { k: 1, x: 0, y: 0, sel: o.selected ?? null as string | null, hl: null as Set<string> | null, anim: 0 };
  svg.innerHTML = `<defs>${MARKERS}</defs><g class="world"><g class="g-under"></g><g class="g-edges"></g><g class="g-nodes"></g></g>`;
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('role', 'application');
  svg.setAttribute('aria-label', o.label ?? 'Grafo');
  const world = svg.querySelector('.world') as SVGGElement;
  const gU = svg.querySelector('.g-under') as SVGGElement;
  const gE = svg.querySelector('.g-edges') as SVGGElement;
  const gN = svg.querySelector('.g-nodes') as SVGGElement;
  let N = new Map(o.nodes.map((n) => [n.id, n]));
  let E = o.edges;
  let els = new Map<string, SVGGElement>();
  let eels: SVGPathElement[] = [];

  const neighbors = (id: string) => {
    const s = new Set([id]);
    for (const e of E) { if (e.from === id) s.add(e.to); if (e.to === id) s.add(e.from); }
    return s;
  };
  function path(e: GEdge) {
    const a = N.get(e.from), b = N.get(e.to);
    if (!a || !b) return 'M0,0';
    const custom = o.edgePath?.(e, a, b);
    if (custom) return custom;
    const fwd = b.x - a.x > (a.w + b.w) / 2 - 4;
    if (fwd) {
      const x1 = a.x + a.w / 2, y1 = a.y, x2 = b.x - b.w / 2 - 3, y2 = b.y, mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }
    const dn = b.y > a.y, x1 = a.x, y1 = a.y + (dn ? a.h / 2 : -a.h / 2), x2 = b.x, y2 = b.y + (dn ? -b.h / 2 - 3 : b.h / 2 + 3), my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }
  const cls = (n: GNode) => {
    const s = st.sel ? neighbors(st.sel) : null;
    return `gn ${n.cls ?? ''} ${n.id === st.sel ? 'sel' : ''} ${(s && s.has(n.id)) || n.keep ? 'nb' : ''} ${st.hl && !st.hl.has(n.id) && !n.keep ? 'hlout' : ''}`;
  };
  function drawNodes() {
    gN.innerHTML = o.nodes.map((n) => `<g class="${cls(n)}" data-gid="${escapeXml(n.id)}" transform="translate(${n.x},${n.y})" role="button" aria-label="${escapeXml(n.aria ?? n.id)}">${o.node(n, n.id === st.sel)}</g>`).join('');
    els = new Map();
    gN.querySelectorAll<SVGGElement>('[data-gid]').forEach((g) => els.set(g.dataset.gid!, g));
  }
  function drawEdges() {
    const s = st.sel ? neighbors(st.sel) : null;
    gE.innerHTML = E.map((e, i) => `<path data-ei="${i}" class="ge ${e.cls ?? ''} ${s && s.has(e.from) && s.has(e.to) ? 'nb' : ''} ${st.hl && !(st.hl.has(e.from) && st.hl.has(e.to)) ? 'hlout' : ''}" d="${path(e)}" ${e.marker ? `marker-end="url(#mk-${e.marker})"` : ''} ${e.color ? `style="stroke:${e.color}"` : ''}/>`).join('')
      + (o.edgeDecor ? E.map((e) => { const a = N.get(e.from), b = N.get(e.to); return a && b ? o.edgeDecor!(e, a, b) : ''; }).join('') : '');
    eels = [...gE.querySelectorAll<SVGPathElement>('path[data-ei]')];
  }
  function draw() {
    gU.innerHTML = o.under?.() ?? '';
    drawEdges();
    drawNodes();
    svg.classList.toggle('gdim', !!st.sel && o.dim !== false);
    apply();
  }
  function restyle() {
    const s = st.sel ? neighbors(st.sel) : null;
    for (const n of o.nodes) els.get(n.id)?.setAttribute('class', cls(n));
    eels.forEach((p, i) => {
      const e = E[i];
      p.classList.toggle('nb', !!(s && s.has(e.from) && s.has(e.to)));
      p.classList.toggle('hlout', !!(st.hl && !(st.hl.has(e.from) && st.hl.has(e.to))));
    });
    svg.classList.toggle('gdim', !!st.sel && o.dim !== false);
  }
  function apply() {
    world.setAttribute('transform', `translate(${st.x},${st.y}) scale(${st.k})`);
    svg.classList.toggle('lowz', st.k < 0.72);
  }
  function bounds() {
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const n of o.nodes) { a = Math.min(a, n.x - n.w / 2); b = Math.min(b, n.y - n.h / 2); c = Math.max(c, n.x + n.w / 2); d = Math.max(d, n.y + n.h / 2); }
    const p = o.pad ?? [30, 30, 30, 30];
    return [a - p[3], b - p[0], c + p[1], d + p[2]];
  }
  function anim(to: { k: number; x: number; y: number }, dur = 520) {
    cancelAnimationFrame(st.anim);
    if (reduced()) { Object.assign(st, to); apply(); return; }
    const fr = { k: st.k, x: st.x, y: st.y }, t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 4);
      st.k = fr.k + (to.k - fr.k) * e; st.x = fr.x + (to.x - fr.x) * e; st.y = fr.y + (to.y - fr.y) * e;
      apply();
      if (p < 1) st.anim = requestAnimationFrame(step);
    };
    st.anim = requestAnimationFrame(step);
  }
  function fitTo() {
    const r = svg.getBoundingClientRect();
    if (!r.width || !o.nodes.length) return null;
    const [x0, y0, x1, y1] = bounds();
    const k = Math.max(o.minFit ?? 0.45, Math.min(o.maxFit ?? 1.15, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
    return { k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: r.height / 2 - ((y0 + y1) / 2) * k };
  }
  function fit(animated = false) {
    const to = fitTo();
    if (!to) return;
    if (animated) anim(to); else { Object.assign(st, to); apply(); }
  }
  function focus(id: string, k?: number) {
    const n = N.get(id), r = svg.getBoundingClientRect();
    if (!n) return;
    const kk = k ?? Math.max(st.k, 1);
    anim({ k: kk, x: r.width / 2 - n.x * kk, y: r.height / 2 - n.y * kk });
  }
  function select(id: string | null, quiet = false) {
    st.sel = id;
    restyle();
    if (!quiet) o.onSelect?.(id);
  }
  function zoom(f: number) {
    const r = svg.getBoundingClientRect(), k2 = Math.max(0.3, Math.min(2.6, st.k * f));
    anim({ k: k2, x: r.width / 2 - ((r.width / 2 - st.x) * k2) / st.k, y: r.height / 2 - ((r.height / 2 - st.y) * k2) / st.k }, 260);
  }
  /** Cambia la disposición conservando la posición de los nodos comunes (continuidad espacial). */
  function morph(nodes: GNode[], edges: GEdge[], under?: () => string, dur = 480) {
    const from = new Map(o.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    o.nodes = nodes; E = o.edges = edges; if (under) o.under = under;
    N = new Map(nodes.map((n) => [n.id, n]));
    const tg = nodes.map((n) => ({ n, fx: from.get(n.id)?.x ?? n.x, fy: from.get(n.id)?.y ?? n.y + 20, tx: n.x, ty: n.y, isNew: !from.has(n.id) }));
    draw();
    if (reduced() || dur < 10) { if (dur >= 10) fit(true); return; }
    for (const t of tg) { const g = els.get(t.n.id); if (t.isNew && g) g.style.opacity = '0'; }
    const t0 = performance.now();
    const step = (tt: number) => {
      const p = Math.min(1, (tt - t0) / dur), e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      for (const t of tg) {
        t.n.x = t.fx + (t.tx - t.fx) * e; t.n.y = t.fy + (t.ty - t.fy) * e;
        const g = els.get(t.n.id);
        if (g) { g.setAttribute('transform', `translate(${t.n.x},${t.n.y})`); if (t.isNew) g.style.opacity = String(e); }
      }
      eels.forEach((pe, i) => pe.setAttribute('d', path(E[i])));
      if (p < 1) requestAnimationFrame(step);
      else { for (const t of tg) { t.n.x = t.tx; t.n.y = t.ty; } drawEdges(); const to = fitTo(); if (to) anim(to, 420); }
    };
    requestAnimationFrame(step);
  }
  function update(id: string) {
    const n = N.get(id), g = els.get(id);
    if (n && g) { g.innerHTML = o.node(n, id === st.sel); g.setAttribute('class', cls(n)); }
  }

  let drag: { x: number; y: number; sx: number; sy: number; m: boolean } | null = null;
  let space = false;
  const onDown = (e: PointerEvent) => {
    const g = (e.target as Element).closest('[data-gid]') as SVGGElement | null;
    if (g && e.button === 0 && !space) { select(g.dataset.gid!); svg.focus({ preventScroll: true }); return; }
    drag = { x: e.clientX, y: e.clientY, sx: st.x, sy: st.y, m: false };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('drag');
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.m = true;
    st.x = drag.sx + dx; st.y = drag.sy + dy; apply();
  };
  const onUp = () => { if (drag && !drag.m && st.sel) select(null); drag = null; svg.classList.remove('drag'); };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    cancelAnimationFrame(st.anim);
    if (e.ctrlKey || e.metaKey) {
      const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const k2 = Math.max(0.3, Math.min(2.6, st.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))));
      st.x = mx - ((mx - st.x) * k2) / st.k; st.y = my - ((my - st.y) * k2) / st.k; st.k = k2;
    } else { st.x -= e.deltaX; st.y -= e.deltaY; }
    apply();
  };
  const onDbl = (e: MouseEvent) => {
    const g = (e.target as Element).closest('[data-gid]') as SVGGElement | null;
    if (g) o.onOpen ? o.onOpen(g.dataset.gid!) : focus(g.dataset.gid!, Math.max(st.k, 1.2));
  };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === ' ') { space = true; return; }
    if (k === '+' || k === '=') { zoom(1.2); e.preventDefault(); }
    else if (k === '-') { zoom(0.83); e.preventDefault(); }
    else if (k === '0') { fit(true); e.preventDefault(); }
    else if (k === 'Escape' && st.sel) { select(null); e.stopPropagation(); }
    else if (k === 'Enter' && st.sel) { o.onOpen ? o.onOpen(st.sel) : focus(st.sel); e.preventDefault(); }
    else if (k.startsWith('Arrow') && o.onKey) { const nx = o.onKey(k, st.sel); if (nx) { select(nx); focus(nx); e.preventDefault(); } }
  };
  const onKeyUp = (e: KeyboardEvent) => { if (e.key === ' ') space = false; };
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('dblclick', onDbl);
  svg.addEventListener('keydown', onKey);
  svg.addEventListener('keyup', onKeyUp);
  draw();
  requestAnimationFrame(() => fit(false));

  return {
    draw, fit, focus, zoom, select, morph, update, restyle,
    highlight(set: Set<string> | null) { st.hl = set; restyle(); },
    get selected() { return st.sel; },
    get nodes() { return o.nodes; },
    destroy() {
      cancelAnimationFrame(st.anim);
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('dblclick', onDbl);
      svg.removeEventListener('keydown', onKey);
      svg.removeEventListener('keyup', onKeyUp);
    },
  };
}
