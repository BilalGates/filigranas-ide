import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { sessions, type Change, type DiffTarget, type Session } from './ipc';

type Props = {
  session: Session;
  closed: boolean;
  onDiff: (change: DiffTarget) => void;
  onChanged: () => void;
  onConflicts: (files: string[]) => void;
};

export default function Pending({ session, closed, onDiff, onChanged, onConflicts }: Props) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [clash, setClash] = useState(false);
  const [integrated, setIntegrated] = useState(!!session.integrated && !session.integrated.startsWith('conflicts:'));
  const [removed, setRemoved] = useState(false);
  const request = useRef(0);
  const id = session.id;
  const label = `${session.branch} → ${session.base ?? 'destino desconocido'}`;

  const reload = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const status = await sessions.changes(id);
      if (sequence !== request.current) return;
      setChanges(status.changes);
      setReadError('');
    } catch (e) {
      if (sequence !== request.current) return;
      setChanges(null);
      setReadError(String(e));
    }
  }, [id]);

  useEffect(() => {
    if (removed) return;
    void reload();
    let timer: number | undefined;
    const stop = listen('project-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, 200);
    });
    return () => {
      ++request.current;
      window.clearTimeout(timer);
      void stop.then((off) => off());
    };
  }, [reload, removed]);

  const act = async (action: 'reopen' | 'integrate' | 'merge' | 'cleanup') => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (action === 'reopen') {
        await sessions.reopen(id);
        setMessage('Sesión retomada.');
      } else if (action === 'cleanup') {
        await sessions.cleanup(id);
        setRemoved(true);
        setMessage('Rama y copia de trabajo eliminadas.');
      } else if (action === 'integrate') {
        const files = await sessions.integrate(id);
        setIntegrated(true);
        setClash(false);
        setMessage(`Integrado en ${session.base}: ${files.length} archivos como cambios sin commit.`);
      } else {
        const { files, conflicts } = await sessions.integrateMerging(id);
        setIntegrated(conflicts.length === 0);
        setClash(conflicts.length > 0);
        if (conflicts.length) onConflicts(conflicts);
        setMessage(conflicts.length ? `${conflicts.length} archivos requieren resolución.` : `Integrados ${files.length} archivos sin conflictos.`);
      }
    } catch (e) {
      const message = String(e);
      setError(message);
      if (action === 'integrate') setClash(message.includes('no se puede integrar sin conflictos'));
    } finally {
      setBusy(false);
      onChanged();
      if (action !== 'cleanup') void reload();
    }
  };

  return (
    <section className="coach" aria-label="Rama">
      <div className="co-head">
        <span>{label}</span>
        <span className="push" />
        {!removed && <button className="co-link" onClick={() => void reload()} disabled={busy}>Actualizar cambios</button>}
      </div>
      <div className="co-log">
        {message && <div className="co-notice" role="status">{message}</div>}
        {error && <div className="co-error" role="alert">{error}</div>}
        {!removed && <>
          {readError && <div className="co-error" role="alert">{readError}</div>}
          {!readError && changes == null && <p className="muted">Consultando cambios…</p>}
          {changes?.length === 0 && <p className="muted">Sin cambios frente al punto de partida.</p>}
          {!!changes?.length && <div className="co-changes">
            {changes.map((change) => (
              <button key={change.path} className="git-change" onClick={() => onDiff({ ...change, session: id, label })}>
                <span className="co-status">{change.status}</span>
                <span className="git-path">{change.path}</span>
                {change.adds != null && <span className="add">+{change.adds}</span>}
                {change.dels != null && <span className="del">−{change.dels}</span>}
              </button>
            ))}
          </div>}
          <div className="co-actions">
            {closed && <button className="co-btn" onClick={() => void act('reopen')} disabled={busy}>Retomar sesión</button>}
            <button className="co-btn" onClick={() => void act('integrate')} disabled={busy || !changes?.length}>
              Integrar en {session.base ?? 'el proyecto'}
            </button>
            {clash && <button className="co-btn" onClick={() => void act('merge')} disabled={busy}>
              Integrar con conflictos
            </button>}
            <button className="co-btn" onClick={() => void act('cleanup')}
              disabled={busy || changes == null || clash || (!integrated && changes.length > 0)}
              title="Elimina la rama y su copia de trabajo después de comprobar la integración">
              Limpiar rama
            </button>
          </div>
        </>}
      </div>
    </section>
  );
}
