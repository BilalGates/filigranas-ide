import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, type Project, type RecentSession } from '../ipc';
import ProviderLogo from '../ProviderLogo';
import { ENGINE_LABEL } from '../Session';
import { Icon } from './icons';
import { EmptyArt, Sigil, ago } from './kit';

function firstLine(text: string | null) {
  if (!text) return null;
  const line = text.split('\n').map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

/**
 * Historial de las últimas sesiones trabajadas cuando todavía no hay proyecto
 * seleccionado en Workspace. No inicia ninguna sesión artificialmente.
 */
export default function RecentSessions({
  projects,
  inicioOpen,
  onOpenSession,
  onOpenInicio,
}: {
  projects: Project[];
  inicioOpen: boolean;
  onOpenSession: (item: RecentSession) => void;
  onOpenInicio: () => void;
}) {
  const activeProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  const pathsKey = useMemo(() => JSON.stringify(activeProjects.map((p) => p.path).slice(0, 64)), [activeProjects]);
  const projectNames = useMemo(() => new Map(activeProjects.map((p) => [p.path, p.name])), [activeProjects]);
  const [items, setItems] = useState<RecentSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const paths: string[] = JSON.parse(pathsKey);
    if (!paths.length) {
      setItems([]);
      return;
    }
    let alive = true;
    const load = () => {
      api.recentSessions(paths, 24).then(
        (list) => { if (alive) { setItems(list); setError(null); } },
        (e) => { if (alive) setError(String(e)); },
      );
    };
    load();
    const offs = ['sessions-changed', 'tasks-changed', 'workspace-changed'].map((ev) => listen(ev, load));
    return () => {
      alive = false;
      offs.forEach((p) => void p.then((off) => off()));
    };
  }, [pathsKey]);

  return (
    <section className="rs-wrap" aria-label="Últimas sesiones">
      <header className="rs-head">
        <div>
          <h1>Últimas sesiones</h1>
          <p>Retoma una conversación reciente o selecciona un proyecto en Inicio.</p>
        </div>
        {!inicioOpen && (
          <button type="button" className="co-btn is-primary" onClick={onOpenInicio}>
            <Icon name="home" size={13} /> Abrir Inicio
          </button>
        )}
      </header>

      {error && <div className="co-error" role="alert">{error}</div>}

      {items === null && !error && (
        <div className="rs-loading muted" role="status">Cargando sesiones recientes…</div>
      )}

      {items && items.length === 0 && (
        <div className="rs-empty">
          <EmptyArt />
          <h2>Sin sesiones recientes</h2>
          <p>Elige o crea un proyecto en Inicio para abrir tu primera conversación.</p>
        </div>
      )}

      {items && items.length > 0 && (
        <div className="rs-list scr" role="list">
          {items.map((item) => {
            const projectName = projectNames.get(item.project) ?? item.project.split(/[\\/]/).pop() ?? item.project;
            const summary = firstLine(item.task);
            const engineName = item.engine === 'claude' ? 'Claude Code' : item.engine === 'codex' ? 'Codex' : (ENGINE_LABEL[item.engine] ?? item.engine);
            return (
              <button
                key={`${item.project}:${item.sessionId ?? 'pm'}`}
                type="button"
                role="listitem"
                className={`rs-item${item.closed ? ' is-closed' : ''}`}
                onClick={() => onOpenSession(item)}
                title={`${projectName} · ${item.name}`}
              >
                <span className="rs-sigil"><Sigil name={projectName} /></span>
                <span className="rs-main">
                  <span className="rs-top">
                    <span className="rs-title">{item.name}</span>
                    {item.isPm && <span className="rs-tag">PM</span>}
                    {item.closed && <span className="rs-tag is-muted">cerrada</span>}
                    <span className="rs-time">{ago(item.lastActiveMs)}</span>
                  </span>
                  {summary && <span className="rs-task">{summary}</span>}
                  <span className="rs-meta">
                    <span className="rs-proj">{projectName}</span>
                    <span className="rs-dot" aria-hidden="true">·</span>
                    <span className="rs-eng"><ProviderLogo engine={item.engine} size={11} />{engineName}</span>
                    {item.branch && (
                      <>
                        <span className="rs-dot" aria-hidden="true">·</span>
                        <span className="rs-branch"><Icon name="branch" size={11} />{item.branch}</span>
                      </>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
