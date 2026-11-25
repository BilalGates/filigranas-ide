import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeHealth from '../CodeHealth';
import ReviewDiff, { type ReviewNote } from './ReviewDiff';
import { openFindings } from './findings';
import GitPanel from '../GitPanel';
import Larry from '../Larry';
import Pending from '../Pending';
import Publish from '../Publish';
import WorkSession from '../WorkSession';
import { git, health, sessions as sessionApi, tasks as taskApi, workSessions, type Change, type DiffTarget, type GitStatus, type HealthRun, type LogRow, type PrInfo, type Session, type Task, type WorkSession as Work } from '../ipc';
import { Icon } from './icons';
import { EmptyArt, Root, StDot, ago } from './kit';

// Entrega de Trama v2: recorrido completo (tarea → integración) con el estado
// real de cada etapa, explorador de cambios, diff protagonista y auditoría.
// Las acciones usan los componentes y comandos existentes (commit, Larry,
// push, PR, merge e integración conservan sus aprobaciones).
type Stage = 'tarea' | 'agentes' | 'rama' | 'cambios' | 'tests' | 'commit' | 'pr' | 'ci' | 'integracion';
export type EntregaStage = Stage;
type StState = 'done' | 'now' | 'fail' | 'todo';
const noop = () => {};
const OUTCOME: Record<string, string> = { passed: 'correcto', failed: 'falló', findings: 'con hallazgos', incomplete: 'incompleto', unknown: 'desconocido' };
const checkTotal = (pull: PrInfo) => pull.checks.reduce((count, checks) => count + checks, 0);
export default function Entrega({ project, projectName, agentSessions, onFile, onConflicts, onBranchesChanged, initialScope = null, initialStage = null, initialCi = false, onConsumeCi }: {
  initialScope?: number | null;
  /** Etapa con la que se abre (Code Health, PR, commits o ramas sin integrar). */
  initialStage?: EntregaStage | null;
  initialCi?: boolean;
  onConsumeCi?: () => void;
  project: string | null;
  projectName: string | null;
  agentSessions: Session[];
  onFile: (path: string, session: number | null, root: string | null) => void;
  onConflicts: (files: string[]) => void;
  onBranchesChanged: () => void;
}) {
  const [finding, setFinding] = useState<{ fingerprint: string }>();
  const [stage, setStage] = useState<Stage | null>(initialCi ? 'ci' : initialStage);
  const [scopeId, setScopeId] = useState<number | null>(initialScope);
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<LogRow[] | null>(null);
  const [runs, setRuns] = useState<HealthRun[] | null>(null);
  const [pulls, setPulls] = useState<PrInfo[] | null>(null);
  const [work, setWork] = useState<Work | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const [left, setLeft] = useState(false);
  const [right, setRight] = useState(false);
  const isolated = agentSessions.filter((s) => s.worktree);
  const chosen = isolated.find((s) => s.id === scopeId) ?? null;
  const sid = chosen?.id ?? null;
  useEffect(() => {
    if (initialCi) {
      setStage('ci');
      onConsumeCi?.();
    }
  }, [initialCi, onConsumeCi]);

  const load = useCallback(async () => {
    if (!project) return;
    const id = ++request.current;
    const [st, lg, h, ci, w, t] = await Promise.allSettled([
      sid == null ? git.status(project) : sessionApi.changes(sid), sid == null ? git.log(project) : Promise.resolve([]), health.list(project, sid), health.ci(project, sid), workSessions.current(project), taskApi.list(project),
    ]);
    if (id !== request.current) return;
    setStatus(st.status === 'fulfilled' ? st.value : null);
    setLog(lg.status === 'fulfilled' ? lg.value : null);
    setRuns(h.status === 'fulfilled' ? h.value : null);
    setPulls(ci.status === 'fulfilled' ? ci.value : null);
    setWork(w.status === 'fulfilled' ? w.value : null);
    setTasks(t.status === 'fulfilled' ? t.value : null);
    const failed = [st, lg, h, ci, w, t].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    setError(failed ? String(failed.reason) : null);
  }, [project, sid]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 15000);
    return () => {
      request.current++;
      window.clearInterval(timer);
    };
  }, [load]);
  const selectScope = (id: number | null) => {
    request.current++;
    setStatus(null);
    setLog(null);
    setRuns(null);
    setPulls(null);
    setError(null);
    setDiff(null);
    setStage(null);
    setScopeId(id);
  };
  // con cambios pendientes, el primer archivo abre el diff como protagonista
  useEffect(() => { if (!diff && stage == null && status?.changes[0]) setDiff(sid == null ? status.changes[0] : { ...status.changes[0], session: sid }); }, [status, diff, stage, sid]);

  const changes = status?.changes ?? [];
  const lastRun = runs?.[0] ?? null;
  const open = useMemo(() => openFindings(runs), [runs]);
  const diffFindings = useMemo(() =>
    diff && (diff.session ?? null) === sid
      ? open.filter((finding) => finding.path === diff.path && finding.line != null)
      : undefined,
  [open, diff, sid]);
  const reviewers = [...new Set((diffFindings ?? []).flatMap((item) => item.who ?? []))];

  if (!project) return <Root label="Entrega"><div className="rev-empty"><div className="empty big"><EmptyArt /><h3>Elige un proyecto</h3><p>Entrega reúne cambios, commits, revisión, PR y CI del proyecto abierto.</p></div></div></Root>;

  const exactPull = status?.headSha ? pulls?.find((p) => p.head === status.headSha && p.state === 'OPEN')
    ?? pulls?.find((p) => p.head === status.headSha) : undefined;
  const pull = exactPull ?? pulls?.find((p) => p.state === 'OPEN') ?? pulls?.[0] ?? null;
  const ci = exactPull?.checksKnown ? exactPull : null;
  const live = tasks?.filter((t) => t.status !== 'done' && t.status !== 'cancelled') ?? [];
  const testRun = runs?.find((r) => ['cargo test', 'pnpm run test', 'npm run test'].includes(r.source));
  const S: [Stage, string, string, StState][] = [
    ['tarea', 'Tarea', work ? work.objective : tasks ? `${live.length} abiertas` : '—', work ? (work.state === 'finished' ? 'done' : 'now') : live.length ? 'now' : 'todo'],
    ['agentes', 'Agentes', `${agentSessions.length} ${agentSessions.length === 1 ? 'sesión' : 'sesiones'}`, agentSessions.length ? 'done' : 'todo'],
    ['rama', 'Rama', chosen?.branch ?? status?.branch ?? '—', status?.branch ? 'done' : 'todo'],
    ['cambios', 'Cambios', `${changes.length} ${changes.length === 1 ? 'archivo' : 'archivos'}`, status ? (changes.length ? 'now' : 'done') : 'todo'],
    ['tests', 'Tests', testRun ? OUTCOME[testRun.outcome] ?? testRun.outcome : 'sin ejecutar', testRun ? (testRun.outcome === 'passed' ? 'done' : testRun.outcome === 'failed' || testRun.outcome === 'findings' ? 'fail' : 'now') : 'todo'],
    ['commit', 'Commit', status ? (status.ahead ? `${status.ahead} por publicar` : changes.length ? 'Larry' : 'al día') : '—', status ? (status.ahead ? 'now' : changes.length ? 'todo' : 'done') : 'todo'],
    ['pr', 'Pull request', pull ? `PR #${pull.number}${pull.isDraft ? ' · borrador' : ''}` : 'sin PR', pull?.state === 'MERGED' || (exactPull?.state === 'OPEN' && !exactPull.isDraft) ? 'done' : pull ? 'now' : 'todo'],
    ['ci', 'CI', ci ? `${ci.checks[0]}/${checkTotal(ci)}` : 'GitHub', ci ? (ci.checksState === 'success' ? 'done' : ci.checksState === 'failure' ? 'fail' : 'now') : 'todo'],
    ['integracion', 'Integración', pull?.base ?? chosen?.base ?? '—', pull?.state === 'MERGED' || chosen?.integrated ? 'done' : 'todo'],
  ];
  const nowStage = (S.find((s) => s[3] === 'fail' || s[3] === 'now') ?? S[3])[0];
  const active = stage ?? (diff ? 'cambios' : status?.changes.length === 0 ? 'rama' : nowStage);
  const selectStage = (s: Stage) => {
    setFinding(undefined);
    setStage(s);
    if (s !== 'cambios' && s !== 'ci') setDiff(null);
    else if (!diff && changes[0]) setDiff({ ...changes[0], session: sid ?? undefined });
  };

  const openChange = (change: Change, keepCi = false) => {
    setFinding(undefined);
    setDiff({ ...change, session: sid ?? undefined });
    setStage(keepCi && stage === 'ci' ? 'ci' : 'cambios');
  };
  const selectAuditFile = (path: string) => {
    const change = changes.find((entry) => entry.path === path);
    if (change) openChange(change, true);
    else onFile(path, sid, chosen?.worktree ?? null);
  };
  const errors = open.filter((f) => f.severity === 'error').length;
  const warnings = open.filter((f) => f.severity === 'warning').length;

  const openFinding = (item: ReviewNote) => {
    if (!item.path) return;
    const change = changes.find((entry) => entry.path === item.path);
    if (!change || item.line == null) {
      onFile(item.path, sid, chosen?.worktree ?? null);
      return;
    }
    openChange(change, true);
    setFinding({ fingerprint: item.fingerprint });
  };

  return (
    <Root label="Entrega">
      <div className={`rev${left ? ' left-open' : ''}${right ? ' insp-open' : ''}`}>
        <div className="pipe">
          <div className="row">
            <h2 className="vt grow">Entrega · {chosen?.branch ?? status?.branch ?? projectName}{(pull?.base ?? chosen?.base) ? ` → ${pull?.base ?? chosen?.base}` : ''}</h2>
            {status?.head && <span className="chip mono">SHA {status.head.slice(0, 7)}</span>}
            <span className={`chip${exactPull ? ' mint' : ''}`}>{pull ? `PR #${pull.number} ${pull.isDraft ? 'en borrador' : pull.state === 'OPEN' ? 'publicada' : pull.state === 'MERGED' ? 'integrada' : 'cerrada'}` : status?.upstream ? `upstream ${status.upstream}` : 'sin publicar'}</span>
            {isolated.length > 0 && <label className="fsel"><select value={scopeId ?? ''} onChange={(e) => selectScope(e.currentTarget.value ? Number(e.currentTarget.value) : null)} aria-label="Alcance"><option value="">Checkout del proyecto</option>{isolated.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.branch ?? 'worktree'}</option>)}</select><Icon name="down" size={11} /></label>}
            <button className="tbtn" onClick={() => void load()} aria-label="Actualizar"><Icon name="refresh" size={15} /></button>
            <button className="tbtn narrow-only" onClick={() => setLeft(!left)} aria-label="Archivos"><Icon name="sidebar" size={16} /></button>
            <button className="tbtn narrow-only" onClick={() => setRight(!right)} aria-label="Auditoría"><Icon name="panel" size={16} /></button>
          </div>
          <Pipeline stages={S} active={active} onPick={selectStage} />
        </div>
        {error && <div className="rev-err" role="alert"><Icon name="warn" size={14} /> {error}</div>}
        <div className="revb">
          <aside className="ftree rev-git" aria-label="Archivos y commits">
            <div className="fsec"><Icon name="file" size={13} /> {chosen ? `Sin integrar · ${chosen.name}` : 'Sin commit · local'}</div>
            {changes.length ? changes.map((change) => (
              <button key={change.path} className={`frow${diff?.path === change.path ? ' on' : ''}`}
                title={change.orig ? `${change.orig} → ${change.path}` : change.path}
                onClick={() => openChange(change)}>
                <span className={`sev ${change.status === '!' || change.status === 'D' ? 'h' : change.status === 'M' ? 'm' : ''}`}
                  aria-label={change.status} />
                <span className="p">{change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/') + 1) : ''}<b>{change.path.split('/').pop()}</b></span>
                <span className="n">{change.adds != null && <span className="add">+{change.adds}</span>} {change.dels ? <span className="del">−{change.dels}</span> : null}</span>
              </button>
            )) : <div className="fnote">{status ? 'Sin cambios' : 'Cargando cambios…'}</div>}
            <div className="fsec"><Icon name="commit" size={13} /> Commits locales</div>
            <button className="frow2 rev-link" onClick={() => selectStage('rama')}><span className="p">Historial y operaciones de rama</span><Icon name="chev" size={12} /></button>
            <button className="frow2 rev-link" onClick={() => selectStage('commit')}><span className="p">Propuesta de Larry</span><Icon name="chev" size={12} /></button>
            <div className="fsec"><Icon name="branch" size={13} /> {chosen ? 'Rama' : 'Remoto'}</div>
            <div className="fnote">{chosen ? `${chosen.branch ?? '—'} · base ${chosen.base ?? '—'}` : status?.upstream ?? 'Sin rama de seguimiento'}</div>
            {isolated.length > 0 && <>
              <div className="fsec"><Icon name="pr" size={13} /> Worktrees de sesiones</div>
              {isolated.map((s) => <button key={s.id} className={`frow2${sid === s.id ? ' on' : ''}`} onClick={() => selectScope(sid === s.id ? null : s.id)}><span className="p">{s.name} · {s.branch ?? 'worktree'}</span><span className="n mono">{s.integrated ? 'integrada' : ''}</span></button>)}
            </>}
          </aside>
          <section className="diffv" aria-label="Contenido">
            <Center stage={active} project={project} diff={diff} chosen={chosen} sid={sid} status={status} log={log} work={work} tasks={tasks} agentSessions={agentSessions} findings={diffFindings} finding={finding} reviewers={reviewers}
              onDiff={(c) => { setDiff(c); setStage('cambios'); }} onFile={onFile} onConflicts={onConflicts} onChanged={() => { onBranchesChanged(); void load(); }} onStage={selectStage} />
          </section>
          <aside className="audit" aria-label="Auditoría">
            <div className="sec">
              <div className="row"><h3 className="grow">Auditoría</h3>
                {errors > 0 && <span className="chip coral">{errors} {errors === 1 ? 'alto' : 'altos'}</span>}
                {warnings > 0 && <span className="chip amber">{warnings} {warnings === 1 ? 'medio' : 'medios'}</span>}
              </div>
              <p className="mut audit-intro">{lastRun ? 'Sin puntuaciones: cada hallazgo enlaza a su línea y a su evidencia.' : 'Ejecuta una comprobación desde Tests para ver los hallazgos.'}</p>
              {(changes.length > 0 || open.some((item) => item.path)) && <Treemap findings={open} changes={changes} selected={diff?.path} onFile={selectAuditFile} />}
              {open.slice(0, 12).map((f) => (
                <button key={f.fingerprint} className={`fitem${finding?.fingerprint === f.fingerprint ? ' on' : ''}`} onClick={() => openFinding(f)}>
                  <span className={`sev ${f.severity === 'error' ? 'h' : f.severity === 'warning' ? 'm' : 'l'}`} />
                  <span><span className="ft" title={f.title ? f.rule : undefined}>{f.title ?? f.rule}</span><span className="mono mut fmeta" title={f.path ?? undefined}>{f.path?.split('/').pop() ?? '—'}{f.line ? `:${f.line}` : ''} · {f.who?.join(' + ')}</span></span>
                </button>
              ))}
              {lastRun && !open.length && <div className="fnote" style={{ padding: 0 }}><Icon name="check" size={13} /> Sin hallazgos abiertos</div>}
            </div>
            <div className="sec"><span className="lab">Evidencias verificables</span>
              {(runs ?? []).slice(0, 8).map((r) => (
                <div key={r.id} className="check">{r.outcome === 'passed' ? <span className="add"><Icon name="check" size={13} /></span> : r.outcome === 'failed' ? <span className="del"><Icon name="close" size={13} /></span> : <StDot st="idle" />}<span>{r.tool}</span><span className="mono mut2">{OUTCOME[r.outcome] ?? r.outcome} · {ago(r.observed)}</span></div>
              ))}
              {(ci || active === 'ci') && <section aria-label={active === 'ci' ? 'Estado de CI' : undefined}>
                <div className="check">{ci?.checksState === 'success' ? <span className="add"><Icon name="check" size={13} /></span> : ci?.checksState === 'failure' ? <span className="del"><Icon name="close" size={13} /></span> : <StDot st={ci ? 'working' : 'idle'} />}
                  <span>CI GitHub</span><span className="mono mut2">{ci ? `${ci.checks[0]}/${checkTotal(ci)}` : 'pendiente'}</span></div>
                {active === 'ci' && (pull ? <dl className="kv ci-inspector">
                  <dt>Pull request</dt><dd>#{pull.number} · {pull.branch} → {pull.base}</dd>
                  <dt>SHA observado</dt><dd className="mono">{pull.head.slice(0, 7)}</dd>
                  <dt>Resultados</dt><dd>{ci ? `${ci.checks[0]} correctos · ${ci.checks[1]} fallidos · ${ci.checks[2]} pendientes` : 'Pendiente de observación para este SHA'}</dd>
                  <dt>Observado</dt><dd>{ago(pull.observedAt)}</dd>
                </dl> : <p className="mut2">Pendiente de una observación de GitHub para esta rama.</p>)}
              </section>}
              {!runs?.length && !ci && active !== 'ci' && <p className="mut2" style={{ margin: '6px 0 0' }}>Nada verificado todavía.</p>}
            </div>
          </aside>
        </div>
      </div>
    </Root>
  );
}

