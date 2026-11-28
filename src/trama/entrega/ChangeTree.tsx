import { useMemo } from 'react';
import { Icon } from '../icons';
import { buildFileTree, type TreeFileItem, type TreeNode, type TreePerspective } from './entregaStore';

type Props = {
  perspective: TreePerspective;
  items: TreeFileItem[];
  localExtraItems?: TreeFileItem[];
  selectedFile: string | null;
  selectedCommitHash: string | null;
  commitLoading?: boolean;
  collapsedDirs: Record<string, boolean>;
  canStage: boolean;
  prNumber: number | null;
  baseLabel: string;
  onPerspective: (p: Exclude<TreePerspective, 'commit'>) => void;
  onClearCommit: () => void;
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
  selectedCommitHash,
  commitLoading = false,
  collapsedDirs,
  canStage,
  prNumber,
  baseLabel,
  onPerspective,
  onClearCommit,
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
    let stagedCount = 0;
    let unstagedCount = 0;
    for (const item of items) {
      adds += item.adds ?? 0;
      dels += item.dels ?? 0;
      if (item.staged) stagedCount++;
      if (item.unstaged) unstagedCount++;
    }
    return { count: items.length, adds, dels, stagedCount, unstagedCount };
  }, [items]);

  const renderNode = (node: TreeNode, depth: number, keyPrefix: string) => {
    if (node.kind === 'dir') {
      const collapsed = Boolean(collapsedDirs[`${keyPrefix}:${node.path}`]);
      return (
        <div key={`${keyPrefix}:d:${node.path}`}>
          <div
            className="ent-trow ent-tdir"
            style={{ paddingLeft: 8 + depth * 12 }}
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
            <Icon name={collapsed ? 'chev' : 'down'} size={10} />
            <Icon name="folder" size={11} />
            <span className="ent-tname mono">{node.name}</span>
            <span className="ent-tmeta mono">{node.filesCount}</span>
            {canStage && perspective === 'uncommitted' && (
              <button
                type="button"
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
        style={{ paddingLeft: 14 + depth * 12 }}
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
        {perspective === 'uncommitted' && (hasStaged || hasUnstaged) && (
          <span className="ent-su" aria-hidden="true">
            {hasStaged && <i className="ent-su-s" title={`Preparado (${f.staged})`}>S</i>}
            {hasUnstaged && <i className="ent-su-u" title={`Sin preparar (${f.unstaged})`}>U</i>}
          </span>
        )}
        <span className="ent-tcounts mono">
          {f.adds != null && f.adds > 0 && <span className="add">+{f.adds}</span>}
          {f.dels != null && f.dels > 0 && <span className="del">−{f.dels}</span>}
        </span>
        <span className="ent-tacts">
          {canStage && perspective === 'uncommitted' && hasUnstaged && (
            <button
              type="button"
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
              type="button"
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
          {perspective === 'uncommitted' && canStage && (
            <button
              type="button"
              className="ent-tact"
              onClick={(e) => {
                e.stopPropagation();
                onOpenEditor(f.path);
              }}
              title="Abrir en editor"
            >
              <Icon name="code" size={10} />
            </button>
          )}
        </span>
      </div>
    );
  };

  return (
    <section className="ent-col ent-col-tree" aria-label="Árbol de cambios">
      <div className="ent-col-head">
        <Icon name="changes" size={12} />
        <span>Cambios</span>
        <span className="ent-col-count mono">
          {totals.count}
          {totals.adds > 0 ? <span className="add"> +{totals.adds}</span> : null}
          {totals.dels > 0 ? <span className="del"> −{totals.dels}</span> : null}
        </span>
        {canStage && perspective === 'uncommitted' && totals.count > 0 && (
          <span className="ent-col-head-acts">
            {totals.unstagedCount > 0 && (
              <button
                type="button"
                className="ent-tact"
                onClick={() => onStage(items.filter((i) => i.unstaged).map((i) => i.path))}
                title={`Preparar todos (${totals.unstagedCount})`}
              >
                +
              </button>
            )}
            {totals.stagedCount > 0 && (
              <button
                type="button"
                className="ent-tact"
                onClick={() => onUnstage(items.filter((i) => i.staged).map((i) => i.path))}
                title={`Vaciar preparación (${totals.stagedCount})`}
              >
                −
              </button>
            )}
          </span>
        )}
      </div>

      <div className="ent-persp-bar" role="tablist" aria-label="Ámbito del árbol de cambios">
        <button
          type="button"
          role="tab"
          aria-selected={perspective === 'uncommitted'}
          className={perspective === 'uncommitted' ? 'on' : ''}
          onClick={() => onPerspective('uncommitted')}
        >
          Sin commit
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={perspective === 'branch'}
          className={perspective === 'branch' ? 'on' : ''}
          onClick={() => onPerspective('branch')}
          title={`Diferencias de la rama frente a ${baseLabel}`}
        >
          vs {baseLabel}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={perspective === 'pr'}
          className={perspective === 'pr' ? 'on' : ''}
          onClick={() => onPerspective('pr')}
          disabled={prNumber == null}
          title={prNumber ? `Archivos de la PR #${prNumber}` : 'Esta rama no tiene Pull Request'}
        >
          PR{prNumber ? ` #${prNumber}` : ''}
        </button>
      </div>

      {perspective === 'commit' && selectedCommitHash && (
        <div className="ent-commit-banner">
          <Icon name="commit" size={11} />
          <span className="mono">Commit {selectedCommitHash.slice(0, 7)}</span>
          <button
            type="button"
            className="ent-tact"
            onClick={onClearCommit}
            title="Volver a los cambios de la rama"
            aria-label="Salir de inspección de commit"
          >
            <Icon name="close" size={10} />
          </button>
        </div>
      )}

      <div className="ent-scroll">
        {tree.length > 0 ? (
          tree.map((n) => renderNode(n, 0, perspective))
        ) : (
          <p className="ent-empty-mini">
            {perspective === 'commit'
              ? commitLoading
                ? 'Cargando archivos del commit…'
                : 'Sin archivos modificados en este commit.'
              : perspective === 'uncommitted'
                ? canStage
                  ? 'Árbol de trabajo limpio.'
                  : 'Inspección sin checkout: cambia a «vs base» para ver los cambios de esta rama.'
                : perspective === 'branch'
                  ? `Sin diferencias respecto a ${baseLabel}.`
                  : 'Sin archivos en la Pull Request.'}
          </p>
        )}

        {perspective === 'pr' && localTree.length > 0 && (
          <div className="ent-local-sep">
            <div className="ent-bgroup-lbl">Locales sin subir · {localExtraItems.length}</div>
            {localTree.map((n) => renderNode(n, 0, 'pr-local'))}
          </div>
        )}
      </div>
    </section>
  );
}
