import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import ReviewDiff from './ReviewDiff';
import { git, sessions, type Change, type DiffTarget } from '../ipc';
import { Icon } from './icons';

export default function WorkspaceChanges({ project, session, onDiff, onEntrega, conversation, tabsTarget }: {
  project: string; session: number | null; onDiff: (change: DiffTarget) => void; onEntrega: () => void;
  conversation?: ReactNode;
  /** Cabecera de la observación: recibe una pestaña por archivo cambiado. */
  tabsTarget?: HTMLElement | null;
}) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string>();
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

  const selection = conversation && !failed ? changes?.slice(0, 3).find((change) => change.path === selected) ?? changes?.[0] : undefined;
  const tabs = tabsTarget && conversation && !failed && changes?.length ? createPortal(changes.slice(0, 3).map((change) => (
    <button key={change.path} className="obs-file" title={change.path} aria-pressed={selection?.path === change.path} onClick={() => setSelected(change.path)}>
      <Icon name="file" size={13} />{change.path.split('/').at(-1)}<span className="obs-file-mark" aria-label="con cambios" />
    </button>
  )), tabsTarget) : null;
  return <>{tabs}<div className="workspace-changes" aria-label={conversation ? 'Cambios observados' : 'Cambios del editor'} role="group">
    <span className="workspace-changes-label">{session == null ? 'Cambios del proyecto' : 'Cambios de la sesión'}</span>
    <div className="workspace-change-files">
      {failed ? <span role="status">No se pudieron leer los cambios</span> : changes == null ? <span>Consultando…</span> : !changes.length ? <span>Sin cambios</span> : changes.slice(0, 3).map((change) => (
        <button className="workspace-change" key={change.path} title={change.path} aria-pressed={conversation ? selection?.path === change.path : undefined}
          onClick={() => { if (conversation) setSelected(change.path); else onDiff(session == null ? change : { ...change, session }); }}>
          <span>{change.path.split('/').at(-1)}</span>
          {change.adds != null && <small className="workspace-added">+{change.adds}</small>}
          {!!change.dels && <small className="workspace-removed">−{change.dels}</small>}
        </button>
      ))}
      {!failed && changes && changes.length > 3 && <span>+{changes.length - 3}</span>}
    </div>
    <button className="workspace-open-review" onClick={onEntrega}>Entrega <Icon name="chev" size={13} /></button>
  </div>
  {conversation}
  {selection && <div className="workspace-observation-diff" aria-label="Código observado" role="region">
    <div className="workspace-observation-caption" title={selection.path}>Código que está tocando</div>
    <ReviewDiff project={project} change={session == null ? selection : { ...selection, session }} />
  </div>}
  </>;
}
