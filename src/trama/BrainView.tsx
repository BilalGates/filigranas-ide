import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { brain, pr, tasks as taskApi, type BrainDraft, type BrainEntry, type BrainGraphData, type BrainInference, type BrainKind, type BrainLink, type BrainLinkKind, type BrainNodeKind, type BrainValidity, type Project, type Task } from '../ipc';
import { STATUS } from '../Tasks';
import { createGraph, escapeXml, type GEdge, type GNode, type GraphHandle } from './graph';
import { ICON_PATHS, Icon } from './icons';
import { EmptyArt, Root } from './kit';
import { ErrorNote, Modal } from './ui';
import { BrainNetwork, brainNetworkLabel, NetworkConnections } from './BrainNetwork';

// Brain de Trama v2 sobre la memoria real: brain_graph (recuerdos, tareas y PR
// con sus aristas), brain_search/entry para la ficha completa y brain_links
// para las relaciones tipadas que crea el usuario. Las inferencias pendientes
// se leen aparte del índice de recuerdos y del contexto de los agentes.
type Lens = 'map' | 'focus' | 'index' | 'ctx';
type BNode = BrainGraphData['nodes'][number];
type Mem = { id: number; key: string; k: BrainKind; x: string; why: string; source: string; date: number; project: string | null; status: BrainValidity; validUntil: number | null; matched: boolean; inferred?: BrainInference; origins: Origin[]; used: { id: number; title: string }[] };
type Origin = { t: 'doc' | 'task' | 'pr' | 'run'; label: string; ref: string | number; url?: string | null };
export const KIND: Record<BrainKind, [string, string, string]> = {
  decision: ['Decisiones', '#9db6ff', 'decisión'],
  constraint: ['Restricciones', '#ffc27a', 'restricción'],
  preference: ['Preferencias', '#e9b4ff', 'preferencia'],
  fact: ['Hechos', '#7fe3c4', 'hecho'],
  evidence: ['Evidencias', '#ffc9d8', 'evidencia'],
  outcome: ['Resultados', '#79d5ff', 'resultado'],
};
export const RELT: Record<BrainLinkKind, [string, string]> = { depende: ['Depende de', '#9db6ff'], refina: ['Refina', '#7fe3c4'], sustituye: ['Sustituye a', '#8d939c'], contradice: ['Contradice', '#ff6b5d'], relacionado: ['Relacionado', '#bcc1c9'] };
const ORIGT: Record<Origin['t'], [string, string]> = { task: ['flow', 'Tarea'], pr: ['pr', 'Pull request'], doc: ['source', 'Fuente'], run: ['route', 'Ejecución'] };
const KINDS = Object.keys(KIND) as BrainKind[];
const newDraft = (global: boolean): BrainDraft => ({
  id: null, version: null, global, task: null, kind: 'decision', title: '', body: '',
  source: '', sourceTask: null, sourceRun: null, share: false, validUntil: null,
});
const fecha = (s: number) => new Date((s < 1e12 ? s * 1000 : s)).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
const tr = (s: string, m: number) => (s.length > m ? `${s.slice(0, m - 1)}…` : s);

function dayBoundary(value: string, end = false) {
  if (!value) return null;
  const local = new Date(`${value}T00:00:00`);
  if (end) local.setDate(local.getDate() + 1);
  return Math.floor(local.getTime() / 1000);
}

function buildMems(g: BrainGraphData): Mem[] {
  const byKey = new Map(g.nodes.map((n) => [n.key, n]));
  const edgesByMemory = new Map<string, BrainGraphData['edges']>();
  for (const edge of g.edges) {
    if (!edge.from.startsWith('m:')) continue;
    const edges = edgesByMemory.get(edge.from) ?? [];
    edges.push(edge);
    edgesByMemory.set(edge.from, edges);
  }
  return g.nodes.filter((n) => (KINDS as string[]).includes(n.kind)).map((n) => {
    const origins: Origin[] = [];
    const used: Mem['used'] = [];
    if (n.source) origins.push({ t: 'doc', label: n.source, ref: n.source });
    for (const ed of edgesByMemory.get(n.key) ?? []) {
      const other = byKey.get(ed.to);
      if (!other) continue;
      if (ed.kind === 'task_source' && other.kind === 'task') origins.push({ t: 'task', label: `#${other.id} ${other.title}`, ref: other.id });
      if (ed.kind === 'pull_source' && other.kind === 'pr') origins.push({ t: 'pr', label: other.title, ref: other.id, url: other.url });
      if (ed.kind === 'scope' && other.kind === 'task') used.push({ id: other.id, title: other.title });
    }
    if (n.sourceTask != null && !origins.some((origin) => origin.t === 'task')) origins.push({ t: 'task', label: `#${n.sourceTask}`, ref: n.sourceTask });
    if (n.sourceRun != null) origins.push({ t: 'run', label: `Ejecución #${n.sourceRun}`, ref: n.sourceRun });
    return { id: n.id, key: n.key, k: n.kind as BrainKind, x: n.title, why: n.body ?? '', source: n.source ?? '', date: n.date,
      project: n.project, status: n.validity ?? 'vigente', validUntil: n.validUntil ?? null, matched: n.matched, origins, used };
  });
}
function relsOf(m: Mem, links: BrainLink[]) {
  return links.filter((l) => l.from === m.id || l.to === m.id).map((l) => ({ id: l.id!, to: l.from === m.id ? l.to : l.from, type: l.kind, inv: l.to === m.id }));
}
const relLabel = (type: BrainLinkKind, inv: boolean) => inv && type === 'sustituye' ? 'Sustituida por' : inv && type === 'depende' ? 'La necesitan' : inv && type === 'refina' ? 'Refinada por' : RELT[type][0];

