import { useMemo, useState } from 'react';
import { health, type HealthRun } from '../../ipc';
import { openFindings, type ReviewNote } from '../findings';
import { Icon } from '../icons';

type Props = {
  project: string;
  headSha: string | null;
  dirtyTree: boolean;
  runs: HealthRun[];
  onOpenFinding: (note: ReviewNote) => void;
  onRefresh: () => void;
};

export function AuditsView({ project, headSha, dirtyTree, runs, onOpenFinding, onRefresh }: Props) {
  const [sevFilter, setSevFilter] = useState<'all' | 'error' | 'warning'>('all');
  const [busyFp, setBusyFp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const notes = useMemo(() => openFindings(runs), [runs]);
  const latestRun = runs[0] ?? null;
  const stale = Boolean(latestRun && headSha && latestRun.revision && latestRun.revision !== headSha) || dirtyTree;

  const filtered = useMemo(
    () => notes.filter((n) => sevFilter === 'all' || n.severity === sevFilter),
    [notes, sevFilter],
  );

  const resolveNote = async (note: ReviewNote, status: 'resolved' | 'accepted') => {
    if (!latestRun) return;
    setBusyFp(note.fingerprint);
    setError(null);
    try {
      await health.resolve(project, null, latestRun.id, note.fingerprint, status, status === 'resolved' ? 'Corregido' : 'Aceptado');
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyFp(null);
    }
  };

  return (
    <div className="ent-view">
      {error && <div className="tr-error" role="alert"><Icon name="warn" size={14} /><span>{error}</span></div>}

      <section className="ent-card">
        <div className="ent-card-head">
          <div className="ent-row-wrap">
            <strong><Icon name="shield" size={13} /> Auditorías y hallazgos ({notes.length} abiertos)</strong>
            {latestRun && (
              stale ? (
                <span className="chip amber tiny">Resultados sobre revisión anterior — re-auditar tras cambios</span>
              ) : (
                <span className="chip mint tiny">Vigente para HEAD actual</span>
              )
            )}
          </div>
          <div className="tr-seg">
            <button aria-pressed={sevFilter === 'all'} onClick={() => setSevFilter('all')}>Todos ({notes.length})</button>
            <button aria-pressed={sevFilter === 'error'} onClick={() => setSevFilter('error')}>
              Errores ({notes.filter((n) => n.severity === 'error').length})
            </button>
            <button aria-pressed={sevFilter === 'warning'} onClick={() => setSevFilter('warning')}>
              Avisos ({notes.filter((n) => n.severity === 'warning').length})
            </button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="ent-empty-mini">Sin hallazgos abiertos para el filtro seleccionado.</p>
        ) : (
          <div className="ent-finding-list">
            {filtered.map((n) => (
              <div key={n.fingerprint} className="ent-finding-row">
                <span className={`sev ${n.severity === 'error' ? 'h' : n.severity === 'warning' ? 'm' : 'l'}`} />
                <div className="ent-finding-body">
                  <button className="ent-finding-link" onClick={() => onOpenFinding(n)}>
                    <strong>{n.title ?? n.rule}</strong>
                    <span className="mut mono">
                      {n.path ?? 'general'}{n.line != null ? `:${n.line}` : ''} · {n.rule}
                    </span>
                  </button>
                  {n.who && n.who.length > 0 && (
                    <div className="ent-row-wrap" style={{ marginTop: 4 }}>
                      {n.who.map((w) => <span key={w} className="chip tiny">{w}</span>)}
                    </div>
                  )}
                </div>
                <div className="ent-row-wrap">
                  <button className="btn sm" disabled={busyFp === n.fingerprint} onClick={() => resolveNote(n, 'resolved')}>
                    Resuelto
                  </button>
                  <button className="btn sm ghost" disabled={busyFp === n.fingerprint} onClick={() => resolveNote(n, 'accepted')}>
                    Aceptar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
