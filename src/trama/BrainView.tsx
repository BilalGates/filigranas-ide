import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { brain, tasks as taskApi, type BrainDraft, type BrainEntry, type BrainGraphData, type BrainKind, type BrainLink, type BrainLinkKind, type Task } from '../ipc';
import { createGraph, escapeXml, type GEdge, type GNode, type GraphHandle } from './graph';
import { Icon } from './icons';
import { Empty, ErrorNote, Modal, Seg } from './ui';

// Brain: memoria del proyecto sobre las tablas reales (brain_entries y la
// tabla aditiva brain_links). Todo recuerdo existe porque alguien lo
// confirmó; las relaciones tipadas solo las crea el usuario. Nada se
// convierte solo en decisión ni en relación verificada.
type Lens = 'mapa' | 'foco' | 'indice' | 'contexto';
export const KIND: Record<string, { label: string; color: string }> = {
  decision: { label: 'Decisión', color: '#9db6ff' },
  constraint: { label: 'Restricción', color: '#ffb25e' },
  preference: { label: 'Preferencia', color: '#b09cff' },
  fact: { label: 'Hecho', color: '#dfe3ea' },
  evidence: { label: 'Evidencia', color: '#6fe0b3' },
  outcome: { label: 'Resultado', color: '#ffc9d8' },
  task: { label: 'Tarea', color: '#5c6168' },
  pr: { label: 'PR', color: '#6fe0b3' },
  project: { label: 'Proyecto', color: '#ffffff' },
};
export const LINK: Record<BrainLinkKind, string> = { depende: 'depende de', refina: 'refina', sustituye: 'sustituye a', contradice: 'contradice', relacionado: 'relacionado con' };
const KINDS: BrainKind[] = ['decision', 'constraint', 'preference', 'fact', 'evidence', 'outcome'];
const now = () => Math.floor(Date.now() / 1000);
const fecha = (s: number) => new Date(s * 1000).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

