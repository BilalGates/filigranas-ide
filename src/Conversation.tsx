import { createPortal } from 'react-dom';
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { chats, type Change, type ChatAttachment, type CItem, type Decision } from './ipc';
import { ConversationArchitecture, ConversationChange } from './trama/ConversationCards';
import ConversationPlan, { ConversationTeam, useConversationTasks, type ConversationWorkflow } from './trama/ConversationPlan';
import { useDelegatedPermissions } from './trama/pendingPermissions';
import { StDot } from './trama/kit';
import { Icon } from './trama/icons';
import { readArchitecture } from './trama/conversationContent';
import { beep, shortcut } from './ui';
import { splitAttachments, takeBatch, type Queued, type ShownAttachment } from './chatAttachments';

// Piezas comunes a las conversaciones del coordinador y de las sesiones de
// agentes: cada motor traduce sus mensajes a `CItem` y a `Ask`, y aquí se
// pintan igual.

// Atajos de la vista visible: la conversación oculta (hidden) no responde.
const shown = (el: HTMLElement | null) => !!el && el.offsetParent !== null;
const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

export const EFFORT_LABEL: Record<string, string> = { auto: 'automático', minimal: 'mínimo', low: 'bajo', medium: 'medio', high: 'alto', xhigh: 'muy alto', max: 'máximo' };
const EFFORT_SHORT: Record<string, string> = { auto: 'Auto', minimal: 'Mín', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máx' };
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Nivel que admite el modelo más cercano a `effort`; «auto» se conserva. */
export function nearestEffort(effort: string, efforts: string[]) {
  if (effort === 'auto' || efforts.includes(effort) || !efforts.length) return effort;
  const rank = (e: string) => EFFORT_ORDER.indexOf(e);
  return efforts.filter((e) => e !== 'auto').reduce((best, e) =>
    Math.abs(rank(e) - rank(effort)) < Math.abs(rank(best) - rank(effort)) ? e : best);
}

const EFFORT_HINT: Record<string, string> = {
  auto: 'El proveedor usa su nivel por defecto',
  minimal: 'Lo justo para responder',
  low: 'Respuestas rápidas para tareas sencillas',
  medium: 'Equilibrio entre rapidez y profundidad',
  high: 'Piensa más antes de cambiar código',
  xhigh: 'Para problemas difíciles; tarda más',
  max: 'El máximo que admite el modelo',
};

export function effortLabel(effort: string) {
  return EFFORT_SHORT[effort] ?? capitalize(EFFORT_LABEL[effort] ?? effort);
}

export function buildEffortOptions(efforts: string[], autoHint?: string) {
  return efforts.map((e) => ({
    value: e,
    label: capitalize(EFFORT_LABEL[e] ?? e),
    shortLabel: EFFORT_SHORT[e] ?? capitalize(EFFORT_LABEL[e] ?? e),
    hint: e === 'auto' ? autoHint ?? EFFORT_HINT.auto : EFFORT_HINT[e],
  }));
}
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

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

function fallbackCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function CopyButton({ text, label = 'Copiar', compact }: { text: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  const onCopy = () => {
    if (!text) return;
    copyToClipboard(text).then(() => {
      setCopied(true);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    }, () => {});
  };
  return (
    <button
      type="button"
      className={`co-copy${compact ? ' is-compact' : ''}${copied ? ' is-done' : ''}`}
      aria-label={copied ? 'Copiado' : label}
      title={copied ? 'Copiado' : label}
      onClick={onCopy}
    >
      {copied ? (
        <Icon name="check" size={12} />
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7" />
        </svg>
      )}
      {!compact && <span>{copied ? 'Copiado' : 'Copiar'}</span>}
    </button>
  );
}

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
    const lang = firstLine >= 0 ? part.slice(0, firstLine).trim() : '';
    const body = (firstLine < 0 ? part : part.slice(firstLine + 1)).trimEnd();
    const architecture = lang === 'mermaid' ? readArchitecture(body) : null;
    if (architecture) return <ConversationArchitecture key={i} data={architecture} onOpen={onOpenFlow} />;
    return (
      <div key={i} className="co-code-wrap">
        <div className="co-code-bar">
          <span className="co-code-lang">{lang || 'bloque'}</span>
          <CopyButton text={body} label="Copiar bloque" />
        </div>
        <pre className="co-code">{body}</pre>
      </div>
    );
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
const ACTION = new Set<string | undefined>(['commandExecution', 'dynamicToolCall', 'mcpToolCall']);

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
        {items.map((it, index) => {
          // Las acciones seguidas se agrupan bajo «N acciones», como en el HTML.
          if (ACTION.has(it.type)) {
            if (ACTION.has(items[index - 1]?.type)) return null;
            let end = index;
            while (ACTION.has(items[end + 1]?.type)) end++;
            const group = items.slice(index, end + 1);
            const running = group.some((item) => item.status === 'inProgress');
            return <details key={it.id} className="co-acts">
              <summary><Icon name="chev" size={12} /> {group.length} {group.length === 1 ? 'acción' : 'acciones'}{running && <span className="co-status is-inProgress"> …</span>}</summary>
              <div className="co-actlist">{group.map((item) => <ItemView key={item.id} it={item} agent={agent} rel={rel} onDiff={onDiff} />)}</div>
            </details>;
          }
          return <Fragment key={it.id}>
            <ItemView it={it} agent={agent} rel={rel} onDiff={onDiff} onOpenFlow={onOpenFlow}
              plan={it.id === lastPlan ? plan : undefined} attached={it.type === 'fileChange' && items[index - 1]?.type === 'agentMessage'} />
            {(it.id === lastArchitecture || (!lastArchitecture && it.id === lastPlan)) && afterArchitecture}
          </Fragment>;
        })}
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
    case 'userMessage': {
      const raw = (it.content ?? []).map((c) => c.text ?? '').join('\n').split('\n\n[Filigranas IDE: skills administradas del turno]\n', 1)[0].split(CONTEXT_MARKER, 1)[0];
      const { text, attachments } = splitAttachments(raw);
      return (
        <div className="co-msg is-user">
          <div className="co-by">tú</div>
          <Prose text={text} />
          {attachments.length > 0 && <MessageAttachments items={attachments} />}
          {text.trim() && <div className="co-msg-tools"><CopyButton text={text.trim()} label="Copiar mensaje" compact /></div>}
        </div>
      );
    }
    case 'agentMessage':
      // En el hilo de otro agente, el mensaje del PM es su encargo: franja del HTML.
      if (it.by === 'Project manager' && agent !== 'Project manager') return (
        <div className="co-brief" role="note" aria-label="Encargo del Project manager">
          <Icon name="flow" size={14} />
          <Prose text={it.text ?? ''} />
        </div>
      );
      return (
        <div className="co-msg is-agent">
          <div className="co-by-row">
            <span className="co-by">{it.by ?? agent}</span>
            {it.text?.trim() && <CopyButton text={it.text.trim()} label="Copiar respuesta" compact />}
          </div>
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

// Miniaturas de las imágenes enviadas en esta ejecución, por nombre. La ruta
// local que recibe el proveedor no se sirve al webview: tras reabrir, chip.
const previewUrls = new WeakMap<File, string>();
const sentPreviews = new Map<string, string>();
function previewOf(file: File) {
  let url = previewUrls.get(file);
  if (!url && /^image\/(png|jpeg|webp|gif)$/.test(file.type) && typeof URL.createObjectURL === 'function') {
    url = URL.createObjectURL(file);
    previewUrls.set(file, url);
  }
  return url;
}

const FileGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M4 1.5h5L12.5 5v9.5h-8.5z M9 1.5V5h3.5" strokeLinejoin="round" />
  </svg>
);

function MessageAttachments({ items }: { items: ShownAttachment[] }) {
  const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null);
  useEffect(() => {
    if (!zoom) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [zoom]);
  return (
    <div className="co-msg-attachments" aria-label="Adjuntos">
      {items.map((item, index) => {
        const url = item.kind === 'image' ? sentPreviews.get(item.name) : undefined;
        if (url) return (
          <button key={index} type="button" className="co-msg-thumb" title={item.name}
            aria-label={`Ampliar ${item.name}`} onClick={() => setZoom({ url, name: item.name })}>
            <img src={url} alt={item.name} />
          </button>
        );
        if (item.kind === 'link') return (
          <a key={index} className="co-msg-chip" href={item.name} target="_blank" rel="noreferrer" title={item.name}>
            <span>{item.name.replace(/^https?:\/\//, '')}</span>
          </a>
        );
        return (
          <span key={index} className="co-msg-chip" title={item.path ?? item.name}>
            <FileGlyph /><span>{item.name}</span>
          </span>
        );
      })}
      {zoom && createPortal(
        <div className="co-lightbox" role="dialog" aria-label={zoom.name} onClick={() => setZoom(null)}>
          <img src={zoom.url} alt={zoom.name} />
        </div>,
        document.body,
      )}
    </div>
  );
}

type ComposerProps = {
  disabled: boolean;
  running: boolean;
  /** Esfuerzos disponibles para el atajo ⌘⇧E. */
  efforts?: string[];
  effort?: string;
  onEffort?: (e: string) => void;
  /** Selector unificado de proveedor, modelo y razonamiento. */
  model?: ReactNode;
  /** Chips de contexto en la fila superior junto a «+» y los adjuntos (p. ej. tarea vinculada). */
  topExtra?: ReactNode;
  /** Entradas adicionales del menú «+» (p. ej. capacidades de la tarea). */
  attachExtra?: (close: () => void) => ReactNode;
  /** Indicadores auxiliares en la barra inferior (estado de conexión…). */
  extra?: ReactNode;
  /** Fila sobre la caja: dónde trabaja la sesión (carpeta, rama, motor). */
  context?: ReactNode;
  /** Chip de modo de trabajo (permisos), junto al selector del modelo. */
  permission?: ReactNode;
  onSend: (text: string, attachments: ChatAttachment[]) => Promise<unknown>;
  onInterrupt: () => void;
  placeholder: string;
  draftKey: string;
};

const drafts = new Map<string, string>();
type DraftAttachment = { kind: 'file'; file: File } | { kind: 'link'; url: string };
const draftAttachments = new Map<string, DraftAttachment[]>();
const queues = new Map<string, Queued<DraftAttachment>[]>();
let queueSeq = 0;
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

/** Caja de mensaje con selector unificado, modo de trabajo, ↩ para enviar y ⌘. para interrumpir. */
export function Composer({ disabled, running, efforts = [], effort = '', onEffort, model, topExtra, attachExtra, extra, context, permission, onSend, onInterrupt, placeholder, draftKey }: ComposerProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const fitArea = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = '0px';
    const next = Math.min(el.scrollHeight, 220);
    el.style.height = `${Math.max(next, 28)}px`;
    el.style.overflowY = el.scrollHeight > 220 ? 'auto' : 'hidden';
  };
  useLayoutEffect(() => {
    fitArea();
    const el = area.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitArea();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draftKey]);
  const busy = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachRoot = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [attachments, setAttachments] = useState(() => draftAttachments.get(draftKey) ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [queue, setQueueState] = useState<Queued<DraftAttachment>[]>(() => queues.get(draftKey) ?? []);
  const [queuePaused, setQueuePaused] = useState(false);
  const queueRef = useRef(queue);
  const setQueue = (items: Queued<DraftAttachment>[]) => {
    queueRef.current = items;
    if (items.length) queues.set(draftKey, items);
    else queues.delete(draftKey);
    setQueueState(items);
  };

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

  const dispatch = (text: string, items: DraftAttachment[]) => {
    for (const item of items) {
      const url = item.kind === 'file' ? previewOf(item.file) : undefined;
      if (url && item.kind === 'file') sentPreviews.set(item.file.name, url);
    }
    return Promise.all(items.map(encodeAttachment))
      .catch((e: Error) => {
        setAttachmentError(e.message);
        throw e;
      })
      .then((payload) => onSend(text, payload));
  };

  const send = () => {
    const el = area.current;
    const text = el?.value.trim();
    if (!el || text === undefined || (!text && !attachments.length) || disabled) return;
    // En marcha (o con cola pendiente), el mensaje espera y sale al terminar el turno.
    if (running || queueRef.current.length || busy.current) {
      if (!running && !queueRef.current.length) return;
      setAttachMenu(false);
      setAttachmentError(null);
      el.value = '';
      fitArea();
      drafts.delete(draftKey);
      setQueue([...queueRef.current, { id: ++queueSeq, text, attachments }]);
      updateAttachments([]);
      beep('tick');
      return;
    }
    busy.current = true;
    setSubmitting(true);
    setAttachMenu(false);
    setAttachmentError(null);
    el.value = '';
    fitArea();
    drafts.delete(draftKey);
    beep('send');
    dispatch(text, attachments)
      .then(() => updateAttachments([]))
      .catch(() => {
        if (text && !drafts.has(draftKey)) {
          drafts.set(draftKey, text);
          el.value = text;
          fitArea();
        }
      })
      .finally(() => {
        busy.current = false;
        setSubmitting(false);
      });
  };

  // Al terminar el turno sale lo encolado. Tras un envío desde la cola se
  // espera a ver el turno nuevo en marcha antes de mandar el resto.
  const awaitingTurn = useRef(false);
  if (running) awaitingTurn.current = false;
  useEffect(() => {
    if (running || disabled || queuePaused || busy.current || awaitingTurn.current || !queue.length) return;
    const { batch, rest, text, attachments: items } = takeBatch(queue, (a) => (a.kind === 'file' ? a.file.size : 0));
    busy.current = true;
    awaitingTurn.current = true;
    setSubmitting(true);
    setQueue(rest);
    beep('send');
    dispatch(text, items)
      .catch(() => {
        // No se pierde: vuelve al principio de la cola hasta reintentar.
        awaitingTurn.current = false;
        setQueue([...batch, ...queueRef.current]);
        setQueuePaused(true);
      })
      .finally(() => {
        busy.current = false;
        setSubmitting(false);
      });
  }, [running, disabled, queue, queuePaused]);

  // ⌘. interrumpe, ⌘⇧E cambia el esfuerzo y ⌘M abre el modelo.
  const root = useRef<HTMLDivElement>(null);
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (!mod(e) || !shown(root.current)) return;
    if (e.code === 'Period' && running) {
      e.preventDefault();
      onInterrupt();
    } else if (e.code === 'KeyE' && e.shiftKey && efforts.length && onEffort && !disabled) {
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
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      const el = area.current;
      if (!text || !el || !shown(root.current)) return;
      const next = el.value.trim() ? `${el.value.trimEnd()}\n\n${text}` : text;
      el.value = next;
      drafts.set(draftKey, next);
      fitArea();
      el.focus();
    };
    window.addEventListener('keydown', on);
    window.addEventListener('filigranas:insert-chat', onInsert);
    return () => {
      window.removeEventListener('keydown', on);
      window.removeEventListener('filigranas:insert-chat', onInsert);
    };
  }, [draftKey]);

  return (
    <>
    {context}
    <div className="co-compose" ref={root}>
      {queue.length > 0 && (
        <ul className="co-queue" aria-label="Mensajes en cola">
          {queue.map((item) => (
            <li key={item.id}>
              <span className="co-queue-tag">en cola</span>
              <span className="co-queue-text" title={item.text}>{item.text || item.attachments.map((a) => (a.kind === 'file' ? a.file.name : a.url)).join(', ')}</span>
              {item.text && item.attachments.length > 0 && <span className="co-queue-count">+{item.attachments.length}</span>}
              <button type="button" className="icon" aria-label="Quitar de la cola" title="quitar de la cola"
                onClick={() => setQueue(queueRef.current.filter((q) => q.id !== item.id))}>×</button>
            </li>
          ))}
          {queuePaused && (
            <li className="is-paused">
              <span className="co-queue-text">No se pudo enviar.</span>
              <button type="button" className="co-btn" onClick={() => { setAttachmentError(null); setQueuePaused(false); }}>reintentar</button>
            </li>
          )}
        </ul>
      )}
      <div className="co-compose-top">
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
          <button className={`co-attach-plus${attachMenu ? ' is-open' : ''}`} type="button" title="Adjuntar imágenes, archivos o enlaces" aria-label="Adjuntar"
            aria-expanded={attachMenu} aria-controls={attachMenu ? menuId : undefined}
            disabled={disabled || submitting} onClick={() => setAttachMenu((open) => !open)}>
            <Icon name="plus" size={13} />
          </button>
          {attachMenu && <div className="menu co-attach-menu" id={menuId}>
            <button className="menu-item" type="button" onClick={() => { fileInput.current?.click(); setAttachMenu(false); }}>Adjuntar imágenes o archivos</button>
            <button className="menu-item" type="button" onClick={() => { setAttachMenu(false); setLink(''); }}>Añadir enlace</button>
            {attachExtra?.(() => setAttachMenu(false))}
          </div>}
        </div>
        {attachments.length > 0 && (
          <ul className="co-attachments" aria-label="Adjuntos del mensaje">
            {attachments.map((item, index) => {
              const name = item.kind === 'file' ? item.file.name : item.url;
              const thumb = item.kind === 'file' ? previewOf(item.file) : undefined;
              return (
                <li key={index} className={thumb ? 'has-thumb' : undefined}>
                  {thumb ? <img src={thumb} alt="" /> : item.kind === 'file' ? <FileGlyph /> : <Icon name="link" size={12} />}
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
        {topExtra}
      </div>
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
      <textarea
        ref={area}
        defaultValue={drafts.get(draftKey) ?? ''}
        onChange={(e) => {
          const value = e.currentTarget.value;
          if (value) drafts.set(draftKey, value);
          else drafts.delete(draftKey);
          fitArea();
        }}
        aria-label="Mensaje"
        placeholder={running ? 'trabajando… lo que envíes quedará en cola' : placeholder}
        rows={1}
        disabled={disabled}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (!files.length || disabled || busy.current) return;
          e.preventDefault();
          addFiles(files);
        }}
        onKeyDown={(e) => {
          // ↩ envía; ⇧↩ hace salto de línea. Mientras un IME compone, ↩ confirma el texto.
          if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="co-compose-bar">
        <div className="co-compose-opts">
          {model && <span className="co-model">{model}</span>}
          {permission}
          {extra}
        </div>
        {running && (
          <button className="send is-queue" aria-label="Poner en cola" title={shortcut('poner en cola · ↩')} onClick={send} disabled={disabled}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" />
            </svg>
          </button>
        )}
        {running ? (
          <button className="send" aria-label="Detener" title={shortcut('detener · ⌘.')} onClick={onInterrupt}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button className="send" aria-label="Enviar" title={shortcut('enviar · ↩ · salto de línea · ⇧↩')} onClick={send} disabled={disabled || submitting}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
    </>
  );
}
