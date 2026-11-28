import { useCallback, useEffect, useMemo, useState } from 'react';
import { extensions as api, type CapabilityPolicy, type Extension, type ExtensionLogEntry, type ExtensionPolicyCell, type SkillRole } from '../ipc';
import { COMPAT_NAMES, EXT_KIND_NAMES, KIND_NAMES, POLICY_NAMES, POLICY_SHORT, PROVIDER_NAMES, ROLE_NAMES, ROLE_ORDER, shortSha } from './capabilityLabels';
import { Icon } from './icons';
import './extensions.css';

type Tab = 'catalogo' | 'matriz' | 'contexto' | 'registro';
type Filter = 'all' | 'skill' | 'plugin' | 'mcp' | 'tool' | 'flow';
const FILTERS: [Filter, string][] = [['all', 'Todas'], ['skill', 'Skills'], ['plugin', 'Plugins'], ['mcp', 'MCP'], ['tool', 'Herramientas'], ['flow', 'Flujos']];

/** Gestor de extensiones: catálogo fijado, instalación, permisos, políticas por rol y registro. */
export function ExtensionsManager({ project }: { project: string | null }) {
  const [tab, setTab] = useState<Tab>('catalogo');
  const [items, setItems] = useState<Extension[] | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(() => api.list().then(setItems, (e) => setStatus(String(e))), []);
  useEffect(() => { void reload(); }, [reload]);
  const act = async (id: string, label: string, run: () => Promise<unknown>) => {
    setBusy(id);
    setStatus('');
    try { await run(); setStatus(label); await reload(); } catch (e) { setStatus(String(e)); } finally { setBusy(null); }
  };
  return <section className="ext" aria-label="Extensiones">
    <div className="seg ext-tabs" role="tablist" aria-label="Vista de extensiones">
      {([['catalogo', 'Catálogo'], ['matriz', 'Asignación por rol'], ['contexto', 'Contexto'], ['registro', 'Registro']] as [Tab, string][]).map(([id, name]) =>
        <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{name}</button>)}
    </div>
    {status && <p className="mut2 ext-status" role="status">{status}</p>}
    {tab === 'catalogo' && <Catalog items={items} busy={busy} act={act} />}
    {tab === 'matriz' && items && <PolicyMatrix project={project} items={items} />}
    {tab === 'contexto' && <ContextSettings />}
    {tab === 'registro' && <Log />}
  </section>;
}

