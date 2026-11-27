import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { shortcut } from '../ui';
import { Icon } from './icons';
import { TOOLS, type ToolId } from './workspaceLayout';

export { TOOLS, type ToolId };

/** Último punto de trabajo, para «Retomar». Solo guarda lo que existe. */
export type Resume = { project: string; view: 'coach' | number; at: number };
const RESUME = 'filigranas.retomar';
export function loadResume(): Resume | null {
  try {
    const r = JSON.parse(localStorage.getItem(RESUME) ?? 'null') as
      | (Omit<Resume, 'view'> & { view: Resume['view'] | 'work' })
      | null;
    if (!r || typeof r.project !== 'string') return null;
    return { project: r.project, view: r.view === 'work' ? 'coach' : r.view, at: r.at ?? 0 };
  } catch {
    return null;
  }
}
export function saveResume(r: Resume) {
  try {
    localStorage.setItem(RESUME, JSON.stringify(r));
  } catch {
    /* sin almacenamiento */
  }
}

/**
 * Barra lateral de herramientas acoplables (sin icono de Workspace: Workspace
 * es la superficie permanente de Filigranas).
 */
export function DestNav({
  activeTool,
  onTool,
  badges,
  live,
  disabledTools,
  github,
}: {
  activeTool: ToolId | null;
  onTool: (tool: ToolId) => void;
  badges: Partial<Record<ToolId, number>>;
  live: Partial<Record<ToolId, boolean>>;
  disabledTools?: Partial<Record<ToolId, boolean>>;
  github?: ReactNode;
}) {
  const [tip, setTip] = useState<{ label: string; keys: string; x: number; y: number } | null>(null);
  const show = (e: { currentTarget: HTMLElement }, label: string, keys: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label, keys, x: r.right + 10, y: r.top + r.height / 2 - 13 });
  };
  const button = (d: (typeof TOOLS)[number]) => {
    const active = activeTool === d.id;
    const disabled = !!disabledTools?.[d.id];
    return (
      <button
        key={d.id}
        type="button"
        className={`tr-nb${active ? ' is-active' : ''}`}
        aria-pressed={active}
        aria-label={d.keys ? `${d.label} (${shortcut(d.keys)})` : d.label}
        disabled={disabled}
        onClick={() => onTool(d.id)}
        onMouseEnter={(e) => show(e, d.label, d.keys)}
        onMouseLeave={() => setTip(null)}
        onFocus={(e) => show(e, d.label, d.keys)}
        onBlur={() => setTip(null)}
      >
        <Icon name={d.icon} size={19} />
        {!!badges[d.id] && (
          <span className="cnt" aria-label={`${badges[d.id]} pendientes`}>
            {badges[d.id]}
          </span>
        )}
        {live[d.id] && !badges[d.id] && <span className="live" aria-hidden="true" />}
      </button>
    );
  };
  const primary = TOOLS.filter((t) => !t.footer);
  const footer = TOOLS.filter((t) => t.footer);
  return (
    <nav className="tr-nav" aria-label="Herramientas">
      {primary.slice(0, 5).map(button)}
      <span className="tr-nsep" aria-hidden="true" />
      {primary.slice(5).map(button)}
      <span className="sp" />
      {footer.map(button)}
      {github && <div className="tr-gh">{github}</div>}
      {tip &&
        createPortal(
          <div className="tr-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
            {tip.label}
            {tip.keys && <kbd>{shortcut(tip.keys)}</kbd>}
          </div>,
          document.body,
        )}
    </nav>
  );
}
