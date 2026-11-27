import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  api,
  type HomeActivityItem,
  type HomeSummary,
  type RecentSession,
  type Session,
  type Workspace,
} from '../ipc';
import ProviderLogo from '../ProviderLogo';
import { ENGINE_LABEL } from '../Session';
import { useUi } from '../ui';
import { Icon } from './icons';
import { EmptyArt, Root, Sigil, StDot, ago } from './kit';
import {
  buildActivityFeed,
  buildAttentionItems,
  buildProjectLibrary,
  firstMeaningfulLine,
  rankContinueSessions,
  type ActivityFeedItem,
  type ActivityPhase,
  type AttentionTarget,
  type ContinueSessionItem,
  type ProjectLibraryEntry,
} from './homeModel';
import { Modal } from './ui';

const SUMMARY_LIMIT = 30;
const REFRESH_TTL_MS = 30_000;

function engineLabel(engine: string) {
  if (engine === 'claude') return 'Claude Code';
  if (engine === 'codex') return 'Codex';
  return ENGINE_LABEL[engine] ?? engine;
}

function relativeProjectPath(path: string, root: string | null) {
  if (root && path.startsWith(root)) {
    const trimmed = path.slice(root.length).replace(/^[\\/]+/, '');
    if (trimmed) return trimmed;
  }
  return path.split(/[\\/]/).slice(-2).join('/');
}

function activityIcon(item: ActivityFeedItem): string {
  if (item.phase === 'live') return 'play';
  switch (item.kind) {
    case 'permission': return 'warn';
    case 'task_done': return 'check';
    case 'task_failed':
    case 'run_failed': return 'warn';
    case 'review': return 'health';
    case 'delivery': return 'pr';
    case 'commit': return 'commit';
    default: return 'chat';
  }
}

