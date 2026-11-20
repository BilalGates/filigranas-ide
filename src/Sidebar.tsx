import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type Project, type Workspace } from './ipc';
import type { ReactNode } from 'react';
import { Icon } from './GitPanel';
import { shortcut } from './ui';

type Props = {
  ws: Workspace;
  project: string | null;
  onProject: (path: string | null) => void;
  onUpdate: (p: Promise<Workspace>) => void;
  onNewSession: () => void;
  onJoin: () => void;
  onShare: (project: Project) => void;
  onProjectManager: (path: string) => void;
  onProjectView: (path: string, tab: 'files' | 'git' | 'containers' | 'work') => void;
  onProjectTerminal: (path: string) => void;
  onError: (message: string) => void;
  /** Sesiones del proyecto abierto, bajo su nombre. */
  sessions: ReactNode;
  status: ReactNode;
};

const COLLAPSED_KEY = 'filigranas.collapsed';

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export default function Sidebar({ ws, project, onProject, onUpdate, onNewSession, onJoin, onShare, onProjectManager, onProjectView, onProjectTerminal, onError, sessions, status }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [newProject, setNewProject] = useState(false);
  // Proyectos desplegados: abrir un proyecto lo despliega; el chevrón pliega.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(project ? [project] : []));
  const expand = (path: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch {
      /* sin almacenamiento: no pasa nada */
    }
  }, [collapsed]);

  const q = query.trim().toLowerCase();
  const visible = ws.projects.filter((p) => !p.archived && (!q || p.name.toLowerCase().includes(q)));
  const archived = ws.projects.filter((p) => p.archived);

  const sections = [
    ...ws.groups.map((g) => ({ key: `g${g.id}`, id: g.id as number | null, name: g.name })),
    { key: 'none', id: null, name: 'sin clasificar' },
  ]
    .map((s) => ({ ...s, items: visible.filter((p) => p.groupId === s.id) }))
    .filter((s) => s.items.length > 0 || (s.id !== null && !q));

  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  return (
    <aside className="sidebar" aria-label="Proyectos">
      <button className="side-new" onClick={onNewSession} disabled={!project} title={shortcut('nueva sesión de agente · ⌘T')}>
        <Icon name="plus" size={14} />
        <span className="grow">Nueva sesión</span>
        <kbd>{shortcut('⌘').replace('+', '')}</kbd>
        <kbd>T</kbd>
      </button>
      <div className="side-head">
        <span className="grow">Proyectos</span>
        <label className="search">
          <Icon name="search" size={12} />
          <input aria-label="Buscar proyecto" placeholder="buscar" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        </label>
      </div>

      <div className="sidebar-scroll">
        {sections.map((s) => (
          <section key={s.key} className="group">
            <div className="group-head">
              {renaming === s.id && s.id !== null ? (
                <InlineInput
                  initial={s.name}
                  label="Nombre del grupo"
                  onCancel={() => setRenaming(null)}
                  onSubmit={(name) => {
                    setRenaming(null);
                    onUpdate(api.renameGroup(s.id!, name));
                  }}
                />
              ) : (
                <button className="group-name" onClick={() => toggle(s.key)} onDoubleClick={() => s.id !== null && setRenaming(s.id)} aria-expanded={!collapsed[s.key]}>
                  {s.name}
                </button>
              )}
              {s.id !== null && renaming !== s.id && (
                <span className="group-actions">
                  <button className="icon" onClick={() => setRenaming(s.id)} aria-label={`Renombrar ${s.name}`} title="renombrar">
                    ✎
                  </button>
                  <button className="icon" onClick={() => onUpdate(api.deleteGroup(s.id!))} aria-label={`Quitar grupo ${s.name}`} title="quitar grupo (los proyectos pasan a sin clasificar)">
                    ×
                  </button>
                </span>
              )}
            </div>
            {!collapsed[s.key] &&
              s.items.map((p) => (
                <ProjectRow
                  key={p.path}
                  p={p}
                  ws={ws}
                  open={p.path === project}
                  expanded={expanded.has(p.path)}
                  onExpand={() => expand(p.path)}
                  menuOpen={menu === p.path}
                  onMenu={(open) => setMenu(open ? p.path : null)}
                  onSelect={() => {
                    if (p.path !== project) onProject(p.path);
                    setExpanded((cur) => new Set(cur).add(p.path));
                  }}
                  onUpdate={onUpdate}
                  onError={onError}
                  onView={(tab) => {
                    if (tab === 'work') setExpanded((cur) => new Set(cur).add(p.path));
                    onProjectView(p.path, tab);
                  }}
                  onTerminal={() => onProjectTerminal(p.path)}
                  onShare={() => onShare(p)}
                  onManager={() => {
                    setExpanded((cur) => new Set(cur).add(p.path));
                    onProjectManager(p.path);
                  }}
                >
                  {p.path === project && expanded.has(p.path) && sessions}
                </ProjectRow>
              ))}
          </section>
        ))}
        <div className="side-create-project">
          {newProject ? (
            <InlineInput
              label="Nombre del proyecto nuevo"
              placeholder="Nombre del proyecto"
              initial=""
              onCancel={() => setNewProject(false)}
              onSubmit={(name) => {
                setNewProject(false);
                onUpdate(api.createProject(name));
              }}
            />
          ) : (
            <div className="side-project-actions">
              <button onClick={() => setNewProject(true)}>
                <Icon name="plus" size={14} />
                <span>Nuevo proyecto</span>
              </button>
              <button onClick={onJoin} aria-label="Unirse a un proyecto" title="Unirse a un proyecto">
                Unirse
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="sidebar-foot">
        {status}
        {showArchived && (
          <div className="archive-list" id="archived-projects">
            {archived.length === 0 && <p className="muted">No hay proyectos archivados.</p>}
            {archived.map((p) => (
                <div key={p.path} className="row archived">
                  <span className="grow">{p.name}</span>
                  <button className="ghost small" onClick={() => onUpdate(api.setArchived(p.path, false))}>
                    restaurar
                  </button>
                </div>
            ))}
          </div>
        )}
        <button className="side-usage" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived} aria-controls={showArchived ? 'archived-projects' : undefined}>
          <Icon name="box" size={13} />
          <span className="grow">Archivados</span>
          <span>{archived.length}</span>
        </button>
      </div>
    </aside>
  );
}


