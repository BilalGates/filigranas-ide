import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type ChipOption = {
  value: string;
  label: string;
  /** Línea secundaria, más pequeña, bajo la etiqueta. */
  hint?: string;
  disabled?: boolean;
  /** Icono a la izquierda (logo del proveedor…). */
  icon?: ReactNode;
};

type Props = {
  /** Nombre accesible del selector («Modelo», «Razonamiento»…). */
  label: string;
  value: string;
  options: ChipOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  /** Texto del chip; por defecto, la etiqueta de la opción elegida. */
  display?: ReactNode;
  /** Encabezado del menú. */
  heading?: string;
  className?: string;
  /** Icono del chip; por defecto, el de la opción elegida. */
  icon?: ReactNode;
};

/**
 * Desplegable del compositor: chip con la opción elegida y menú propio que se
 * abre hacia arriba. Sustituye al `<select>` nativo, que en Windows abre una
 * lista blanca del sistema. Flechas, Inicio/Fin, ↩ y Esc lo manejan.
 */
export default function ChipMenu({ label, value, options, onChange, disabled, title, display, heading, className, icon }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    // Al abrir, el foco va a la opción elegida (o a la primera disponible).
    const items = root.current?.querySelectorAll<HTMLButtonElement>('.cm-item:not(:disabled)');
    const selected = root.current?.querySelector<HTMLButtonElement>('.cm-item[aria-checked="true"]:not(:disabled)');
    (selected ?? items?.[0])?.focus();
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const close = (focus = true) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  const choose = (option: ChipOption) => {
    if (option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close();
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.cm-item:not(:disabled)') ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  };

  return (
    <div className={`cm${className ? ` ${className}` : ''}`} ref={root}>
      <button ref={trigger} type="button" className={`chip cm-trigger${open ? ' is-open' : ''}`} aria-label={current || value ? `${label}: ${current?.label ?? value}` : label}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} title={title}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !open) { e.preventDefault(); setOpen(true); } }}>
        {icon ?? current?.icon}
        <span className="cm-value">{display ?? current?.label ?? value}</span>
        <svg className="cm-caret" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M2.5 6.2 5 3.8l2.5 2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="cm-menu" id={menuId} role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {heading && <div className="cm-heading">{heading}</div>}
          {options.map((o) => (
            <button key={o.value} type="button" role="menuitemradio" aria-checked={o.value === value} disabled={o.disabled}
              className={`cm-item${o.value === value ? ' is-on' : ''}`} onClick={() => choose(o)}>
              {o.icon && <span className="cm-icon">{o.icon}</span>}
              <span className="cm-text">
                <span className="cm-label">{o.label}</span>
                {o.hint && <small>{o.hint}</small>}
              </span>
              <svg className="cm-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                {o.value === value && <path d="M5 12.5l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />}
              </svg>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
