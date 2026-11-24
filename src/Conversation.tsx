import { createPortal } from 'react-dom';
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { chats, type Change, type ChatAttachment, type CItem, type Decision } from './ipc';
import { ConversationArchitecture, ConversationChange } from './trama/ConversationCards';
import ConversationPlan, { ConversationTeam, useConversationTasks, type ConversationWorkflow } from './trama/ConversationPlan';
import { useDelegatedPermissions } from './trama/pendingPermissions';
import { StDot } from './trama/kit';
import { readArchitecture } from './trama/conversationContent';
import Splitter, { SIZES } from './Splitter';
import { beep, shortcut } from './ui';

// Piezas comunes a las conversaciones del coordinador y de las sesiones de
// agentes: cada motor traduce sus mensajes a `CItem` y a `Ask`, y aquí se
// pintan igual.

// Atajos de la vista visible: la conversación oculta (hidden) no responde.
const shown = (el: HTMLElement | null) => !!el && el.offsetParent !== null;
const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

export const EFFORT_LABEL: Record<string, string> = { auto: 'automático', low: 'bajo', medium: 'medio', high: 'alto', xhigh: 'muy alto', max: 'máximo' };
const CONTEXT_MARKER = '\n\n[Filigranas IDE: historial del proveedor anterior]\n';

export function useChatHistory(project: string, session: number | null | undefined) {
  const [items, setItems] = useState<CItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (session === undefined) return;
    let active = true;
    chats.history(project, session).then(
      (items) => { if (active) setItems(items); },
      (error) => { if (active) setError(String(error)); },
    );
    return () => { active = false; };
  }, [project, session]);
  return { items, error };
}

export const KIND_LETTER: Record<string, string> = { add: 'A', delete: 'D', update: 'M' };

/** Petición de permiso ya traducida, con la decisión a la que llama. */
export type Ask = {
  key: string;
  title: string;
  agent?: string;
  root?: string;
  command?: string;
  files?: string[];
  detail?: string;
  reason?: string;
  decide: (d: Decision) => void;
};

function inlineProse(text: string) {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).map((part, i) => {
    if (i % 2 === 0) return part;
    return part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <code key={i}>{part.slice(1, -1)}</code>;
  });
}

