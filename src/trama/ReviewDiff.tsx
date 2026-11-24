import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { git, sessions, type DiffTarget, type HealthFinding } from '../ipc';
import type { unifiedDiff } from '../unifiedDiff';

type ComputedDiff = ReturnType<typeof unifiedDiff>;
type ReviewRow = ComputedDiff['rows'][number] & { notes: HealthFinding[]; top: number };
const LINE = 22;
const NOTE = 36;
const GUTTER = 10;
const OVERSCAN = 440;
const NO_FINDINGS: HealthFinding[] = [];
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
    if (row.top + LINE + (row.notes.length ? NOTE : 0) <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

export default function ReviewDiff({ project, change, findings = NO_FINDINGS, finding }: {
  project: string; change: DiffTarget; findings?: HealthFinding[]; finding?: { fingerprint: string };
}) {
  const { path, orig, session } = change;
  const scope = JSON.stringify([project, session, path, orig]);
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
        const texts = await (session == null ? git.diffTexts(project, path, orig) : sessions.diffTexts(session, path, orig));
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
    const projectEvents = listen('project-changed', reload);
    const sessionEvents = session == null ? null : listen<{ id: number; msg: { type?: string } }>('session', ({ payload }) => {
      if (payload.id === session && ['result', 'turn_end'].includes(payload.msg?.type ?? '')) reload();
    });
    return () => {
      active = false;
      window.clearTimeout(timer);
      worker?.terminate();
      void projectEvents.then((off) => off());
      void sessionEvents?.then((off) => off());
    };
  }, [scope, project, path, orig, session]);

  const { rows, height, positions } = useMemo(() => {
    const byLine = new Map<number, HealthFinding[]>();
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
      for (const note of notes) positions.set(note.fingerprint, top);
      height += LINE + (notes.length ? NOTE : 0);
      return { ...row, top, notes };
    });
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
    if (element && top != null) element.scrollTop = Math.max(0, top - element.clientHeight / 2 + LINE);
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
        {row.notes.length > 0 && <div className={`diff-finding${row.notes.some((note) => note.severity === 'error') ? ' diff-finding-error' : ''}`} role="note">
          <div>{row.notes.map((note) => <span key={note.fingerprint}>L{note.line} · {note.rule}</span>)}</div>
        </div>}
      </div>)}
    </div>}
  </div>;
}
