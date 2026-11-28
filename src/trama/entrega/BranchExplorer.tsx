import { useEffect, useRef, useState } from 'react';
import type { BranchEntry, PullSummary } from '../../ipc';
import { Icon } from '../icons';
import { computeBranchSignals } from './entregaStore';

type Props = {
  branches: BranchEntry[];
  inspectedBranch: string | null;
  prByBranch: Map<string, PullSummary>;
  search: string;
  showMerged: boolean;
  onSearch: (q: string) => void;
  onToggleMerged: () => void;
  onInspect: (branch: BranchEntry) => void;
  onCheckout: (branchName: string) => void;
  onFilterHistory: (branch: BranchEntry) => void;
  onOpenPr: (branch: BranchEntry) => void;
  onPushBranch: (branch: BranchEntry) => void;
};

export function BranchExplorer({
  branches,
  inspectedBranch,
  prByBranch,
  search,
  showMerged,
  onSearch,
  onToggleMerged,
  onInspect,
  onCheckout,
  onFilterHistory,
  onOpenPr,
  onPushBranch,
}: Props) {
  const [menuBranch, setMenuBranch] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuBranch) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuBranch(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuBranch(null);
    };
    window.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuBranch]);

  const q = search.trim().toLowerCase();
  const filtered = branches.filter(
    (b) => !q || b.name.toLowerCase().includes(q) || b.subject.toLowerCase().includes(q),
  );

  const merged = filtered.filter((b) => {
    const pr = prByBranch.get(b.name);
    return !b.active && !b.isDefault && (pr?.state === 'MERGED' || b.mergedIntoDefault);
  });
  const activeOrOpen = filtered.filter((b) => !merged.includes(b));
  const localBranches = activeOrOpen.filter((b) => b.local);
  const remoteOnly = activeOrOpen.filter((b) => !b.local && b.remote);

  const renderBranch = (b: BranchEntry) => {
    const pr = prByBranch.get(b.name) ?? null;
    const sig = computeBranchSignals(b, pr);
    const selected = inspectedBranch === b.name;
    const isMenuOpen = menuBranch === b.refName;
    const canPush = b.local && (!b.published || b.ahead > 0);

    const tooltipParts = [
      `${b.name} (${b.shortOid})`,
      b.active ? 'Rama activa (HEAD)' : b.local ? (b.published ? 'Local y publicada' : 'Solo local') : 'Solo remota',
      sig.syncLabel ? `Sync: ${sig.syncLabel}` : null,
      pr ? `PR #${pr.number} (${pr.isDraft ? 'borrador' : pr.state})` : null,
      sig.activeAgentName ? `Agente: ${sig.activeAgentName}${sig.agentBusy ? ' (en ejecución)' : ''}` : null,
      sig.hasWorktree ? `Worktree: ${b.worktreePath}` : null,
      b.subject ? `Último: ${b.subject}` : null,
      'Clic para inspeccionar sin cambiar checkout',
    ].filter(Boolean);

    return (
      <div key={b.refName} className="ent-brow-wrap">
        <div
          className={`ent-brow${selected ? ' on' : ''}${b.active ? ' is-active' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => onInspect(b)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onInspect(b);
            }
          }}
          title={tooltipParts.join('\n')}
        >
          <span
            className={`ent-bdot${b.active ? ' is-active' : b.remote && !b.local ? ' is-remote' : ''}`}
            aria-hidden="true"
          />
          <span className="ent-bname mono">{b.name}</span>

          <span className="ent-bsignals">
            {(sig.hasWorktree || sig.activeAgentName) && (
              <span
                className={`ent-bsig-ic${sig.agentBusy ? ' is-live' : ''}`}
                title={sig.activeAgentName ? `Agente: ${sig.activeAgentName}` : 'Worktree aislado'}
              >
                <Icon name="agent" size={11} />
              </span>
            )}
            {sig.syncLabel && (
              <span className={`ent-bsig mono tone-${sig.syncTone}`}>
                {sig.syncLabel}
              </span>
            )}
            {sig.prLabel && (
              <span className={`ent-bsig-pr mono tone-${sig.prTone}`}>
                {sig.ciTone && <i className={`ent-ci-dot tone-${sig.ciTone}`} aria-hidden="true" />}
                {sig.prLabel}
              </span>
            )}
          </span>

          <button
            type="button"
            className="ent-brow-more"
            aria-label={`Acciones de rama ${b.name}`}
            aria-expanded={isMenuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuBranch(isMenuOpen ? null : b.refName);
            }}
          >
            <Icon name="more" size={12} />
          </button>
        </div>

        {isMenuOpen && (
          <div ref={menuRef} className="ent-menu" role="menu" aria-label={`Acciones para ${b.name}`}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuBranch(null);
                onInspect(b);
              }}
            >
              <Icon name="eye" size={12} /> Inspeccionar cambios
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuBranch(null);
                onFilterHistory(b);
              }}
            >
              <Icon name="commit" size={12} /> Filtrar historial por rama
            </button>
            {b.local && !b.active && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuBranch(null);
                  onCheckout(b.name);
                }}
              >
                <Icon name="branch" size={12} /> Activar rama (checkout)
              </button>
            )}
            {canPush && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuBranch(null);
                  onPushBranch(b);
                }}
              >
                <Icon name="push" size={12} /> {b.published ? `Push ↑${b.ahead}` : 'Publicar rama'}
              </button>
            )}
            {!b.isDefault && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuBranch(null);
                  onOpenPr(b);
                }}
              >
                <Icon name="pr" size={12} /> {pr ? `Ver PR #${pr.number}` : 'Crear Pull Request'}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="ent-col ent-col-branches" aria-label="Ramas">
      <div className="ent-col-head">
        <Icon name="branch" size={12} />
        <span>Ramas</span>
        <span className="ent-col-count mono">{branches.length}</span>
      </div>

      <div className="ent-search-wrap">
        <Icon name="search" size={11} />
        <input
          type="search"
          className="ent-search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Filtrar ramas…"
          aria-label="Filtrar ramas"
        />
      </div>

      <div className="ent-scroll">
        {localBranches.length > 0 && (
          <div className="ent-bgroup">
            <div className="ent-bgroup-lbl">Locales · {localBranches.length}</div>
            {localBranches.map(renderBranch)}
          </div>
        )}

        {remoteOnly.length > 0 && (
          <div className="ent-bgroup">
            <div className="ent-bgroup-lbl">Remotas · {remoteOnly.length}</div>
            {remoteOnly.map(renderBranch)}
          </div>
        )}

        {merged.length > 0 && (
          <div className="ent-bgroup">
            <button type="button" className="ent-bgroup-toggle" onClick={onToggleMerged}>
              <Icon name={showMerged ? 'down' : 'chev'} size={11} />
              <span>Integradas · {merged.length}</span>
            </button>
            {showMerged && merged.map(renderBranch)}
          </div>
        )}

        {filtered.length === 0 && (
          <p className="ent-empty-mini">Sin ramas coincidentes.</p>
        )}
      </div>
    </section>
  );
}
