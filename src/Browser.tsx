import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { browser, type BrowserBounds, type BrowserEntry } from './ipc';

type Props = {
  visible: boolean;
  covered: boolean;
  target: { url: string; project?: string | null } | null;
  project?: string | null;
  projectName?: string | null;
};
type Action = 'back' | 'forward' | 'reload';
type Library = 'bookmarks' | 'history';

function webAddress(address: string) {
  const value = address.trim();
  const explicit = /^(?:[a-z][a-z\d+.-]*:\/\/|(?:javascript|data|file|about|tauri):)/i.test(value);
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/?#]|$)/i.test(value);
  const url = new URL(explicit ? value : (local ? 'http://' : 'https://') + value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Introduce una dirección HTTP o HTTPS válida.');
  }
  return url.href;
}

function bounds(el: HTMLElement): BrowserBounds {
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export default function Browser({ visible, covered, target, project = null, projectName = null }: Props) {
  const native = isTauri();
  const surface = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const currentScope = useRef(project);
  currentScope.current = project;
  const consumedTarget = useRef<Props['target']>(null);
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof browser.status>> | null>(null);
  const [bookmarks, setBookmarks] = useState<BrowserEntry[]>([]);
  const [history, setHistory] = useState<BrowserEntry[]>([]);
  const [library, setLibrary] = useState<Library | null>(null);
  const active = visible && !covered;

  const refreshLibrary = useCallback(async () => {
    if (!native) return;
    const [savedBookmarks, visitedPages] = await Promise.all([browser.bookmarks(), browser.history()]);
    setBookmarks(savedBookmarks);
    setHistory(visitedPages);
  }, [native]);

  const send = useCallback((operation: () => Promise<void>) => {
    const scope = currentScope.current;
    queue.current = queue.current.then(operation).catch((e) => {
      if (currentScope.current === scope) setError(String(e));
    });
  }, []);

  const open = useCallback((address: string) => {
    let next: string;
    try { next = webAddress(address); }
    catch { setError('Introduce una dirección HTTP o HTTPS válida.'); return; }
    if (!native) {
      setUrl(next);
      setError('La navegación integrada requiere la aplicación Tauri. El modo web no puede garantizar la carga de páginas externas mediante iframe.');
      return;
    }
    if (!surface.current) return;
    const rect = bounds(surface.current);
    setError(null);
    setDraft(null);
    setUrl(next);
    setStatus(null);
    send(async () => { await browser.open(next, rect, project); });
  }, [native, project, send]);

  useEffect(() => { setUrl(''); }, [project]);

  // Read actual engine state. A project switch selects its existing WebView;
  // only a session recovered after process restart needs a new navigation.
  useEffect(() => {
    setDraft(null); setError(null); setLayoutError(null); setStatus(null);
    if (!native || !active) return;
    let alive = true;
    let polling = false;
    let previousUrl = '';
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await browser.status(project);
        if (!alive) return;
        setStatus(next);
        setUrl(next.url);
        if (next.loaded && next.url !== previousUrl) {
          previousUrl = next.url;
          await refreshLibrary();
        }
        if (!next.exists && next.url && surface.current) {
          const rect = bounds(surface.current);
          send(() => browser.open(next.url, rect, project));
        }
      } catch (e) { if (alive) setError(String(e)); }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [active, native, project, refreshLibrary, send]);

  useEffect(() => {
    if (active && target && target !== consumedTarget.current && (!target.project || target.project === project)) {
      consumedTarget.current = target;
      open(target.url);
    }
  }, [active, target, open, project]);

  useEffect(() => {
    if (active) void refreshLibrary().catch((e) => setError(String(e)));
  }, [active, refreshLibrary]);

  useEffect(() => {
    const el = surface.current;
    if (!native || !el || !active) return;
    let frame = 0;
    let alive = true;
    let pending: BrowserBounds | null | undefined;
    let placing = false;
    let last = '';
    const flush = () => {
      if (placing || pending === undefined) return;
      placing = true;
      send(async () => {
        try {
          while (pending !== undefined) {
            const rect = pending; pending = undefined;
            await browser.place(rect, project);
          }
        } finally { placing = false; }
      });
    };
    const measure = () => {
      frame = 0;
      if (!alive) return;
      const rect = bounds(el);
      if (rect.width < 64 || rect.height < 64) {
        pending = null;
        setLayoutError('Browser no dispone de altura o anchura suficiente. Amplía el panel o vuelve a abrirlo.');
      } else {
        setLayoutError(null);
        const key = JSON.stringify(rect);
        if (last === key) return;
        last = key; pending = rect;
      }
      flush();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    const mutations = new MutationObserver(schedule);
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      mutations.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    schedule();
    return () => {
      alive = false; cancelAnimationFrame(frame);
      observer.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      pending = null; flush();
    };
  }, [active, native, project, send]);

  const saveBookmark = async () => {
    if (!url || !native) return;
    try {
      await browser.bookmark(url, new URL(url).hostname);
      await refreshLibrary();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const removeBookmark = async (address: string) => {
    try {
      await browser.removeBookmark(address);
      await refreshLibrary();
    } catch (e) {
      setError(String(e));
    }
  };

  const clearHistory = async () => {
    try {
      await browser.clearHistory();
      await refreshLibrary();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const act = (action: Action) => {
    setDraft(null); setError(null);
    if (native) send(() => browser.action(action, project));
  };
  const problem = layoutError ?? error ?? status?.error;
  const external = async () => {
    try {
      if (native) await browser.external(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) { setError(String(e)); }
  };

  return (
    <section className="browser-panel" hidden={!visible} aria-label="Navegador integrado">
      <form className="browser-bar" onSubmit={(e) => { e.preventDefault(); if ((draft ?? url).trim()) open(draft ?? url); }}>
        <button type="button" className="icon" disabled={!url || status?.canGoBack === false || !native} aria-label="Atrás" title="Atrás" onClick={() => act('back')}>‹</button>
        <button type="button" className="icon" disabled={!url || status?.canGoForward === false || !native} aria-label="Adelante" title="Adelante" onClick={() => act('forward')}>›</button>
        <button type="button" className="icon" disabled={!url} aria-label="Recargar" title="Recargar" onClick={() => act('reload')}>↻</button>
        <input aria-label="Dirección web" placeholder="Dirección web o localhost:3000" value={draft ?? url}
          spellCheck={false} autoCapitalize="off" onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); }} />
        <button className="co-btn" type="submit">Ir</button>
      </form>
      <div className="browser-tools">
        <button type="button" className={`co-btn${library === 'bookmarks' ? ' is-on' : ''}`}
          onClick={() => setLibrary((current) => current === 'bookmarks' ? null : 'bookmarks')}>Marcadores</button>
        <button type="button" className={`co-btn${library === 'history' ? ' is-on' : ''}`}
          onClick={() => setLibrary((current) => current === 'history' ? null : 'history')}>Historial</button>
        <span className="grow" />
        {status?.loading && <span className="browser-loading" role="status">Cargando…</span>}
        <button type="button" className="co-btn" disabled={!url} onClick={() => void external()}
          aria-label="Abrir en el navegador del sistema" title="Abrir en el navegador del sistema">↗</button>
        {projectName && <span className="muted" style={{ fontSize: 11.5 }} title={project ?? undefined}>{projectName}</span>}
        <button type="button" className="co-btn" disabled={!url || !native} onClick={() => void saveBookmark()}
          aria-label="Guardar marcador" title="Guardar marcador">☆</button>
      </div>
      {library && (
        <div className="browser-library">
          <div className="browser-library-head">
            <strong>{library === 'bookmarks' ? 'Marcadores' : 'Historial'}</strong>
            {library === 'history' && <button type="button" className="co-btn" onClick={() => void clearHistory()}>Borrar historial</button>}
            <button type="button" className="co-btn" onClick={() => setLibrary(null)} aria-label="Cerrar lista">×</button>
          </div>
          <div className="browser-library-list">
            {(library === 'bookmarks' ? bookmarks : history).map((entry) => (
              <div className="browser-entry-row" key={`${library}:${entry.url}`}>
                <button type="button" className="browser-entry" onClick={() => open(entry.url)} title={entry.url}>
                  <strong>{entry.title}</strong><span>{entry.url}</span>
                </button>
                {library === 'bookmarks' && <button type="button" className="co-btn" aria-label={`Quitar marcador ${entry.title}`}
                  onClick={() => void removeBookmark(entry.url)}>×</button>}
              </div>
            ))}
            {(library === 'bookmarks' ? bookmarks : history).length === 0 &&
              <p className="muted">{library === 'bookmarks' ? 'Aún no hay marcadores.' : 'El historial está vacío.'}</p>}
          </div>
        </div>
      )}
      {problem && <div className="browser-problem" role="alert">
        <span>{problem}</span>
        {url && <button type="button" className="co-btn" onClick={() => open(url)}>Reintentar</button>}
      </div>}
      <div className="browser-surface" ref={surface}>
        {!url && <p className="muted">Introduce una dirección para abrir una página.</p>}
        {!native && url && <p className="muted">Abre esta dirección en Filigranas o en el navegador del sistema.</p>}
      </div>
    </section>
  );
}
