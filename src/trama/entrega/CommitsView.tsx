import { useState } from 'react';
import { gitOps, larry, type BranchEntry, type GitStatus, type LarryCommit, type LarryPlan, type LogRow } from '../../ipc';
import { Icon } from '../icons';

type Props = {
  project: string;
  inspected: BranchEntry | null;
  status: GitStatus | null;
  commits: LogRow[];
  selectedCommit: string | null;
  onSelectCommit: (hash: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onRefresh: () => void;
};

export function CommitsView({
  project,
  inspected,
  status,
  commits,
  selectedCommit,
  onSelectCommit,
  onStage,
  onUnstage,
  onRefresh,
}: Props) {
  const isActive = Boolean(inspected?.active);
  const changes = isActive ? (status?.changes ?? []) : [];
  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => c.unstaged);

  const [directMsg, setDirectMsg] = useState('');
  const [larryPlan, setLarryPlan] = useState<LarryPlan | null>(null);
  const [larryHint, setLarryHint] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runDirectCommit = async () => {
    if (!directMsg.trim()) return;
    setBusy('commit');
    setError(null);
    setNotice(null);
    try {
      const res = await gitOps.commitStaged(project, directMsg.trim(), null);
      setDirectMsg('');
      setNotice(`Commit creado: ${res}`);
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const askLarry = async (onlyUnstaged = false) => {
    setBusy('larry');
    setError(null);
    setNotice(null);
    try {
      const paths = onlyUnstaged ? unstaged.map((c) => c.path) : null;
      const plan = await larry.proposeSelected(project, null, paths, larryHint.trim() || null);
      setLarryPlan(plan);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const loadLarryGroups = async () => {
    setBusy('groups');
    setError(null);
    try {
      const plan = await larry.groups(project, null);
      setLarryPlan(plan);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const executeLarry = async () => {
    if (!larryPlan) return;
    setBusy('larry-commit');
    setError(null);
    setNotice(null);
    try {
      const out = await larry.commit(project, null, larryPlan.commits, false);
      if (out.stopped) setError(out.stopped);
      if (out.created.length > 0) {
        setNotice(`Creados ${out.created.length} commits: ${out.created.join(' · ')}`);
        if (!out.stopped) setLarryPlan(null);
      }
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const undoLast = async () => {
    setBusy('undo');
    setError(null);
    setNotice(null);
    try {
      await gitOps.undoCommit(project);
      setNotice('Último commit local deshecho (los cambios siguen en el índice).');
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const updateLarryMsg = (idx: number, message: string) => {
    setLarryPlan((prev) => {
      if (!prev) return prev;
      const next: LarryCommit[] = prev.commits.map((c, i) => (i === idx ? { ...c, message } : c));
      return { ...prev, commits: next };
    });
  };

  return (
    <div className="ent-view ent-commits">
      {error && <div className="tr-error" role="alert"><Icon name="warn" size={14} /><span>{error}</span></div>}
      {notice && <div className="ent-notice"><Icon name="check" size={14} /><span>{notice}</span></div>}

      {isActive ? (
        <div className="ent-grid2">
          <section className="ent-card">
            <div className="ent-card-head">
              <strong>Preparación y commit directo</strong>
              <span className="mut mono">{staged.length} preparados · {unstaged.length} pendientes</span>
            </div>

            <div className="ent-row-wrap">
              <button
                className="btn sm"
                disabled={busy !== null || unstaged.length === 0}
                onClick={() => onStage(unstaged.map((c) => c.path))}
              >
                Preparar todo ({unstaged.length})
              </button>
              <button
                className="btn sm"
                disabled={busy !== null || staged.length === 0}
                onClick={() => onUnstage(staged.map((c) => c.path))}
              >
                Vaciar stage ({staged.length})
              </button>
              <button
                className="btn sm ghost"
                disabled={busy !== null}
                onClick={undoLast}
                title="Deshacer último commit local si no está publicado"
              >
                Deshacer último
              </button>
            </div>

            <textarea
              className="in ent-commit-input mono"
              rows={3}
              value={directMsg}
              onChange={(e) => setDirectMsg(e.target.value)}
              placeholder="tipo(alcance): resumen del commit para los archivos preparados"
              disabled={staged.length === 0 || busy !== null}
            />
            <div className="ent-row-end">
              <span className="mut">Hooks y comprobación local activos</span>
              <button
                className="btn sm pearl"
                disabled={staged.length === 0 || !directMsg.trim() || busy !== null}
                onClick={runDirectCommit}
              >
                {busy === 'commit' ? 'Creando…' : `Commit preparados (${staged.length})`}
              </button>
            </div>
          </section>

          <section className="ent-card">
            <div className="ent-card-head">
              <strong><Icon name="spark" size={13} /> Larry · Commits atómicos</strong>
              <span className="mut">Agrupa por unidad funcional</span>
            </div>

            <div className="ent-row-wrap">
              <button
                className="btn sm pearl"
                disabled={busy !== null || changes.length === 0}
                onClick={() => askLarry(false)}
              >
                {busy === 'larry' ? 'Analizando…' : 'Proponer con Larry'}
              </button>
              <button
                className="btn sm"
                disabled={busy !== null || changes.length === 0}
                onClick={loadLarryGroups}
              >
                Grupos rápidos
              </button>
            </div>

            <input
              type="text"
              className="in"
              value={larryHint}
              onChange={(e) => setLarryHint(e.target.value)}
              placeholder="Indicación opcional para Larry (ej. separa docs de refactor)…"
            />

            {larryPlan && (
              <div className="ent-larry-plan">
                {larryPlan.notes && <p className="ent-muted-note">{larryPlan.notes}</p>}
                {larryPlan.commits.map((c, idx) => (
                  <div key={idx} className="commit">
                    <input
                      value={c.message}
                      onChange={(e) => updateLarryMsg(idx, e.target.value)}
                      aria-label={`Mensaje del commit ${idx + 1}`}
                    />
                    <div className="fl">{c.files.join(', ')}</div>
                  </div>
                ))}
                <div className="ent-row-end">
                  <button className="btn sm ghost" onClick={() => setLarryPlan(null)}>Descartar plan</button>
                  <button
                    className="btn sm pearl"
                    disabled={busy !== null}
                    onClick={executeLarry}
                  >
                    {busy === 'larry-commit' ? 'Aplicando…' : `Crear ${larryPlan.commits.length} commits`}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="ent-info-banner">
          <Icon name="info" size={14} />
          <span>
            Estás inspeccionando <strong className="mono">{inspected?.name ?? 'otra rama'}</strong> sin hacer checkout.
            El historial de commits es completamente navegable; para crear nuevos commits locales activa esta rama.
          </span>
        </div>
      )}

      <section className="ent-card">
        <div className="ent-card-head">
          <strong>Historial de commits · <span className="mono">{inspected?.name ?? 'HEAD'}</span></strong>
          <span className="mut mono">{commits.length} recientes</span>
        </div>
        <div className="ent-commit-list">
          {commits.map((row) => (
            <button
              key={row.hash}
              className={`ent-crow${selectedCommit === row.hash ? ' on' : ''}`}
              onClick={() => onSelectCommit(row.hash)}
            >
              <span className="mono ent-chash">{row.hash}</span>
              <span className="ent-csubj">{row.subject}</span>
              {row.refs && <span className="chip tiny">{row.refs}</span>}
              <span className="mut ent-cauth">{row.author}</span>
              <span className="mut mono ent-cdate">{row.date.slice(0, 10)}</span>
            </button>
          ))}
          {commits.length === 0 && <p className="ent-empty-mini">Sin commits en esta referencia.</p>}
        </div>
      </section>
    </div>
  );
}
