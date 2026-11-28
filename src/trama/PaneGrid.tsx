import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Icon } from './icons';
import {
  clampPaneRatio,
  computePaneGeometry,
  MAX_PANE_RATIO,
  MAX_PANES,
  MIN_PANE_RATIO,
  PANE_DIVIDER_PX,
  PANE_RATIO_STEP,
  type PaneAxis,
  type PaneMode,
  type PaneRatios,
  type PaneRef,
} from './conversationPanes';
import { registerPaneDropTarget } from './paneDrag';

export type PaneState = 'trabajando' | 'permiso' | null;
export type PaneTab = { key: string; label: string; state: PaneState };

type Props = {
  /** Conversaciones en pantalla; con una sola, la vista de siempre. */
  count: number;
  ratios: PaneRatios;
  maximized: boolean;
  activeIndex: number;
  tabs: PaneTab[];
  onResize: (axis: PaneAxis, ratio: number) => void;
  onEqualize: (axis: PaneAxis) => void;
  onActivate: (index: number) => void;
  /** Conversación soltada: en un panel nuevo (`null`) o sustituyendo el panel indicado. */
  onDrop: (ref: PaneRef, replaceIndex: number | null) => void;
  onModeChange: (mode: PaneMode) => void;
  children: ReactNode;
};

type DropZone = { left: number; top: number; width: number; height: number; text: string; replace: number | null };

/**
 * Área de conversación del Workspace. Siempre es el mismo elemento para que
 * las conversaciones no se remonten al pasar de uno a varios paneles. El
 * arrastre de los divisores solo vuelve a pintar este componente: las
 * conversaciones (sus hijos) no cambian hasta soltar.
 */
export default function PaneGrid({ count, ratios, maximized, activeIndex, tabs, onResize, onEqualize, onActivate, onDrop, onModeChange, children }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<PaneRatios | null>(null);
  const [drop, setDrop] = useState<DropZone | null>(null);
  const multi = count > 1;

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    // Caja de contenido: el relleno de la rejilla no cuenta para el mínimo de cada panel.
    const measure = () => {
      const css = getComputedStyle(el);
      const w = Math.round(el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight));
      const h = Math.round(el.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom));
      setSize((cur) => (cur.w === w && cur.h === h ? cur : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const live = draft ?? ratios;
  const geometry = computePaneGeometry(count, live, size.w || Infinity, size.h || Infinity, maximized);
  const fitted = (axis: PaneAxis, ratio: number) =>
    computePaneGeometry(count, { ...live, [axis]: ratio }, size.w || Infinity, size.h || Infinity, maximized)[axis];

  const modeChanged = useRef(onModeChange);
  modeChanged.current = onModeChange;
  useEffect(() => { modeChanged.current(geometry.mode); }, [geometry.mode]);

  // Conversaciones arrastradas desde el explorador.
  const latest = useRef({ count, activeIndex, onDrop });
  latest.current = { count, activeIndex, onDrop };
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const zoneAt = (x: number, y: number): DropZone => {
      const box = el.getBoundingClientRect();
      const rel = (r: DOMRect, text: string, replace: number | null): DropZone =>
        ({ left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height, text, replace });
      if (latest.current.count < MAX_PANES) return rel(box, 'Suelta para abrir en un panel nuevo', null);
      const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>('.ws-cell[data-slot]');
      if (cell && el.contains(cell) && cell.getClientRects().length) return rel(cell.getBoundingClientRect(), 'Suelta para sustituir este panel', Number(cell.dataset.slot));
      return rel(box, 'Suelta para sustituir el panel activo', latest.current.activeIndex);
    };
    return registerPaneDropTarget({
      el,
      over: (x, y) => {
        const next = zoneAt(x, y);
        setDrop((cur) => (cur && cur.left === next.left && cur.top === next.top && cur.width === next.width && cur.text === next.text ? cur : next));
      },
      leave: () => setDrop(null),
      drop: (ref, x, y) => {
        setDrop(null);
        latest.current.onDrop(ref, zoneAt(x, y).replace);
      },
    });
  }, []);

  const style: CSSProperties | undefined = (() => {
    const cols = `minmax(0, ${geometry.col}fr) ${PANE_DIVIDER_PX}px minmax(0, ${1 - geometry.col}fr)`;
    const rows = `minmax(0, ${geometry.row}fr) ${PANE_DIVIDER_PX}px minmax(0, ${1 - geometry.row}fr)`;
    if (geometry.mode === 'columns') return { gridTemplateColumns: cols, gridTemplateRows: 'minmax(0, 1fr)' };
    if (geometry.mode === 'grid') return { gridTemplateColumns: cols, gridTemplateRows: rows };
    return undefined;
  })();

  const divider = (axis: PaneAxis) => (
    <PaneDivider
      key={axis}
      axis={axis}
      ratio={geometry[axis]}
      host={host}
      onDraft={(ratio) => setDraft({ ...live, [axis]: fitted(axis, ratio) })}
      onCommit={(ratio) => { setDraft(null); onResize(axis, fitted(axis, ratio)); }}
      onCancel={() => setDraft(null)}
      onEqualize={() => { setDraft(null); onEqualize(axis); }}
    />
  );

  return (
    <div
      ref={host}
      className={`main-view${multi ? ' is-panes' : ''}`}
      data-pane-mode={multi ? geometry.mode : undefined}
      data-panes={multi ? count : undefined}
      style={style}
    >
      {multi && geometry.mode === 'tabs' && (
        <div className="ws-pane-tabs" role="group" aria-label="Conversaciones en pantalla">
          {tabs.map((tab, index) => (
            <button key={tab.key} type="button" className="ws-pane-tab" aria-pressed={index === activeIndex} onClick={() => onActivate(index)} title={tab.label}>
              <span className={`dot${tab.state ? ` is-${tab.state}` : ''}`} aria-hidden="true" />
              <span className="ws-pane-tab-label">{tab.label}</span>
            </button>
          ))}
        </div>
      )}
      {children}
      {multi && (geometry.mode === 'columns' || geometry.mode === 'grid') && divider('col')}
      {multi && geometry.mode === 'grid' && divider('row')}
      {drop && (
        <div className="ws-pane-drop" style={{ left: drop.left, top: drop.top, width: drop.width, height: drop.height }} aria-hidden="true">
          <span><Icon name="split" size={14} />{drop.text}</span>
        </div>
      )}
    </div>
  );
}

