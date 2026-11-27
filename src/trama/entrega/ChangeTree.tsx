import { useMemo } from 'react';
import { Icon } from '../icons';
import { buildFileTree, type TreeFileItem, type TreeNode, type TreePerspective } from './entregaStore';

type Props = {
  perspective: TreePerspective;
  items: TreeFileItem[];
  localExtraItems?: TreeFileItem[];
  selectedFile: string | null;
  collapsedDirs: Record<string, boolean>;
  canStage: boolean;
  prNumber: number | null;
  baseLabel: string;
  onPerspective: (p: TreePerspective) => void;
  onSelectFile: (item: TreeFileItem) => void;
  onToggleDir: (dirPath: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onOpenEditor: (path: string) => void;
};

function collectPaths(node: TreeNode): string[] {
  if (node.kind === 'file') return [node.path];
  return node.children.flatMap(collectPaths);
}

export function ChangeTree({
  perspective,
  items,
  localExtraItems = [],
  selectedFile,
  collapsedDirs,
  canStage,
  prNumber,
  baseLabel,
  onPerspective,
  onSelectFile,
  onToggleDir,
  onStage,
  onUnstage,
  onOpenEditor,
}: Props) {
  const tree = useMemo(() => buildFileTree(items), [items]);
  const localTree = useMemo(() => buildFileTree(localExtraItems), [localExtraItems]);

  const totals = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const item of items) {
      adds += item.adds ?? 0;
      dels += item.dels ?? 0;
    }
    return { count: items.length, adds, dels };
  }, [items]);

  const renderNode = (node: TreeNode, depth: number, keyPrefix: string) => {
    if (node.kind === 'dir') {
      const collapsed = Boolean(collapsedDirs[`${keyPrefix}:${node.path}`]);
      return (
        <div key={`${keyPrefix}:d:${node.path}`}>
          <div
            className="ent-trow ent-tdir"
            style={{ paddingLeft: 10 + depth * 12 }}
            onClick={() => onToggleDir(`${keyPrefix}:${node.path}`)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggleDir(`${keyPrefix}:${node.path}`);
              }
            }}
          >
            <Icon name={collapsed ? 'chev' : 'down'} size={11} />
            <Icon name="folder" size={12} />
            <span className="ent-tname mono">{node.name}</span>
            <span className="ent-tmeta mono">{node.filesCount}</span>
            {canStage && perspective === 'uncommitted' && (
              <button
                className="ent-tact"
                onClick={(e) => {
                  e.stopPropagation();
                  onStage(collectPaths(node));
                }}
                title={`Preparar todos los archivos en ${node.path}`}
              >
                +
              </button>
            )}
          </div>
          {!collapsed && node.children.map((ch) => renderNode(ch, depth + 1, keyPrefix))}
        </div>
      );
    }

    const f = node.file;
    const isSel = selectedFile === f.path;
    const hasStaged = Boolean(f.staged);
    const hasUnstaged = Boolean(f.unstaged);

    return (
      <div
        key={`${keyPrefix}:f:${f.path}`}
        className={`ent-trow ent-tfile${isSel ? ' on' : ''}`}
        style={{ paddingLeft: 16 + depth * 12 }}
        onClick={() => onSelectFile(f)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectFile(f);
          }
        }}
        title={f.orig ? `${f.orig} → ${f.path}` : f.path}
      >
        <span className={`ent-st ent-st-${f.status.toLowerCase()}`}>{f.status === 'U' ? '?' : f.status}</span>
        <span className="ent-tname mono">{node.name}</span>
        {perspective === 'uncommitted' && (
          <span className="ent-su">
            {hasStaged && <i className="ent-su-s" title={`Preparado (${f.staged})`}>S</i>}
            {hasUnstaged && <i className="ent-su-u" title={`Sin preparar (${f.unstaged})`}>U</i>}
          </span>
        )}
        <span className="ent-tcounts mono">
          {f.adds != null && f.adds > 0 && <span className="add">+{f.adds}</span>}
          {f.dels != null && f.dels > 0 && <span className="del">-{f.dels}</span>}
        </span>
        <span className="ent-tacts">
          {canStage && perspective === 'uncommitted' && hasUnstaged && (
            <button
              className="ent-tact"
              onClick={(e) => {
                e.stopPropagation();
                onStage([f.path]);
              }}
              title="Preparar archivo (git add)"
            >
              +
            </button>
          )}
          {canStage && perspective === 'uncommitted' && hasStaged && (
            <button
              className="ent-tact"
              onClick={(e) => {
                e.stopPropagation();
                onUnstage([f.path]);
              }}
              title="Sacar de preparación (git reset)"
            >
              −
            </button>
          )}
          {perspective === 'uncommitted' && (
            <button
              className="ent-tact"
              onClick={(e) => {
                e.stopPropagation();
                onOpenEditor(f.path);
              }}
              title="Abrir en editor"
            >
              <Icon name="code" size={11} />
            </button>
          )}
        </span>
      </div>
    );
  };

  return (
    <section className="ent-block ent-tree" aria-label="Árbol permanente de cambios">
      <div className="ent-sec-head">
        <Icon name="changes" size={13} />
        <span>Cambios</span>
        <span className="ent-count mono">
          {totals.count}
          {totals.adds > 0 ? ` +${totals.adds}` : ''}
          {totals.dels > 0 ? ` -${totals.dels}` : ''}
        </span>
      </div>

      <div className="ent-persp">
        <div className="tr-seg ent-persp-seg" role="tablist" aria-label="Perspectiva del árbol de cambios">
          <button
            role="tab"
            aria-selected={perspective === 'uncommitted'}
            onClick={() => onPerspective('uncommitted')}
          >
            Sin commit
          </button>
          <button
            role="tab"
            aria-selected={perspective === 'branch'}
            onClick={() => onPerspective('branch')}
            title={`Cambios de la rama frente a ${baseLabel}`}
          >
            vs base
          </button>
          <button
            role="tab"
            aria-selected={perspective === 'pr'}
            onClick={() => onPerspective('pr')}
            disabled={prNumber == null}
            title={prNumber ? `Archivos de la PR #${prNumber}` : 'Esta rama no tiene Pull Request'}
          >
            PR{prNumber ? ` #${prNumber}` : ''}
          </button>
        </div>
      </div>

      <div className="ent-scroll">
        {tree.length > 0 ? (
          tree.map((n) => renderNode(n, 0, perspective))
        ) : (
          <p className="ent-empty-mini">
            {perspective === 'uncommitted'
              ? canStage
                ? 'Árbol de trabajo limpio.'
                : 'Cambia a esta rama o cambia a «vs base» para ver sus cambios.'
              : perspective === 'branch'
                ? `Sin diferencias respecto a ${baseLabel}.`
                : 'Sin archivos en la PR.'}
          </p>
        )}

        {perspective === 'pr' && localTree.length > 0 && (
          <div className="ent-local-sep">
            <div className="ent-bgroup-lbl">Cambios locales sin subir ({localExtraItems.length})</div>
            {localTree.map((n) => renderNode(n, 0, 'pr-local'))}
          </div>
        )}
      </div>
    </section>
  );
}
