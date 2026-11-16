import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { sessions, type Change, type CItem, type Decision, type Session as SessionInfo, type SessionEvent } from './ipc';
import { Composer, ConversationLog, type Ask } from './Conversation';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

type Pending = { requestId: string; tool: string; input: any; toolUseId?: string; reason?: string };

const textOf = (content: any): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c?.type === 'text' ? c.text : '')).join('\n') : '';

/** Lo más útil de la entrada de una herramienta para una línea de resumen. */
const brief = (input: any): string =>
  String(input?.file_path ?? input?.notebook_path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? input?.command ?? '');

/** Un bloque `tool_use` de Claude Code como ítem de la conversación. */
function toolItem(id: string, name: string, input: any): CItem {
  if (name === 'Bash') return { id, type: 'commandExecution', command: input?.command ?? '', status: 'inProgress', aggregatedOutput: null, exitCode: null };
  if (EDIT_TOOLS.includes(name))
    return { id, type: 'fileChange', status: 'inProgress', changes: [{ path: input?.file_path ?? input?.notebook_path ?? '', kind: { type: 'update' } }] };
  if (name === 'TodoWrite')
    return { id, type: 'plan', text: (input?.todos ?? []).map((t: any) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '›' : '·'} ${t.content}`).join('\n') };
  return { id, type: 'mcpToolCall', tool: `${name} ${brief(input)}`.trim(), status: 'inProgress' };
}

/** Bloques de un mensaje `assistant` como ítems (texto, razonamiento, herramientas). */
function assistantItems(message: any): CItem[] {
  const blocks: any[] = Array.isArray(message?.content) ? message.content : [];
  return blocks.flatMap((b, i): CItem[] => {
    const id = b.id ?? `${message.id}:${i}`;
    if (b.type === 'text' && b.text?.trim()) return [{ id, type: 'agentMessage', text: b.text }];
    if (b.type === 'thinking' && b.thinking?.trim()) return [{ id, type: 'reasoning', summary: [b.thinking] }];
    if (b.type === 'tool_use') return [toolItem(b.id, b.name, b.input)];
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

type Props = { session: SessionInfo; project: string; hidden: boolean; onDiff: (c: Change) => void };

/** Conversación con una sesión de Claude Code del proyecto. */
export default function Session({ session, project, hidden, onDiff }: Props) {
  const [items, setItems] = useState<CItem[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [running, setRunning] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [effort, setEffort] = useState(session.effort ?? 'medium');
  const declined = useRef(new Set<string>());

  useEffect(() => {
    sessions.history(session.id).then((h) => setItems(historyItems(h)), (e) => setError(String(e)));
  }, [session.id]);

  useEffect(() => {
    const live = (type: 'agentMessage' | 'reasoning', delta: string) =>
      setItems((list) => {
        const id = type === 'agentMessage' ? 'live' : 'live-think';
        const at = list.findIndex((it) => it.id === id);
        if (at < 0) return [...list, type === 'agentMessage' ? { id, type, text: delta } : { id, type, summary: [delta] }];
        return list.map((it, i) => (i !== at ? it : type === 'agentMessage' ? { ...it, text: (it.text ?? '') + delta } : { ...it, summary: [(it.summary?.[0] ?? '') + delta] }));
      });

    const unlisten = listen<SessionEvent>('session', ({ payload: { id, msg } }) => {
      if (id !== session.id) return;
      switch (msg.type) {
        case 'stream_event': {
          const d = msg.event?.delta;
          if (d?.type === 'text_delta') live('agentMessage', d.text);
          else if (d?.type === 'thinking_delta') live('reasoning', d.thinking);
          break;
        }
        case 'assistant':
          setItems((list) => {
            const fresh = assistantItems(msg.message);
            const kept = list.filter((it) => !it.id.startsWith('live') && !fresh.some((f) => f.id === it.id));
            return [...kept, ...fresh];
          });
          break;
        case 'user':
          setItems((list) => applyResults(list, msg.message, declined.current));
          break;
        case 'control_request': {
          const r = msg.request;
          setPending((p) => [...p, { requestId: msg.request_id, tool: r.tool_name, input: r.input, toolUseId: r.tool_use_id, reason: [r.decision_reason, r.description].find((x) => typeof x === 'string' && x.trim()) }]);
          break;
        }
        case 'result':
          setRunning(false);
          setItems((list) => list.filter((it) => !it.id.startsWith('live')));
          if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) setError(msg.result || `la sesión terminó con error (${msg.subtype})`);
          break;
        case 'system':
          if (msg.model) setModel(msg.model);
          break;
        case 'exit':
          setRunning((was) => {
            if (was) setError('el proceso de Claude Code terminó; se reanudará al enviar otro mensaje');
            return false;
          });
          setPending([]);
          break;
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [session.id]);

  const send = (text: string) => {
    setError(null);
    setRunning(true);
    setItems((list) => [...list, { id: `local-${Date.now()}`, type: 'userMessage', content: [{ type: 'text', text }] }]);
    return sessions.send(session.id, text, effort).catch((e) => {
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

  const asks: Ask[] = pending.map((p) => ({
    key: p.requestId,
    title: p.tool === 'Bash' ? 'quiere ejecutar' : EDIT_TOOLS.includes(p.tool) ? 'quiere cambiar archivos' : `quiere usar ${p.tool}`,
    command: p.tool === 'Bash' ? p.input?.command : undefined,
    files: EDIT_TOOLS.includes(p.tool) ? [p.input?.file_path ?? p.input?.notebook_path ?? ''] : undefined,
    detail: p.tool !== 'Bash' && !EDIT_TOOLS.includes(p.tool) ? brief(p.input) || JSON.stringify(p.input, null, 2) : undefined,
    reason: p.reason,
    decide: (d) => decide(p, d),
  }));

  const state = pending.length ? 'esperando permiso' : running ? 'en marcha' : 'inactiva';

  return (
    <section className="coach" aria-label={`Sesión ${session.name}`} hidden={hidden}>
      <div className="co-head">
        <span>{session.name}</span>
        <span className="muted">claude code{model ? ` · ${model}` : ''}</span>
        <span className={`co-state is-${state.replace(' ', '-')}`}>{state}</span>
      </div>
      <ConversationLog items={items} asks={asks} agent={session.name} project={project} onDiff={onDiff}>
        {items.length === 0 && !error && <div className="muted co-empty">Sesión nueva de Claude Code en este proyecto. Escribe la tarea.</div>}
        {error && <div className="co-error">{error}</div>}
      </ConversationLog>
      <Composer
        disabled={false}
        running={running}
        efforts={EFFORTS}
        effort={effort}
        onEffort={setEffort}
        onSend={send}
        onInterrupt={() => sessions.interrupt(session.id).catch((e) => setError(String(e)))}
        placeholder="escribe la tarea · ⌘↩ para enviar"
      />
    </section>
  );
}