export default function BrainView({ project, projects, onOpenTask }: { project: string | null; projects: Project[]; onOpenTask: (id: number, project: string | null) => void }) {
  const [savedLens, setLensState] = useState<Lens>(() => { try { const v = localStorage.getItem('filigranas.brain.lente') as Lens | null; return v && ['map', 'focus', 'index', 'ctx'].includes(v) ? v : 'map'; } catch { return 'map'; } });
  const setLens = (l: Lens) => { setLensState(l); try { localStorage.setItem('filigranas.brain.lente', l); } catch { /* */ } };
  const [p, setScope] = useState<string | null>(project);
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const lens = p == null && savedLens === 'ctx' ? 'map' : savedLens;
  const validDays = lens === 'ctx' || !fromDay || !toDay || fromDay <= toDay;
  const from = lens === 'ctx' ? null : dayBoundary(fromDay);
  const until = lens === 'ctx' ? null : dayBoundary(toDay, true);
  const projectName = projects.find((item) => item.path === p)?.name;
  const linkProject = p ?? project;
  const [graph, setGraph] = useState<BrainGraphData | null>(null);
  const [inferences, setInferences] = useState<BrainInference[]>([]);
  const [showInferences, setShowInferences] = useState(true);
  const [links, setLinks] = useState<BrainLink[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [hist, setHist] = useState<number[]>([]);
  const [network, setNetwork] = useState(false);
  const [grouped, setGrouped] = useState(false);
  const [networkKind, setNetworkKind] = useState<BrainNodeKind | null>(null);
  const [networkNode, setNetworkNode] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [fk, setFk] = useState<BrainKind | 'all'>('all');
  const [fv, setFv] = useState<'all' | BrainValidity>('all');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: BrainDraft; project: string | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const [inspOpen, setInspOpen] = useState(false);

  const inNetwork = lens === 'map' && network;
  const graphQuery = lens !== 'ctx' ? query || null : null;
  const graphKind = inNetwork ? networkKind : lens !== 'ctx' && fk !== 'all' ? fk : null;
  const validity = !inNetwork && lens !== 'ctx' && fv !== 'all' ? fv : null;
  const focusId = lens === 'focus' ? focus : null;
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(q.trim()), 140);
    return () => window.clearTimeout(timer);
  }, [q]);
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    if (!validDays) return;
    try {
      const [g, l, pending] = await Promise.all([
        brain.graph({ query: graphQuery, project: p, kind: graphKind, from, until,
          memoryOnly: !inNetwork, validity, focusId }),
        linkProject ? brain.links(linkProject) : Promise.resolve([] as BrainLink[]),
        p && !inNetwork && lens !== 'ctx' ? brain.inferences(p) : Promise.resolve([] as BrainInference[]),
      ]);
      if (request !== latest.current) return;
      setGraph(g); setLinks(l); setInferences(pending); setError(null);
    } catch (err) { if (request === latest.current) setError(String(err)); }
  }, [p, linkProject, validDays, from, until, graphQuery, graphKind, inNetwork, validity, focusId, lens]);
  useEffect(() => {
    setGraph(null);
    setLinks([]);
    setInferences([]);
    void load();
    return () => { latest.current++; };
  }, [load]);
  useEffect(() => { setSel(null); setFocus(null); setHist([]); setNetworkNode(null); }, [p, fromDay, toDay]);

  const mems = useMemo(() => graph ? buildMems(graph) : [], [graph]);
  const visibleInferences = useMemo(() => {
    if (!p || !showInferences || inNetwork || lens === 'ctx' || validity) return [];
    const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const words = normalize(query).trim().split(/\s+/);
    return inferences.slice(0, 60).filter(({ created, draft }) =>
      (!graphKind || graphKind === draft.kind) && (from == null || created >= from) && (until == null || created < until)
      && words.every((word) => normalize(`${draft.title} ${draft.body} ${draft.source}`).includes(word)))
      .map((inferred): Mem => ({
        id: -inferred.id, key: `suggested:${inferred.id}`, k: inferred.draft.kind, x: inferred.draft.title,
        why: inferred.draft.body, source: inferred.draft.source, project: p, date: inferred.created, status: 'vigente',
        validUntil: inferred.draft.validUntil, matched: true, inferred, origins: [], used: [],
      }));
  }, [p, showInferences, inNetwork, lens, validity, query, inferences, graphKind, from, until]);
  const visibleMemories = useMemo(() => [...mems, ...visibleInferences], [mems, visibleInferences]);
  const filtered = useMemo(() => visibleMemories.filter((memory) => memory.matched), [visibleMemories]);
  const selectedNode = inNetwork ? graph?.nodes.find((node) => node.key === networkNode) : undefined;
  const selectNetwork = (key: string | null) => {
    setNetworkNode(key);
    const node = graph?.nodes.find((item) => item.key === key);
    setSel(node && KINDS.includes(node.kind as BrainKind) ? node.id : null);
    if (key) setInspOpen(true);
  };
  const openNetwork = (node: BNode) => {
    if (node.kind === 'task') onOpenTask(node.id, node.project);
    else if (node.kind === 'pr' && node.url) void pr.open(node.url).catch((reason) => setError(String(reason)));
    else if (node.kind === 'project' && node.project) setScope(node.project);
    else if (KINDS.includes(node.kind as BrainKind)) openFocus(node.id);
  };
  const m = sel != null ? visibleMemories.find((x) => x.id === sel) ?? null : null;
  const pick = (id: number | null) => { setSel(id); if (id != null) setInspOpen(true); };
  const openFocus = (id: number) => { if (id < 0) { pick(id); return; } setHist([]); setFocus(id); setSel(id); setLens('focus'); };

  const vig = mems.filter((x) => x.status === 'vigente').length;
  const empty = graph && visibleMemories.length === 0;
  return (
    <Root label="Brain">
      <div className={`brain${lens === 'map' && !inNetwork ? ' map-inspection' : ''}${inspOpen ? ' insp-open' : ''}`}>
        <div className="brainh">
          <h2 className="vt">Brain{projectName ? ` · ${projectName}` : ''}</h2>
          <span className="chip">{mems.length} aprobados</span>
          {inferences.length > 0 && <span className="chip dash">{Math.min(inferences.length, 60)}{inferences.length > 60 ? '+' : ''} inferidos por confirmar</span>}
          {mems.length - vig > 0 && <span className="chip dash">{mems.length - vig} sustituidos o caducados</span>}
          <label className="bsearch"><Icon name="search" size={14} /><input placeholder="Buscar en la memoria" value={q} maxLength={300} onChange={(e) => setQ(e.currentTarget.value)} aria-label="Buscar en la memoria" /></label>
          <span className="grow" />
          <div className="seg" role="group" aria-label="Ámbito">
            <label className="fsel brain-scope">
              <select value={p ?? ''} onChange={(e) => setScope(e.currentTarget.value || null)} aria-label="Proyecto de Brain">
                <option value="">Proyecto</option>
                {projects.map((item) => <option key={item.path} value={item.path}>{item.name}{item.archived ? ' · archivado' : ''}</option>)}
              </select>
              <Icon name="down" size={11} />
            </label>
            <button className={p == null ? 'on' : ''} aria-pressed={p == null} onClick={() => setScope(null)}>Todos</button>
          </div>
          <div className="seg" role="group" aria-label="Vista">
            {([['map', 'map', 'Mapa'], ['focus', 'focus', 'Foco'], ['index', 'list', 'Índice'], ['ctx', 'layers', 'Contexto']] as [Lens, string, string][]).map(([id, ic, l]) => (
              <button key={id} className={lens === id ? 'on' : ''} aria-label={l} aria-pressed={lens === id} disabled={id === 'ctx' && p == null} onClick={() => { if (id === 'focus' && focus == null && sel != null && sel > 0) setFocus(sel); setLens(id); }}><Icon name={ic} size={14} /><span className="hide-s">{l}</span></button>
            ))}
          </div>
          <button className="btn sm" onClick={() => setEditing({ project: p, draft: newDraft(p == null) })}><Icon name="plus" size={12} /> Recuerdo</button>
          <button className="tbtn narrow-only" onClick={() => setInspOpen(!inspOpen)} aria-label="Ficha"><Icon name="panel" size={16} /></button>
        </div>
        {lens !== 'ctx' && (
          <div className={lens === 'map' && !inNetwork ? 'bfilters bfilters-map' : 'bfilters'} role="group" aria-label="Filtros">
            {lens === 'map' && <button className="btn sm" aria-pressed={network} onClick={() => { setNetwork(!network); setNetworkNode(null); setSel(null); }}><Icon name="brain" size={13} /> Red del proyecto</button>}
            {inNetwork ? <label className="fsel"><select aria-label="Tipo de nodo" value={networkKind ?? ''} onChange={(e) => { setNetworkKind((e.target.value || null) as BrainNodeKind | null); selectNetwork(null); }}>
              <option value="">Todos los nodos</option><option value="project">Proyectos</option><option value="task">Tareas</option><option value="pr">Pull requests</option>
              {KINDS.map((kind) => <option key={kind} value={kind}>{KIND[kind][0]}</option>)}
            </select><Icon name="down" size={11} /></label> : <>
            <label className="fsel"><span className="sr">Tipo</span><select value={fk} onChange={(e) => setFk(e.currentTarget.value as BrainKind | 'all')} aria-label="Tipo"><option value="all">Todos los tipos</option>{KINDS.map((k) => <option key={k} value={k}>{KIND[k][0]}</option>)}</select><Icon name="down" size={11} /></label>
            {p && <button className={`btn sm${showInferences ? ' on' : ''}`} aria-pressed={showInferences}
              onClick={() => { setShowInferences(!showInferences); if ((sel ?? 0) < 0) setSel(null); }}>Inferidos</button>}
            {lens === 'map' && <button className={`btn sm${grouped ? ' on' : ''}`} aria-pressed={grouped} onClick={() => setGrouped(!grouped)}><Icon name="layers" size={12} /> Agrupar</button>}
            <label className="fsel"><span className="sr">Vigencia</span><select value={fv} onChange={(e) => setFv(e.currentTarget.value as typeof fv)} aria-label="Vigencia"><option value="all">Cualquier vigencia</option><option value="vigente">Vigentes</option><option value="sustituido">Sustituidos</option><option value="caducado">Caducados</option></select><Icon name="down" size={11} /></label>
            </>}
            <details className="brain-dates">
              <summary className="btn sm ghost">{fromDay || toDay ? 'Fechas activas' : 'Fechas'}</summary>
              <div className="brain-date-fields">
                <label className="tr-field-row">Desde<input type="date" value={fromDay} onChange={(e) => setFromDay(e.currentTarget.value)} /></label>
                <label className="tr-field-row">Hasta<input type="date" value={toDay} onChange={(e) => setToDay(e.currentTarget.value)} /></label>
                <button className="btn sm" onClick={() => { setFromDay(''); setToDay(''); }}>Quitar fechas</button>
              </div>
            </details>
            <span className="mut2 bcount">{inNetwork ? `${graph?.nodes.length ?? 0} nodos` : `${filtered.length} de ${mems.length + (showInferences ? Math.min(inferences.length, 60) : 0)}`}{graph?.limited && ' · vista parcial'}</span>
            {lens === 'focus' && hist.length > 0 && <button className="btn sm ghost" onClick={() => { const h = [...hist]; const prev = h.pop()!; setHist(h); setFocus(prev); setSel(prev); }}><Icon name="back" size={12} /> Volver</button>}
            <span className="grow" />
            {lens === 'map' && !inNetwork && <span className="brain-kind-legend" aria-label="Tipos de recuerdo">
              {KINDS.map((kind) => <span key={kind}><i style={{ background: KIND[kind][1] }} />{KIND[kind][0]}</span>)}
            </span>}
            {!inNetwork && (lens === 'map' || lens === 'focus') && <details className="brain-map-relations">
              <summary className="btn sm ghost">Relaciones</summary>
              <span className="blegend">{(Object.keys(RELT) as BrainLinkKind[]).map((k) => <span key={k}><svg width="22" height="8" aria-hidden="true"><path className={`ge r-${k} lg`} d="M1 4H21" /></svg>{RELT[k][0].toLowerCase()}</span>)}</span>
            </details>}
          </div>
        )}
        <div className="stage bstage">
          {error && <div className="flow-err" role="alert"><Icon name="warn" size={14} /> {error} <button className="btn sm" onClick={() => void load()}>Reintentar</button></div>}
          {!validDays ? <div className="empty sm" role="status">Elige una fecha final igual o posterior al inicio.</div>
            : !graph ? <div className="flow-loading"><span className="spin" /></div>
            : inNetwork ? (graph.nodes.length ? <BrainNetwork data={graph} selected={networkNode} onSelect={selectNetwork} onOpen={openNetwork} /> : <div className="empty sm" role="status">No hay nodos con estos filtros.</div>)
            : empty && (graphQuery || graphKind || validity) ? <div className="empty sm" role="status">Ningún recuerdo coincide con estos filtros.</div>
            : empty && (from != null || until != null) ? <div className="empty sm" role="status">Sin recuerdos en estas fechas.</div>
            : empty && lens !== 'ctx' ? (
              <div className="empty big"><EmptyArt /><h3>{p == null ? 'Aún no hay memoria' : `${projectName} aún no tiene memoria`}</h3>
                <p>Brain guarda decisiones, restricciones, preferencias, hechos, evidencias y resultados que <b>confirmas</b>, con su fuente. Los agentes los reciben como contexto cuando son relevantes para su tarea.</p>
                <div className="row"><button className="btn pearl" onClick={() => setEditing({ project: p, draft: newDraft(p == null) })}><Icon name="plus" size={13} /> Añadir el primer recuerdo…</button></div>
                <span className="sample">Nada se guarda sin tu confirmación.</span>
              </div>
            ) : lens === 'map' || lens === 'focus' ? (
              <BrainGraphView lens={lens} mems={filtered} all={visibleMemories} links={links} sel={sel} focus={focus ?? ((sel ?? 0) > 0 ? sel : mems[0]?.id) ?? null} q={q}
                grouped={grouped} scopeLabel={projectName ?? 'Memoria'}
                onSel={pick} onFocus={openFocus} onRel={(id) => { if (focus != null) setHist([...hist, focus]); setFocus(id); setSel(id); }}
                onMore={(k) => { setFk(k); setLens('index'); }} onTask={onOpenTask} onError={setError} />
            ) : lens === 'index' ? <MemIndex mems={filtered} sel={sel} onSel={pick} onFocus={openFocus} q={q} onClear={() => { setQ(''); setFk('all'); setFv('all'); }} />
            : p && <Ctx key={p} project={p} mems={mems} />}
        </div>
        <aside className="insp" id="binsp" aria-label="Ficha del recuerdo">
          {m?.inferred && m.project ? <InferenceInspector key={m.id} memory={m.inferred} project={m.project}
            onChanged={load} onDecided={(id) => { pick(id); void load(); }} /> : m ? <Insp key={`${m.id}:${revision}`} m={m} mems={mems} links={links} project={linkProject} scopeAll={p == null} lens={lens}
            onSel={pick} onFocus={openFocus} onTask={onOpenTask} onEdit={(draft) => setEditing({ draft, project: m.project })} onChanged={load} onForgot={() => { setSel(null); void load(); }} />
            : selectedNode && graph ? <div className="sec">
                <span className="lab">{brainNetworkLabel(selectedNode.kind)}</span><h3>{selectedNode.title}</h3>
                {selectedNode.body && <p className="mut2">{selectedNode.body}</p>}
                <button className="btn sm" onClick={() => openNetwork(selectedNode)}>{selectedNode.kind === 'project' ? 'Ver proyecto' : selectedNode.kind === 'pr' ? 'Abrir pull request' : 'Abrir tarea'}</button>
              </div> : (
              <>
                <div className="sec"><h3>Memoria {p == null ? 'de todos los proyectos' : 'del proyecto'}</h3><p className="mut2">Conocimiento confirmado y su procedencia. No reentrena modelos: aporta contexto a cada turno.</p></div>
                <div className="sec">{KINDS.map((k) => <div key={k} className="agline"><i className="kd" style={{ background: KIND[k][1] }} /><span className="grow">{KIND[k][0]}</span><span className="mono mut2">{mems.filter((x) => x.k === k).length}</span></div>)}</div>
                <div className="sec"><div className="why">Las tareas y los agentes viven en Flow; aquí solo hay conocimiento y su procedencia. Las relaciones solo existen si las creas tú.</div></div>
              </>
            )}
          {selectedNode && graph && <NetworkConnections data={graph} selected={selectedNode.key} onSelect={selectNetwork} />}
        </aside>
      </div>
      {editing && <EntryForm {...editing} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); pick(id); void load().then(() => setRevision((value) => value + 1)); }} />}
    </Root>
  );
}

