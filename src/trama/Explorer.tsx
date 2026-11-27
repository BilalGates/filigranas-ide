import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type Project, type Session, type Workspace } from '../ipc';
import { ENGINE_LABEL } from '../Session';
import { shortcut, useUi } from '../ui';
import { Icon } from './icons';
import { AgDot, Sigil, sessionAgents, type Agent } from './kit';
import type { ActiveSelection } from './workspaceContext';

const COLLAPSED_GROUPS_KEY = 'filigranas.collapsed';
const EXPANDED_PROJECTS_KEY = 'filigranas.explorer.expanded';

function loadBoolMap(key: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadStringSet(key: string, initial?: string | null): Set<string> {
  const out = new Set<string>();
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'string' && item) out.add(item);
      }
    }
  } catch {
    // ignore storage errors
  }
  if (initial) out.add(initial);
  return out;
}

function engineShort(engine: string): string {
  if (engine === 'claude') return 'Claude';
  if (engine === 'codex') return 'Codex';
  return ENGINE_LABEL[engine] ?? engine;
}

function compactTask(text: string | null | undefined, max = 38): string | null {
  if (!text) return null;
  const line = text.split('\n').map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export type ExplorerProps = {
  ws: Workspace;
  selection: ActiveSelection;
  project: string | null;
  sessionsByProject: Record<string, Session[]>;
  pmProjects: ReadonlySet<string>;
  pmClaudeByProject: Record<string, Session | null>;
  onSelectSession: (next: Exclude<ActiveSelection, null>) => void;
  onSelectProject: (path: string) => void;
  onNewSession: (projectPath: string) => void;
  onStartPm: (projectPath: string) => void;
  onHidePm: (projectPath: string) => void;
  onCloseSession: (id: number) => void;
  onUpdate: (p: Promise<Workspace>) => void;
  onProjectView: (path: string, tab: 'files' | 'git' | 'containers') => void;
  onProjectTerminal: (path: string) => void;
  onError: (message: string) => void;
  footer?: ReactNode;
  className?: string;
};

/**
 * Explorador lateral unificado de Workspace: proyectos agrupados y desplegables
 * con su Project Manager, sesiones y subsesiones en tiempo real, gestión de
 * proyectos/grupos y archivados, sin buscador local duplicado (la búsqueda
 * global vive en la barra superior ⌘K).
 */
export default function Explorer({
  ws,
  selection,
  project,
  sessionsByProject,
  pmProjects,
  pmClaudeByProject,
  onSelectSession,
  onSelectProject,
  onNewSession,
  onStartPm,
  onHidePm,
  onCloseSession,
  onUpdate,
  onProjectView,
  onProjectTerminal,
  onError,
  footer,
  className = '',
}: ExplorerProps) {
  const { activity } = useUi();
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => loadBoolMap(COLLAPSED_GROUPS_KEY));
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => loadStringSet(EXPANDED_PROJECTS_KEY, project));
  const [menuProject, setMenuProject] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);

  // Despliega automáticamente el proyecto de la sesión activa para mantener el foco visible.
  useEffect(() => {
    if (!project) return;
    setExpandedProjects((cur) => {
      if (cur.has(project)) return cur;
      const next = new Set(cur);
      next.add(project);
      return next;
    });
  }, [project]);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(collapsedGroups)); } catch { /* */ }
  }, [collapsedGroups]);

  useEffect(() => {
    try { localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([...expandedProjects])); } catch { /* */ }
  }, [expandedProjects]);

  const toggleGroup = (key: string) => setCollapsedGroups((c) => ({ ...c, [key]: !c[key] }));
  const toggleProject = (path: string) =>
    setExpandedProjects((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const activeProjects = useMemo(() => ws.projects.filter((p) => !p.archived), [ws.projects]);
  const archivedProjects = useMemo(() => ws.projects.filter((p) => p.archived), [ws.projects]);

  const sections = useMemo(() => {
    const knownGroupIds = new Set(ws.groups.map((g) => g.id));
    const grouped = ws.groups.map((g) => ({
      key: `g${g.id}`,
      id: g.id as number | null,
      name: g.name,
      items: activeProjects.filter((p) => p.groupId === g.id),
    }));
    const ungrouped = {
      key: 'none',
      id: null as number | null,
      name: 'Sin clasificar',
      items: activeProjects.filter((p) => p.groupId == null || !knownGroupIds.has(p.groupId)),
    };
    return [...grouped, ungrouped].filter((s) => s.items.length > 0 || s.id !== null);
  }, [ws.groups, activeProjects]);

  return (
    <aside className={`sidebar tv threads-side explorer-side${className ? ` ${className}` : ''}`} aria-label="Explorador de proyectos y conversaciones">
      <div className="threads explorer">
        <div className="ph">
          <h3 className="grow">Conversaciones</h3>
          <button
            type="button"
            className="tbtn"
            onClick={() => project && onNewSession(project)}
            disabled={!project}
            aria-label="Nueva sesión en el proyecto activo"
            title={shortcut('Nueva sesión · ⌘T')}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>

        <div className="scr explorer-scroll" role="tree" aria-label="Proyectos y sesiones">
          {activeProjects.length === 0 && (
            <div className="threads-empty">Sin proyectos activos. Crea uno nuevo o ábrelo en Inicio.</div>
          )}

          {sections.map((section) => {
            const groupClosed = !!collapsedGroups[section.key];
            return (
              <section key={section.key} className="exp-group">
                {(ws.groups.length > 0 || section.id !== null) && (
                  <div className="exp-group-head">
                    {renamingGroup === section.id && section.id !== null ? (
                      <InlineInput
                        initial={section.name}
                        label="Nombre del grupo"
                        onCancel={() => setRenamingGroup(null)}
                        onSubmit={(name) => {
                          setRenamingGroup(null);
                          onUpdate(api.renameGroup(section.id!, name));
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="exp-group-btn"
                        onClick={() => toggleGroup(section.key)}
                        onDoubleClick={() => section.id !== null && setRenamingGroup(section.id)}
                        aria-expanded={!groupClosed}
                      >
                        <Icon name={groupClosed ? 'chev' : 'down'} size={10} />
                        <span className="exp-group-label">{section.name}</span>
                      </button>
                    )}
                    {section.id !== null && renamingGroup !== section.id && (
                      <span className="exp-group-actions">
                        <button
                          type="button"
                          className="exp-mini-btn"
                          onClick={() => setRenamingGroup(section.id)}
                          aria-label={`Renombrar grupo ${section.name}`}
                          title="Renombrar grupo"
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="exp-mini-btn"
                          onClick={() => onUpdate(api.deleteGroup(section.id!))}
                          aria-label={`Quitar grupo ${section.name}`}
                          title="Quitar grupo (los proyectos pasan a Sin clasificar)"
                        >
                          <Icon name="close" size={9} />
                        </button>
                      </span>
                    )}
                  </div>
                )}

                {!groupClosed && section.items.map((p) => {
                  const sessions = sessionsByProject[p.path] ?? [];
                  const hasPm = pmProjects.has(p.path);
                  const pmClaude = pmClaudeByProject[p.path] ?? null;
                  const pmEngine = pmClaude?.engine === 'claude' ? 'Claude' : 'Codex';
                  const agents = sessionAgents(sessions, activity, hasPm ? { engine: pmEngine } : null, p.path);
                  return (
                    <ProjectNode
                      key={p.path}
                      p={p}
                      ws={ws}
                      selection={selection}
                      isActiveProject={p.path === project}
                      expanded={expandedProjects.has(p.path)}
                      hasPm={hasPm}
                      pmEngine={pmEngine}
                      pmSessionId={pmClaude?.id ?? null}
                      sessions={sessions}
                      agents={agents}
                      menuOpen={menuProject === p.path}
                      onToggleExpand={() => toggleProject(p.path)}
                      onMenu={(open) => setMenuProject(open ? p.path : null)}
                      onSelectProject={() => {
                        setExpandedProjects((cur) => new Set(cur).add(p.path));
                        onSelectProject(p.path);
                      }}
                      onSelectSession={onSelectSession}
                      onNewSession={() => {
                        setExpandedProjects((cur) => new Set(cur).add(p.path));
                        onNewSession(p.path);
                      }}
                      onStartPm={() => {
                        setExpandedProjects((cur) => new Set(cur).add(p.path));
                        onStartPm(p.path);
                      }}
                      onHidePm={() => onHidePm(p.path)}
                      onCloseSession={onCloseSession}
                      onUpdate={onUpdate}
                      onError={onError}
                      onView={(tab) => onProjectView(p.path, tab)}
                      onTerminal={() => onProjectTerminal(p.path)}
                    />
                  );
                })}
              </section>
            );
          })}
        </div>

        <div className="threads-foot explorer-foot">
          {creatingProject ? (
            <InlineInput
              label="Nombre del proyecto nuevo"
              placeholder="Nombre del proyecto"
              initial=""
              onCancel={() => setCreatingProject(false)}
              onSubmit={(name) => {
                setCreatingProject(false);
                onUpdate(api.createProject(name));
              }}
            />
          ) : (
            <div className="exp-foot-row">
              <button type="button" className="btn sm ghost grow" onClick={() => setCreatingProject(true)}>
                <Icon name="plus" size={12} /> Nuevo proyecto
              </button>
            </div>
          )}

          {showArchived && (
            <div className="exp-archived-list" id="explorer-archived">
              {archivedProjects.length === 0 ? (
                <p className="exp-archived-empty">Sin proyectos archivados.</p>
              ) : (
                archivedProjects.map((p) => (
                  <div key={p.path} className="exp-archived-row">
                    <span className="grow">{p.name}</span>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => onUpdate(api.setArchived(p.path, false))}
                    >
                      Restaurar
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          <button
            type="button"
            className="btn sm ghost"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            aria-controls={showArchived ? 'explorer-archived' : undefined}
          >
            <Icon name="box" size={12} />
            <span className="grow">Archivados</span>
            <span className="exp-count">{archivedProjects.length}</span>
          </button>

          {footer}
        </div>
      </div>
    </aside>
  );
}

function ProjectNode({
  p,
  ws,
  selection,
  isActiveProject,
  expanded,
  hasPm,
  pmEngine,
  pmSessionId,
  sessions,
  agents,
  menuOpen,
  onToggleExpand,
  onMenu,
  onSelectProject,
  onSelectSession,
  onNewSession,
  onStartPm,
  onHidePm,
  onCloseSession,
  onUpdate,
  onError,
  onView,
  onTerminal,
}: {
  p: Project;
  ws: Workspace;
  selection: ActiveSelection;
  isActiveProject: boolean;
  expanded: boolean;
  hasPm: boolean;
  pmEngine: string;
  pmSessionId: number | null;
  sessions: Session[];
  agents: Agent[];
  menuOpen: boolean;
  onToggleExpand: () => void;
  onMenu: (open: boolean) => void;
  onSelectProject: () => void;
  onSelectSession: (next: Exclude<ActiveSelection, null>) => void;
  onNewSession: () => void;
  onStartPm: () => void;
  onHidePm: () => void;
  onCloseSession: (id: number) => void;
  onUpdate: (p: Promise<Workspace>) => void;
  onError: (message: string) => void;
  onView: (tab: 'files' | 'git' | 'containers') => void;
  onTerminal: () => void;
}) {
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menuOpen || !el) return;
    el.style.left = `${Math.max(8, Math.min(point.x, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(point.y, window.innerHeight - el.offsetHeight - 8))}px`;
    el.querySelector('button')?.focus({ preventScroll: true });
  }, [menuOpen, point]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!rowRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) onMenu(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onMenu(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menuOpen, onMenu]);

  const openMenu = (x: number, y: number, from: HTMLElement | null) => {
    setCreatingGroup(false);
    setPoint({ x, y });
    triggerRef.current = from;
    onMenu(true);
  };

  const run = (action: () => void) => {
    onMenu(false);
    action();
  };

  const act = (promise: Promise<Workspace>) => {
    onMenu(false);
    setCreatingGroup(false);
    onUpdate(promise);
  };

  const pmAgent = agents.find((a) => a.id === 'pm') ?? null;
  const waitingAgent = agents.find((a) => a.state === 'waiting') ?? null;
  const workingAgent = agents.find((a) => a.state === 'working' || a.state === 'thinking') ?? null;
  const leadLive = waitingAgent ?? workingAgent;

  const roots = sessions.filter((s) => s.parentSession == null);
  const childrenByParent = new Map<number, Session[]>();
  const orphanChildren: Session[] = [];
  for (const s of sessions) {
    if (s.parentSession == null) continue;
    const knownParent = s.parentSession === pmSessionId || roots.some((r) => r.id === s.parentSession);
    if (!knownParent) {
      orphanChildren.push(s);
      continue;
    }
    const kids = childrenByParent.get(s.parentSession) ?? [];
    kids.push(s);
    childrenByParent.set(s.parentSession, kids);
  }

  const isPmSelected = selection?.kind === 'pm' && selection.project === p.path;

  const renderSubitem = (s: Session) => {
    const a = agents.find((x) => x.session === s.id);
    if (!a) return null;
    const active = selection?.kind === 'session' && selection.sessionId === s.id && selection.project === p.path;
    const title = s.title?.trim() || compactTask(s.task) || s.name;
    const statusText = a.state === 'working' ? 'trabajando' : a.state === 'waiting' ? 'permiso' : a.state === 'done' ? 'terminada' : 'en espera';
    const meta = `${engineShort(s.engine)} · ${statusText}`;
    return (
      <div key={s.id} className="thread-wrap is-sub" role="treeitem" aria-selected={active}>
        <button
          type="button"
          className={`thread thread-sub${active ? ' on' : ''}`}
          aria-current={active || undefined}
          onClick={() => onSelectSession({ kind: 'session', sessionId: s.id, project: p.path })}
          title={`${p.name} · ${title} (${meta})`}
        >
          <AgDot a={a} s={11} />
          <span className="tx">
            <span className="t1">{title}</span>
            <span className="t2">{meta}</span>
          </span>
          {a.state === 'waiting' && <span className="chip amber tiny">permiso</span>}
        </button>
        <button
          type="button"
          className="thread-x"
          aria-label={`Cerrar ${title}`}
          title="Cerrar subsesión"
          onClick={() => onCloseSession(s.id)}
        >
          <Icon name="close" size={10} />
        </button>
      </div>
    );
  };

  const renderChildren = (parentId: number | null | undefined) => {
    if (parentId == null) return null;
    const kids = childrenByParent.get(parentId);
    if (!kids?.length) return null;
    return <div className="subthreads" role="group" aria-label="Subsesiones">{kids.map(renderSubitem)}</div>;
  };

  const renderSession = (s: Session) => {
    const a = agents.find((x) => x.session === s.id);
    if (!a) return null;
    const active = selection?.kind === 'session' && selection.sessionId === s.id && selection.project === p.path;
    const label = s.title?.trim() || s.name;
    const eng = engineShort(s.engine);
    const detail = a.state === 'working'
      ? 'trabajando'
      : a.state === 'waiting'
        ? 'espera permiso'
        : a.state === 'paused'
          ? 'en pausa'
          : a.state === 'done'
            ? 'terminada'
            : compactTask(s.task) ?? s.branch ?? null;
    const meta = detail ? `${eng} · ${detail}` : eng;
    return (
      <div key={s.id} className="thread-branch" role="treeitem" aria-selected={active}>
        <div className="thread-wrap">
          <button
            type="button"
            className={`thread exp-sess${active ? ' on' : ''}`}
            aria-current={active || undefined}
            onClick={() => onSelectSession({ kind: 'session', sessionId: s.id, project: p.path })}
            title={`${p.name} · ${label} (${meta})`}
          >
            <AgDot a={a} s={12} />
            <span className="tx">
              <span className="t1">{label}</span>
              <span className="t2">{meta}</span>
            </span>
            {a.state === 'waiting' && <span className="chip amber tiny">permiso</span>}
          </button>
          <button
            type="button"
            className="thread-x"
            aria-label={`Cerrar sesión ${label}`}
            title="Cerrar sesión"
            onClick={() => onCloseSession(s.id)}
          >
            <Icon name="close" size={10} />
          </button>
        </div>
        {renderChildren(s.id)}
      </div>
    );
  };

  return (
    <div ref={rowRef} className={`exp-proj${isActiveProject ? ' is-active' : ''}`} role="treeitem" aria-expanded={expanded}>
      <div
        className={`exp-proj-row${isActiveProject ? ' is-current' : ''}`}
        onContextMenu={(e) => {
          e.preventDefault();
          const bounds = e.currentTarget.getBoundingClientRect();
          openMenu(e.clientX || bounds.left, e.clientY || bounds.bottom, e.currentTarget.querySelector<HTMLButtonElement>('.exp-proj-main'));
        }}
      >
        <button
          type="button"
          className={`exp-chev${expanded ? ' is-open' : ''}`}
          onClick={onToggleExpand}
          aria-label={`${expanded ? 'Plegar' : 'Desplegar'} ${p.name}`}
          aria-expanded={expanded}
        >
          <Icon name="chev" size={10} />
        </button>

        <button
          type="button"
          className="exp-proj-main"
          onClick={onSelectProject}
          aria-current={isActiveProject ? 'true' : undefined}
          title={p.path}
        >
          <span className="exp-sig"><Sigil name={p.name} /></span>
          <span className="exp-proj-name">{p.name}</span>
          {!expanded && leadLive && <AgDot a={leadLive} s={9} />}
          {!expanded && !leadLive && sessions.length > 0 && (
            <span className="exp-proj-count" aria-label={`${sessions.length} sesiones`}>{sessions.length}</span>
          )}
        </button>

        <span className="exp-proj-actions">
          <button
            type="button"
            className="exp-mini-btn"
            onClick={onNewSession}
            aria-label={`Nueva sesión en ${p.name}`}
            title={`Nueva sesión en ${p.name}`}
          >
            <Icon name="plus" size={11} />
          </button>
          <button
            type="button"
            className="exp-mini-btn"
            onClick={(e) => {
              if (menuOpen) return onMenu(false);
              const bounds = e.currentTarget.getBoundingClientRect();
              openMenu(bounds.left, bounds.bottom + 4, e.currentTarget);
            }}
            aria-label={`Opciones de ${p.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={`Opciones de ${p.name}`}
          >
            ⋯
          </button>
        </span>
      </div>

      {expanded && (
        <div className="exp-children" role="group" aria-label={`Sesiones de ${p.name}`}>
          {hasPm && pmAgent ? (
            <div className="thread-branch" role="treeitem" aria-selected={isPmSelected}>
              <div className="thread-wrap">
                <button
                  type="button"
                  className={`thread exp-sess${isPmSelected ? ' on' : ''}`}
                  aria-current={isPmSelected || undefined}
                  onClick={() => onSelectSession({ kind: 'pm', project: p.path })}
                  title={`${p.name} · Project manager (${pmEngine})`}
                >
                  <AgDot a={pmAgent} s={12} />
                  <span className="tx">
                    <span className="t1">Project manager</span>
                    <span className="t2">{pmAgent.state === 'idle' ? pmEngine : `${pmEngine} · ${pmAgent.did}`}</span>
                  </span>
                  {pmAgent.state === 'waiting' && <span className="chip amber tiny">permiso</span>}
                </button>
                <button
                  type="button"
                  className="thread-x"
                  aria-label={`Ocultar Project manager de ${p.name}`}
                  title="Ocultar Project manager"
                  onClick={onHidePm}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
              {renderChildren(pmSessionId)}
            </div>
          ) : (
            <button
              type="button"
              className={`thread exp-sess ghost-thread${isPmSelected ? ' on' : ''}`}
              aria-current={isPmSelected || undefined}
              onClick={onStartPm}
              title={`Empezar Project manager en ${p.name}`}
            >
              <span className="eng"><Icon name="agent" size={11} /></span>
              <span className="tx">
                <span className="t1">Project manager</span>
                <span className="t2">Coordinar {p.name}</span>
              </span>
            </button>
          )}

          {roots.map(renderSession)}
          {orphanChildren.map(renderSubitem)}
        </div>
      )}

      {menuOpen && createPortal(
        <div
          ref={menuRef}
          className="menu project-context exp-context"
          role="menu"
          aria-label={`Opciones de ${p.name}`}
          onKeyDown={(e) => {
            if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.target instanceof HTMLInputElement) return;
            e.preventDefault();
            const items = [...e.currentTarget.querySelectorAll('button')];
            const next = items.indexOf(document.activeElement as HTMLButtonElement) + (e.key === 'ArrowDown' ? 1 : -1);
            items[(next + items.length) % items.length]?.focus();
          }}
        >
          <button role="menuitem" className="menu-item" onClick={() => run(onSelectProject)}>Abrir proyecto</button>
          <button role="menuitem" className="menu-item" onClick={() => run(onNewSession)}>Nueva sesión</button>
          <button role="menuitem" className="menu-item" onClick={() => run(onStartPm)}>Abrir Project manager</button>
          <div className="menu-sep" />
          <button role="menuitem" className="menu-item" onClick={() => run(() => onView('files'))}>Ver archivos</button>
          <button role="menuitem" className="menu-item" onClick={() => run(() => onView('git'))}>Ver cambios</button>
          <button role="menuitem" className="menu-item" onClick={() => run(() => onView('containers'))}>Ver contenedores</button>
          <button role="menuitem" className="menu-item" onClick={() => run(onTerminal)}>Abrir terminal aquí</button>
          <button role="menuitem" className="menu-item" onClick={() => run(() => void api.revealProject(p.path).catch((e) => onError(String(e))))}>Mostrar carpeta</button>
          <button role="menuitem" className="menu-item" onClick={() => run(() => {
            if (!navigator.clipboard) return onError('Portapapeles no disponible.');
            void navigator.clipboard.writeText(p.path).catch((e) => onError(String(e)));
          })}>Copiar ruta</button>
          <div className="menu-sep" />
          <div className="menu-label">mover a</div>
          {ws.groups.map((g) => (
            <button key={g.id} role="menuitemradio" aria-checked={p.groupId === g.id} className="menu-item" onClick={() => act(api.moveProject(p.path, g.id))}>
              <span className="mark">{p.groupId === g.id ? '●' : ''}</span>
              {g.name}
            </button>
          ))}
          <button role="menuitemradio" aria-checked={p.groupId === null} className="menu-item" onClick={() => act(api.moveProject(p.path, null))}>
            <span className="mark">{p.groupId === null ? '●' : ''}</span>
            Sin clasificar
          </button>
          {creatingGroup ? (
            <InlineInput
              label="Nuevo grupo"
              initial=""
              onCancel={() => setCreatingGroup(false)}
              onSubmit={(name) =>
                act(
                  api.createGroup(name).then((next) => {
                    const g = next.groups.find((x) => x.name === name.trim());
                    return g ? api.moveProject(p.path, g.id) : next;
                  }),
                )
              }
            />
          ) : (
            <button role="menuitem" className="menu-item" onClick={() => setCreatingGroup(true)}>
              <span className="mark">+</span>Nuevo grupo
            </button>
          )}
          <div className="menu-sep" />
          <button role="menuitem" className="menu-item" onClick={() => act(api.setArchived(p.path, true))}>
            <span className="mark" />
            Archivar
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

function InlineInput({ initial, label, placeholder, onSubmit, onCancel }: {
  initial: string;
  label: string;
  placeholder?: string;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="inline-input"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <input
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      />
    </form>
  );
}
