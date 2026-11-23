import { useSharedPermissions } from './trama/pendingPermissions';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { coordinator, type Change, type CItem, type ChatAttachment, type CoordinatorEvent, type Decision, type Opened } from './ipc';
import { Composer, ConversationLog, ConversationObservation, useChatHistory, withAttachmentNames, type Ask } from './Conversation';
import type { ConversationWorkflow } from './trama/ConversationPlan';
import { useReportActivity } from './ui';
import { contextRemaining, reportCodex, reportQuotaLimit } from './usageStore';

const APPROVAL_METHODS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'];

type Approval = { requestId: unknown; method: string; params: any };
type Props = {
  project: string;
  hidden: boolean;
  switching?: boolean;
  providerPicker?: ReactNode;
  onDiff: (c: Change) => void;
  workflow?: ConversationWorkflow;
  observation?: HTMLElement | null;
  session?: { id: number; name: string; worktree: string | null };
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
export default function Coordinator({ project, hidden, switching, providerPicker, onDiff, workflow, observation, session, task, onClearTask, onActivity, onModel, onContext, onConversation }: Props) {
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
  useReportActivity(session ? null : 'coach', state);
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
      if (!efforts.includes(effort)) setEffort(efforts.includes('medium') ? 'medium' : (efforts[0] ?? 'medium'));
    }, (e) => setError(String(e)));
  };

  return (
    <section className="coach" aria-label={session ? 'Chat directo Codex' : 'Coordinador'} hidden={hidden}>
      {observation && <ConversationObservation target={observation} items={[...history.items, ...items]}
        agent={directName ?? 'Project manager'} project={session?.worktree ?? project} onDiff={onDiff} />}
      <ConversationLog items={[...history.items, ...items]} asks={asks} agent={directName ?? 'Project manager'} project={project} onDiff={onDiff} workflow={hidden ? undefined : workflow}>
        {opening && <div className="muted">abriendo el coordinador…</div>}
        {!opening && info && !history.items.length && items.length === 0 && <div className="co-empty">¿Qué hacemos?</div>}
        {history.error && <div className="co-error">{history.error}</div>}
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
        providerPicker={providerPicker}
        draftKey={sessionId == null ? `pm:${project}` : `session:${sessionId}`}
        disabled={!info || switching === true}
        running={!!running}
        efforts={automaticTask == null ? info?.efforts ?? ['medium'] : ['auto', ...(info?.efforts ?? ['medium'])]}
        effort={selectedEffort}
        onEffort={(value) => automaticTask == null ? setEffort(value) : setTaskEffort({ id: automaticTask, value })}
        model={
          <>
            {info?.models?.length ? <select className="chip-select" aria-label="Fijar modelo Codex" value={info.pinnedModel ?? ''}
              onChange={(e) => pin(e.target.value)} disabled={!!running || switching}>
              <option value="">{info.model ?? 'modelo de la sesión'}</option>
              {info.pinnedModel && !info.models.some((m) => m.id === info.pinnedModel) && <option value={info.pinnedModel}>{info.pinnedModel} · no disponible</option>}
              {info.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select> : <span className="chip is-static">codex{info?.model ? ` · ${info.model}` : ''}</span>}
            {task && <button className="co-btn" onClick={onClearTask} title="desvincular los próximos mensajes" disabled={!!running}>#{task.id} {task.title} ×</button>}
          </>
        }
        onSend={send}
        onInterrupt={() => coordinator.interrupt(project, sessionId).catch((e) => setError(String(e)))}
        placeholder={`encargo para ${directName ?? 'Project manager'}`}
      />
    </section>
  );
}
