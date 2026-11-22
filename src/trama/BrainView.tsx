import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { brain, pr, tasks as taskApi, type BrainDraft, type BrainEntry, type BrainGraphData, type BrainKind, type BrainLink, type BrainLinkKind, type Project, type Task } from '../ipc';
import { STATUS } from '../Tasks';
import { createGraph, escapeXml, type GEdge, type GNode, type GraphHandle } from './graph';
import { ICON_PATHS, Icon } from './icons';
import { EmptyArt, Root } from './kit';
import { ErrorNote, Modal } from './ui';

// Brain de Trama v2 sobre la memoria real: brain_graph (recuerdos, tareas y PR
// con sus aristas), brain_search/entry para la ficha completa y brain_links
// para las relaciones tipadas que crea el usuario. Todo recuerdo guardado está
// confirmado; nada se presenta como inferencia ni relación verificada.
type Lens = 'map' | 'focus' | 'index' | 'ctx';
type BNode = BrainGraphData['nodes'][number];
type Mem = { id: number; key: string; k: BrainKind; x: string; why: string; source: string; date: number; project: string | null; status: 'vigente' | 'sustituido' | 'caducado'; validUntil: number | null; origins: Origin[]; used: { id: number; title: string }[] };
type Origin = { t: 'doc' | 'task' | 'pr' | 'run'; label: string; ref: string | number; url?: string | null };
export const KIND: Record<BrainKind, [string, string, string]> = {
  decision: ['Decisiones', '#9db6ff', 'decisión'],
  constraint: ['Restricciones', '#ffc27a', 'restricción'],
  preference: ['Preferencias', '#e9b4ff', 'preferencia'],
  fact: ['Hechos', '#7fe3c4', 'hecho'],
  evidence: ['Evidencias', '#7fd6ff', 'evidencia'],
  outcome: ['Resultados', '#ffc9d8', 'resultado'],
};
export const RELT: Record<BrainLinkKind, [string, string]> = { depende: ['Depende de', '#9db6ff'], refina: ['Refina', '#7fe3c4'], sustituye: ['Sustituye a', '#8d939c'], contradice: ['Contradice', '#ff6b5d'], relacionado: ['Relacionado', '#bcc1c9'] };
const ORIGT: Record<Origin['t'], [string, string]> = { task: ['flow', 'Tarea'], pr: ['pr', 'Pull request'], doc: ['source', 'Fuente'], run: ['route', 'Ejecución'] };
const KINDS = Object.keys(KIND) as BrainKind[];
const newDraft = (global: boolean): BrainDraft => ({
  id: null, version: null, global, task: null, kind: 'decision', title: '', body: '',
  source: '', sourceTask: null, sourceRun: null, share: false, validUntil: null,
});
const searchText = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
const nowS = () => Math.floor(Date.now() / 1000);
const fecha = (s: number) => new Date((s < 1e12 ? s * 1000 : s)).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
const tr = (s: string, m: number) => (s.length > m ? `${s.slice(0, m - 1)}…` : s);

function dayBoundary(value: string, end = false) {
  if (!value) return null;
  const local = new Date(`${value}T00:00:00`);
  if (end) local.setDate(local.getDate() + 1);
  return Math.floor(local.getTime() / 1000);
}

