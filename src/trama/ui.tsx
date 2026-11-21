import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './icons';

/** Diálogo modal con foco atrapado y Escape. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, [tabindex="0"]')];
      if (!items.length) return;
      const a = items[0], b = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) { b.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === b) { a.focus(); e.preventDefault(); }
    };
    node?.addEventListener('keydown', onKey);
    return () => { node?.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="tr-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="tr-modal" role="dialog" aria-modal="true" aria-labelledby={id} style={wide ? { width: 'min(720px, 94vw)' } : undefined}>
        <h3 id={id}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Pestañas accesibles (flechas izquierda/derecha). */
export function Tabs<T extends string>({ value, onChange, items, label }: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: string; icon?: string; count?: number | null }[];
  label: string;
}) {
  return (
    <div className="tr-tabs" role="tablist" aria-label={label} onKeyDown={(e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = items.findIndex((x) => x.id === value);
      const next = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
      onChange(next.id);
      (e.currentTarget.querySelector(`[data-tab="${next.id}"]`) as HTMLElement | null)?.focus();
    }}>
      {items.map((t) => (
        <button key={t.id} data-tab={t.id} role="tab" className="tr-tab" aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1} onClick={() => onChange(t.id)}>
          {t.icon && <Icon name={t.icon} size={13} />}
          {t.label}
          {t.count != null && <span className="cnt">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Selector segmentado. */
export function Seg<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; icon?: string }[]; label: string }) {
  return (
    <div className="tr-seg" role="group" aria-label={label}>
      {items.map((t) => (
        <button key={t.id} aria-pressed={value === t.id} onClick={() => onChange(t.id)} title={t.label}>
          {t.icon && <Icon name={t.icon} size={13} />}<span className="seg-l">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon = 'info', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="tr-empty">
      <span className="art"><Icon name={icon} size={40} /></span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="tr-error" role="alert">
      <Icon name="warn" size={14} />
      <span style={{ flex: 1 }}>{error}</span>
      {onRetry && <button className="tr-btn sm" onClick={onRetry}>Reintentar</button>}
    </div>
  );
}
