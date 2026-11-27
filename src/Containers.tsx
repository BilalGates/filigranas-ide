import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './GitPanel';
import {
  dockerContainers,
  localServices,
  type ContainerAction,
  type DockerContainer,
  type DockerView,
  type LocalService,
  type ServiceAction,
  type ServiceForm,
} from './ipc';
import { pushOperationalError } from './trama/notifications';

type Props = {
  project: string;
  projectName?: string | null;
  onOpen: (url: string) => void;
};

type TabId = 'docker' | 'services';

const SERVICE_LABELS: Record<LocalService['state'], string> = {
  stopped: 'Detenido',
  running: 'En marcha',
  exited: 'Finalizado',
  failed: 'Falló',
};

const DOCKER_STATE_LABELS: Record<string, string> = {
  running: 'En marcha',
  exited: 'Detenido',
  paused: 'En pausa',
  restarting: 'Reiniciando',
  created: 'Creado',
  dead: 'Caído',
};

const DOCKER_ACTION_LABELS: Record<ContainerAction, string> = {
  start: 'Arrancar',
  stop: 'Detener',
  restart: 'Reiniciar',
};

const DOCKER_STATUS_META: Record<string, { label: string; title: string; hint: string; tone: 'ok' | 'warn' | 'bad' }> = {
  ok: {
    label: 'Disponible',
    title: 'Motor Docker conectado',
    hint: '',
    tone: 'ok',
  },
  absent: {
    label: 'No instalado',
    title: 'Docker no está disponible en este equipo',
    hint: 'Instala Docker Desktop, OrbStack o Colima y asegúrate de que la CLI `docker` esté en el PATH de tu shell. Los servicios locales funcionan de forma independiente.',
    tone: 'warn',
  },
  stopped: {
    label: 'Daemon detenido',
    title: 'El motor de Docker no está en marcha',
    hint: 'Inicia Docker Desktop, OrbStack o Colima y pulsa «Volver a comprobar». Filigranas nunca arranca el daemon sin tu intervención.',
    tone: 'warn',
  },
  denied: {
    label: 'Sin permiso',
    title: 'Sin permiso para acceder al socket de Docker',
    hint: 'Comprueba los permisos del socket de Docker o el contexto activo (`docker context ls`) y vuelve a intentarlo.',
    tone: 'bad',
  },
  error: {
    label: 'Error de motor',
    title: 'No se pudo consultar el motor de Docker',
    hint: 'Revisa el mensaje de diagnóstico y comprueba que `docker ps` responde correctamente en tu terminal.',
    tone: 'bad',
  },
};

const EMPTY_FORM: ServiceForm = { id: null, name: '', command: '', port: null };
const SERVICES_POLL_MS = 3000;
const DOCKER_POLL_MS = 8000;

/** Extrae una URL local abrible desde un mapeo `127.0.0.1:5433→5432/tcp` o `8080→80/tcp`. */
function portToLocalUrl(mapping: string): string | null {
  const arrow = mapping.indexOf('→');
  if (arrow <= 0) return null;
  const left = mapping.slice(0, arrow);
  const match = left.match(/(?:([^:]+):)?(\d+)$/);
  if (!match) return null;
  const host = match[1] && match[1] !== '0.0.0.0' && match[1] !== '::' ? match[1] : 'localhost';
  const port = Number(match[2]);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return `http://${host}:${port}`;
}

