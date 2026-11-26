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
type ProjectBrowserState = { url: string; entries: string[]; index: number };

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
  const nav = useRef({ entries: [] as string[], index: -1 });
  const byProject = useRef(new Map<string, ProjectBrowserState>());
  const scopeKey = project ?? '__global__';
  const currentScope = useRef(scopeKey);
  const consumedTarget = useRef<Props['target']>(null);
  const lastLocation = useRef('');
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [bookmarks, setBookmarks] = useState<BrowserEntry[]>([]);
  const [history, setHistory] = useState<BrowserEntry[]>([]);
  const [library, setLibrary] = useState<Library | null>(null);
  const active = visible && !covered;

  const persistCurrentScope = useCallback((nextUrl: string) => {
    byProject.current.set(currentScope.current, {
      url: nextUrl,
      entries: [...nav.current.entries],
      index: nav.current.index,
    });
  }, []);

  const refreshLibrary = useCallback(async () => {
    if (!native) return;
    try {
      const [savedBookmarks, visitedPages] = await Promise.all([browser.bookmarks(), browser.history()]);
      setBookmarks(savedBookmarks);
      setHistory(visitedPages);
    } catch (e) {
      setError(String(e));
    }
  }, [native]);

  const send = useCallback((operation: () => Promise<void>) => {
    queue.current = queue.current.then(operation).catch((e) => setError(String(e)));
  }, []);

  const open = useCallback((address: string) => {
    try {
      const next = webAddress(address);
      setError(null);
      setDraft(null);
      if (native && surface.current) {
        const rect = bounds(surface.current);
        send(async () => {
          await browser.open(next, rect);
          setUrl(next);
          lastLocation.current = next;
          persistCurrentScope(next);
          await refreshLibrary();
        });
      } else {
        const entries = [...nav.current.entries.slice(0, nav.current.index + 1), next];
        nav.current = { entries, index: entries.length - 1 };
        setUrl(next);
        persistCurrentScope(next);
        setRevision((r) => r + 1);
      }
    } catch {
      setError('Introduce una dirección HTTP o HTTPS válida.');
    }
  }, [native, persistCurrentScope, refreshLibrary, send]);

  // Aísla la sesión de navegación por proyecto activo sin perder historial al cambiar.
  useEffect(() => {
    if (currentScope.current === scopeKey) return;
    byProject.current.set(currentScope.current, {
      url: lastLocation.current || url,
      entries: [...nav.current.entries],
      index: nav.current.index,
    });
    currentScope.current = scopeKey;
    const restored = byProject.current.get(scopeKey) ?? { url: '', entries: [], index: -1 };
    nav.current = { entries: [...restored.entries], index: restored.index };
    setDraft(null);
    setError(null);
    setUrl(restored.url);
    setRevision((r) => r + 1);
    if (native) {
      if (active && restored.url && surface.current) {
        const rect = bounds(surface.current);
        send(async () => {
          await browser.open(restored.url, rect);
          lastLocation.current = restored.url;
        });
      } else if (!restored.url) {
        lastLocation.current = '';
        send(() => browser.place(null));
      }
    }
  }, [scopeKey, active, native, send, url]);

  useEffect(() => {
    if (active && native && url && url !== lastLocation.current && surface.current) {
      const rect = bounds(surface.current);
      send(async () => {
        await browser.open(url, rect);
        lastLocation.current = url;
      });
    }
  }, [active, native, url, send]);

  useEffect(() => {
    if (active && target && target !== consumedTarget.current) {
      consumedTarget.current = target;
      open(target.url);
    }
  }, [active, target, open]);

  useEffect(() => {
    if (active) void refreshLibrary();
  }, [active, refreshLibrary]);

  useEffect(() => {
    const el = surface.current;
    if (!native || !el || !active) return;
    const place = () => {
      const rect = bounds(el);
      if (rect.width > 0 && rect.height > 0) send(() => browser.place(rect));
    };
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener('resize', place);
    place();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      send(() => browser.place(null));
    };
  }, [active, native, send]);

  useEffect(() => {
    if (!active || !native) return;
    let mounted = true;
    const timer = window.setInterval(() => {
      void browser.location().then((next) => {
        if (mounted && next && next !== 'about:blank' && next !== lastLocation.current) {
          lastLocation.current = next;
          setUrl(next);
          persistCurrentScope(next);
          void refreshLibrary();
        }
      }, () => {});
    }, 700);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [active, native, refreshLibrary]);

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
    setDraft(null);
    if (native) {
      send(() => browser.action(action));
    } else {
      const { entries, index } = nav.current;
      const next = index + (action === 'back' ? -1 : action === 'forward' ? 1 : 0);
      if (!entries[next]) return;
      nav.current.index = next;
      setUrl(entries[next]);
      setRevision((r) => r + 1);
    }
  };

  return (
    <section className="browser-panel" hidden={!visible} aria-label="Navegador integrado">
      <form className="browser-bar" onSubmit={(e) => { e.preventDefault(); if ((draft ?? url).trim()) open(draft ?? url); }}>
        <button type="button" className="icon" disabled={!url} aria-label="Atrás" title="Atrás" onClick={() => act('back')}>‹</button>
        <button type="button" className="icon" disabled={!url} aria-label="Adelante" title="Adelante" onClick={() => act('forward')}>›</button>
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
      {error && <p className="co-error" role="alert">{error}</p>}
      <div className="browser-surface" ref={surface}>
        {!url && <p className="muted">Introduce una dirección para abrir una página.</p>}
        {!native && url && <iframe key={revision} title="Página web" src={url} sandbox="allow-forms allow-scripts" />}
      </div>
    </section>
  );
}