export default function BrainView({ project, projectName, onOpenTask }: { project: string | null; projectName: string | null; onOpenTask: (id: number) => void }) {
  const [lens, setLensState] = useState<Lens>(() => {
    try { const v = localStorage.getItem('filigranas.brain.lente') as Lens | null; return v && ['mapa', 'foco', 'indice', 'contexto'].includes(v) ? v : 'mapa'; } catch { return 'mapa'; }
  });
  const setLens = (l: Lens) => { setLensState(l); try { localStorage.setItem('filigranas.brain.lente', l); } catch { /* */ } };
  const [graph, setGraph] = useState<BrainGraphData | null>(null);
  const [entries, setEntries] = useState<BrainEntry[] | null>(null);
  const [links, setLinks] = useState<BrainLink[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<BrainKind | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BrainDraft | null>(null);

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const [g, e, l] = await Promise.all([
        brain.graph({ query: null, project, kind: null, from: null, until: null }),
        brain.search(project, query.trim(), kind || null),
        brain.links(project).catch(() => [] as BrainLink[]),
      ]);
      setGraph(g); setEntries(e); setLinks(l); setError(null);
    } catch (e) { setError(String(e)); }
  }, [project, query, kind]);
  useEffect(() => { const t = window.setTimeout(load, query ? 220 : 0); return () => window.clearTimeout(t); }, [load, query]);

  const all = useMemo(() => {
    // entradas visibles en el grafo + las de la búsqueda, sin duplicados
    const map = new Map<number, BrainEntry>();
    for (const e of entries ?? []) map.set(e.id!, e);
    return map;
  }, [entries]);
  const replaced = useMemo(() => new Set(links.filter((l) => l.kind === 'sustituye').map((l) => l.to)), [links]);
  const entry = selected != null ? all.get(selected) ?? null : null;
  const [loaded, setLoaded] = useState<BrainEntry | null>(null);
  useEffect(() => {
    if (selected == null || all.has(selected) || !project) { setLoaded(null); return; }
    brain.entry(project, selected).then(setLoaded, () => setLoaded(null));
  }, [selected, all, project]);
  const current = entry ?? loaded;

  if (!project) return <section className="tr-dest" aria-label="Brain"><Empty icon="brain" title="Elige un proyecto">Brain muestra la memoria confirmada del proyecto abierto.</Empty></section>;
  const memories = graph?.nodes.filter((n) => KINDS.includes(n.kind as BrainKind)).length ?? 0;
  return (
    <section className="tr-dest tr-brain" aria-label="Brain">
      <header className="tr-head">
        <div><h1>Brain</h1><div className="sub">{projectName} · {graph ? `${memories} recuerdos · ${links.length} relaciones` : 'cargando…'}</div></div>
        <span className="grow" />
        <input type="search" className="tr-input" style={{ width: 200 }} placeholder="Buscar en la memoria" value={query} onChange={(e) => setQuery(e.currentTarget.value)} aria-label="Buscar en la memoria" />
        <select className="tr-input" value={kind} onChange={(e) => setKind(e.currentTarget.value as BrainKind | '')} aria-label="Tipo">
          <option value="">Todos los tipos</option>
          {KINDS.map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}
        </select>
        <button className="tr-btn sm" onClick={() => setEditing({ id: null, version: null, global: false, task: null, kind: 'decision', title: '', body: '', source: '', sourceTask: null, sourceRun: null, share: true, validUntil: null })}><Icon name="plus" size={13} /> Recuerdo</button>
        <Seg label="Vista" value={lens} onChange={setLens} items={[{ id: 'mapa', label: 'Mapa', icon: 'graph' }, { id: 'foco', label: 'Foco', icon: 'focus' }, { id: 'indice', label: 'Índice', icon: 'list' }, { id: 'contexto', label: 'Contexto', icon: 'layers' }]} />
      </header>
      {error && <div style={{ padding: '10px 18px 0' }}><ErrorNote error={error} onRetry={() => void load()} /></div>}
      <div className={`tr-split${current && lens !== 'contexto' ? '' : ' no-insp'}`}>
        <div className="flow-main">
          {graph === null && !error ? <div className="tr-loading"><div className="tr-skel" style={{ height: 160 }} /></div>
            : lens === 'mapa' || lens === 'foco' ? (
              memories === 0 ? <Empty icon="brain" title="Sin recuerdos todavía">Los recuerdos se guardan siempre con confirmación: decisiones, restricciones, hechos y resultados con su fuente.</Empty>
                : <BrainMap data={graph!} links={links} focus={lens === 'foco' ? selected : null} selected={selected} replaced={replaced} query={query}
                    onSelect={(key) => { const id = key?.startsWith('m:') ? Number(key.slice(2)) : null; if (key?.startsWith('t:')) onOpenTask(Number(key.slice(2))); else setSelected(id); }} />
            ) : lens === 'indice' ? <Index entries={entries ?? []} selected={selected} replaced={replaced} onSelect={setSelected} />
            : <Context project={project} />}
          {lens === 'foco' && selected == null && memories > 0 && <div className="studio-hint">Elige un recuerdo para centrar la vista en él y sus relaciones.</div>}
        </div>
        {current && lens !== 'contexto' && (
          <Inspector key={`${current.id}:${current.version}`} project={project} entry={current} all={all} links={links} replaced={replaced}
            onClose={() => setSelected(null)} onSelect={setSelected} onEdit={() => setEditing(current)} onChanged={load} onForgotten={() => { setSelected(null); void load(); }} />
        )}
      </div>
      {editing && <EntryForm project={project} draft={editing} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); setSelected(id); void load(); }} />}
    </section>
  );
}

