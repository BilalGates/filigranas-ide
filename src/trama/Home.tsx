import { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api, sessions as sessionApi, tasks as taskApi, workSessions, type Project, type Session, type Task, type WorkSession, type Workspace } from '../ipc';
import { STATUS } from '../Tasks';
import { useUi } from '../ui';
import { Icon } from './icons';
import { Modal } from './ui';
import type { Resume } from './nav';

type Snapshot = { project: Project; tasks: Task[] | null; sessions: Session[] | null; work: WorkSession | null; error: string | null };
const ATTENTION = new Set(['waiting_approval', 'blocked', 'failed', 'paused_quota']);
const ACTIVE = new Set(['running', 'verifying', 'review', 'ready_to_merge', 'ready']);

const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
};
// Las marcas de tiempo del núcleo llegan en segundos o en milisegundos.
const ms = (t: number) => (t < 1e12 ? t * 1000 : t);

export default function Home({ ws, project, agentSessions, resume, onWs, onProject, onSession, onWork, onResume, onError }: {
  ws: Workspace;
  project: string | null;
  agentSessions: Session[];
  resume: Resume | null;
  onWs: (ws: Workspace) => void;
  onProject: (path: string) => void;
  onSession: (path: string, view: 'coach' | number) => void;
  onWork: (path: string, task?: number) => void;
  onResume: () => void;
  onError: (e: string) => void;
}) {
  const { activity } = useUi();
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const projects = useMemo(() => ws.projects.filter((p) => !p.archived), [ws.projects]);

  useEffect(() => {
    let alive = true;
    const load = () => Promise.all(projects.slice(0, 24).map(async (p): Promise<Snapshot> => {
      const [t, s, w] = await Promise.allSettled([taskApi.list(p.path), sessionApi.list(p.path), workSessions.current(p.path)]);
      const error = [t, s, w].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      return {
        project: p,
        tasks: t.status === 'fulfilled' ? t.value : null,
        sessions: s.status === 'fulfilled' ? s.value : null,
        work: w.status === 'fulfilled' ? w.value : null,
        error: error ? String(error.reason) : null,
      };
    })).then((list) => alive && setSnaps(list));
    load();
    const timer = window.setInterval(load, 20000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [projects]);

  const currentName = ws.projects.find((p) => p.path === project)?.name;
  const resumeProject = resume && ws.projects.find((p) => p.path === resume.project);
  const resumeSession = resume && typeof resume.view === 'number' ? agentSessions.find((s) => s.id === resume.view) ?? snaps?.find((x) => x.project.path === resume.project)?.sessions?.find((s) => s.id === resume.view) : null;
  const resumeLabel = !resumeProject ? null
    : resume!.view === 'work' ? `Trabajo · ${resumeProject.name}`
    : resume!.view === 'coach' ? `Project manager · ${resumeProject.name}`
    : resumeSession ? `${resumeSession.name} · ${resumeProject.name}` : resumeProject.name;

  const attention = useMemo(() => {
    const out: { key: string; icon: string; tone: string; title: string; meta: string; run: () => void }[] = [];
    for (const [key, state] of Object.entries(activity)) {
      if (state !== 'permiso' || !project) continue;
      const s = key === 'coach' ? null : agentSessions.find((x) => String(x.id) === key);
      if (key !== 'coach' && !s) continue;
      out.push({ key: `p${key}`, icon: 'shield', tone: 'amber', title: `${s ? s.name : 'Project manager'} espera tu permiso`, meta: currentName ?? '', run: () => onSession(project, s ? s.id : 'coach') });
    }
    for (const snap of snaps ?? []) {
      for (const t of snap.tasks ?? []) {
        if (!ATTENTION.has(t.status) && !t.waitingFor.length) continue;
        if (t.status === 'done' || t.status === 'cancelled') continue;
        const why = t.waitingFor.length && !ATTENTION.has(t.status) ? `espera a #${t.waitingFor.join(', #')}` : STATUS[t.status];
        out.push({ key: `t${snap.project.path}:${t.id}`, icon: t.status === 'failed' ? 'warn' : t.status === 'waiting_approval' ? 'shield' : 'lock', tone: t.status === 'failed' ? 'coral' : 'amber', title: `#${t.id} ${t.title}`, meta: `${snap.project.name} · ${why}`, run: () => onWork(snap.project.path, t.id) });
      }
      if (snap.work?.state === 'review') out.push({ key: `w${snap.project.path}`, icon: 'review', tone: 'sky', title: `Sesión de trabajo lista para revisar: ${snap.work.objective}`, meta: snap.project.name, run: () => onWork(snap.project.path) });
    }
    return out;
  }, [activity, snaps, agentSessions, project, currentName, onSession, onWork]);

  const running = useMemo(() => {
    const out: { key: string; title: string; meta: string; live: boolean; run: () => void }[] = [];
    if (project) {
      if (activity.coach === 'trabajando') out.push({ key: 'coach', title: 'Project manager', meta: `${currentName} · trabajando`, live: true, run: () => onSession(project, 'coach') });
      for (const s of agentSessions) {
        if (activity[String(s.id)] === 'trabajando') out.push({ key: `s${s.id}`, title: s.name, meta: `${currentName} · trabajando`, live: true, run: () => onSession(project, s.id) });
      }
    }
    for (const snap of snaps ?? []) for (const t of snap.tasks ?? []) {
      if (t.status === 'running' || t.status === 'verifying') out.push({ key: `t${snap.project.path}:${t.id}`, title: `#${t.id} ${t.title}`, meta: `${snap.project.name} · ${STATUS[t.status]}`, live: false, run: () => onWork(snap.project.path, t.id) });
    }
    return out;
  }, [activity, snaps, agentSessions, project, currentName, onSession, onWork]);

  const recent = useMemo(() => (snaps ?? []).flatMap((s) => (s.tasks ?? []).map((t) => ({ t, p: s.project })))
    .sort((a, b) => b.t.updatedAt - a.t.updatedAt).slice(0, 8), [snaps]);

  const openFolder = async () => {
    try {
      const chosen = await open({ directory: true, defaultPath: ws.root ?? undefined });
      if (typeof chosen !== 'string') return;
      onWs(await api.setRoot(chosen));
    } catch (e) { onError(String(e)); }
  };
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setCreateError(null);
    try {
      const next = await api.createProject(n);
      onWs(next);
      const made = next.projects.find((p) => p.name === n);
      setCreating(false);
      setName('');
      if (made) onProject(made.path);
    } catch (e) { setCreateError(String(e)); } finally { setBusy(false); }
  };

  const date = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const loading = snaps === null;
  return (
    <section className="tr-dest tr-home" aria-label="Inicio">
      <header className="tr-head">
        <div>
          <h1>Inicio</h1>
          <div className="sub">{date} · {projects.length} {projects.length === 1 ? 'proyecto' : 'proyectos'} en {ws.root}</div>
        </div>
        <span className="grow" />
        <button className="tr-btn" onClick={openFolder}><Icon name="folder" size={14} /> Abrir carpeta…</button>
        <button className="tr-btn" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> Nuevo proyecto</button>
        <button className="tr-btn pearl" disabled={!resumeLabel} onClick={onResume} title={resumeLabel ? `Retomar ${resumeLabel}` : 'Aún no hay trabajo que retomar'}>
          <Icon name="play" size={13} /> {resumeLabel ? 'Retomar' : 'Retomar sesión'}
        </button>
      </header>
      <div className="tr-body home-grid">
        {resumeLabel && (
          <button className="tr-card home-resume" onClick={onResume}>
            <span className="tr-lab">Donde lo dejaste</span>
            <span className="home-resume-t">{resumeLabel}</span>
            <span className="mut">{ago(resume!.at)} · {shortDest(resume!.dest)}</span>
          </button>
        )}
        <section className="tr-card home-att" aria-label="Necesita atención">
          <h2><Icon name="warn" size={14} /> Necesita atención <span className="mut mono">{loading ? '…' : attention.length}</span></h2>
          {loading ? <Skeleton /> : attention.length === 0
            ? <p className="mut home-calm">Nada bloqueado ni esperando permiso.</p>
            : <ul className="tr-list">{attention.map((a) => (
              <li key={a.key}><button className="tr-li" onClick={a.run}><span className={`tr-chip ${a.tone}`}><Icon name={a.icon} size={11} /></span><span className="t">{a.title}</span><span className="meta">{a.meta}</span></button></li>
            ))}</ul>}
        </section>
        <section className="tr-card home-run" aria-label="En marcha">
          <h2><Icon name="agent" size={14} /> En marcha <span className="mut mono">{loading ? '…' : running.length}</span></h2>
          {loading ? <Skeleton /> : running.length === 0
            ? <p className="mut home-calm">Ningún agente trabajando ahora mismo.</p>
            : <ul className="tr-list">{running.map((r) => (
              <li key={r.key}><button className="tr-li" onClick={r.run}><span className={`dot${r.live ? ' is-trabajando' : ''}`} /><span className="t">{r.title}</span><span className="meta">{r.meta}</span></button></li>
            ))}</ul>}
        </section>
        <section className="tr-card home-projects" aria-label="Proyectos">
          <h2><Icon name="folder" size={14} /> Proyectos</h2>
          {projects.length === 0 ? (
            <div className="tr-empty"><h3>Sin proyectos</h3><p>Crea uno nuevo o abre otra carpeta de proyectos.</p></div>
          ) : (
            <div className="home-pgrid">
              {projects.map((p) => {
                const s = snaps?.find((x) => x.project.path === p.path);
                const active = s?.tasks?.filter((t) => ACTIVE.has(t.status)).length ?? null;
                const att = s?.tasks?.filter((t) => ATTENTION.has(t.status)).length ?? 0;
                const open = s?.sessions?.length ?? null;
                const last = s?.tasks?.reduce((m, t) => Math.max(m, t.updatedAt), 0) ?? 0;
                return (
                  <button key={p.path} className={`home-proj${p.path === project ? ' on' : ''}`} onClick={() => onProject(p.path)} title={p.path}>
                    <span className="home-proj-n">{p.name}</span>
                    <span className="home-proj-m">
                      {s === undefined ? <span className="tr-skel" style={{ width: 90 }} /> : s.error && s.tasks === null ? <span className="mut">sin lectura</span> : <>
                        <span>{open ?? '—'} {open === 1 ? 'sesión' : 'sesiones'}</span>
                        <span>{active ?? '—'} activas</span>
                        {att > 0 && <span className="amb">{att} con atención</span>}
                      </>}
                    </span>
                    {s?.work && <span className="tr-chip sky" title={s.work.objective}>{s.work.state === 'active' ? 'sesión de trabajo' : s.work.state === 'review' ? 'en revisión' : 'terminada'}</span>}
                    {last > 0 && <span className="home-proj-t mono">{ago(ms(last))}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </section>
        <section className="tr-card home-recent" aria-label="Actividad reciente">
          <h2><Icon name="clock" size={14} /> Actividad reciente</h2>
          {loading ? <Skeleton /> : recent.length === 0
            ? <p className="mut home-calm">Todavía no hay tareas registradas.</p>
            : <ul className="tr-list">{recent.map(({ t, p }) => (
              <li key={`${p.path}:${t.id}`}><button className="tr-li" onClick={() => onWork(p.path, t.id)}>
                <span className={`tr-chip ${t.status === 'done' ? 'mint' : ATTENTION.has(t.status) ? 'amber' : ''}`}>{STATUS[t.status] ?? t.status}</span>
                <span className="t">#{t.id} {t.title}</span><span className="meta">{p.name} · {ago(ms(t.updatedAt))}</span>
              </button></li>
            ))}</ul>}
        </section>
      </div>
      {creating && (
        <Modal title="Nuevo proyecto" onClose={() => setCreating(false)}>
          <p>Se crea una carpeta nueva en {ws.root}.</p>
          <label className="tr-field-row">Nombre
            <input autoFocus value={name} onChange={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          </label>
          {createError && <div className="tr-error" role="alert" style={{ marginTop: 10 }}>{createError}</div>}
          <div className="acts">
            <button className="tr-btn ghost" onClick={() => setCreating(false)}>Cancelar</button>
            <button className={`tr-btn pearl${busy ? ' busy' : ''}`} disabled={!name.trim() || busy} onClick={create}>Crear</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

const shortDest = (d: string) => ({ inicio: 'Inicio', workspace: 'Workspace', flow: 'Flow', studio: 'Studio', entrega: 'Entrega', brain: 'Brain', ajustes: 'Ajustes' } as Record<string, string>)[d] ?? d;

function Skeleton() {
  return <div className="tr-loading" aria-label="Cargando"><div className="tr-skel" style={{ width: '70%' }} /><div className="tr-skel" style={{ width: '50%' }} /><div className="tr-skel" style={{ width: '60%' }} /></div>;
}
