import { useState } from 'react';
import { deliveryAuto, type AutomationPolicy, type AutomationStatus } from '../../ipc';
import { Icon } from '../icons';

type Props = {
  project: string;
  status: AutomationStatus | null;
  onRefresh: () => void;
};

export function AutomationView({ project, status, onRefresh }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!status) {
    return <div className="ent-view"><p className="ent-empty-mini">Cargando configuración de automatización…</p></div>;
  }

  const { policy } = status;

  const updatePolicy = async (patch: Partial<AutomationPolicy>) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await deliveryAuto.savePolicy(project, { ...policy, ...patch, requireExplicitMerge: true });
      setNotice('Política de automatización guardada para este proyecto.');
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const cancelAttempt = async (id: number) => {
    try {
      await deliveryAuto.cancelAutofix(project, id);
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="ent-view">
      {error && <div className="tr-error" role="alert"><Icon name="warn" size={14} /><span>{error}</span></div>}
      {notice && <div className="ent-notice"><Icon name="check" size={14} /><span>{notice}</span></div>}

      {!status.pmDelegationReady && status.pmBlockedReason && (
        <div className="ent-warn-banner">
          <Icon name="lock" size={14} />
          <div>
            <strong>Compuerta de seguridad activa (dependencia P0 del Project Manager)</strong>
            <div>{status.pmBlockedReason}</div>
          </div>
        </div>
      )}

      <section className="ent-card">
        <div className="ent-card-head">
          <strong><Icon name="spark" size={13} /> Modo de automatización del proyecto</strong>
          <span className="chip mint tiny"><Icon name="lock" size={11} /> Merge siempre manual</span>
        </div>

        <div className="tr-seg" role="radiogroup" aria-label="Modo de automatización">
          {(['manual', 'assisted', 'auto'] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={policy.mode === m}
              aria-pressed={policy.mode === m}
              disabled={saving}
              onClick={() => updatePolicy({ mode: m })}
            >
              {m === 'manual' ? 'Manual' : m === 'assisted' ? 'Asistido' : 'Automático'}
            </button>
          ))}
        </div>

        <p className="mut">
          {policy.mode === 'manual' && 'Manual: Entrega muestra estado, logs y diagnósticos, pero toda acción requiere intervención directa.'}
          {policy.mode === 'assisted' && 'Asistido: Entrega detecta fallos de CI/revisión y prepara planes de corrección y limpieza pendientes de confirmación.'}
          {policy.mode === 'auto' && 'Automático: Entrega delega correcciones al Project Manager dentro del límite de reintentos y ejecuta limpieza post-merge verificada. El merge sigue exigiendo aprobación humana explícita.'}
        </p>

        <div className="ent-policy-grid">
          <label className="ent-check-inline">
            <input type="checkbox" checked={policy.allowAutoDiagnose} disabled={saving}
              onChange={(e) => updatePolicy({ allowAutoDiagnose: e.target.checked })} />
            <span>Diagnosticar fallos de CI y revisión</span>
          </label>
          <label className="ent-check-inline">
            <input type="checkbox" checked={policy.allowAutoFix} disabled={saving || !status.pmDelegationReady}
              onChange={(e) => updatePolicy({ allowAutoFix: e.target.checked })} />
            <span>Delegar correcciones al Project Manager (requiere PM P0)</span>
          </label>
          <label className="ent-check-inline">
            <input type="checkbox" checked={policy.allowAutoCommit} disabled={saving || !status.pmDelegationReady}
              onChange={(e) => updatePolicy({ allowAutoCommit: e.target.checked })} />
            <span>Crear commits atómicos con Larry tras verificación</span>
          </label>
          <label className="ent-check-inline">
            <input type="checkbox" checked={policy.allowAutoPush} disabled={saving || !status.pmDelegationReady}
              onChange={(e) => updatePolicy({ allowAutoPush: e.target.checked })} />
            <span>Actualizar la misma PR mediante push autorizado</span>
          </label>
          <label className="ent-check-inline">
            <input type="checkbox" checked={policy.allowAutoCleanup} disabled={saving}
              onChange={(e) => updatePolicy({ allowAutoCleanup: e.target.checked })} />
            <span>Limpieza segura post-merge tras confirmar estado MERGED</span>
          </label>
          <label className="ent-row-wrap">
            <span>Límite de reintentos por PR:</span>
            <select
              className="in"
              style={{ width: 72 }}
              value={policy.maxRetries}
              disabled={saving}
              onChange={(e) => updatePolicy({ maxRetries: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      </section>

      <div className="ent-grid2">
        <section className="ent-card">
          <div className="ent-card-head">
            <strong>Intentos de corrección de PR ({status.attempts.length})</strong>
            <span className="mut">Deduplicados por PR + SHA</span>
          </div>
          {status.attempts.length === 0 ? (
            <p className="ent-empty-mini">Sin intentos registrados todavía.</p>
          ) : (
            status.attempts.map((a) => (
              <div key={a.id} className="ent-check-item">
                <span className="chip tiny">{a.status}</span>
                <div className="ent-check-main">
                  <strong className="mono">PR #{a.prNumber} · intento {a.attemptNo}</strong>
                  <div className="mut mono">{a.headSha.slice(0, 7)} · {a.summary ?? a.failureSignature}</div>
                </div>
                {['queued', 'running', 'awaiting_ci'].includes(a.status) && (
                  <button className="btn sm danger" onClick={() => cancelAttempt(a.id)}>Cancelar</button>
                )}
              </div>
            ))
          )}
        </section>

        <section className="ent-card">
          <div className="ent-card-head">
            <strong>Historial de entregas limpiadas ({status.archives.length})</strong>
            <span className="mut">Post-merge archivado</span>
          </div>
          {status.archives.length === 0 ? (
            <p className="ent-empty-mini">Sin limpiezas post-merge archivadas.</p>
          ) : (
            status.archives.map((ar) => (
              <div key={ar.id} className="ent-check-item">
                <span className="chip mint tiny">{ar.prNumber ? `PR #${ar.prNumber}` : 'Rama'}</span>
                <div className="ent-check-main">
                  <strong className="mono">{ar.branch} → {ar.base}</strong>
                  {ar.notes && <div className="mut">{ar.notes}</div>}
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
