import { useEffect, useRef } from 'react';
import type { Tool } from './ipc';
import { toolState } from './Tools';
import { compact, resetTokens, totalOf, useUsage } from './usageStore';

const ENGINE: Record<string, string> = { codex: 'codex', claude: 'claude code' };

const time = (s: number | null) =>
  s ? new Date(s * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;

/** Resumen del uso para la barra inferior: la ventana de 5 h y la semanal más llenas. */
export function UsageSummary() {
  const { limits } = useUsage();
  const windows = Object.values(limits).flatMap((e) => e.windows);
  const pick = (week: boolean) =>
    windows.filter((w) => (w.label === 'semana') === week).sort((a, b) => b.percent - a.percent)[0];
  const short = pick(false);
  const week = pick(true);
  const out = Object.values(limits).some((e) => e.out);
  if (!short && !week) return <span>uso</span>;
  return (
    <>
      {short && (
        <>
          <span>5 h</span>
          <span className="mtr" aria-hidden="true">
            <i style={{ width: `${Math.min(100, short.percent)}%` }} className={short.percent >= 90 ? 'is-hot' : undefined} />
          </span>
        </>
      )}
      {week && (
        <>
          <span>semana</span>
          <span className="mtr" aria-hidden="true">
            <i style={{ width: `${Math.min(100, week.percent)}%` }} className={week.percent >= 90 ? 'is-hot' : undefined} />
          </span>
          <span className={out ? 'is-out' : undefined}>{out ? 'agotada' : `${Math.round(week.percent)}%`}</span>
        </>
      )}
    </>
  );
}

type Props = {
  tools: Tool[] | null;
  checking: boolean;
  onRefresh: () => void;
  onLogin: ((command: string) => void) | null;
  onClose: () => void;
};

/**
 * Detalle del uso, sobre la barra inferior: cuotas de cada motor, tokens por
 * modelo (el más usado, en azul) y el estado de las CLI de los agentes.
 */
export default function UsagePanel({ tools, checking, onRefresh, onLogin, onClose }: Props) {
  const { limits, models, since } = useUsage();
  const ref = useRef<HTMLDivElement>(null);
  const engines = Object.values(limits);
  const ranked = [...models].sort((a, b) => totalOf(b) - totalOf(a));
  const top = ranked[0] ? totalOf(ranked[0]) : 0;

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest('.status-usage')) onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);

  return (
    <div className="uso" role="dialog" aria-label="Uso de los modelos" ref={ref}>
      {engines.map((e) => (
        <div className="uso-sec" key={e.engine}>
          <div className="uso-h">
            <span>{ENGINE[e.engine] ?? e.engine}</span>
            {e.out && <span className="is-out">cuota agotada</span>}
          </div>
          {e.windows.map((w) => (
            <div className="uso-row" key={w.label} title={time(w.resetsAt) ? `se renueva ${time(w.resetsAt)}` : undefined}>
              <span>{w.label}</span>
              <span className="bar" aria-hidden="true">
                <i style={{ width: `${Math.min(100, w.percent)}%` }} className={w.percent >= 90 ? 'is-hot' : undefined} />
              </span>
              <span className="num">{Math.round(w.percent)}%</span>
            </div>
          ))}
        </div>
      ))}

      <div className="uso-sec">
        <div className="uso-h">
          <span>tokens desde {new Date(since).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
          {ranked.length > 0 && (
            <button className="co-link" onClick={resetTokens}>
              reiniciar
            </button>
          )}
        </div>
        {ranked.length === 0 && <div className="muted">se cuentan a partir del siguiente turno</div>}
        {ranked.map((m, i) => (
          <div
            className={`uso-model${i === 0 ? ' is-top' : ''}`}
            key={`${m.engine}/${m.model}`}
            title={`entrada ${compact(m.input)} · caché ${compact(m.cached)} · salida ${compact(m.output)} · ${m.turns} turno${m.turns === 1 ? '' : 's'}`}
          >
            <span className="uso-name">{m.model}</span>
            <span className="num">{compact(totalOf(m))}</span>
            <span className="bar" aria-hidden="true">
              <i style={{ width: `${top ? (totalOf(m) / top) * 100 : 0}%` }} />
            </span>
          </div>
        ))}
      </div>

      <div className="uso-sec">
        <div className="uso-h">
          <span>herramientas</span>
          <button className="co-link" onClick={onRefresh} disabled={checking}>
            {checking ? 'comprobando…' : 'comprobar'}
          </button>
        </div>
        <div className="uso-tools">
          {tools?.map((t) => {
            const st = toolState(t);
            const bad = st === 'falta' || st === 'sin sesión';
            return bad && t.installed && t.login && onLogin ? (
              <button key={t.id} className="is-bad" onClick={() => onLogin(t.login!)} title={`${st} · abre un terminal con «${t.login}»`}>
                {t.name} · iniciar sesión
              </button>
            ) : (
              <span key={t.id} className={bad ? 'is-bad' : undefined} title={`${t.role} · ${st}${t.detail ? ` · ${t.detail}` : ''}`}>
                {t.name}
                {bad ? ` · ${st}` : ''}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
