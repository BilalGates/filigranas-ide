import type { ReactNode } from 'react';
import Splitter, { SIZES } from './Splitter';
import { Icon } from './GitPanel';

export type RightTab = 'git' | 'files' | 'containers' | 'uso' | 'editor';

export const RIGHT_TABS: [Exclude<RightTab, 'editor'>, string, string, string][] = [
  ['git', 'Cambios', 'changes', '⌘G'],
  ['files', 'Archivos', 'file', '⌘P'],
  ['containers', 'Contenedores', 'box', '⌘⇧O'],
  ['uso', 'Uso', 'gauge', '⌘U'],
];

type Props = {
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  dirty: boolean;
  containers: number | null;
  /** Archivo o diff abierto: aparece como una pestaña más, con su cierre. */
  editor: { name: string; path: string; diff: boolean } | null;
  onCloseEditor: () => void;
  children: ReactNode;
};

/** Panel derecho: cambios, archivos, contenedores, uso y el editor. */
export default function Right({ tab, onTab, dirty, containers, editor, onCloseEditor, children }: Props) {
  return (
    <aside className={`panel right${tab === 'editor' ? ' is-editor' : ''}`} aria-label="Panel del proyecto">
      <Splitter size={SIZES.git} axis="x" invert label="Ancho del panel derecho" className="is-right" />
      <div className="panel-head" role="tablist" aria-label="Paneles">
        {RIGHT_TABS.map(([id, label, , keys]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`ptab${tab === id ? ' is-on' : ''}`} onClick={() => onTab(id)} title={`${label.toLowerCase()} · ${keys}`}>
            {label}
            {id === 'git' && dirty && <span className="dot is-dirty" aria-label="cambios sin commit" />}
            {id === 'containers' && containers != null && containers > 0 && <span className="ptab-n">{containers}</span>}
          </button>
        ))}
        {editor && (
          <div className={`ptab is-file${tab === 'editor' ? ' is-on' : ''}`} role="tab" aria-selected={tab === 'editor'}>
            <button onClick={() => onTab('editor')} title={editor.path}>
              <Icon name="file" size={12} />
              <span className="ptab-name">{editor.name}</span>
              {editor.diff && <span className="ptab-n">diff</span>}
            </button>
            <button className="ptab-x" aria-label={`Cerrar ${editor.name}`} title="cerrar · ⌘W" onClick={onCloseEditor}>
              <Icon name="close" size={9} />
            </button>
          </div>
        )}
      </div>
      <div className={`panel-body is-${tab}`} key={tab}>
        {children}
      </div>
    </aside>
  );
}
