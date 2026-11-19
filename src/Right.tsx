import type { ReactNode } from 'react';
import Splitter, { SIZES } from './Splitter';
import { Icon } from './GitPanel';

export type RightTab = 'git' | 'pr' | 'containers' | 'uso';

const TABS: [RightTab, string][] = [
  ['git', 'Git'],
  ['pr', 'Pull requests'],
  ['containers', 'Contenedores'],
  ['uso', 'Uso'],
];

export type EditorSlot = {
  name: string;
  path: string;
  diff: boolean;
  minimized: boolean;
  body: ReactNode;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
};

type Props = {
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  dirty: boolean;
  containers: number | null;
  editor: EditorSlot | null;
  children: ReactNode;
};

/**
 * Columna derecha: git, pull requests, contenedores y uso. El editor se abre
 * encima (la columna se ensancha) y al minimizarlo queda como lengüeta en el
 * borde derecho, con lo que vuelve a verse el panel de debajo.
 */
export default function Right({ tab, onTab, dirty, containers, editor, children }: Props) {
  const editing = !!editor && !editor.minimized;
  return (
    <aside className={`git right${editing ? ' is-editing' : ''}`} aria-label="Git, pull requests, contenedores y uso">
      <Splitter size={SIZES.git} axis="x" invert label="Ancho de la columna derecha" className="is-edge-left" />
      <div className="rh" role="tablist" aria-label="Paneles" data-tauri-drag-region>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`rh-tab${tab === id ? ' is-on' : ''}`}
            onClick={() => onTab(id)}
            title={id === 'git' ? 'git · ⌘G' : id === 'containers' ? 'contenedores · ⌘⇧O' : id === 'uso' ? 'uso · ⌘U' : 'pull requests'}
          >
            {label}
            {id === 'git' && dirty && <span className="rh-mark" aria-label="cambios sin commit" />}
            {id === 'containers' && containers != null && containers > 0 && <span className="rh-count">{containers}</span>}
          </button>
        ))}
      </div>
      {children}
      {editor && (
        <section className={`right-editor${editor.minimized ? ' is-min' : ''}`} aria-label="Editor" aria-hidden={editor.minimized}>
          <div className="re-head">
            <span className="re-name" title={editor.path}>
              {editor.name}
            </span>
            {editor.diff && <span className="re-tag">diff</span>}
            <span className="grow" />
            <button className="re-btn" onClick={editor.onMinimize} aria-label="Minimizar el editor" title="minimizar · ⌘E">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                <path d="M2.5 6h7" />
              </svg>
            </button>
            <button className="re-btn" onClick={editor.onClose} aria-label="Cerrar el editor" title="cerrar · ⌘W">
              <Icon name="close" size={11} />
            </button>
          </div>
          <div className="re-body">{editor.body}</div>
        </section>
      )}
      {editor?.minimized && (
        <button className="right-dock" onClick={editor.onRestore} title="volver al editor · ⌘E">
          {editor.name}
        </button>
      )}
    </aside>
  );
}

/** Pull requests: publicar la rama abierta y las ramas de sesiones sin integrar. */
export function PullRequests({ branch, pending, onPublish, onPending }: { branch: string | null; pending: number; onPublish: () => void; onPending: () => void }) {
  return (
    <>
      <div className="git-label">
        <span>esta rama</span>
      </div>
      <button className="pr-row" onClick={onPublish}>
        <span className="pr-title">Crear pull request</span>
        <span className="pr-meta">{branch ? `${branch} → main` : 'sin rama'}</span>
      </button>
      <div className="git-label">
        <span>ramas sin integrar</span>
        <span>{pending}</span>
      </div>
      {pending > 0 ? (
        <button className="pr-row" onClick={onPending}>
          <span className="pr-title">
            {pending} rama{pending === 1 ? '' : 's'} de sesiones cerradas
          </span>
          <span className="pr-meta">revisar, integrar o descartar</span>
        </button>
      ) : (
        <div className="muted pr-empty">ninguna</div>
      )}
    </>
  );
}
