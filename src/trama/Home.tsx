import { useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api, git, sessions as sessionApi, tasks as taskApi, workSessions, type Project, type Session, type Task, type WorkSession, type Workspace } from '../ipc';
import { STATUS } from './taskMeta';
import { useUi } from '../ui';
import { Icon } from './icons';
import { AgDot, EmptyArt, Root, Sigil, StDot, ago, ambient, sessionAgents, type Agent } from './kit';
import { Modal } from './ui';
import type { Resume } from './nav';

// Inicio de Trama v2: composición del Artifact (continuidad de sesión con la
// trama del equipo, proyectos con sigilo y actividad, atención y agentes)
// alimentada solo con datos reales.
type Snap = { project: Project; tasks: Task[] | null; sessions: Session[] | null; work: WorkSession | null; branch: string | null; activity: number[] | null; last: number | null };
const ATTENTION = new Set(['waiting_approval', 'blocked', 'failed', 'paused_quota']);
const RUNNING = new Set(['running', 'verifying']);
const DAYS = 21;

function activityOf(dates: string[]) {
  const bins = new Array(DAYS).fill(0);
  const today = new Date(); today.setHours(23, 59, 59, 999);
  for (const d of dates) {
    const k = Math.floor((today.getTime() - new Date(d).getTime()) / 86400000);
    if (k >= 0 && k < DAYS) bins[DAYS - 1 - k]++;
  }
  return bins;
}

