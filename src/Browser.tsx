import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { browser, type BrowserBounds } from './ipc';

type Props = { visible: boolean; covered: boolean; target: { url: string } | null };
type Action = 'back' | 'forward' | 'reload';

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

export default function Browser({ visible, covered, target }: Props) {
  const native = isTauri();
  const surface = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const nav = useRef({ entries: [] as string[], index: -1 });
  const consumedTarget = useRef<Props['target']>(null);
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const active = visible && !covered;

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
        });
      } else {
        const entries = [...nav.current.entries.slice(0, nav.current.index + 1), next];
        nav.current = { entries, index: entries.length - 1 };
        setUrl(next);
        setRevision((r) => r + 1);
      }
    } catch {
      setError('Introduce una dirección HTTP o HTTPS válida.');
    }
  }, [native, send]);

  useEffect(() => {
    if (active && target && target !== consumedTarget.current) {
      consumedTarget.current = target;
      open(target.url);
    }
  }, [active, target, open]);

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
        if (mounted && next && next !== 'about:blank') setUrl(next);
      }, () => {});
    }, 700);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [active, native]);

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
      {error && <p className="co-error" role="alert">{error}</p>}
      <div className="browser-surface" ref={surface}>
        {!url && <p className="muted">Introduce una dirección para abrir una página.</p>}
        {!native && url && <iframe key={revision} title="Página web" src={url} sandbox="allow-forms allow-scripts" />}
      </div>
    </section>
  );
}
