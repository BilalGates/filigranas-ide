import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Icon } from './icons';
import { type Agent } from './kit';
import {
  canSplitWorkspace,
  computeLayoutGeometry,
  resizeWorkspaceFromDelta,
  splitterKeyTargetPx,
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
  tool: ReactNode;
  browserLayer: ReactNode;
  onResize: (targetPx: number, availableWidth: number) => void;
  onResetRatio: () => void;
  onRecoverWorkspace: (availableWidth: number) => void;
  onFocusWorkspace?: () => void;
  onGeometryChange?: (geometry: LayoutGeometry) => void;
};

function WorkspaceDockTab({
  buttonRef,
  info,
  fitsSplit,
  toolLabel,
  onRecover,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  info: CompactWorkspaceInfo;
  fitsSplit: boolean;
  toolLabel: string | null;
  onRecover: () => void;
}) {
  const hasWarn = info.waitingCount > 0;
  const hasLive = !hasWarn && info.workingCount > 0;
  const statusText = hasWarn
    ? `${info.waitingCount} permiso${info.waitingCount === 1 ? '' : 's'} pendiente${info.waitingCount === 1 ? '' : 's'}`
    : hasLive
      ? `${info.workingCount} agente${info.workingCount === 1 ? '' : 's'} trabajando`
      : info.conversationName;
  const actionNote = !fitsSplit && toolLabel ? ` (cierra ${toolLabel})` : '';
  const fullLabel = `Mostrar chat · ${statusText}${actionNote}`;

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`ws-dock-tab${hasWarn ? ' is-warn' : ''}${hasLive ? ' is-live' : ''}`}
      onClick={onRecover}
      aria-label={fullLabel}
      title={fullLabel}
    >
      <span className="ws-dock-chev" aria-hidden="true">
        <Icon name="back" size={13} />
      </span>
      <span className="ws-dock-ico" aria-hidden="true">
        <Icon name="chat" size={14} />
      </span>
      {hasWarn ? (
        <span className="ws-dock-badge" aria-hidden="true">{info.waitingCount}</span>
      ) : (
        <>
          {hasLive && <span className="ws-dock-live" aria-hidden="true" />}
          <span className="ws-dock-lbl" aria-hidden="true">Chat</span>
        </>
      )}
    </button>
  );
}

/**
 * Contenedor centralizado de distribución: ToolPane a la izquierda + divisor
 * central + WorkspacePane permanente a la derecha (o lengüeta en el borde
 * derecho cuando el chat está oculto o la herramienta maximizada).
 */
export default function WorkspaceShell({
  state,
  compactInfo,
  browserMounted,
  workspace,
  tool,
  browserLayer,
  onResize,
  onResetRatio,
  onRecoverWorkspace,
  onFocusWorkspace,
  onGeometryChange,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null);
  const wsPaneRef = useRef<HTMLDivElement>(null);
  const dockTabRef = useRef<HTMLButtonElement>(null);
  const activeInPaneRef = useRef(false);
  const recoveringFromDockRef = useRef(false);
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
  const wasHiddenRef = useRef(workspaceHidden);

  // Traslada el foco entre «Ocultar chat»/compositor y la lengüeta para no perderlo en nodos ocultos/desmontados.
  useLayoutEffect(() => {
    const wasHidden = wasHiddenRef.current;
    wasHiddenRef.current = workspaceHidden;
    if (!wasHidden && workspaceHidden) {
      if (activeInPaneRef.current) {
        activeInPaneRef.current = false;
        dockTabRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (wasHidden && !workspaceHidden && recoveringFromDockRef.current) {
      recoveringFromDockRef.current = false;
      const hideBtn = wsPaneRef.current?.querySelector<HTMLButtonElement>('.ws-hide-chat');
      if (hideBtn && hideBtn.offsetParent !== null) {
        hideBtn.focus({ preventScroll: true });
      } else {
        onFocusWorkspace?.();
      }
    }
  }, [workspaceHidden, onFocusWorkspace]);

  useEffect(() => {
    onGeometryChange?.(geometry);
  }, [
    onGeometryChange,
    geometry.effectiveMode,
    geometry.collapseWorkspaceSidebar,
    geometry.workspaceWidthPx,
    geometry.toolWidthPx,
    geometry.autoCompacted,
  ]);

  if (!workspaceHidden && geometry.workspaceWidthPx > 0) {
    lastWorkspaceWidth.current = geometry.workspaceWidthPx;
  }

  const activeTool: ToolId | null = state.activeTool;
  const toolSpec = activeTool ? TOOL_MAP[activeTool] : null;
  const keepToolPaneMounted = Boolean(toolSpec || browserMounted);
  const fitsSplit = canSplitWorkspace(availableWidth);

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
      {keepToolPaneMounted && (
        <section
          className={`tool-pane${toolSpec ? ` is-${geometry.effectiveMode}` : ' is-dormant'}`}
          aria-label={toolSpec ? `Herramienta ${toolSpec.label}` : undefined}
          aria-hidden={!toolSpec || undefined}
        >
          <div className="tool-body">
            {toolSpec && tool}
            {browserMounted && browserLayer}
          </div>
        </section>
      )}

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
            const next = resizeWorkspaceFromDelta(state, dragRef.current.startWidth, delta, availableWidth);
            if (next.workspacePx != null) onResize(next.workspacePx, availableWidth);
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
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onResetRatio();
              return;
            }
            const target = splitterKeyTargetPx(geometry, e.key);
            if (target == null) return;
            e.preventDefault();
            onResize(target, availableWidth);
          }}
        />
      )}

      <div
        ref={wsPaneRef}
        className={`ws-pane${workspaceHidden ? ' is-hidden' : ''}`}
        style={workspaceStyle}
        aria-hidden={workspaceHidden || undefined}
        onFocusCapture={() => {
          if (!workspaceHidden) activeInPaneRef.current = true;
        }}
        onBlurCapture={(e) => {
          if (!workspaceHidden && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
            activeInPaneRef.current = false;
          }
        }}
      >
        {workspace(geometry)}
      </div>

      {workspaceHidden && (
        <WorkspaceDockTab
          buttonRef={dockTabRef}
          info={compactInfo}
          fitsSplit={fitsSplit}
          toolLabel={toolSpec?.label ?? null}
          onRecover={() => {
            recoveringFromDockRef.current = true;
            onRecoverWorkspace(availableWidth);
          }}
        />
      )}
    </div>
  );
}