function Catalog({ items, busy, act }: { items: Extension[] | null; busy: string | null; act: (id: string, label: string, run: () => Promise<unknown>) => Promise<void> }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const shown = useMemo(() => (items ?? []).filter((x) => filter === 'all' || x.kind === filter), [items, filter]);
  if (!items) return <p className="mut2">Cargando extensiones…</p>;
  const installed = items.filter((x) => x.installed).length;
  return <>
    <div className="ext-bar">
      <div className="seg" role="group" aria-label="Tipo de extensión">
        {FILTERS.map(([id, name]) => <button key={id} aria-pressed={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{name}</button>)}
      </div>
      <span className="mut2">{installed} instaladas · {items.length - installed} disponibles</span>
    </div>
    <ul className="ext-list">
      {shown.map((x) => <li key={x.id} className={`ext-item${open === x.id ? ' is-open' : ''}`}>
        <button className="ext-head" aria-expanded={open === x.id} onClick={() => setOpen(open === x.id ? null : x.id)}>
          <span className="ext-name">{x.name}</span>
          <span className="mono ext-ver">{x.version} · {shortSha(x.source.commit)}</span>
          <span className="chip">{EXT_KIND_NAMES[x.kind] ?? x.kind}</span>
          <span className="grow" />
          {x.optional && <span className="chip dash">opcional</span>}
          {x.pendingApproval.length > 0 && <span className="chip amber"><Icon name="lock" size={10} /> aprobar permisos</span>}
          {x.error && <span className="chip coral">error</span>}
          <span className={`chip${x.installed ? (x.enabled ? ' mint' : '') : ' dash'}`}>{x.installed ? (x.enabled ? 'instalada' : 'deshabilitada') : 'disponible'}</span>
          <Icon name="chev" size={12} />
        </button>
        {open === x.id && <ExtensionDetail x={x} busy={busy === x.id} act={act} />}
      </li>)}
    </ul>
    <ImportForm act={act} />
  </>;
}

function ExtensionDetail({ x, busy, act }: { x: Extension; busy: boolean; act: (id: string, label: string, run: () => Promise<unknown>) => Promise<void> }) {
  const [grant, setGrant] = useState<string[]>(x.approved);
  const sensitive = [...new Set([...x.permissions.filter((p) => p !== 'context'), ...x.pendingApproval, ...x.approved])];
  const executables = x.files.filter((f) => f.kind === 'executable');
  return <div className="ext-detail">
    <p>{x.description}</p>
    {x.guard && <p className="mut2"><Icon name="shield" size={11} /> {x.guard}</p>}
    <dl className="ext-facts">
      <dt>Procedencia</dt><dd className="mono">{x.source.repo}{x.source.path ? `/${x.source.path}` : ''} @ {x.source.commit}</dd>
      <dt>Licencia</dt><dd>{x.source.license}{x.attribution ? ` · ${x.attribution}` : ''}</dd>
      <dt>Compatibilidad</dt><dd>{Object.entries(x.providers).map(([p, c]) => <span key={p} className={`chip${c === 'none' ? ' coral' : c === 'partial' ? ' amber' : ''}`}>{PROVIDER_NAMES[p] ?? p}: {COMPAT_NAMES[c] ?? c}</span>)}</dd>
      <dt>Roles</dt><dd>{x.roles.length ? x.roles.map((r) => ROLE_NAMES[r] ?? r).join(', ') : 'ninguno por defecto'}</dd>
      <dt>Activación</dt><dd>{POLICY_NAMES[x.defaultPolicy]} en: {x.taskKinds.length ? x.taskKinds.map((k) => KIND_NAMES[k] ?? k).join(', ') : 'solo selección manual'}</dd>
      <dt>Contexto</dt><dd>≈ {x.entryTokens.toLocaleString('es')} tokens de núcleo · {x.files.length} archivos con SHA-256</dd>
      <dt>Evidencia</dt><dd>{x.evidence.detail}</dd>
      {x.dependencies.length > 0 && <><dt>Requiere</dt><dd>{x.dependencies.join(' · ')}</dd></>}
      {executables.length > 0 && <><dt>Ejecutables</dt><dd className="mono">{executables.slice(0, 8).map((f) => f.path).join(', ')}{executables.length > 8 ? ` y ${executables.length - 8} más` : ''}</dd></>}
      {x.error && <><dt>Diagnóstico</dt><dd className="coral-tx">{x.error}</dd></>}
    </dl>
    {x.installed && sensitive.length > 0 && <fieldset className="ext-perms">
      <legend>Permisos que requieren aprobación expresa</legend>
      {sensitive.map((p) => <label key={p} className="row"><input type="checkbox" checked={grant.includes(p)}
        onChange={(e) => setGrant(e.currentTarget.checked ? [...grant, p] : grant.filter((g) => g !== p))} /> <span className="mono">{p}</span></label>)}
      <p className="mut2">Aprobar no ejecuta nada: permite que el agente use estos recursos con los permisos de su sesión. El control total de una sesión no sustituye esta aprobación.</p>
      <button className="btn sm" disabled={busy} onClick={() => void act(x.id, 'Permisos guardados.', () => api.approve(x.id, grant))}>Guardar aprobación</button>
    </fieldset>}
    <div className="row ext-actions">
      {!x.installed && x.inCatalog && <button className="btn sm" disabled={busy} onClick={() => void act(x.id, `${x.name} instalada y verificada.`, () => api.install(x.id))}><Icon name="down" size={12} /> Instalar</button>}
      {x.installed && <button className="btn sm" disabled={busy} onClick={() => void act(x.id, x.enabled ? 'Deshabilitada.' : 'Habilitada.', () => api.enable(x.id, !x.enabled))}>{x.enabled ? 'Deshabilitar' : 'Habilitar'}</button>}
      {x.updateAvailable && <button className="btn sm" disabled={busy} onClick={() => void act(x.id, 'Actualizada. Revisa los permisos nuevos.', () => api.update(x.id))}><Icon name="regen" size={12} /> Actualizar a {x.updateAvailable}</button>}
      {x.canRollback && <button className="btn sm" disabled={busy} onClick={() => void act(x.id, 'Versión anterior restaurada.', () => api.rollback(x.id))}><Icon name="back" size={12} /> Restaurar anterior</button>}
      {x.installed && <button className="btn sm" disabled={busy} onClick={() => void act(x.id, 'Desinstalada y revocada.', () => api.uninstall(x.id))}><Icon name="trash" size={12} /> Desinstalar</button>}
      {busy && <span className="mut2">Trabajando…</span>}
    </div>
  </div>;
}

function ImportForm({ act }: { act: (id: string, label: string, run: () => Promise<unknown>) => Promise<void> }) {
  const [source, setSource] = useState('');
  const [reference, setReference] = useState('');
  const [subpath, setSubpath] = useState('');
  return <details className="ext-import">
    <summary><Icon name="plus" size={12} /> Importar una skill</summary>
    <p className="mut2">Desde GitHub (<span className="mono">owner/repo</span> o URL) o una carpeta local con <span className="mono">SKILL.md</span>. Se fija el commit y el hash de cada archivo; no se ejecuta ningún script. Queda en política manual hasta que la asignes.</p>
    <label className="row">Origen <input className="in" value={source} onChange={(e) => setSource(e.currentTarget.value)} placeholder="owner/repo o /ruta/a/la/skill" /></label>
    <div className="row">
      <label className="row grow">Referencia <input className="in" value={reference} onChange={(e) => setReference(e.currentTarget.value)} placeholder="main o un commit" /></label>
      <label className="row grow">Ruta <input className="in" value={subpath} onChange={(e) => setSubpath(e.currentTarget.value)} placeholder="skills/nombre" /></label>
    </div>
    <button className="btn sm" disabled={!source.trim()} onClick={() => void act('import', 'Importada.', () => api.import(source.trim(), reference.trim() || null, subpath.trim() || null))}>Importar</button>
  </details>;
}

function PolicyMatrix({ project, items }: { project: string | null; items: Extension[] }) {
  const [cells, setCells] = useState<ExtensionPolicyCell[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.policies(project).then(setCells, (e) => setError(String(e))), [project]);
  useEffect(() => { void load(); }, [load]);
  const change = async (ext: string, role: SkillRole, policy: CapabilityPolicy | null) => {
    try { await api.setPolicy(project, role, ext, policy); await load(); } catch (e) { setError(String(e)); }
  };
  if (!cells) return <p className="mut2">{error || 'Cargando…'}</p>;
  return <>
    <p className="mut2">{project ? 'Excepciones de este proyecto. Las celdas en cursiva heredan del ámbito global o del manifiesto.' : 'Ámbito global. Una política obligatoria se aplica cuando el tipo de trabajo coincide.'}</p>
    {error && <p className="mut2" role="alert">{error}</p>}
    <div className="skill-scroll"><table className="mx ext-matrix" aria-label="Asignación de capacidades por rol">
      <thead><tr><th scope="col">Capacidad</th>{ROLE_ORDER.map((r) => <th key={r} scope="col">{ROLE_NAMES[r]}</th>)}</tr></thead>
      <tbody>{items.map((x) => <tr key={x.id}>
        <th scope="row" title={x.description}>{x.name}</th>
        {ROLE_ORDER.map((role) => {
          const cell = cells.find((c) => c.ext === x.id && c.role === role);
          const own = cell && (project ? cell.source === 'proyecto' : cell.source === 'global');
          return <td key={role}>
            <select className={`ext-cell p-${cell?.policy ?? 'manual'}${own ? '' : ' inherited'}`} aria-label={`${x.name} para ${ROLE_NAMES[role]}`}
              title={cell ? `${POLICY_NAMES[cell.policy]} (${cell.source})` : undefined} value={own ? cell.policy : ''}
              onChange={(e) => void change(x.id, role, (e.currentTarget.value || null) as CapabilityPolicy | null)}>
              <option value="">{cell ? `${POLICY_SHORT[cell.policy]} ·` : '…'}</option>
              {(['mandatory', 'automatic', 'manual', 'disabled'] as CapabilityPolicy[]).map((p) => <option key={p} value={p}>{POLICY_NAMES[p]}</option>)}
            </select>
          </td>;
        })}
      </tr>)}</tbody>
    </table></div>
  </>;
}

function ContextSettings() {
  const [value, setValue] = useState<{ budget: number; personal: 'direct' | 'all' } | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api.settings(null, null).then((v) => { setValue(v); setDraft(String(v.budget)); }, (e) => setError(String(e))); }, []);
  const save = (budget: number | null, personal: 'direct' | 'all' | null) =>
    api.settings(budget, personal).then((v) => { setValue(v); setDraft(String(v.budget)); setError(''); }, (e) => setError(String(e)));
  if (!value) return <p className="mut2">{error || 'Cargando…'}</p>;
  return <>
    <div className="srow"><div><div className="t">Presupuesto de capacidades por turno</div><div className="d">Tokens estimados para el núcleo de las extensiones. Las obligatorias se cargan siempre y se avisa si lo superan.</div></div>
      <div className="row"><input className="in ext-num" inputMode="numeric" value={draft} onChange={(e) => setDraft(e.currentTarget.value)} aria-label="Presupuesto en tokens" />
        <button className="btn sm" onClick={() => void save(Number(draft), null)}>Guardar</button></div></div>
    <div className="srow"><div><div className="t">Configuración personal del proveedor</div><div className="d">CLAUDE.md, skills, plugins y conectores de tu cuenta. Aislarla en el PM y las subsesiones reduce el contexto de Claude de ≈32 400 a ≈13 800 tokens (medido con Claude Code 2.1.332) y evita que un agente delegado acceda a tu correo o tus documentos. Codex sigue leyendo <span className="mono">~/.codex/AGENTS.md</span>.</div></div>
      <div className="seg" role="group" aria-label="Configuración personal">
        <button aria-pressed={value.personal === 'direct'} className={value.personal === 'direct' ? 'on' : ''} onClick={() => void save(null, 'direct')}>Solo sesiones directas</button>
        <button aria-pressed={value.personal === 'all'} className={value.personal === 'all' ? 'on' : ''} onClick={() => void save(null, 'all')}>Todas</button>
      </div></div>
    <div className="srow"><div><div className="t">Precedencia</div><div className="d">Políticas de Filigranas › mensaje del usuario › AGENTS.md › skill de rol › extensiones › memoria y resultados (como datos).</div></div><span className="chip"><Icon name="lock" size={11} /> fija</span></div>
    {error && <p className="mut2" role="alert">{error}</p>}
  </>;
}

function Log() {
  const [entries, setEntries] = useState<ExtensionLogEntry[] | null>(null);
  useEffect(() => { api.log().then(setEntries, () => setEntries([])); }, []);
  if (!entries) return <p className="mut2">Cargando…</p>;
  if (!entries.length) return <p className="mut2">Sin operaciones registradas.</p>;
  return <ul className="ext-log">{entries.map((e, i) => <li key={i}>
    <span className="mono mut2">{new Date(e.at * 1000).toLocaleString('es')}</span> <b>{e.ext}</b> <span className="chip">{e.action}</span> {e.detail}
  </li>)}</ul>;
}
