import { pushAgentCompletion, pushOperationalError } from './trama/notifications';
import { useSharedPermissions } from './trama/pendingPermissions';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { sessions, type AcpOption, type Change, type CItem, type ChatAttachment, type Decision, type DiffTarget, type Session as SessionInfo, type SessionEvent } from './ipc';
import type { ConversationWorkflow } from './trama/ConversationPlan';
import { buildEffortOptions, Composer, ConversationLog, ConversationObservation, effortLabel, useChatHistory, withAttachmentNames, type Ask } from './Conversation';
import { beep, shortcut, useReportActivity } from './ui';
import { pmActivityKey } from './trama/workspaceContext';
import Coordinator from './Coordinator';
import ChipMenu from './ChipMenu';
import ModelConfigMenu, { type ProviderSwitch, type ReasoningGroup } from './ModelConfigMenu';
import { contextRemaining, LOW_REMAINING, percentLabel, reportQuotaLimit } from './usageStore';
import { PermissionChip, SessionContext, usePermissionMode } from './trama/SessionBar';
import { Icon } from './trama/icons';

export const ENGINE_LABEL: Record<string, string> = { codex: 'codex', claude: 'claude code', opencode: 'opencode', agy: 'antigravity', devin: 'devin' };
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** Petición de permiso pendiente, ya traducida para la tarjeta. */
type Pending = Omit<Ask, 'decide' | 'key'> & { requestId: string; toolUseId?: string };

const textOf = (content: any): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c?.type === 'text' ? c.text : '')).join('\n') : '';

/** Lo más útil de la entrada de una herramienta para una línea de resumen. */
const brief = (input: any): string =>
  String(input?.file_path ?? input?.notebook_path ?? input?.filePath ?? input?.path ?? input?.Path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? input?.command ?? '');

// ── Claude Code (stream-json) ───────────────────────────────────────────

