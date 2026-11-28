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
      await health.resolve(
        project,
        null,
        latestRun.id,
        note.fingerprint,
        status,
        status === 'resolved' ? 'Corregido' : 'Aceptado',
      );
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyFp(null);
    }
  };

  return (
    <section className="ent-sec">
      {error && (
        <div className="tr-error" role="alert">
          <Icon name="warn" size={13} />
          <span>{error}</span>
        </div>
      )}

      <div className="ent-sec-bar">
        <Icon name="shield" size={12} />
        <strong>Auditorías y hallazgos</strong>
        <span className="ent-mono-meta mono">{notes.length} abiertos</span>
        {latestRun && (
          <span className={`ent-inline-tag tone-${stale ? 'amber' : 'mint'}`}>
            {stale ? 'Re-auditar' : 'Vigente'}
          </span>
        )}
        <span className="grow" />
        <div className="tr-seg ent-mini-seg">
          <button type="button" aria-pressed={sevFilter === 'all'} onClick={() => setSevFilter('all')}>
            Todos
          </button>
          <button type="button" aria-pressed={sevFilter === 'error'} onClick={() => setSevFilter('error')}>
            Errores ({notes.filter((n) => n.severity === 'error').length})
          </button>
          <button type="button" aria-pressed={sevFilter === 'warning'} onClick={() => setSevFilter('warning')}>
            Avisos ({notes.filter((n) => n.severity === 'warning').length})
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="ent-empty-inline">Sin hallazgos abiertos para el filtro seleccionado.</p>
      ) : (
        <div className="ent-list">
          {filtered.map((n) => (
            <div key={n.fingerprint} className="ent-list-row">
              <span className={`sev ${n.severity === 'error' ? 'h' : n.severity === 'warning' ? 'm' : 'l'}`} />
              <button type="button" className="ent-finding-link" onClick={() => onOpenFinding(n)}>
                <strong>{n.title ?? n.rule}</strong>
                <span className="mut mono">
                  {n.path ?? 'general'}{n.line != null ? `:${n.line}` : ''} · {n.rule}
                  {n.who && n.who.length > 0 ? ` · ${n.who.join(', ')}` : ''}
                </span>
              </button>
              <button
                type="button"
                className="btn sm ghost"
                disabled={busyFp === n.fingerprint}
                onClick={() => resolveNote(n, 'resolved')}
              >
                Resuelto
              </button>
              <button
                type="button"
                className="btn sm ghost"
                disabled={busyFp === n.fingerprint}
                onClick={() => resolveNote(n, 'accepted')}
              >
                Aceptar
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