export default function Home({ ws, project, agentSessions, pm, resume, onWs, onProject, onSession, onWork, onResume, onFlow, onError }: {
  ws: Workspace;
  project: string | null;
  agentSessions: Session[];
  pm: { engine: string } | null;
  resume: Resume | null;
  onWs: (ws: Workspace) => void;
  onProject: (path: string) => void;
  onSession: (path: string, view: 'coach' | number) => void;
  onWork: (path: string, task?: number) => void;
  onResume: () => void;
  onFlow: (path: string) => void;
  onError: (e: string) => void;
}) {
  const { activity } = useUi();
  const [snaps, setSnaps] = useState<Record<string, Snap>>({});
  const [creating, setCreating] = useState(false);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const projects = useMemo(() => ws.projects.filter((p) => !p.archived), [ws.projects]);

  useEffect(() => {
    let alive = true;
    const load = () => projects.slice(0, 30).forEach(async (p) => {
      const [t, s, w, b, l] = await Promise.allSettled([taskApi.list(p.path), sessionApi.list(p.path), workSessions.current(p.path), git.head(p.path), git.log(p.path)]);
      if (!alive) return;
      const dates = l.status === 'fulfilled' ? l.value.map((r) => r.date) : null;
      setSnaps((m) => ({ ...m, [p.path]: {
        project: p,
        tasks: t.status === 'fulfilled' ? t.value : null,
        sessions: s.status === 'fulfilled' ? s.value : null,
        work: w.status === 'fulfilled' ? w.value : null,
        branch: b.status === 'fulfilled' ? b.value : null,
        activity: dates ? activityOf(dates) : null,
        last: dates && dates.length ? Math.max(...dates.map((d) => new Date(d).getTime())) : null,
      } }));
    });
    load();
    const timer = window.setInterval(load, 30000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [projects]);

  // Proyecto protagonista: el que se dejó a medias, o el abierto.
  const resumeAvailable = resume && projects.some((p) => p.path === resume.project);
  const focusPath = (resumeAvailable ? resume.project : project) ?? projects[0]?.path ?? null;
  const focus = focusPath ? snaps[focusPath] : undefined;
  const focusName = ws.projects.find((p) => p.path === focusPath)?.name ?? '';
  const isCurrent = focusPath === project;
  const agents: Agent[] = useMemo(() => {
    if (!focusPath) return [];
    return sessionAgents(isCurrent ? agentSessions : focus?.sessions ?? [], isCurrent ? activity : {}, isCurrent ? pm : null);
  }, [focusPath, isCurrent, agentSessions, focus?.sessions, activity, pm]);
  const live = agents.filter((a) => a.state === 'working' || a.state === 'waiting' || a.state === 'thinking');
  const tasks = focus?.tasks ?? [];
  const running = tasks.filter((t) => RUNNING.has(t.status));
  const pending = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const lead = focus?.work?.objective ?? running[0]?.title ?? pending[0]?.title ?? null;
  const resting = live.length === 0;

  const attention = useMemo(() => {
    const out: { key: string; st: 'waiting' | 'blocked' | 'paused'; title: string; text: string; action: string; run: () => void; warn?: boolean }[] = [];
    if (project) for (const [key, state] of Object.entries(activity)) {
      if (state !== 'permiso') continue;
      const s = key === 'coach' ? null : agentSessions.find((x) => String(x.id) === key);
      if (key !== 'coach' && !s) continue;
      out.push({ key: `p${key}`, st: 'waiting', title: `${s ? s.name : 'Project manager'} pide permiso`, text: ws.projects.find((p) => p.path === project)?.name ?? '', action: 'Ver la petición', warn: true, run: () => onSession(project, s ? s.id : 'coach') });
    }
    for (const { path } of projects) {
      const snap = snaps[path];
      if (!snap) continue;
      for (const t of snap.tasks ?? []) {
        if (!ATTENTION.has(t.status)) continue;
        out.push({ key: `t${snap.project.path}:${t.id}`, st: t.status === 'paused_quota' ? 'paused' : t.status === 'waiting_approval' ? 'waiting' : 'blocked', title: `${STATUS[t.status]}: ${t.title}`, text: `${snap.project.name} · tarea #${t.id}`, action: 'Abrir tarea', run: () => onWork(snap.project.path, t.id) });
      }
      if (snap.work?.state === 'review') out.push({ key: `w${snap.project.path}`, st: 'waiting', title: 'Sesión de trabajo lista para revisar', text: `${snap.project.name} · ${snap.work.objective}`, action: 'Revisar', run: () => onWork(snap.project.path) });
    }
    return out;
  }, [activity, snaps, agentSessions, project, projects, ws.projects, onSession, onWork]);

  const working = sessionAgents(agentSessions, activity, pm).filter((a) => a.state === 'working' || a.state === 'thinking');
  const groups = useMemo(() => {
    const named = ws.groups.map((g) => ({ name: g.name, items: projects.filter((p) => p.groupId === g.id) })).filter((g) => g.items.length);
    const loose = projects.filter((p) => p.groupId == null || !ws.groups.some((g) => g.id === p.groupId));
    return loose.length ? [...named, { name: 'Sin grupo', items: loose }] : named;
  }, [ws.groups, projects]);

  const openFolder = async () => {
    try { const chosen = await open({ directory: true, defaultPath: ws.root ?? undefined }); if (typeof chosen === 'string') onWs(await api.setRoot(chosen)); }
    catch (e) { onError(String(e)); }
  };
  let date = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  date = date[0].toUpperCase() + date.slice(1);

  return (
    <Root label="Inicio">
      <div className="home scr">
        <div className="col" style={{ gap: 0 }}>
          <div className="when">{date}</div>
          <h1 className="vt">{resumeAvailable ? 'Continúa donde lo dejaste' : focusPath ? 'Empieza con un proyecto' : 'Bienvenido a Filigranas'}</h1>
          {focusPath && (
            <section className="resume" aria-label="Última sesión">
              <div className="shot"><Tapestry agents={agents.filter((a) => a.id !== 'pm')} label={focus?.branch ?? focusName} sub={focus?.tasks ? `${pending.length} tareas · ${running.length} en curso` : ''} resting={resting} /></div>
              <div className="meta">
                <div className="row wrap">
                  {focus?.branch && <span className="chip sky"><Icon name="branch" size={12} /> {focus.branch}</span>}
                  {focus?.work && <span className="chip">sesión de trabajo · {focus.work.state === 'active' ? 'en curso' : focus.work.state === 'review' ? 'en revisión' : 'terminada'}</span>}
                  {resting && <span className="chip">en calma</span>}
                </div>
                <h2>{lead ?? focusName}</h2>
                {agents.length ? (
                  <div className="col" style={{ gap: 7 }}>
                    {agents.slice(0, 5).map((a) => (
                      <button key={a.id} className="agline home-agline" onClick={() => focusPath && onSession(focusPath, a.session ?? 'coach')}><AgDot a={a} /><b>{a.name}</b><span className="mut2">{a.did}</span></button>
                    ))}
                    {agents.length > 5 && <span className="mut">y {agents.length - 5} sesiones más</span>}
                  </div>
                ) : (
                  <p className="mut2" style={{ margin: 0, lineHeight: 1.55 }}>No hay sesiones abiertas en {focusName}. Pide al Project manager que planifique el trabajo o abre una conversación directa.</p>
                )}
                {running[0] ? (
                  <div className="last">«{running[0].title}» está {STATUS[running[0].status]}. <span className="mut">Tarea #{running[0].id} · {ago(running[0].updatedAt)}</span></div>
                ) : pending[0] ? (
                  <div className="last">Siguiente tarea: «{pending[0].title}». <span className="mut">{STATUS[pending[0].status]} · #{pending[0].id}</span></div>
                ) : null}
                <div className="row" style={{ marginTop: 'auto' }}>
                  <button className="btn pearl" onClick={resumeAvailable ? onResume : () => focusPath && onProject(focusPath)}><Icon name="play" size={13} /> {resumeAvailable ? 'Retomar sesión' : 'Abrir proyecto'} <span className="kbd dark">↩</span></button>
                  <button className="btn" onClick={() => onFlow(focusPath)}><Icon name="flow" size={14} /> Ver el equipo</button>
                </div>
              </div>
            </section>
          )}
          <section className="projects pane" aria-label="Proyectos">
            <div className="projects-head">
              <h3>Proyectos</h3>
              <div className="projects-actions">
                <button className="btn" onClick={openFolder}><Icon name="folder" size={15} /> Abrir carpeta…</button>
                <button className="btn pearl" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> Nuevo proyecto…</button>
              </div>
            </div>
            {projects.length === 0 && <div className="empty"><EmptyArt /><h3>Sin proyectos</h3><p>La carpeta {ws.root} no tiene proyectos todavía.</p></div>}
            {groups.map((g) => (
              <div className="projects-group" key={g.name}>
                <h4 className="pgroup">{g.name}</h4>
                <ul className="projects-list">
                  {g.items.map((p) => (
                    <li key={p.path}>
                      <ProjectRow p={p} snap={snaps[p.path]} current={p.path === project} agents={p.path === project ? sessionAgents(agentSessions, activity, null) : []} onOpen={() => onProject(p.path)} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </div>
        <aside className="col" style={{ gap: 14 }}>
          <section className="pane attn" aria-label="Necesita tu atención">
            <h3>Necesita tu atención</h3>
            {attention.length === 0 ? (
              <div className="home-calm"><EmptyArt /><p>Nada espera tu permiso ni está bloqueado.</p></div>
            ) : (showAllAttention ? attention : attention.slice(0, 6)).map((a) => (
              <div key={a.key} className="aitem"><StDot st={a.st} /><div><div className="t">{a.title}</div><p>{a.text}</p><button className={`btn sm${a.warn ? ' warn' : ''}`} onClick={a.run}>{a.action}</button></div></div>
            ))}
            {attention.length > 6 && <button className="btn sm ghost" aria-expanded={showAllAttention} onClick={() => setShowAllAttention(!showAllAttention)}>{showAllAttention ? 'Ver menos' : `Ver ${attention.length - 6} más`}</button>}
          </section>
          <section className="pane attn" aria-label="Trabajando ahora">
            <h3>Trabajando ahora</h3>
            {working.length === 0 ? <p className="mut2" style={{ margin: 0 }}>Ningún agente trabajando en este momento.</p>
              : working.map((a) => (
                <button key={a.id} className="agline home-agline" onClick={() => project && onSession(project, a.session ?? 'coach')}><AgDot a={a} /><span className="grow"><b>{a.name}</b><br /><span className="mut2">{a.did}</span></span></button>
              ))}
          </section>
          <p className="sample">{projects.length} proyectos en {ws.root}</p>
        </aside>
      </div>
      {creating && <NewProject root={ws.root ?? ''} onClose={() => setCreating(false)} onDone={(next, path) => { onWs(next); setCreating(false); if (path) onProject(path); }} />}
    </Root>
  );
}

function ProjectRow({ p, snap, current, agents, onOpen }: { p: Project; snap?: Snap; current: boolean; agents: Agent[]; onOpen: () => void }) {
  const act = snap?.activity;
  const mx = act ? Math.max(...act, 1) : 1;
  const last = snap?.last ? ago(snap.last) : null;
  const att = snap?.tasks?.filter((t) => ATTENTION.has(t.status)).length ?? 0;
  const run = snap?.tasks?.filter((t) => RUNNING.has(t.status)).length ?? 0;
  const live = agents.filter((a) => a.state !== 'idle');
  const calm = !live.length && !att && !run && !snap?.work;
  return (
    <button className={`prow${current ? ' on' : ''}`} onClick={onOpen} aria-current={current ? true : undefined} aria-label={`Abrir ${p.name}`} title={p.path}>
      <span className="glyph"><Sigil name={p.name} /></span>
      <span className="pn">
        <span className="nm">{p.name}</span>
        <span className="project-details">
          {snap?.branch && <span className="branch-line"><Icon name="branch" size={12} /><span className="br">{snap.branch}</span></span>}
          {!calm && <span className="stt">
            {live.map((a) => <AgDot key={a.id} a={a} s={12} />)}
            {att > 0 && <span className="chip amber">{att} con atención</span>}
            {run > 0 && <span className="chip sky">{run} en curso</span>}
            {snap?.work && <span className="chip">{snap.work.state === 'review' ? 'en revisión' : 'sesión de trabajo'}</span>}
          </span>}
        </span>
      </span>
      <span className="project-history">
        {act?.some(Boolean) && <span className="project-activity" role="img" aria-label="Commits de las últimas tres semanas" title="Commits de las últimas tres semanas">
          {act.map((value, i) => <i key={i} className={value ? 'has-commits' : undefined} style={{ height: value ? 4 + (value / mx) * 13 : 2 }} />)}
        </span>}
        {last && <span className="tm" title="Último commit">{last === 'ahora' ? 'Ahora' : `Hace ${last}`}</span>}
      </span>
      <span className="project-open"><Icon name="chev" size={16} /></span>
    </button>
  );
}

/** Trama del equipo: una línea de puntos por sesión que converge en el proyecto. */
function Tapestry({ agents, label, sub, resting }: { agents: Agent[]; label: string; sub: string; resting: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const kick = useRef<() => void>(() => {});
  const data = useRef({ agents, label, sub, resting });
  data.current = { agents, label, sub, resting };
  useEffect(() => {
    const cv = ref.current!;
    let raf = 0, last = 0, sphere: HTMLCanvasElement | null = null, size = '';
    const frame = (t: number) => {
      if (!cv.isConnected) return;
      if (t - last < 50 && t) { raf = requestAnimationFrame(frame); return; }
      last = t;
      const box = cv.parentElement!.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
      const W = box.width, H = box.height, cx = W * 0.62, cy = H * 0.5;
      const key = `${W}x${H}`;
      if (key !== size) {
        size = key; cv.width = W * d; cv.height = H * d;
        sphere = document.createElement('canvas'); sphere.width = W * d; sphere.height = H * d;
        const sc = sphere.getContext('2d')!; sc.scale(d, d);
        for (let y = 4; y < H; y += 6) for (let x = 4; x < W; x += 6) {
          const dd = Math.hypot(x - cx, (y - cy) * 1.1), l = Math.max(0, 1 - dd / (H * 0.42));
          if (l < 0.05) continue;
          const z = Math.min(4.4, l * 6);
          sc.fillStyle = `rgba(${(200 + l * 55) | 0},${(205 + l * 50) | 0},255,${0.2 + l * 0.75})`; sc.fillRect(x - z / 2, y - z / 2, z, z);
        }
      }
      const c = cv.getContext('2d')!;
      c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, W, H);
      const { agents: A, label: lb, sub: sb, resting: rest } = data.current;
      // en reposo la esfera respira despacio; con actividad, luce plena
      const breath = rest ? (ambient() ? 0.55 + 0.2 * Math.sin(t / 1300) : 0.6) : 1;
      c.globalAlpha = breath; c.drawImage(sphere!, 0, 0, W, H); c.globalAlpha = 1;
      const n = Math.max(1, A.length);
      A.slice(0, 7).forEach((a, i) => {
        const y = H * (n === 1 ? 0.5 : 0.14 + (i * 0.72) / (Math.min(n, 7) - 1));
        const hex = a.h.replace('#', ''), rgb = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16)).join(',');
        const on = a.state === 'working' || a.state === 'waiting', ph = (t / 1500 + i * 0.17) % 1;
        for (let k = 0; k < 60; k++) {
          const p = k / 60, x = 18 + p * (cx - 62), yy = y + (cy - y) * (p * p * (3 - 2 * p)) + Math.sin(k * 12.9 + i * 7.3);
          const near = on && Math.abs(p - ph) < 0.05 && ambient();
          const al = a.state === 'idle' || a.state === 'paused' ? 0.18 : 0.38 + (near ? 0.55 : 0);
          c.fillStyle = a.state === 'waiting' ? `rgba(255,178,94,${al})` : `rgba(${rgb},${al})`;
          const z = near ? 2.6 : 1.4; c.fillRect(x, yy, z, z);
        }
        c.fillStyle = `rgba(${rgb},.95)`; c.font = '600 10.5px Iosevka,"JetBrains Mono",monospace';
        c.fillText(a.name.toUpperCase(), 18, y - 8);
      });
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.beginPath(); c.moveTo(cx + 30, cy - 30); c.lineTo(cx + 56, cy - 56); c.stroke();
      c.fillStyle = '#fff'; c.font = '600 12px -apple-system,Inter,sans-serif'; c.fillText(lb, cx + 60, cy - 62);
      c.fillStyle = 'rgba(255,255,255,.65)'; c.font = '11px Iosevka,"JetBrains Mono",monospace'; c.fillText(sb, cx + 60, cy - 47);
      if (!A.length) {
        // reposo: dos hilos tenues para los motores disponibles, sin actividad
        ['CODEX · LIBRE', 'CLAUDE · LIBRE'].forEach((name, i) => {
          const y = H * (0.36 + i * 0.28);
          for (let k = 0; k < 60; k++) { const p = k / 60, x = 18 + p * (cx - 62), yy = y + (cy - y) * (p * p * (3 - 2 * p)); c.fillStyle = `rgba(190,200,230,${0.1 + 0.08 * breath})`; c.fillRect(x, yy, 1.3, 1.3); }
          c.fillStyle = 'rgba(190,200,230,.5)'; c.font = '600 10.5px Iosevka,"JetBrains Mono",monospace'; c.fillText(name, 18, y - 8);
        });
      }
      if (ambient() && !document.hidden) raf = requestAnimationFrame(frame);
    };
    kick.current = () => { cancelAnimationFrame(raf); last = 0; raf = requestAnimationFrame(frame); };
    raf = requestAnimationFrame(frame);
    const ro = new ResizeObserver(() => kick.current());
    ro.observe(cv.parentElement!);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  // con movimiento reducido, redibuja al cambiar los datos
  useEffect(() => { kick.current(); }, [agents, label, sub, resting]);
  return <canvas ref={ref} aria-hidden="true" />;
}

function NewProject({ root, onClose, onDone }: { root: string; onClose: () => void; onDone: (ws: Workspace, path: string | null) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true); setError(null);
    try { const next = await api.createProject(n); onDone(next, next.projects.find((p) => p.name === n)?.path ?? null); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title="Nuevo proyecto" onClose={onClose}>
      <p>Se crea una carpeta nueva en {root}.</p>
      <label className="tr-field-row">Nombre<input value={name} onChange={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && create()} /></label>
      {error && <div className="tr-error" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <div className="acts">
        <button className="tr-btn ghost" onClick={onClose}>Cancelar</button>
        <button className={`tr-btn pearl${busy ? ' busy' : ''}`} disabled={!name.trim() || busy} onClick={create}>Crear</button>
      </div>
    </Modal>
  );
}