function Pipeline({ stages, active, onPick }: { stages: [Stage, string, string, StState][]; active: Stage; onPick: (s: Stage) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(1000);
  useEffect(() => { const ro = new ResizeObserver(([e]) => setW(e.contentRect.width)); if (ref.current) ro.observe(ref.current); return () => ro.disconnect(); }, []);
  const n = stages.length, step = (w - 60) / (n - 1);
  const col: Record<StState, string> = { done: '#6fe0b3', now: '#9db6ff', fail: '#ff6b5d', todo: 'rgba(220,226,236,.35)' };
  // El tramo verde llega a la última etapa en curso antes de la primera pendiente.
  const firstTodo = stages.findIndex((s) => s[3] === 'todo');
  const reached = (firstTodo < 0 ? stages : stages.slice(0, firstTodo)).map((s) => s[3]).lastIndexOf('now');
  const nowI = reached >= 0 ? reached : Math.max(0, stages.findIndex((s) => s[3] === 'now' || s[3] === 'fail'));
  return (
    <svg id="pipesvg" ref={ref} role="group" aria-label="Recorrido de la entrega">
      <line x1="30" x2={w - 30} y1="30" y2="30" stroke="rgba(255,255,255,.08)" strokeWidth="2" strokeDasharray="1 5" strokeLinecap="round" />
      <line x1="30" x2={30 + nowI * step} y1="30" y2="30" stroke="rgba(111,224,179,.5)" strokeWidth="2" />
      {stages.map(([id, label, sub, st], i) => {
        const x = 30 + i * step, c = col[st], on = active === id;
        return (
          <g key={id} className={`st${on ? ' on' : ''}`} transform={`translate(${x},30)`} tabIndex={0} role="button" aria-label={`${label}: ${sub}`} onClick={() => onPick(id)} onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            onPick(id);
          }}>
            <rect x="-46" y="-16" width="92" height="66" rx="8" className="sthit" />
            {st === 'now' && <circle r="10" fill="none" stroke={c} strokeOpacity=".4" className="svgbreath" />}
            <circle r={on ? 6 : 4.5} fill={st === 'todo' ? '#0d0f12' : c} stroke={c} strokeWidth="1.5" />
            {on && <circle r="11" fill="none" stroke="#fff" strokeOpacity=".55" />}
            <text y="30" textAnchor="middle">{label}</text>
            <text className="s" y="45" textAnchor="middle">{w < 760 && i % 2 ? '' : sub.length > 18 ? `${sub.slice(0, 17)}…` : sub}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Treemap({ findings, changes, selected, onFile }: {
  findings: HealthRun['findings']; changes: Change[]; selected?: string; onFile: (path: string) => void;
}) {
  const files = new Map(changes.map((change) => [change.path, {
    findings: [] as HealthRun['findings'], lines: (change.adds ?? 0) + (change.dels ?? 0),
  }]));
  for (const finding of findings) {
    if (!finding.path) continue;
    const file = files.get(finding.path) ?? { findings: [], lines: 0 };
    file.findings.push(finding);
    files.set(finding.path, file);
  }
  const entries = [...files].sort(([, a], [, b]) => b.findings.length - a.findings.length || b.lines - a.lines).slice(0, 4);
  return (
    <div className="tree audit-map" role="group" aria-label="Mapa de archivos" data-count={entries.length}>
      {entries.map(([path, data]) => <button key={path} className="tmap" title={path}
        aria-label={`Revisar ${path}`} aria-pressed={selected === path} onClick={() => onFile(path)}>
        {path.split('/').pop()}
        <span className="map-findings" aria-hidden="true">
          {data.findings.slice(0, 6).map((finding) => <i key={finding.fingerprint}
            className={`sev ${finding.severity === 'error' ? 'h' : finding.severity === 'warning' ? 'm' : 'l'}`} />)}
        </span>
      </button>)}
    </div>
  );
}

function Center({ stage, project, diff, chosen, sid, status, log, work, tasks, agentSessions, findings, finding, reviewers = [], onDiff, onFile, onConflicts, onChanged, onStage }: {
  stage: Stage; project: string; diff: DiffTarget | null; chosen: Session | null; sid: number | null; status: GitStatus | null; log: LogRow[] | null; work: Work | null; tasks: Task[] | null; agentSessions: Session[];
  findings?: ReviewNote[];
  finding?: { fingerprint: string };
  reviewers?: string[];
  onDiff: (c: DiffTarget) => void; onFile: (path: string, session: number | null, root: string | null) => void; onConflicts: (f: string[]) => void; onChanged: () => void; onStage: (s: Stage) => void;
}) {
  const head = (icon: string, title: string, extra?: React.ReactNode, full?: string) => <div className="tabs"><span className="tab on" title={full}><Icon name={icon} size={13} />{title}</span><span className="grow" />{extra}</div>;
  const base = (path: string) => path.split('/').pop() ?? path;
  if ((stage === 'cambios' || stage === 'ci') && diff) return (
    <>
      {head('file', diff.orig ? `${diff.orig} → ${diff.path}` : base(diff.path), <>
        {reviewers.length > 0 && <span className="chip"><Icon name="agent" size={11} /> revisado por {reviewers.length > 1 ? `${reviewers.slice(0, -1).join(', ')} y ${reviewers.at(-1)}` : reviewers[0]}</span>}
        <button className="btn sm ghost" onClick={() => onFile(diff.path, diff.session ?? null, chosen?.worktree ?? null)}><Icon name="code" size={12} /> Abrir en el editor</button></>, diff.path)}
      <div className="rev-diff"><ReviewDiff project={project} change={diff} findings={findings} finding={finding} /></div>
    </>
  );
  if (stage === 'commit') return <>{head('commit', 'Commits por unidad funcional · Larry')}<div className="rev-tool legacy"><Larry key={`${project}:${sid}`} project={project} session={chosen} onDiff={onDiff} onDone={onChanged} /></div></>;
  if (stage === 'pr') return <>{head('pr', 'Pull request')}<div className="rev-tool legacy"><Publish key={`${project}:${sid}`} project={project} session={sid} hidden={false} /></div></>;
  if (stage === 'tests' || stage === 'ci') return <>{head('shield', stage === 'ci' ? 'CI y revisión' : 'Tests y revisión de código')}<div className="rev-tool legacy"><CodeHealth key={`${project}:${sid}`} project={project} session={chosen} closed={false} onFile={onFile} /></div></>;
  if (stage === 'integracion' && chosen) return <>{head('merge', `Integrar ${chosen.name}`)}<div className="rev-tool legacy"><Pending key={chosen.id} session={chosen} closed={false} onDiff={onDiff} onChanged={onChanged} onConflicts={onConflicts} /></div></>;
  if (stage === 'tarea' || stage === 'integracion') return <>{head('flow', 'Sesión de trabajo')}<div className="rev-tool"><div className="legacy"><WorkSession key={project} project={project} hidden={false} onReview={(ready) => { if (ready) onStage('pr'); }} /></div>
    {stage === 'integracion' && <ClosedBranches project={project} onDiff={onDiff} onChanged={onChanged} onConflicts={onConflicts} />}
    {tasks && tasks.length > 0 && <div className="rev-tasks"><span className="lab">Tareas abiertas</span>{tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').slice(0, 12).map((t) => <div key={t.id} className="frow2"><span className="p">#{t.id} {t.title}</span><span className="n">{t.status}</span></div>)}</div>}</div></>;
  if (stage === 'agentes') return <>{head('agent', 'Sesiones del proyecto')}<div className="rev-tool rev-list">
    {agentSessions.length ? agentSessions.map((s) => <div key={s.id} className="frow2"><span className="p"><b>{s.name}</b> · {s.engine}{s.branch ? ` · ${s.branch}` : ''}</span><span className="n">{s.worktree ? (s.integrated ? 'integrada' : 'worktree propio') : 'checkout compartido'}</span></div>)
      : <div className="empty sm">No hay sesiones abiertas.</div>}</div></>;
  // rama, o sin cambios: historial y estado como protagonistas
  return (
    <>
      {head('branch', `Historial · ${chosen?.branch ?? status?.branch ?? ''}`, status && <span className="mut2" style={{ fontSize: 12 }}>{status.upstream ? `${status.ahead} por publicar · ${status.behind} por traer` : 'sin upstream'}</span>)}
      <div className="rev-history scr">
        {sid == null && <section className="legacy rev-git-controls" aria-label="Operaciones de rama">
          <GitPanel key={project} project={project} selected={null} onDiff={onDiff} chooseBranch={false}
            onBranchPickerOpened={noop} pending={0} onPending={noop} onPublish={() => onStage('pr')}
            onChanged={onChanged} operationsOnly />
        </section>}
        {status && status.changes.length === 0 && (
          <div className="rev-next">
            <b>Árbol limpio.</b> <span className="mut2">{status.ahead ? `Hay ${status.ahead} commits locales por publicar.` : work ? `Sesión de trabajo: ${work.objective}.` : 'No hay nada pendiente de confirmar.'}</span>
            <div className="row" style={{ marginTop: 8 }}>
              {status.ahead > 0 && <button className="btn sm" onClick={() => onStage('pr')}><Icon name="pr" size={12} /> Preparar la PR</button>}
              <button className="btn sm" onClick={() => onStage('tests')}><Icon name="shield" size={12} /> Ejecutar comprobaciones</button>
            </div>
          </div>
        )}
        {sid != null ? <div className="empty sm">El historial se muestra en el checkout del proyecto.</div> : log === null ? <div className="tr-skel" style={{ height: 120 }} /> : log.length === 0 ? <div className="empty sm">Sin commits.</div> : (
          <ol className="rev-log">
            {log.slice(0, 80).map((r) => (
              <li key={r.hash}>
                <span className="dot2" />
                <span className="subj">{r.subject}{r.refs && r.refs.split(', ').filter(Boolean).slice(0, 3).map((ref) => <span key={ref} className={`chip tiny${ref.includes('HEAD') ? ' sky' : ref.startsWith('origin') ? '' : ' mint'}`}>{ref.replace('HEAD -> ', '')}</span>)}</span>
                <span className="mut2">{r.author}</span>
                <span className="mono mut2">{r.hash.slice(0, 7)}</span>
                <span className="mono mut2">{ago(new Date(r.date).getTime())}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

/** Ramas de sesiones ya cerradas que siguen sin integrar (antes en Trabajo › Ramas). */
function ClosedBranches({ project, onDiff, onChanged, onConflicts }: {
  project: string; onDiff: (c: DiffTarget) => void; onChanged: () => void; onConflicts: (f: string[]) => void;
}) {
  const [list, setList] = useState<Session[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => sessionApi.orphans(project).then((l) => { setList(l); setError(null); }, (e) => setError(String(e))), [project]);
  useEffect(() => { void load(); }, [load]);
  const chosen = list?.find((s) => s.id === open) ?? null;
  return (
    <div className="rev-tasks rev-orphans">
      <span className="lab">Ramas de sesiones cerradas</span>
      {error && <div className="flow-err" role="alert">{error}</div>}
      {list == null && !error && <span className="mut2">Consultando ramas…</span>}
      {list?.length === 0 && <span className="mut2">No hay ramas de sesiones cerradas pendientes de integrar.</span>}
      {list?.map((s) => <button key={s.id} className={`frow2 rowbtn${open === s.id ? ' on' : ''}`} onClick={() => setOpen(open === s.id ? null : s.id)}>
        <span className="p mono">{s.branch} → {s.base}</span><span className="n">{s.name}</span>
      </button>)}
      {chosen && <div className="legacy"><Pending key={chosen.id} session={chosen} closed onDiff={onDiff} onConflicts={onConflicts}
        onChanged={() => { onChanged(); void load(); setOpen(null); }} /></div>}
    </div>
  );
}
