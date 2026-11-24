import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { api, type HomeSummary, type Project, type Session, type Workspace } from '../ipc';
import { STATUS } from './taskMeta';
import { useUi } from '../ui';
import { Icon } from './icons';
import { AgDot, EmptyArt, Root, Sigil, StDot, ago, sessionAgents, type Agent } from './kit';
import { ambientEnabled, useMotion } from './motion';
import { Modal } from './ui';
import type { Resume } from './nav';

// Inicio de Trama v2: composición del Artifact (continuidad de sesión con la
// trama del equipo, proyectos con sigilo y actividad, atención y agentes)
// alimentada solo con datos reales.
type Snap = HomeSummary & { activity: number[] | null; last: number | null };
const EMPTY_SNAPS: Record<string, Snap> = {};
const ATTENTION = new Set(['waiting_approval', 'blocked', 'failed', 'paused_quota']);
const RUNNING = new Set(['running', 'verifying']);
const DAYS = 21;
const REFRESH_MS = 30_000;

function activityOf(dates: string[]) {
  const bins = new Array(DAYS).fill(0);
  const today = new Date(); today.setHours(23, 59, 59, 999);
  for (const d of dates) {
    const k = Math.floor((today.getTime() - new Date(d).getTime()) / 86400000);
    if (k >= 0 && k < DAYS) bins[DAYS - 1 - k]++;
  }
  return bins;
}

