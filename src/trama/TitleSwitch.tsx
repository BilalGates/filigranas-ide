import { useEffect, useMemo, useRef, useState } from 'react';
import { git, type Project, type Session, type Workspace } from '../ipc';
import { ENGINE_LABEL } from '../Session';
import { Icon } from './icons';
import { AgDot, Sigil, sessionAgents, type Agent } from './kit';
import { pmActivityKey, type ActiveSelection } from './workspaceContext';

type MenuTarget =
  | { kind: 'pm'; project: string }
  | { kind: 'session'; sessionId: number; project: string };

function engineShort(engine: string): string {
  if (engine === 'claude') return 'Claude';
  if (engine === 'codex') return 'Codex';
  return ENGINE_LABEL[engine] ?? engine;
}

function sessionDisplayTitle(s: Session): string {
  const title = s.title?.trim() || s.name;
  return `${engineShort(s.engine)} · ${title}`;
}

/**
 * Selector superior global de sesiones (agrupadas por proyecto) + selector de
 * rama del proyecto derivado. Al elegir una sesión, establece la sesión activa
 * y deriva automáticamente el proyecto asociado sin cerrar herramientas abiertas.
 */
export default function TitleSwitch({
  ws,
  selection,
  project,
  sessionsByProject,
  pmProjects,
  pmClaudeByProject,
  activity,
  branch,
  onSelectSession,
  onBranched,
  onManage,
  onBranchTools,
  onError,
}: {
  ws: Workspace;
  selection: ActiveSelection;
  project: string | null;
  sessionsByProject: Record<string, Session[]>;
  pmProjects: ReadonlySet<string>;
  pmClaudeByProject: Record<string, Session | null>;
  activity: Record<string, 'trabajando' | 'permiso' | null>;
  branch: { label: string; ahead: number; behind: number; upstream: string | null } | null;
  onSelectSession: (next: Exclude<ActiveSelection, null>) => void;
  onBranched: () => void;
  onManage: () => void;
  onBranchTools: () => void;
  onError: (e: string) => void;
}) {
  const [menu, setMenu] = useState<'session' | 'branch' | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const activeProjects = useMemo(() => ws.projects.filter((p) => !p.archived), [ws.projects]);
  const current = activeProjects.find((p) => p.path === project) ?? null;

  useEffect(() => {
    if (!menu) return;
    const out = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setMenu(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', out);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', out);
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);

  useEffect(() => {
    setQ('');
    if (menu !== 'branch' || !project) return;
    let active = true;
    setBranches(null);
    void git.branches(project).then(
      (list) => { if (active) setBranches(list); },
      (error) => { if (active) { onError(String(error)); setBranches([]); } },
    );
    return () => { active = false; };
  }, [menu, project, onError]);

  const currentSessions = project ? sessionsByProject[project] ?? [] : [];
  const activeSession = selection?.kind === 'session'
    ? currentSessions.find((s) => s.id === selection.sessionId) ?? null
    : null;
  const activeSessionLabel = !current
    ? null
    : activeSession
      ? sessionDisplayTitle(activeSession)
      : 'Project Manager';
  const activeState = !current
    ? null
    : activeSession
      ? (activity[String(activeSession.id)] ?? (activeSession.status === 'trabajando' ? 'trabajando' : activeSession.status === 'esperando' ? 'permiso' : null))
      : (activity[pmActivityKey(current.path)] ?? null);

  const query = q.trim().toLowerCase();

  const groupedProjects = useMemo(() => {
    // Orden: proyecto activo primero, luego proyectos con sesiones o PM activos, luego el resto.
    const sorted = [...activeProjects].sort((a, b) => {
      if (a.path === project) return -1;
      if (b.path === project) return 1;
      const aScore = (sessionsByProject[a.path]?.length ?? 0) + (pmProjects.has(a.path) ? 1 : 0);
      const bScore = (sessionsByProject[b.path]?.length ?? 0) + (pmProjects.has(b.path) ? 1 : 0);
      if (aScore > 0 && bScore === 0) return -1;
      if (bScore > 0 && aScore === 0) return 1;
      return a.name.localeCompare(b.name, 'es');
    });

    const groups: Array<{
      project: Project;
      pmEnabled: boolean;
      pmEngine: string;
      pmAgent: Agent | null;
      pmMatches: boolean;
      pmSessionId: number | null;
      roots: Session[];
      childrenByParent: Map<number, Session[]>;
      orphanSubs: Session[];
      agentBySession: Map<number, Agent>;
    }> = [];

    for (const p of sorted) {
      const list = sessionsByProject[p.path] ?? [];
      const pmEnabled = pmProjects.has(p.path);
      const pmClaude = pmClaudeByProject[p.path] ?? null;
      const pmEngine = pmClaude?.engine === 'claude' ? 'Claude' : 'Codex';
      const agents = sessionAgents(list, activity, { engine: pmEngine }, p.path);
      const pmAgent = agents.find((a) => a.id === 'pm') ?? null;
      const agentBySession = new Map<number, Agent>();
      for (const a of agents) {
        if (a.session != null) agentBySession.set(a.session, a);
      }

      const projectMatches = !query || p.name.toLowerCase().includes(query);
      const pmMatches = projectMatches || 'project manager'.includes(query) || pmEngine.toLowerCase().includes(query);
      const matchedSessions = projectMatches
        ? list
        : list.filter((s) =>
            sessionDisplayTitle(s).toLowerCase().includes(query) ||
            s.name.toLowerCase().includes(query) ||
            (s.task?.toLowerCase().includes(query) ?? false),
          );

      if (!pmMatches && matchedSessions.length === 0) continue;

      const roots = matchedSessions.filter((s) => s.parentSession == null);
      const childrenByParent = new Map<number, Session[]>();
      const orphanSubs: Session[] = [];
      const pmSessionId = pmClaude?.id ?? null;

      for (const s of matchedSessions) {
        if (s.parentSession == null) continue;
        const hasParent = s.parentSession === pmSessionId || roots.some((r) => r.id === s.parentSession);
        if (!hasParent) {
          orphanSubs.push(s);
          continue;
        }
        const kids = childrenByParent.get(s.parentSession) ?? [];
        kids.push(s);
        childrenByParent.set(s.parentSession, kids);
      }

      groups.push({
        project: p,
        pmEnabled,
        pmEngine,
        pmAgent,
        pmMatches,
        pmSessionId,
        roots,
        childrenByParent,
        orphanSubs,
        agentBySession,
      });
    }
    return groups;
  }, [activeProjects, project, sessionsByProject, pmProjects, pmClaudeByProject, activity, query]);

  const firstTarget = useMemo<MenuTarget | null>(() => {
    for (const g of groupedProjects) {
      if (g.pmMatches) return { kind: 'pm', project: g.project.path };
      if (g.roots[0]) return { kind: 'session', sessionId: g.roots[0].id, project: g.project.path };
      if (g.orphanSubs[0]) return { kind: 'session', sessionId: g.orphanSubs[0].id, project: g.project.path };
    }
    return null;
  }, [groupedProjects]);

  const shownBranches = (branches ?? []).filter((b) => b.toLowerCase().includes(query));

  const pickSession = (target: MenuTarget) => {
    onSelectSession(target);
    setMenu(null);
  };

  const renderSessionRow = (
    p: Project,
    s: Session,
    agent: Agent | undefined,
    isSub: boolean,
  ) => {
    const isSelected = selection?.kind === 'session' && selection.sessionId === s.id && selection.project === p.path;
    const label = sessionDisplayTitle(s);
    const waiting = agent?.state === 'waiting';
    return (
      <button
        key={`s:${s.id}`}
        role="menuitem"
        className={`tb-sess-row${isSelected ? ' on' : ''}${isSub ? ' is-sub' : ''}`}
        onClick={() => pickSession({ kind: 'session', sessionId: s.id, project: p.path })}
        title={`${p.name} · ${label}`}
      >
        {agent ? <AgDot a={agent} s={11} /> : <span className="dot" />}
        <span className="grow tb-sess-name">{label}</span>
        {waiting && <span className="chip amber tiny">permiso</span>}
        {isSelected && <Icon name="check" size={12} />}
      </button>
    );
  };

  return (
    <div className="tb-switch" ref={root}>
      <button
        className={`tb-proj tb-session-trigger${menu === 'session' ? ' is-on' : ''}`}
        onClick={() => setMenu(menu === 'session' ? null : 'session')}
        aria-haspopup="menu"
        aria-expanded={menu === 'session'}
        aria-label={current ? `Sesión activa: ${current.name} · ${activeSessionLabel}` : 'Seleccionar sesión'}
        title={current ? `${current.name} · ${activeSessionLabel} — Cambiar de sesión` : 'Cambiar de sesión'}
      >
        {current ? <span className="tb-sig"><Sigil name={current.name} /></span> : <Icon name="folder" size={13} />}
        <span className="tb-name">{current?.name ?? 'Elige una sesión'}</span>
        {activeSessionLabel && <>
          <span className="tb-dot-sep" aria-hidden="true">·</span>
          <span className="tb-sess-current">{activeSessionLabel}</span>
        </>}
        {activeState && <span className={`dot is-${activeState}`} aria-hidden="true" />}
        <Icon name="down" size={11} />
      </button>
      {current && <>
        <span className="tb-sep">/</span>
        <button
          className={`tb-branch${menu === 'branch' ? ' is-on' : ''}`}
          onClick={() => setMenu(menu === 'branch' ? null : 'branch')}
          aria-haspopup="menu"
          aria-expanded={menu === 'branch'}
          aria-label={`Rama del proyecto: ${branch?.label ?? 'Leyendo rama'}`}
          title="Cambiar de rama"
        >
          <Icon name="branch" size={12} /><span className="mono">{branch?.label ?? '…'}</span>
          {branch?.upstream && <span className="tb-branch-sync" title={branch.upstream}>↑{branch.ahead} ↓{branch.behind}</span>}
          <Icon name="down" size={11} />
        </button>
      </>}
      {menu && (
        <div className={`tb-menu ${menu}`} role="menu" aria-label={menu === 'session' ? 'Sesiones por proyecto' : 'Ramas'}>
          <input
            autoFocus
            className="tb-q"
            placeholder={menu === 'session' ? 'Buscar proyecto o sesión' : 'Buscar rama'}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            aria-label={menu === 'session' ? 'Buscar proyecto o sesión' : 'Buscar rama'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && menu === 'session' && firstTarget) {
                pickSession(firstTarget);
              }
            }}
          />
          <div className="tb-list tv">
            {menu === 'session' ? (
              groupedProjects.length === 0 ? (
                <div className="tb-empty">Sin proyectos ni sesiones que coincidan.</div>
              ) : (
                groupedProjects.map((g) => {
                  const pmSelected = selection?.kind === 'pm' && selection.project === g.project.path;
                  const pmKids = g.pmSessionId != null ? (g.childrenByParent.get(g.pmSessionId) ?? []) : [];
                  return (
                    <div key={g.project.path} className="tb-proj-group" role="group" aria-label={g.project.name}>
                      <div className="tb-proj-head">
                        <span className="tb-sig"><Sigil name={g.project.name} /></span>
                        <span className="tb-proj-title">{g.project.name}</span>
                      </div>
                      {g.pmMatches && (
                        <button
                          role="menuitem"
                          className={`tb-sess-row${pmSelected ? ' on' : ''}`}
                          onClick={() => pickSession({ kind: 'pm', project: g.project.path })}
                          title={`${g.project.name} · Project Manager`}
                        >
                          {g.pmEnabled && g.pmAgent ? <AgDot a={g.pmAgent} s={11} /> : <Icon name="agent" size={11} />}
                          <span className="grow tb-sess-name">Project Manager</span>
                          {g.pmEnabled && <span className="tb-sess-meta">{g.pmEngine}</span>}
                          {g.pmAgent?.state === 'waiting' && <span className="chip amber tiny">permiso</span>}
                          {pmSelected && <Icon name="check" size={12} />}
                        </button>
                      )}
                      {pmKids.map((sub) => renderSessionRow(g.project, sub, g.agentBySession.get(sub.id), true))}
                      {g.roots.map((s) => (
                        <div key={`b:${s.id}`}>
                          {renderSessionRow(g.project, s, g.agentBySession.get(s.id), false)}
                          {(g.childrenByParent.get(s.id) ?? []).map((sub) =>
                            renderSessionRow(g.project, sub, g.agentBySession.get(sub.id), true),
                          )}
                        </div>
                      ))}
                      {g.orphanSubs.map((sub) => renderSessionRow(g.project, sub, g.agentBySession.get(sub.id), true))}
                    </div>
                  );
                })
              )
            ) : branches === null ? (
              <div className="tb-empty">Leyendo ramas…</div>
            ) : !shownBranches.length ? (
              <div className="tb-empty">Sin ramas que coincidan.</div>
            ) : (
              shownBranches.map((b) => (
                <button
                  key={b}
                  role="menuitem"
                  disabled={busy}
                  className={b === branch?.label ? 'on' : ''}
                  onClick={async () => {
                    if (!project || b === branch?.label) { setMenu(null); return; }
                    setBusy(true);
                    try { await git.switch(project, b); onBranched(); setMenu(null); } catch (e) { onError(String(e)); } finally { setBusy(false); }
                  }}
                >
                  <Icon name="branch" size={12} /><span className="grow mono">{b}</span>{b === branch?.label && <Icon name="check" size={12} />}
                </button>
              ))
            )}
          </div>
          <div className="tb-foot">
            <button role="menuitem" onClick={() => {
              setMenu(null);
              if (menu === 'session') onManage(); else onBranchTools();
            }}>
              {menu === 'session' ? 'Gestionar proyectos en Inicio' : 'Operaciones de rama'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
