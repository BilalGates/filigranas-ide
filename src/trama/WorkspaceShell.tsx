import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { AgDot, Sigil, type Agent } from './kit';
import {
  computeLayoutGeometry,
  TOOL_MAP,
  type LayoutGeometry,
  type ShellState,
  type ToolId,
} from './workspaceLayout';

export type CompactWorkspaceInfo = {
  projectName: string | null;
  conversationName: string;
  activeAgent: Pick<Agent, 'h' | 'state' | 'name'> | null;
  workingCount: number;
  waitingCount: number;
};

type Props = {
  state: ShellState;
  compactInfo: CompactWorkspaceInfo;
  browserMounted: boolean;
  workspace: (geometry: LayoutGeometry) => ReactNode;
  compactExplorer?: ReactNode;
  compactExplorerOpen?: boolean;
  onToggleCompactExplorer?: () => void;
  onCloseCompactExplorer?: () => void;
  tool: ReactNode;
  browserLayer: ReactNode;
  onResize: (targetPx: number, availableWidth: number) => void;
  onResetRatio: () => void;
  onMinimizeWorkspace: () => void;
  onRestoreWorkspace: () => void;
  onCloseTool: () => void;
};

function WorkspaceCompactRail({
  info,
  autoCompacted,
  explorerOpen,
  onToggleExplorer,
  onRestore,
  onCloseTool,
}: {
  info: CompactWorkspaceInfo;
  autoCompacted: boolean;
  explorerOpen: boolean;
  onToggleExplorer?: () => void;
  onRestore: () => void;
  onCloseTool: () => void;
}) {
  const recover = () => {
    if (autoCompacted) onCloseTool();
    else onRestore();
  };
  const statusLabel = info.waitingCount > 0
    ? `${info.waitingCount} permiso${info.waitingCount === 1 ? '' : 's'} pendiente${info.waitingCount === 1 ? '' : 's'}`
    : info.workingCount > 0
      ? `${info.workingCount} agente${info.workingCount === 1 ? '' : 's'} trabajando`
      : 'En reposo';

  return (
    <aside className="ws-compact" aria-label="Workspace minimizado">
      {onToggleExplorer && (
        <button
          type="button"
          className={`ws-compact-nav-btn${explorerOpen ? ' is-on' : ''}`}
          onClick={onToggleExplorer}
          aria-label={explorerOpen ? 'Cerrar explorador de proyectos y conversaciones' : 'Abrir explorador de proyectos y conversaciones'}
          aria-expanded={explorerOpen}
          title="Proyectos y conversaciones"
        >
          <Icon name="sidebar" size={15} />
        </button>
      )}
      <button
        type="button"
        className="ws-compact-btn"
        onClick={recover}
        aria-label={`Recuperar Workspace · ${info.conversationName} · ${statusLabel}`}
        title={autoCompacted ? `Volver a Workspace (${info.conversationName})` : `Restaurar Workspace (${info.conversationName})`}
      >
        <span className="ws-compact-top">
          {info.projectName ? (
            <span className="ws-compact-sigil"><Sigil name={info.projectName} /></span>
          ) : (
            <span className="ws-compact-icon"><Icon name="chat" size={15} /></span>
          )}
          <span className="ws-compact-expand" aria-hidden="true">
            <Icon name="chev" size={12} />
          </span>
        </span>

        <span className="ws-compact-status">
          {info.activeAgent ? (
            <span className="tv"><AgDot a={info.activeAgent} s={12} /></span>
          ) : (
            <span className="ws-compact-idle-dot" aria-hidden="true" />
          )}
          {info.waitingCount > 0 && (
            <span className="ws-compact-badge is-warn" title={statusLabel}>
              {info.waitingCount}
            </span>
          )}
          {info.waitingCount === 0 && info.workingCount > 0 && (
            <span className="ws-compact-badge is-live" title={statusLabel}>
              {info.workingCount}
            </span>
          )}
        </span>

        <span className="ws-compact-label">{info.conversationName}</span>
      </button>
    </aside>
  );
}

/**
 * Contenedor centralizado de distribución: WorkspacePane (permanente y siempre
 * montado) + divisor central + ToolPane (solo la herramienta activa).
 */
