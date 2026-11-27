import type { BranchEntry, PullSummary } from '../../ipc';
import { Icon } from '../icons';
import { computeBranchBadges } from './entregaStore';

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
}: Props) {
  const q = search.trim().toLowerCase();
  const filtered = branches.filter((b) => !q || b.name.toLowerCase().includes(q) || b.subject.toLowerCase().includes(q));

  const merged = filtered.filter((b) => {
    const pr = prByBranch.get(b.name);
    return !b.active && !b.isDefault && (pr?.state === 'MERGED' || b.mergedIntoDefault);
  });
  const activeOrOpen = filtered.filter((b) => !merged.includes(b));
  const localBranches = activeOrOpen.filter((b) => b.local);
  const remoteOnly = activeOrOpen.filter((b) => !b.local && b.remote);

  const renderBranch = (b: BranchEntry) => {
    const pr = prByBranch.get(b.name) ?? null;
    const badges = computeBranchBadges(b, pr);
    const selected = inspectedBranch === b.name;

    return (
      <div
        key={b.refName}
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
        title={`${b.name} (${b.shortOid}) — ${b.subject}\nClic para inspeccionar sin cambiar de rama`}
      >
        <div className="ent-brow-top">
          <span className={`ent-bdot${b.active ? ' is-active' : b.remote && !b.local ? ' is-remote' : ''}`} aria-hidden="true" />
          <span className="ent-bname mono">{b.name}</span>
          {b.local && !b.active && (
            <button
              className="ent-brow-act"
              onClick={(e) => {
                e.stopPropagation();
                onCheckout(b.name);
              }}
              title={`Hacer checkout a ${b.name}`}
            >
              Activar
            </button>
          )}
        </div>
        <div className="ent-bbadges">
          {badges.map((bg) => (
            <span key={bg.key} className={`ent-tag tone-${bg.tone}`}>{bg.label}</span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <section className="ent-block ent-branches" aria-label="Explorador de ramas">
      <div className="ent-sec-head">
        <Icon name="branch" size={13} />
        <span>Ramas</span>
        <span className="ent-count mono">{branches.length}</span>
      </div>
      <div className="ent-search-wrap">
        <Icon name="search" size={12} />
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
            <div className="ent-bgroup-lbl">Locales ({localBranches.length})</div>
            {localBranches.map(renderBranch)}
          </div>
        )}

        {remoteOnly.length > 0 && (
          <div className="ent-bgroup">
            <div className="ent-bgroup-lbl">Solo remotas ({remoteOnly.length})</div>
            {remoteOnly.map(renderBranch)}
          </div>
        )}

        {merged.length > 0 && (
          <div className="ent-bgroup">
            <button className="ent-bgroup-toggle" onClick={onToggleMerged}>
              <Icon name={showMerged ? 'down' : 'chev'} size={11} />
              <span>Integradas ({merged.length})</span>
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