function wrapText(s: string, max: number, x: number, y: number, lines: number) {
  const out: string[] = []; let cur = '';
  s.split(' ').forEach((w) => { if (`${cur} ${w}`.trim().length > max) { out.push(cur.trim()); cur = w; } else cur += ` ${w}`; });
  out.push(cur.trim());
  const L = out.slice(0, lines);
  if (out.length > lines) L[lines - 1] = `${L[lines - 1].slice(0, -1)}…`;
  return L.map((l, i) => `<text x="${x}" y="${y + i * 18}" class="big">${escapeXml(l)}</text>`).join('');
}
function memNode(n: GNode, sel: boolean) {
  void sel;
  if (n.kind === 'project') {
    return `<circle r="16" fill="rgba(91,134,255,.18)" stroke="#9db6ff"/><circle r="5" fill="#9db6ff"/><text y="32" text-anchor="middle">${escapeXml(n.aria ?? '')}</text>`;
  }
  if (n.kind === 'cluster') {
    const color = KIND[n.k as BrainKind][1];
    return `<circle r="${n.h / 2}" fill="${color}" fill-opacity=".14" stroke="${color}"/><text y="${n.h / 2 + 16}" text-anchor="middle">${escapeXml(n.aria ?? '')}</text>`;
  }
  if (n.kind === 'radial') {
    const m = n.m as Mem;
    const color = KIND[m.k][1], left = n.x < 0, r = n.h / 2, live = !m.inferred && m.status === 'vigente';
    const ring = `<circle class="memory-ring" r="${r + 9}" fill="none" stroke="${color}" stroke-opacity=".35"/>`;
    return `<circle class="memory-dot" r="${r}" fill="${live ? color : '#0b0c0f'}" stroke="${color}" ${live ? '' : 'stroke-dasharray="2 2"'}/>${ring}<text class="memory-label" x="${(left ? -1 : 1) * (r + 7)}" y="4" text-anchor="${left ? 'end' : 'start'}">${escapeXml(tr(m.x, 34))}</text>`;
  }
  if (n.kind === 'more') return `<rect class="body more" x="-110" y="-18" width="220" height="36" rx="18"/><text x="0" y="5" text-anchor="middle" class="s">+ ${n.n} más · abrir en Índice</text>`;
  if (n.kind === 'origin') { const o = n.o as Origin, ic = ORIGT[o.t]; return `<rect class="body org" x="-120" y="-23" width="240" height="46" rx="10"/><g transform="translate(-106,-8) scale(.68)" class="oic" fill="none" stroke="currentColor" stroke-width="1.6">${ICON_PATHS[ic[0]] ?? ''}</g><text x="-84" y="-3">${escapeXml(tr(o.label, 28))}</text><text class="s" x="-84" y="13">${ic[1]}</text>`; }
  if (n.kind === 'use') { const t = n.t as { id: number; title: string }; return `<rect class="body use" x="-90" y="-22" width="180" height="44" rx="10"/><circle cx="-74" cy="-4" r="3.6" fill="#9db6ff"/><text x="-64" y="0">#${t.id} · ${escapeXml(tr(t.title, 17))}</text><text class="s" x="-64" y="15">tarea</text>`; }
  const m = n.m as Mem, c = KIND[m.k][1];
  const state = m.status === 'vigente' ? `confirmado · ${fecha(m.date)}` : m.status === 'sustituido' ? 'sustituido' : 'caducado';
  if (n.kind === 'center') return `<rect class="body center" x="-160" y="-46" width="320" height="92" rx="14" style="stroke:${c}"/><circle cx="-140" cy="-26" r="4.5" fill="${c}" stroke="${c}"/><text x="-128" y="-22" class="s">${KIND[m.k][2]} · ${state}</text>${wrapText(m.x, 40, -140, 0, 2)}`;
  const w = n.w;
  return `<rect class="body" x="-${w / 2}" y="-${n.h / 2}" width="${w}" height="${n.h}" rx="10"/><circle cx="${-w / 2 + 14}" cy="-6" r="4" fill="${c}" stroke="${c}" stroke-width="1.3"/><text x="${-w / 2 + 26}" y="-2" class="${m.status === 'sustituido' ? 'strike' : ''}">${escapeXml(tr(m.x, 30))}</text><text class="s" x="${-w / 2 + 26}" y="13">${state}${m.project && n.showProject ? ` · ${escapeXml(m.project.split('/').pop() ?? '')}` : ''}</text>`;
}

