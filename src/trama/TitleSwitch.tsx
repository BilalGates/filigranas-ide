import type { Session, Workspace } from '../ipc';
import { ENGINE_LABEL } from '../Session';
import { Sigil } from './kit';
import { pmActivityKey, type ActiveSelection } from './workspaceContext';

function engineShort(engine: string): string {
  if (engine === 'claude') return 'Claude';
  if (engine === 'codex') return 'Codex';
  return ENGINE_LABEL[engine] ?? engine;
}

function sessionDisplayTitle(s: Session): string {
  const title = s.title?.trim() || s.name;
  return `${engineShort(s.engine)} · ${title}`;
}

/**
 * Indicador superior discreto y no interactivo del contexto activo (`Proyecto / Sesión`).
 * La navegación entre proyectos y sesiones vive en el explorador lateral y en la búsqueda global (⌘K).
 */
export default function TitleSwitch({
  ws,
  selection,
  project,
  sessionsByProject,
  activity,
}: {
  ws: Workspace;
  selection: ActiveSelection;
  project: string | null;
  sessionsByProject: Record<string, Session[]>;
  activity: Record<string, 'trabajando' | 'permiso' | null>;
}) {
  const current = ws.projects.find((p) => !p.archived && p.path === project) ?? null;
  const currentSessions = project ? sessionsByProject[project] ?? [] : [];
  const activeSession = selection?.kind === 'session'
    ? currentSessions.find((s) => s.id === selection.sessionId) ?? null
    : null;
  const activeSessionLabel = !current
    ? null
    : activeSession
      ? sessionDisplayTitle(activeSession)
      : 'Project Manager';
  const activeState = !current
    ? null
    : activeSession
      ? (activity[String(activeSession.id)] ?? (activeSession.status === 'trabajando' ? 'trabajando' : activeSession.status === 'esperando' ? 'permiso' : null))
      : (activity[pmActivityKey(current.path)] ?? null);

  return (
    <div
      className="tb-context"
      aria-label={current ? `Contexto activo: ${current.name} / ${activeSessionLabel}` : 'Sin sesión activa'}
      title={current ? `${current.name} / ${activeSessionLabel}` : undefined}
      data-tauri-drag-region
    >
      {current ? (
        <>
          <span className="tb-sig"><Sigil name={current.name} /></span>
          <span className="tb-name">{current.name}</span>
          <span className="tb-sep" aria-hidden="true">/</span>
          <span className="tb-sess-current">{activeSessionLabel}</span>
          {activeState && <span className={`dot is-${activeState}`} aria-hidden="true" />}
        </>
      ) : (
        <span className="tb-ctx-empty">Sin sesión activa</span>
      )}
    </div>
  );
}