function buildMems(g: BrainGraphData, entries: Map<number, BrainEntry>, links: BrainLink[]): Mem[] {
  const byKey = new Map(g.nodes.map((n) => [n.key, n]));
  const replaced = new Map(links.filter((l) => l.kind === 'sustituye').map((l) => [l.to, l.created ?? 0]));
  return g.nodes.filter((n) => (KINDS as string[]).includes(n.kind)).map((n) => {
    const e = entries.get(n.id);
    const origins: Origin[] = [];
    if (n.source) origins.push({ t: 'doc', label: n.source, ref: n.source });
    for (const ed of g.edges) {
      if (ed.from !== n.key && ed.to !== n.key) continue;
      const other = byKey.get(ed.from === n.key ? ed.to : ed.from);
      if (!other) continue;
      if (ed.kind === 'task_source' && other.kind === 'task') origins.push({ t: 'task', label: `#${other.id} ${other.title}`, ref: other.id });
      if (ed.kind === 'pull_source' && other.kind === 'pr') origins.push({ t: 'pr', label: other.title, ref: other.id, url: other.url });
    }
    if (e?.sourceRun) origins.push({ t: 'run', label: `Ejecución #${e.sourceRun}`, ref: e.sourceRun });
    const used = g.edges.filter((ed) => ed.kind === 'scope' && (ed.from === n.key || ed.to === n.key)).map((ed) => byKey.get(ed.from === n.key ? ed.to : ed.from)).filter((o): o is BNode => !!o && o.kind === 'task').map((o) => ({ id: o.id, title: o.title }));
    const vu = e?.validUntil ?? null;
    return { id: n.id, key: n.key, k: n.kind as BrainKind, x: n.title, why: n.body ?? e?.body ?? '', source: n.source ?? e?.source ?? '', date: n.date, project: n.project, status: replaced.has(n.id) ? 'sustituido' : vu != null && vu <= nowS() ? 'caducado' : 'vigente', validUntil: vu, origins, used };
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
  const [entries, setEntries] = useState<Map<number, BrainEntry>>(new Map());
  const [links, setLinks] = useState<BrainLink[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [hist, setHist] = useState<number[]>([]);
  const [q, setQ] = useState('');
  const [fk, setFk] = useState<BrainKind | 'all'>('all');
  const [fv, setFv] = useState<'all' | 'vigente' | 'sustituido' | 'caducado'>('all');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: BrainDraft; project: string | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const [inspOpen, setInspOpen] = useState(false);

  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    if (!validDays) return;
    try {
      const [g, e, l] = await Promise.all([
        brain.graph({ query: null, project: p, kind: null, from, until }),
        brain.search(p, '', null).catch(() => [] as BrainEntry[]),
        linkProject ? brain.links(linkProject).catch(() => [] as BrainLink[]) : Promise.resolve([] as BrainLink[]),
      ]);
      if (request !== latest.current) return;
      setGraph(g); setEntries(new Map(e.map((x) => [x.id!, x]))); setLinks(l); setError(null);
    } catch (err) { if (request === latest.current) setError(String(err)); }
  }, [p, linkProject, validDays, from, until]);
  useEffect(() => {
    setGraph(null);
    setEntries(new Map());
    setLinks([]);
    void load();
    return () => { latest.current++; };
  }, [load]);
  useEffect(() => { setSel(null); setFocus(null); setHist([]); }, [p, fromDay, toDay]);

  const mems = useMemo(() => graph ? buildMems(graph, entries, links) : [], [graph, entries, links]);
  const filtered = useMemo(() => {
    const terms = searchText(q).trim().split(/\s+/).filter(Boolean);
    return mems.filter((m) => (fk === 'all' || m.k === fk) && (fv === 'all' || m.status === fv) &&
      terms.every((term) => searchText(`${m.x} ${m.why} ${m.source}`).includes(term)));
  }, [mems, q, fk, fv]);
  const m = sel != null ? mems.find((x) => x.id === sel) ?? null : null;
  const pick = (id: number | null) => { setSel(id); if (id != null) setInspOpen(true); };
  const openFocus = (id: number) => { setHist([]); setFocus(id); setSel(id); setLens('focus'); };

  const vig = mems.filter((x) => x.status === 'vigente').length;
  const empty = graph && mems.length === 0;
  return (
    <Root label="Brain">
      <div className={`brain${inspOpen ? ' insp-open' : ''}`}>
        <div className="brainh">
          <h2 className="vt">Brain</h2>
          <span className="chip">{vig} vigentes</span>
          {mems.length - vig > 0 && <span className="chip dash">{mems.length - vig} sustituidos o caducados</span>}
          <label className="bsearch"><Icon name="search" size={14} /><input placeholder="Buscar en la memoria" value={q} onChange={(e) => setQ(e.currentTarget.value)} aria-label="Buscar en la memoria" /></label>
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
              <button key={id} className={lens === id ? 'on' : ''} aria-pressed={lens === id} disabled={id === 'ctx' && p == null} onClick={() => { if (id === 'focus' && focus == null && sel != null) setFocus(sel); setLens(id); }}><Icon name={ic} size={14} /><span className="hide-s">{l}</span></button>
            ))}
          </div>
          <button className="btn sm" onClick={() => setEditing({ project: p, draft: newDraft(p == null) })}><Icon name="plus" size={12} /> Recuerdo</button>
          <button className="tbtn narrow-only" onClick={() => setInspOpen(!inspOpen)} aria-label="Ficha"><Icon name="panel" size={16} /></button>
        </div>
        {lens !== 'ctx' && (
          <div className="bfilters" role="group" aria-label="Filtros">
            <label className="fsel"><span className="sr">Tipo</span><select value={fk} onChange={(e) => setFk(e.currentTarget.value as BrainKind | 'all')} aria-label="Tipo"><option value="all">Todos los tipos</option>{KINDS.map((k) => <option key={k} value={k}>{KIND[k][0]}</option>)}</select><Icon name="down" size={11} /></label>
            <label className="fsel"><span className="sr">Vigencia</span><select value={fv} onChange={(e) => setFv(e.currentTarget.value as typeof fv)} aria-label="Vigencia"><option value="all">Cualquier vigencia</option><option value="vigente">Vigentes</option><option value="sustituido">Sustituidos</option><option value="caducado">Caducados</option></select><Icon name="down" size={11} /></label>
            <details className="brain-dates">
              <summary className="btn sm ghost">{fromDay || toDay ? 'Fechas activas' : 'Fechas'}</summary>
              <div className="brain-date-fields">
                <label className="tr-field-row">Desde<input type="date" value={fromDay} onChange={(e) => setFromDay(e.currentTarget.value)} /></label>
                <label className="tr-field-row">Hasta<input type="date" value={toDay} onChange={(e) => setToDay(e.currentTarget.value)} /></label>
                <button className="btn sm" onClick={() => { setFromDay(''); setToDay(''); }}>Quitar fechas</button>
              </div>
            </details>
            <span className="mut2 bcount">{filtered.length} de {mems.length}{graph?.limited && ' · vista parcial'}</span>
            {lens === 'focus' && hist.length > 0 && <button className="btn sm ghost" onClick={() => { const h = [...hist]; const prev = h.pop()!; setHist(h); setFocus(prev); setSel(prev); }}><Icon name="back" size={12} /> Volver</button>}
            <span className="grow" />
            <span className="blegend">{(Object.keys(RELT) as BrainLinkKind[]).map((k) => <span key={k}><svg width="22" height="8" aria-hidden="true"><path className={`ge r-${k} lg`} d="M1 4H21" /></svg>{RELT[k][0].toLowerCase()}</span>)}</span>
          </div>
        )}
        <div className="stage bstage">
          {error && <div className="flow-err" role="alert"><Icon name="warn" size={14} /> {error} <button className="btn sm" onClick={() => void load()}>Reintentar</button></div>}
          {!validDays ? <div className="empty sm" role="status">Elige una fecha final igual o posterior al inicio.</div>
            : !graph ? <div className="flow-loading"><span className="spin" /></div>
            : empty && (from != null || until != null) ? <div className="empty sm" role="status">Sin recuerdos en estas fechas.</div>
            : empty && lens !== 'ctx' ? (
              <div className="empty big"><EmptyArt /><h3>{p == null ? 'Aún no hay memoria' : `${projectName} aún no tiene memoria`}</h3>
                <p>Brain guarda decisiones, restricciones, preferencias, hechos, evidencias y resultados que <b>confirmas</b>, con su fuente. Los agentes los reciben como contexto cuando son relevantes para su tarea.</p>
                <div className="row"><button className="btn pearl" onClick={() => setEditing({ project: p, draft: newDraft(p == null) })}><Icon name="plus" size={13} /> Añadir el primer recuerdo…</button></div>
                <span className="sample">Nada se guarda sin tu confirmación.</span>
              </div>
            ) : lens === 'map' || lens === 'focus' ? (
              <BrainGraphView lens={lens} mems={filtered} all={mems} links={links} sel={sel} focus={focus ?? sel ?? filtered[0]?.id ?? null} q={q}
                onSel={pick} onFocus={openFocus} onRel={(id) => { if (focus != null) setHist([...hist, focus]); setFocus(id); setSel(id); }}
                onMore={(k) => { setFk(k); setLens('index'); }} onTask={onOpenTask} onError={setError} />
            ) : lens === 'index' ? <MemIndex mems={filtered} sel={sel} onSel={pick} onFocus={openFocus} q={q} onClear={() => { setQ(''); setFk('all'); setFv('all'); }} />
            : p && <Ctx key={p} project={p} mems={mems} />}
        </div>
        <aside className="insp" id="binsp" aria-label="Ficha del recuerdo">
          {m ? <Insp key={`${m.id}:${revision}`} m={m} mems={mems} links={links} project={linkProject} entry={entries.get(m.id) ?? null} scopeAll={p == null} lens={lens}
            onSel={pick} onFocus={openFocus} onTask={onOpenTask} onEdit={(draft) => setEditing({ draft, project: m.project })} onChanged={load} onForgot={() => { setSel(null); void load(); }} />
            : (
              <>
                <div className="sec"><h3>Memoria {p == null ? 'de todos los proyectos' : 'del proyecto'}</h3><p className="mut2">Conocimiento confirmado y su procedencia. No reentrena modelos: aporta contexto a cada turno.</p></div>
                <div className="sec">{KINDS.map((k) => <div key={k} className="agline"><i className="kd" style={{ background: KIND[k][1] }} /><span className="grow">{KIND[k][0]}</span><span className="mono mut2">{mems.filter((x) => x.k === k).length}</span></div>)}</div>
                <div className="sec"><div className="why">Las tareas y los agentes viven en Flow; aquí solo hay conocimiento y su procedencia. Las relaciones solo existen si las creas tú.</div></div>
              </>
            )}
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
  if (n.kind === 'more') return `<rect class="body more" x="-110" y="-18" width="220" height="36" rx="18"/><text x="0" y="5" text-anchor="middle" class="s">+ ${n.n} más · abrir en Índice</text>`;
  if (n.kind === 'none') return `<rect class="body none" x="-110" y="-18" width="220" height="36" rx="10"/><text x="0" y="5" text-anchor="middle" class="s">Ningún recuerdo con estos filtros</text>`;
  if (n.kind === 'origin') { const o = n.o as Origin, ic = ORIGT[o.t]; return `<rect class="body org" x="-120" y="-23" width="240" height="46" rx="10"/><g transform="translate(-106,-8) scale(.68)" class="oic" fill="none" stroke="currentColor" stroke-width="1.6">${ICON_PATHS[ic[0]] ?? ''}</g><text x="-84" y="-3">${escapeXml(tr(o.label, 28))}</text><text class="s" x="-84" y="13">${ic[1]}</text>`; }
  if (n.kind === 'use') { const t = n.t as { id: number; title: string }; return `<rect class="body use" x="-90" y="-22" width="180" height="44" rx="10"/><circle cx="-74" cy="-4" r="3.6" fill="#9db6ff"/><text x="-64" y="0">#${t.id} · ${escapeXml(tr(t.title, 17))}</text><text class="s" x="-64" y="15">tarea</text>`; }
  const m = n.m as Mem, c = KIND[m.k][1];
  const state = m.status === 'vigente' ? `confirmado · ${fecha(m.date)}` : m.status === 'sustituido' ? 'sustituido' : 'caducado';
  if (n.kind === 'center') return `<rect class="body center" x="-160" y="-46" width="320" height="92" rx="14" style="stroke:${c}"/><circle cx="-140" cy="-26" r="4.5" fill="${c}" stroke="${c}"/><text x="-128" y="-22" class="s">${KIND[m.k][2]} · ${state}</text>${wrapText(m.x, 40, -140, 0, 2)}`;
  const w = n.w;
  return `<rect class="body" x="-${w / 2}" y="-${n.h / 2}" width="${w}" height="${n.h}" rx="10"/><circle cx="${-w / 2 + 14}" cy="-6" r="4" fill="${c}" stroke="${c}" stroke-width="1.3"/><text x="${-w / 2 + 26}" y="-2" class="${m.status === 'sustituido' ? 'strike' : ''}">${escapeXml(tr(m.x, 30))}</text><text class="s" x="${-w / 2 + 26}" y="13">${state}${m.project && n.showProject ? ` · ${escapeXml(m.project.split('/').pop() ?? '')}` : ''}</text>`;
}