export default function Home({
  active,
  ws,
  project,
  agentSessions,
  sessionsByProject,
  onWs,
  onProject,
  onSession,
  onOpenRecentSession,
  onWork,
  onCi,
  onError,
}: {
  active: boolean;
  ws: Workspace;
  project: string | null;
  agentSessions: Session[];
  sessionsByProject?: Record<string, Session[]>;
  onWs: (ws: Workspace) => void;
  onProject: (path: string) => void;
  onSession: (path: string, view: 'coach' | number) => void;
  onOpenRecentSession: (session: RecentSession) => void;
  onWork: (path: string, task?: number) => void;
  onCi: (path: string) => void;
  onError: (e: string) => void;
}) {
  const { activity } = useUi();
  const [summaryState, setSummaryState] = useState<{ key: string; snaps: Record<string, HomeSummary> }>({
    key: '',
    snaps: {},
  });
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [backendActivity, setBackendActivity] = useState<HomeActivityItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);

  const [showAllSessions, setShowAllSessions] = useState(false);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [activityFilter, setActivityFilter] = useState<'all' | ActivityPhase>('all');
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'activity' | 'name'>('activity');
  const [grouped, setGrouped] = useState(true);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const projects = useMemo(() => ws.projects.filter((p) => !p.archived), [ws.projects]);
  const allPaths = useMemo(() => projects.slice(0, 64).map((p) => p.path), [projects]);
  const summaryPaths = useMemo(() => {
    const list = projects.slice(0, SUMMARY_LIMIT).map((p) => p.path);
    if (project && projects.some((p) => p.path === project) && !list.includes(project)) {
      list.push(project);
    }
    return list;
  }, [projects, project]);

  const pathsKey = useMemo(() => JSON.stringify(allPaths), [allPaths]);
  const summaryKey = useMemo(() => JSON.stringify([summaryPaths, project]), [summaryPaths, project]);
  const snaps = summaryState.key === summaryKey ? summaryState.snaps : {};

  const shown = useRef(active);
  shown.current = active;
  const triggerLoad = useRef<() => void>(() => {});

  // Carga rápida desde SQLite (sesiones recientes y actividad) + resúmenes Git en paralelo.
  useEffect(() => {
    const paths: string[] = JSON.parse(pathsKey);
    const [sumPaths, focus]: [string[], string | null] = JSON.parse(summaryKey);
    if (!paths.length) {
      setRecentSessions([]);
      setBackendActivity([]);
      setSummaryState({ key: summaryKey, snaps: {} });
      setLoadingSessions(false);
      return;
    }

    let alive = true;
    let loading = false;
    let expiresAt = 0;
    let revision = 0;
    let debounce: number | undefined;

    const load = async () => {
      if (!alive || !shown.current || loading || document.hidden || Date.now() < expiresAt) return;
      const id = revision;
      loading = true;
      try {
        const [recentRes, actRes, sumRes] = await Promise.allSettled([
          api.recentSessions(paths, 48),
          api.homeActivity(paths, 24),
          api.homeSummary(sumPaths, focus),
        ]);
        if (!alive || id !== revision) return;
        expiresAt = Date.now() + REFRESH_TTL_MS;
        if (recentRes.status === 'fulfilled') setRecentSessions(recentRes.value);
        if (actRes.status === 'fulfilled') setBackendActivity(actRes.value);
        if (sumRes.status === 'fulfilled') {
          setSummaryState({
            key: summaryKey,
            snaps: Object.fromEntries(sumRes.value.map((item) => [item.path, item])),
          });
        }
      } finally {
        loading = false;
        if (alive) setLoadingSessions(false);
        if (alive && id !== revision) invalidate();
      }
    };

    const invalidate = () => {
      revision++;
      expiresAt = 0;
      window.clearTimeout(debounce);
      if (shown.current && !loading) debounce = window.setTimeout(load, 200);
    };

    triggerLoad.current = load;
    const subs = ['project-changed', 'tasks-changed', 'sessions-changed', 'workspace-changed'].map((ev) =>
      listen(ev, invalidate),
    );
    const onVisible = () => { if (!document.hidden && shown.current) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    const initial = window.setTimeout(() => void load(), 0);

    return () => {
      alive = false;
      window.clearTimeout(debounce);
      window.clearTimeout(initial);
      document.removeEventListener('visibilitychange', onVisible);
      for (const sub of subs) void sub.then((off) => off());
    };
  }, [pathsKey, summaryKey]);

  useEffect(() => {
    if (active) triggerLoad.current();
    else setCreating(false);
  }, [active]);

  const continueSessions = useMemo(
    () => rankContinueSessions(recentSessions, projects, activity, project, 16, sessionsByProject),
    [recentSessions, projects, activity, project, sessionsByProject],
  );

  const attentionItems = useMemo(
    () => buildAttentionItems({ projects, snaps, agentSessions, sessionsByProject, liveActivity: activity, currentProject: project }),
    [projects, snaps, agentSessions, sessionsByProject, activity, project],
  );

  const activityFeed = useMemo(
    () =>
      buildActivityFeed({
        continueSessions,
        attentionItems,
        backendActivity,
        snaps,
        projects,
        limit: 18,
      }),
    [continueSessions, attentionItems, backendActivity, snaps, projects],
  );

  const activityPhasesPresent = useMemo(() => {
    const set = new Set(activityFeed.map((item) => item.phase));
    return set;
  }, [activityFeed]);

  const visibleActivity = useMemo(() => {
    const filtered = activityFilter === 'all'
      ? activityFeed
      : activityFeed.filter((item) => item.phase === activityFilter);
    return showAllActivity ? filtered : filtered.slice(0, 6);
  }, [activityFeed, activityFilter, showAllActivity]);

  const projectSections = useMemo(
    () =>
      buildProjectLibrary({
        projects,
        groups: ws.groups,
        snaps,
        recentSessions,
        sessionsByProject,
        liveActivity: activity,
        currentProject: project,
        query,
        sortBy,
        grouped: grouped && ws.groups.length > 0,
      }),
    [projects, ws.groups, snaps, recentSessions, sessionsByProject, activity, project, query, sortBy, grouped],
  );

  const matchedProjectCount = useMemo(
    () => projectSections.reduce((sum, sec) => sum + sec.items.length, 0),
    [projectSections],
  );

  const liveRunningCount = useMemo(
    () => continueSessions.filter((s) => s.status.state === 'working').length,
    [continueSessions],
  );

  const openTarget = (target: AttentionTarget | { kind: 'recent_session'; session: RecentSession } | { kind: 'project'; project: string }) => {
    switch (target.kind) {
      case 'recent_session':
        onOpenRecentSession(target.session);
        return;
      case 'session':
        onSession(target.project, target.view);
        return;
      case 'task':
        onWork(target.project, target.taskId);
        return;
      case 'work':
        onWork(target.project);
        return;
      case 'ci':
        onCi(target.project);
        return;
      case 'project':
        onProject(target.project);
        return;
    }
  };

  const openProjectEntry = (entry: ProjectLibraryEntry) => {
    if (entry.latestSession) {
      onOpenRecentSession(entry.latestSession);
    } else {
      onProject(entry.project.path);
    }
  };

  const openFolder = async () => {
    try {
      const chosen = await open({ directory: true, defaultPath: ws.root ?? undefined });
      if (typeof chosen === 'string') onWs(await api.setRoot(chosen));
    } catch (e) {
      onError(String(e));
    }
  };

  const dateLabel = new Date().toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  if (!active) return null;

  const visibleSessions = showAllSessions ? continueSessions : continueSessions.slice(0, 5);
  const visibleAttention = showAllAttention ? attentionItems : attentionItems.slice(0, 5);

  return (
    <Root label="Inicio">
      <div className="home-hub scr">
        <div className="home-hub-inner">
          <header className="home-top">
            <div className="home-top-title">
              <div className="home-date">{dateLabel}</div>
              <h1>Inicio</h1>
            </div>
            {(liveRunningCount > 0 || attentionItems.length > 0) && (
              <div className="home-top-signals" aria-label="Estado actual">
                {attentionItems.length > 0 && (
                  <span className="chip amber">
                    {attentionItems.length} {attentionItems.length === 1 ? 'asunto pendiente' : 'asuntos pendientes'}
                  </span>
                )}
                {liveRunningCount > 0 && (
                  <span className="chip sky">
                    {liveRunningCount} en ejecución
                  </span>
                )}
              </div>
            )}
          </header>

          {/* A. CONTINUAR DONDE LO DEJASTE */}
          <section className="home-sec" aria-labelledby="home-sec-continue">
            <div className="home-sec-head">
              <h2 id="home-sec-continue">Continuar donde lo dejaste</h2>
              {continueSessions.length > 5 && (
                <button
                  type="button"
                  className="home-link"
                  aria-expanded={showAllSessions}
                  onClick={() => setShowAllSessions((v) => !v)}
                >
                  {showAllSessions ? 'Ver menos' : `Ver todas (${continueSessions.length})`}
                </button>
              )}
            </div>

            {loadingSessions && continueSessions.length === 0 ? (
              <p className="home-quiet" role="status">Cargando sesiones recientes…</p>
            ) : continueSessions.length === 0 ? (
              <div className="home-empty-inline">
                <p>No hay sesiones recientes todavía. Abre cualquier proyecto de tu biblioteca o crea uno nuevo para empezar.</p>
              </div>
            ) : (
              <div className="home-sessions" role="list">
                {visibleSessions.map((item, idx) => (
                  <ContinueSessionRow
                    key={item.key}
                    item={item}
                    primary={idx === 0}
                    onResume={() => onOpenRecentSession(item.session)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* B. NECESITA TU ATENCIÓN (se oculta si no hay asuntos reales) */}
          {attentionItems.length > 0 && (
            <section className="home-sec home-sec-attention" aria-labelledby="home-sec-attention">
              <div className="home-sec-head">
                <h2 id="home-sec-attention">Necesita tu atención</h2>
                {attentionItems.length > 5 && (
                  <button
                    type="button"
                    className="home-link"
                    aria-expanded={showAllAttention}
                    onClick={() => setShowAllAttention((v) => !v)}
                  >
                    {showAllAttention ? 'Ver menos' : `Ver los ${attentionItems.length}`}
                  </button>
                )}
              </div>
              <div className="home-attention-list" role="list">
                {visibleAttention.map((item) => (
                  <div
                    key={item.key}
                    role="listitem"
                    className={`home-alert${item.urgent ? ' is-urgent' : ''}`}
                  >
                    <span className="home-alert-dot"><StDot st={item.severity} s={12} /></span>
                    <div className="home-alert-body">
                      <div className="home-alert-title">{item.title}</div>
                      <div className="home-alert-meta">
                        <span className="home-alert-proj">{item.projectName}</span>
                        {item.detail && item.detail !== item.projectName && (
                          <>
                            <span className="home-sep" aria-hidden="true">·</span>
                            <span>{item.detail}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`btn sm${item.urgent ? ' warn' : ''}`}
                      onClick={() => openTarget(item.target)}
                    >
                      {item.action}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* C. ACTIVIDAD RECIENTE */}
          <section className="home-sec" aria-labelledby="home-sec-activity">
            <div className="home-sec-head">
              <h2 id="home-sec-activity">Actividad reciente</h2>
              <div className="home-sec-tools">
                {activityPhasesPresent.size > 1 && (
                  <div className="seg home-seg" role="tablist" aria-label="Filtrar actividad">
                    {([
                      ['all', 'Todo'],
                      ...(activityPhasesPresent.has('live') ? [['live', 'En curso']] : []),
                      ...(activityPhasesPresent.has('pending') ? [['pending', 'Pendiente']] : []),
                      ...(activityPhasesPresent.has('history') ? [['history', 'Histórico']] : []),
                    ] as ['all' | ActivityPhase, string][]).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={activityFilter === id}
                        className={activityFilter === id ? 'on' : ''}
                        onClick={() => setActivityFilter(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {activityFeed.length > 6 && (
                  <button
                    type="button"
                    className="home-link"
                    aria-expanded={showAllActivity}
                    onClick={() => setShowAllActivity((v) => !v)}
                  >
                    {showAllActivity ? 'Ver menos' : `Ver más (${activityFeed.length})`}
                  </button>
                )}
              </div>
            </div>

            {visibleActivity.length === 0 ? (
              <p className="home-quiet">Sin actividad reciente registrada.</p>
            ) : (
              <div className="home-activity-list" role="list">
                {visibleActivity.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="listitem"
                    className={`home-act-row is-${item.phase}`}
                    onClick={() => openTarget(item.target)}
                  >
                    <span className="home-act-ico" aria-hidden="true">
                      <Icon name={activityIcon(item)} size={13} />
                    </span>
                    <span className="home-act-main">
                      <span className="home-act-title">{item.title}</span>
                      {item.detail && <span className="home-act-detail">{item.detail}</span>}
                    </span>
                    <span className="home-act-proj">{item.projectName}</span>
                    <span className={`home-phase is-${item.phase}`}>
                      {item.phase === 'live' ? 'En curso' : item.phase === 'pending' ? 'Pendiente' : 'Histórico'}
                    </span>
                    <span className="home-act-time">
                      {item.phase === 'live' ? 'ahora' : item.timestampMs ? ago(item.timestampMs) : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* D. BIBLIOTECA DE PROYECTOS */}
          <section className="home-sec home-sec-projects" aria-labelledby="home-sec-projects">
            <div className="home-sec-head home-lib-head">
              <div className="home-lib-title">
                <h2 id="home-sec-projects">Proyectos</h2>
                <span className="home-count">{query.trim() ? `${matchedProjectCount} de ${projects.length}` : projects.length}</span>
              </div>
              <div className="home-lib-actions">
                <button type="button" className="btn sm" onClick={openFolder}>
                  <Icon name="folder" size={13} /> Abrir carpeta
                </button>
                <button type="button" className="btn sm" onClick={() => setCreating(true)}>
                  <Icon name="plus" size={13} /> Nuevo proyecto
                </button>
              </div>
            </div>

            {projects.length > 0 && (
              <div className="home-lib-bar">
                <label className="home-search">
                  <Icon name="search" size={13} />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.currentTarget.value)}
                    placeholder="Buscar proyecto, rama o sesión…"
                    aria-label="Buscar proyectos"
                  />
                  {query && (
                    <button
                      type="button"
                      className="home-search-clear"
                      aria-label="Limpiar búsqueda"
                      onClick={() => setQuery('')}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  )}
                </label>

                <div className="home-lib-controls">
                  <div className="seg home-seg" role="group" aria-label="Ordenar proyectos">
                    <button
                      type="button"
                      className={sortBy === 'activity' ? 'on' : ''}
                      aria-pressed={sortBy === 'activity'}
                      onClick={() => setSortBy('activity')}
                    >
                      Actividad
                    </button>
                    <button
                      type="button"
                      className={sortBy === 'name' ? 'on' : ''}
                      aria-pressed={sortBy === 'name'}
                      onClick={() => setSortBy('name')}
                    >
                      Nombre
                    </button>
                  </div>
                  {ws.groups.length > 0 && (
                    <button
                      type="button"
                      className={`btn sm${grouped ? ' on' : ''}`}
                      aria-pressed={grouped}
                      onClick={() => setGrouped((v) => !v)}
                      title="Agrupar por grupos"
                    >
                      <Icon name="layers" size={12} /> Grupos
                    </button>
                  )}
                </div>
              </div>
            )}

            {projects.length === 0 ? (
              <div className="empty">
                <EmptyArt />
                <h3>Sin proyectos</h3>
                <p>La carpeta {ws.root} no tiene proyectos todavía.</p>
              </div>
            ) : projectSections.length === 0 ? (
              <div className="home-empty-inline">
                <p>Ningún proyecto coincide con «{query.trim()}».</p>
              </div>
            ) : (
              <div className="home-lib-sections">
                {projectSections.map((section) => (
                  <div className="home-lib-group" key={section.key}>
                    {section.label && <h3 className="pgroup">{section.label}</h3>}
                    <ul className="home-lib-list">
                      {section.items.map((entry) => (
                        <ProjectLibraryRow
                          key={entry.project.path}
                          entry={entry}
                          root={ws.root}
                          expanded={expandedProject === entry.project.path}
                          onToggleSessions={() =>
                            setExpandedProject((curr) => (curr === entry.project.path ? null : entry.project.path))
                          }
                          onOpen={() => openProjectEntry(entry)}
                          onOpenSession={onOpenRecentSession}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {ws.root && (
              <footer className="home-root-foot" title={ws.root}>
                <Icon name="folder" size={11} />
                <span className="mono">{ws.root}</span>
              </footer>
            )}
          </section>
        </div>
      </div>

      {creating && (
        <NewProject
          root={ws.root ?? ''}
          onClose={() => setCreating(false)}
          onDone={(next, path) => {
            onWs(next);
            setCreating(false);
            if (path) onProject(path);
          }}
        />
      )}
    </Root>
  );
}

function ContinueSessionRow({
  item,
  primary,
  onResume,
}: {
  item: ContinueSessionItem;
  primary: boolean;
  onResume: () => void;
}) {
  const { session, projectName, description, status } = item;
  const dotState =
    status.state === 'waiting'
      ? 'waiting'
      : status.state === 'working'
        ? session.isPm
          ? 'thinking'
          : 'working'
        : status.state === 'failed'
          ? 'blocked'
          : status.state === 'paused'
            ? 'paused'
            : 'idle';

  return (
    <button
      type="button"
      role="listitem"
      className={`home-sess${primary ? ' is-primary' : ''}${status.state === 'closed' ? ' is-closed' : ''}${status.state === 'waiting' ? ' is-waiting' : ''}`}
      onClick={onResume}
      aria-label={`Retomar ${session.name} en ${projectName}`}
      title={`${projectName} · ${session.name}`}
    >
      <span className="home-sess-sigil">
        <Sigil name={projectName} />
      </span>

      <span className="home-sess-body">
        <span className="home-sess-top">
          <span className="home-sess-name">{session.name}</span>
          {session.isPm && <span className="home-badge">PM</span>}
          <span className="home-sep" aria-hidden="true">·</span>
          <span className="home-sess-proj">{projectName}</span>
          {session.branch && (
            <span className="home-sess-branch mono">
              <Icon name="branch" size={11} />
              {session.branch}
            </span>
          )}
        </span>

        <span className="home-sess-sub">
          <span className="home-sess-eng">
            <ProviderLogo engine={session.engine} size={11} />
            {engineLabel(session.engine)}
          </span>
          {description && (
            <>
              <span className="home-sep" aria-hidden="true">·</span>
              <span className="home-sess-desc">{description}</span>
            </>
          )}
        </span>
      </span>

      <span className="home-sess-right">
        <span className={`home-status is-${status.state}`}>
          <StDot st={dotState} s={10} />
          <span>{status.label}</span>
        </span>
        <span className="home-sess-time mono">{ago(session.lastActiveMs)}</span>
        <span className={`home-sess-go${primary ? ' is-lead' : ''}`} aria-hidden="true">
          <Icon name="play" size={11} />
          <span>Retomar</span>
        </span>
      </span>
    </button>
  );
}

function ProjectLibraryRow({
  entry,
  root,
  expanded,
  onToggleSessions,
  onOpen,
  onOpenSession,
}: {
  entry: ProjectLibraryEntry;
  root: string | null;
  expanded: boolean;
  onToggleSessions: () => void;
  onOpen: () => void;
  onOpenSession: (session: RecentSession) => void;
}) {
  const { project, branch, sessions, latestSession, lastActivityMs, attentionCount, runningCount, liveWorkingCount, liveWaitingCount, snap, isCurrent } = entry;
  const ci = snap?.ci;
  const failedCi = ci?.checksKnown && ci.checksState === 'failure';
  const relPath = relativeProjectPath(project.path, root);
  const openLabel = latestSession ? `Abrir ${project.name} (${latestSession.name})` : `Abrir ${project.name}`;

  return (
    <li className={`home-proj-item${isCurrent ? ' is-current' : ''}${expanded ? ' is-expanded' : ''}`}>
      <div className="home-proj-row">
        <button
          type="button"
          className="home-proj-main"
          onClick={onOpen}
          aria-current={isCurrent ? 'true' : undefined}
          aria-label={openLabel}
          title={project.path}
        >
          <span className="home-proj-sigil"><Sigil name={project.name} /></span>
          <span className="home-proj-id">
            <span className="home-proj-line">
              <span className="home-proj-name">{project.name}</span>
              {branch && (
                <span className="home-proj-branch mono">
                  <Icon name="branch" size={11} />
                  {branch}
                </span>
              )}
            </span>
            <span className="home-proj-path mono">
              {latestSession
                ? `${latestSession.name}${firstMeaningfulLine(latestSession.task, 54) ? ` · ${firstMeaningfulLine(latestSession.task, 54)}` : ''}`
                : relPath}
            </span>
          </span>

          <span className="home-proj-state">
            {liveWaitingCount > 0 && <span className="chip amber">permiso</span>}
            {liveWorkingCount > 0 && <span className="chip sky">{liveWorkingCount} en curso</span>}
            {attentionCount > 0 && <span className="chip amber">{attentionCount} atención</span>}
            {runningCount > 0 && liveWorkingCount === 0 && <span className="chip sky">{runningCount} tareas</span>}
            {snap?.work && (
              <span className="chip">{snap.work.state === 'review' ? 'en revisión' : 'trabajo'}</span>
            )}
            {ci && (
              <span className={`chip${failedCi ? ' coral' : ''}`}>
                {failedCi ? `PR #${ci.number} · CI` : `PR #${ci.number}`}
              </span>
            )}
          </span>

          <span className="home-proj-time mono">
            {lastActivityMs ? ago(lastActivityMs) : ''}
          </span>
        </button>

        {sessions.length > 0 && (
          <button
            type="button"
            className={`home-proj-sessions-btn${expanded ? ' is-open' : ''}`}
            aria-expanded={expanded}
            aria-label={`Sesiones de ${project.name} (${sessions.length})`}
            title={`Ver ${sessions.length} ${sessions.length === 1 ? 'sesión' : 'sesiones'} de ${project.name}`}
            onClick={onToggleSessions}
          >
            <Icon name="chat" size={12} />
            <span>{sessions.length}</span>
            <Icon name="down" size={11} />
          </button>
        )}
      </div>

      {expanded && sessions.length > 0 && (
        <div className="home-proj-drawer" role="list" aria-label={`Sesiones de ${project.name}`}>
          {sessions.slice(0, 6).map((s) => (
            <button
              key={`${s.project}:${s.sessionId ?? 'pm'}`}
              type="button"
              role="listitem"
              className={`home-proj-subsess${s.closed ? ' is-closed' : ''}`}
              onClick={() => onOpenSession(s)}
            >
              <ProviderLogo engine={s.engine} size={11} />
              <span className="home-proj-subname">{s.name}</span>
              {s.isPm && <span className="home-badge">PM</span>}
              {firstMeaningfulLine(s.task, 64) && (
                <span className="home-proj-subtask">{firstMeaningfulLine(s.task, 64)}</span>
              )}
              {s.closed && <span className="home-proj-subtag">cerrada</span>}
              <span className="home-proj-subtime mono">{ago(s.lastActiveMs)}</span>
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function NewProject({
  root,
  onClose,
  onDone,
}: {
  root: string;
  onClose: () => void;
  onDone: (ws: Workspace, path: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.createProject(n);
      onDone(next, next.projects.find((p) => p.name === n)?.path ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Nuevo proyecto" onClose={onClose}>
      <p>Se crea una carpeta nueva en {root}.</p>
      <label className="tr-field-row">
        Nombre
        <input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && create()}
          autoFocus
        />
      </label>
      {error && <div className="tr-error" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <div className="acts">
        <button type="button" className="tr-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className={`tr-btn pearl${busy ? ' busy' : ''}`} disabled={!name.trim() || busy} onClick={create}>
          Crear
        </button>
      </div>
    </Modal>
  );
}