export default function Home({ active, ws, project, agentSessions, pm, resume, onWs, onProject, onSession, onWork, onResume, onFlow, onCi, onError }: {
  active: boolean;
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
  onCi: (path: string) => void;
  onError: (e: string) => void;
}) {
  const { activity } = useUi();
  const [summary, setSummary] = useState<{ key: string; snaps: Record<string, Snap> }>();
  const [creating, setCreating] = useState(false);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const projects = useMemo(() => ws.projects.filter((p) => !p.archived), [ws.projects]);
  const resumeAvailable = resume && projects.some((p) => p.path === resume.project);
  const focusPath = (resumeAvailable ? resume.project : project) ?? projects[0]?.path ?? null;
  const paths = projects.slice(0, 30).map(({ path }) => path);
  if (focusPath && !paths.includes(focusPath)) paths.push(focusPath);
  const scope = JSON.stringify([paths, focusPath]);
  const snaps = summary?.key === scope ? summary.snaps : EMPTY_SNAPS;
  const shown = useRef(active);
  const resumeSummary = useRef<() => void>(() => {});
  shown.current = active;

  useEffect(() => {
    let alive = true;
    let loading = false;
    let expiresAt = 0;
    let revision = 0;
    let refresh: number;
    const [selection, focus]: [string[], string | null] = JSON.parse(scope);
    const load = async () => {
      if (!alive || !shown.current || loading || document.hidden || Date.now() < expiresAt) return;
      const id = revision;
      loading = true;
      try {
        const items = await api.homeSummary(selection, focus);
        if (!alive || id !== revision) return;
        expiresAt = Date.now() + REFRESH_MS;
        setSummary({ key: scope, snaps: Object.fromEntries(items.map((item) => [item.path, {
          ...item,
          activity: item.dates ? activityOf(item.dates) : null,
          last: item.dates?.length ? Math.max(...item.dates.map((date) => new Date(date).getTime())) : null,
        }])) });
      } catch {
        // Keep the last available summary and retry after the next refresh.
      } finally {
        loading = false;
        if (alive && id !== revision) invalidate();
      }
    };
    const invalidate = () => {
      revision++;
      expiresAt = 0;
      window.clearTimeout(refresh);
      if (shown.current && !loading) refresh = window.setTimeout(load, 180);
    };
    const subscriptions = ['project-changed', 'tasks-changed', 'sessions-changed'].map((event) => listen(event, invalidate));
    resumeSummary.current = load;
    const initial = window.setTimeout(load);
    const timer = window.setInterval(load, REFRESH_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      alive = false; window.clearTimeout(refresh); window.clearTimeout(initial); window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten());
    };
  }, [scope]);
  useEffect(() => {
    if (active) resumeSummary.current();
    else { setCreating(false); setShowAllAttention(false); }
  }, [active]);

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
    if (!active) return out;
    if (project) for (const [key, state] of Object.entries(activity)) {
      if (state !== 'permiso') continue;
      const s = key === 'coach' ? null : agentSessions.find((x) => String(x.id) === key);
      if (key !== 'coach' && !s) continue;
      out.push({ key: `p${key}`, st: 'waiting', title: `${s ? s.name : 'Project manager'} pide permiso`, text: ws.projects.find((p) => p.path === project)?.name ?? '', action: 'Ver la petición', warn: true, run: () => onSession(project, s ? s.id : 'coach') });
    }
    for (const { path, name } of projects) {
      const snap = snaps[path];
      if (!snap) continue;
      if (snap.ci?.checksState === 'failure' && snap.ci.checksKnown) {
        const [passed, failed, waiting] = snap.ci.checks;
        out.push({ key: `ci:${path}`, st: 'blocked', title: `CI fallido en ${name}`,
          text: `PR #${snap.ci.number} · ${failed} de ${passed + failed + waiting} checks`,
          action: 'Abrir entrega', run: () => onCi(path) });
      }
      for (const t of snap.tasks ?? []) {
        if (!ATTENTION.has(t.status)) continue;
        out.push({ key: `t${path}:${t.id}`, st: t.status === 'paused_quota' ? 'paused' : t.status === 'waiting_approval' ? 'waiting' : 'blocked', title: `${STATUS[t.status]}: ${t.title}`, text: `${name} · tarea #${t.id}`, action: 'Abrir tarea', run: () => onWork(path, t.id) });
      }
      if (snap.work?.state === 'review') out.push({ key: `w${path}`, st: 'waiting', title: 'Sesión de trabajo lista para revisar', text: `${name} · ${snap.work.objective}`, action: 'Revisar', run: () => onWork(path) });
    }
    return out;
  }, [active, activity, snaps, agentSessions, project, projects, ws.projects, onSession, onWork, onCi]);

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
  const date = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });

  if (!active) return null;
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
                <button className="btn sm" onClick={openFolder}><Icon name="folder" size={13} /> Abrir carpeta</button>
                <button className="btn sm" onClick={() => setCreating(true)}><Icon name="plus" size={13} /> Nuevo proyecto</button>
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
  const ci = snap?.ci;
  const failedCi = ci?.checksKnown && ci.checksState === 'failure';
  const calm = !live.length && !att && !run && !snap?.work && !ci;
  return (
    <button className={`prow${current ? ' on' : ''}`} onClick={onOpen} aria-current={current ? true : undefined} aria-label={`Abrir ${p.name}`} title={p.path}>
      <span className="glyph"><Sigil name={p.name} /></span>
      <span className="pn">
        <span className="nm">{p.name}</span>
        {snap?.branch && <span className="br">{snap.branch}</span>}
      </span>
      <span className="project-activity" role="img" aria-label="Commits de las últimas tres semanas" title="Commits de las últimas tres semanas">
        {(act ?? Array<number>(21).fill(0)).map((value, i) => <i key={i}
          style={{ height: value ? 4 + (value / mx) * 16 : 2, background: value >= mx * 0.7 ? 'var(--tx2)' : undefined }} />)}
      </span>
      <span className="stt">
        {live.map((a) => <AgDot key={a.id} a={a} s={12} />)}
        {att > 0 && <span className="chip amber">{att} con atención</span>}
        {run > 0 && <span className="chip sky">{run} en curso</span>}
        {snap?.work && <span className="chip">{snap.work.state === 'review' ? 'en revisión' : 'sesión de trabajo'}</span>}
        {ci && <span className={`chip${failedCi ? ' coral' : ''}`} title={`Observación de ${ci.head.slice(0, 7)}`}>
          {failedCi ? 'CI fallido' : `PR #${ci.number} ${ci.isDraft ? 'en borrador' : ci.checksState === 'success' && ci.review === 'APPROVED' ? 'lista' : 'en revisión'}`}
        </span>}
        {calm && snap && <span className="mut">en calma</span>}
      </span>
      <span className="tm" title={last ? 'Último commit' : undefined}>{last}</span>
    </button>
  );
}