function mapModel(mems: Mem[], links: BrainLink[], label: string, grouped: boolean) {
  const center: GNode = { id: 'P', kind: 'project', aria: label, x: 0, y: 0, w: Math.max(32, label.length * 7), h: 32, keep: true };
  const nodes: GNode[] = [center];
  const edges: GEdge[] = [];
  const order: BrainKind[] = ['decision', 'fact', 'preference', 'constraint', 'outcome'];
  if (mems.some((memory) => memory.k === 'evidence')) order.push('evidence');
  for (const [i, kind] of order.entries()) {
    const angle = i / order.length * 2 * Math.PI - Math.PI / 2;
    const all = mems.filter((m) => m.k === kind);
    if (!all.length) continue;
    if (grouped) {
      const r = 10 + Math.min(36, all.length * 3);
      const id = `K-${kind}`;
      nodes.push({ id, k: kind, kind: 'cluster', aria: `${KIND[kind][0]} · ${all.length}`,
        x: Math.cos(angle) * 230, y: Math.sin(angle) * 170, w: 2 * r, h: 2 * r });
      edges.push({ from: center.id, to: id, cls: 'memory-anchor' });
      continue;
    }
    const shown = all.slice(0, 10);
    for (const [j, m] of shown.entries()) {
      const direction = angle + (j - (shown.length - 1) / 2) * 0.42;
      const radius = 200 + (j % 2) * 70;
      const id = String(m.id);
      nodes.push({ id, kind: 'radial', m, x: Math.cos(direction) * radius * 1.25, y: Math.sin(direction) * radius,
        w: Math.max(32, tr(m.x, 34).length * 8), h: !m.inferred && m.status === 'vigente' ? 14 : 12, aria: `${KIND[kind][2]}: ${m.x}${m.inferred ? ' · por confirmar' : ''}` });
      edges.push({ from: center.id, to: id, cls: 'memory-anchor' });
    }
    if (all.length > shown.length) nodes.push({ id: `more-${kind}`, kind: 'more', k: kind, n: all.length - shown.length,
      x: Math.cos(angle) * 480, y: Math.sin(angle) * 395, w: 220, h: 36, aria: `${all.length - shown.length} más` });
  }
  const ids = new Set(nodes.map((n) => n.id));
  links.forEach((l) => {
    if (ids.has(String(l.from)) && ids.has(String(l.to))) edges.push({ from: String(l.from), to: String(l.to), cls: `r-${l.kind}` });
  });
  // Reproduce la separación de etiquetas del export en grafos pequeños.
  // En proyectos grandes el presupuesto de iteraciones se mantiene acotado.
  const iterations = nodes.length <= 18 ? 160 : 24;
  for (let i = 0; i < iterations; i++) {
    for (const a of nodes) {
      if (a === center) continue;
      for (const b of nodes) {
        if (a === b) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        if ((a.x < 0) === (b.x < 0) && Math.abs(dx) < 230 && Math.abs(dy) < 30)
          a.y += Math.sign(dy || 1) * (30 - Math.abs(dy)) * 0.3;
        const d = Math.hypot(dx, dy) || 1;
        const gap = (a.h + b.h) / 2 + 40;
        if (d < gap) {
          const force = (gap - d) / d * 0.25;
          a.x += dx * force;
          a.y += dy * force;
        }
      }
    }
  }
  return { nodes, edges, under: () => '' };
}
function mapExtent(n: GNode): [number, number, number, number] | undefined {
  const { x, y } = n;
  const radius = n.h / 2;
  if (n.kind === 'radial') {
    const labelWidth = tr((n.m as Mem).x, 34).length * 6.4;
    const edge = radius + 8;
    return [x - edge - (x < 0 ? labelWidth : 0), y - 14, x + edge + (x < 0 ? 0 : labelWidth), y + 14];
  }
  if (n.kind === 'project' || n.kind === 'cluster') {
    const labelWidth = Math.max(n.w / 2, n.kind === 'project' ? 50 : 60);
    return [x - radius - labelWidth, y - radius - 8, x + radius + labelWidth, y + radius + 30];
  }
  return undefined;
}
function focusModel(m: Mem, all: Mem[], links: BrainLink[]) {
  const nodes: GNode[] = [], edges: GEdge[] = [], under: string[] = [];
  nodes.push({ id: String(m.id), kind: 'center', m, x: 0, y: 0, w: 320, h: 92, keep: true, aria: m.x });
  m.origins.forEach((o, i) => { const nid = `o-${i}`; nodes.push({ id: nid, kind: 'origin', o, x: -400, y: (i - (m.origins.length - 1) / 2) * 62, w: 240, h: 46, keep: true, aria: o.label }); edges.push({ from: nid, to: String(m.id), cls: 'r-origin', marker: 'dep' }); });
  under.push(`<text x="-520" y="${-Math.max(1, m.origins.length) * 31 - 22}" class="mch">Por qué existe</text>`);
  const rels = relsOf(m, links);
  const groups: Record<string, typeof rels> = {};
  rels.forEach((r) => { (groups[`${r.type}:${r.inv}`] = groups[`${r.type}:${r.inv}`] || []).push(r); });
  let y = -Math.max(0, rels.length + Object.keys(groups).length - 1) * 28;
  Object.values(groups).forEach((rs) => {
    const { type, inv } = rs[0];
    under.push(`<text x="290" y="${y - 4}" class="mcs" style="fill:${RELT[type][1]}">${relLabel(type, inv)}</text>`); y += 14;
    rs.forEach((r) => { const o = all.find((x) => x.id === r.to); if (!o) return; const nid = `r-${r.to}`; nodes.push({ id: nid, ref: r.to, kind: 'rel', m: o, x: 410, y: y + 18, w: 240, h: 44, keep: true, aria: o.x, cls: o.status === 'sustituido' ? 'sup' : '' }); edges.push({ from: String(m.id), to: nid, cls: `r-${type}`, marker: 'rel' }); y += 56; });
    y += 10;
  });
  if (!rels.length) under.push('<text x="290" y="0" class="mcs">Sin relaciones registradas</text>');
  m.used.forEach((t, i) => { const nid = `u-${t.id}`; nodes.push({ id: nid, kind: 'use', t, x: (i - (m.used.length - 1) / 2) * 200, y: 180, w: 180, h: 44, keep: true, aria: t.title }); edges.push({ from: String(m.id), to: nid, cls: 'r-apply', marker: 'dep' }); });
  under.push(m.used.length ? `<text x="${-m.used.length * 100}" y="148" class="mch">Aplicado en</text>` : '<text x="-160" y="160" class="mcs">No está acotado a ninguna tarea</text>');
  return { nodes, edges, under: () => under.join('') };
}
const brainEdgePath = (_e: GEdge, a: GNode, b: GNode) => {
  if (a.kind === 'center' && b.kind === 'use') return `M${b.x * 0.3},${a.y + a.h / 2} C${b.x * 0.3},${a.y + a.h / 2 + 40} ${b.x},${b.y - b.h / 2 - 40} ${b.x},${b.y - b.h / 2 - 3}`;
  if (a.kind === 'project' || (a.kind === 'radial' && b.kind === 'radial')) {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
    const ra = a.h / 2 + 3, rb = b.h / 2 + 3;
    const x1 = a.x + dx / length * ra, y1 = a.y + dy / length * ra;
    const x2 = b.x - dx / length * rb, y2 = b.y - dy / length * rb;
    return `M${x1},${y1} Q${(x1 + x2) / 2 - dy * 0.12},${(y1 + y2) / 2 + dx * 0.12} ${x2},${y2}`;
  }
  return null;
};

