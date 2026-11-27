import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { git, sessions, type DiffMode, type DiffTarget } from '../ipc';
import type { unifiedDiff } from '../unifiedDiff';

export type DiffSpec = {
  mode: DiffMode;
  baseRef?: string | null;
  headRef?: string | null;
  commit?: string | null;
  session?: number | null;
  revisionKey?: string;
};

type ComputedDiff = ReturnType<typeof unifiedDiff>;
import type { ReviewNote } from './findings';
export type { ReviewNote };
type ReviewRow = ComputedDiff['rows'][number] & { notes: ReviewNote[]; top: number };
const LINE = 22;
// Tarjeta del HTML: 7 pt de relleno, título de 15 pt y revisores de 24 pt,
// con 2 pt arriba y 6 pt abajo. Sin revisores ocupa solo el título.
const noteHeight = (note: ReviewNote) => (note.who?.length ? 53 : 29) + 8;
const notesHeight = (notes: ReviewNote[]) => notes.reduce((total, note) => total + noteHeight(note), 0);
const GUTTER = 10;
const OVERSCAN = 440;
const NO_FINDINGS: ReviewNote[] = [];
const TOKENS = /(\/\/.*|#(?=\s).*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(pub|fn|let|if|else|match|use|crate|export|const|function|return|Ok|Err|async|await|struct|enum)\b|\b([a-z_]\w*)(?=\s*\()|\b(\d+(?:\.\d+)?)\b/gi;

function code(text: string): ReactNode {
  if (text.length > 4096) return text;
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(TOKENS)) {
    const start = match.index;
    const token = match[0];
    if (start > offset) parts.push(text.slice(offset, start));
    const kind = match[1] ? (token.startsWith('//') || token.startsWith('#') ? 'comment' : 'string') : match[2] ? 'keyword' : match[3] ? 'function' : 'number';
    parts.push(<span key={start} className={`review-token-${kind}`}>{token}</span>);
    offset = start + token.length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

function firstRow(rows: ReviewRow[], offset: number) {
  let low = 0, high = rows.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const row = rows[mid];
    if (row.top + LINE + notesHeight(row.notes) <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

export default function ReviewDiff({ project, change, diffSpec, findings = NO_FINDINGS, finding }: {
  project: string; change: DiffTarget; diffSpec?: DiffSpec; findings?: ReviewNote[]; finding?: { fingerprint: string };
}) {
  const { path, orig, session } = change;
  const specMode = diffSpec?.mode ?? null;
  const specBase = diffSpec?.baseRef ?? null;
  const specHead = diffSpec?.headRef ?? null;
  const specCommit = diffSpec?.commit ?? null;
  const specSession = diffSpec?.session ?? session ?? null;
  const specRev = diffSpec?.revisionKey ?? '';
  const scope = JSON.stringify([project, specSession, path, orig, specMode, specBase, specHead, specCommit, specRev]);
  const [data, setData] = useState<{ scope: string; result?: ComputedDiff; error?: string }>();
  const [viewport, setViewport] = useState({ y: 0, height: 700 });
  const container = useRef<HTMLDivElement>(null);
  const result = data?.scope === scope ? data.result : undefined;
  const error = data?.scope === scope ? data.error : undefined;

  useEffect(() => {
    let revision = 0;
    let active = true;
    let timer: number;
    let worker: Worker | undefined;
    const fail = (error: unknown) => setData({ scope, error: String(error) });
    const load = async () => {
      const id = ++revision;
      try {
        const texts = await (specMode
          ? git.diffRef(project, specMode, path, {
              orig,
              baseRef: specBase,
              headRef: specHead,
              commit: specCommit,
              session: specSession,
            })
          : specSession == null
            ? git.diffTexts(project, path, orig)
            : sessions.diffTexts(specSession, path, orig));
        if (!active || id !== revision) return;
        if (!worker) {
          const { default: DiffWorker } = await import('../unifiedDiff.worker?worker&inline');
          if (!active || id !== revision) return;
          worker = new DiffWorker();
          worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: ComputedDiff; error?: string }>) => {
            if (active && data.id === revision) setData({ scope, result: data.result, error: data.error });
          };
          worker.onerror = (event) => { if (active) fail(event.message || 'No se pudo calcular el diff.'); };
        }
        worker.postMessage({ id, texts });
      } catch (error) {
        if (active && id === revision) fail(error);
      }
    };
    const reload = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 240);
    };
    timer = window.setTimeout(load);
    const liveWorktree = !specMode || specMode === 'worktree' || specMode === 'unstaged' || specMode === 'staged';
    const projectEvents = liveWorktree ? listen('project-changed', reload) : null;
    const sessionEvents = specSession == null ? null : listen<{ id: number; msg: { type?: string } }>('session', ({ payload }) => {
      if (payload.id === specSession && ['result', 'turn_end'].includes(payload.msg?.type ?? '')) reload();
    });
    return () => {
      active = false;
      window.clearTimeout(timer);
      worker?.terminate();
      void projectEvents?.then((off) => off());
      void sessionEvents?.then((off) => off());
    };
  }, [scope, project, path, orig, specSession, specMode, specBase, specHead, specCommit]);

  const { rows, height, positions } = useMemo(() => {
    const byLine = new Map<number, ReviewNote[]>();
    for (const item of findings) {
      if (item.line == null) continue;
      let at = byLine.get(item.line);
      if (!at) byLine.set(item.line, at = []);
      at.push(item);
    }
    const positions = new Map<string, number>();
    let height = 0;
    const rows: ReviewRow[] = (result?.rows ?? []).map((row) => {
      const notes = row.modified == null ? NO_FINDINGS : byLine.get(row.modified) ?? NO_FINDINGS;
      const top = height;
      let offset = top + LINE;
      for (const note of notes) {
        positions.set(note.fingerprint, offset + noteHeight(note) / 2 - 2);
        offset += noteHeight(note);
      }
      height += LINE + notesHeight(notes);
      return { ...row, top, notes };
    });
    if (result?.noFinalNewline) height += LINE;
    return { rows, height, positions };
  }, [result, findings]);

  useEffect(() => {
    const element = container.current!;
    const resize = new ResizeObserver(() => setViewport({ y: element.scrollTop, height: element.clientHeight }));
    resize.observe(element);
    return () => resize.disconnect();
  }, []);

  useEffect(() => {
    const top = finding && positions.get(finding.fingerprint);
    const element = container.current;
    // Centra la tarjeta del hallazgo, como scrollIntoView({block:'center'}) en el HTML.
    if (element && top != null) element.scrollTop = Math.max(0, GUTTER + top - element.clientHeight / 2);
  }, [finding, positions]);

  const first = firstRow(rows, Math.max(0, viewport.y - OVERSCAN));
  const end = firstRow(rows, viewport.y + viewport.height + OVERSCAN) + 1;

  return <div className="review-code" ref={container} tabIndex={0} role="region" aria-label="Diff unificado"
    onScroll={(event) => setViewport({ y: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
    {error && <p className="viewer-msg" role="alert">{error}</p>}
    {!error && !result && <p className="viewer-msg" role="status">Cargando diff…</p>}
    {result?.limited && <p className="viewer-msg" role="status">Comparación aproximada por tamaño del archivo.</p>}
    {result && <div className="review-code-rows" style={{ height, paddingTop: GUTTER, boxSizing: 'content-box' }}>
      <div style={{ height: rows[first]?.top ?? height }} />
      {rows.slice(first, end).map((row) => <div key={row.top}>
        <div className={`review-code-line${row.type ? ' ' + row.type : ''}`}>
          <span className="review-line-number" title={row.original == null ? undefined : `Línea original ${row.original}`}>{row.modified}</span>
          <span className="review-gutter" aria-hidden="true">{row.type === 'added' ? '+' : row.type === 'removed' ? '−' : ''}</span>
          <code>{code(row.text)}</code>
        </div>
        {row.notes.map((note) => <div key={note.fingerprint} className={`diff-finding${note.severity === 'error' ? ' diff-finding-error' : ''}`}
          role="note" aria-label={`Línea ${note.line}: ${note.title ?? note.rule}`} data-rule={note.rule}>
          <span className={`sev ${note.severity === 'error' ? 'h' : note.severity === 'warning' ? 'm' : 'l'}`} aria-hidden="true" />
          <div><b>{note.title ?? note.rule}</b>
            {note.who && note.who.length > 0 && <div className="who2">{note.who.map((name) => <span key={name} className="chip">{name}</span>)}
              {note.who.length > 1 && <span className="chip sky">coinciden</span>}</div>}</div>
        </div>)}
      </div>)}
      {result.noFinalNewline && end >= rows.length && <div className="review-code-eof" role="note">
        {result.noFinalNewline === 'modified' ? 'Sin salto de línea al final' : 'Sin salto de línea al final en la versión anterior'}</div>}
    </div>}
  </div>;
}
