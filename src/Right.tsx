import type { ReactNode } from 'react';
import Splitter, { SIZES } from './Splitter';
import { Icon } from './GitPanel';
import { shortcut } from './ui';

export const RIGHT_PANELS = {
  git: { title: 'Cambios', icon: 'changes', keys: '⌘G' },
  files: { title: 'Archivos', icon: 'folder', keys: '⌘P' },
  browser: { title: 'Navegador', icon: 'globe' },
  containers: { title: 'Contenedores', icon: 'box', keys: '⌘⇧O' },
  design: { title: 'Design Loop', icon: 'design' },
  brain: { title: 'Filigranas Brain', icon: 'brain' },
  'brain-graph': { title: 'Filigranas Brain', icon: 'graph' },
  conflicts: { title: 'Conflictos', icon: 'warn' },
  editor: { title: 'Editor', icon: 'file', keys: '⌘E' },
} satisfies Record<string, { title: string; icon: string; keys?: string }>;

export type RightTab = keyof typeof RIGHT_PANELS;

export const WIDE_RIGHT_PANELS = new Set<RightTab>(['editor', 'browser', 'containers', 'design', 'brain', 'brain-graph', 'conflicts']);

type Props = {
  tab: RightTab;
  hidden: boolean;
  onEditor: () => void;
  editor: { name: string; path: string; diff: boolean } | null;
  onCloseEditor: () => void;
  /** Carpeta de repositorios elegida al abrir Filigranas y ruta que muestra el panel. */
  root?: string | null;
  location?: string | null;
  children: ReactNode;
};

// Paneles que trabajan sobre una carpeta: su cabecera es la ruta, no un título.
const PATH_PANELS = new Set<RightTab>(['git', 'files', 'containers', 'conflicts', 'editor']);

/** Ruta desde la carpeta de repositorios: «repositorios/grupo/proyecto/src/a.ts». */
export function fromRoot(root: string, path: string) {
  const norm = (v: string) => v.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root), p = norm(path);
  const base = r.split('/').pop() || r;
  if (p === r) return base;
  return p.startsWith(r + '/') ? `${base}/${p.slice(r.length + 1)}` : p;
}

function Crumb({ path }: { path: string }) {
  const cut = path.lastIndexOf('/');
  return (
    <span className="panel-crumb">
      {cut > 0 && <span className="dir"><bdi>{path.slice(0, cut + 1)}</bdi></span>}
      <span className="leaf">{path.slice(cut + 1)}</span>
    </span>
  );
}

export default function Right({ tab, hidden, onEditor, editor, onCloseEditor, root, location, children }: Props) {
  const panel = RIGHT_PANELS[tab];
  const editing = tab === 'editor' && editor;
  const crumb = root && location && PATH_PANELS.has(tab) ? fromRoot(root, location) : null;

  return (
    <aside id="workspace-right-panel" className="panel right"
      aria-labelledby={tab === 'design' ? undefined : 'right-panel-title'}
      aria-label={tab === 'design' ? panel.title : undefined} hidden={hidden}>
      <Splitter size={tab === 'design' ? SIZES.design : SIZES.git} axis="x" invert measureParent={tab === 'design'}
        label="Ancho del panel derecho" className="is-right" />
      {tab !== 'design' && <header className="panel-head">
        <Icon name={panel.icon} size={15} />
        {crumb ? (
          <h2 id="right-panel-title" className="is-path" title={`${panel.title} · ${location}`} aria-label={`${editing ? editor.name : panel.title} · ${crumb}`}><Crumb path={crumb} /></h2>
        ) : (
          <h2 id="right-panel-title" title={editing ? editor.path : undefined}>{editing ? editor.name : panel.title}</h2>
        )}
        {editing && editor.diff && <span className="right-panel-kind">diff</span>}
        <span className="grow" />
        {editor && !editing && (
          <button className="tb-btn" onClick={onEditor} aria-label={`Volver a ${editor.name}`} title={editor.path}>
            <Icon name="file" size={14} />
          </button>
        )}
        {editing && (
          <button className="tb-btn" onClick={onCloseEditor} aria-label={`Cerrar ${editor.name}`} title={shortcut('cerrar archivo · ⌘W')}>
            <Icon name="close" size={12} />
          </button>
        )}
      </header>}
      <div className={`panel-body is-${tab}`}>
        {children}
      </div>
    </aside>
  );
}
