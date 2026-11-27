import { pushAgentCompletion } from './trama/notifications';
import { useSharedPermissions } from './trama/pendingPermissions';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { coordinator, type Change, type CItem, type ChatAttachment, type CoordinatorEvent, type Decision, type Opened } from './ipc';
import { buildEffortOptions, Composer, ConversationLog, ConversationObservation, effortLabel, nearestEffort, useChatHistory, withAttachmentNames, type Ask } from './Conversation';
import ModelConfigMenu, { type ProviderSwitch } from './ModelConfigMenu';
import type { ConversationWorkflow } from './trama/ConversationPlan';
import { beep, shortcut, useReportActivity } from './ui';
import { pmActivityKey } from './trama/workspaceContext';
import { contextRemaining, reportCodex, reportQuotaLimit } from './usageStore';
import { PermissionChip, SessionContext, usePermissionMode } from './trama/SessionBar';
import { Icon } from './trama/icons';

const APPROVAL_METHODS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'];

type Approval = { requestId: unknown; method: string; params: any };
type Props = {
  project: string;
  hidden: boolean;
  switching?: boolean;
  providerSwitch?: ProviderSwitch;
  onDiff: (c: Change) => void;
  workflow?: ConversationWorkflow;
  observation?: HTMLElement | null;
  session?: { id: number; name: string; worktree: string | null; branch?: string | null; base?: string | null };
  task?: { id: number; title: string } | null;
  onClearTask?: () => void;
  onActivity?: (status: string) => void;
  onModel?: (key: number | string, model: string | null) => void;
  onContext?: (remaining: number | null) => void;
  onConversation?: (hasWork: boolean) => void;
};

/**
 * Conversación con el coordinador del proyecto (Codex). El historial viene
 * del hilo guardado; los turnos nuevos llegan como eventos y se pintan a
 * medida que avanzan. Las aprobaciones esperan aquí la decisión del usuario.
 */
