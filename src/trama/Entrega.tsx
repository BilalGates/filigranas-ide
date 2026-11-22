import { useCallback, useEffect, useState } from 'react';
import CodeHealth from '../CodeHealth';
import Diff from '../Diff';
import GitPanel from '../GitPanel';
import Larry from '../Larry';
import Pending from '../Pending';
import Publish, { CHECK_STATE } from '../Publish';
import WorkSession from '../WorkSession';
import { git, health, sessions as sessionApi, workSessions, type DiffTarget, type GitStatus, type HealthRun, type PrInfo, type Session, type WorkSession as Work } from '../ipc';
import { Icon } from './icons';
import { Empty, ErrorNote, Tabs } from './ui';

// Entrega: una sola superficie para Git, Larry, revisión de código, PR y CI.
// Reutiliza los componentes y comandos existentes (incluidos los formularios
// de aprobación de push, PR y merge); aquí solo se ordenan en un recorrido y
// se resume el estado real de cada paso.
const noop = () => {};
type Tab = 'cambios' | 'commits' | 'revision' | 'publicar' | 'ramas';
type Scope = { kind: 'checkout' } | { kind: 'session'; session: Session };

export default function Entrega({ project, projectName, agentSessions, onFile, onConflicts, onBranchesChanged }: {
  project: string | null;
  projectName: string | null;
  agentSessions: Session[];
  onFile: (path: string, session: number | null, root: string | null) => void;
  onConflicts: (files: string[]) => void;
  onBranchesChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>('cambios');
  const [scopeId, setScopeId] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [runs, setRuns] = useState<HealthRun[] | null>(null);
  const [pulls, setPulls] = useState<PrInfo[] | null>(null);
  const [work, setWork] = useState<Work | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isolated = agentSessions.filter((s) => s.worktree);
  const chosen = isolated.find((s) => s.id === scopeId) ?? null;
  const scope: Scope = chosen ? { kind: 'session', session: chosen } : { kind: 'checkout' };
  const sid = chosen?.id ?? null;

  const load = useCallback(async () => {
    if (!project) return;
    const [st, h, ci, w] = await Promise.allSettled([
      sid == null ? git.status(project) : sessionApi.changes(sid),
      health.list(project, sid),
      health.ci(project, sid),
      workSessions.current(project),
    ]);
    setStatus(st.status === 'fulfilled' ? st.value : null);
    setRuns(h.status === 'fulfilled' ? h.value : null);
    setPulls(ci.status === 'fulfilled' ? ci.value : null);
    setWork(w.status === 'fulfilled' ? w.value : null);
    const failed = [st, h, ci, w].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    setError(failed ? String(failed.reason) : null);
  }, [project, sid]);
  useEffect(() => {
    setDiff(null);
    void load();
    const t = window.setInterval(load, 15000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!project) return <section className="tr-dest" aria-label="Entrega"><Empty icon="review" title="Elige un proyecto">Entrega reúne cambios, commits, revisión, PR y CI del proyecto abierto.</Empty></section>;

  const changes = status?.changes.length ?? null;
  const lastRun = runs?.[0] ?? null;
  const findings = lastRun ? lastRun.findings.filter((f) => f.status === 'open').length : null;
  const pull = pulls?.find((p) => p.state === 'OPEN') ?? pulls?.[0] ?? null;
  const steps = [
    { id: 'cambios' as Tab, label: 'Cambios', value: changes == null ? '—' : `${changes} archivos`, tone: changes ? 'sky' : 'mint', done: changes === 0 },
    { id: 'commits' as Tab, label: 'Commits', value: status ? (status.upstream ? `${status.ahead} por publicar` : 'sin upstream') : '—', tone: status?.ahead ? 'sky' : '', done: !!status?.upstream && status.ahead === 0 },
    { id: 'revision' as Tab, label: 'Revisión', value: lastRun ? (findings ? `${findings} hallazgos abiertos` : 'sin hallazgos abiertos') : 'sin ejecutar', tone: findings ? 'amber' : lastRun ? 'mint' : '', done: !!lastRun && !findings },
    { id: 'publicar' as Tab, label: 'PR y CI', value: pull ? `#${pull.number} · ${pull.checksKnown ? `checks ${CHECK_STATE[pull.checksState]}` : pull.state.toLowerCase()}` : 'sin PR', tone: pull?.checksState === 'failure' ? 'coral' : pull?.checksState === 'success' ? 'mint' : pull ? 'sky' : '', done: pull?.state === 'MERGED' },
  ];

  return (
    <section className="tr-dest tr-entrega" aria-label="Entrega">
      <header className="tr-head">
        <div><h1>Entrega</h1><div className="sub">{projectName}{status?.branch ? ` · ${status.branch}` : ''}{work ? ` · sesión de trabajo: ${work.objective}` : ''}</div></div>
        <span className="grow" />
        <label className="tr-row" style={{ fontSize: 12, color: 'var(--tx3)' }}>Alcance
          <select className="tr-input" value={scopeId ?? ''} onChange={(e) => setScopeId(e.currentTarget.value ? Number(e.currentTarget.value) : null)} aria-label="Alcance">
            <option value="">Checkout del proyecto</option>
            {isolated.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.branch ?? 'worktree'}</option>)}
          </select>
        </label>
        <button className="tr-btn sm icon ghost" onClick={() => void load()} aria-label="Actualizar"><Icon name="regen" size={14} /></button>
      </header>
      <ol className="entrega-steps" aria-label="Recorrido de entrega">
        {steps.map((s, i) => (
          <li key={s.id}>
            <button className={`entrega-step${tab === s.id ? ' on' : ''}${s.done ? ' done' : ''}`} onClick={() => setTab(s.id)}>
              <span className="n">{s.done ? <Icon name="check" size={12} /> : i + 1}</span>
              <span className="l">{s.label}</span>
              <span className={`tr-chip ${s.tone}`}>{s.value}</span>
            </button>
          </li>
        ))}
      </ol>
      {error && <div style={{ padding: '0 18px 8px' }}><ErrorNote error={error} onRetry={() => void load()} /></div>}
      <Tabs label="Secciones de entrega" value={tab} onChange={setTab} items={[
        { id: 'cambios', label: 'Cambios', icon: 'changes', count: changes },
        { id: 'commits', label: 'Commits · Larry', icon: 'commit' },
        { id: 'revision', label: 'Revisión', icon: 'shield', count: findings },
        { id: 'publicar', label: 'PR y CI', icon: 'pr' },
        { id: 'ramas', label: scope.kind === 'session' ? 'Integrar rama' : 'Sesión de trabajo', icon: 'branch' },
      ]} />
      <div className={`entrega-body${diff ? ' with-diff' : ''}`}>
        <div className="entrega-main">
          {tab === 'cambios' && (scope.kind === 'checkout'
            ? <div className="entrega-git"><GitPanel key={project} project={project} selected={diff?.session == null ? diff : null} onDiff={setDiff} chooseBranch={false}
                onBranchPickerOpened={() => {}} pending={0} onPending={() => setTab('ramas')} onPublish={() => setTab('publicar')} /></div>
            : <Pending key={scope.session.id} session={scope.session} closed={false} onDiff={setDiff} onChanged={() => { onBranchesChanged(); void load(); }} onConflicts={onConflicts} />)}
          {tab === 'commits' && <Larry key={`${project}:${sid}`} project={project} session={chosen} onDiff={setDiff} onDone={() => { void load(); setTab('revision'); }} />}
          {tab === 'revision' && <CodeHealth key={`${project}:${sid}`} project={project} session={chosen} closed={false} onFile={onFile} />}
          {tab === 'publicar' && <Publish key={`${project}:${sid}`} project={project} session={sid} hidden={false} />}
          {tab === 'ramas' && (scope.kind === 'session'
            ? <Pending key={scope.session.id} session={scope.session} closed={false} onDiff={setDiff} onChanged={() => { onBranchesChanged(); void load(); }} onConflicts={onConflicts} />
            : <WorkSession key={project} project={project} hidden={false} onReview={noop} />)}
        </div>
        {diff && (
          <div className="entrega-diff">
            <div className="tr-row entrega-diff-h"><Icon name="diff" size={13} /><span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{diff.label ?? diff.path}</span><span className="grow" />
              <button className="tr-btn sm icon ghost" onClick={() => setDiff(null)} aria-label="Cerrar diff"><Icon name="close" size={13} /></button></div>
            <Diff project={project} change={diff} />
          </div>
        )}
      </div>
    </section>
  );
}
