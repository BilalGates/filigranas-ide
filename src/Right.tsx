import type { ReactNode } from 'react';
import Splitter, { SIZES } from './Splitter';
import { Icon } from './GitPanel';
import { shortcut } from './ui';

export const RIGHT_PANELS = {
  git: { title: 'Cambios', icon: 'changes', keys: '⌘G' },
  files: { title: 'Archivos', icon: 'folder', keys: '⌘P' },
  browser: { title: 'Navegador', icon: 'globe' },
  containers: { title: 'Contenedores', icon: 'box', keys: '⌘⇧O' },
  design: { title: 'Studio', icon: 'design' },
  conflicts: { title: 'Conflictos', icon: 'warn' },
  editor: { title: 'Editor', icon: 'file', keys: '⌘E' },
} satisfies Record<string, { title: string; icon: string; keys?: string }>;

export type RightTab = keyof typeof RIGHT_PANELS;

export const WIDE_RIGHT_PANELS = new Set<RightTab>(['editor', 'browser', 'containers', 'conflicts']);

type Props = {
  tab: RightTab;
  hidden: boolean;
  onEditor: () => void;
  editor: { name: string; path: string; diff: boolean } | null;
  onCloseEditor: () => void;
  children: ReactNode;
};

export default function Right({ tab, hidden, onEditor, editor, onCloseEditor, children }: Props) {
  const panel = RIGHT_PANELS[tab];
  const editing = tab === 'editor' && editor;

  return (
    <aside id="workspace-right-panel" className="panel right"
      aria-labelledby="right-panel-title" hidden={hidden}>
      <Splitter size={SIZES.git} axis="x" invert
        label="Ancho del panel derecho" className="is-right" />
      <header className="panel-head">
        <Icon name={panel.icon} size={15} />
        <h2 id="right-panel-title" title={editing ? editor.path : undefined}>{editing ? editor.name : panel.title}</h2>
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
      </header>
      <div className={`panel-body is-${tab}`}>
        {children}
      </div>
    </aside>
  );
}
