import { Fragment, useEffect, useRef, useState } from 'react';
import { shortcut } from './ui';

export type Command = {
  id: string;
  label: string;
  keys?: string;
  run: () => void;
  group?: string;
  subtitle?: string;
  keywords?: string;
  state?: 'trabajando' | 'permiso' | null;
};

/** Búsqueda global (⌘K): proyectos, sesiones y órdenes con navegación por teclado. */
export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = commands.filter((c) => {
    if (!terms.length) return true;
    const hay = `${c.label} ${c.subtitle ?? ''} ${c.group ?? ''} ${c.keywords ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const at = Math.min(sel, Math.max(0, hits.length - 1));

  useEffect(() => {
    list.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const run = (c: Command) => {
    onClose();
    c.run();
  };

  return (
    <div className="veil" onMouseDown={onClose}>
      <div className="pal" role="dialog" aria-label="Buscar proyecto, sesión u orden" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          aria-label="Buscar proyecto, sesión u orden"
          placeholder="Buscar proyecto, sesión u orden…"
          value={q}
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel(Math.min(at + 1, hits.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel(Math.max(at - 1, 0));
            } else if (e.key === 'Enter' && hits[at]) {
              e.preventDefault();
              run(hits[at]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="pal-list" ref={list} role="listbox">
          {hits.map((c, i) => {
            const prevGroup = i > 0 ? hits[i - 1].group : undefined;
            const showGroup = c.group && c.group !== prevGroup;
            return (
              <Fragment key={c.id}>
                {showGroup && <div className="pal-group">{c.group}</div>}
                <button
                  role="option"
                  aria-selected={i === at}
                  className={`pal-item${i === at ? ' is-sel' : ''}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                >
                  {c.state && <span className={`dot is-${c.state}`} aria-hidden="true" />}
                  <span className="pal-main">
                    <span className="pal-label">{c.label}</span>
                    {c.subtitle && <span className="pal-sub">{c.subtitle}</span>}
                  </span>
                  {c.keys && <span className="kbd">{shortcut(c.keys)}</span>}
                </button>
              </Fragment>
            );
          })}
          {hits.length === 0 && <div className="pal-empty">Nada coincide</div>}
        </div>
      </div>
    </div>
  );
}

/** Chuleta de atajos (⌘/). */
export function Cheatsheet({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="veil" onMouseDown={onClose}>
      <div className="cheat" role="dialog" aria-label="Atajos de teclado" onMouseDown={(e) => e.stopPropagation()}>
        {commands
          .filter((c) => c.keys)
          .map((c) => (
            <div className="cheat-row" key={c.id}>
              <span>{c.label}</span>
              <kbd>{shortcut(c.keys!)}</kbd>
            </div>
          ))}
      </div>
    </div>
  );
}
