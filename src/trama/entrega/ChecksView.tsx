import { useState } from 'react';
import {
  deliveryAuto,
  githubPr,
  health,
  pr as prApi,
  type AutomationStatus,
  type CheckLog,
  type CheckRunItem,
  type HealthCheck,
  type HealthRun,
  type PullDetail,
} from '../../ipc';
import type { ReviewNote } from '../findings';
import { Icon } from '../icons';
import { AuditsView } from './AuditsView';

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
  mode: 'tests' | 'ci';
  project: string;
  headSha: string | null;
  dirtyTree: boolean;
  isActiveBranch: boolean;
  prDetail: PullDetail | null;
  healthRuns: HealthRun[];
  automation: AutomationStatus | null;
  onRefresh: () => void;
  onOpenFinding: (note: ReviewNote) => void;
};

export function ChecksView({
  mode,
  project,
  headSha,
  dirtyTree,
  isActiveBranch,
  prDetail,
  healthRuns,
  automation,
  onRefresh,
  onOpenFinding,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeLog, setActiveLog] = useState<{ title: string; log: CheckLog } | null>(null);

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
      setActiveLog({ title: item.name, log });
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

  const requestPmAutofix = async () => {
    if (!prDetail) return;
    setBusy('pm-autofix');
    setError(null);
    setNotice(null);
    try {
      const failed = prDetail.checks
        .filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(c.conclusion ?? ''))
        .map((c) => c.name);
      const msg = await deliveryAuto.requestAutofix(
        project,
        prDetail.number,
        prDetail.headOid,
        failed,
        prDetail.reviewDecision,
      );
      setNotice(msg);
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancelAttempt = async (id: number) => {
    setBusy(`cancel:${id}`);
    setError(null);
    try {
      await deliveryAuto.cancelAutofix(project, id);
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

  const prAttempts = (automation?.attempts ?? []).filter(
    (a) => !prDetail || a.prNumber === prDetail.number,
  );

  if (mode === 'tests') {
    return (
      <div className="ent-op-scroll">
        {error && (
          <div className="tr-error" role="alert">
            <Icon name="warn" size={13} />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="ent-notice">
            <Icon name="check" size={13} />
            <span>{notice}</span>
          </div>
        )}

        <section className="ent-sec">
          <div className="ent-sec-bar">
            <Icon name="health" size={12} />
            <strong>Tests y verificaciones locales</strong>
            {!isActiveBranch && (
              <span className="ent-inline-tag tone-amber">Solo en rama activa</span>
            )}
          </div>

          <div className="ent-row-wrap">
            {LOCAL_CHECKS.map((ch) => (
              <button
                key={ch.id}
                type="button"
                className="btn sm"
                disabled={!isActiveBranch || busy !== null}
                onClick={() => runLocal(ch.id)}
              >
                {busy === `local:${ch.id}` ? 'Ejecutando…' : ch.label}
              </button>
            ))}
          </div>

          <div className="ent-list">
            {healthRuns.slice(0, 10).map((run) => {
              const stale = Boolean(headSha && run.revision && run.revision !== headSha) || (isActiveBranch && dirtyTree);
              const tone = run.outcome === 'ok' || run.outcome === 'passed' ? 'mint' : run.outcome === 'failed' ? 'coral' : 'amber';
              return (
                <div key={run.id} className="ent-list-row">
                  <span className={`ent-dot-sm tone-${tone}`} />
                  <div className="ent-list-main">
                    <span className="ent-list-title">
                      <strong>{run.tool}</strong> <span className="mut">· {run.source}</span>
                      {run.revision && <span className="mut mono"> · {run.revision.slice(0, 7)}</span>}
                    </span>
                  </div>
                  <span className={`ent-inline-tag tone-${stale ? 'amber' : 'mint'}`}>
                    {stale ? 'Obsoleta' : 'Vigente'}
                  </span>
                  <span className="ent-mono-meta mono">{run.findings.length} hallazgos</span>
                </div>
              );
            })}
            {healthRuns.length === 0 && (
              <p className="ent-empty-inline">Sin ejecuciones locales registradas en este proyecto.</p>
            )}
          </div>
        </section>

        <AuditsView
          project={project}
          headSha={headSha}
          dirtyTree={dirtyTree}
          runs={healthRuns}
          onOpenFinding={onOpenFinding}
          onRefresh={onRefresh}
        />
      </div>
    );
  }

  return (
    <div className="ent-op-scroll">
      {error && (
        <div className="tr-error" role="alert">
          <Icon name="warn" size={13} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="ent-notice">
          <Icon name="check" size={13} />
          <span>{notice}</span>
        </div>
      )}

      <section className="ent-sec">
        <div className="ent-sec-bar">
          <Icon name="signal" size={12} />
          <strong>Comprobaciones CI {prDetail ? `· PR #${prDetail.number}` : ''}</strong>
          <span className="grow" />
          {prDetail && prDetail.state === 'OPEN' && (prDetail.checksFailed > 0 || prDetail.reviewDecision === 'CHANGES_REQUESTED') && (
            <button
              type="button"
              className="btn sm warn"
              disabled={busy !== null}
              onClick={requestPmAutofix}
              title="Enviar fallo sanitizado al Project Manager para delegar diagnóstico y corrección en agentes"
            >
              <Icon name="pm" size={11} /> {busy === 'pm-autofix' ? 'Delegando…' : 'Corregir con PM'}
            </button>
          )}
          {failedRunIds.map((rid) => (
            <button
              key={rid}
              type="button"
              className="btn sm"
              disabled={busy !== null}
              onClick={() => rerunFailed(rid)}
            >
              <Icon name="refresh" size={11} /> Relanzar #{rid}
            </button>
          ))}
        </div>

        {!prDetail ? (
          <p className="ent-empty-inline">La rama inspeccionada no tiene Pull Request con comprobaciones CI asociadas.</p>
        ) : prDetail.checks.length === 0 ? (
          <p className="ent-empty-inline">GitHub no reporta check runs para el commit actual ({prDetail.headOid.slice(0, 7)}).</p>
        ) : (
          <div className="ent-list">
            {prDetail.checks.map((c, idx) => {
              const verdict = c.conclusion ?? c.status;
              const tone = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict)
                ? 'mint'
                : ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(verdict)
                  ? 'coral'
                  : 'amber';
              const isSelectedLog = activeLog?.title === c.name;
              return (
                <div key={`${c.name}:${idx}`} className={`ent-list-row${isSelectedLog ? ' on' : ''}`}>
                  <span className={`ent-dot-sm tone-${tone}`} />
                  <div className="ent-list-main">
                    <span className="ent-list-title">
                      <strong>{c.name}</strong>
                      {c.workflow && <span className="mut"> · {c.workflow}</span>}
                    </span>
                  </div>
                  <span className={`ent-inline-tag tone-${tone}`}>{verdict}</span>
                  {(c.jobId || c.runId) && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={busy !== null}
                      onClick={() => openJobLog(c)}
                    >
                      {busy === `log:${c.name}` ? 'Leyendo…' : 'Log'}
                    </button>
                  )}
                  {c.url && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => prApi.open(c.url!)}
                      title="Abrir en GitHub"
                      aria-label={`Abrir ${c.name} en GitHub`}
                    >
                      <Icon name="link" size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Visor de log CI inline en la columna derecha (sin ocultar ramas, cambios ni historial) */}
      {activeLog && (
        <section className="ent-sec">
          <div className="ent-sec-bar">
            <Icon name="terminal" size={12} />
            <strong>Log · {activeLog.title}</strong>
            <span className="grow" />
            {activeLog.log.truncated && <span className="ent-mono-meta">últimos 120 KB</span>}
            <button
              type="button"
              className="tbtn"
              onClick={() => setActiveLog(null)}
              aria-label="Cerrar log CI"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          {activeLog.log.untrusted && (
            <div className="ent-warn-banner">
              <Icon name="shield" size={12} />
              <span>Salida externa de GitHub (tokens redactados).</span>
            </div>
          )}
          <pre className="ent-log-pre mono">{activeLog.log.content || 'Sin salida de log.'}</pre>
        </section>
      )}

      {/* Intentos de corrección automática ligados a la PR */}
      {prAttempts.length > 0 && (
        <section className="ent-sec">
          <div className="ent-sec-bar">
            <Icon name="spark" size={12} />
            <strong>Correcciones automáticas</strong>
            <span className="ent-mono-meta mono">
              {prAttempts.length} · límite {automation?.policy.maxRetries ?? 3}
            </span>
          </div>
          <div className="ent-list">
            {prAttempts.slice(0, 6).map((a) => {
              const active = ['queued', 'running', 'awaiting_ci'].includes(a.status);
              const tone = a.status === 'succeeded' ? 'mint' : a.status === 'failed' ? 'coral' : active ? 'sky' : 'mut';
              return (
                <div key={a.id} className="ent-list-row">
                  <span className={`ent-dot-sm tone-${tone}`} />
                  <div className="ent-list-main">
                    <span className="ent-list-title mono">
                      PR #{a.prNumber} · intento {a.attemptNo} · {a.headSha.slice(0, 7)}
                    </span>
                    <span className="ent-list-sub">{a.summary ?? a.failureSignature}</span>
                  </div>
                  <span className={`ent-inline-tag tone-${tone}`}>{a.status}</span>
                  {active && (
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={busy === `cancel:${a.id}`}
                      onClick={() => cancelAttempt(a.id)}
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
