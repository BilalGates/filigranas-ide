import { useCallback, useEffect, useState } from 'react';
import { sessions, type Change, type DiffTarget, type Session } from './ipc';
import { ENGINE_LABEL } from './Session';

type Props = { project: string; hidden: boolean; onDiff: (c: DiffTarget) => void; onChanged: () => void; onConflicts: (files: string[]) => void };

type Row = { session: Session; changes: Change[] | null; open: boolean; busy: boolean; clash: boolean; message: string | null; error: string | null };

/**
 * Ramas de sesiones cerradas que siguen en disco: nada se pierde al cerrar
 * una sesión, y aquí se retoma, se integra o se limpia ese trabajo.
 */
export default function Pending({ project, hidden, onDiff, onChanged, onConflicts }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const patch = (id: number, f: Partial<Row>) => setRows((list) => list.map((r) => (r.session.id === id ? { ...r, ...f } : r)));

  const load = useCallback(() => {
    setLoading(true);
    sessions.orphans(project).then(
      (list) => {
        setRows(list.map((session) => ({ session, changes: null, open: false, busy: false, clash: false, message: null, error: null })));
        setLoading(false);
        list.forEach((s) =>
          sessions.changes(s.id).then(
            (st) => patch(s.id, { changes: st.changes }),
            (e) => patch(s.id, { error: String(e), changes: [] }),
          ),
        );
      },
      (e) => {
        setError(String(e));
        setLoading(false);
      },
    );
  }, [project]);

  useEffect(load, [load]);

  const act = (r: Row, run: () => Promise<string | null>) => {
    patch(r.session.id, { busy: true, error: null, message: null });
    run()
      .then(
        (message) => patch(r.session.id, { message }),
        (e) => patch(r.session.id, { error: String(e), clash: String(e).includes('sin conflictos') }),
      )
      .finally(() => {
        patch(r.session.id, { busy: false });
        onChanged();
        sessions.changes(r.session.id).then((st) => patch(r.session.id, { changes: st.changes }), () => {});
      });
  };

  const reopen = (r: Row) => act(r, () => sessions.reopen(r.session.id).then(() => (load(), null)));
  const integrate = (r: Row) =>
    act(r, () => sessions.integrate(r.session.id).then((files) => `Integrado en ${r.session.base}: ${files.length} archivos como cambios sin commit.`));
  const merge = (r: Row) =>
    act(r, () =>
      sessions
        .integrateMerging(r.session.id)
        .then(({ files, conflicts }) => {
          if (conflicts.length) onConflicts(conflicts);
          return conflicts.length ? `Integrado con conflictos en ${conflicts.join(', ')}.` : `Integrado sin conflictos: ${files.length} archivos.`;
        }),
    );
  const cleanup = (r: Row) => act(r, () => sessions.cleanup(r.session.id).then(() => (load(), null)));

  return (
    <section className="coach" aria-label="Ramas sin integrar" hidden={hidden}>
      <div className="co-head">
        <span>ramas sin integrar</span>
        <span className="muted">sesiones cerradas cuya rama sigue guardada</span>
        <span className="push" />
        <button className="co-link" onClick={load} disabled={loading}>
          actualizar
        </button>
      </div>
      <div className="co-log">
        {loading && <div className="muted">buscando…</div>}
        {!loading && rows.length === 0 && !error && <div className="muted co-empty">No queda trabajo de sesiones cerradas en este proyecto.</div>}
        {rows.map((r) => {
          const s = r.session;
          const n = r.changes?.length ?? 0;
          const label = `${s.branch} frente a ${s.base}`;
          return (
            <div className="pending-row" key={s.id}>
              <div className="pending-head">
                <span>{s.name}</span>
                <span className="muted">{ENGINE_LABEL[s.engine] ?? s.engine}</span>
                <span title={s.worktree ?? undefined}>
                  ⎇ {s.branch} <span className="muted">← {s.base}</span>
                </span>
                {s.integrated && <span className="add">integrada</span>}
                <button className="co-link" aria-expanded={r.open} disabled={!n} onClick={() => patch(s.id, { open: !r.open })}>
                  {r.changes == null ? '…' : n ? `${n} cambio${n === 1 ? '' : 's'}` : 'sin cambios'}
                </button>
              </div>
              {s.task && <div className="muted pending-task">{s.task.split('\n').find((l) => l.trim() && !l.startsWith('Encargo del coordinador')) ?? ''}</div>}
              {r.open && (
                <div className="co-changes">
                  {r.changes?.map((c) => (
                    <button key={c.path} className="git-change" onClick={() => onDiff({ ...c, session: s.id, label })}>
                      <span className="co-status">{c.status}</span>
                      <span className="git-path">{c.path}</span>
                      {c.adds != null && <span className="add">+{c.adds}</span>}
                      {c.dels != null && <span className="del">−{c.dels}</span>}
                    </button>
                  ))}
                </div>
              )}
              <div className="co-actions">
                <button className="co-btn" onClick={() => reopen(r)} disabled={r.busy} title="vuelve a abrir la sesión y su conversación">
                  retomar
                </button>
                <button className="co-btn" onClick={() => integrate(r)} disabled={r.busy || !n} title="aplica sus cambios al proyecto, sin commit">
                  integrar en {s.base}
                </button>
                {r.clash && (
                  <button className="co-btn" onClick={() => merge(r)} disabled={r.busy}>
                    integrar con conflictos
                  </button>
                )}
                <button className="co-btn" onClick={() => cleanup(r)} disabled={r.busy || (!s.integrated && n > 0 && !r.message)} title="borra la rama y su carpeta; solo si todo está integrado">
                  limpiar rama
                </button>
              </div>
              {r.message && <div className="co-notice">{r.message}</div>}
              {r.error && <div className="co-error">{r.error}</div>}
            </div>
          );
        })}
        {error && <div className="co-error">{error}</div>}
      </div>
    </section>
  );
}
