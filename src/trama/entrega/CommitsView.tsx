import { useState } from 'react';
import { gitOps, larry, type BranchEntry, type GitStatus, type LarryCommit, type LarryPlan } from '../../ipc';
import { Icon } from '../icons';

type Props = {
  project: string;
  inspected: BranchEntry | null;
  status: GitStatus | null;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onRefresh: () => void;
};

export function CommitsView({
  project,
  inspected,
  status,
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

      {!isActive ? (
        <div className="ent-info-banner">
          <Icon name="info" size={13} />
          <span>
            Estás inspeccionando <strong className="mono">{inspected?.name ?? 'otra rama'}</strong> sin cambiar el checkout.
            Puedes explorar su historial en el grafo inferior; para crear commits locales activa esta rama.
          </span>
        </div>
      ) : (
        <>
          <section className="ent-sec">
            <div className="ent-sec-bar">
              <Icon name="spark" size={12} />
              <strong>Propuesta de Larry</strong>
              <span className="ent-mono-meta">Commits atómicos por unidad funcional</span>
            </div>

            <div className="ent-row-wrap">
              <button
                type="button"
                className="btn sm pearl"
                disabled={busy !== null || changes.length === 0}
                onClick={() => askLarry(false)}
              >
                {busy === 'larry' ? 'Analizando…' : 'Proponer con Larry'}
              </button>
              <button
                type="button"
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
                {larryPlan.notes && <p className="ent-sec-note">{larryPlan.notes}</p>}
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
                  <button type="button" className="btn sm ghost" onClick={() => setLarryPlan(null)}>
                    Descartar plan
                  </button>
                  <button
                    type="button"
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

          <section className="ent-sec">
            <div className="ent-sec-bar">
              <Icon name="commit" size={12} />
              <strong>Commit directo</strong>
              <span className="ent-mono-meta mono">
                {staged.length} preparados · {unstaged.length} pendientes
              </span>
            </div>

            <div className="ent-row-wrap">
              <button
                type="button"
                className="btn sm"
                disabled={busy !== null || unstaged.length === 0}
                onClick={() => onStage(unstaged.map((c) => c.path))}
              >
                Preparar todo ({unstaged.length})
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={busy !== null || staged.length === 0}
                onClick={() => onUnstage(staged.map((c) => c.path))}
              >
                Vaciar stage ({staged.length})
              </button>
              <button
                type="button"
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
              <span className="ent-sec-note">Hooks y comprobación local activos</span>
              <button
                type="button"
                className="btn sm pearl"
                disabled={staged.length === 0 || !directMsg.trim() || busy !== null}
                onClick={runDirectCommit}
              >
                {busy === 'commit' ? 'Creando…' : `Commit preparados (${staged.length})`}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
