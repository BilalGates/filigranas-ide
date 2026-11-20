import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { pr, workSessions, type WorkAgent, type WorkSession as Work } from './ipc';
import Publish from './Publish';
import './workSession.css';

function Assignment({ agent, disabled, save }: { agent: WorkAgent; disabled: boolean; save: (paths: string[]) => Promise<void> }) {
  const [paths, setPaths] = useState(agent.paths.join('\n'));
  useEffect(() => setPaths(agent.paths.join('\n')), [agent.paths.join('\n')]);
  return <form className="work-assignment" onSubmit={(e) => { e.preventDefault(); void save(paths.split('\n').map((p) => p.trim()).filter(Boolean)); }}>
    <span>{agent.name} · {agent.running ? 'en marcha' : 'disponible'}</span>
    <label>Archivos o carpetas, uno por línea
      <textarea aria-label={`Área de ${agent.name}`} rows={2} value={paths} disabled={disabled || agent.running} onChange={(e) => setPaths(e.target.value)} />
    </label>
    <button className="co-btn" disabled={disabled || agent.running || paths === agent.paths.join('\n')}>Guardar reparto</button>
  </form>;
}

export default function WorkSession({ project, hidden }: { project: string; hidden: boolean }) {
  const [work, setWork] = useState<Work | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [objective, setObjective] = useState('');
  const [kind, setKind] = useState('feat');
  const [description, setDescription] = useState('');
  const [includeExisting, setIncludeExisting] = useState(false);
  const [tests, setTests] = useState('');
  const [evidence, setEvidence] = useState('');
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const next = await workSessions.current(project);
      if (id !== request.current) return;
      setWork(next);
      setLoaded(true);
    } catch (e) { if (id === request.current) setError(String(e)); }
  }, [project]);
  useEffect(() => {
    if (hidden) return;
    void refresh();
    const unlisten = listen('tasks-changed', () => void refresh());
    return () => { ++request.current; void unlisten.then((stop) => stop()); };
  }, [hidden, refresh]);
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await run(); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const start = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await workSessions.start(project, objective, kind, description || objective, includeExisting);
      setObjective(''); setDescription(''); setIncludeExisting(false); setTests(''); setEvidence('');
    });
  };
  const active = !!work && work.state !== 'finished';
  const slug = (description || objective).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72).replace(/-$/, '');

  return <details className="work-session-panel" key={`${work?.id ?? 'new'}:${work?.state ?? ''}`} open={!active || work?.state === 'review'}>
    <summary>Sesión de trabajo · {active ? `${work.branch} → main` : 'nueva sesión'}{active && ` · ${work.agents.filter((a) => !a.closed).length} agentes`}</summary>
    <div className="work-session-content">
      {error && <div className="co-error" role="alert">{error}</div>}
      {!loaded && !error && <p className="muted">Cargando sesión…</p>}
      {loaded && !active && <>
        {work?.prUrl && <p>Sesión anterior finalizada · <button className="co-link" onClick={() => void pr.open(work.prUrl!).catch((e) => setError(String(e)))}>Abrir PR</button></p>}
        <form className="work-session-form" onSubmit={start}>
          <label>Objetivo de la sesión<input required value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Agentes en una rama compartida" /></label>
          <div className="work-session-branch">
            <label>Tipo<select value={kind} onChange={(e) => setKind(e.target.value)}>{['feat', 'fix', 'refactor', 'docs', 'test', 'chore'].map((k) => <option key={k}>{k}</option>)}</select></label>
            <label>Nombre descriptivo<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Se propone a partir del objetivo" /></label>
          </div>
          <p className="muted">{kind}/{slug || 'objetivo-de-la-sesion'} → main · Todos los agentes compartirán esta carpeta y rama.</p>
          <label className="pub-check"><input type="checkbox" checked={includeExisting} onChange={(e) => setIncludeExisting(e.target.checked)} /> Incluir cambios existentes tras revisarlos</label>
          {includeExisting && <p className="muted">Se partirá de la rama actual conservando sus cambios y commits. La PR incluirá todo lo que difiera de main.</p>}
          <button className="co-btn is-primary" disabled={busy || !objective.trim()}>Iniciar sesión de trabajo</button>
        </form>
      </>}
      {active && <>
        <p>{work.objective}</p>
        {work.state === 'active' && <>
          <p className="muted">Asigna rutas relativas. «.» abarca todo el proyecto; los ámbitos que se solapen esperan su turno. Los agentes reciben este reparto como instrucciones.</p>
          {work.agents.filter((a) => !a.closed).map((agent) => <Assignment key={agent.sessionId} agent={agent} disabled={busy}
            save={(paths) => act(() => workSessions.assign(project, agent.sessionId, paths))} />)}
          <form className="work-session-form" onSubmit={(e) => { e.preventDefault(); void act(() => workSessions.prepare(project, tests, evidence)); }}>
            <label>Resultado de las pruebas<select required value={tests} onChange={(e) => setTests(e.target.value)}>
              <option value="">Selecciona el resultado</option><option value="passed">Correctas</option><option value="not_applicable">No aplican</option>
            </select></label>
            <label>Evidencia<textarea required rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Comprobaciones ejecutadas y resultados, o motivo por el que no aplican" /></label>
            <button className="co-btn is-primary" disabled={busy || !tests || !evidence.trim() || work.agents.some((a) => a.running)}>Finalizar sesión y revisar PR</button>
            <p className="muted">Primero crea los commits con Larry. Después se comprueba el diff y se revisa la publicación hacia main.</p>
          </form>
        </>}
        {work.state === 'review' && <>
          <p className="muted">En revisión · Los nuevos turnos quedan detenidos hasta publicar o reanudar.</p>
          <button className="co-btn" disabled={busy} onClick={() => void act(() => workSessions.resume(project))}>Reanudar trabajo</button>
          <Publish project={project} session={null} hidden={hidden} workClosure />
        </>}
      </>}
    </div>
  </details>;
}
