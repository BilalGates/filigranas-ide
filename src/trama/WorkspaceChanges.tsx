import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { git, sessions, type Change, type DiffTarget } from '../ipc';
import { Icon } from './icons';

export default function WorkspaceChanges({ project, session, onDiff, onEntrega }: {
  project: string; session: number | null; onDiff: (change: DiffTarget) => void; onEntrega: () => void;
}) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revision = 0;
    const refresh = () => {
      const id = ++revision;
      void (session == null ? git.status(project) : sessions.changes(session)).then((status) => {
        if (revision !== id) return;
        setChanges(status.changes);
        setFailed(false);
      }, () => { if (revision === id) setFailed(true); });
    };
    refresh();
    const off = listen('project-changed', refresh);
    return () => { revision++; void off.then((stop) => stop()); };
  }, [project, session]);

  return <div className="workspace-changes" aria-label="Cambios del editor" role="group">
    <span className="workspace-changes-label">{session == null ? 'Cambios del proyecto' : 'Cambios de la sesión'}</span>
    <div className="workspace-change-files">
      {failed ? <span role="status">No se pudieron leer los cambios</span> : changes == null ? <span>Consultando…</span> : !changes.length ? <span>Sin cambios</span> : changes.slice(0, 3).map((change) => (
        <button className="workspace-change" key={change.path} title={change.path}
          onClick={() => onDiff(session == null ? change : { ...change, session })}>
          <span>{change.path.split('/').at(-1)}</span>
          {change.adds != null && <small className="workspace-added">+{change.adds}</small>}
          {!!change.dels && <small className="workspace-removed">−{change.dels}</small>}
        </button>
      ))}
      {!failed && changes && changes.length > 3 && <span>+{changes.length - 3}</span>}
    </div>
    <button className="workspace-open-review" onClick={onEntrega}>Entrega <Icon name="chev" size={13} /></button>
  </div>;
}