function PaneDivider({ axis, ratio, host, onDraft, onCommit, onCancel, onEqualize }: {
  axis: PaneAxis;
  ratio: number;
  host: RefObject<HTMLDivElement | null>;
  onDraft: (ratio: number) => void;
  onCommit: (ratio: number) => void;
  onCancel: () => void;
  onEqualize: () => void;
}) {
  const drag = useRef<{ start: number; size: number; last: number } | null>(null);
  const cols = axis === 'col';
  const label = cols ? 'Ancho de las columnas de conversación' : 'Alto de las filas de conversación';
  const stop = () => {
    drag.current = null;
    delete document.documentElement.dataset.resizing;
  };
  const step = (delta: number) => onCommit(clampPaneRatio(ratio + delta));

  return (
    <div
      className={`ws-divider is-${axis}`}
      role="separator"
      aria-orientation={cols ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={Math.round(MIN_PANE_RATIO * 100)}
      aria-valuemax={Math.round(MAX_PANE_RATIO * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      title={`${label} · arrastra para ajustar · doble clic para igualar`}
      onPointerDown={(e) => {
        const el = host.current;
        if (e.button !== 0 || !el) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const box = el.getBoundingClientRect();
        const css = getComputedStyle(el);
        const start = cols ? box.left + parseFloat(css.paddingLeft) : box.top + parseFloat(css.paddingTop);
        const inner = cols
          ? el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
          : el.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
        drag.current = { start, size: Math.max(1, inner - PANE_DIVIDER_PX), last: ratio };
        document.documentElement.dataset.resizing = cols ? 'x' : 'y';
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = ((cols ? e.clientX : e.clientY) - d.start - PANE_DIVIDER_PX / 2) / d.size;
        onDraft(d.last);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        stop();
        onCommit(d.last);
      }}
      onPointerCancel={() => { stop(); onCancel(); }}
      onDoubleClick={onEqualize}
      onKeyDown={(e) => {
        const back = cols ? 'ArrowLeft' : 'ArrowUp';
        const forward = cols ? 'ArrowRight' : 'ArrowDown';
        if (e.key === back) step(-PANE_RATIO_STEP);
        else if (e.key === forward) step(PANE_RATIO_STEP);
        else if (e.key === 'Home') onCommit(MIN_PANE_RATIO);
        else if (e.key === 'End') onCommit(MAX_PANE_RATIO);
        else if (e.key === 'Enter' || e.key === ' ') onEqualize();
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** Cabecera mínima de cada panel: nombre, agente, estado, maximizar y quitar. */
export function PaneHeader({ name, meta, tag, state, active, maximized, onMaximize, onClose }: {
  name: string;
  meta: string | null;
  tag: string | null;
  state: PaneState;
  active: boolean;
  maximized: boolean;
  onMaximize: () => void;
  onClose: () => void;
}) {
  return (
    <div className="ws-pane-head" data-active={active || undefined}>
      <span className={`dot${state ? ` is-${state}` : ''}`} aria-hidden="true" />
      <span className="ws-pane-name" title={name}>{name}</span>
      {tag && <span className="tag">{tag}</span>}
      {meta && <span className="ws-pane-meta" title={meta}>{meta}</span>}
      {state && <span className={`ch-state is-${state}`}>{state === 'permiso' ? 'espera tu permiso' : 'trabajando'}</span>}
      <span className="grow" />
      <span className="ws-pane-actions">
        <button type="button" className="tb-btn" onClick={onMaximize} aria-pressed={maximized}
          aria-label={maximized ? `Restaurar los paneles (${name})` : `Maximizar ${name}`}
          title={maximized ? 'Restaurar los paneles' : 'Maximizar este panel'}>
          <Icon name={maximized ? 'side' : 'fit'} size={13} />
        </button>
        <button type="button" className="tb-btn" onClick={onClose} aria-label={`Quitar ${name} de la pantalla`}
          title="Quitar de la pantalla · la conversación sigue abierta">
          <Icon name="close" size={10} />
        </button>
      </span>
    </div>
  );
}
