import { useState } from 'react';
import { compact, resetTokens, totalOf, useUsage } from './usageStore';

const ENGINE: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };

const time = (s: number | null) =>
  s ? new Date(s * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;

/**
 * Consumo de los modelos, al pie del panel de Git. Plegado muestra la cuota
 * más ajustada; desplegado, las ventanas de cada motor y los tokens por
 * modelo, con el más usado marcado.
 */
export default function Usage() {
  const { limits, models, since } = useUsage();
  // Plegado por defecto; se recuerda entre sesiones.
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem('filigranas.uso') === 'abierto';
    } catch {
      return false;
    }
  });
  const setOpen = (f: (o: boolean) => boolean) =>
    setOpenState((o) => {
      const v = f(o);
      try {
        localStorage.setItem('filigranas.uso', v ? 'abierto' : 'plegado');
      } catch {
        // sin almacenamiento
      }
      return v;
    });
  const engines = Object.values(limits);
  const ranked = [...models].sort((a, b) => totalOf(b) - totalOf(a));
  const top = ranked[0] ? totalOf(ranked[0]) : 0;
  const all = ranked.reduce((n, m) => n + totalOf(m), 0);

  // La ventana más llena de todas: es la que manda.
  const worst = engines.flatMap((e) => e.windows.map((w) => ({ ...w, engine: e.engine }))).sort((a, b) => b.percent - a.percent)[0];
  const out = engines.some((e) => e.out);

  return (
    <section className={`usage${open ? ' is-open' : ''}`} aria-label="Consumo de los modelos">
      <button className="usage-head" aria-expanded={open} title={open ? 'minimizar el consumo' : 'ver el consumo de los modelos'} onClick={() => setOpen((o) => !o)}>
        <span className="usage-title">uso</span>
        <span className={`usage-sum${out ? ' is-out' : ''}`}>
          {worst ? (out ? 'cuota agotada' : `${Math.round(worst.percent)}% · ${worst.label}`) : all ? `${compact(all)} tokens` : '—'}
        </span>
        <span className="usage-chev" aria-hidden="true">›</span>
      </button>

      {open && (
        <div className="usage-body">
          {engines.map((e) => (
            <div className="usage-engine" key={e.engine}>
              <div className="usage-label">
                <span>{ENGINE[e.engine] ?? e.engine}</span>
                {e.out && <span className="usage-num is-out">cuota agotada</span>}
              </div>
              {e.windows.map((w) => (
                <div className="usage-row" key={w.label} title={time(w.resetsAt) ? `se renueva ${time(w.resetsAt)}` : undefined}>
                  <span className="usage-span">{w.label}</span>
                  <span className="meter" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, w.percent)}%` }} className={w.percent >= 90 ? 'is-hot' : undefined} />
                  </span>
                  <span className="usage-num">{Math.round(w.percent)}%</span>
                </div>
              ))}
            </div>
          ))}

          <div className="usage-engine">
            <div className="usage-label">
              <span>tokens por modelo</span>
              <span>{compact(all)}</span>
            </div>
            {ranked.length === 0 && <div className="muted">Se cuentan a partir del siguiente turno.</div>}
            {ranked.map((m, i) => (
              <div
                className={`usage-model${i === 0 ? ' is-top' : ''}`}
                key={`${m.engine}/${m.model}`}
                title={`entrada ${compact(m.input)} · caché ${compact(m.cached)} · salida ${compact(m.output)} · ${m.turns} turno${m.turns === 1 ? '' : 's'}`}
              >
                <div className="usage-row">
                  <span className="usage-name">{m.model}</span>
                  <span className="usage-num">{compact(totalOf(m))}</span>
                </div>
                <span className="meter is-thin" aria-hidden="true">
                  <span style={{ width: `${top ? (totalOf(m) / top) * 100 : 0}%` }} />
                </span>
                <div className="usage-split muted">
                  {ENGINE[m.engine] ?? m.engine} · entrada {compact(m.input)} · caché {compact(m.cached)} · salida {compact(m.output)}
                </div>
              </div>
            ))}
            <div className="usage-foot muted">
              desde {new Date(since).toLocaleDateString([], { day: 'numeric', month: 'short' })}
              <button className="co-link" onClick={resetTokens}>
                reiniciar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