function mapModel(mems: Mem[], links: BrainLink[], width: number, height: number, showProject: boolean) {
  const nodes: GNode[] = [], edges: GEdge[] = [], under: string[] = [];
  const PER = 10, CW = 244, ncol = Math.max(2, Math.min(5, Math.round(width / (height > 520 ? 330 : 250))));
  const present = KINDS.filter((k) => mems.some((m) => m.k === k));
  const ks = present.length ? present : KINDS.slice(0, 1);
  let y0 = 0;
  for (let r = 0; r * ncol < ks.length; r++) {
    const row = ks.slice(r * ncol, (r + 1) * ncol); let rowMax = 1;
    row.forEach((k, c) => {
      const all = mems.filter((m) => m.k === k).sort((a, b) => Number(a.status !== 'vigente') - Number(b.status !== 'vigente') || b.date - a.date);
      const shown = all.slice(0, PER), x = c * CW;
      rowMax = Math.max(rowMax, shown.length + (all.length > PER ? 1 : 0));
      under.push(`<g class="mcol"><text x="${x - 110}" y="${y0 - 36}" class="mch">${KIND[k][0]}</text><text x="${x - 110}" y="${y0 - 18}" class="mcs">${all.filter((m) => m.status === 'vigente').length} vigentes${all.some((m) => m.status !== 'vigente') ? ` · ${all.filter((m) => m.status !== 'vigente').length} retirados` : ''}</text><line x1="${x - 110}" x2="${x + 110}" y1="${y0 - 8}" y2="${y0 - 8}" stroke="${KIND[k][1]}" stroke-opacity=".5"/></g>`);
      shown.forEach((m, i) => nodes.push({ id: String(m.id), kind: 'mem', m, showProject, x, y: y0 + 24 + i * 54, w: 220, h: 44, cls: `mk-${k} ${m.status === 'sustituido' ? 'sup' : ''}`, aria: `${KIND[k][2]}: ${m.x}` }));
      if (all.length > PER) nodes.push({ id: `more-${k}`, kind: 'more', k, n: all.length - PER, x, y: y0 + 24 + PER * 54, w: 220, h: 36, aria: `${all.length - PER} más` });
      if (!all.length) nodes.push({ id: `none-${k}`, kind: 'none', x, y: y0 + 24, w: 220, h: 36, aria: 'sin recuerdos' });
    });
    y0 += rowMax * 54 + 90;
  }
  const ids = new Set(nodes.map((n) => n.id));
  links.forEach((l) => { if (ids.has(String(l.from)) && ids.has(String(l.to))) edges.push({ from: String(l.from), to: String(l.to), cls: `r-${l.kind}` }); });
  return { nodes, edges, under: () => under.join('') };
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
  if (a.kind === 'mem' && b.kind === 'mem') {
    if (Math.abs(a.y - b.y) > 120 && Math.abs(a.x - b.x) > 10) { const y1 = a.y + (b.y > a.y ? a.h / 2 : -a.h / 2), y2 = b.y + (b.y > a.y ? -b.h / 2 : b.h / 2); return `M${a.x},${y1} C${a.x},${(y1 + y2) / 2} ${b.x},${(y1 + y2) / 2} ${b.x},${y2}`; }
    if (Math.abs(a.x - b.x) < 10) { const x = a.x + a.w / 2; return `M${x},${a.y} C${x + 40},${a.y} ${x + 40},${b.y} ${x + 2},${b.y}`; }
    const d = b.x > a.x ? 1 : -1, x1 = a.x + (d * a.w) / 2, x2 = b.x - (d * b.w) / 2;
    return `M${x1},${a.y} C${(x1 + x2) / 2},${a.y} ${(x1 + x2) / 2},${b.y} ${x2},${b.y}`;
  }
  return null;
};

