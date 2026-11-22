import { useEffect, useState, type FormEvent } from 'react';
import GithubConnect from './GithubConnect';
import { Icon } from './GitPanel';
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
  const visible = tools?.filter(({ id }) => ['codex', 'claude', 'gh', 'node'].includes(id));
  return (
    <section className={settings ? "tr-settings-tools" : "coach"} aria-label="Herramientas" hidden={hidden}>
      <div className={settings ? "row tr-settings-heading" : "co-head"}>
        <span className="muted">CLI de los agentes, Node y GitHub</span>
        <span className={settings ? "grow" : "push"} />
        <button className="co-link" onClick={onRefresh} disabled={checking}>
          {checking ? 'comprobando…' : 'volver a comprobar'}
        </button>
      </div>
      <div className={settings ? "tr-settings-body" : "co-log"}>
        {!tools && <div className="muted">comprobando las herramientas…</div>}
        {visible?.map((t) => {
          const state = toolState(t);
          return (
            <div className={settings ? "srow tr-tool-row" : "tool-row"} key={t.id}>
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
        {!hidden && <CliUpdates onRefresh={onRefresh} last={autoUpdates ?? null} />}
        {!hidden && <JevRouting />}
      </div>
    </section>
  );
}

/** Aviso emergente de las CLI actualizadas o que fallaron en segundo plano. */
export function CliNotice({ updates, onOpen, onClose }: { updates: CliUpdate[]; onOpen: () => void; onClose: () => void }) {
  const done = updates.filter((u) => u.outcome === 'updated');
  const failed = updates.filter((u) => u.outcome === 'failed');
  const title = !failed.length
    ? done.length === 1 ? `${done[0].name} se ha actualizado` : `Se han actualizado ${done.length} CLI`
    : !done.length
      ? failed.length === 1 ? `No se pudo actualizar ${failed[0].name}` : `No se pudieron actualizar ${failed.length} CLI`
      : `${done.length} CLI actualizadas · ${failed.length} con errores`;
  const items = [...done, ...failed];
  return (
    <div className={`toast cli-toast${failed.length ? '' : ' is-ok'}`} role={failed.length ? 'alert' : 'status'}>
      <Icon name={failed.length ? 'warn' : 'check'} size={13} />
      <div className="cli-toast-body">
        <span className="cli-toast-title">{title}</span>
        <ul>
          {items.map((u) => (
            <li key={u.id}>
              {items.length > 1 && <span>{u.name}</span>}
              <span className="cli-toast-detail" title={u.detail}>{u.outcome === 'updated' ? u.to ?? u.detail : u.detail}</span>
            </li>
          ))}
        </ul>
      </div>
      <button className="co-link" onClick={onOpen}>detalles</button>
      <button className="icon" aria-label="Cerrar aviso" onClick={onClose}><Icon name="close" size={12} /></button>
    </div>
  );
}

/** Actualización de las CLI de IA: ajuste automático y último resultado. */
function CliUpdates({ onRefresh, last }: { onRefresh: () => void; last: CliUpdate[] | null }) {
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
    <section className="cli-updates" aria-label="Actualización de las CLI" aria-busy={updating}>
      <div className="cli-updates-head">
        <h2>Actualización de las CLI</h2>
        <button className="co-link" onClick={update} disabled={updating} title="ejecuta la orden de actualización de cada CLI de IA instalada">
          {updating ? 'actualizando…' : 'buscar ahora'}
        </button>
      </div>
      <label className="pub-check">
        <input type="checkbox" checked={auto ?? false} disabled={auto === null} onChange={(e) => toggle(e.target.checked)} />
        Actualizar automáticamente las CLI de IA
      </label>
      <p className="co-aside">Al abrir el IDE y cada 6 h se usa la orden de actualización de cada CLI. Si una está en uso, se espera a que quede libre.</p>
      {updates && (
        updates.length ? <ul className="cli-update-list" role="status">
          {updates.map((u) => (
            <li key={u.id}>
              <span className={`tool-dot is-${u.outcome}`} aria-hidden="true" />
              <span className="tool-name">{u.name}</span>
              <span className={`cli-update-state is-${u.outcome}`}>{UPDATE_LABEL[u.outcome]}</span>
              <span className="tool-detail" title={u.detail}>{u.outcome === 'current' ? u.from : u.detail}</span>
            </li>
          ))}
        </ul> : <p className="muted" role="status">No hay CLI de IA instaladas que se puedan actualizar.</p>
      )}
      {(error || saveError) && <p role="alert" className="co-error">{error ?? saveError}</p>}
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