/** Conserva los bloques de código y reconoce las cadenas de arquitectura. */
function Prose({ text, onOpenFlow }: { text: string; onOpenFlow?: () => void }) {
  return text.split(/^```/m).map((part, i) => {
    if (i % 2 === 0) return part.trim() && <p key={i} className="co-text">{inlineProse(part.trim())}</p>;
    const firstLine = part.indexOf('\n');
    const body = (firstLine < 0 ? part : part.slice(firstLine + 1)).trimEnd();
    const architecture = firstLine >= 0 && part.slice(0, firstLine).trim() === 'mermaid' ? readArchitecture(body) : null;
    return architecture ? <ConversationArchitecture key={i} data={architecture} onOpen={onOpenFlow} /> : <pre key={i} className="co-code">{body}</pre>;
  });
}

type LogProps = {
  items: CItem[];
  asks: Ask[];
  /** Quién firma las respuestas del agente. */
  agent: string;
  project: string;
  onDiff: (c: Change) => void;
  workflow?: ConversationWorkflow;
  /** Avisos al final: cargando, vacío, errores. */
  children?: ReactNode;
};

/** Lista de mensajes que sigue el final salvo que el usuario haya subido. */
export function ConversationLog({ items, asks, agent, project, onDiff, workflow, children }: LogProps) {
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const snapshot = useConversationTasks(workflow ? project : null);
  const delegated = useDelegatedPermissions(project, !!workflow);
  const queue = [...asks, ...delegated];
  useLayoutEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, asks, snapshot, delegated.length]);

  const plan = workflow && snapshot && <ConversationPlan {...snapshot} onOpen={workflow.onOpenFlow} />;
  const afterArchitecture = workflow && snapshot && <ConversationTeam items={snapshot.items} {...workflow} />;
  const onOpenFlow = workflow?.onOpenFlow;

  let lastPlan: string | undefined, lastArchitecture: string | undefined;
  if (snapshot) for (let i = items.length - 1; i >= 0 && (!lastPlan || !lastArchitecture); i--) {
    const item = items[i];
    if (item.type === 'plan' && item.text) lastPlan ??= item.id;
    if (item.type === 'agentMessage' && item.text?.includes('```mermaid')) lastArchitecture ??= item.id;
  }
  const rel = (p: string) => (p.startsWith(project + '/') ? p.slice(project.length + 1) : p);

  // El atajo se corresponde con la acción marcada en cada tarjeta.
  useEffect(() => {
    if (!queue.length) return;
    const on = (e: KeyboardEvent) => {
      const a = queue[0];
      if (e.defaultPrevented || !a || !mod(e) || e.shiftKey || !shown(log.current)) return;
      if (e.code === 'KeyY') {
        e.preventDefault();
        a.decide(a.agent ? 'acceptForSession' : 'accept');
      } else if (e.code === 'KeyN') {
        e.preventDefault();
        a.decide('decline');
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [queue]);

  return (
    <div
      className="co-log"
      ref={log}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div className="co-log-inner">
        {items.map((it, index) => (
          <Fragment key={it.id}>
            <ItemView it={it} agent={agent} rel={rel} onDiff={onDiff} onOpenFlow={onOpenFlow}
              plan={it.id === lastPlan ? plan : undefined} attached={it.type === 'fileChange' && items[index - 1]?.type === 'agentMessage'} />
            {(it.id === lastArchitecture || (!lastArchitecture && it.id === lastPlan)) && afterArchitecture}
          </Fragment>
        ))}
        {queue.map((ask) => (
          <div className="co-approval" key={ask.key} role="group" aria-label="Petición de permiso">
            <div className="co-approval-title"><span className="tv co-approval-signal"><StDot st="waiting" s={14} /></span>{ask.agent && <b>{ask.agent}</b>}<span>{ask.title}</span></div>
            {ask.command && <pre className="co-code co-approval-command">{ask.command}</pre>}
            {ask.files?.map((file) => (
              <div key={file} className="co-file">{ask.root && file.startsWith(ask.root + '/') ? file.slice(ask.root.length + 1) : rel(file)}</div>
            ))}
            {ask.detail && <pre className="co-code">{ask.detail}</pre>}
            {ask.reason && <p className="co-text muted">{ask.reason}</p>}
            <div className="co-actions">
              <button className="co-btn co-allow" onClick={() => ask.decide('acceptForSession')}>Permitir en esta sesión{ask.agent && <kbd aria-hidden="true">⌘Y</kbd>}</button>
              <button className="co-btn co-secondary" onClick={() => ask.decide('accept')}>Solo esta vez{!ask.agent && <kbd aria-hidden="true">⌘Y</kbd>}</button>
              <button className="co-btn co-secondary" aria-label="Ahora no" onClick={() => ask.decide('decline')}>Ahora no<kbd aria-hidden="true">⌘N</kbd></button>
            </div>
          </div>
        ))}
        {children}
      </div>
    </div>
  );
}

export function ConversationObservation({ target, items, agent, project, onDiff }: {
  target: HTMLElement; items: CItem[]; agent: string; project: string; onDiff: (change: Change) => void;
}) {
  return createPortal(
    <ConversationLog items={items} asks={[]} agent={agent} project={project} onDiff={onDiff}>
      {!items.length && <p className="co-text muted">Sin mensajes en esta sesión.</p>}
    </ConversationLog>,
    target,
  );
}

function ItemView({ it, agent, rel, onDiff, onOpenFlow, plan, attached }: {
  it: CItem; agent: string; rel: (p: string) => string; onDiff: (c: Change) => void;
  onOpenFlow?: () => void; plan?: ReactNode; attached?: boolean;
}) {
  switch (it.type) {
    case 'userMessage':
      return (
        <div className="co-msg is-user">
          <div className="co-by">tú</div>
          <Prose text={(it.content ?? []).map((c) => c.text ?? '').join('\n').split('\n\n[Filigranas IDE: skills administradas del turno]\n', 1)[0].split(CONTEXT_MARKER, 1)[0]} />
        </div>
      );
    case 'agentMessage':
      return (
        <div className="co-msg is-agent">
          <div className="co-by">{it.by ?? agent}</div>
          <Prose text={it.text ?? ''} onOpenFlow={onOpenFlow} />
        </div>
      );
    case 'reasoning':
      return it.summary?.some((s) => s.trim()) ? (
        <details className="co-aside">
          <summary>razonamiento</summary>
          <Prose text={it.summary.join('\n\n')} />
        </details>
      ) : null;
    case 'plan':
      if (it.text && plan) return <div className="co-msg is-agent">
        <div className="co-by">{it.by ?? agent}</div>
        <Prose text={it.text} />
        {plan}
      </div>;
      return it.text ? (
        <div className="co-aside">
          <div className="co-by">plan</div>
          <Prose text={it.text} />
        </div>
      ) : null;
    case 'commandExecution':
      return (
        <details className="co-cmd">
          <summary>
            <span className={`co-status is-${it.status}`}>
              {it.status === 'inProgress' ? '…' : it.status === 'declined' ? '×' : it.status === 'failed' || (it.exitCode ?? 0) !== 0 ? '!' : '✓'}
            </span>
            <span className="co-cmd-line">$ {it.command}</span>
          </summary>
          {it.aggregatedOutput && <pre className="co-code">{it.aggregatedOutput}</pre>}
        </details>
      );
    case 'fileChange':
      return (
        <div className={`co-files${attached ? ' is-attached' : ''}`}>
          {(it.changes ?? []).map((change) => <ConversationChange key={change.path} change={change} path={rel(change.path)} status={it.status} onDiff={onDiff} />)}
        </div>
      );
    case 'dynamicToolCall': {
      const args = it.arguments ?? {};
      const what =
        it.tool === 'delegar' ? `delegar en ${args.agente}: ${String(args.tarea ?? '').split('\n')[0]}` : it.tool === 'esperar_sesion' ? `esperar a ${args.sesion}` : (it.tool ?? '');
      const output = (it.contentItems ?? []).map((c) => c.text ?? '').join('\n');
      const status = it.success === false ? 'failed' : it.status;
      return (
        <details className="co-cmd">
          <summary>
            <span className={`co-status is-${status}`}>{status === 'inProgress' ? '…' : status === 'failed' ? '!' : '✓'}</span>
            <span className="co-cmd-line">{what}</span>
          </summary>
          {output && <Prose text={output} />}
        </details>
      );
    }
    case 'notice':
      return <div className="co-marker">{it.text}</div>;
    case 'mcpToolCall':
      return (
        <div className="co-aside co-tool">
          <span className={`co-status is-${it.status}`}>·</span> {it.server ? `${it.server}.${it.tool}` : it.tool}
        </div>
      );
    default:
      return null;
  }
}

type ComposerProps = {
  disabled: boolean;
  running: boolean;
  efforts: string[];
  effort: string;
  onEffort: (e: string) => void;
  providerPicker?: ReactNode;
  /** Modelo de la sesión (texto o selector), junto al esfuerzo. */
  model?: ReactNode;
  onSend: (text: string, attachments: ChatAttachment[]) => Promise<unknown>;
  onInterrupt: () => void;
  placeholder: string;
  draftKey: string;
};

const drafts = new Map<string, string>();
type DraftAttachment = { kind: 'file'; file: File } | { kind: 'link'; url: string };
const draftAttachments = new Map<string, DraftAttachment[]>();
const FILE_LIMIT = 10 * 1024 * 1024;
const BATCH_LIMIT = 20 * 1024 * 1024;
const IMAGE_LIMIT = 5_000_000;

export function withAttachmentNames(text: string, attachments: ChatAttachment[]) {
  if (!attachments.length) return text;
  const names = attachments.map((item) => `- ${item.kind === 'file' ? item.name : item.url}`);
  return [text, 'Adjuntos del mensaje:\n' + names.join('\n')].filter(Boolean).join('\n\n');
}

function encodeAttachment(item: DraftAttachment): Promise<ChatAttachment> {
  if (item.kind === 'link') return Promise.resolve(item);
  const file = item.file;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve({ kind: 'file', name: file.name, data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    };
    reader.onerror = reader.onabort = () => reject(new Error(`No se pudo leer «${file.name}».`));
    reader.readAsDataURL(file);
  });
}

/** Caja de mensaje con esfuerzo, ⌘↩ para enviar e Interrumpir en marcha. */
export function Composer({ disabled, running, efforts, effort, onEffort, providerPicker, model, onSend, onInterrupt, placeholder, draftKey }: ComposerProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachRoot = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [attachments, setAttachments] = useState(() => draftAttachments.get(draftKey) ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  useEffect(() => {
    if (!attachMenu) return;
    const outside = (e: Event) => {
      if (!attachRoot.current?.contains(e.target as Node)) setAttachMenu(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [attachMenu]);

  const updateAttachments = (items: DraftAttachment[]) => {
    if (items.length) draftAttachments.set(draftKey, items);
    else draftAttachments.delete(draftKey);
    setAttachments(items);
  };
  const addFiles = (files: File[]) => {
    const next = [...attachments];
    let size = next.reduce((total, item) => total + (item.kind === 'file' ? item.file.size : 0), 0);
    const rejected: string[] = [];
    for (const file of files) {
      if (next.length === 8) {
        rejected.push('Hasta 8 adjuntos por mensaje.');
        break;
      }
      const isImage = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
      const limit = isImage ? IMAGE_LIMIT : FILE_LIMIT;
      if (file.size > limit) {
        rejected.push(`«${file.name}» supera ${isImage ? '5 MB' : '10 MiB'}.`);
        continue;
      }
      if (size + file.size > BATCH_LIMIT) {
        rejected.push(`«${file.name}» superaría los 20 MiB en total.`);
        continue;
      }
      size += file.size;
      next.push({ kind: 'file', file });
    }
    updateAttachments(next);
    setAttachmentError(rejected.join(' ') || null);
  };
  const addLink = () => {
    try {
      const url = new URL(link?.trim() ?? '');
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.href.length > 4096) throw new Error();
      if (attachments.length >= 8) {
        setAttachmentError('Hasta 8 adjuntos por mensaje.');
        return;
      }
      updateAttachments([...attachments, { kind: 'link', url: url.href }]);
      setLink(null);
      setAttachmentError(null);
      area.current?.focus();
    } catch {
      setAttachmentError('Introduce un enlace HTTP o HTTPS válido.');
    }
  };

  const send = () => {
    const el = area.current;
    const text = el?.value.trim();
    if (!el || text === undefined || (!text && !attachments.length) || busy.current || disabled || running) return;
    busy.current = true;
    setSubmitting(true);
    setAttachMenu(false);
    setAttachmentError(null);
    el.value = '';
    drafts.delete(draftKey);
    beep('send');
    Promise.all(attachments.map(encodeAttachment))
      .catch((e: Error) => {
        setAttachmentError(e.message);
        throw e;
      })
      .then((payload) => onSend(text, payload))
      .then(() => updateAttachments([]))
      .catch(() => {
        if (text && !drafts.has(draftKey)) {
          drafts.set(draftKey, text);
          el.value = text;
        }
      })
      .finally(() => {
        busy.current = false;
        setSubmitting(false);
      });
  };

  // ⌘. interrumpe, ⌘⇧E cambia el esfuerzo y ⌘M abre el modelo.
  const root = useRef<HTMLDivElement>(null);
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (!mod(e) || !shown(root.current)) return;
    if (e.code === 'Period' && running) {
      e.preventDefault();
      onInterrupt();
    } else if (e.code === 'KeyE' && e.shiftKey && efforts.length && !disabled) {
      e.preventDefault();
      onEffort(efforts[(efforts.indexOf(effort) + 1) % efforts.length]);
      beep('tick');
    } else if (e.code === 'KeyM' && !e.shiftKey) {
      const pick = root.current?.querySelector<HTMLElement>('.co-model select, .co-model button');
      if (pick) {
        e.preventDefault();
        pick.focus();
        pick.click();
      }
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  return (
    <div className="co-compose" ref={root}>
      <Splitter size={SIZES.compose} axis="y" invert label="Altura del mensaje" className="is-compose" />
      <textarea
        ref={area}
        defaultValue={drafts.get(draftKey) ?? ''}
        onChange={(e) => {
          const value = e.currentTarget.value;
          if (value) drafts.set(draftKey, value);
          else drafts.delete(draftKey);
        }}
        aria-label="Mensaje"
        placeholder={running ? 'trabajando… puedes interrumpir' : placeholder}
        rows={2}
        disabled={disabled}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (!files.length || disabled || busy.current) return;
          e.preventDefault();
          addFiles(files);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      {attachments.length > 0 && (
        <ul className="co-attachments" aria-label="Adjuntos del mensaje">
          {attachments.map((item, index) => {
            const name = item.kind === 'file' ? item.file.name : item.url;
            return (
              <li key={index}>
                <span title={name}>{name}</span>
                <button type="button" className="icon" disabled={submitting}
                  aria-label={`Quitar ${name}`} onClick={() => {
                    updateAttachments(attachments.filter((_, i) => i !== index));
                    setAttachmentError(null);
                  }}>×</button>
              </li>
            );
          })}
        </ul>
      )}
      {link !== null && (
        <form className="co-attach-link" onSubmit={(e) => { e.preventDefault(); addLink(); }}>
          <input aria-label="Dirección del enlace" placeholder="https://…" type="text" inputMode="url"
            value={link} autoFocus disabled={submitting} onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setLink(null); setAttachmentError(null); area.current?.focus(); } }} />
          <button className="co-btn" type="submit" disabled={submitting || !link.trim()}>Añadir</button>
          <button className="icon" type="button" aria-label="Cancelar enlace"
            onClick={() => { setLink(null); setAttachmentError(null); area.current?.focus(); }}>×</button>
        </form>
      )}
      {attachmentError && <p className="co-attachment-error" role="alert">{attachmentError}</p>}
      <div className="co-compose-bar">
        <div className="co-compose-opts">
          <div className="co-attach" ref={attachRoot} onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setAttachMenu(false);
              e.currentTarget.querySelector('button')?.focus();
            }
          }}>
            <input type="file" hidden multiple ref={fileInput} aria-label="Archivos adjuntos"
              onChange={(e) => {
                addFiles(Array.from(e.currentTarget.files ?? []));
                e.currentTarget.value = '';
                area.current?.focus();
              }} />
            <button className="chip co-attach-button" type="button" title="Adjuntar archivos o enlaces" aria-label="Adjuntar"
              aria-expanded={attachMenu} aria-controls={attachMenu ? menuId : undefined}
              disabled={disabled || submitting} onClick={() => setAttachMenu((open) => !open)}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                <path d="m5.6 8.4 4-4a1.45 1.45 0 0 1 2.05 2.05l-5 5a2.55 2.55 0 0 1-3.6-3.6l5.2-5.2a3.35 3.35 0 0 1 4.74 4.74l-5.1 5.1" strokeLinecap="round" />
              </svg>
            </button>
            {attachMenu && <div className="menu co-attach-menu" id={menuId}>
              <button className="menu-item" type="button" onClick={() => { fileInput.current?.click(); setAttachMenu(false); }}>Adjuntar archivos</button>
              <button className="menu-item" type="button" onClick={() => { setAttachMenu(false); setLink(''); }}>Añadir enlace</button>
            </div>}
          </div>
          {providerPicker}
          {model && <span className="co-model">{model}</span>}
          {efforts.length > 0 && (
            <button
              className="chip"
              title={shortcut('esfuerzo · ⌘⇧E')}
              disabled={disabled}
              onClick={() => {
                beep('tick');
                onEffort(efforts[(efforts.indexOf(effort) + 1) % efforts.length]);
              }}
            >
              {EFFORT_LABEL[effort] ?? effort}
            </button>
          )}
        </div>
        {running ? (
          <button className="send" aria-label="Detener" title={shortcut('detener · ⌘.')} onClick={onInterrupt}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button className="send" aria-label="Enviar" title={shortcut('enviar · ⌘↩')} onClick={send} disabled={disabled || submitting}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
