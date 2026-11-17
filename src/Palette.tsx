import { useEffect, useRef, useState } from 'react';

export type Command = { id: string; label: string; keys?: string; run: () => void; group?: string };

/** Paleta de órdenes (⌘K): se filtra escribiendo y se maneja con flechas y ↩. */
export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const query = q.trim().toLowerCase();
  const hits = commands.filter((c) => !query || c.label.toLowerCase().includes(query) || c.group?.includes(query));
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
      <div className="pal" role="dialog" aria-label="Órdenes" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          aria-label="Buscar orden"
          placeholder="orden, sesión o vista"
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
          {hits.map((c, i) => (
            <button key={c.id} role="option" aria-selected={i === at} className={`pal-item${i === at ? ' is-sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <span className="grow">{c.label}</span>
              {c.keys && <span className="kbd">{c.keys}</span>}
            </button>
          ))}
          {hits.length === 0 && <div className="pal-empty">nada coincide</div>}
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
              <kbd>{c.keys}</kbd>
            </div>
          ))}
      </div>
    </div>
  );
}
