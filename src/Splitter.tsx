import { useRef } from 'react';

// Tamaños de las secciones redimensionables. Se guardan como variables CSS
// en <html> y en localStorage, así que sobreviven a reinicios.
type Size = { name: string; def: number; min: number; max: number };

export const SIZES = {
  side: { name: '--side-w', def: 232, min: 180, max: 420 },
  git: { name: '--git-w', def: 360, min: 300, max: 720 },
  term: { name: '--term-h', def: 240, min: 120, max: 720 },
  log: { name: '--log-h', def: 280, min: 96, max: 900 },
  compose: { name: '--compose-h', def: 76, min: 44, max: 420 },
} satisfies Record<string, Size>;

const KEY = 'filigranas.layout';

function saved(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function apply(size: Size, px: number) {
  const v = Math.round(Math.min(size.max, Math.max(size.min, px)));
  document.documentElement.style.setProperty(size.name, `${v}px`);
  return v;
}

/** Restaura los tamaños guardados (al arrancar). */
export function restoreLayout() {
  const s = saved();
  for (const size of Object.values(SIZES)) apply(size, s[size.name] ?? size.def);
}

function store(size: Size, px: number) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...saved(), [size.name]: px }));
  } catch {
    // sin almacenamiento: el tamaño dura lo que la ventana
  }
}

function current(size: Size) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(size.name));
  return Number.isFinite(v) ? v : size.def;
}

type Props = {
  size: Size;
  /** x: arrastre horizontal; y: vertical. */
  axis: 'x' | 'y';
  /** El panel crece al arrastrar hacia la izquierda / arriba. */
  invert?: boolean;
  measureParent?: boolean;
  className?: string;
  label: string;
};

/**
 * Divisor arrastrable entre dos secciones. Doble clic vuelve al tamaño
 * por defecto; con el teclado, las flechas lo mueven de 16 en 16 px.
 */
export default function Splitter({ size, axis, invert, measureParent, className, label }: Props) {
  const drag = useRef<{ start: number; from: number } | null>(null);
  const sign = invert ? -1 : 1;

  const set = (px: number) => store(size, apply(size, px));
  const renderedSize = (handle: HTMLElement) => {
    const panel = measureParent ? handle.parentElement : null;
    return panel ? (axis === 'x' ? panel.offsetWidth : panel.offsetHeight) : current(size);
  };

  return (
    <div
      className={`splitter is-${axis}${className ? ` ${className}` : ''}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      tabIndex={0}
      title={`${label} · doble clic para restablecer`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: axis === 'x' ? e.clientX : e.clientY, from: renderedSize(e.currentTarget) };
        document.documentElement.dataset.resizing = axis;
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const delta = (axis === 'x' ? e.clientX : e.clientY) - d.start;
        apply(size, d.from + sign * delta);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        delete document.documentElement.dataset.resizing;
        store(size, current(size));
      }}
      onDoubleClick={() => set(size.def)}
      onKeyDown={(e) => {
        const grow = axis === 'x' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 };
        const step = grow[e.key as keyof typeof grow];
        if (!step) return;
        e.preventDefault();
        set(renderedSize(e.currentTarget) + sign * step * 16);
      }}
    />
  );
}
