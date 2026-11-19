import { useEffect, useRef, useState } from 'react';
import { api, type Project, type Workspace } from './ipc';
import type { ReactNode } from 'react';
import { Icon } from './GitPanel';

type Props = {
  ws: Workspace;
  project: string | null;
  onProject: (path: string | null) => void;
  onUpdate: (p: Promise<Workspace>) => void;
  onNewSession: () => void;
  /** Sesiones del proyecto abierto, bajo su nombre. */
  sessions: ReactNode;
  /** Uso y estado, al pie. */
  footer: ReactNode;
};

const COLLAPSED_KEY = 'filigranas.collapsed';

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export default function Sidebar({ ws, project, onProject, onUpdate, onNewSession, sessions, footer }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
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
      <button className="side-new" onClick={onNewSession} disabled={!project} title="nueva sesión de agente · ⌘T">
        <Icon name="plus" size={14} />
        <span className="grow">Nueva sesión</span>
        <kbd>⌘</kbd>
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
                >
                  {p.path === project && expanded.has(p.path) && sessions}
                </ProjectRow>
              ))}
          </section>
        ))}
      </div>

      <div className="sidebar-foot">
        {footer}
        {archived.length > 0 && (
          <>
            <button className="group-name" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
              archivados · {archived.length}
            </button>
            {showArchived &&
              archived.map((p) => (
                <div key={p.path} className="row archived">
                  <span className="grow">{p.name}</span>
                  <button className="ghost small" onClick={() => onUpdate(api.setArchived(p.path, false))}>
                    restaurar
                  </button>
                </div>
              ))}
          </>
        )}
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
  children?: React.ReactNode;
}) {
  const { p, ws, open, expanded, onExpand, menuOpen, onMenu, onSelect, onUpdate, children } = props;
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onMenu(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menuOpen, onMenu]);

  const act = (promise: Promise<Workspace>) => {
    onMenu(false);
    setCreating(false);
    onUpdate(promise);
  };

  return (
    <div ref={ref} className="project">
      <div className={`row project-row${open ? ' is-open' : ''}${expanded ? ' is-expanded' : ''}`}>
        <button className={`ex${expanded && open ? ' is-open' : ''}`} onClick={open ? onExpand : onSelect} aria-label={`${expanded && open ? 'Plegar' : 'Desplegar'} ${p.name}`} aria-expanded={expanded && open}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M3.5 2 6.5 5 3.5 8" />
          </svg>
        </button>
        <button className="row-main" onClick={onSelect} aria-current={open ? 'true' : undefined}>
          <Icon name="folder" size={14} />
          <span className="grow">{p.name}</span>
        </button>
        <button className="icon more" onClick={() => onMenu(!menuOpen)} aria-label={`Opciones de ${p.name}`} aria-haspopup="menu" aria-expanded={menuOpen}>
          ⋯
        </button>
      </div>
      {menuOpen && (
        <div className="menu" role="menu">
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
        </div>
      )}
      {children}
    </div>
  );
}

function InlineInput({ initial, label, onSubmit, onCancel }: { initial: string; label: string; onSubmit: (v: string) => void; onCancel: () => void }) {
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
