import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { coordinator, type Change, type CItem, type CoordinatorEvent, type Decision, type Opened, type RateLimits, type RateWindow } from './ipc';
import { Composer, ConversationLog, KIND_LETTER, type Ask } from './Conversation';

const PROFILES: [string, string][] = [
  ['hansi', 'Hansi Flick'],
  ['pep', 'Pep Guardiola'],
  ['luis-enrique', 'Luis Enrique'],
  ['cruyff', 'Johan Cruyff'],
];
const APPROVAL_METHODS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'];

type Approval = { requestId: unknown; method: string; params: any };
type Props = { project: string; hidden: boolean; onDiff: (c: Change) => void; onProfile: (name: string) => void };

function windowLabel(w: RateWindow) {
  const mins = w.windowDurationMins ?? 0;
  const span = mins >= 10080 ? 'semana' : mins >= 1440 ? `${Math.round(mins / 1440)} d` : `${Math.round(mins / 60)} h`;
  return `${span} ${Math.round(w.usedPercent)}%`;
}

function Quota({ limits }: { limits: RateLimits | null }) {
  if (!limits) return null;
  const windows = [limits.primary, limits.secondary].filter((w): w is RateWindow => !!w);
  const reset = limits.primary?.resetsAt ? new Date(limits.primary.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <span className={limits.rateLimitReachedType ? 'co-quota is-out' : 'co-quota'} title={reset ? `se renueva a las ${reset}` : undefined}>
      {limits.rateLimitReachedType ? 'cuota agotada · ' : 'uso '}
      {windows.map(windowLabel).join(' · ')}
    </span>
  );
}

/**
 * Conversación con el coordinador del proyecto (Codex). El historial viene
 * del hilo guardado; los turnos nuevos llegan como eventos y se pintan a
 * medida que avanzan. Las aprobaciones esperan aquí la decisión del usuario.
 */
export default function Coordinator({ project, hidden, onDiff, onProfile }: Props) {
  const [info, setInfo] = useState<Opened | null>(null);
  const [items, setItems] = useState<CItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [limits, setLimits] = useState<RateLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [effort, setEffort] = useState('medium');
  const thread = useRef<string | null>(null);
  const onProfileRef = useRef(onProfile);
  onProfileRef.current = onProfile;

  const open = useCallback(() => {
    setOpening(true);
    setError(null);
    coordinator.open(project).then(
      (o) => {
        thread.current = o.threadId;
        setInfo(o);
        setItems(o.turns.flatMap((t) => t.items));
        setRunning(o.activeTurn);
        setLimits(o.rateLimits);
        setApprovals([]);
        setEffort(o.efforts.includes('medium') ? 'medium' : (o.efforts[0] ?? 'medium'));
        onProfileRef.current(o.profile);
        setOpening(false);
      },
      (e) => {
        setError(String(e));
        setOpening(false);
      },
    );
  }, [project]);

  useEffect(() => {
    thread.current = null;
    setInfo(null);
    setItems([]);
    open();
  }, [open]);

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
        setRunning(null);
        setApprovals([]);
        setError('Codex se ha cerrado; se volverá a abrir al enviar el siguiente mensaje');
        return;
      }
      if (method === 'account/rateLimits/updated') return setLimits(params.rateLimits);
      if (!thread.current || params?.threadId !== thread.current) return;
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
    return coordinator.send(project, text, effort).catch((e) => {
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
    coordinator.setProfile(project, profile).then(open, (e) => setError(String(e)));
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

  return (
    <section className="coach" aria-label="Coordinador" hidden={hidden}>
      <div className="co-head">
        <select
          className="co-profile"
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
        </select>
        <span className="muted">codex{info?.model ? ` · ${info.model}` : ''}</span>
        <span className={`co-state is-${state.replace(' ', '-')}`}>{state}</span>
        <Quota limits={limits} />
      </div>

      <ConversationLog items={items} asks={asks} agent={profileName.toLowerCase()} project={project} onDiff={onDiff}>
        {opening && <div className="muted">abriendo el coordinador…</div>}
        {!opening && info && items.length === 0 && <div className="muted co-empty">Cuéntale a {profileName} qué hay que hacer en este proyecto.</div>}
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
        efforts={info?.efforts ?? ['medium']}
        effort={effort}
        onEffort={setEffort}
        onSend={send}
        onInterrupt={() => coordinator.interrupt(project).catch((e) => setError(String(e)))}
        placeholder="escribe un encargo · ⌘↩ para enviar"
      />
    </section>
  );
}
