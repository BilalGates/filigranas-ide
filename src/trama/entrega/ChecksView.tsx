import { useState } from 'react';
import {
  githubPr,
  health,
  pr as prApi,
  type CheckLog,
  type CheckRunItem,
  type HealthCheck,
  type HealthRun,
  type PullDetail,
} from '../../ipc';
import { Icon } from '../icons';

const LOCAL_CHECKS: { id: HealthCheck; label: string }[] = [
  { id: 'diff', label: 'Diff check' },
  { id: 'typecheck', label: 'Typecheck' },
  { id: 'lint', label: 'Lint' },
  { id: 'test', label: 'Tests' },
  { id: 'build', label: 'Build' },
  { id: 'cargo_check', label: 'Cargo check' },
  { id: 'cargo_test', label: 'Cargo test' },
];

type Props = {
  project: string;
  headSha: string | null;
  dirtyTree: boolean;
  isActiveBranch: boolean;
  prDetail: PullDetail | null;
  healthRuns: HealthRun[];
  onRefresh: () => void;
  onInspectLog: (title: string, log: CheckLog) => void;
};

export function ChecksView({
  project,
  headSha,
  dirtyTree,
  isActiveBranch,
  prDetail,
  healthRuns,
  onRefresh,
  onInspectLog,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const runLocal = async (check: HealthCheck) => {
    setBusy(`local:${check}`);
    setError(null);
    setNotice(null);
    try {
      await health.run(project, null, check);
      setNotice(`Comprobación local «${check}» completada.`);
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const openJobLog = async (item: CheckRunItem) => {
    if (!item.jobId && !item.runId) {
      if (item.url) void prApi.open(item.url);
      return;
    }
    setBusy(`log:${item.name}`);
    setError(null);
    try {
      const log = await githubPr.checkLog(project, item.jobId, item.runId);
      onInspectLog(item.name, log);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const rerunFailed = async (runId: number) => {
    setBusy(`rerun:${runId}`);
    setError(null);
    setNotice(null);
    try {
      await githubPr.rerunChecks(project, runId, true);
      setNotice(`Relanzados los jobs fallidos del workflow #${runId}.`);
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const failedRunIds = [...new Set(
    (prDetail?.checks ?? [])
      .filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion ?? '') && c.runId != null)
      .map((c) => c.runId!),
  )];

  return (
    <div className="ent-view">
      {error && <div className="tr-error" role="alert"><Icon name="warn" size={14} /><span>{error}</span></div>}
      {notice && <div className="ent-notice"><Icon name="check" size={14} /><span>{notice}</span></div>}

      <section className="ent-card">
        <div className="ent-card-head">
          <strong><Icon name="signal" size={13} /> Comprobaciones CI de GitHub {prDetail ? `· PR #${prDetail.number}` : ''}</strong>
          <div className="ent-row-wrap">
            {failedRunIds.map((rid) => (
              <button key={rid} className="btn sm warn" disabled={busy !== null} onClick={() => rerunFailed(rid)}>
                <Icon name="refresh" size={12} /> Relanzar fallos #{rid}
              </button>
            ))}
          </div>
        </div>

        {!prDetail ? (
          <p className="ent-empty-mini">La rama inspeccionada no tiene Pull Request con comprobaciones CI asociadas.</p>
        ) : prDetail.checks.length === 0 ? (
          <p className="ent-empty-mini">GitHub no reporta check runs para el commit actual ({prDetail.headOid.slice(0, 7)}).</p>
        ) : (
          <div className="ent-check-list">
            {prDetail.checks.map((c, idx) => {
              const verdict = c.conclusion ?? c.status;
              const tone = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict)
                ? 'mint'
                : ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(verdict)
                  ? 'coral'
                  : 'amber';
              return (
                <div key={`${c.name}:${idx}`} className="ent-check-item">
                  <span className={`chip tiny ${tone}`}>{verdict}</span>
                  <div className="ent-check-main">
                    <strong>{c.name}</strong>
                    {c.workflow && <span className="mut"> · {c.workflow}</span>}
                  </div>
                  <div className="ent-row-wrap">
                    {(c.jobId || c.runId) && (
                      <button className="btn sm" disabled={busy !== null} onClick={() => openJobLog(c)}>
                        {busy === `log:${c.name}` ? 'Leyendo…' : 'Ver log'}
                      </button>
                    )}
                    {c.url && (
                      <button className="btn sm ghost" onClick={() => prApi.open(c.url!)} title="Abrir en GitHub">
                        <Icon name="link" size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="ent-card">
        <div className="ent-card-head">
          <strong><Icon name="health" size={13} /> Pruebas y verificaciones locales</strong>
          {!isActiveBranch && <span className="chip amber tiny">Solo disponibles en la rama activa</span>}
        </div>

        <div className="ent-row-wrap">
          {LOCAL_CHECKS.map((ch) => (
            <button
              key={ch.id}
              className="btn sm"
              disabled={!isActiveBranch || busy !== null}
              onClick={() => runLocal(ch.id)}
            >
              {busy === `local:${ch.id}` ? 'Ejecutando…' : ch.label}
            </button>
          ))}
        </div>

        <div className="ent-check-list">
          {healthRuns.slice(0, 12).map((run) => {
            const stale = Boolean(headSha && run.revision && run.revision !== headSha) || (isActiveBranch && dirtyTree);
            const tone = run.outcome === 'ok' || run.outcome === 'passed' ? 'mint' : run.outcome === 'failed' ? 'coral' : 'amber';
            return (
              <div key={run.id} className="ent-check-item">
                <span className={`chip tiny ${tone}`}>{run.outcome}</span>
                <div className="ent-check-main">
                  <strong>{run.tool}</strong>
                  <span className="mut"> · {run.source}</span>
                  {run.revision && <span className="mut mono"> · {run.revision.slice(0, 7)}</span>}
                </div>
                <div className="ent-row-wrap">
                  {stale ? (
                    <span className="chip amber tiny" title="El código cambió desde esta ejecución">Obsoleta</span>
                  ) : (
                    <span className="chip mint tiny">Vigente</span>
                  )}
                  <span className="mut mono">{run.findings.length} hallazgos</span>
                </div>
              </div>
            );
          })}
          {healthRuns.length === 0 && <p className="ent-empty-mini">Sin ejecuciones locales registradas en este proyecto.</p>}
        </div>
      </section>
    </div>
  );
}
