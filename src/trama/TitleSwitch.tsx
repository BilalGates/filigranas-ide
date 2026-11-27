import { useEffect, useRef, useState } from 'react';
import { git, type Session, type Workspace } from '../ipc';
import { ENGINE_LABEL } from '../Session';
import { Icon } from './icons';
import { Sigil } from './kit';
import { pmActivityKey, type ActiveSelection } from './workspaceContext';

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
 * Indicador superior no desplegable del contexto activo (`Proyecto / Sesión`)
 * junto al selector de rama Git del proyecto derivado. La navegación entre
 * proyectos y sesiones vive en el explorador lateral y la búsqueda global (⌘K).
 */
export default function TitleSwitch({
  ws,
  selection,
  project,
  sessionsByProject,
  activity,
  branch,
  onBranched,
  onBranchTools,
  onError,
}: {
  ws: Workspace;
  selection: ActiveSelection;
  project: string | null;
  sessionsByProject: Record<string, Session[]>;
  activity: Record<string, 'trabajando' | 'permiso' | null>;
  branch: { label: string; ahead: number; behind: number; upstream: string | null } | null;
  onBranched: () => void;
  onBranchTools: () => void;
  onError: (e: string) => void;
}) {
  const [branchMenu, setBranchMenu] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const current = ws.projects.find((p) => !p.archived && p.path === project) ?? null;

  useEffect(() => {
    if (!branchMenu) return;
    const out = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setBranchMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setBranchMenu(false); };
    document.addEventListener('pointerdown', out);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', out);
      document.removeEventListener('keydown', esc);
    };
  }, [branchMenu]);

  useEffect(() => {
    setQ('');
    if (!branchMenu || !project) return;
    let active = true;
    setBranches(null);
    void git.branches(project).then(
      (list) => { if (active) setBranches(list); },
      (error) => { if (active) { onError(String(error)); setBranches([]); } },
    );
    return () => { active = false; };
  }, [branchMenu, project, onError]);

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

  const shownBranches = (branches ?? []).filter((b) => b.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="tb-switch" ref={root}>
      <div
        className="tb-context"
        aria-label={current ? `Contexto activo: ${current.name} / ${activeSessionLabel}` : 'Sin sesión activa'}
        title={current ? `${current.name} / ${activeSessionLabel}` : undefined}
        data-tauri-drag-region
      >
        {current ? (
          <>
            <span className="tb-sig"><Sigil name={current.name} /></span>
            <span className="tb-name">{current.name}</span>
            <span className="tb-sep" aria-hidden="true">/</span>
            <span className="tb-sess-current">{activeSessionLabel}</span>
            {activeState && <span className={`dot is-${activeState}`} aria-hidden="true" />}
          </>
        ) : (
          <span className="tb-ctx-empty">Sin sesión activa</span>
        )}
      </div>

      {current && (
        <>
          <span className="tb-sep tb-branch-sep" aria-hidden="true">·</span>
          <button
            type="button"
            className={`tb-branch${branchMenu ? ' is-on' : ''}`}
            onClick={() => setBranchMenu((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={branchMenu}
            aria-label={`Rama del proyecto: ${branch?.label ?? 'Leyendo rama'}`}
            title="Cambiar de rama"
          >
            <Icon name="branch" size={12} />
            <span className="mono">{branch?.label ?? '…'}</span>
            {branch?.upstream && <span className="tb-branch-sync" title={branch.upstream}>↑{branch.ahead} ↓{branch.behind}</span>}
            <Icon name="down" size={11} />
          </button>
        </>
      )}

      {branchMenu && current && (
        <div className="tb-menu branch" role="menu" aria-label="Ramas">
          <input
            autoFocus
            className="tb-q"
            placeholder="Buscar rama"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            aria-label="Buscar rama"
          />
          <div className="tb-list">
            {branches === null ? (
              <div className="tb-empty">Leyendo ramas…</div>
            ) : !shownBranches.length ? (
              <div className="tb-empty">Sin ramas que coincidan.</div>
            ) : (
              shownBranches.map((b) => (
                <button
                  key={b}
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  className={b === branch?.label ? 'on' : ''}
                  onClick={async () => {
                    if (!project || b === branch?.label) { setBranchMenu(false); return; }
                    setBusy(true);
                    try { await git.switch(project, b); onBranched(); setBranchMenu(false); } catch (e) { onError(String(e)); } finally { setBusy(false); }
                  }}
                >
                  <Icon name="branch" size={12} />
                  <span className="grow mono">{b}</span>
                  {b === branch?.label && <Icon name="check" size={12} />}
                </button>
              ))
            )}
          </div>
          <div className="tb-foot">
            <button type="button" role="menuitem" onClick={() => { setBranchMenu(false); onBranchTools(); }}>
              Operaciones de rama
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
