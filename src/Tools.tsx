import { useEffect, useId, useState, type FormEvent } from 'react';
import GithubConnect from './GithubConnect';
import ProviderLogo from './ProviderLogo';
import { jev, tools as toolsApi, type CliUpdate, type JevSettings, type JevStatus, type Tool } from './ipc';

/** Resultado de una actualización en pocas palabras. */
const UPDATE_LABEL: Record<CliUpdate['outcome'], string> = {
  updated: 'actualizada',
  current: 'al día',
  busy: 'en uso',
  failed: 'no se actualizó',
};

type Props = {
  tools: Tool[] | null;
  checking: boolean;
  hidden: boolean;
  /** Abre un terminal del proyecto con la orden; `null` sin proyecto abierto. */
  onLogin: ((command: string) => void) | null;
  onRefresh: () => void;
  /** Último resultado de la actualización automática, si la hubo. */
  autoUpdates?: CliUpdate[] | null;
  surface?: 'settings';
};

/** Estado de una herramienta en una palabra. */
function toolState(t: Tool): 'ok' | 'sin sesión' | 'falta' | 'instalada' {
  if (!t.installed) return 'falta';
  if (t.loggedIn === false) return 'sin sesión';
  return t.loggedIn ? 'ok' : 'instalada';
}

/** Estado y acceso a las herramientas del IDE. */
export default function Tools({ tools, checking, hidden, onLogin, onRefresh, autoUpdates, surface }: Props) {
  const settings = surface === 'settings';
  const visible = tools?.filter(({ id }) => ['codex', 'claude', 'gh'].includes(id));
  // En Ajustes cada bloque es una tarjeta; en el panel emergente, una lista seguida.
  const block = settings ? 'tools-block tr-settings-card' : 'tools-block';
  return (
    <section className={settings ? 'tools-panel is-settings' : 'tools-panel coach'} aria-label="Herramientas" hidden={hidden}>
      <div className={settings ? 'tools-stack' : 'tools-stack co-log'}>
        <div className={block}>
          <div className="tools-head">
            <h3>CLI de los agentes y GitHub</h3>
            <button className="co-link" onClick={onRefresh} disabled={checking}>
              {checking ? 'comprobando…' : 'volver a comprobar'}
            </button>
          </div>
          <div className="tools-list-wrap">
            <ul className="tools-list" aria-busy={checking}>
              {!tools && <li className="muted tools-empty">comprobando las herramientas…</li>}
              {visible?.map((t) => {
                const state = toolState(t);
                const tone = state.replace(' ', '-');
                return (
                  <li className="tool-item" key={t.id}>
                    <span className="tool-logo"><ProviderLogo engine={t.id} size={16} /></span>
                    <span className="tool-main">
                      <span className="tool-name">{t.name}</span>
                      <span className="tool-role">{t.role}</span>
                    </span>
                    <span className={`tool-badge is-${tone}`}>
                      <span className="tool-dot" aria-hidden="true" />
                      {state === 'instalada' ? 'instalada · sesión no comprobable' : state}
                    </span>
                    <span className="tool-detail" title={t.detail}>{t.detail}</span>
                    {(t.id === 'gh' || (t.installed && t.login && state !== 'ok')) && <span className="tool-actions">
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
                    </span>}
                  </li>
                );
              })}
            </ul>
          </div>
          {visible?.some((t) => !t.installed) && (
            <p className="co-aside tools-note">Instala las que faltan con su instalador habitual y vuelve a comprobar; la app las busca con el PATH de tu shell.</p>
          )}
        </div>
        {!hidden && <CliUpdates className={block} onRefresh={onRefresh} last={autoUpdates ?? null} />}
        {!hidden && <JevRouting className={block} />}
      </div>
    </section>
  );
}