function BrainGraphView({ lens, mems, all, links, sel, focus, q, onSel, onFocus, onRel, onMore, onTask, onError }: {
  lens: 'map' | 'focus'; mems: Mem[]; all: Mem[]; links: BrainLink[]; sel: number | null; focus: number | null; q: string;
  onSel: (id: number | null) => void; onFocus: (id: number) => void; onRel: (id: number) => void; onMore: (k: BrainKind) => void; onTask: (id: number, project: string | null) => void; onError: (error: string) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const g = useRef<GraphHandle | null>(null);
  const cb = useRef({ onSel, onFocus, onRel, onMore, onTask, onError });
  cb.current = { onSel, onFocus, onRel, onMore, onTask, onError };
  const showProject = new Set(all.map((m) => m.project)).size > 1;
  const fm = focus != null ? all.find((x) => x.id === focus) : undefined;
  const sig = `${lens}|${focus}|${mems.map((m) => `${m.id}:${m.status}`).join(',')}|${links.map((l) => `${l.id}`).join(',')}`;
  useEffect(() => {
    const el = svg.current!;
    const model = lens === 'focus' && fm ? focusModel(fm, all, links) : mapModel(mems, links, el.clientWidth || 1000, el.clientHeight || 600, showProject);
    const byId = () => g.current!.nodes;
    if (!g.current) {
      g.current = createGraph(el, {
        nodes: model.nodes, edges: model.edges, under: model.under, node: memNode, edgePath: brainEdgePath, dim: lens === 'map',
        selected: lens === 'focus' ? (fm ? String(fm.id) : null) : sel != null ? String(sel) : null, pad: lens === 'focus' ? [60, 240, 60, 160] : [60, 30, 30, 30], maxFit: lens === 'focus' ? 1.1 : 1, minFit: 0.5,
        label: 'Mapa de conocimiento: flechas para moverse, Intro abre el foco',
        onSelect: (id) => {
          if (!id) { cb.current.onSel(null); return; }
          const n = byId().find((x) => x.id === id);
          if (!n) return;
          if (n.kind === 'more') return cb.current.onMore(n.k as BrainKind);
          if (n.kind === 'none') return;
          if (n.kind === 'rel') return cb.current.onRel(n.ref as number);
          if (n.kind === 'origin') { const o = n.o as Origin; if (o.t === 'task') cb.current.onTask(o.ref as number, (byId().find((x) => x.kind === 'center')?.m as Mem | undefined)?.project ?? null); else if (o.t === 'pr' && o.url) void pr.open(o.url).catch((e) => cb.current.onError(String(e))); return; }
          if (n.kind === 'use') { const t = n.t as { id: number }; cb.current.onTask(t.id, (byId().find((x) => x.kind === 'center')?.m as Mem | undefined)?.project ?? null); return; }
          cb.current.onSel((n.m as Mem).id);
        },
        onOpen: (id) => { const n = byId().find((x) => x.id === id); if (n?.kind === 'mem') cb.current.onFocus((n.m as Mem).id); },
        onKey: (k, s) => {
          const ns = byId().filter((x) => x.kind !== 'more' && x.kind !== 'none');
          const n = ns.find((x) => x.id === s);
          if (!n) return ns[0]?.id ?? null;
          const cand = ns.filter((x) => x !== n && (k === 'ArrowRight' ? x.x > n.x + 10 : k === 'ArrowLeft' ? x.x < n.x - 10 : k === 'ArrowDown' ? x.y > n.y + 5 && Math.abs(x.x - n.x) < 60 : x.y < n.y - 5 && Math.abs(x.x - n.x) < 60));
          cand.sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y));
          return cand[0]?.id ?? null;
        },
      });
    } else { g.current.setPad(lens === 'focus' ? [60, 240, 60, 160] : [60, 30, 30, 30]); g.current.morph(model.nodes, model.edges, model.under); }
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
            <div key={m.id} data-mem={m.id} className={`mem${m.status === 'sustituido' ? ' sup' : ''}${sel === m.id ? ' sel' : ''}`} role="option" aria-selected={sel === m.id} tabIndex={sel === m.id || (sel == null && m === l[0]) ? 0 : -1}
              onClick={() => onSel(m.id)} onDoubleClick={() => onFocus(m.id)} onKeyDown={(e) => e.key === 'Enter' && onFocus(m.id)}>
              <span className="mk" style={{ ['--c' as string]: KIND[k][1] }} />
              <div><div className="mt">{m.x}</div><div className="ms">confirmado · {fecha(m.date)}{m.source ? ` · ${m.source}` : ''}{m.used.length ? ` · acotado a ${m.used.length} ${m.used.length === 1 ? 'tarea' : 'tareas'}` : ''}{m.project ? ` · ${m.project.split('/').pop()}` : ' · global'}</div></div>
              <div className="col" style={{ gap: 4, alignItems: 'flex-end' }}>{m.status === 'sustituido' ? <span className="chip">sustituido</span> : m.status === 'caducado' ? <span className="chip amber">caducado</span> : null}</div>
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

function Insp({ m, mems, links, project, entry, scopeAll, lens, onSel, onFocus, onTask, onEdit, onChanged, onForgot }: {
  m: Mem; mems: Mem[]; links: BrainLink[]; project: string | null; entry: BrainEntry | null; scopeAll: boolean; lens: Lens;
  onSel: (id: number) => void; onFocus: (id: number) => void; onTask: (id: number, project: string | null) => void; onEdit: (d: BrainDraft) => void; onChanged: () => void; onForgot: () => void;
}) {
  const [fetched, setFetched] = useState<BrainEntry | null>(null);
  const full = entry ?? fetched;
  const [target, setTarget] = useState<number | ''>('');
  const [kind, setKind] = useState<BrainLinkKind>('relacionado');
  const [ok, setOk] = useState(false);
  const [forget, setForget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (entry) return;
    let active = true;
    brain.entry(m.project, m.id).then((value) => {
      if (active) setFetched(value);
    }, (error) => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [entry, m.id, m.project]);
  const c = KIND[m.k][1];
  const rels = relsOf(m, links);
  const grouped: Record<string, typeof rels> = {};
  rels.forEach((r) => { (grouped[`${r.type}:${r.inv}`] = grouped[`${r.type}:${r.inv}`] || []).push(r); });
  const sameProject = !scopeAll || m.project === project || m.project == null;
  return (
    <>
      <div className="sec">
        <div className="row" style={{ marginBottom: 8 }}><i className="kd" style={{ ['--c' as string]: c, background: c }} /><span className="lab">{KIND[m.k][0]}</span><span className="grow" /><span className="chip mint"><Icon name="check" size={10} /> Confirmado</span></div>
        <p className={`statement${m.status === 'sustituido' ? ' strike' : ''}`}>{m.x}</p>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button className="btn sm" disabled={!full} onClick={() => full && onEdit(full)}><Icon name="edit" size={12} /> Corregir</button>
          {lens !== 'focus' && <button className="btn sm" onClick={() => onFocus(m.id)}><Icon name="focus" size={12} /> Foco</button>}
          <span className="grow" />
          <button className="btn sm danger" disabled={!full} onClick={() => setForget(true)}>Olvidar</button>
        </div>
      </div>
      <div className="sec"><span className="lab">Por qué existe</span><p className="mut2" style={{ margin: '6px 0 8px', whiteSpace: 'pre-wrap' }}>{m.why || 'Sin justificación registrada.'}</p>
        <div className="col" style={{ gap: 4 }}>{m.origins.map((o, i) => (
          <button key={i} className="orow" onClick={() => { if (o.t === 'task') onTask(o.ref as number, m.project); else if (o.t === 'pr' && o.url) void pr.open(o.url).catch((e) => setError(String(e))); }}>
            <Icon name={ORIGT[o.t][0]} size={14} /><span className="grow">{o.label}</span><span className="mut">{ORIGT[o.t][1]}</span>
          </button>))}</div>
      </div>
      <div className="sec"><span className="lab">Vigencia</span><div className="vig">
        {m.status === 'sustituido' ? <><span className="chip">Sustituido</span> {rels.filter((r) => r.type === 'sustituye' && r.inv).map((r) => <button key={r.id} className="lnk" onClick={() => onSel(r.to)}>Ver el recuerdo que lo sustituye</button>)}</>
          : m.status === 'caducado' ? <><span className="chip amber">Caducado</span> <span className="mut2">vigente hasta el {fecha(m.validUntil!)}</span></>
          : <><span className="chip mint">Vigente</span> <span className="mut2">{m.validUntil ? `hasta el ${fecha(m.validUntil)}` : `desde el ${fecha(full?.created ?? m.date)}`}</span></>}
      </div>{full && <div className="mut2" style={{ marginTop: 6, fontSize: 12 }}>{full.global ? 'Global' : full.task ? `Acotado a la tarea #${full.task}` : 'Del proyecto'} · {full.share ? 'se comparte con los agentes' : 'privado'} · versión {full.version}</div>}</div>
      <div className="sec"><span className="lab">Relaciones</span>
        {Object.keys(grouped).length ? Object.values(grouped).map((rs) => (
          <div key={`${rs[0].type}${rs[0].inv}`} className="relg"><span className="relt" style={{ color: RELT[rs[0].type][1] }}>{relLabel(rs[0].type, rs[0].inv)}</span>
            {rs.map((r) => { const o = mems.find((x) => x.id === r.to); return o ? <div key={r.id} className="relrow"><button className="lnk" onClick={() => onSel(o.id)}>{o.x}</button><button className="tbtn" aria-label="Quitar relación" onClick={() => project && brain.unlink(project, r.id).then(onChanged, (e) => setError(String(e)))}><Icon name="close" size={11} /></button></div> : null; })}
          </div>)) : <p className="mut2">Sin relaciones registradas. Filigranas no inventa relaciones: solo existen las que creas aquí.</p>}
        {project && sameProject && (
          <div className="col" style={{ gap: 6, marginTop: 8 }}>
            <div className="row">
              <label className="fsel"><select value={kind} onChange={(e) => setKind(e.currentTarget.value as BrainLinkKind)} aria-label="Tipo de relación">{(Object.keys(RELT) as BrainLinkKind[]).map((k) => <option key={k} value={k}>{RELT[k][0]}</option>)}</select><Icon name="down" size={11} /></label>
              <label className="fsel wide" style={{ flex: 1 }}><select value={target} onChange={(e) => setTarget(e.currentTarget.value ? Number(e.currentTarget.value) : '')} aria-label="Recuerdo relacionado"><option value="">Elige un recuerdo…</option>{mems.filter((x) => x.id !== m.id && (x.project === project || x.project == null)).map((x) => <option key={x.id} value={x.id}>{tr(x.x, 60)}</option>)}</select><Icon name="down" size={11} /></label>
            </div>
            <label className="row" style={{ fontSize: 12 }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.currentTarget.checked)} /> Confirmo que esta relación es correcta</label>
            <button className="btn sm" disabled={!ok || target === ''} onClick={() => brain.link(project, { id: null, from: m.id, to: Number(target), kind, note: '' }, true).then(() => { setTarget(''); setOk(false); onChanged(); }, (e) => setError(String(e)))}><Icon name="link" size={12} /> Relacionar</button>
          </div>
        )}
        {error && <ErrorNote error={error} />}
      </div>
      <div className="sec"><span className="lab">Aplicado en</span><div className="row wrap" style={{ marginTop: 6 }}>{m.used.length ? m.used.map((t) => <button key={t.id} className="chip btnchip" onClick={() => onTask(t.id, m.project)}>#{t.id} · {tr(t.title, 26)}</button>) : <span className="mut2">{full?.global ? 'Global: puede enviarse a cualquier tarea relevante' : 'Se envía a las tareas del proyecto cuando es relevante'}</span>}</div></div>
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
        <label className="tr-field-row span">Enunciado<input autoFocus value={form.title} maxLength={160} onChange={(e) => change({ title: e.currentTarget.value })} /></label>
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
        <button className={`tr-btn pearl${busy ? ' busy' : ''}`} disabled={!ok || !valid || busy} onClick={() => { setBusy(true); brain.save(project, form, true).then(onSaved, (e) => setError(String(e))).finally(() => setBusy(false)); }}>Guardar</button>
      </div>
    </Modal>
  );
}
