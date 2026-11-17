import type { Tool } from './ipc';

type Props = {
  tools: Tool[] | null;
  checking: boolean;
  hidden: boolean;
  /** Abre un terminal del proyecto con la orden; `null` sin proyecto abierto. */
  onLogin: ((command: string) => void) | null;
  onRefresh: () => void;
};

/** Estado de una herramienta en una palabra. */
export function toolState(t: Tool): 'ok' | 'sin sesión' | 'falta' | 'instalada' {
  if (!t.installed) return 'falta';
  if (t.loggedIn === false) return 'sin sesión';
  return t.loggedIn ? 'ok' : 'instalada';
}

/**
 * CLI que usa el IDE: instaladas o no y con sesión o no. El IDE no inicia
 * sesión por el usuario; abre un terminal con la orden para que la complete.
 */
export default function Tools({ tools, checking, hidden, onLogin, onRefresh }: Props) {
  return (
    <section className="coach" aria-label="Herramientas" hidden={hidden}>
      <div className="co-head">
        <span>herramientas</span>
        <span className="muted">CLI de los agentes, Node y GitHub</span>
        <span className="push" />
        <button className="co-link" onClick={onRefresh} disabled={checking}>
          {checking ? 'comprobando…' : 'volver a comprobar'}
        </button>
      </div>
      <div className="co-log">
        {!tools && <div className="muted">comprobando las herramientas…</div>}
        {tools?.map((t) => {
          const state = toolState(t);
          return (
            <div className="tool-row" key={t.id}>
              <span className={`tool-dot is-${state.replace(' ', '-')}`} aria-hidden="true" />
              <span className="tool-name">{t.name}</span>
              <span className="muted">{t.role}</span>
              <span className={`tool-state is-${state.replace(' ', '-')}`}>{state === 'instalada' ? 'instalada · sesión no comprobable' : state}</span>
              <span className="muted tool-detail" title={t.detail}>
                {t.detail}
              </span>
              {t.installed && t.login && state !== 'ok' && (
                <button
                  className="co-btn"
                  disabled={!onLogin}
                  onClick={() => onLogin?.(t.login!)}
                  title={onLogin ? `abre un terminal con «${t.login}»` : `abre un proyecto o ejecuta «${t.login}» en tu terminal`}
                >
                  iniciar sesión
                </button>
              )}
            </div>
          );
        })}
        {tools?.some((t) => !t.installed) && (
          <div className="co-aside">Instala las que faltan con su instalador habitual y vuelve a comprobar; la app las busca con el PATH de tu shell.</div>
        )}
      </div>
    </section>
  );
}