/** Un bloque `tool_use` de Claude Code como ítem de la conversación. */
function claudeTool(id: string, name: string, input: any): CItem {
  if (name === 'Bash') return { id, type: 'commandExecution', command: input?.command ?? '', status: 'inProgress', aggregatedOutput: null, exitCode: null };
  if (EDIT_TOOLS.includes(name))
    return { id, type: 'fileChange', status: 'inProgress', changes: [{ path: input?.file_path ?? input?.notebook_path ?? '', kind: { type: 'update' } }] };
  if (name === 'TodoWrite')
    return { id, type: 'plan', text: (input?.todos ?? []).map((t: any) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '›' : '·'} ${t.content}`).join('\n') };
  if (name.startsWith('mcp__filigranas__')) {
    const short = name.slice('mcp__filigranas__'.length);
    const detail = input?.titulo ?? input?.sesion ?? brief(input);
    return { id, type: 'mcpToolCall', tool: detail ? `${short} · ${detail}` : short, status: 'inProgress' };
  }
  return { id, type: 'mcpToolCall', tool: `${name} ${brief(input)}`.trim(), status: 'inProgress' };
}

/** Bloques de un mensaje `assistant` como ítems (texto, razonamiento, herramientas). */
function assistantItems(message: any): CItem[] {
  const blocks: any[] = Array.isArray(message?.content) ? message.content : [];
  return blocks.flatMap((b, i): CItem[] => {
    const id = b.id ?? `${message.id}:${i}`;
    if (b.type === 'text' && b.text?.trim()) return [{ id, type: 'agentMessage', text: b.text }];
    if (b.type === 'thinking' && b.thinking?.trim()) return [{ id, type: 'reasoning', summary: [b.thinking] }];
    if (b.type === 'tool_use') return [claudeTool(b.id, b.name, b.input)];
    return [];
  });
}

/** Aplica los `tool_result` de un mensaje `user` a sus herramientas. */
function applyResults(list: CItem[], message: any, declined: Set<string>): CItem[] {
  const results: any[] = Array.isArray(message?.content) ? message.content.filter((c: any) => c?.type === 'tool_result') : [];
  if (!results.length) return list;
  return list.map((it) => {
    const r = results.find((x) => x.tool_use_id === it.id);
    if (!r) return it;
    const status = declined.has(it.id) ? 'declined' : r.is_error ? 'failed' : 'completed';
    if (it.type === 'commandExecution') return { ...it, status, exitCode: r.is_error ? 1 : 0, aggregatedOutput: textOf(r.content) };
    return { ...it, status };
  });
}

/** Historial guardado (transcript de Claude Code) como ítems. */
function historyItems(entries: any[]): CItem[] {
  let list: CItem[] = [];
  entries.forEach((e, i) => {
    if (e.type === 'assistant') {
      const fresh = assistantItems(e.message).filter((it) => !list.some((x) => x.id === it.id));
      list = [...list, ...fresh];
    } else if (typeof e.message?.content === 'string' || e.message?.content?.some?.((c: any) => c?.type === 'text')) {
      const text = textOf(e.message.content);
      if (text.trim()) list = [...list, { id: `h${i}`, type: 'userMessage', content: [{ type: 'text', text }] }];
    } else {
      list = applyResults(list, e.message, new Set());
    }
  });
  return list;
}

function claudeAsk(msg: any): Pending {
  const r = msg.request;
  const isEdit = EDIT_TOOLS.includes(r.tool_name);
  return {
    requestId: msg.request_id,
    toolUseId: r.tool_use_id,
    title: r.tool_name === 'Bash' ? 'quiere ejecutar' : isEdit ? 'quiere cambiar archivos' : `quiere usar ${r.tool_name}`,
    command: r.tool_name === 'Bash' ? r.input?.command : undefined,
    files: isEdit ? [r.input?.file_path ?? r.input?.notebook_path ?? ''] : undefined,
    detail: r.tool_name !== 'Bash' && !isEdit ? brief(r.input) || JSON.stringify(r.input, null, 2) : undefined,
    reason: [r.decision_reason, r.description].find((x) => typeof x === 'string' && x.trim()),
  };
}

// ── ACP (OpenCode, Antigravity, Devin) ──────────────────────────────────

const ACP_STATUS: Record<string, string> = { pending: 'inProgress', in_progress: 'inProgress', completed: 'completed', failed: 'failed' };

/** Rutas de un `tool_call` ACP: diffs y ubicaciones. */
const acpPaths = (call: any): string[] => [
  ...new Set<string>([
    ...(call?.content ?? []).filter((c: any) => c?.type === 'diff' && c.path).map((c: any) => c.path),
    ...(call?.locations ?? []).map((l: any) => l?.path).filter(Boolean),
  ]),
];

/** Texto de salida de un `tool_call` ACP. */
const acpOutput = (call: any): string =>
  (call?.content ?? [])
    .map((c: any) => (c?.type === 'content' && c.content?.type === 'text' ? c.content.text : ''))
    .filter(Boolean)
    .join('\n');

/** Comando de un `tool_call` de ejecución; cada agente lo nombra a su modo. */
const acpCommand = (call: any): string => {
  const raw = call?.rawInput ?? {};
  const command = raw.command ?? raw.CommandLine ?? raw.cmd;
  return Array.isArray(command) ? command.join(' ') : (command ?? call?.title ?? '');
};

function acpTool(call: any): CItem {
  const id = call.toolCallId;
  const status = ACP_STATUS[call.status] ?? 'inProgress';
  if (call.kind === 'execute')
    return { id, type: 'commandExecution', command: acpCommand(call), status, aggregatedOutput: acpOutput(call) || null, exitCode: status === 'completed' ? 0 : null };
  if (['edit', 'delete', 'move'].includes(call.kind))
    return { id, type: 'fileChange', status, changes: acpPaths(call).map((path) => ({ path, kind: { type: call.kind === 'delete' ? 'delete' : 'update' } })) };
  return { id, type: 'mcpToolCall', tool: call.title ?? call.kind ?? 'herramienta', status };
}

function acpAsk(msg: any): Pending {
  const call = msg.toolCall ?? {};
  return {
    requestId: msg.requestId,
    toolUseId: call.toolCallId,
    title: call.kind === 'execute' ? 'quiere ejecutar' : ['edit', 'delete', 'move'].includes(call.kind) ? 'quiere cambiar archivos' : `quiere usar ${call.title ?? 'una herramienta'}`,
    command: call.kind === 'execute' ? acpCommand(call) : undefined,
    files: acpPaths(call),
    detail: call.kind !== 'execute' && !acpPaths(call).length ? call.title : undefined,
  };
}

// ── componente ──────────────────────────────────────────────────────────

type Props = {
  session: SessionInfo;
  project: string;
  hidden: boolean;
  switching?: boolean;
  providerSwitch?: ProviderSwitch;
  onDiff: (c: DiffTarget) => void;
  quotaNear?: boolean;
  onOpenFile?: (path: string) => void;
  onConflicts?: (files: string[]) => void;
  onModel: (key: number | string, model: string | null) => void;
  workflow?: ConversationWorkflow;
  observation?: HTMLElement | null;
  manager?: { task: { id: number; title: string } | null; clearTask: () => void };
  /** Abre Trabajo para empezar la sesión de trabajo que exigen las sesiones directas. */
  onStartWork?: () => void;
  /** Ámbito de permisos de la sesión padre para heredar el modo en subsesiones. */
  parentPermissionScope?: string;
};

// Error del backend cuando no hay sesión de trabajo activa (src-tauri/src/work.rs).
const NEEDS_WORK = /inicia una sesión de trabajo/i;

/** Conversación con una sesión de agente ejecutor del proyecto. */
export default function Session({ session, project, hidden, switching, providerSwitch, onDiff, quotaNear, onOpenFile, onConflicts, onModel, workflow, observation, manager, onStartWork, parentPermissionScope }: Props) {
  const isManager = manager !== undefined;
  const isClaude = session.engine === 'claude';
  const isCodex = session.engine === 'codex';
  const history = useChatHistory(project, isClaude ? (manager ? null : session.id) : undefined);
  const [items, setItems] = useState<CItem[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [providerRunning, setRunning] = useState(session.status === 'trabajando');
  const [directState, setDirectState] = useState('inactiva');
  const [codexHasWork, setCodexHasWork] = useState(false);
  const running = isCodex ? ['en marcha', 'esperando permiso'].includes(directState) : providerRunning;
  const [starting, setStarting] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [context, setContext] = useState<number | null>(null);
  const claudeContext = useRef<{ model: string; used: number } | null>(null);
  const claudeWindows = useRef<Record<string, number>>({});

  const [claudeModels, setClaudeModels] = useState<{ id: string; label: string }[]>([]);
  const [loadingClaudeModels, setLoadingClaudeModels] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (error) pushOperationalError(error, { source: ENGINE_LABEL[session.engine] ?? session.engine, action: { label: 'Abrir sesión', target: 'session', session: session.id, project } }); }, [error, session.engine, session.id, project]);
  const [effort, setEffort] = useState(session.effort ?? 'medium');
  const declined = useRef(new Set<string>());
  // ACP no numera los mensajes: el texto se acumula en el ítem en curso
  // hasta que aparece otro tipo de ítem.
  const current = useRef<{ kind: string; id: string } | null>(null);
  const replaying = useRef(false);

  // Rama aislada: cambios frente al commit de partida e integración.
  // Una subsesión comparte la carpeta del padre y no integra por su cuenta.
  const isolated = !!session.worktree && session.parentSession == null;
  const [changes, setChanges] = useState<Change[]>([]);
  const [showChanges, setShowChanges] = useState(false);
  const [integrated, setIntegrated] = useState(!!session.integrated);
  const [notice, setNotice] = useState<string | null>(null);
  const [autoNotes, setAutoNotes] = useState<string[]>([]);
  const permission = usePermissionMode(session.id, null, manager ? `pm:${project}` : undefined, parentPermissionScope, session.engine === 'agy');
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState<string | null>(session.paused);
  const pausedReason = useRef<string | null>(session.paused);
  useEffect(() => {
    if (isCodex) return;
    if (session.status === 'trabajando') setRunning(true);
    else if (session.status === 'terminada') setRunning(false);
  }, [isCodex, session.status]);
  useEffect(() => {
    if (isCodex && directState === 'en marcha') setPaused(null);
  }, [directState, isCodex]);
  // Modelo y razonamiento elegibles en los agentes ACP.
  const [acpOptions, setAcpOptions] = useState<AcpOption[]>([]);
  const modelOption = acpOptions.find((o) => o.category === 'model');
  const displayedModel = claudeModels.find((m) => m.id === pinned)?.label ?? pinned
    ?? modelOption?.options.find((m) => m.value === modelOption.currentValue)?.name ?? modelOption?.currentValue ?? model;
  useEffect(() => {
    if (!hidden && !isCodex) onModel(isManager ? project : session.id, displayedModel);
  }, [displayedModel, hidden, isCodex, onModel, project, isManager, session.id]);
  // La integración directa chocó: se ofrece fusionar con marcas.
  const [clash, setClash] = useState(false);
  const diffLabel = `${session.branch} frente a ${session.base}`;
  const openDiff = (c: Change) => onDiff(isolated ? { ...c, session: session.id, label: diffLabel } : c);

  const refreshChanges = useCallback(() => {
    if (isolated) sessions.changes(session.id).then((st) => setChanges(st.changes), (e) => setError(String(e)));
  }, [isolated, session.id]);
  useEffect(() => {
    if (!isolated || hidden) return;
    const unlisten = listen('project-changed', refreshChanges);
    refreshChanges();
    return () => {
      unlisten.then((off) => off());
    };
  }, [hidden, isolated, refreshChanges]);

  useEffect(() => {
    // Fragmento de texto en el ítem en curso de ese tipo (o uno nuevo).
    const chunk = (type: 'agentMessage' | 'reasoning' | 'userMessage', delta: string, fixedId?: string) =>
      setItems((list) => {
        const cur = current.current;
        if (!fixedId && cur?.kind === type && list.some((it) => it.id === cur.id)) {
          return list.map((it) => {
            if (it.id !== cur.id) return it;
            if (type === 'reasoning') return { ...it, summary: [(it.summary?.[0] ?? '') + delta] };
            if (type === 'userMessage') return { ...it, content: [{ type: 'text', text: (it.content?.[0]?.text ?? '') + delta }] };
            return { ...it, text: (it.text ?? '') + delta };
          });
        }
        const id = fixedId ?? `${type}-${Date.now()}-${list.length}`;
        if (fixedId) {
          const at = list.findIndex((it) => it.id === id);
          if (at >= 0) return list.map((it, i) => (i !== at ? it : type === 'agentMessage' ? { ...it, text: (it.text ?? '') + delta } : { ...it, summary: [(it.summary?.[0] ?? '') + delta] }));
        }
        if (!fixedId) current.current = { kind: type, id };
        const item: CItem =
          type === 'reasoning' ? { id, type, summary: [delta] } : type === 'userMessage' ? { id, type, content: [{ type: 'text', text: delta }] } : { id, type, text: delta };
        return [...list, item];
      });

    const unlisten = listen<SessionEvent>('session', ({ payload: { id, msg } }) => {
      if (id !== session.id) return;
      switch (msg.type) {
        // Claude Code
        case 'stream_event': {
          setRunning(true); // también un turno que no empezó aquí (relevo)
          const d = msg.event?.delta;
          if (d?.type === 'text_delta') chunk('agentMessage', d.text, 'live');
          else if (d?.type === 'thinking_delta') chunk('reasoning', d.thinking, 'live-think');
          break;
        }
        case 'assistant': {
          const usage = msg.message?.usage;
          const modelId = msg.message?.model;
          if (isClaude && typeof modelId === 'string' && typeof usage?.input_tokens === 'number') {
            const used = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
            claudeContext.current = { model: modelId, used };
            setContext(contextRemaining(used, claudeWindows.current[modelId]));
          }
          setItems((list) => {
            const fresh = assistantItems(msg.message);
            return [...list.filter((it) => !it.id.startsWith('live') && !fresh.some((f) => f.id === it.id)), ...fresh];
          });
          break;
        }
        case 'user':
          setItems((list) => applyResults(list, msg.message, declined.current));
          break;
        case 'control_request':
          setPending((p) => [...p, claudeAsk(msg)]);
          break;
        case 'result': {
          if (!msg.is_error && (!msg.subtype || msg.subtype === 'success')) pushAgentCompletion(project, session.id, session.title || session.name);
          for (const [id, metrics] of Object.entries(msg.modelUsage ?? {})) {
            const size = (metrics as { contextWindow?: number })?.contextWindow;
            if (typeof size === 'number' && size > 0) claudeWindows.current[id] = size;
          }
          const last = claudeContext.current;
          if (last) setContext(contextRemaining(last.used, claudeWindows.current[last.model]));
          if (msg.is_error && typeof msg.result === 'string' && msg.result.toLowerCase().includes('prompt is too long')) setContext(0);
          refreshChanges();
          setRunning(false);
          setItems((list) => list.filter((it) => !it.id.startsWith('live')));
          if (!pausedReason.current && (msg.is_error || (msg.subtype && msg.subtype !== 'success'))) setError(msg.result || `la sesión terminó con error (${msg.subtype})`);
          break;
        }
        case 'system':
          if (msg.model) setModel(msg.model);
          break;
        case 'model_catalog':
          if (Array.isArray(msg.models)) setClaudeModels(msg.models);
          break;

        // ACP
        case 'replay':
          replaying.current = true;
          current.current = null;
          setItems([]);
          break;
        case 'ready':
          replaying.current = false;
          current.current = null;
          setStarting(false);
          if (msg.model) setModel(msg.model);
          if (Array.isArray(msg.options)) setAcpOptions(msg.options);
          if (typeof msg.running === 'boolean') setRunning(msg.running);
          break;
        case 'update': {
          const u = msg.update ?? {};
          if (!replaying.current && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(u.sessionUpdate)) setRunning(true);
          switch (u.sessionUpdate) {
            case 'agent_message_chunk':
              if (u.content?.type === 'text') chunk('agentMessage', u.content.text);
              break;
            case 'agent_thought_chunk':
              if (u.content?.type === 'text') chunk('reasoning', u.content.text);
              break;
            case 'usage_update':
              setContext(contextRemaining(u.used, u.size));
              break;
            case 'user_message_chunk':
              // En vivo el mensaje propio ya está pintado; solo al reanudar.
              if (replaying.current && u.content?.type === 'text') chunk('userMessage', u.content.text);
              break;
            case 'tool_call':
              current.current = null;
              setItems((list) => [...list.filter((it) => it.id !== u.toolCallId), acpTool(u)]);
              break;
            case 'tool_call_update':
              setItems((list) =>
                list.map((it) => {
                  if (it.id !== u.toolCallId) return it;
                  const status = declined.current.has(it.id) && u.status === 'failed' ? 'declined' : (ACP_STATUS[u.status] ?? it.status);
                  const output = acpOutput(u);
                  const paths = acpPaths(u);
                  return {
                    ...it,
                    status,
                    ...(it.type === 'commandExecution' && output ? { aggregatedOutput: output } : {}),
                    ...(it.type === 'commandExecution' && status === 'completed' ? { exitCode: 0 } : {}),
                    ...(it.type === 'fileChange' && paths.length ? { changes: paths.map((path) => ({ path, kind: { type: 'update' } })) } : {}),
                    ...(it.type === 'mcpToolCall' && u.title ? { tool: u.title } : {}),
                  };
                }),
              );
              break;
            case 'plan':
              current.current = null;
              setItems((list) => [
                ...list.filter((it) => it.id !== 'plan'),
                { id: 'plan', type: 'plan', text: (u.entries ?? []).map((e: any) => `${e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '›' : '·'} ${e.content}`).join('\n') },
              ]);
              break;
          }
          break;
        }
        case 'policy_denied':
          setError(msg.message);
          break;
        case 'permission':
          setPending((p) => [...p, acpAsk(msg)]);
          break;
        case 'auto_approved': {
          // El núcleo aprobó por su cuenta según el nivel de permisos de la sesión.
          const call = msg.toolCall as { title?: string; kind?: string } | undefined;
          const input = msg.input as { file_path?: string; path?: string; command?: string } | undefined;
          const what = call ? call.title ?? call.kind ?? 'acción' : `${msg.tool ?? 'herramienta'}${input?.file_path ?? input?.path ? ` · ${input?.file_path ?? input?.path}` : input?.command ? ` · ${input.command.slice(0, 120)}` : ''}`;
          setAutoNotes((n) => [...n.slice(-19), `Aprobado automáticamente: ${what}`]);
          break;
        }
        case 'turn_end':
          if (msg.stopReason === 'end_turn') pushAgentCompletion(project, session.id, session.title || session.name);
          refreshChanges();
          setRunning(false);
          current.current = null;
          if (msg.stopReason && msg.stopReason !== 'end_turn' && msg.stopReason !== 'cancelled') setError(`el turno terminó: ${msg.stopReason}`);
          break;
        case 'error':
          setRunning(false);
          setStarting(false);
          setError(msg.message);
          break;

        case 'paused':
          if (typeof msg.reason === 'string' && msg.reason.startsWith('cuota agotada:')) {
            if (isClaude) reportQuotaLimit('claude');
            if (isCodex) reportQuotaLimit('codex');
          }
          pausedReason.current = msg.reason;
          setPaused(msg.reason);
          setPending([]);
          setError(null);
          setStarting(false);
          setRunning(false);
          break;
        case 'exit':
          setStarting(false);
          setRunning((was) => {
            if (was) setError('el proceso del agente terminó; se reanudará al enviar otro mensaje');
            return false;
          });
          setPending([]);
          break;
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [session.id, refreshChanges, isClaude, isCodex]);

  // Después de escuchar: la carga de una sesión ACP llega como eventos.
  useEffect(() => {
    if (isCodex) return;
    if (!isClaude && session.providerSession) setStarting(true);
    sessions.history(session.id).then(
      (h) => {
        if (isClaude) setItems(historyItems(h));
      },
      (e) => {
        setStarting(false);
        setError(String(e));
      },
    );
  }, [session.id, isClaude, isCodex, session.providerSession]);

  useEffect(() => {
    if (!isClaude || hidden) return;
    let active = true;
    setLoadingClaudeModels(true);
    sessions.claudeOptions(session.id).then(({ models, pinnedModel }) => {
      if (!active) return;
      if (models.length) setClaudeModels(models);
      setPinned(pinnedModel);
    }, () => {}).finally(() => {
      if (active) setLoadingClaudeModels(false);
    }); // El envío sigue mostrando errores del proveedor.
    return () => { active = false; };
  }, [hidden, isClaude, session.id]);

  const send = (text: string, attachments: ChatAttachment[]) => {
    setError(null);
    pausedReason.current = null;
    setPaused(null);
    setRunning(true);
    current.current = null;
    setItems((list) => [...list, { id: `local-${Date.now()}`, type: 'userMessage', content: [{ type: 'text', text: withAttachmentNames(text, attachments) }] }]);
    return sessions.send(session.id, text, isClaude ? effort : null, manager?.task?.id ?? null, attachments, session.engine).catch((e) => {
      setRunning(false);
      setError(String(e));
      setItems((list) => list.filter((it) => !it.id.startsWith('local-')));
      throw e;
    });
  };

  const decide = (p: Pending, d: Decision) => {
    if ((d === 'decline' || d === 'cancel') && p.toolUseId) declined.current.add(p.toolUseId);
    setPending((list) => list.filter((x) => x !== p));
    sessions.respond(p.requestId, d).catch((e) => setError(String(e)));
  };

  const integrate = () => {
    setBusy(true);
    setError(null);
    sessions
      .integrate(session.id)
      .then(
        (files) => {
          setIntegrated(true);
          setClash(false);
          setNotice(`Integrado en ${session.base}: ${files.length} archivo${files.length === 1 ? '' : 's'} como cambios sin commit. Revísalos en el proyecto; Larry propondrá los commits.`);
        },
        (e) => {
          setError(String(e));
          setClash(String(e).includes('sin conflictos'));
        },
      )
      .finally(() => {
        setBusy(false);
        refreshChanges();
      });
  };

  const integrateMerging = () => {
    setBusy(true);
    setError(null);
    sessions
      .integrateMerging(session.id)
      .then(
        ({ files, conflicts }) => {
          setIntegrated(true);
          setClash(false);
          if (conflicts.length) onConflicts?.(conflicts);
          setNotice(
            conflicts.length
              ? `Integrado con conflictos en ${conflicts.join(', ')}: resuélvelos en el editor (marcas <<<<<<< proyecto / >>>>>>> ${session.branch}). El resto de los ${files.length} archivos ya está aplicado.`
              : `Integrado en ${session.base} sin conflictos: ${files.length} archivos.`,
          );
        },
        (e) => setError(String(e)),
      )
      .finally(() => {
        setBusy(false);
        refreshChanges();
      });
  };

  const cleanup = () => {
    setBusy(true);
    sessions.cleanup(session.id).catch((e) => {
      setError(String(e));
      setBusy(false);
    });
  };

  const setOption = (key: string, value: string) => {
    setError(null);
    sessions.setOption(session.id, key, value).then(
      (opts) => {
        setAcpOptions(opts);
        const m = opts.find((o) => o.category === 'model');
        if (m) setModel(m.options.find((x) => x.value === m.currentValue)?.name ?? m.currentValue);
      },
      (e) => setError(String(e)),
    );
  };

  const resume = () => {
    setError(null);
    pausedReason.current = null;
    setPaused(null);
    setRunning(true);
    sessions.resume(session.id).catch((e) => {
      setRunning(false);
      setError(String(e));
    });
  };

  const handoff = (engine: string) => {
    if (!engine) return;
    setBusy(true);
    setError(null);
    sessions.handoff(session.id, engine).catch((e) => {
      setError(String(e));
      setBusy(false);
    });
  };

  const ownedAsks: Ask[] = pending.map((p) => ({ ...p, key: p.requestId, decide: (d) => decide(p, d) }));
  const asks = useSharedPermissions(project, manager || isCodex ? null : session.id, session.name, session.worktree ?? project, ownedAsks);
  const state = isCodex ? directState : pending.length ? 'esperando permiso' : running ? 'en marcha' : paused ? 'en pausa' : starting ? 'arrancando' : 'inactiva';
  useReportActivity(manager ? pmActivityKey(project) : String(session.id), state);
  const engine = ENGINE_LABEL[session.engine] ?? session.engine;
  const contextLow = context !== null && context <= LOW_REMAINING;
  const quotaBlocked = !!paused?.startsWith('cuota agotada:');
  const mayHandoff = !manager && (contextLow || quotaNear || quotaBlocked) && (!!session.task || items.length > 0 || codexHasWork || running || quotaBlocked);


  return (
    <section className="coach" aria-label={`Sesión ${session.name}`} hidden={hidden}>
      <div className="co-head">
        <span className="push" />
        {running && (
          <button className="co-link" onClick={() => sessions.pause(session.id).catch((e) => setError(String(e)))} title="detiene el turno y deja la sesión en pausa">
            pausar
          </button>
        )}
        {contextLow && <span className="usage-limit" title="Contexto restante de esta sesión">{percentLabel(context)} de contexto</span>}
        {mayHandoff && <ChipMenu
          className="is-down"
          label="Relevar la tarea a otro motor"
          heading="Relevar a"
          value=""
          display="relevar a…"
          disabled={busy}
          title="pasa la tarea a otro motor en la misma rama"
          options={[
            ...(session.engine !== 'codex' ? [{ value: 'codex', label: 'Codex', hint: 'Sigue en la misma rama y carpeta' }] : []),
            ...(session.engine !== 'claude' ? [{ value: 'claude', label: 'Claude Code', hint: 'Sigue en la misma rama y carpeta' }] : []),
          ]}
          onChange={handoff}
        />}
      </div>
      {paused && (
        <div className="co-paused" role="status">
          <span>en pausa · {paused}</span>
          <button className="co-btn" onClick={resume} disabled={busy}>
            retomar
          </button>
        </div>
      )}
      {isolated && (
        <div className="co-branch">
          <button className="co-link" aria-expanded={showChanges} onClick={() => setShowChanges((v) => !v)} disabled={!changes.length}>
            {changes.length ? `${changes.length} cambio${changes.length === 1 ? '' : 's'}` : 'sin cambios'}
          </button>
          <span className="push" />
          <button className="co-btn" onClick={integrate} disabled={busy || running || !changes.length} title="aplica sus cambios al proyecto, sin commit">
            integrar en {session.base}
          </button>
          {clash && (
            <button className="co-btn" onClick={integrateMerging} disabled={busy || running} title="aplica lo que encaja y deja marcas de conflicto para resolver en el editor">
              integrar con conflictos
            </button>
          )}
          {integrated && (
            <button className="co-btn" onClick={cleanup} disabled={busy || running} title="borra la rama y su worktree y cierra la sesión">
              limpiar rama
            </button>
          )}
        </div>
      )}
      {isolated && showChanges && changes.length > 0 && (
        <div className="co-changes">
          {changes.map((c) => (
            <div key={c.path} className="co-change-row">
              <button className="git-change" onClick={() => openDiff(c)} title={c.orig ? `${c.orig} → ${c.path}` : `diff de ${c.path}`}>
                <span className="co-status">{c.status}</span>
                <span className="git-path">{c.path}</span>
                {c.adds != null && <span className="add">+{c.adds}</span>}
                {c.dels != null && <span className="del">−{c.dels}</span>}
              </button>
              {c.status !== 'D' && (
                <button className="co-link" onClick={() => onOpenFile?.(`${session.worktree}/${c.path}`)} title="abrir en el editor (en la rama de la sesión)">
                  editar
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {isCodex ? <>
        {notice && <div className="co-notice">{notice}</div>}
        {error && (NEEDS_WORK.test(error) && onStartWork ? (
          <div className="co-error co-needs-work" role="alert">
            <span className="grow">Las sesiones directas trabajan en el checkout del proyecto: antes hay que fijar un objetivo y una rama en una sesión de trabajo. Si prefieres no tocar el checkout, abre una sesión aislada.</span>
            <button className="co-link" onClick={onStartWork}>Iniciar sesión de trabajo</button>
          </div>
        ) : <div className="co-error">{error}</div>)}
        <Coordinator project={project} session={session} hidden={hidden} switching={switching} providerSwitch={providerSwitch} onDiff={openDiff} observation={observation} onActivity={setDirectState} onModel={onModel}
          onContext={setContext} onConversation={setCodexHasWork} />
      </> : <>
      {observation && <ConversationObservation target={observation} items={[...history.items, ...items]}
        agent={session.name} project={session.worktree ?? project} onDiff={openDiff} />}
      <ConversationLog items={[...history.items, ...items]} asks={asks} agent={session.name} project={session.worktree ?? project} onDiff={openDiff} workflow={hidden ? undefined : workflow}>
        {history.error && <div className="co-error">{history.error}</div>}
        {items.length === 0 && !history.items.length && !error && !starting && <div className="co-empty">¿Qué hacemos?</div>}
        {starting && items.length === 0 && <div className="muted">recuperando la sesión de {engine}…</div>}
        {notice && <div className="co-notice">{notice}</div>}
        {autoNotes.map((note, i) => <div key={i} className="co-auto"><Icon name="check" size={12} />{note}</div>)}
        {permission.error && <div className="co-error">{permission.error}</div>}
        {error && (NEEDS_WORK.test(error) && onStartWork ? (
          <div className="co-error co-needs-work" role="alert">
            <span className="grow">Las sesiones directas trabajan en el checkout del proyecto: antes hay que fijar un objetivo y una rama en una sesión de trabajo. Si prefieres no tocar el checkout, abre una sesión aislada.</span>
            <button className="co-link" onClick={onStartWork}>Iniciar sesión de trabajo</button>
          </div>
        ) : <div className="co-error">{error}</div>)}
      </ConversationLog>
      {(() => {
        const engineTitle = isClaude ? 'Claude Code' : engine;
        const claudeEfforts = isClaude ? ['auto', ...CLAUDE_EFFORTS] : [];
        const acpReasoning = acpOptions.filter((o) => o.category !== 'model');
        const modelDisplay = isClaude
          ? (pinned ? claudeModels.find((item) => item.id === pinned)?.label ?? pinned : (claudeModels.length ? 'Automático' : (model ?? 'Automático')))
          : (modelOption ? (modelOption.options.find((x) => x.value === modelOption.currentValue)?.name ?? modelOption.currentValue) : (model ?? ''));
        const modelConfig = isClaude && claudeModels.length
          ? {
              value: pinned ?? '',
              disabled: running || !!switching,
              options: [
                { value: '', label: 'Automático', hint: model ? `Claude Code elige; ahora ${model}` : 'Claude Code elige el modelo' },
                ...(pinned && !claudeModels.some((item) => item.id === pinned) ? [{ value: pinned, label: pinned, hint: 'No disponible', disabled: true }] : []),
                ...claudeModels.map((item) => ({ value: item.id, label: item.label })),
              ],
              onChange: (value: string) => {
                sessions.setOption(session.id, 'model', value).then(() => { setPinned(value || null); setContext(null); claudeContext.current = null; }, (err) => setError(String(err)));
              },
            }
          : modelOption
            ? {
                value: modelOption.currentValue,
                disabled: running,
                options: modelOption.options.map((x) => ({ value: x.value, label: x.name })),
                onChange: (value: string) => setOption(modelOption.id, value),
              }
            : undefined;
        const reasoningGroups: ReasoningGroup[] = isClaude
          ? [{
              id: 'effort',
              heading: 'Razonamiento',
              value: effort,
              disabled: switching === true,
              options: buildEffortOptions(claudeEfforts, 'Claude Code usa su nivel por defecto'),
              onChange: (value) => { beep('tick'); setEffort(value); },
            }]
          : acpReasoning.map((o) => ({
              id: o.id,
              heading: o.name || 'Razonamiento',
              value: o.currentValue,
              disabled: running,
              options: o.options.map((x) => ({ value: x.value, label: x.name })),
              onChange: (value) => setOption(o.id, value),
            }));
        const reasoningDisplay = isClaude
          ? effortLabel(effort)
          : acpReasoning.map((o) => o.options.find((x) => x.value === o.currentValue)?.name ?? o.currentValue).filter(Boolean).join(' · ') || undefined;
        return (
          <Composer
            context={<SessionContext project={project} worktree={session.worktree} branch={session.branch} base={session.base} hidden={hidden} />}
            permission={<PermissionChip restricted={session.engine === 'agy'} mode={permission.mode} onMode={permission.setMode} disabled={switching === true} />}
            draftKey={manager ? `pm:${project}` : `session:${session.id}`}
            disabled={switching === true}
            running={running}
            efforts={claudeEfforts}
            effort={effort}
            onEffort={setEffort}
            model={
              <ModelConfigMenu
                persistKey={manager ? `pm:${project}` : `session:${session.id}`}
                hidden={hidden}
                switching={switching === true}
                loadingModels={isClaude && loadingClaudeModels && !claudeModels.length}
                engine={session.engine}
                engineLabel={engineTitle}
                provider={providerSwitch}
                modelDisplay={modelDisplay}
                model={modelConfig}
                reasoning={reasoningGroups}
                reasoningDisplay={reasoningDisplay}
                disabled={switching === true}
                title={shortcut(isClaude ? 'Proveedor, modelo y razonamiento · ⌘M · ⌘⇧E' : 'Modelo y razonamiento · ⌘M')}
              />
            }
            topExtra={manager?.task && (
              <button className="co-top-chip" onClick={manager.clearTask} title="Desvincular los próximos mensajes" disabled={running}>
                <span>#{manager.task.id} {manager.task.title}</span>
                <span className="co-top-x" aria-hidden="true">×</span>
              </button>
            )}
            onSend={send}
            onInterrupt={() => sessions.interrupt(session.id).catch((e) => setError(String(e)))}
            placeholder="/filigranas"
          />
        );
      })()}
      </>}
    </section>
  );
}
