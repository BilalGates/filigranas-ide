import { useEffect, useState, type FormEvent } from 'react';
import GithubConnect from './GithubConnect';
import { jev, type JevSettings, type JevStatus, type Tool } from './ipc';

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

/** Estado y acceso a las herramientas del IDE. */
export default function Tools({ tools, checking, hidden, onLogin, onRefresh }: Props) {
  const visible = tools?.filter(({ id }) => ['codex', 'claude', 'gh', 'node'].includes(id));
  return (
    <section className="coach" aria-label="Herramientas" hidden={hidden}>
      <div className="co-head">
        <span className="muted">CLI de los agentes, Node y GitHub</span>
        <span className="push" />
        <button className="co-link" onClick={onRefresh} disabled={checking}>
          {checking ? 'comprobando…' : 'volver a comprobar'}
        </button>
      </div>
      <div className="co-log">
        {!tools && <div className="muted">comprobando las herramientas…</div>}
        {visible?.map((t) => {
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
              {t.id === 'gh' && <GithubConnect tool={t} onRefresh={onRefresh} />}
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
        {visible?.some((t) => !t.installed) && (
          <div className="co-aside">Instala las que faltan con su instalador habitual y vuelve a comprobar; la app las busca con el PATH de tu shell.</div>
        )}
        {!hidden && <JevRouting />}
      </div>
    </section>
  );
}

function JevRouting() {
  const [status, setStatus] = useState<JevStatus | null>(null);
  const [policy, setPolicy] = useState<JevSettings['policy']>('balanced');
  const [timeout, setTimeout] = useState(3);
  const [lightModel, setLightModel] = useState('');
  const [shadow, setShadow] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    jev.status().then((value) => {
      if (!mounted) return;
      setStatus(value);
      setPolicy(value.settings.policy);
      setTimeout(value.settings.timeoutSecs);
      setLightModel(value.settings.lightModel ?? '');
      setShadow(value.settings.mode === 'shadow');
    }, (e) => { if (mounted) setError(String(e)); });
    return () => { mounted = false; };
  }, []);

  const save = async (mode: JevSettings['mode']) => {
    setBusy(true);
    setError(null);
    try {
      const timeoutSecs = mode === 'local' && (timeout < 1 || timeout > 10) ? status?.settings.timeoutSecs ?? 3 : timeout;
      const next = await jev.configure({ mode, policy, timeoutSecs, consent, lightModel: lightModel || null });
      setStatus(next);
      setTimeout(next.settings.timeoutSecs);
      setConsent(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const activate = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && consent && status?.supported) void save(shadow ? 'shadow' : 'active');
  };
  const mode = status?.settings.mode;
  const enabled = mode === 'active' || mode === 'shadow';

  return (
    <section className="jev-settings" aria-label="Enrutamiento de tareas">
      <h2>Enrutamiento con Jev</h2>
      {status && <p role="status">{mode === 'active' ? 'Activo' : mode === 'shadow' ? 'Solo observación' : 'Local'}{enabled && ` · ${status.settings.model}`}</p>}
      {status && <form onSubmit={activate} className="task-form">
        <div className="jev-options">
          <label>Política
            <select value={policy} disabled={busy} onChange={(e) => setPolicy(e.target.value as JevSettings['policy'])}>
              <option value="economy">Económica</option>
              <option value="balanced">Equilibrada</option>
              <option value="quality">Calidad</option>
            </select>
          </label>
          <label>Plazo de TypeSafe en segundos
            <input type="number" min="1" max="10" required value={timeout || ''} disabled={busy} onChange={(e) => setTimeout(Number(e.target.value))} />
          </label>
        </div>
        {policy === 'economy' && status.supported && <label>Modelo de Codex para tareas sencillas
          <select value={lightModel} disabled={busy} onChange={(e) => setLightModel(e.target.value)}>
            <option value="">Modelo habitual del coordinador</option>
            {lightModel && !status.codexModels.includes(lightModel) && <option value={lightModel}>{lightModel} · sin confirmar</option>}
            {status.codexModels.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          {status.codexModels.length === 0 && <span className="muted">Abre el coordinador para cargar su catálogo.</span>}
        </label>}
        {status.supported ? <>
          <details className="co-aside">
            <summary>Configurar la credencial del sistema</summary>
            <p>Guarda tu clave de TypeSafe como contraseña genérica en el llavero de inicio de sesión de macOS o en el Administrador de credenciales de Windows. Usa <code>{status.service}</code> como nombre y <code>{status.account}</code> como cuenta. Si macOS pide acceso, permite el acceso permanente para los turnos automáticos.</p>
          </details>
          <label className="jev-check"><input type="checkbox" checked={shadow} disabled={busy} onChange={(e) => setShadow(e.target.checked)} />Solo observar la recomendación y aplicar la política local</label>
          <label className="jev-check">
            <input type="checkbox" checked={consent} disabled={busy} onChange={(e) => setConsent(e.target.checked)} />
            <span>Autorizo consultar el catálogo y enviar a api.typesafe.ai el riesgo, la prioridad, el tamaño aproximado y el estado del turno anterior de mis tareas automáticas, además de la política y las opciones de Codex disponibles.</span>
          </label>
        </> : <p className="muted">El almacén de credenciales de esta plataforma no está disponible para Jev.</p>}
        <div className="jev-options">
          {status.supported && <button className="co-btn" type="submit" disabled={busy || !consent}>{enabled ? 'Actualizar Jev' : 'Activar Jev'}</button>}
          <button className="co-btn" type="button" disabled={busy || (!enabled && (timeout < 1 || timeout > 10))} onClick={() => void save('local')}>
            {enabled ? 'Desactivar Jev' : 'Guardar política local'}
          </button>
        </div>
      </form>}
      {error && <p role="alert" className="co-error">{error}</p>}
    </section>
  );
}