/** Actualización de las CLI de IA: ajuste automático y último resultado. */
function CliUpdates({ className, onRefresh, last }: { className: string; onRefresh: () => void; last: CliUpdate[] | null }) {
  const autoId = useId();
  const [auto, setAuto] = useState<boolean | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [checked, setChecked] = useState<CliUpdate[] | null>(null);
  // Lo buscado a mano manda sobre el último resultado automático.
  const updates = checked ?? last;
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = () => {
    setUpdating(true);
    setError(null);
    toolsApi.update().then(
      (list) => { setChecked(list); if (list.some((u) => u.outcome === 'updated')) onRefresh(); },
      (e) => setError(String(e)),
    ).finally(() => setUpdating(false));
  };
  useEffect(() => {
    let mounted = true;
    toolsApi.autoUpdate().then((on) => { if (mounted) setAuto(on); }, (e) => { if (mounted) setSaveError(String(e)); });
    return () => { mounted = false; };
  }, []);
  const toggle = (on: boolean) => {
    setSaveError(null);
    setAuto(on);
    toolsApi.autoUpdate(on).then(setAuto, (e) => { setAuto(!on); setSaveError(String(e)); });
  };
  return (
    <section className={`${className} cli-updates`} aria-label="Actualización de las CLI" aria-busy={updating}>
      <div className="tools-head">
        <h3>Actualización de las CLI</h3>
        <button className="co-link" onClick={update} disabled={updating} title="ejecuta la orden de actualización de cada CLI de IA instalada">
          {updating ? 'actualizando…' : 'buscar ahora'}
        </button>
      </div>
      <div className="tools-body">
        <div className="tools-option">
          <input id={`${autoId}-auto`} type="checkbox" checked={auto ?? false} disabled={auto === null} aria-describedby={`${autoId}-help`} onChange={(e) => toggle(e.target.checked)} />
          <label htmlFor={`${autoId}-auto`}>Actualizar automáticamente las CLI de IA</label>
          <p id={`${autoId}-help`} className="tools-help">Al abrir el IDE y cada 6 h se usa la orden de actualización de cada CLI. Si una está en uso, se espera a que quede libre.</p>
        </div>
        {updates && (
          updates.length ? <ul className="cli-update-list" role="status">
            {updates.map((u) => (
              <li key={u.id}>
                <span className="tool-logo"><ProviderLogo engine={u.id} size={14} /></span>
                <span className="tool-name">{u.name}</span>
                <span className={`cli-update-state is-${u.outcome}`}>{UPDATE_LABEL[u.outcome]}</span>
                <span className="tool-detail" title={u.detail}>{u.outcome === 'current' ? u.from : u.detail}</span>
              </li>
            ))}
          </ul> : <p className="muted" role="status">No hay CLI de IA instaladas que se puedan actualizar.</p>
        )}
        {(error || saveError) && <p role="alert" className="co-error">{error ?? saveError}</p>}
      </div>
    </section>
  );
}