function BrainGraphView({ lens, mems, all, links, sel, focus, q, grouped, scopeLabel, onSel, onFocus, onRel, onMore, onTask, onError }: {
  lens: 'map' | 'focus'; mems: Mem[]; all: Mem[]; links: BrainLink[]; sel: number | null; focus: number | null; q: string; grouped: boolean; scopeLabel: string;
  onSel: (id: number | null) => void; onFocus: (id: number) => void; onRel: (id: number) => void; onMore: (k: BrainKind) => void; onTask: (id: number, project: string | null) => void; onError: (error: string) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const g = useRef<GraphHandle | null>(null);
  const cb = useRef({ onSel, onFocus, onRel, onMore, onTask, onError });
  cb.current = { onSel, onFocus, onRel, onMore, onTask, onError };
  const fm = focus != null ? all.find((x) => x.id === focus) : undefined;
  const sig = `${lens}|${focus}|${scopeLabel}|${grouped}|${mems.map((m) => `${m.id}:${m.status}:${m.x}`).join(',')}|${links.map((l) => `${l.id}`).join(',')}`;
  useEffect(() => {
    const el = svg.current!;
    const model = lens === 'focus' && fm ? focusModel(fm, all, links) : mapModel(mems, links, scopeLabel, grouped);
    const byId = () => g.current!.nodes;
    if (!g.current) {
      g.current = createGraph(el, {
        nodes: model.nodes, edges: model.edges, under: model.under, node: memNode, extent: mapExtent, edgePath: brainEdgePath, dim: true,
        selected: lens === 'focus' ? (fm ? String(fm.id) : null) : sel != null ? String(sel) : null, pad: lens === 'focus' ? [60, 240, 60, 160] : [70, 20, 20, 20], maxFit: lens === 'focus' ? 1.1 : 1, minFit: 0.5,
        label: 'Mapa de conocimiento: flechas para moverse, Intro abre el foco',
        onSelect: (id) => {
          if (!id) { cb.current.onSel(null); return; }
          const n = byId().find((x) => x.id === id);
          if (!n) return;
          if (n.kind === 'more' || n.kind === 'cluster') return cb.current.onMore(n.k as BrainKind);
          if (n.kind === 'project') return cb.current.onSel(null);
          if (n.kind === 'rel') return cb.current.onRel(n.ref as number);
          if (n.kind === 'origin') { const o = n.o as Origin; if (o.t === 'task') cb.current.onTask(o.ref as number, (byId().find((x) => x.kind === 'center')?.m as Mem | undefined)?.project ?? null); else if (o.t === 'pr' && o.url) void pr.open(o.url).catch((e) => cb.current.onError(String(e))); return; }
          if (n.kind === 'use') { const t = n.t as { id: number }; cb.current.onTask(t.id, (byId().find((x) => x.kind === 'center')?.m as Mem | undefined)?.project ?? null); return; }
          cb.current.onSel((n.m as Mem).id);
        },
        onOpen: (id) => { const n = byId().find((x) => x.id === id); if (n?.kind === 'radial') cb.current.onFocus((n.m as Mem).id); },
        onKey: (k, s) => {
          const ns = byId().filter((x) => x.kind !== 'project' && x.kind !== 'more');
          const n = ns.find((x) => x.id === s);
          if (!n) return ns[0]?.id ?? null;
          const cand = ns.filter((x) => x !== n && (k === 'ArrowRight' ? x.x > n.x + 10 : k === 'ArrowLeft' ? x.x < n.x - 10 : k === 'ArrowDown' ? x.y > n.y + 5 && Math.abs(x.x - n.x) < 60 : x.y < n.y - 5 && Math.abs(x.x - n.x) < 60));
          cand.sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y));
          return cand[0]?.id ?? null;
        },
      });
    } else { g.current.setPad(lens === 'focus' ? [60, 240, 60, 160] : [70, 20, 20, 20]); g.current.morph(model.nodes, model.edges, model.under); }
    el.classList.toggle('mapmode', lens === 'map'); el.classList.toggle('focusmode', lens === 'focus');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useEffect(() => { g.current?.highlight(q.trim() && lens === 'map' ? new Set(mems.map((m) => String(m.id))) : null); }, [q, mems, lens]);
  useEffect(() => { const key = sel != null ? String(sel) : null; if (lens === 'map' && g.current && g.current.selected !== key) g.current.select(key, true); }, [sel, lens]);
  useEffect(() => { const ro = new ResizeObserver(() => g.current?.fit(false)); ro.observe(svg.current!); return () => { ro.disconnect(); g.current?.destroy(); g.current = null; }; }, []);
  return (
    <>
      <svg ref={svg} className={`g brg ${lens === 'map' ? 'mapmode' : 'focusmode'}`} />
      <div className="gtools">
        <button className="tbtn" onClick={() => g.current?.zoom(1.2)} aria-label="Acercar"><Icon name="zin" size={15} /></button>
        <button className="tbtn" onClick={() => g.current?.zoom(0.83)} aria-label="Alejar"><Icon name="zout" size={15} /></button>
        <button className="tbtn" onClick={() => g.current?.fit(true)} aria-label="Encajar"><Icon name="fit" size={15} /></button>
        <span className="gsep" /><span className="ghint">{lens === 'map' ? 'Selecciona para ver relaciones · doble clic abre el foco' : 'Pulsa un elemento relacionado para navegar'}</span>
      </div>
    </>
  );
}

function MemIndex({ mems, sel, onSel, onFocus, q, onClear }: { mems: Mem[]; sel: number | null; onSel: (id: number) => void; onFocus: (id: number) => void; q: string; onClear: () => void }) {
  if (!mems.length) return <div className="empty"><Icon name="search" size={22} /><div>Ningún recuerdo coincide{q ? ` con «${q}»` : ''}.</div><button className="btn sm" onClick={onClear}>Quitar filtros</button></div>;
  return (
    <div className="mems scr" role="listbox" aria-label="Recuerdos" onKeyDown={(e) => {
      if (!/Arrow(Up|Down)/.test(e.key)) return;
      const order = KINDS.flatMap((k) => mems.filter((m) => m.k === k)), i = order.findIndex((m) => m.id === sel);
      const n = order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { onSel(n.id); (e.currentTarget.querySelector(`[data-mem="${n.id}"]`) as HTMLElement | null)?.focus(); }
      e.preventDefault();
    }}>
      {KINDS.map((k) => { const l = mems.filter((m) => m.k === k); if (!l.length) return null; return (
        <div key={k}>
          <div className="mgroup"><i style={{ background: KIND[k][1] }} />{KIND[k][0]}<span className="mut2">{l.length}</span></div>
          {l.map((m) => (
            <div key={m.id} data-mem={m.id} className={`mem${m.inferred ? ' inf' : ''}${m.status === 'sustituido' ? ' sup' : ''}${sel === m.id ? ' sel' : ''}`} role="option" aria-selected={sel === m.id} tabIndex={sel === m.id || (sel == null && m === l[0]) ? 0 : -1}
              onClick={() => onSel(m.id)} onDoubleClick={() => onFocus(m.id)} onKeyDown={(e) => e.key === 'Enter' && onFocus(m.id)}>
              <span className="mk" style={{ ['--c' as string]: KIND[k][1] }} />
              <div><div className="mt">{m.x}</div><div className="ms">{m.inferred ? 'por confirmar' : 'confirmado'} · {fecha(m.date)}{m.source ? ` · ${m.source}` : ''}{m.used.length ? ` · acotado a ${m.used.length} ${m.used.length === 1 ? 'tarea' : 'tareas'}` : ''}{m.project ? ` · ${m.project.split('/').pop()}` : ' · global'}</div></div>
              <div className="col" style={{ gap: 4, alignItems: 'flex-end' }}>{m.inferred ? <span className="chip dash">inferido</span> : m.status === 'sustituido' ? <span className="chip">sustituido</span> : m.status === 'caducado' ? <span className="chip amber">caducado</span> : null}</div>
            </div>
          ))}
        </div>); })}
    </div>
  );
}

function Ctx({ project, mems }: { project: string; mems: Mem[] }) {
  const [list, setList] = useState<Task[] | null>(null);
  const [task, setTask] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [res, setRes] = useState<BrainEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { taskApi.list(project).then((t) => { setList(t); setTask(t.find((x) => x.status !== 'done' && x.status !== 'cancelled')?.id ?? t[0]?.id ?? null); }, (e) => setError(String(e))); }, [project]);
  useEffect(() => {
    if (task == null) return;
    let active = true;
    setRes(null);
    setError(null);
    const timer = window.setTimeout(() => {
      brain.preview(project, task, query).then(
        (value) => { if (active) setRes(value); },
        (e) => { if (active) setError(String(e)); },
      );
    }, 120);
    return () => { active = false; window.clearTimeout(timer); };
  }, [project, task, query]);
  const tok = (res ?? []).reduce((s, e) => s + (e.title.length + e.body.length) * 0.3, 0) | 0;
  return (
    <div className="mems scr">
      {error && <ErrorNote error={error} />}
      {list && list.length === 0 ? <div className="empty"><EmptyArt /><h3>Sin tareas</h3><p>El contexto se calcula para una tarea concreta.</p></div> : (
        <>
          <div className="row wrap"><span className="lab">Próximo turno de</span>
            <label className="fsel wide"><select value={task ?? ''} onChange={(e) => setTask(Number(e.currentTarget.value))} aria-label="Tarea">{(list ?? []).map((x) => <option key={x.id} value={x.id}>#{x.id} · {x.title} · {STATUS[x.status]}</option>)}</select><Icon name="down" size={11} /></label>
            <span className="grow" /><span className="chip">{res ? `${res.length} ${res.length === 1 ? 'recuerdo' : 'recuerdos'} · ≈${tok} tokens` : '…'}</span></div>
          <label className="bsearch"><Icon name="search" size={14} /><input aria-label="Encargo para la vista previa" placeholder="Encargo para la vista previa" maxLength={300} value={query} onChange={(e) => setQuery(e.currentTarget.value)} /></label>
          <p className="mut2" style={{ maxWidth: 640 }}>Esto es lo que el núcleo adjuntaría al agente que empiece esta tarea, además de las instrucciones del proyecto, con el mismo cálculo que usa al lanzar la ejecución. Los recuerdos privados o caducados no se envían.</p>
          {res === null ? <div className="tr-skel" style={{ height: 60 }} /> : res.length === 0 ? <div className="empty sm">Esta tarea no carga recuerdos.</div>
            : res.map((e, i) => (
              <div key={e.id} className="ctxrow"><span className="mk" style={{ ['--c' as string]: KIND[e.kind][1] }} />
                <div><div>{e.title}</div><div className="mono mut2" style={{ fontSize: 11.5 }}>{KIND[e.kind][0]} · se envía · {e.source}{mems.find((m) => m.id === e.id)?.status === 'sustituido' ? ' · marcado como sustituido' : ''}</div></div>
                <span className="rel" aria-label={`Posición ${i + 1}`}>{Array.from({ length: 10 }, (_, j) => <i key={j} className={j < Math.max(3, 10 - i * 1.3) ? 'f' : ''} />)}</span>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

function InferenceInspector({ memory, project, onChanged, onDecided }: {
  memory: BrainInference; project: string; onChanged: () => Promise<void>; onDecided: (id: number | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { draft } = memory;
  const [title, setTitle] = useState(draft.title);
  const dirty = title.trim() !== draft.title;
  const correct = async () => {
    setBusy(true);
    setError(null);
    try {
      await brain.correctInference(project, memory.id, title.trim());
      await onChanged();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const decide = (approve: boolean) => {
    setBusy(true);
    setError(null);
    void brain.decide(project, memory.id, approve).then(onDecided, (e) => setError(String(e))).finally(() => setBusy(false));
  };
  return <>
    <div className="sec">
      <div className="row brain-inference-heading"><i aria-hidden="true" style={{ borderColor: KIND[draft.kind][1] }} /><span className="lab grow">{KIND[draft.kind][0]}</span><span className="chip dash">inferencia por confirmar</span></div>
      <textarea className="in brain-memory-statement" rows={3} maxLength={160} aria-label="Inferencia" value={title} disabled={busy}
        onChange={(event) => setTitle(event.currentTarget.value)} />
      <div className="row wrap brain-inference-actions">
        <button className="btn sm pearl" disabled={busy || dirty} onClick={() => decide(true)}><Icon name="check" size={12} /> Aprobar</button>
        <button className="btn sm" disabled={busy || !dirty || !title.trim()} onClick={() => void correct()}><Icon name="edit" size={12} /> Guardar corrección</button>
        <span className="grow" />
        <button className="btn sm danger" disabled={busy} onClick={() => decide(false)}><Icon name="trash" size={12} /> Olvidar</button>
      </div>
    </div>
    <div className="sec">
      <dl className="kv brain-inspector-meta">
        <dt>Procedencia</dt><dd>{draft.source}</dd>
        <dt>Ámbito</dt><dd>{draft.task == null ? 'Proyecto' : `Tarea #${draft.task}`}</dd>
        <dt>Usado en</dt><dd>Aún sin uso</dd>
      </dl>
      {draft.body !== draft.title && <p className="mut2 brain-memory-context">{draft.body}</p>}
      {error && <ErrorNote error={error} />}
    </div>
  </>;
}

function Insp({ m, mems, links, project, scopeAll, lens, onSel, onFocus, onTask, onEdit, onChanged, onForgot }: {
  m: Mem; mems: Mem[]; links: BrainLink[]; project: string | null; scopeAll: boolean; lens: Lens;
  onSel: (id: number) => void; onFocus: (id: number) => void; onTask: (id: number, project: string | null) => void; onEdit: (d: BrainDraft) => void; onChanged: () => void; onForgot: () => void;
}) {
  const [full, setFull] = useState<BrainEntry | null>(null);
  const [target, setTarget] = useState<number | ''>('');
  const [kind, setKind] = useState<BrainLinkKind>('relacionado');
  const [ok, setOk] = useState(false);
  const [forget, setForget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    brain.entry(m.project, m.id).then((value) => {
      if (active) setFull(value);
    }, (error) => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [m.id, m.project]);
  const c = KIND[m.k][1];
  const rels = relsOf(m, links);
  const grouped: Record<string, typeof rels> = {};
  rels.forEach((r) => { (grouped[`${r.type}:${r.inv}`] = grouped[`${r.type}:${r.inv}`] || []).push(r); });
  const sameProject = !scopeAll || m.project === project || m.project == null;
  return (
    <>
      <div className="sec">
        <div className="row" style={{ marginBottom: 8 }}><i className="kd" style={{ ['--c' as string]: c, background: c }} /><span className="lab">{KIND[m.k][0]}</span><span className="grow" /><span className="chip">aprobado por ti</span></div>
        <p className={`statement in brain-memory-statement${m.status === 'sustituido' ? ' strike' : ''}`}>{m.x}</p>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button className="btn sm" disabled={!full} onClick={() => full && onEdit(full)}><Icon name="edit" size={12} /> Corregir</button>
          {lens !== 'focus' && <button className="btn sm" onClick={() => onFocus(m.id)}><Icon name="focus" size={12} /> Foco</button>}
          <span className="grow" />
          <button className="btn sm danger" disabled={!full} onClick={() => setForget(true)}>Olvidar</button>
        </div>
      </div>
      <div className="sec">
        <dl className="kv brain-inspector-meta">
          <dt>Procedencia</dt>
          <dd>{m.origins.length ? m.origins.map((origin, i) => {
            const url = origin.t === 'pr' ? origin.url : null;
            if (origin.t === 'task') return <button key={i} className="lnk" onClick={() => onTask(origin.ref as number, m.project)}>{origin.label}</button>;
            if (url) return <button key={i} className="lnk" onClick={() => void pr.open(url).catch((e) => setError(String(e)))}>{origin.label}</button>;
            return <span key={i}>{origin.label}</span>;
          }) : '—'}</dd>
          <dt>Ámbito</dt><dd>{m.project == null ? 'Global' : full?.task ? `Tarea #${full.task}` : 'Proyecto'}</dd>
          <dt>Usado en</dt><dd className="row wrap">{m.used.length ? m.used.map((task) => (
            <button key={task.id} className="chip btnchip" title={task.title} onClick={() => onTask(task.id, m.project)}>#{task.id}</button>
          )) : 'Sin uso registrado'}</dd>
          <dt>Relacionado</dt><dd>
            {rels.length ? Object.values(grouped).map((rs) => (
              <div key={rs[0].id} className="relg">
                {rs[0].type !== 'relacionado' && <span className="relt" style={{ color: RELT[rs[0].type][1] }}>{relLabel(rs[0].type, rs[0].inv)}</span>}
                {rs.map((relation) => {
                  const other = mems.find((memory) => memory.id === relation.to);
                  return other && <div key={relation.id} className="relrow">
                    <button className="lnk" onClick={() => onSel(other.id)}>{other.x}</button>
                    {project && sameProject && <button className="tbtn" aria-label="Quitar relación" onClick={() =>
                      brain.unlink(project, relation.id).then(onChanged, (e) => setError(String(e)))}><Icon name="close" size={11} /></button>}
                  </div>;
                })}
              </div>
            )) : '—'}
          </dd>
        </dl>
        {project && sameProject && (
          <details className="brain-inspector-details"><summary className="lab">Añadir relación</summary><div className="col" style={{ gap: 6, marginTop: 8 }}>
            <div className="row">
              <label className="fsel"><select value={kind} onChange={(e) => setKind(e.currentTarget.value as BrainLinkKind)} aria-label="Tipo de relación">{(Object.keys(RELT) as BrainLinkKind[]).map((k) => <option key={k} value={k}>{RELT[k][0]}</option>)}</select><Icon name="down" size={11} /></label>
              <label className="fsel wide" style={{ flex: 1 }}><select value={target} onChange={(e) => setTarget(e.currentTarget.value ? Number(e.currentTarget.value) : '')} aria-label="Recuerdo relacionado"><option value="">Elige un recuerdo…</option>{mems.filter((x) => x.id !== m.id && (x.project === project || x.project == null)).map((x) => <option key={x.id} value={x.id}>{tr(x.x, 60)}</option>)}</select><Icon name="down" size={11} /></label>
            </div>
            <label className="row" style={{ fontSize: 12 }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.currentTarget.checked)} /> Confirmo que esta relación es correcta</label>
            <button className="btn sm" disabled={!ok || target === ''} onClick={() => brain.link(project, { id: null, from: m.id, to: Number(target), kind, note: '' }, true).then(() => { setTarget(''); setOk(false); onChanged(); }, (e) => setError(String(e)))}><Icon name="link" size={12} /> Relacionar</button>
          </div></details>
        )}
        <details className="brain-inspector-details" open={m.status !== 'vigente' || undefined}>
          <summary className="lab">Vigencia y contexto</summary>
          {m.why && m.why !== m.x && <p className="mut2 brain-memory-context">{m.why}</p>}
          <div className="vig">
            {m.status === 'sustituido' ? <><span className="chip">Sustituido</span> {rels.filter((r) => r.type === 'sustituye' && r.inv).map((r) => <button key={r.id} className="lnk" onClick={() => onSel(r.to)}>Ver el recuerdo que lo sustituye</button>)}</>
              : m.status === 'caducado' ? <><span className="chip amber">Caducado</span> <span className="mut2">vigente hasta el {fecha(m.validUntil!)}</span></>
              : <><span className="chip mint">Vigente</span> <span className="mut2">{m.validUntil ? `hasta el ${fecha(m.validUntil)}` : `desde el ${fecha(full?.created ?? m.date)}`}</span></>}
          </div>
          {full && <p className="mut2">{full.share ? 'Se comparte con los agentes' : 'Privado'} · versión {full.version}</p>}
        </details>
        {error && <ErrorNote error={error} />}
      </div>
      {forget && full && (
        <Modal title="Olvidar recuerdo" onClose={() => setForget(false)}>
          <p>Se borrará «{m.x}» y sus relaciones. Los agentes dejarán de recibirlo. No se puede deshacer.</p>
          <div className="acts"><button className="tr-btn ghost" onClick={() => setForget(false)}>Cancelar</button>
            <button className="tr-btn danger" onClick={() => brain.forget(m.project, m.id, full.version!).then(onForgot, (e) => { setError(String(e)); setForget(false); })}>Olvidar</button></div>
        </Modal>
      )}
    </>
  );
}

function EntryForm({ project, draft, onClose, onSaved }: { project: string | null; draft: BrainDraft; onClose: () => void; onSaved: (id: number) => void }) {
  const [form, setForm] = useState(draft);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    if (!project) return;
    let active = true;
    taskApi.list(project).then((list) => { if (active) setTasks(list); }, (e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [project]);
  const change = (next: Partial<BrainDraft>) => {
    setOk(false);
    setForm((current) => ({ ...current, ...next }));
  };
  const date = form.validUntil == null ? null : new Date(form.validUntil * 1000);
  const until = date == null ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const valid = form.title.trim() && form.title.length <= 160 && form.body.trim() && form.body.length <= 1200 && form.source.trim() && form.source.length <= 400;
  const taskOptions = (items: Task[]) => items.map((task) => <option key={task.id} value={task.id}>#{task.id} · {task.title}</option>);
  return (
    <Modal title={draft.id == null ? 'Nuevo recuerdo' : 'Corregir recuerdo'} onClose={onClose} wide>
      <div className="brain-form">
        <label className="tr-field-row">Tipo<select value={form.kind} onChange={(e) => change({ kind: e.currentTarget.value as BrainKind })}>{KINDS.map((k) => <option key={k} value={k}>{KIND[k][2]}</option>)}</select></label>
        <label className="tr-field-row">Ámbito<select value={form.global ? 'global' : 'proyecto'} disabled={!project || draft.id != null} onChange={(e) => change(e.currentTarget.value === 'global' ? { global: true, task: null, sourceTask: null, sourceRun: null } : { global: false })}>{project && <option value="proyecto">Este proyecto</option>}<option value="global">Global (todos los proyectos)</option></select></label>
        {!form.global && <label className="tr-field-row span">Tarea del recuerdo<select value={form.task ?? ''} onChange={(e) => change({ task: Number(e.currentTarget.value) || null, sourceTask: null, sourceRun: null })}><option value="">Todo el proyecto</option>{taskOptions(tasks)}</select></label>}
        <label className="tr-field-row span">Enunciado<input data-initial-focus value={form.title} maxLength={160} onChange={(e) => change({ title: e.currentTarget.value })} /></label>
        <label className="tr-field-row span">Por qué existe<textarea rows={4} value={form.body} maxLength={1200} onChange={(e) => change({ body: e.currentTarget.value })} /></label>
        <label className="tr-field-row span">Fuente<input value={form.source} maxLength={400} placeholder="acta, PR, conversación…" onChange={(e) => change({ source: e.currentTarget.value })} /></label>
        {!form.global && <>
          <label className="tr-field-row">Tarea fuente<select value={form.sourceTask ?? ''} onChange={(e) => change({ sourceTask: Number(e.currentTarget.value) || null, sourceRun: null })}><option value="">Sin vínculo</option>{taskOptions(tasks.filter((task) => form.task == null || task.id === form.task))}</select></label>
          <label className="tr-field-row">ID de turno fuente<input type="number" min={1} step={1} disabled={form.sourceTask != null} value={form.sourceRun ?? ''} onChange={(e) => change({ sourceRun: Number(e.currentTarget.value) || null })} /></label>
        </>}
        <label className="tr-field-row">Vigente hasta<input type="datetime-local" value={until} onChange={(e) => change({ validUntil: e.currentTarget.value ? Math.floor(new Date(e.currentTarget.value).getTime() / 1000) : null })} /></label>
        <label className="tr-row" style={{ fontSize: 12, alignSelf: 'end' }}><input type="checkbox" checked={form.share} onChange={(e) => change({ share: e.currentTarget.checked })} /> Compartir con los agentes</label>
      </div>
      <label className="tr-row" style={{ fontSize: 12, marginTop: 12 }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.currentTarget.checked)} /> He revisado el contenido y su procedencia</label>
      {error && <div style={{ marginTop: 10 }}><ErrorNote error={error} /></div>}
      <div className="acts">
        <button className="tr-btn ghost" onClick={onClose}>Cancelar</button>
        {project && !form.global && draft.id == null && <button className="tr-btn ghost" disabled={!valid || busy}
          onClick={() => { setBusy(true); brain.propose(project, form).then((id) => onSaved(-id), (e) => setError(String(e))).finally(() => setBusy(false)); }}>
          Guardar como inferencia
        </button>}
        <button className={`tr-btn pearl${busy ? ' busy' : ''}`} disabled={!ok || !valid || busy} onClick={() => { setBusy(true); brain.save(project, form, true).then(onSaved, (e) => setError(String(e))).finally(() => setBusy(false)); }}>Guardar</button>
      </div>
    </Modal>
  );
}