export default function WorkspaceShell({
  state,
  compactInfo,
  browserMounted,
  workspace,
  compactExplorer,
  compactExplorerOpen = false,
  onToggleCompactExplorer,
  onCloseCompactExplorer,
  tool,
  browserLayer,
  onResize,
  onResetRatio,
  onMinimizeWorkspace,
  onRestoreWorkspace,
  onCloseTool,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(() =>
    typeof window !== 'undefined' ? Math.max(320, window.innerWidth - 56) : 1384,
  );
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Conserva el último ancho real de Workspace para que Monaco y xterm no colapsen al ocultarse.
  const lastWorkspaceWidth = useRef(availableWidth);

  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0) setAvailableWidth(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const geometry = computeLayoutGeometry(state, availableWidth);
  const workspaceHidden =
    geometry.effectiveMode === 'maximized' || geometry.effectiveMode === 'compact';

  if (!workspaceHidden && geometry.workspaceWidthPx > 0) {
    lastWorkspaceWidth.current = geometry.workspaceWidthPx;
  }

  useEffect(() => {
    if (!compactExplorerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseCompactExplorer?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compactExplorerOpen, onCloseCompactExplorer]);

  const activeTool: ToolId | null = state.activeTool;
  const toolSpec = activeTool ? TOOL_MAP[activeTool] : null;
  const keepToolPaneMounted = Boolean(toolSpec || browserMounted);

  const workspaceStyle = workspaceHidden
    ? { width: `${lastWorkspaceWidth.current}px` }
    : geometry.effectiveMode === 'split'
      ? { width: `${geometry.workspaceWidthPx}px`, flex: '0 0 auto' }
      : { flex: '1 1 auto' };

  return (
    <div
      ref={shellRef}
      className={`ws-shell is-${geometry.effectiveMode}${dragging ? ' is-dragging' : ''}${geometry.collapseWorkspaceSidebar ? ' is-narrow-ws' : ''}`}
      data-shell-mode={geometry.effectiveMode}
      data-active-tool={activeTool ?? ''}
    >
      {geometry.effectiveMode === 'compact' && (
        <WorkspaceCompactRail
          info={compactInfo}
          autoCompacted={geometry.autoCompacted}
          explorerOpen={compactExplorerOpen}
          onToggleExplorer={compactExplorer ? onToggleCompactExplorer : undefined}
          onRestore={onRestoreWorkspace}
          onCloseTool={onCloseTool}
        />
      )}

      {geometry.effectiveMode === 'compact' && compactExplorerOpen && compactExplorer && (
        <>
          <div className="ws-compact-backdrop" onClick={onCloseCompactExplorer} aria-hidden="true" />
          <div className="ws-compact-drawer" role="region" aria-label="Explorador en Workspace compacto">
            {compactExplorer}
          </div>
        </>
      )}

      <div
        className={`ws-pane${workspaceHidden ? ' is-hidden' : ''}`}
        style={workspaceStyle}
        aria-hidden={workspaceHidden || undefined}
      >
        {workspace(geometry)}
      </div>

      {geometry.showSplitter && (
        <div
          className="ws-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Divisor entre Workspace y herramienta"
          aria-valuemin={geometry.minWorkspacePx}
          aria-valuemax={geometry.maxWorkspacePx}
          aria-valuenow={geometry.workspaceWidthPx}
          tabIndex={0}
          title="Arrastra para ajustar · Doble clic para restablecer 35 % / 65 %"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { startX: e.clientX, startWidth: geometry.workspaceWidthPx };
            setDragging(true);
            document.documentElement.dataset.resizing = 'x';
          }}
          onPointerMove={(e) => {
            if (!dragRef.current) return;
            const delta = e.clientX - dragRef.current.startX;
            onResize(dragRef.current.startWidth + delta, availableWidth);
          }}
          onPointerUp={(e) => {
            if (!dragRef.current) return;
            dragRef.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            setDragging(false);
            delete document.documentElement.dataset.resizing;
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            setDragging(false);
            delete document.documentElement.dataset.resizing;
          }}
          onDoubleClick={onResetRatio}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              onResize(geometry.workspaceWidthPx - 24, availableWidth);
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              onResize(geometry.workspaceWidthPx + 24, availableWidth);
            } else if (e.key === 'Home') {
              e.preventDefault();
              onResize(geometry.minWorkspacePx, availableWidth);
            } else if (e.key === 'End') {
              e.preventDefault();
              onResize(geometry.maxWorkspacePx, availableWidth);
            } else if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onResetRatio();
            }
          }}
        />
      )}

      {keepToolPaneMounted && (
        <section
          className={`tool-pane${toolSpec ? ` is-${geometry.effectiveMode}` : ' is-dormant'}${toolSpec && geometry.effectiveMode === 'split' ? ' has-ws-min' : ''}`}
          aria-label={toolSpec ? `Herramienta ${toolSpec.label}` : undefined}
          aria-hidden={!toolSpec || undefined}
        >
          {toolSpec && geometry.effectiveMode === 'split' && (
            <button
              type="button"
              className="tool-ws-min"
              onClick={onMinimizeWorkspace}
              aria-label="Minimizar Workspace"
              title="Minimizar Workspace a columna compacta"
            >
              <Icon name="sidebar" size={14} />
            </button>
          )}
          <div className="tool-body">
            {toolSpec && tool}
            {browserMounted && browserLayer}
          </div>
        </section>
      )}
    </div>
  );
}
