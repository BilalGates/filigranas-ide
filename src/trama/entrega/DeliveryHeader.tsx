import type { BranchEntry } from '../../ipc';
import { Icon } from '../icons';
import type { CenterTab, PipelineStage } from './entregaStore';

type Props = {
  projectName: string;
  activeBranch: string | null;
  inspected: BranchEntry | null;
  stages: PipelineStage[];
  activeTab: CenterTab;
  busyAction: string | null;
  inspectorOpen: boolean;
  hasInspectorData: boolean;
  onSelectStage: (tab: CenterTab) => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onCheckout: (branch: string) => void;
  onToggleInspector: () => void;
};

export function DeliveryHeader({
  projectName,
  activeBranch,
  inspected,
  stages,
  activeTab,
  busyAction,
  inspectorOpen,
  hasInspectorData,
  onSelectStage,
  onFetch,
  onPull,
  onPush,
  onCheckout,
  onToggleInspector,
}: Props) {
  const inspectingOther = Boolean(inspected && !inspected.active);
  const canPush = Boolean(inspected?.local && (!inspected.published || inspected.ahead > 0));
  const canPull = Boolean(inspected?.active && inspected.published && inspected.behind > 0);

  return (
    <header className="ent-head">
      <div className="ent-head-top">
        <div className="ent-head-ctx">
          <Icon name="branch" size={14} />
          <span className="ent-proj">{projectName}</span>
          <span className="mut">/</span>
          <strong className="mono ent-cur-branch">{inspected?.name ?? activeBranch ?? 'HEAD suelto'}</strong>
          {inspected?.active && <span className="chip sky tiny">Activa</span>}
          {inspectingOther && (
            <span className="chip amber tiny" title={`Rama activa del repositorio: ${activeBranch ?? 'HEAD suelto'}`}>
              Inspección · Activa: {activeBranch ?? 'HEAD'}
            </span>
          )}
          {inspected && !inspected.local && inspected.remote && (
            <span className="chip tiny">Solo remota</span>
          )}
          {inspected?.worktreePath && (
            <span className="chip tiny">Worktree</span>
          )}
        </div>

        <div className="ent-head-acts">
          {inspectingOther && inspected?.local && (
            <button
              className="btn sm"
              disabled={busyAction !== null}
              onClick={() => onCheckout(inspected.name)}
              title="Cambiar la rama activa del repositorio a esta rama"
            >
              <Icon name="branch" size={12} /> Cambiar a rama
            </button>
          )}
          <button
            className="btn sm"
            disabled={busyAction !== null}
            onClick={onFetch}
            title="Sincronizar referencias remotas (git fetch --all --prune)"
          >
            <Icon name="refresh" size={12} /> {busyAction === 'fetch' ? 'Sincronizando…' : 'Fetch'}
          </button>
          {canPull && (
            <button
              className="btn sm"
              disabled={busyAction !== null}
              onClick={onPull}
              title="Descargar cambios con avance rápido (git pull --ff-only)"
            >
              <Icon name="pull" size={12} /> Pull ↓{inspected?.behind}
            </button>
          )}
          {canPush && (
            <button
              className="btn sm"
              disabled={busyAction !== null}
              onClick={onPush}
              title="Publicar commits de la rama inspeccionada con confirmación de SHA"
            >
              <Icon name="push" size={12} /> {inspected?.published ? `Push ↑${inspected.ahead}` : 'Publicar'}
            </button>
          )}
          {hasInspectorData && (
            <button
              className={`btn sm ghost${inspectorOpen ? ' on' : ''}`}
              onClick={onToggleInspector}
              title={inspectorOpen ? 'Ocultar inspector contextual' : 'Mostrar inspector contextual'}
              aria-pressed={inspectorOpen}
            >
              <Icon name="panel" size={13} />
            </button>
          )}
        </div>
      </div>

      <nav className="ent-pipe" aria-label="Estado del ciclo de entrega">
        {stages.map((st, idx) => (
          <div key={st.id} className="ent-pipe-slot">
            <button
              className={`ent-pipe-step tone-${st.tone}${activeTab === st.tab ? ' is-focus' : ''}`}
              onClick={() => onSelectStage(st.tab)}
              title={`${st.label}: ${st.detail}`}
            >
              <span className={`ent-dot tone-${st.tone}`} aria-hidden="true" />
              <span className="ent-pipe-lbl">{st.label}</span>
              <span className="ent-pipe-det mono">{st.detail}</span>
            </button>
            {idx < stages.length - 1 && <span className="ent-pipe-sep" aria-hidden="true">›</span>}
          </div>
        ))}
      </nav>
    </header>
  );
}
