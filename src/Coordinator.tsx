import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { coordinator, type Change, type CItem, type CoordinatorEvent, type Decision, type Opened, type RateLimits, type RateWindow } from './ipc';
import { Composer, ConversationLog, KIND_LETTER, type Ask } from './Conversation';
import { addTokens, reportLimits, spanLabel } from './usageStore';
import { useReportActivity } from './ui';

const PROFILES: [string, string][] = [
  ['hansi', 'Hansi Flick'],
  ['pep', 'Pep Guardiola'],
  ['luis-enrique', 'Luis Enrique'],
  ['cruyff', 'Johan Cruyff'],
];
const APPROVAL_METHODS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'];

type Approval = { requestId: unknown; method: string; params: any };
type Props = {
  project: string;
  hidden: boolean;
  onDiff: (c: Change) => void;
  onProfile?: (name: string) => void;
  session?: { id: number; name: string; worktree: string | null };
  task?: { id: number; title: string } | null;
  onClearTask?: () => void;
  onActivity?: (status: string) => void;
};

/** Cuota de Codex en el formato común del panel de consumo. */
function report(limits: RateLimits) {
  const windows = [limits.primary, limits.secondary].filter((w): w is RateWindow => !!w);
  reportLimits({
    engine: 'codex',
    out: !!limits.rateLimitReachedType,
    windows: windows.map((w) => ({ label: spanLabel(w.windowDurationMins), percent: w.usedPercent, resetsAt: w.resetsAt ?? null })),
  });
}

/**
 * Conversación con el coordinador del proyecto (Codex). El historial viene
 * del hilo guardado; los turnos nuevos llegan como eventos y se pintan a
 * medida que avanzan. Las aprobaciones esperan aquí la decisión del usuario.
 */