function BrainMap({ data, links, focus, selected, replaced, query, onSelect }: {
  data: BrainGraphData; links: BrainLink[]; focus: number | null; selected: number | null; replaced: Set<number>; query: string; onSelect: (key: string | null) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const g = useRef<GraphHandle | null>(null);
  const cb = useRef(onSelect);
  cb.current = onSelect;
  const replacedRef = useRef(replaced);
  replacedRef.current = replaced;
  const model = useMemo(() => {
    const byKey = new Map(data.nodes.map((n) => [n.key, n]));
    let edges: GEdge[] = data.edges.filter((e) => e.kind !== 'project_member').map((e) => ({ from: e.from, to: e.to, cls: `r-${e.kind}`, kind: e.kind }));
    for (const l of links) if (byKey.has(`m:${l.from}`) && byKey.has(`m:${l.to}`)) edges.push({ from: `m:${l.from}`, to: `m:${l.to}`, cls: `r-${l.kind}`, kind: l.kind, marker: 'rel' });
    let keep = new Set(data.nodes.map((n) => n.key));
    if (focus != null) {
      const center = `m:${focus}`;
      keep = new Set([center]);
      for (const e of edges) { if (e.from === center) keep.add(e.to); if (e.to === center) keep.add(e.from); }
      edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    }
    const shown = data.nodes.filter((n) => keep.has(n.key) && (focus != null || n.kind !== 'project'));
    const nodes: GNode[] = [];
    if (focus != null) {
      const others = shown.filter((n) => n.key !== `m:${focus}`);
      shown.filter((n) => n.key === `m:${focus}`).forEach((n) => nodes.push({ id: n.key, x: 0, y: 0, w: 40, h: 40, aria: n.title }));
      others.forEach((n, i) => { const a = (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2; nodes.push({ id: n.key, x: Math.cos(a) * 260, y: Math.sin(a) * 200, w: 26, h: 26, aria: n.title }); });
    } else {
      // sectores por tipo; las tareas y PR en el anillo exterior
      const groups = [...KINDS, 'task', 'pr'].map((k) => shown.filter((n) => n.kind === k)).filter((x) => x.length);
      const total = groups.reduce((s, x) => s + x.length, 0);
      let at = -Math.PI / 2;
      for (const group of groups) {
        const span = (group.length / total) * Math.PI * 2;
        group.sort((a, b) => b.date - a.date).forEach((n, i) => {
          const a = at + span * ((i + 0.5) / group.length);
          const outer = n.kind === 'task' || n.kind === 'pr';
          const r = outer ? 420 : 180 + (i % 3) * 70;
          nodes.push({ id: n.key, x: Math.cos(a) * r, y: Math.sin(a) * r * 0.78, w: 26, h: 26, aria: n.title });
        });
        at += span;
      }
    }
    return { nodes, edges, byKey };
  }, [data, links, focus]);

  const byKeyRef = useRef(model.byKey);
  byKeyRef.current = model.byKey;
  useEffect(() => {
    const draw = (n: GNode, sel: boolean) => {
      const d = byKeyRef.current.get(n.id);
      if (!d) return '';
      const replaced = replacedRef.current;
      const k = KIND[d.kind] ?? KIND.fact;
      const memory = KINDS.includes(d.kind as BrainKind);
      const old = memory && replaced.has(d.id);
      const r = n.w / 2 - 4;
      const label = d.title.length > 34 ? `${d.title.slice(0, 33)}…` : d.title;
      const shape = d.kind === 'task' ? `<rect class="core" x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}" rx="3" fill="none" stroke="${k.color}"/>`
        : d.kind === 'pr' ? `<path class="core" d="M0,${-r}L${r},0L0,${r}L${-r},0Z" fill="none" stroke="${k.color}"/>`
        : `<circle class="core" r="${r}" fill="${memory ? k.color : 'none'}" fill-opacity="${old ? 0.15 : 0.9}" stroke="${k.color}"/>`;
      const hw = Math.min(110, label.length * 3.6 + 10);
      return `<rect x="${-hw}" y="${-r - 4}" width="${hw * 2}" height="${r * 2 + 40}" fill="#000" fill-opacity="0"/>${sel ? `<circle r="${r + 6}" fill="none" stroke="#9db6ff" stroke-width="1.5"/>` : ''}${shape}
<text class="gt" y="${r + 16}" text-anchor="middle" ${old ? 'fill-opacity=".5" text-decoration="line-through"' : ''}>${escapeXml(label)}</text>
${n.id === `m:${0}` ? '' : `<text class="gs" y="${r + 30}" text-anchor="middle">${escapeXml(k.label)}${old ? ' · sustituido' : ''}</text>`}`;
    };
    const opts = {
      nodes: model.nodes, edges: model.edges, node: draw, label: 'Mapa de memoria', selected: selected != null ? `m:${selected}` : null, pad: [60, 120, 60, 120] as [number, number, number, number],
      edgePath: (_e: GEdge, a: GNode, b: GNode) => {
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ra = a.w / 2, rb = b.w / 2 + 3;
        return `M${a.x + (dx / len) * ra},${a.y + (dy / len) * ra} L${b.x - (dx / len) * rb},${b.y - (dy / len) * rb}`;
      },
      onSelect: (id: string | null) => cb.current(id),
      maxFit: 1,
    };
    if (!g.current) g.current = createGraph(svg.current!, opts);
    else g.current.morph(model.nodes, model.edges, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, replaced]);
  useEffect(() => {
    const q = query.trim().toLowerCase();
    g.current?.highlight(q ? new Set(data.nodes.filter((n) => `${n.title} ${n.body ?? ''}`.toLowerCase().includes(q)).map((n) => n.key)) : null);
  }, [query, data]);
  useEffect(() => { const key = selected != null ? `m:${selected}` : null; if (g.current && g.current.selected !== key) g.current.select(key, true); }, [selected]);
  useEffect(() => {
    const ro = new ResizeObserver(() => g.current?.fit(false));
    ro.observe(svg.current!);
    return () => { ro.disconnect(); g.current?.destroy(); g.current = null; };
  }, []);
  return (
    <div className="flow-graph">
      <svg ref={svg} className="tr-graph" />
      <div className="tr-zoom">
        <button className="tr-btn sm icon ghost" onClick={() => g.current?.zoom(1.2)} aria-label="Acercar"><Icon name="zin" size={14} /></button>
        <button className="tr-btn sm icon ghost" onClick={() => g.current?.zoom(0.83)} aria-label="Alejar"><Icon name="zout" size={14} /></button>
        <button className="tr-btn sm icon ghost" onClick={() => g.current?.fit(true)} aria-label="Encajar"><Icon name="fit" size={14} /></button>
      </div>
      <div className="tr-legend">
        {KINDS.map((k) => <span key={k}><i style={{ color: KIND[k].color, borderTopWidth: 6, width: 6, borderRadius: 6 }} />{KIND[k].label}</span>)}
        <span><i style={{ color: 'rgb(255 178 94 / .7)', borderTopStyle: 'dashed' }} />sustituye</span>
        <span><i style={{ color: 'rgb(255 107 93 / .7)', borderTopStyle: 'dotted' }} />contradice</span>
      </div>
    </div>
  );
}

function Index({ entries, selected, replaced, onSelect }: { entries: BrainEntry[]; selected: number | null; replaced: Set<number>; onSelect: (id: number) => void }) {
  if (!entries.length) return <Empty icon="search" title="Sin resultados">Prueba con otra búsqueda o tipo.</Empty>;
  return (
    <div className="tr-body">
      <table className="flow-table">
        <thead><tr><th>Recuerdo</th><th>Tipo</th><th>Ámbito</th><th>Fuente</th><th>Vigencia</th><th>Actualizado</th></tr></thead>
        <tbody>
          {entries.map((e) => {
            const expired = e.validUntil != null && e.validUntil <= now();
            return (
              <tr key={e.id} aria-selected={selected === e.id} tabIndex={0} onClick={() => onSelect(e.id!)} onKeyDown={(ev) => ev.key === 'Enter' && onSelect(e.id!)}>
                <td style={{ textDecoration: replaced.has(e.id!) ? 'line-through' : undefined }}>{e.title}</td>
                <td><span className="brain-kind" style={{ ['--k' as string]: KIND[e.kind].color }}>{KIND[e.kind].label}</span></td>
                <td className="mut">{e.global ? 'global' : e.task ? `tarea #${e.task}` : 'proyecto'}</td>
                <td className="mut">{e.source}</td>
                <td>{expired ? <span className="tr-chip coral">caducado</span> : replaced.has(e.id!) ? <span className="tr-chip amber">sustituido</span> : e.validUntil ? <span className="mut">hasta {fecha(e.validUntil)}</span> : <span className="mut">vigente</span>}</td>
                <td className="mono mut">{fecha(e.updated)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Context({ project }: { project: string }) {
  const [list, setList] = useState<Task[] | null>(null);
  const [task, setTask] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<BrainEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { taskApi.list(project).then((t) => { setList(t); setTask(t.find((x) => x.status !== 'done')?.id ?? t[0]?.id ?? null); }, (e) => setError(String(e))); }, [project]);
  useEffect(() => {
    if (task == null) return;
    const t = window.setTimeout(() => brain.preview(project, task, text).then(setResult, (e) => setError(String(e))), 200);
    return () => window.clearTimeout(t);
  }, [project, task, text]);
  return (
    <div className="tr-body brain-context">
      <div className="tr-note"><Icon name="info" size={14} /><span>Lo que el núcleo adjuntaría a un agente que empiece esta tarea, con el mismo cálculo que usa al lanzar la ejecución.</span></div>
      {error && <ErrorNote error={error} />}
      {list && list.length === 0 ? <Empty icon="tasks" title="Sin tareas">El contexto se calcula para una tarea concreta.</Empty> : (
        <>
          <div className="tr-row tr-wrap">
            <select className="tr-input" value={task ?? ''} onChange={(e) => setTask(Number(e.currentTarget.value))} aria-label="Tarea">
              {(list ?? []).map((t) => <option key={t.id} value={t.id}>#{t.id} {t.title}</option>)}
            </select>
            <input className="tr-input" style={{ flex: 1, minWidth: 200 }} placeholder="Encargo adicional (opcional)" value={text} onChange={(e) => setText(e.currentTarget.value)} aria-label="Encargo adicional" />
          </div>
          {result === null ? <div className="tr-skel" style={{ height: 80 }} /> : result.length === 0 ? <p className="mut">Ningún recuerdo vigente se adjuntaría.</p> : (
            <ol className="brain-ctx-list">
              {result.map((e) => (
                <li key={e.id}><span className="brain-kind" style={{ ['--k' as string]: KIND[e.kind].color }}>{KIND[e.kind].label}</span> <b>{e.title}</b><p>{e.body}</p><span className="mono mut">{e.source}{e.global ? ' · global' : e.task ? ` · tarea #${e.task}` : ''}</span></li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function Inspector({ project, entry, all, links, replaced, onClose, onSelect, onEdit, onChanged, onForgotten }: {
  project: string; entry: BrainEntry; all: Map<number, BrainEntry>; links: BrainLink[]; replaced: Set<number>;
  onClose: () => void; onSelect: (id: number) => void; onEdit: () => void; onChanged: () => void; onForgotten: () => void;
}) {
  const mine = links.filter((l) => l.from === entry.id || l.to === entry.id);
  const [target, setTarget] = useState<number | ''>('');
  const [kind, setKind] = useState<BrainLinkKind>('relacionado');
  const [ok, setOk] = useState(false);
  const [forget, setForget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = entry.validUntil != null && entry.validUntil <= now();
  const title = (id: number) => all.get(id)?.title ?? `recuerdo #${id}`;
  return (
    <aside className="tr-insp" aria-label="Recuerdo">
      <div className="sec">
        <div className="tr-row" style={{ justifyContent: 'space-between' }}>
          <span className="brain-kind" style={{ ['--k' as string]: KIND[entry.kind].color }}>{KIND[entry.kind].label}</span>
          <button className="tr-btn sm icon ghost" onClick={onClose} aria-label="Cerrar"><Icon name="close" size={13} /></button>
        </div>
        <h3 style={{ marginTop: 10 }}>{entry.title}</h3>
        <p style={{ margin: '6px 0 0', color: 'var(--tx2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{entry.body}</p>
        <div className="tr-row tr-wrap" style={{ marginTop: 10 }}>
          {expired && <span className="tr-chip coral">caducado</span>}
          {replaced.has(entry.id!) && <span className="tr-chip amber">sustituido</span>}
          <span className="tr-chip">{entry.global ? 'global' : entry.task ? `tarea #${entry.task}` : 'proyecto'}</span>
          <span className="tr-chip">{entry.share ? 'se comparte con agentes' : 'privado'}</span>
        </div>
      </div>
      <div className="sec">
        <dl className="tr-kv">
          <dt>Fuente</dt><dd>{entry.source}{entry.sourceTask ? ` · tarea #${entry.sourceTask}` : ''}{entry.sourceRun ? ` · ejecución #${entry.sourceRun}` : ''}</dd>
          <dt>Vigencia</dt><dd>{entry.validUntil ? `hasta ${fecha(entry.validUntil)}` : 'sin fecha de caducidad'}</dd>
          <dt>Creado</dt><dd>{fecha(entry.created)}</dd>
          <dt>Actualizado</dt><dd>{fecha(entry.updated)} · versión {entry.version}</dd>
        </dl>
        <div className="tr-row" style={{ marginTop: 10 }}>
          <button className="tr-btn sm" onClick={onEdit}><Icon name="edit" size={13} /> Corregir</button>
          <button className="tr-btn sm danger" onClick={() => setForget(true)}><Icon name="trash" size={13} /> Olvidar</button>
        </div>
      </div>
      <div className="sec">
        <div className="tr-lab">Relaciones</div>
        {mine.length === 0 ? <p className="mut" style={{ margin: '0 0 8px', fontSize: 12 }}>Sin relaciones. Solo se crean a mano.</p> : (
          <ul className="tr-list" style={{ marginBottom: 8 }}>
            {mine.map((l) => {
              const out = l.from === entry.id;
              const other = out ? l.to : l.from;
              return (
                <li key={l.id} className="tr-row">
                  <button className="tr-li" onClick={() => onSelect(other)}><span className={`brain-rel r-${l.kind}`} /><span className="t">{out ? LINK[l.kind] : `${LINK[l.kind]} ←`} {title(other)}</span></button>
                  <button className="tr-btn sm icon ghost" aria-label="Quitar relación" onClick={() => brain.unlink(project, l.id!).then(onChanged, (e) => setError(String(e)))}><Icon name="close" size={12} /></button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="tr-col">
          <div className="tr-row">
            <select className="tr-input" value={kind} onChange={(e) => setKind(e.currentTarget.value as BrainLinkKind)} aria-label="Tipo de relación" style={{ width: 130 }}>
              {(Object.keys(LINK) as BrainLinkKind[]).map((k) => <option key={k} value={k}>{LINK[k]}</option>)}
            </select>
            <select className="tr-input" value={target} onChange={(e) => setTarget(e.currentTarget.value ? Number(e.currentTarget.value) : '')} aria-label="Recuerdo relacionado" style={{ flex: 1, minWidth: 0 }}>
              <option value="">Elige un recuerdo…</option>
              {[...all.values()].filter((e) => e.id !== entry.id).map((e) => <option key={e.id} value={e.id!}>{e.title}</option>)}
            </select>
          </div>
          <label className="tr-row" style={{ fontSize: 12 }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.currentTarget.checked)} /> Confirmo que esta relación es correcta</label>
          <button className="tr-btn sm" disabled={!ok || target === ''} onClick={() => brain.link(project, { id: null, from: entry.id!, to: Number(target), kind, note: '' }, true).then(() => { setTarget(''); setOk(false); onChanged(); }, (e) => setError(String(e)))}><Icon name="link" size={13} /> Relacionar</button>
          {error && <ErrorNote error={error} />}
        </div>
      </div>
      {forget && (
        <Modal title="Olvidar recuerdo" onClose={() => setForget(false)}>
          <p>Se borrará «{entry.title}» y sus relaciones. Los agentes dejarán de recibirlo. No se puede deshacer.</p>
          <div className="acts">
            <button className="tr-btn ghost" onClick={() => setForget(false)}>Cancelar</button>
            <button className="tr-btn danger" onClick={() => brain.forget(project, entry.id!, entry.version!).then(onForgotten, (e) => { setError(String(e)); setForget(false); })}>Olvidar</button>
          </div>
        </Modal>
      )}
    </aside>
  );
}

function EntryForm({ project, draft, onClose, onSaved }: { project: string; draft: BrainDraft; onClose: () => void; onSaved: (id: number) => void }) {
  const [form, setForm] = useState(draft);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const until = form.validUntil ? new Date(form.validUntil * 1000).toISOString().slice(0, 10) : '';
  const valid = form.title.trim() && form.title.length <= 160 && form.body.trim() && form.body.length <= 1200 && form.source.trim() && form.source.length <= 400;
  return (
    <Modal title={draft.id == null ? 'Nuevo recuerdo' : 'Corregir recuerdo'} onClose={onClose} wide>
      <div className="brain-form">
        <label className="tr-field-row">Tipo
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.currentTarget.value as BrainKind })}>{KINDS.map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}</select>
        </label>
        <label className="tr-field-row">Ámbito
          <select value={form.global ? 'global' : 'proyecto'} disabled={draft.id != null} onChange={(e) => setForm({ ...form, global: e.currentTarget.value === 'global' })}>
            <option value="proyecto">Este proyecto</option><option value="global">Global (todos los proyectos)</option>
          </select>
        </label>
        <label className="tr-field-row span">Título<input autoFocus value={form.title} maxLength={160} onChange={(e) => setForm({ ...form, title: e.currentTarget.value })} /></label>
        <label className="tr-field-row span">Contenido<textarea rows={4} value={form.body} maxLength={1200} onChange={(e) => setForm({ ...form, body: e.currentTarget.value })} /></label>
        <label className="tr-field-row span">Fuente (de dónde sale)<input value={form.source} maxLength={400} placeholder="acta, PR, conversación…" onChange={(e) => setForm({ ...form, source: e.currentTarget.value })} /></label>
        <label className="tr-field-row">Vigente hasta<input type="date" value={until} onChange={(e) => setForm({ ...form, validUntil: e.currentTarget.value ? Math.floor(new Date(e.currentTarget.value).getTime() / 1000) : null })} /></label>
        <label className="tr-row" style={{ fontSize: 12, alignSelf: 'end' }}><input type="checkbox" checked={form.share} onChange={(e) => setForm({ ...form, share: e.currentTarget.checked })} /> Compartir con los agentes</label>
      </div>
      <label className="tr-row" style={{ fontSize: 12, marginTop: 12 }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.currentTarget.checked)} /> He revisado el contenido y su procedencia</label>
      {error && <div style={{ marginTop: 10 }}><ErrorNote error={error} /></div>}
      <div className="acts">
        <button className="tr-btn ghost" onClick={onClose}>Cancelar</button>
        <button className={`tr-btn pearl${busy ? ' busy' : ''}`} disabled={!ok || !valid || busy} onClick={() => {
          setBusy(true);
          brain.save(form.global ? project : project, form, true).then(onSaved, (e) => setError(String(e))).finally(() => setBusy(false));
        }}>Guardar</button>
      </div>
    </Modal>
  );
}
