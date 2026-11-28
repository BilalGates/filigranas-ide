import { useRef, useState } from 'react';
import { deliveryAuto, type AutomationPolicy, type AutomationStatus, type Session } from '../../ipc';
import { Icon } from '../icons';

type Props = {
  project: string;
  activeBranch: string | null;
  agentSessions: Session[];
  automation: AutomationStatus | null;
  onRefresh: () => void;
  onOpenSettings?: () => void;
};

const MODE_LABELS: Record<AutomationPolicy['mode'], string> = {
  manual: 'Manual',
  assisted: 'Asistido',
  auto: 'Automático',
};

const ATTEMPT_STATUS_LABEL: Record<string, string> = {
  queued: 'En cola',
  running: 'En ejecución',
  awaiting_ci: 'Esperando CI',
  succeeded: 'Corregido',
  failed: 'Fallido',
  cancelled: 'Cancelado',
  blocked: 'Bloqueado',
};

export function StageAgentsView({
  project,
  activeBranch,
  agentSessions,
  automation,
  onRefresh,
  onOpenSettings,
}: Props) {
  const prevActiveMode = useRef<'assisted' | 'auto'>('assisted');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (automation && automation.policy.mode !== 'manual') {
    prevActiveMode.current = automation.policy.mode;
  }

  const runningAttempts = (automation?.attempts ?? []).filter((a) =>
    ['queued', 'running', 'awaiting_ci'].includes(a.status),
  );
  const recentAttempts = automation?.attempts ?? [];

  const togglePause = async () => {
    if (!automation) return;
    setBusy('pause');
    setError(null);
    try {
      const nextMode: AutomationPolicy['mode'] =
        automation.policy.mode === 'manual' ? prevActiveMode.current : 'manual';
      await deliveryAuto.savePolicy(project, {
        ...automation.policy,
        mode: nextMode,
        requireExplicitMerge: true,
      });
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

  return (
    <div className="ent-op-scroll">
      {error && (
        <div className="tr-error" role="alert">
          <Icon name="warn" size={13} />
          <span>{error}</span>
        </div>
      )}

      {/* Estado de automatización en vivo (configuración detallada en Ajustes) */}
      <section className="ent-sec">
        <div className="ent-sec-bar">
          <Icon name="spark" size={12} />
          <strong>Automatización de Entrega</strong>
          {automation && (
            <span className={`ent-inline-tag tone-${automation.policy.mode === 'auto' ? 'sky' : automation.policy.mode === 'assisted' ? 'amber' : 'mut'}`}>
              {MODE_LABELS[automation.policy.mode]}
            </span>
          )}
          <span className="grow" />
          {automation && (
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy !== null}
              onClick={togglePause}
              title={automation.policy.mode === 'manual' ? 'Reanudar modo asistido/automático' : 'Pausar automatización (pasar a Manual)'}
            >
              <Icon name={automation.policy.mode === 'manual' ? 'play' : 'pause'} size={11} />
              {automation.policy.mode === 'manual' ? 'Reanudar' : 'Pausar'}
            </button>
          )}
          {onOpenSettings && (
            <button type="button" className="btn sm" onClick={onOpenSettings}>
              <Icon name="settings" size={11} /> Ajustes
            </button>
          )}
        </div>

        <p className="ent-sec-note">
          Project Manager coordina · Agentes ejecutan · Merge siempre manual. La política detallada se configura en Ajustes del proyecto.
        </p>

        {automation && !automation.pmDelegationReady && automation.pmBlockedReason && (
          <div className="ent-warn-banner">
            <Icon name="lock" size={13} />
            <span><strong>Bloqueo:</strong> {automation.pmBlockedReason}</span>
          </div>
        )}

        {runningAttempts.length > 0 ? (
          <div className="ent-list">
            {runningAttempts.map((a) => (
              <div key={a.id} className="ent-list-row is-live">
                <span className="ent-dot-sm tone-sky" />
                <div className="ent-list-main">
                  <span className="ent-list-title mono">
                    PR #{a.prNumber} · intento {a.attemptNo}/{automation?.policy.maxRetries ?? 3}
                  </span>
                  <span className="ent-list-sub">
                    {ATTEMPT_STATUS_LABEL[a.status] ?? a.status} · <span className="mono">{a.headSha.slice(0, 7)}</span>
                    {a.summary ? ` · ${a.summary}` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn sm danger"
                  disabled={busy === `cancel:${a.id}`}
                  onClick={() => cancelAttempt(a.id)}
                >
                  Cancelar
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="ent-kv-inline">
            <span>Operación en curso: <strong>ninguna</strong></span>
            {automation && (
              <span className="mono mut">
                Límite de reintentos: {automation.policy.maxRetries}
              </span>
            )}
          </div>
        )}

        {recentAttempts.length > 0 && (
          <div className="ent-subsec">
            <div className="ent-sub-lbl">Intentos de corrección ({recentAttempts.length})</div>
            <div className="ent-list">
              {recentAttempts.slice(0, 8).map((a) => {
                const active = ['queued', 'running', 'awaiting_ci'].includes(a.status);
                const tone =
                  a.status === 'succeeded'
                    ? 'mint'
                    : a.status === 'failed' || a.status === 'blocked'
                      ? 'coral'
                      : active
                        ? 'sky'
                        : 'mut';
                return (
                  <div key={a.id} className="ent-list-row">
                    <span className={`ent-dot-sm tone-${tone}`} />
                    <div className="ent-list-main">
                      <span className="ent-list-title mono">
                        PR #{a.prNumber} · intento {a.attemptNo} · {a.headSha.slice(0, 7)}
                      </span>
                      <span className="ent-list-sub">{a.summary ?? a.failureSignature}</span>
                    </div>
                    <span className={`ent-inline-tag tone-${tone}`}>
                      {ATTEMPT_STATUS_LABEL[a.status] ?? a.status}
                    </span>
                    {active && (
                      <button
                        type="button"
                        className="btn sm ghost"
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
          </div>
        )}
      </section>

      {/* Sesiones de agentes del proyecto */}
      <section className="ent-sec">
        <div className="ent-sec-bar">
          <Icon name="agent" size={12} />
          <strong>Agentes del proyecto</strong>
          <span className="ent-mono-meta mono">{agentSessions.length} sesiones</span>
        </div>

        {agentSessions.length === 0 ? (
          <p className="ent-empty-inline">Sin sesiones de agentes activas en este proyecto.</p>
        ) : (
          <div className="ent-list">
            {agentSessions.map((s) => {
              const isWorking = s.status === 'trabajando';
              const isWaiting = s.status === 'esperando';
              const tone = isWaiting ? 'amber' : isWorking ? 'sky' : 'mut';
              const distinctBranch = s.branch && activeBranch && s.branch !== activeBranch;
              return (
                <div key={s.id} className="ent-list-row">
                  <span className={`ent-dot-sm tone-${tone}`} />
                  <div className="ent-list-main">
                    <span className="ent-list-title">
                      <strong>{s.name}</strong> <span className="mut">· {s.engine}</span>
                    </span>
                    <span className="ent-list-sub mono">
                      {s.branch ?? 'rama del proyecto'}
                      {s.worktree ? ' · worktree aislado' : ' · checkout compartido'}
                      {distinctBranch ? ' · rama independiente' : ''}
                    </span>
                  </div>
                  <span className={`ent-inline-tag tone-${tone}`}>
                    {s.status ?? (s.integrated ? 'integrada' : 'reposo')}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
