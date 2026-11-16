import { useEffect, useRef, useState } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { pty, type PtyEvent } from './ipc';
import { darkQuery } from './monacoLoader';

// Colores tomados de los tokens de styles.css, para que el terminal siga el
// tema claro/oscuro igual que el resto de la interfaz.
function theme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: '#00000000',
    foreground: v('--tx'),
    cursor: v('--ac'),
    selectionBackground: darkQuery.matches ? '#5b8ff045' : '#1f4fb530',
    red: v('--ac'),
    brightRed: v('--del'),
    green: v('--add'),
    brightGreen: v('--add'),
    yellow: v('--gold'),
    brightYellow: v('--gold'),
    blue: v('--blue'),
    brightBlue: v('--blue'),
  };
}

/**
 * Terminal de un proyecto: el shell del usuario en la carpeta del proyecto.
 * Sigue vivo mientras está oculto (al cambiar de proyecto) y termina al
 * desmontarse. Si el shell sale, se puede abrir otro con Intro.
 */
export default function Terminal({ project, hidden }: { project: string; hidden: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const terminal = useRef<XTerm | null>(null);
  const [session, setSession] = useState(0);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    const term = new XTerm({
      allowTransparency: true,
      fontFamily: "Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: theme(),
    });
    const fitter = new FitAddon();
    term.loadAddon(fitter);
    term.open(host.current!);
    terminal.current = term;
    fit.current = fitter;
    if (host.current?.offsetParent) fitter.fit();

    let id: number | null = null;
    let alive = true;
    const channel = new Channel<PtyEvent>();
    channel.onmessage = (e) => {
      if (e.kind === 'data') term.write(e.data);
      else if (alive) {
        term.write('\r\n\x1b[2m[sesión terminada · Intro para abrir otra]\x1b[0m\r\n');
        setExited(true);
      }
    };
    pty.open(project, term.cols, term.rows, channel).then(
      (pid) => {
        if (alive) id = pid;
        else void pty.close(pid);
      },
      (e) => term.write(`\x1b[31m${String(e)}\x1b[0m\r\n`),
    );

    const input = term.onData((data) => id != null && void pty.write(id, data).catch(() => {}));
    const resize = term.onResize(({ cols, rows }) => id != null && void pty.resize(id, cols, rows));
    const observer = new ResizeObserver(() => host.current?.offsetParent && fitter.fit());
    observer.observe(host.current!);
    const onScheme = () => (term.options.theme = theme());
    darkQuery.addEventListener('change', onScheme);
    if (host.current?.offsetParent) term.focus();

    return () => {
      alive = false;
      if (id != null) void pty.close(id);
      observer.disconnect();
      darkQuery.removeEventListener('change', onScheme);
      input.dispose();
      resize.dispose();
      term.dispose();
      fit.current = null;
      terminal.current = null;
    };
  }, [project, session]);

  // Al volver a mostrarse puede haber cambiado el tamaño disponible.
  useEffect(() => {
    if (!hidden) requestAnimationFrame(() => {
      fit.current?.fit();
      terminal.current?.focus();
    });
  }, [hidden]);

  const restart = (e: React.KeyboardEvent) => {
    if (exited && e.key === 'Enter') {
      setExited(false);
      setSession((s) => s + 1);
    }
  };

  return <div ref={host} className="term" hidden={hidden} onKeyDown={restart} />;
}