/** Trama del equipo: una línea de puntos por sesión que converge en el proyecto. */
function Tapestry({ agents, label, sub, resting }: { agents: Agent[]; label: string; sub: string; resting: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const kick = useRef<() => void>(() => {});
  const motion = useMotion();
  const data = useRef({ agents, label, sub, resting });
  data.current = { agents, label, sub, resting };
  useEffect(() => {
    const cv = ref.current!;
    const c = cv.getContext('2d')!;
    const sphere = document.createElement('canvas');
    const sc = sphere.getContext('2d')!;
    let raf = 0, seed = 11;
    let W = 0, H = 0, d = 0, cx = 0, cy = 0;
    const noise = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const thresholds = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const resize = () => {
      const box = cv.parentElement!.getBoundingClientRect();
      const scale = Math.min(2, devicePixelRatio || 1);
      if (box.width === W && box.height === H && d === scale) return;
      W = box.width; H = box.height; d = scale; cx = W * 0.6; cy = H * 0.5;
      cv.width = sphere.width = Math.round(W * d);
      cv.height = sphere.height = Math.round(H * d);
      sc.setTransform(d, 0, 0, d, 0, 0);
      for (let y = 4; y < H; y += 6) for (let x = 4; x < W; x += 6) {
        const dd = Math.hypot(x - cx, (y - cy) * 1.1), l = Math.max(0, 1 - dd / (H * 0.42));
        if (l < 0.05) continue;
        const threshold = thresholds[((y / 6 | 0) & 3) * 4 + ((x / 6 | 0) & 3)] / 16;
        if (l < 0.45 && l * 2.2 < threshold) continue;
        const z = Math.min(4.4, l * 6);
        sc.fillStyle = `rgba(${(200 + l * 55) | 0},${(205 + l * 50) | 0},255,${0.25 + l * 0.75})`;
        sc.fillRect(x - z / 2, y - z / 2, z, z);
      }
      kick.current();
    };
    const frame = (t: number) => {
      if (!W || !H || document.hidden) return;
      const live = ambientEnabled();
      c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, W, H);
      const { agents: A, label: lb, sub: sb, resting: rest } = data.current;
      // en reposo la esfera respira despacio; con actividad, luce plena
      const breath = rest ? (live ? 0.55 + 0.2 * Math.sin(t / 1300) : 0.6) : 1;
      c.globalAlpha = breath; c.drawImage(sphere, 0, 0, W, H); c.globalAlpha = 1;
      const n = Math.max(1, A.length);
      A.slice(0, 7).forEach((a, i) => {
        const y = H * (n === 1 ? 0.5 : 0.14 + (i * 0.72) / (Math.min(n, 7) - 1));
        const hex = a.h.replace('#', ''), rgb = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16)).join(',');
        const on = a.state === 'working' || a.state === 'waiting', ph = (t / 1400 + i * 0.17) % 1;
        for (let k = 0; k < 60; k++) {
          const p = k / 60, x = 18 + p * (cx - 60), yy = y + (cy - y) * (p * p * (3 - 2 * p)) + (live ? (noise() - 0.5) * 2 : 0);
          const near = live && on && Math.abs(p - ph) < 0.05;
          const al = a.state === 'idle' || a.state === 'paused' ? 0.15 : 0.35 + (near ? 0.6 : 0);
          c.fillStyle = a.state === 'waiting' ? `rgba(255,178,94,${al})` : `rgba(${rgb},${al})`;
          const z = near ? 2.6 : 1.4; c.fillRect(x, yy, z, z);
        }
        c.fillStyle = `rgba(${rgb},.95)`; c.font = '600 10px Iosevka,"JetBrains Mono",monospace';
        c.fillText(a.name.toUpperCase(), 18, y - 8);
      });
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.beginPath(); c.moveTo(cx + 30, cy - 30); c.lineTo(cx + 58, cy - 58); c.stroke();
      c.fillStyle = '#fff'; c.font = '600 11px -apple-system,Inter,sans-serif'; c.fillText(lb, cx + 62, cy - 62);
      c.fillStyle = 'rgba(255,255,255,.55)'; c.font = '10px Iosevka,"JetBrains Mono",monospace'; c.fillText(sb, cx + 62, cy - 48);
      if (!A.length) {
        // reposo: dos hilos tenues para los motores disponibles, sin actividad
        ['CODEX · LIBRE', 'CLAUDE · LIBRE'].forEach((name, i) => {
          const y = H * (0.36 + i * 0.28);
          for (let k = 0; k < 60; k++) { const p = k / 60, x = 18 + p * (cx - 62), yy = y + (cy - y) * (p * p * (3 - 2 * p)); c.fillStyle = `rgba(190,200,230,${0.1 + 0.08 * breath})`; c.fillRect(x, yy, 1.3, 1.3); }
          c.fillStyle = 'rgba(190,200,230,.5)'; c.font = '600 10px Iosevka,"JetBrains Mono",monospace'; c.fillText(name, 18, y - 8);
        });
      }
      if (live) raf = requestAnimationFrame(frame);
    };
    kick.current = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv.parentElement!);
    const visibility = () => kick.current();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', resize);
    };
  }, []);
  // con movimiento reducido, redibuja al cambiar los datos
  useEffect(() => { kick.current(); }, [agents, label, sub, resting, motion]);
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