export default function Coordinator({ project, hidden, onDiff, onProfile, session, task, onClearTask, onActivity }: Props) {
  const sessionId = session?.id ?? null;
  const directName = session?.name;
  const [visited, setVisited] = useState(!session || !hidden);
  useEffect(() => {
    if (!hidden) setVisited(true);
  }, [hidden]);
  const [info, setInfo] = useState<Opened | null>(null);
  const [items, setItems] = useState<CItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [limits, setLimits] = useState<RateLimits | null>(null);
  useEffect(() => {
    if (limits) report(limits);
  }, [limits]);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [effort, setEffort] = useState('medium');
  const [taskEffort, setTaskEffort] = useState<{ id: number; value: string } | null>(null);
  const automaticTask = sessionId == null ? task?.id : undefined;
  const selectedEffort = automaticTask == null ? effort : taskEffort?.id === automaticTask ? taskEffort.value : 'auto';
  const thread = useRef<string | null>(null);
  const model = useRef<string | null>(null);
  model.current = info?.model ?? null;
  const onProfileRef = useRef(onProfile);
  onProfileRef.current = onProfile;
  // Perfil vigente, para firmar las respuestas según llegan.
  const signer = useRef('coordinador');

  const open = useCallback(() => {
    setOpening(true);
    setError(null);
    coordinator.open(project, sessionId).then(
      (o) => {
        thread.current = o.threadId;
        signer.current = (directName ?? PROFILES.find(([id]) => id === o.profile)?.[1] ?? 'coordinador').toLowerCase();
        setInfo(o);
        setItems(o.turns.flatMap((t) => t.items));
        setRunning(o.activeTurn);
        setLimits(o.rateLimits);
        setApprovals([]);
        setEffort(o.efforts.includes('medium') ? 'medium' : (o.efforts[0] ?? 'medium'));
        onProfileRef.current?.(o.profile);
        setOpening(false);
      },
      (e) => {
        setError(String(e));
        setOpening(false);
      },
    );
  }, [directName, project, sessionId]);

  useEffect(() => {
    if (sessionId != null && !visited) return;
    thread.current = null;
    setInfo(null);
    setItems([]);
    open();
  }, [open, sessionId, visited]);

  // Eventos del hilo de este proyecto.
  useEffect(() => {
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
      if (method === 'account/rateLimits/updated') return setLimits(params.rateLimits);
      if (!thread.current || params?.threadId !== thread.current) return;
      if (method === 'thread/tokenUsage/updated') {
        const last = params.tokenUsage?.last;
        if (last) addTokens('codex', model.current, { input: (last.inputTokens ?? 0) - (last.cachedInputTokens ?? 0), cached: last.cachedInputTokens, output: last.outputTokens });
        return;
      }
      if (APPROVAL_METHODS.includes(method)) return setApprovals((a) => [...a, { requestId, method, params }]);
      switch (method) {
        case 'turn/started':
          setRunning(params.turn.id);
          setError(null);
          break;
        case 'turn/completed':
          setRunning(null);
          setApprovals([]);
          if (params.turn.error) setError(params.turn.error.message);
          break;
        case 'item/started':
        case 'item/completed':
          upsert(params.item.type === 'agentMessage' ? { ...params.item, by: signer.current } : params.item);
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
          if (!params.willRetry) setError(params.error?.message ?? 'error de Codex');
          break;
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  const send = (text: string) => {
    setError(null);
    setItems((list) => [...list, { id: `local-${Date.now()}`, type: 'userMessage', content: [{ type: 'text', text }] }]);
    return coordinator.send(project, text, selectedEffort, sessionId, task?.id ?? null).catch((e) => {
      setError(String(e));
      setItems((list) => list.filter((it) => !it.id.startsWith('local-')));
      throw e;
    });
  };

  const respond = (a: Approval, decision: Decision) => {
    setApprovals((list) => list.filter((x) => x !== a));
    coordinator.respond(a.requestId, decision).catch((e) => setError(String(e)));
  };

  const changeProfile = (profile: string) => {
    const name = PROFILES.find(([id]) => id === profile)?.[1] ?? profile;
    setError(null);
    coordinator.setProfile(project, profile).then(
      () => {
        signer.current = name.toLowerCase();
        setInfo((i) => (i ? { ...i, profile } : i));
        onProfileRef.current?.(profile);
        setItems((list) => [...list, { id: `perfil-${Date.now()}`, type: 'notice', text: `perfil cambiado a ${name}: se aplica desde el siguiente mensaje` }]);
      },
      (e) => setError(String(e)),
    );
  };

  const asks: Ask[] = approvals.map((a, i) => {
    const files = a.method.includes('fileChange') ? (items.find((it) => it.id === a.params.itemId)?.changes ?? []) : [];
    return {
      key: `${i}-${JSON.stringify(a.requestId)}`,
      title: a.method.includes('fileChange') ? 'quiere cambiar archivos' : 'quiere ejecutar',
      command: a.params.command ?? undefined,
      files: files.map((c) => `${KIND_LETTER[c.kind.type] ?? 'M'} ${c.path}`),
      reason: a.params.reason ?? undefined,
      decide: (d) => respond(a, d),
    };
  });

  const profileName = PROFILES.find(([id]) => id === info?.profile)?.[1] ?? 'Hansi Flick';
  const state = approvals.length ? 'esperando permiso' : running ? 'en marcha' : error && !info ? 'fallida' : 'inactiva';
  useReportActivity(session ? null : 'coach', state);
  useEffect(() => onActivity?.(state), [onActivity, state]);

  const pin = (value: string) => {
    if (sessionId == null) return;
    setError(null);
    coordinator.pinModel(project, sessionId, value || null).then(() => {
      const efforts = info?.models?.find((m) => m.id === (value || info.model))?.efforts ?? info?.efforts ?? ['medium'];
      setInfo((old) => old && { ...old, pinnedModel: value || null, efforts });
      if (!efforts.includes(effort)) setEffort(efforts.includes('medium') ? 'medium' : (efforts[0] ?? 'medium'));
    }, (e) => setError(String(e)));
  };

  return (
    <section className="coach" aria-label={session ? 'Chat directo Codex' : 'Coordinador'} hidden={hidden}>

      <ConversationLog items={items} asks={asks} agent="coordinador" project={project} onDiff={onDiff}>
        {opening && <div className="muted">abriendo el coordinador…</div>}
        {!opening && info && items.length === 0 && <div className="co-empty">¿Qué hacemos?</div>}
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
        disabled={!info}
        running={!!running}
        efforts={automaticTask == null ? info?.efforts ?? ['medium'] : ['auto', ...(info?.efforts ?? ['medium'])]}
        effort={selectedEffort}
        onEffort={(value) => automaticTask == null ? setEffort(value) : setTaskEffort({ id: automaticTask, value })}
        model={
          <>
            {!session && <select
              className="chip-select"
              title="project manager"
              aria-label="Perfil del coordinador"
              value={info?.profile ?? 'hansi'}
              onChange={(e) => changeProfile(e.target.value)}
              disabled={!info || !!running}
            >
              {PROFILES.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>}
            {session && info?.models?.length ? <select className="chip-select" aria-label="Fijar modelo Codex" value={info.pinnedModel ?? ''}
              onChange={(e) => pin(e.target.value)} disabled={!!running}>
              <option value="">{info.model ?? 'modelo de la sesión'}</option>
              {info.pinnedModel && !info.models.some((m) => m.id === info.pinnedModel) && <option value={info.pinnedModel}>{info.pinnedModel} · no disponible</option>}
              {info.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select> : <span className="chip is-static">codex{info?.model ? ` · ${info.model}` : ''}</span>}
            {task && <button className="co-btn" onClick={onClearTask} title="desvincular los próximos mensajes" disabled={!!running}>#{task.id} {task.title} ×</button>}
          </>
        }
        onSend={send}
        onInterrupt={() => coordinator.interrupt(project, sessionId).catch((e) => setError(String(e)))}
        placeholder={`encargo para ${directName ?? profileName.toLowerCase()}`}
      />
    </section>
  );
}
