import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Change, CItem, Decision } from './ipc';

// Piezas comunes a las conversaciones del coordinador y de las sesiones de
// agentes: cada motor traduce sus mensajes a `CItem` y a `Ask`, y aquí se
// pintan igual.

export const EFFORT_LABEL: Record<string, string> = { low: 'bajo', medium: 'medio', high: 'alto', xhigh: 'muy alto', max: 'máximo' };
export const KIND_LETTER: Record<string, string> = { add: 'A', delete: 'D', update: 'M' };

/** Petición de permiso ya traducida, con la decisión a la que llama. */
export type Ask = {
  key: string;
  title: string;
  command?: string;
  files?: string[];
  detail?: string;
  reason?: string;
  decide: (d: Decision) => void;
};

/** Texto con bloques ``` como código; el resto conserva los saltos de línea. */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(/```[^\n]*\n?/).map((part, i) =>
        i % 2 ? (
          <pre key={i} className="co-code">
            {part.replace(/\n$/, '')}
          </pre>
        ) : (
          part.trim() && (
            <p key={i} className="co-text">
              {part.trim()}
            </p>
          )
        ),
      )}
    </>
  );
}

type LogProps = {
  items: CItem[];
  asks: Ask[];
  /** Quién firma las respuestas del agente. */
  agent: string;
  project: string;
  onDiff: (c: Change) => void;
  /** Avisos al final: cargando, vacío, errores. */
  children?: ReactNode;
};

/** Lista de mensajes que sigue el final salvo que el usuario haya subido. */
export function ConversationLog({ items, asks, agent, project, onDiff, children }: LogProps) {
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, asks]);

  const rel = (p: string) => (p.startsWith(project + '/') ? p.slice(project.length + 1) : p);

  return (
    <div
      className="co-log"
      ref={log}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {items.map((it) => (
        <Fragment key={it.id}>
          <ItemView it={it} agent={agent} rel={rel} onDiff={onDiff} />
        </Fragment>
      ))}
      {asks.map((a) => (
        <div className="co-approval" key={a.key} role="group" aria-label="Petición de permiso">
          <div className="co-approval-title">{a.title}</div>
          {a.command && <pre className="co-code">{a.command}</pre>}
          {a.files?.map((f) => (
            <div key={f} className="co-file">
              {rel(f)}
            </div>
          ))}
          {a.detail && <pre className="co-code">{a.detail}</pre>}
          {a.reason && <p className="co-text muted">{a.reason}</p>}
          <div className="co-actions">
            <button className="co-btn is-primary" onClick={() => a.decide('accept')}>
              aprobar
            </button>
            <button className="co-btn" onClick={() => a.decide('acceptForSession')}>
              aprobar en esta sesión
            </button>
            <button className="co-btn" onClick={() => a.decide('decline')}>
              rechazar
            </button>
          </div>
        </div>
      ))}
      {children}
    </div>
  );
}

function ItemView({ it, agent, rel, onDiff }: { it: CItem; agent: string; rel: (p: string) => string; onDiff: (c: Change) => void }) {
  switch (it.type) {
    case 'userMessage':
      return (
        <div className="co-msg is-user">
          <div className="co-by">tú</div>
          <Prose text={(it.content ?? []).map((c) => c.text ?? '').join('\n')} />
        </div>
      );
    case 'agentMessage':
      return (
        <div className="co-msg">
          <div className="co-by">{agent}</div>
          <Prose text={it.text ?? ''} />
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
        <div className="co-files">
          {(it.changes ?? []).map((c) => (
            <button
              key={c.path}
              className="co-file"
              onClick={() => onDiff({ path: rel(c.path), orig: null, status: KIND_LETTER[c.kind.type] ?? 'M', adds: null, dels: null })}
              title="ver diff"
            >
              <span className={`co-status is-${it.status}`}>{KIND_LETTER[c.kind.type] ?? 'M'}</span> {rel(c.path)}
            </button>
          ))}
        </div>
      );
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
  onSend: (text: string) => Promise<unknown>;
  onInterrupt: () => void;
  placeholder: string;
};

/** Caja de mensaje con esfuerzo, ⌘↩ para enviar e Interrumpir en marcha. */
export function Composer({ disabled, running, efforts, effort, onEffort, onSend, onInterrupt, placeholder }: ComposerProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);

  const send = () => {
    const el = area.current;
    const text = el?.value.trim();
    if (!el || !text || busy.current) return;
    busy.current = true;
    el.value = '';
    onSend(text)
      .catch(() => {
        if (!el.value) el.value = text; // devolver el borrador si falló
      })
      .finally(() => (busy.current = false));
  };

  return (
    <div className="co-compose">
      <textarea
        ref={area}
        aria-label="Mensaje"
        placeholder={running ? 'trabajando… puedes interrumpir' : placeholder}
        rows={3}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="co-compose-bar">
        {efforts.length > 0 ? (
          <label className="muted">
            esfuerzo{' '}
            <select value={effort} onChange={(e) => onEffort(e.target.value)} disabled={disabled}>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {EFFORT_LABEL[e] ?? e}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span />
        )}
        {running ? (
          <button className="co-btn" onClick={onInterrupt}>
            interrumpir
          </button>
        ) : (
          <button className="co-btn is-primary" onClick={send} disabled={disabled}>
            enviar
          </button>
        )}
      </div>
    </div>
  );
}