function JevRouting({ className }: { className: string }) {
  const [status, setStatus] = useState<JevStatus | null>(null);
  const [personalKey, setPersonalKey] = useState('');
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
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
    <section className={`${className} jev-settings`} aria-label="Enrutamiento de tareas">
      <div className="tools-head">
        <h3>Enrutamiento con Jev</h3>
        {status && <span role="status" className={`tool-badge ${enabled ? 'is-ok' : 'is-instalada'}`}>{mode === 'active' ? 'Activo' : mode === 'shadow' ? 'Solo observación' : 'Local'}{enabled && ` · ${status.settings.model}`}</span>}
      </div>
      <div className="tools-body">
        {status && <form onSubmit={activate} className="jev-form">
          <div className="jev-fields">
            <label className="jev-field">
              <span className="jev-label">Política</span>
              <select value={policy} disabled={busy} onChange={(e) => setPolicy(e.target.value as JevSettings['policy'])}>
                <option value="economy">Económica</option>
                <option value="balanced">Equilibrada</option>
                <option value="quality">Calidad</option>
              </select>
            </label>
            <label className="jev-field">
              <span className="jev-label">Plazo de TypeSafe en segundos</span>
              <input type="number" min="1" max="10" required value={timeout || ''} disabled={busy} onChange={(e) => setTimeout(Number(e.target.value))} />
            </label>
            {policy === 'economy' && status.supported && <label className="jev-field is-wide">
              <span className="jev-label">Modelo de Codex para tareas sencillas</span>
              <select value={lightModel} disabled={busy} onChange={(e) => setLightModel(e.target.value)}>
                <option value="">Modelo habitual del coordinador</option>
                {lightModel && !status.codexModels.includes(lightModel) && <option value={lightModel}>{lightModel} · sin confirmar</option>}
                {status.codexModels.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
              {status.codexModels.length === 0 && <span className="tools-help">Abre el coordinador para cargar su catálogo.</span>}
            </label>}
          </div>
          {status.supported ? <>
            <div className="co-aside jev-credential">
              <label>Tu API key personal de TypeSafe
                <input type="password" autoComplete="off" spellCheck={false} value={personalKey} disabled={busy}
                  onChange={(e) => setPersonalKey(e.target.value)} aria-label="API key personal de TypeSafe" />
              </label>
              <p>Se guarda en el almacén seguro de tu usuario de macOS o Windows. Cada usuario configura su propia clave. Estado: {status.credential === 'available' ? 'disponible' : 'sin configurar o acceso nativo pendiente'}.</p>
              <button type="button" disabled={busy || !personalKey.trim()} onClick={() => {
                setBusy(true); setError(null);
                void jev.setCredential(personalKey).then(async () => {
                  setPersonalKey(''); setDiagnostic('Clave guardada. Prueba la conexión para comprobar la autenticación.'); setStatus(await jev.status());
                }).catch((e) => setError(String(e))).finally(() => setBusy(false));
              }}>Guardar / sustituir clave</button>
              <button type="button" disabled={busy} onClick={() => {
                setBusy(true); setError(null);
                void jev.testConnection().then((r) => setDiagnostic(r.authenticated
                  ? `Autenticación correcta · ${r.model ?? 'sin modelo compatible'} · ${r.durationMs} ms`
                  : `Conexión fallida · ${r.error} · ${r.durationMs} ms`)).catch((e) => setError(String(e))).finally(() => setBusy(false));
              }}>Probar conexión real</button>
              <button type="button" disabled={busy} onClick={() => {
                setBusy(true); setError(null);
                void jev.deleteCredential().then(async () => { setPersonalKey(''); setDiagnostic('Clave eliminada; Jev desactivado.'); setStatus(await jev.status()); })
                  .catch((e) => setError(String(e))).finally(() => setBusy(false));
              }}>Eliminar clave</button>
              {diagnostic && <p role="status">{diagnostic}</p>}
            </div>
            <div className="jev-checks">
              <label className="jev-check">
                <input type="checkbox" checked={shadow} disabled={busy} onChange={(e) => setShadow(e.target.checked)} />
                <span>Solo observar la recomendación y aplicar la política local</span>
              </label>
              <label className="jev-check">
                <input type="checkbox" checked={consent} disabled={busy} onChange={(e) => setConsent(e.target.checked)} />
                <span>Autorizo consultar el catálogo y enviar a api.typesafe.ai el riesgo, la prioridad, el tamaño aproximado y el estado del turno anterior de mis tareas automáticas, además de la política, el rol, el tamaño aproximado del encargo delegado y los proveedores autenticados disponibles. No se envían archivos, prompts ni credenciales de otros proveedores.</span>
              </label>
            </div>
          </> : <p className="muted">El almacén de credenciales de esta plataforma no está disponible para Jev.</p>}
          <div className="jev-actions">
            <button className="co-btn" type="button" disabled={busy || (!enabled && (timeout < 1 || timeout > 10))} onClick={() => void save('local')}>
              {enabled ? 'Desactivar Jev' : 'Guardar política local'}
            </button>
            {status.supported && <button className="co-btn is-primary" type="submit" disabled={busy || !consent}>{enabled ? 'Actualizar Jev' : 'Activar Jev'}</button>}
          </div>
        </form>}
        {error && <p role="alert" className="co-error">{error}</p>}
      </div>
    </section>
  );
}