export default function Containers({ project, projectName, onOpen }: Props) {
  const [tab, setTab] = useState<TabId>('docker');

  // ── Estado Docker ─────────────────────────────────────────────────────
  const [docker, setDocker] = useState<DockerView | null>(null);
  const [dockerLoading, setDockerLoading] = useState(true);
  const [dockerBusy, setDockerBusy] = useState(false);
  const [dockerError, setDockerError] = useState<string | null>(null);
  const [dockerRev, setDockerRev] = useState(0);
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ container: DockerContainer; action: ContainerAction } | null>(null);
  const [containerLogs, setContainerLogs] = useState<string | null>(null);
  const [logsTail, setLogsTail] = useState<number>(150);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const dockerLogRef = useRef<HTMLPreElement>(null);

  // ── Estado Servicios locales ──────────────────────────────────────────
  const [services, setServices] = useState<LocalService[] | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [form, setForm] = useState<ServiceForm | null>(null);
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [serviceRev, setServiceRev] = useState(0);
  const serviceLogRef = useRef<HTMLPreElement>(null);
  const serviceFollow = useRef(true);

  const projectLabel = projectName || project.split('/').filter(Boolean).pop() || project;

  // Polling Docker (solo cuando el motor no está ocupado en una mutación)
  useEffect(() => {
    if (dockerBusy) return;
    let alive = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const view = await dockerContainers.list(project);
        if (!alive) return;
        setDocker(view);
        setDockerError(null);
      } catch (e) {
        if (!alive) return;
        setDockerError(String(e));
      } finally {
        if (alive) {
          setDockerLoading(false);
          timer = window.setTimeout(load, DOCKER_POLL_MS);
        }
      }
    };
    void load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [project, dockerBusy, dockerRev]);

  // Polling Servicios locales (conserva el comportamiento existente)
  useEffect(() => {
    if (serviceBusy) return;
    let alive = true;
    let timer: number | undefined;
    let pollingError = false;
    const load = async () => {
      try {
        const next = await localServices.list(project, selectedServiceId);
        if (!alive) return;
        setServices(next);
        if (pollingError) setServiceError(null);
        pollingError = false;
      } catch (e) {
        if (!alive) return;
        pollingError = true;
        setServiceError(String(e));
      } finally {
        if (alive) timer = window.setTimeout(load, SERVICES_POLL_MS);
      }
    };
    void load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [project, selectedServiceId, serviceBusy, serviceRev]);

  const projectContainers = useMemo(
    () => (docker ? [...docker.compose, ...docker.linked] : []),
    [docker],
  );
  const linkedIds = useMemo(
    () => new Set((docker?.linked ?? []).map((c) => c.id)),
    [docker],
  );
  const selectedContainer = useMemo(
    () => projectContainers.find((c) => c.id === selectedContainerId) ?? null,
    [projectContainers, selectedContainerId],
  );

  // Cargar logs del contenedor seleccionado
  const loadContainerLogs = useCallback(async (id: string, tail: number) => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const out = await dockerContainers.logs(project, id, tail);
      setContainerLogs(out);
    } catch (e) {
      setLogsError(String(e));
    } finally {
      setLogsLoading(false);
    }
  }, [project]);

  useEffect(() => {
    if (!selectedContainer) {
      setContainerLogs(null);
      setLogsError(null);
      return;
    }
    void loadContainerLogs(selectedContainer.id, logsTail);
  }, [selectedContainer?.id, logsTail, loadContainerLogs]);

  useEffect(() => {
    if (dockerLogRef.current) {
      dockerLogRef.current.scrollTop = dockerLogRef.current.scrollHeight;
    }
  }, [containerLogs]);

  const activeService = services?.find((s) => s.id === selectedServiceId) ?? null;
  const serviceOutput = activeService?.logs;

  useEffect(() => {
    if (serviceLogRef.current && serviceFollow.current) {
      serviceLogRef.current.scrollTop = serviceLogRef.current.scrollHeight;
    }
  }, [serviceOutput, selectedServiceId]);

  const mutateDocker = async (op: () => Promise<void>) => {
    if (dockerBusy) return;
    setDockerBusy(true);
    setDockerError(null);
    try {
      await op();
    } catch (e) {
      const msg = String(e);
      setDockerError(msg);
      pushOperationalError(msg, { source: `Docker · ${projectLabel}` });
    } finally {
      setPendingAction(null);
      setDockerRev((r) => r + 1);
      setDockerBusy(false);
    }
  };

  const confirmDockerAction = () => {
    if (!pendingAction) return;
    const { container, action } = pendingAction;
    void mutateDocker(async () => {
      await dockerContainers.action(project, container.id, action);
      if (selectedContainerId === container.id) {
        void loadContainerLogs(container.id, logsTail);
      }
    });
  };

  const linkContainer = (c: DockerContainer) => void mutateDocker(async () => {
    await dockerContainers.link(project, c.id, c.name);
    setSelectedContainerId(c.id);
  });

  const unlinkContainer = (id: string) => void mutateDocker(async () => {
    await dockerContainers.unlink(id);
    if (selectedContainerId === id) setSelectedContainerId(null);
  });

  const selectService = (id: string | null) => {
    serviceFollow.current = true;
    setSelectedServiceId(id);
    setDeleteFor(null);
  };

  const mutateService = async (op: () => Promise<void>) => {
    if (serviceBusy) return;
    setServiceBusy(true);
    setServiceError(null);
    try {
      await op();
    } catch (e) {
      const msg = String(e);
      setServiceError(msg);
      pushOperationalError(msg, { source: `Servicios locales · ${projectLabel}` });
    } finally {
      setServiceRev((r) => r + 1);
      setServiceBusy(false);
    }
  };

  const actService = (id: string, action: ServiceAction) => void mutateService(async () => {
    await localServices.action(project, id, action);
    if (action === 'remove' && selectedServiceId === id) selectService(null);
  });

  const saveService = (value: ServiceForm) => void mutateService(async () => {
    const id = await localServices.save(project, value);
    selectService(id);
    setForm(null);
  });

  const runningDockerCount = projectContainers.filter((c) => c.state === 'running').length;
  const runningServicesCount = services?.filter((s) => s.state === 'running').length ?? 0;
  const statusMeta = DOCKER_STATUS_META[docker?.status ?? 'error'] ?? DOCKER_STATUS_META.error;

  return (
    <section className="ct-hub" aria-label="Contenedores y servicios locales">
      <header className="ct-header">
        <div className="ct-header-copy">
          <div className="ct-kicker">
            <span>Entorno de desarrollo</span>
            <span className="ct-dot-sep" aria-hidden="true">·</span>
            <span className="ct-proj-pill">{projectLabel}</span>
          </div>
          <h1>Contenedores y servicios</h1>
          <p className="ct-sub">
            Gestiona contenedores Docker y procesos locales de este proyecto por separado. Cambiar de proyecto o cerrar esta vista no detiene procesos en marcha.
          </p>
        </div>

        <div className="ct-tabs" role="tablist" aria-label="Tipo de entorno">
          <button
            type="button"
            role="tab"
            className={`ct-tab${tab === 'docker' ? ' is-on' : ''}`}
            aria-selected={tab === 'docker'}
            onClick={() => setTab('docker')}
          >
            <Icon name="box" size={14} />
            <span>Contenedores</span>
            {docker?.status === 'ok' && (
              <span className={`ct-tab-badge${runningDockerCount > 0 ? ' is-live' : ''}`}>
                {runningDockerCount}/{projectContainers.length}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            className={`ct-tab${tab === 'services' ? ' is-on' : ''}`}
            aria-selected={tab === 'services'}
            onClick={() => setTab('services')}
          >
            <Icon name="terminal" size={14} />
            <span>Servicios locales</span>
            {services && (
              <span className={`ct-tab-badge${runningServicesCount > 0 ? ' is-live' : ''}`}>
                {runningServicesCount}/{services.length}
              </span>
            )}
          </button>
        </div>
      </header>

      {tab === 'docker' ? (
        <div className="ct-body" role="tabpanel" aria-label="Contenedores Docker">
          <div className="ct-bar">
            <div className="ct-engine">
              <span className={`ct-status-dot is-${dockerLoading ? 'idle' : statusMeta.tone}`} />
              <span className="ct-engine-label">
                {dockerLoading
                  ? 'Comprobando motor Docker…'
                  : docker?.status === 'ok'
                    ? (docker.engine ?? 'Docker disponible')
                    : statusMeta.label}
              </span>
              {docker?.composeFiles.length ? (
                <span className="ct-compose-tag" title={docker.composeFiles.join(', ')}>
                  Compose: {docker.composeFiles.join(', ')}
                </span>
              ) : null}
            </div>
            <div className="ct-bar-actions">
              <button
                type="button"
                className="co-btn"
                disabled={dockerBusy || dockerLoading}
                onClick={() => { setDockerLoading(true); setDockerRev((r) => r + 1); }}
              >
                <Icon name="refresh" size={13} />
                <span>Actualizar</span>
              </button>
            </div>
          </div>

          {dockerError && (
            <p className="co-error" role="alert">{dockerError}</p>
          )}

          {!dockerLoading && docker && docker.status !== 'ok' && (
            <div className={`ct-unavailable is-${statusMeta.tone}`}>
              <div className="ct-unavailable-head">
                <Icon name="warn" size={16} />
                <h2>{statusMeta.title}</h2>
              </div>
              {docker.message && <p className="ct-unavailable-msg">{docker.message}</p>}
              <p className="ct-unavailable-hint">{statusMeta.hint}</p>
              <div className="ct-unavailable-actions">
                <button
                  type="button"
                  className="co-btn is-primary"
                  disabled={dockerBusy}
                  onClick={() => { setDockerLoading(true); setDockerRev((r) => r + 1); }}
                >
                  Volver a comprobar
                </button>
                <button
                  type="button"
                  className="co-btn"
                  onClick={() => setTab('services')}
                >
                  Ir a Servicios locales
                </button>
              </div>
            </div>
          )}

          {docker?.status === 'ok' && (
            <>
              {pendingAction && (
                <div className="ct-confirm" role="alertdialog" aria-label="Autorización de acción en Docker">
                  <div className="ct-confirm-text">
                    <strong>
                      ¿Autorizas {DOCKER_ACTION_LABELS[pendingAction.action].toLowerCase()} el contenedor <code>{pendingAction.container.name}</code>?
                    </strong>
                    <span>
                      Se ejecutará <code>docker {pendingAction.action} {pendingAction.container.id}</code> sobre el motor Docker local.
                    </span>
                  </div>
                  <div className="ct-confirm-actions">
                    <button
                      type="button"
                      className="co-btn is-primary"
                      disabled={dockerBusy}
                      onClick={confirmDockerAction}
                    >
                      Autorizar y {DOCKER_ACTION_LABELS[pendingAction.action].toLowerCase()}
                    </button>
                    <button
                      type="button"
                      className="co-btn"
                      disabled={dockerBusy}
                      onClick={() => setPendingAction(null)}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              <div className="ct-section">
                <div className="ct-sec-head">
                  <h2>Contenedores del proyecto</h2>
                  <span className="muted">
                    {projectContainers.length === 0
                      ? 'Sin contenedores asociados'
                      : `${runningDockerCount} en marcha · ${projectContainers.length} asociados`}
                  </span>
                </div>

                {projectContainers.length === 0 ? (
                  <div className="ct-empty">
                    <p>
                      {docker.composeFiles.length > 0
                        ? `Se detectó ${docker.composeFiles.join(', ')} en ${projectLabel}, pero no hay contenedores creados todavía.`
                        : `No hay contenedores de Docker Compose ni vinculados manualmente para ${projectLabel}.`}
                    </p>
                    {docker.unlinked.length > 0 && (
                      <p className="muted">
                        Hay {docker.unlinked.length} contenedor{docker.unlinked.length === 1 ? '' : 'es'} suelto{docker.unlinked.length === 1 ? '' : 's'} en el motor que puedes vincular abajo si pertenecen a este proyecto.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="ct-list">
                    {projectContainers.map((c) => {
                      const isRunning = c.state === 'running';
                      const isLinked = linkedIds.has(c.id);
                      const stat = docker.stats[c.id];
                      const isSelected = selectedContainerId === c.id;
                      return (
                        <div className={`ct-row${isSelected ? ' is-selected' : ''}`} key={c.id}>
                          <button
                            type="button"
                            className="ct-row-main"
                            aria-pressed={isSelected}
                            onClick={() => setSelectedContainerId(isSelected ? null : c.id)}
                          >
                            <span className={`ct-state-dot is-${c.state}`} title={DOCKER_STATE_LABELS[c.state] ?? c.state} />
                            <span className="ct-row-info">
                              <span className="ct-row-title">
                                <strong>{c.name}</strong>
                                {c.service && <span className="ct-pill">compose · {c.service}</span>}
                                {isLinked && <span className="ct-pill is-linked">vinculado</span>}
                                {c.health && <span className={`ct-pill is-health-${c.health}`}>{c.health}</span>}
                              </span>
                              <span className="ct-row-meta">
                                <span className="mono">{c.image}</span>
                                <span>·</span>
                                <span>{DOCKER_STATE_LABELS[c.state] ?? c.state}</span>
                                {stat && (
                                  <>
                                    <span>·</span>
                                    <span className="mono">CPU {stat.cpuPercent}</span>
                                    <span>·</span>
                                    <span className="mono">{stat.memUsage}</span>
                                  </>
                                )}
                              </span>
                              {c.ports.length > 0 && (
                                <span className="ct-ports">
                                  {c.ports.map((p) => (
                                    <span className="ct-port-chip mono" key={p}>{p}</span>
                                  ))}
                                </span>
                              )}
                            </span>
                          </button>

                          <div className="ct-row-actions">
                            {isRunning ? (
                              <>
                                <button
                                  type="button"
                                  className="co-btn"
                                  disabled={dockerBusy}
                                  onClick={() => setPendingAction({ container: c, action: 'restart' })}
                                >
                                  Reiniciar
                                </button>
                                <button
                                  type="button"
                                  className="co-btn"
                                  disabled={dockerBusy}
                                  onClick={() => setPendingAction({ container: c, action: 'stop' })}
                                >
                                  Detener
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="co-btn"
                                disabled={dockerBusy}
                                onClick={() => setPendingAction({ container: c, action: 'start' })}
                              >
                                Arrancar
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {selectedContainer && (
                <section className="ct-detail" aria-label={`Diagnóstico de ${selectedContainer.name}`}>
                  <div className="ct-detail-head">
                    <div>
                      <h3>{selectedContainer.name}</h3>
                      <p className="muted mono">
                        {selectedContainer.id} · {selectedContainer.image}
                      </p>
                    </div>
                    <div className="ct-detail-actions">
                      {selectedContainer.state === 'running' && selectedContainer.ports.map((p) => {
                        const url = portToLocalUrl(p);
                        if (!url) return null;
                        return (
                          <button type="button" key={p} className="co-btn" onClick={() => onOpen(url)}>
                            <Icon name="globe" size={13} />
                            <span>Abrir {url.replace('http://', '')}</span>
                          </button>
                        );
                      })}
                      {linkedIds.has(selectedContainer.id) && (
                        <button
                          type="button"
                          className="co-btn"
                          disabled={dockerBusy}
                          onClick={() => unlinkContainer(selectedContainer.id)}
                        >
                          Desvincular
                        </button>
                      )}
                      <button
                        type="button"
                        className="tb-btn"
                        aria-label="Cerrar panel de contenedor"
                        onClick={() => setSelectedContainerId(null)}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  </div>

                  {docker.stats[selectedContainer.id] && (
                    <div className="ct-stats-strip">
                      <span>CPU <strong className="mono">{docker.stats[selectedContainer.id].cpuPercent}</strong></span>
                      <span>Memoria <strong className="mono">{docker.stats[selectedContainer.id].memUsage}</strong></span>
                      <span>Uso RAM <strong className="mono">{docker.stats[selectedContainer.id].memPercent}</strong></span>
                    </div>
                  )}

                  <div className="ct-logs-bar">
                    <h4>Registros del contenedor</h4>
                    <div className="ct-logs-tools">
                      <select
                        aria-label="Cantidad de líneas de registro"
                        className="fsel"
                        value={logsTail}
                        onChange={(e) => setLogsTail(Number(e.target.value))}
                      >
                        <option value={100}>Últimas 100 líneas</option>
                        <option value={150}>Últimas 150 líneas</option>
                        <option value={400}>Últimas 400 líneas</option>
                      </select>
                      <button
                        type="button"
                        className="co-btn"
                        disabled={logsLoading}
                        onClick={() => void loadContainerLogs(selectedContainer.id, logsTail)}
                      >
                        <Icon name="refresh" size={12} />
                        <span>{logsLoading ? 'Leyendo…' : 'Actualizar'}</span>
                      </button>
                    </div>
                  </div>

                  {logsError && <p className="co-error" role="alert">{logsError}</p>}
                  <pre
                    ref={dockerLogRef}
                    className="service-log ct-log"
                    tabIndex={0}
                    aria-label={`Registros de ${selectedContainer.name}`}
                  >
                    {logsLoading && containerLogs === null
                      ? 'Leyendo registros de Docker…'
                      : containerLogs || 'Sin registros disponibles.'}
                  </pre>
                </section>
              )}

              {docker.unlinked.length > 0 && (
                <details className="ct-collapsible">
                  <summary>
                    <span>Contenedores sueltos en el equipo</span>
                    <span className="ct-count-pill">{docker.unlinked.length}</span>
                  </summary>
                  <p className="ct-collapsible-note">
                    Estos contenedores no pertenecen a ningún Compose de este proyecto. Vincúlalos solo si forman parte de {projectLabel}.
                  </p>
                  <div className="ct-list">
                    {docker.unlinked.map((c) => (
                      <div className="ct-row is-compact" key={c.id}>
                        <div className="ct-row-main is-static">
                          <span className={`ct-state-dot is-${c.state}`} />
                          <span className="ct-row-info">
                            <span className="ct-row-title"><strong>{c.name}</strong></span>
                            <span className="ct-row-meta">
                              <span className="mono">{c.image}</span>
                              <span>·</span>
                              <span>{DOCKER_STATE_LABELS[c.state] ?? c.state}</span>
                            </span>
                          </span>
                        </div>
                        <button
                          type="button"
                          className="co-btn"
                          disabled={dockerBusy}
                          onClick={() => linkContainer(c)}
                        >
                          Vincular al proyecto
                        </button>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {docker.images.length > 0 && (
                <details className="ct-collapsible">
                  <summary>
                    <span>Imágenes locales</span>
                    <span className="ct-count-pill">{docker.images.length}</span>
                  </summary>
                  <div className="ct-images">
                    {docker.images.map((img) => (
                      <div className="ct-image-row" key={`${img.id}:${img.repository}:${img.tag}`}>
                        <span className="ct-image-name mono">
                          <strong>{img.repository}</strong>:{img.tag}
                        </span>
                        <span className="ct-image-meta mono">{img.size}</span>
                        <span className="ct-image-meta">{img.createdSince}</span>
                        <span className="ct-image-id mono">{img.id}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="ct-body" role="tabpanel" aria-label="Servicios locales del proyecto">
          <div className="ct-bar">
            <div className="ct-engine">
              <span className={`ct-status-dot is-${runningServicesCount > 0 ? 'ok' : 'idle'}`} />
              <span className="ct-engine-label">
                Procesos directos del proyecto (fuera de Docker)
              </span>
              {services && (
                <span className="muted">
                  · {runningServicesCount} en marcha · {services.length} configurados
                </span>
              )}
            </div>
            <div className="ct-bar-actions">
              <button
                type="button"
                className="co-btn is-primary"
                disabled={serviceBusy || !!form}
                onClick={() => setForm(EMPTY_FORM)}
              >
                <Icon name="plus" size={13} />
                <span>Nuevo servicio</span>
              </button>
            </div>
          </div>

          {serviceError && <p className="co-error" role="alert">{serviceError}</p>}

          {form && (
            <form className="service-form" onSubmit={(e) => { e.preventDefault(); saveService(form); }}>
              <h3>{form.id ? 'Editar servicio local' : 'Nuevo servicio local'}</h3>
              <label>
                Nombre
                <input required maxLength={120} autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Frontend dev / API" />
              </label>
              <label>
                Comando
                <textarea required rows={2} maxLength={8192} value={form.command} placeholder="pnpm dev" onChange={(e) => setForm({ ...form, command: e.target.value })} />
              </label>
              <label>
                Puerto (opcional)
                <input type="number" min={1} max={65535} value={form.port ?? ''} placeholder="3000" onChange={(e) => setForm({ ...form, port: e.target.value ? Number(e.target.value) : null })} />
              </label>
              <p className="muted">
                El comando se ejecuta en la carpeta del proyecto con tus permisos de usuario (fuera de Docker). Si indicas un puerto, se pasa como <code>PORT</code> y se habilita la apertura directa en el navegador.
              </p>
              <div className="service-actions">
                <button type="submit" className="co-btn is-primary" disabled={serviceBusy || !form.name.trim() || !form.command.trim()}>Guardar</button>
                <button type="button" className="co-btn" disabled={serviceBusy} onClick={() => setForm(null)}>Cancelar</button>
              </div>
            </form>
          )}

          {services === null && !serviceError && <p className="muted">Cargando servicios locales…</p>}
          {!form && services?.length === 0 && (
            <div className="ct-empty">
              <p>Añade aquí servidores de desarrollo, APIs o watchers que se lancen mediante comandos locales de <strong>{projectLabel}</strong>.</p>
            </div>
          )}

          {!!services?.length && (
            <div className="service-list" aria-label="Servicios locales">
              {services.map((s) => (
                <div className="service-row" key={s.id}>
                  <button type="button" className="service-select" aria-pressed={selectedServiceId === s.id} onClick={() => selectService(s.id)}>
                    <Icon name="terminal" size={15} />
                    <span>
                      <strong>{s.name}</strong>
                      <small className="mono">{s.port ? `localhost:${s.port} · ${s.command}` : s.command}</small>
                    </span>
                    <span className="service-state" data-state={s.state}><i />{SERVICE_LABELS[s.state]}</span>
                  </button>
                  <button
                    type="button"
                    className="co-btn"
                    disabled={serviceBusy}
                    aria-label={`${s.state === 'running' ? 'Detener' : 'Arrancar'} ${s.name}`}
                    onClick={() => actService(s.id, s.state === 'running' ? 'stop' : 'start')}
                  >
                    {s.state === 'running' ? 'Detener' : 'Arrancar'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {activeService && !form && (
            <section className="service-detail ct-detail" aria-label={`Detalles de ${activeService.name}`}>
              <div className="service-detail-head">
                <h3>{activeService.name}</h3>
                <span className="muted mono">
                  {activeService.pid ? `PID ${activeService.pid}` : activeService.exitCode !== null ? `Salida ${activeService.exitCode}` : SERVICE_LABELS[activeService.state]}
                </span>
              </div>
              <code className="service-command">{activeService.command}</code>
              <div className="service-actions">
                {activeService.port && activeService.state === 'running' && (
                  <button type="button" className="co-btn" onClick={() => onOpen(`http://localhost:${activeService.port}`)}>
                    <Icon name="globe" size={14} /> Abrir en el navegador
                  </button>
                )}
                {activeService.state === 'running' ? (
                  <button type="button" className="co-btn" disabled={serviceBusy} onClick={() => actService(activeService.id, 'restart')}>Reiniciar</button>
                ) : (
                  <>
                    <button type="button" className="co-btn" disabled={serviceBusy} onClick={() => setForm({ id: activeService.id, name: activeService.name, command: activeService.command, port: activeService.port })}>Editar</button>
                    <button type="button" className="co-btn" disabled={serviceBusy} onClick={() => setDeleteFor(activeService.id)}>Quitar</button>
                  </>
                )}
              </div>
              {deleteFor === activeService.id && activeService.state !== 'running' && (
                <div className="ct-confirm is-inline">
                  <span>¿Quitar la configuración de <strong>{activeService.name}</strong>?</span>
                  <div className="ct-confirm-actions">
                    <button type="button" className="co-btn is-primary" disabled={serviceBusy} onClick={() => actService(activeService.id, 'remove')}>Confirmar</button>
                    <button type="button" className="co-btn" disabled={serviceBusy} onClick={() => setDeleteFor(null)}>Cancelar</button>
                  </div>
                </div>
              )}
              <h4>Registros</h4>
              <pre
                ref={serviceLogRef}
                className="service-log"
                tabIndex={0}
                aria-label={`Registros de ${activeService.name}`}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  serviceFollow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
                }}
              >
                {serviceOutput || 'Sin salida todavía.'}
              </pre>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
