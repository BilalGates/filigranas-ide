import { useEffect, useRef, useState } from 'react';
import type { AutomationStatus, BranchEntry } from '../../ipc';
import { Icon } from '../icons';
import type { StageStatus, TimelineStage, TimelineStageId } from './entregaStore';

type Props = {
  projectName: string;
  activeBranch: string | null;
  agentBranches: string[];
  inspected: BranchEntry | null;
  stages: TimelineStage[];
  selectedStage: TimelineStageId;
  automation: AutomationStatus | null;
  busyAction: string | null;
  onSelectStage: (id: TimelineStageId) => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onCheckout: (branch: string) => void;
  onOpenSettings?: () => void;
};

const STAGE_COLORS: Record<StageStatus, string> = {
  done: '#6fe0b3',
  active: '#9db6ff',
  blocked: '#ffb25e',
  failed: '#ff6b5d',
  pending: 'rgba(220,226,236,.32)',
};

const MODE_LABELS: Record<string, string> = {
  manual: 'Manual',
  assisted: 'Asistido',
  auto: 'Automático',
};

export function TimelineHeader({
  projectName,
  activeBranch,
  agentBranches,
  inspected,
  stages,
  selectedStage,
  automation,
  busyAction,
  onSelectStage,
  onFetch,
  onPull,
  onPush,
  onCheckout,
  onOpenSettings,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(960);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const inspectingOther = Boolean(inspected && !inspected.active);
  const canPush = Boolean(inspected?.local && (!inspected.published || inspected.ahead > 0));
  const canPull = Boolean(inspected?.active && inspected.published && inspected.behind > 0);
  const distinctAgentBranches = agentBranches.filter((b) => b && b !== inspected?.name && b !== activeBranch);

  const runningAttempt = automation?.attempts.find((a) => ['queued', 'running', 'awaiting_ci'].includes(a.status)) ?? null;
  const modeLabel = automation ? (MODE_LABELS[automation.policy.mode] ?? automation.policy.mode) : null;
  const autoBlocked = Boolean(automation && !automation.pmDelegationReady && automation.pmBlockedReason);

  const count = stages.length;
  const padX = width < 640 ? 28 : 42;
  const step = count > 1 ? (Math.max(360, width) - padX * 2) / (count - 1) : 0;

  // El tramo luminoso llega hasta la última etapa alcanzada antes de la primera pendiente.
  const firstPending = stages.findIndex((s) => s.status === 'pending');
  const reachedSlice = firstPending < 0 ? stages : stages.slice(0, firstPending);
  let progressIdx = -1;
  for (let i = 0; i < reachedSlice.length; i++) {
    if (reachedSlice[i].status === 'done' || reachedSlice[i].status === 'active' || reachedSlice[i].isExecuting) {
      progressIdx = i;
    }
  }
  const progressX = progressIdx >= 0 ? padX + progressIdx * step : padX;

  return (
    <header className="ent-s01" aria-label="Entrega y línea temporal">
      <div className="ent-head-top">
        <div className="ent-head-ctx">
          <span className="ent-title">Entrega</span>
          <span className="ent-sep" aria-hidden="true">/</span>
          <span className="ent-proj">{projectName}</span>
          <span className="ent-sep" aria-hidden="true">·</span>
          <span className="ent-ctx-branch mono" title={`Rama inspeccionada: ${inspected?.name ?? activeBranch ?? 'HEAD suelto'}`}>
            <span className={`ent-bdot${inspected?.active ? ' is-active' : inspected?.remote && !inspected.local ? ' is-remote' : ''}`} />
            {inspected?.name ?? activeBranch ?? 'HEAD suelto'}
          </span>
          {inspectingOther && (
            <span
              className="ent-ctx-note"
              title={`Estás inspeccionando ${inspected?.name} sin cambiar el checkout activo (${activeBranch ?? 'HEAD'})`}
            >
              Inspección · activa <code className="mono">{activeBranch ?? 'HEAD'}</code>
            </span>
          )}
          {distinctAgentBranches.length > 0 && (
            <span className="ent-ctx-note is-agent" title={`Agentes operando en: ${distinctAgentBranches.join(', ')}`}>
              <Icon name="agent" size={11} />
              <code className="mono">{distinctAgentBranches[0]}</code>
              {distinctAgentBranches.length > 1 ? ` +${distinctAgentBranches.length - 1}` : ''}
            </span>
          )}
        </div>

        <div className="ent-head-acts">
          {modeLabel && (
            <button
              type="button"
              className={`ent-auto-pill${runningAttempt ? ' is-live' : autoBlocked ? ' is-warn' : ''}`}
              onClick={() => onSelectStage(runningAttempt ? 'ci' : 'agentes')}
              title={
                runningAttempt
                  ? `Automatización (${modeLabel}): intento #${runningAttempt.attemptNo} en PR #${runningAttempt.prNumber} (${runningAttempt.status})`
                  : autoBlocked
                    ? `Automatización bloqueada: ${automation?.pmBlockedReason}`
                    : `Modo de automatización: ${modeLabel}. Configúralo en Ajustes.`
              }
            >
              <span className={`ent-auto-dot${runningAttempt ? ' is-live' : autoBlocked ? ' is-warn' : ''}`} />
              <span>{modeLabel}</span>
              {runningAttempt && (
                <span className="mono ent-auto-sub">
                  #{runningAttempt.attemptNo}/{automation?.policy.maxRetries ?? 3}
                </span>
              )}
            </button>
          )}
          {onOpenSettings && (
            <button
              type="button"
              className="tbtn ent-icon-btn"
              onClick={onOpenSettings}
              title="Configurar automatización de Entrega en Ajustes"
              aria-label="Configurar automatización en Ajustes"
            >
              <Icon name="settings" size={13} />
            </button>
          )}

          <span className="ent-vbar" aria-hidden="true" />

          {inspectingOther && inspected?.local && (
            <button
              type="button"
              className="btn sm"
              disabled={busyAction !== null}
              onClick={() => onCheckout(inspected.name)}
              title={`Cambiar checkout activo del repositorio a ${inspected.name}`}
            >
              <Icon name="branch" size={12} /> Activar rama
            </button>
          )}
          <button
            type="button"
            className="btn sm ghost"
            disabled={busyAction !== null}
            onClick={onFetch}
            title="Sincronizar referencias remotas (git fetch --all --prune)"
          >
            <Icon name="refresh" size={12} />
            {busyAction === 'fetch' ? 'Fetch…' : 'Fetch'}
          </button>
          {canPull && (
            <button
              type="button"
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
              type="button"
              className="btn sm"
              disabled={busyAction !== null}
              onClick={onPush}
              title="Publicar commits de la rama inspeccionada con confirmación de SHA"
            >
              <Icon name="push" size={12} /> {inspected?.published ? `Push ↑${inspected.ahead}` : 'Publicar'}
            </button>
          )}
        </div>
      </div>

      <nav className="ent-timeline-wrap" aria-label="Línea temporal de Entrega">
        <svg
          ref={svgRef}
          className="ent-pipesvg"
          role="group"
          aria-label="Etapas de entrega: Tareas, Agentes, Cambios, Tests, Commit, PR, CI e Integración"
        >
          {/* Carril base fino punteado */}
          <line
            x1={padX}
            x2={Math.max(padX, width - padX)}
            y1="20"
            y2="20"
            className="ent-track-base"
          />
          {/* Línea de progreso real */}
          {progressIdx > 0 && (
            <line
              x1={padX}
              x2={progressX}
              y1="20"
              y2="20"
              className="ent-track-prog"
            />
          )}

          {stages.map((st, idx) => {
            const cx = padX + idx * step;
            const color = STAGE_COLORS[st.status];
            const isSelected = selectedStage === st.id;
            const isExecuting = st.isExecuting;
            const showSub = width >= 700 || isSelected || isExecuting || idx % 2 === 0;
            const shortDetail = st.detail.length > 16 ? `${st.detail.slice(0, 15)}…` : st.detail;
            const ariaDesc = `${st.label}: ${st.detail} (${st.status}${isExecuting ? ', en ejecución' : ''}${isSelected ? ', consultando' : ''})`;

            return (
              <g
                key={st.id}
                className={`ent-st st-${st.status}${isSelected ? ' is-selected' : ''}${isExecuting ? ' is-exec' : ''}`}
                transform={`translate(${cx},20)`}
                tabIndex={0}
                role="button"
                aria-label={ariaDesc}
                aria-pressed={isSelected}
                onClick={() => onSelectStage(st.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectStage(st.id);
                  } else if (e.key === 'ArrowRight' && idx < stages.length - 1) {
                    e.preventDefault();
                    onSelectStage(stages[idx + 1].id);
                  } else if (e.key === 'ArrowLeft' && idx > 0) {
                    e.preventDefault();
                    onSelectStage(stages[idx - 1].id);
                  }
                }}
              >
                <rect x={-Math.max(32, step / 2)} y="-16" width={Math.max(64, step)} height="56" rx="6" className="sthit" />

                {/* Halo animado sutil para la etapa en ejecución real */}
                {(st.status === 'active' || isExecuting) && (
                  <circle
                    r="10"
                    fill="none"
                    stroke={color}
                    strokeOpacity={isExecuting ? 0.55 : 0.35}
                    strokeWidth="1.2"
                    className="svgbreath"
                  />
                )}

                {/* Contorno discontinuo ámbar para estado bloqueado */}
                {st.status === 'blocked' && (
                  <circle
                    r="8.5"
                    fill="none"
                    stroke={color}
                    strokeOpacity="0.6"
                    strokeWidth="1.1"
                    strokeDasharray="2.5 2.5"
                  />
                )}

                {/* Resplandor sutil para estado fallido */}
                {st.status === 'failed' && (
                  <circle r="9" fill={color} fillOpacity="0.14" />
                )}

                {/* Anillo nítido de consulta (diferencia qué mira el usuario vs qué se ejecuta) */}
                {isSelected && (
                  <circle
                    r="12"
                    fill="none"
                    className="ent-st-ring"
                    strokeWidth="1.25"
                  />
                )}

                {/* Nodo principal */}
                <circle
                  r={isSelected ? 5 : isExecuting ? 4.8 : 4}
                  fill={st.status === 'pending' || st.status === 'blocked' ? 'var(--ink2)' : color}
                  stroke={color}
                  strokeWidth="1.5"
                />

                {/* Etiqueta de etapa */}
                <text y="26" textAnchor="middle" className="ent-st-lbl">
                  {st.label}
                </text>

                {/* Subtítulo monoespaciado de estado real */}
                {showSub && (
                  <text y="39" textAnchor="middle" className="ent-st-sub">
                    {shortDetail}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </nav>
    </header>
  );
}
