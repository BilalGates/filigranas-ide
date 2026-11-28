import { memo, useMemo } from 'react';
import { parseRefs } from '../../GitGraph';
import type { LogRow, PullSummary } from '../../ipc';
import { Icon } from '../icons';
import { ago } from '../kit';
import { GRAPH_ROW_HEIGHT, layoutCommitGraph } from './commitGraphLayout';
import type { HistoryScope } from './entregaStore';

type Props = {
  rows: LogRow[];
  loading: boolean;
  scope: HistoryScope;
  inspectedBranchName: string | null;
  selectedCommit: string | null;
  search: string;
  pulls: PullSummary[];
  onScopeChange: (scope: HistoryScope) => void;
  onSearchChange: (q: string) => void;
  onSelectCommit: (hash: string) => void;
  onClearCommit: () => void;
};

export const CommitGraph = memo(function CommitGraph({
  rows,
  loading,
  scope,
  inspectedBranchName,
  selectedCommit,
  search,
  pulls,
  onScopeChange,
  onSearchChange,
  onSelectCommit,
  onClearCommit,
}: Props) {
  const q = search.trim().toLowerCase();

  const visibleRows = useMemo(() => {
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.subject.toLowerCase().includes(q) ||
        r.hash.toLowerCase().includes(q) ||
        r.author.toLowerCase().includes(q) ||
        r.refs.toLowerCase().includes(q),
    );
  }, [rows, q]);

  // Asocia Pull Requests reales a los commits por headOid o mergeCommitOid.
  const prByShortHash = useMemo(() => {
    const map = new Map<string, PullSummary>();
    for (const p of pulls) {
      if (p.headOid) map.set(p.headOid.slice(0, 7), p);
      if (p.mergeCommitOid) map.set(p.mergeCommitOid.slice(0, 7), p);
    }
    return map;
  }, [pulls]);

  // El grafo topológico real se traza sobre el historial sin romper padres cuando no hay búsqueda de texto.
  const graph = useMemo(() => layoutCommitGraph(visibleRows), [visibleRows]);

  const selectedIndex = useMemo(() => {
    if (!selectedCommit) return -1;
    return visibleRows.findIndex(
      (r) => r.hash === selectedCommit || selectedCommit.startsWith(r.hash) || r.hash.startsWith(selectedCommit),
    );
  }, [visibleRows, selectedCommit]);

  const formatCommitDate = (iso: string) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return iso.slice(0, 10);
    return ago(ms);
  };

  return (
    <section className="ent-s03" aria-label="Historial de commits y grafo Git">
      <div className="ent-hist-bar">
        <div className="ent-hist-left">
          <Icon name="commit" size={12} />
          <span className="ent-hist-title">Historial</span>
          <span className="ent-col-count mono">{visibleRows.length}</span>

          <div className="ent-hist-scope" role="tablist" aria-label="Ámbito del historial">
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'all'}
              className={scope === 'all' ? 'on' : ''}
              onClick={() => onScopeChange('all')}
            >
              Todas las ramas
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'branch'}
              className={scope === 'branch' ? 'on' : ''}
              disabled={!inspectedBranchName}
              onClick={() => onScopeChange('branch')}
              title={inspectedBranchName ? `Filtrar historial por ${inspectedBranchName}` : undefined}
            >
              {inspectedBranchName ?? 'Rama'}
            </button>
          </div>
        </div>

        <div className="ent-hist-right">
          {selectedCommit && (
            <button
              type="button"
              className="ent-hist-sel-chip mono"
              onClick={onClearCommit}
              title="Limpiar selección de commit"
            >
              <span>{selectedCommit.slice(0, 7)}</span>
              <Icon name="close" size={10} />
            </button>
          )}
          <div className="ent-hist-search">
            <Icon name="search" size={11} />
            <input
              type="search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Buscar commit…"
              aria-label="Buscar en el historial de commits"
            />
          </div>
        </div>
      </div>

      <div className="ent-hist-scroll">
        {loading && visibleRows.length === 0 ? (
          <p className="ent-empty-mini">Cargando grafo de commits…</p>
        ) : visibleRows.length === 0 ? (
          <p className="ent-empty-mini">Sin commits para mostrar.</p>
        ) : (
          <div
            className="ent-graph-canvas"
            style={{
              height: graph.height,
              ['--ent-graph-w' as string]: `${graph.width}px`,
            }}
          >
            <svg
              className="ent-graph-svg"
              width={graph.width}
              height={graph.height}
              fill="none"
              aria-hidden="true"
            >
              {graph.lines.map((line, i) => (
                <path
                  key={i}
                  d={line.d}
                  stroke={line.color}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeOpacity="0.82"
                />
              ))}
              {graph.dots.map((dot, idx) => {
                const isSel = idx === selectedIndex;
                return (
                  <g key={dot.hash}>
                    {isSel && (
                      <circle
                        cx={dot.x}
                        cy={dot.y}
                        r="7.5"
                        fill="none"
                        stroke="var(--tx)"
                        strokeOpacity="0.72"
                        strokeWidth="1.2"
                      />
                    )}
                    {dot.kind === 'merge' ? (
                      <rect
                        x={dot.x - 3.6}
                        y={dot.y - 3.6}
                        width="7.2"
                        height="7.2"
                        rx="1.2"
                        transform={`rotate(45 ${dot.x} ${dot.y})`}
                        fill="var(--ink1)"
                        stroke={dot.color}
                        strokeWidth="1.6"
                      />
                    ) : dot.kind === 'head' ? (
                      <>
                        <circle cx={dot.x} cy={dot.y} r="6.5" fill={dot.color} fillOpacity="0.18" />
                        <circle
                          cx={dot.x}
                          cy={dot.y}
                          r="4"
                          fill="var(--ink1)"
                          stroke={dot.color}
                          strokeWidth="1.8"
                        />
                      </>
                    ) : (
                      <circle
                        cx={dot.x}
                        cy={dot.y}
                        r={isSel ? 3.5 : 2.8}
                        fill={dot.color}
                      />
                    )}
                  </g>
                );
              })}
            </svg>

            {visibleRows.map((row, idx) => {
              const dot = graph.dots[idx];
              const refs = row.refs ? parseRefs(row.refs) : [];
              const matchedPr = prByShortHash.get(row.hash.slice(0, 7)) ?? null;
              const isSel = idx === selectedIndex;
              const isHead = dot?.kind === 'head';

              return (
                <button
                  key={row.hash}
                  type="button"
                  className={`ent-grow${isSel ? ' on' : ''}${isHead ? ' is-head' : ''}`}
                  style={{
                    height: GRAPH_ROW_HEIGHT,
                    paddingLeft: Math.max(graph.width + 6, (dot?.inset ?? 24) + 6),
                  }}
                  onClick={() => onSelectCommit(row.hash)}
                  aria-pressed={isSel}
                  title={`${row.hash} — ${row.subject}\n${row.author} · ${row.date}`}
                >
                  <span className="ent-grow-main">
                    {refs.length > 0 && (
                      <span className="ent-grow-refs">
                        {refs.slice(0, 4).map((ref) => (
                          <span
                            key={`${ref.kind}:${ref.name}`}
                            className={`ent-gref is-${ref.kind}`}
                            style={{ ['--ref-col' as string]: dot?.color ?? 'var(--skyhi)' }}
                          >
                            {ref.kind === 'head' ? 'HEAD · ' : ''}
                            {ref.name}
                          </span>
                        ))}
                      </span>
                    )}
                    {matchedPr && (
                      <span
                        className={`ent-gref is-pr tone-${
                          matchedPr.state === 'MERGED'
                            ? 'mint'
                            : matchedPr.state === 'CLOSED'
                              ? 'mut'
                              : 'sky'
                        }`}
                      >
                        PR #{matchedPr.number}
                      </span>
                    )}
                    <span className="ent-grow-subj">{row.subject}</span>
                  </span>
                  <span className="ent-grow-auth">{row.author}</span>
                  <span className="ent-grow-sha mono">{row.hash}</span>
                  <span className="ent-grow-date mono">{formatCommitDate(row.date)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
});