export default function Coordinator({ project, hidden, switching, providerSwitch, onDiff, workflow, observation, session, task, onClearTask, onActivity, onModel, onContext, onConversation }: Props) {
  const sessionId = session?.id ?? null;
  const directName = session?.name;
  const history = useChatHistory(project, sessionId);
  const [visited, setVisited] = useState(!session || !hidden);
  useEffect(() => {
    if (!hidden) setVisited(true);
  }, [hidden]);
  const [info, setInfo] = useState<Opened | null>(null);
  const [turnModel, setTurnModel] = useState<string | null>(null);
  const [items, setItems] = useState<CItem[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [autoNotes, setAutoNotes] = useState<string[]>([]);
  const permission = usePermissionMode(sessionId, sessionId == null ? project : null, sessionId == null ? `pm:${project}` : undefined);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [effort, setEffort] = useState('medium');
  const [taskEffort, setTaskEffort] = useState<{ id: number; value: string } | null>(null);
  const automaticTask = sessionId == null ? task?.id : undefined;
  const selectedEffort = automaticTask == null ? effort : taskEffort?.id === automaticTask ? taskEffort.value : 'auto';
  const thread = useRef<string | null>(null);
  const open = useCallback(() => {
    setOpening(true);
    setError(null);
    coordinator.open(project, sessionId).then(
      (o) => {
        if (o.rateLimits) reportCodex(o.rateLimits);
        thread.current = o.threadId;
        setInfo(o);
        setItems(o.turns.flatMap((t) => t.items.map((item) => sessionId == null && item.type === 'agentMessage' ? { ...item, by: undefined } : item)));
        setRunning(o.activeTurn);
        setApprovals([]);
        setEffort(o.efforts.includes('medium') ? 'medium' : (o.efforts[0] ?? 'medium'));
        setOpening(false);
      },
      (e) => {
        setError(String(e));
        setOpening(false);
      },
    );
  }, [project, sessionId]);

  useEffect(() => {
    if (sessionId != null && !visited) return;
    thread.current = null;
    setInfo(null);
    setItems([]);
    open();
  }, [open, sessionId, visited]);

  // Eventos del hilo de este proyecto.
  useEffect(() => {
    const turnError = (error: { message?: string; codexErrorInfo?: unknown }) => {
      if (error.codexErrorInfo === 'usageLimitExceeded') reportQuotaLimit('codex');
      if (error.codexErrorInfo === 'contextWindowExceeded') onContext?.(0);
      setError(error.message ?? 'error de Codex');
    };
    const patch = (id: string, f: (it: CItem) => CItem) => setItems((list) => list.map((it) => (it.id === id ? f(it) : it)));
    const upsert = (item: CItem) =>
      setItems((list) => {
        const at = list.findIndex((it) => it.id === item.id);
        if (at >= 0) return list.map((it, i) => (i === at ? item : it));
        // El mensaje propio se pinta al enviarlo; aquí llega el definitivo.
        if (item.type === 'userMessage') {
          const local = list.findIndex((it) => it.id.startsWith('local-'));
          if (local >= 0) return list.map((it, i) => (i === local ? item : it));
        }
        return [...list, item];
      });

    const unlisten = listen<CoordinatorEvent>('coordinator', ({ payload: { method, params, requestId } }) => {
      if (method === 'server/closed') {
        if (!thread.current) return;
        setRunning(null);
        setApprovals([]);
        setError('Codex se ha cerrado; se volverá a abrir al enviar el siguiente mensaje');
        return;
      }
      if (!thread.current || params?.threadId !== thread.current) return;
      if (APPROVAL_METHODS.includes(method)) return setApprovals((a) => [...a, { requestId, method, params }]);
      if (method === 'filigranas/autoApproved') {
        const p = params?.params ?? {};
        const what = params?.request === 'item/fileChange/requestApproval' ? 'cambio de archivos' : p.command ? `orden «${String(p.command).slice(0, 120)}»` : 'orden';
        return setAutoNotes((n) => [...n.slice(-19), `Aprobado automáticamente (full control): ${what}`]);
      }
      switch (method) {
        case 'thread/tokenUsage/updated':
          onContext?.(contextRemaining(params.tokenUsage?.last?.totalTokens, params.tokenUsage?.modelContextWindow));
          break;
        case 'model/selected':
          setTurnModel(typeof params.model === 'string' ? params.model : null);
          break;
        case 'model/rerouted':
          if (typeof params.toModel === 'string') setTurnModel(params.toModel);
          break;
        case 'turn/started':
          setRunning(params.turn.id);
          setError(null);
          break;
        case 'turn/completed':
          setRunning(null);
          setApprovals([]);
          if (params.turn.error) turnError(params.turn.error);
          else if (params.turn.status === 'completed') pushAgentCompletion(project, sessionId ?? 'coach', directName ?? 'Project manager');
          break;
        case 'item/started':
        case 'item/completed':
          upsert(params.item);
          break;
        case 'item/agentMessage/delta':
        case 'item/plan/delta':
          patch(params.itemId, (it) => ({ ...it, text: (it.text ?? '') + params.delta }));
          break;
        case 'item/reasoning/summaryTextDelta':
          patch(params.itemId, (it) => {
            const summary = [...(it.summary ?? [])];
            summary[params.summaryIndex] = (summary[params.summaryIndex] ?? '') + params.delta;
            return { ...it, summary };
          });
          break;
        case 'item/commandExecution/outputDelta':
          patch(params.itemId, (it) => ({ ...it, aggregatedOutput: (it.aggregatedOutput ?? '') + params.delta }));
          break;
        case 'serverRequest/resolved':
          setApprovals((a) => a.filter((x) => JSON.stringify(x.requestId) !== JSON.stringify(params.requestId)));
          break;
        case 'error':
          if (!params.willRetry) turnError(params.error ?? {});
          break;
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [onContext]);

  const send = (text: string, attachments: ChatAttachment[]) => {
    setSubmitted(true);
    setError(null);
    setItems((list) => [...list, { id: `local-${Date.now()}`, type: 'userMessage', content: [{ type: 'text', text: withAttachmentNames(text, attachments) }] }]);
    return coordinator.send(project, text, selectedEffort, sessionId, task?.id ?? null, attachments).catch((e) => {
      setError(String(e));
      setItems((list) => list.filter((it) => !it.id.startsWith('local-')));
      throw e;
    });
  };

  const respond = (a: Approval, decision: Decision) => {
    setApprovals((list) => list.filter((x) => x !== a));
    coordinator.respond(a.requestId, decision).catch((e) => setError(String(e)));
  };

  const ownedAsks: Ask[] = approvals.map((a) => {
    const files = a.method.includes('fileChange') ? (items.find((it) => it.id === a.params.itemId)?.changes ?? []) : [];
    return {
      key: JSON.stringify(a.requestId),
      title: a.method.includes('fileChange') ? 'quiere cambiar archivos' : 'quiere ejecutar',
      command: a.params.command ?? undefined,
      files: files.map((c) => c.path),
      reason: a.params.reason ?? undefined,
      decide: (d) => respond(a, d),
    };
  });

  const asks = useSharedPermissions(project, sessionId, directName ?? 'Codex', session?.worktree ?? project, ownedAsks);
  const state = approvals.length ? 'esperando permiso' : running ? 'en marcha' : error && !info ? 'fallida' : 'inactiva';
  useReportActivity(session ? null : pmActivityKey(project), state);
  useEffect(() => onActivity?.(state), [onActivity, state]);
  const hasWork = history.items.length > 0 || submitted || items.some((item) => item.type === 'userMessage');
  useEffect(() => onConversation?.(hasWork), [hasWork, onConversation]);
  useEffect(() => {
    if (!hidden) onModel?.(sessionId ?? project, turnModel ?? info?.pinnedModel ?? info?.model ?? null);
  }, [hidden, info?.model, info?.pinnedModel, onModel, project, sessionId, turnModel]);

  const pin = (value: string) => {
    setError(null);
    coordinator.pinModel(project, sessionId, value || null).then(() => {
      setTurnModel(null);
      onContext?.(null);
      const efforts = info?.models?.find((m) => m.id === (value || info.model))?.efforts ?? info?.efforts ?? ['medium'];
      setInfo((old) => old && { ...old, pinnedModel: value || null, efforts });
      setEffort((current) => nearestEffort(current, efforts));
    }, (e) => setError(String(e)));
  };

  const availableEfforts = ['auto', ...(info?.models?.find((m) => m.id === (info.pinnedModel ?? info.model))?.efforts ?? info?.efforts ?? ['medium'])];
  const autoHint = automaticTask == null ? undefined : 'Jev o la política local eligen según la tarea';
  const selectEffort = (value: string) => {
    beep('tick');
    if (automaticTask == null) setEffort(value);
    else setTaskEffort({ id: automaticTask, value });
  };
  const modelDisplay = info?.pinnedModel
    ? info.models?.find((m) => m.id === info.pinnedModel)?.label ?? info.pinnedModel
    : info?.models?.length ? 'Automático' : (info?.model ?? 'Automático');
  const modelOptions = info?.models?.length
    ? [
        { value: '', label: 'Automático', hint: info.model ? `Codex elige; ahora ${info.model}` : 'Codex elige el modelo' },
        ...(info.pinnedModel && !info.models.some((m) => m.id === info.pinnedModel)
          ? [{ value: info.pinnedModel, label: info.pinnedModel, hint: 'No disponible', disabled: true }] : []),
        ...info.models.map((m) => ({
          value: m.id,
          label: m.label,
        })),
      ]
    : [];

  return (
    <section className="coach" aria-label={session ? 'Chat directo Codex' : 'Coordinador'} hidden={hidden}>
      {observation && <ConversationObservation target={observation} items={[...history.items, ...items]}
        agent={directName ?? 'Project manager'} project={session?.worktree ?? project} onDiff={onDiff} />}
      <ConversationLog items={[...history.items, ...items]} asks={asks} agent={directName ?? 'Project manager'} project={project} onDiff={onDiff} workflow={hidden ? undefined : workflow}>
        {opening && !hasWork && <div className="muted" role="status">Abriendo el coordinador…</div>}
        {!opening && info && !history.items.length && items.length === 0 && <div className="co-empty">¿Qué hacemos?</div>}
        {history.error && <div className="co-error">{history.error}</div>}
        {autoNotes.map((note, i) => <div key={i} className="co-auto"><Icon name="check" size={12} />{note}</div>)}
        {permission.error && <div className="co-error">{permission.error}</div>}
        {error && (
          <div className="co-error">
            {error}
            {!info && (
              <button className="co-btn" onClick={open}>
                reintentar
              </button>
            )}
          </div>
        )}
      </ConversationLog>

      <Composer
        draftKey={sessionId == null ? `pm:${project}` : `session:${sessionId}`}
        context={<SessionContext project={project} worktree={session?.worktree ?? null} branch={session?.branch ?? null} base={session?.base ?? null} hidden={hidden} />}
        permission={<PermissionChip mode={permission.mode} onMode={permission.setMode} disabled={switching === true} />}
        disabled={!info || switching === true}
        running={!!running}
        efforts={availableEfforts}
        effort={selectedEffort}
        onEffort={selectEffort}
        model={
          <ModelConfigMenu
            persistKey={sessionId == null ? `pm:${project}` : `session:${sessionId}`}
            hidden={hidden}
            switching={switching === true}
            loadingModels={opening && !info}
            engine="codex"
            engineLabel="Codex"
            provider={providerSwitch}
            modelDisplay={modelDisplay}
            model={modelOptions.length ? { value: info?.pinnedModel ?? '', options: modelOptions, disabled: !!running || !!switching, onChange: pin } : undefined}
            reasoning={[{
              id: 'effort',
              heading: 'Razonamiento',
              value: selectedEffort,
              disabled: !info || switching === true,
              options: buildEffortOptions(availableEfforts, autoHint),
              onChange: selectEffort,
            }]}
            reasoningDisplay={effortLabel(selectedEffort)}
            disabled={switching === true}
            title={shortcut('Proveedor, modelo y razonamiento · ⌘M · ⌘⇧E')}
          />
        }
        topExtra={task && (
          <button className="co-top-chip" onClick={onClearTask} title="Desvincular los próximos mensajes" disabled={!!running}>
            <span>#{task.id} {task.title}</span>
            <span className="co-top-x" aria-hidden="true">×</span>
          </button>
        )}
        extra={opening && hasWork && <span className="co-connecting" role="status">Conectando…</span>}
        onSend={send}
        onInterrupt={() => coordinator.interrupt(project, sessionId).catch((e) => setError(String(e)))}
        placeholder="/filigranas"
      />
    </section>
  );
}