function ProjectRow(props: {
  p: Project;
  ws: Workspace;
  open: boolean;
  expanded: boolean;
  onExpand: () => void;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onSelect: () => void;
  onUpdate: (p: Promise<Workspace>) => void;
  onError: (message: string) => void;
  onView: (tab: 'files' | 'git' | 'containers' | 'work') => void;
  onTerminal: () => void;
  onShare: () => void;
  onManager: () => void;
  children?: React.ReactNode;
}) {
  const { p, ws, open, expanded, onExpand, menuOpen, onMenu, onSelect, onUpdate, onError, onView, onTerminal, onShare, onManager, children } = props;
  const [creating, setCreating] = useState(false);
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);

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
      if (!ref.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) onMenu(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onMenu(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menuOpen, onMenu]);

  const openMenu = (x: number, y: number, from: HTMLElement) => {
    setCreating(false);
    setPoint({ x, y });
    trigger.current = from;
    onMenu(true);
  };
  const run = (action: () => void) => {
    onMenu(false);
    action();
  };
  const act = (promise: Promise<Workspace>) => {
    onMenu(false);
    setCreating(false);
    onUpdate(promise);
  };

  return (
    <div ref={ref} className="project">
      <div className={`row project-row${open ? ' is-open' : ''}${expanded ? ' is-expanded' : ''}`}
        onContextMenu={(e) => {
          e.preventDefault();
          const bounds = e.currentTarget.getBoundingClientRect();
          openMenu(e.clientX || bounds.left, e.clientY || bounds.bottom, e.currentTarget.querySelector<HTMLButtonElement>('.row-main')!);
        }}>
        <button className={`ex${expanded && open ? ' is-open' : ''}`} onClick={open ? onExpand : onSelect} aria-label={`${expanded && open ? 'Plegar' : 'Desplegar'} ${p.name}`} aria-expanded={expanded && open}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M3.5 2 6.5 5 3.5 8" />
          </svg>
        </button>
        <button className="row-main" onClick={onSelect} aria-current={open ? 'true' : undefined}>
          <Icon name="folder" size={14} />
          <span className="grow">{p.name}</span>
        </button>
        <button className="icon more" onClick={(e) => {
          if (menuOpen) return onMenu(false);
          const bounds = e.currentTarget.getBoundingClientRect();
          openMenu(bounds.left, bounds.bottom, e.currentTarget);
        }} aria-label={`Opciones de ${p.name}`} aria-haspopup="menu" aria-expanded={menuOpen}>
          ⋯
        </button>
      </div>
      {menuOpen && createPortal(
        <div ref={menuRef} className="menu project-context" role="menu" aria-label={`Opciones de ${p.name}`}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' || e.target instanceof HTMLInputElement) return;
            e.preventDefault();
            const items = [...e.currentTarget.querySelectorAll('button')];
            const next = items.indexOf(document.activeElement as HTMLButtonElement) + (e.key === 'ArrowDown' ? 1 : -1);
            items[(next + items.length) % items.length]?.focus();
          }}>
          <button role="menuitem" className="menu-item" onClick={() => run(onSelect)}>Abrir proyecto</button>
          <button role="menuitem" className="menu-item" onClick={() => run(onShare)}>Compartir proyecto</button>
          <button role="menuitem" className="menu-item" onClick={() => run(onManager)}>Abrir Project manager</button>
          <button role="menuitem" className="menu-item" onClick={() => run(() => onView('work'))}>Trabajo</button>
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
            sin clasificar
          </button>
          {creating ? (
            <InlineInput
              label="Nuevo grupo"
              initial=""
              onCancel={() => setCreating(false)}
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
            <button role="menuitem" className="menu-item" onClick={() => setCreating(true)}>
              <span className="mark">+</span>nuevo grupo
            </button>
          )}
          <div className="menu-sep" />
          <button role="menuitem" className="menu-item" onClick={() => act(api.setArchived(p.path, true))}>
            <span className="mark" />
            archivar
          </button>
        </div>, document.body
      )}
      {children}
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
