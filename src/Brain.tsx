import { useEffect, useState } from 'react';
import { brain, tasks, type BrainDraft, type BrainEntry, type BrainKind, type Task } from './ipc';

const KINDS: Record<BrainKind, string> = {
  fact: 'Hecho', decision: 'Decisión', preference: 'Preferencia', constraint: 'Restricción', evidence: 'Evidencia', outcome: 'Resultado',
};
const EMPTY: BrainDraft = {
  id: null, version: null, global: false, task: null, kind: 'decision', title: '', body: '', source: '',
  sourceTask: null, sourceRun: null, share: false, validUntil: null,
};
const numberOrNull = (value: string) => value === '' ? null : Number(value);
const date = (ts: number) => new Date(ts * 1000).toLocaleString();
const localDate = (ts: number | null) => {
  if (ts == null) return '';
  const value = new Date(ts * 1000);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function Source({ entry }: { entry: BrainEntry }) {
  return <span>{entry.source}
    {entry.sourceTask != null && ` · tarea #${entry.sourceTask}`}
    {entry.sourceRun != null && ` · turno #${entry.sourceRun}`}
  </span>;
}

export default function Brain({ project, target, onClearTarget, onGraph }: {
  project: string | null; target: number | null; onClearTarget: () => void; onGraph: () => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<BrainKind | null>(null);
  const [list, setList] = useState<BrainEntry[]>([]);
  const [taskList, setTaskList] = useState<Task[]>([]);
  const [draft, setDraft] = useState<BrainDraft | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [forget, setForget] = useState<BrainEntry | null>(null);
  const [previewTask, setPreviewTask] = useState<number | null>(null);
  const [previewQuery, setPreviewQuery] = useState('');
  const [preview, setPreview] = useState<BrainEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    if (project == null) return;
    tasks.list(project).then((items) => { if (current) setTaskList(items); }, (e) => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [project]);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      const request = target == null ? brain.search(project, query, kind) : brain.entry(project, target).then((item) => [item]);
      request.then((items) => { if (current) setList(items); }, (e) => { if (current) setError(String(e)); });
    }, 120);
    return () => { current = false; window.clearTimeout(timer); };
  }, [project, query, kind, revision, target]);

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setStatus('');
    try { await run(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const edit = (item: BrainDraft) => {
    setDraft(item);
    setConfirmed(false);
    setForget(null);
    setError('');
    setStatus('');
  };
  const change = (next: Partial<BrainDraft>) => {
    setDraft((item) => item && { ...item, ...next });
    setConfirmed(false);
  };
  const updated = (message: string) => {
    setDraft(null);
    setForget(null);
    setPreview(null);
    onClearTarget();
    setRevision((value) => value + 1);
    setStatus(message);
  };

  return <section className="coach" aria-label="Filigranas Brain">
    <div className="co-head brain-tabs">
      <button className="co-link" onClick={onGraph}>Grafo</button><button className="co-link is-active" aria-current="page">Recuerdos</button>
    </div>
    <div className="co-log p5-panel">
      <div className="p5-actions task-form">
        <label>Buscar recuerdos<input type="search" value={query} maxLength={300} onChange={(e) => { onClearTarget(); setQuery(e.target.value); }} /></label>
        <label>Tipo<select value={kind ?? ''} onChange={(e) => { onClearTarget(); setKind((e.target.value || null) as BrainKind | null); }}>
          <option value="">Todos</option>
          {Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <button className="co-btn" disabled={busy} onClick={() => edit({ ...EMPTY, global: project == null })}>Nuevo recuerdo</button>
        {target != null && <button className="co-btn" onClick={() => { setError(''); onClearTarget(); }}>Mostrar todos</button>}
      </div>
      {!!error && <p className="co-error" role="alert">{error}</p>}
      {!!status && <p role="status">{status}</p>}

      {draft && <form className="p5-section task-form" aria-label="Editar recuerdo" onSubmit={(e) => {
        e.preventDefault();
        void act(async () => {
          await brain.save(project, draft, confirmed);
          updated('Recuerdo guardado');
        });
      }}>
        <div className="p5-actions">
          <label>Ámbito<select value={draft.global ? 'global' : 'project'} disabled={busy} onChange={(e) => change(e.target.value === 'global'
            ? { global: true, task: null, sourceTask: null, sourceRun: null } : { global: false })}>
            {project && <option value="project">Este proyecto</option>}
            <option value="global">Global</option>
          </select></label>
          <label>Clase<select value={draft.kind} disabled={busy} onChange={(e) => change({ kind: e.target.value as BrainKind })}>
            {Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          {!draft.global && <label>Tarea del recuerdo<select value={draft.task ?? ''} disabled={busy}
            onChange={(e) => change({ task: numberOrNull(e.target.value), sourceTask: null, sourceRun: null })}>
            <option value="">Todo el proyecto</option>
            {taskList.map((task) => <option key={task.id} value={task.id}>#{task.id} {task.title}</option>)}
          </select></label>}
        </div>
        <label>Título<input value={draft.title} disabled={busy} maxLength={160} required onChange={(e) => change({ title: e.target.value })} /></label>
        <label>Contenido<textarea value={draft.body} disabled={busy} maxLength={1200} required onChange={(e) => change({ body: e.target.value })} /></label>
        <label>Fuente<input value={draft.source} disabled={busy} maxLength={400} required
          placeholder="Documento, URL o referencia que respalda el recuerdo" onChange={(e) => change({ source: e.target.value })} /></label>
        {!draft.global && <div className="p5-actions">
          <label>Tarea fuente<select disabled={busy} value={draft.sourceTask ?? ''}
            onChange={(e) => change({ sourceTask: numberOrNull(e.target.value), sourceRun: null })}>
            <option value="">Sin vínculo</option>
            {taskList.filter((task) => draft.task == null || task.id === draft.task).map((task) => <option key={task.id} value={task.id}>#{task.id} {task.title}</option>)}
          </select></label>
          <label>ID de turno fuente<input type="number" min={1} step={1} disabled={busy || draft.sourceTask != null}
            value={draft.sourceRun ?? ''} onChange={(e) => change({ sourceRun: numberOrNull(e.target.value) })} /></label>
        </div>}
        <label>Vigente hasta<input type="datetime-local" value={localDate(draft.validUntil)} disabled={busy}
          onChange={(e) => change({ validUntil: e.target.value ? Math.floor(new Date(e.target.value).getTime() / 1000) : null })} /></label>
        <label className="p5-check"><input type="checkbox" checked={draft.share} disabled={busy}
          onChange={(e) => change({ share: e.target.checked })} /> Permitir incluir el contenido y la fuente en encargos a agentes</label>
        <label className="p5-check"><input type="checkbox" checked={confirmed} disabled={busy}
          onChange={(e) => setConfirmed(e.target.checked)} /> Confirmo el contenido y su procedencia</label>
        <div className="p5-actions">
          <button className="co-btn" disabled={busy || !confirmed}>Guardar recuerdo</button>
          <button type="button" className="co-btn" disabled={busy} onClick={() => setDraft(null)}>Cancelar</button>
        </div>
      </form>}

      {forget && <section className="p5-section" aria-label="Confirmar olvido">
        <p>Se borrará el recuerdo «{forget.title}» de Brain y de las referencias locales de los turnos.</p>
        <div className="p5-actions">
          <button className="co-btn" disabled={busy} onClick={() => void act(async () => {
            if (forget.id == null || forget.version == null) return;
            await brain.forget(project, forget.id, forget.version);
            updated('Recuerdo olvidado');
          })}>Olvidar definitivamente</button>
          <button className="co-btn" disabled={busy} onClick={() => setForget(null)}>Cancelar olvido</button>
        </div>
      </section>}

      <section className="p5-section" aria-label="Recuerdos">
        {list.length === 0 && <p className="muted">Sin recuerdos para esta búsqueda.</p>}
        {list.map((item) => <details className="p5-record" key={item.id} open={target != null && item.id === target ? true : undefined}>
          <summary>{item.title} · {KINDS[item.kind]} · {item.global ? 'Global' : item.task == null ? 'Proyecto' : `Tarea #${item.task}`}</summary>
          <p className="task-text">{item.body}</p>
          <dl className="task-facts">
            <dt>Fuente</dt><dd><Source entry={item} /></dd>
            <dt>Confirmado</dt><dd>{date(item.updated)} · revisión {item.version}</dd>
            <dt>Recuperación</dt><dd>{item.share ? 'Disponible para agentes' : 'Solo local'}</dd>
            {item.validUntil != null && <><dt>Vigencia</dt><dd>{date(item.validUntil)}{item.validUntil <= Date.now() / 1000 && ' · caducado'}</dd></>}
          </dl>
          <div className="p5-actions">
            <button className="co-btn" disabled={busy} onClick={() => edit(item)}>Editar recuerdo</button>
            <button className="co-btn" disabled={busy} onClick={() => { setDraft(null); setForget(item); }}>Olvidar recuerdo</button>
          </div>
        </details>)}
      </section>

      {project && <section className="p5-section" aria-label="Contexto para una tarea">
        <h2>Contexto para una tarea</h2>
        <form className="p5-actions task-form" onSubmit={(e) => {
          e.preventDefault();
          if (previewTask != null) void act(async () => setPreview(await brain.preview(project, previewTask, previewQuery)));
        }}>
          <label>Tarea para recuperar contexto<select value={previewTask ?? ''} disabled={busy}
            onChange={(e) => { setPreviewTask(numberOrNull(e.target.value)); setPreview(null); }}>
            <option value="">Elige una tarea</option>
            {taskList.map((task) => <option key={task.id} value={task.id}>#{task.id} {task.title}</option>)}
          </select></label>
          <label>Encargo adicional<input value={previewQuery} disabled={busy} maxLength={800}
            onChange={(e) => { setPreviewQuery(e.target.value); setPreview(null); }} /></label>
          <button className="co-btn" disabled={busy || previewTask == null}>Previsualizar contexto</button>
        </form>
        {preview && (preview.length ? <ul>
          {preview.map((item) => <li key={item.id}>{item.title} · <Source entry={item} /></li>)}
        </ul> : <p className="muted">Sin recuerdos vigentes y pertinentes para esta tarea.</p>)}
      </section>}
    </div>
  </section>;
}
