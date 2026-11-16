import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, git, sessions, type Change, type Session, type Workspace } from './ipc';
import Onboarding from './Onboarding';
import Sidebar from './Sidebar';
import Editor from './Editor';
import Diff from './Diff';
import GitPanel from './GitPanel';
import Terminal from './Terminal';
import Coordinator from './Coordinator';
import SessionView from './Session';

// Motores de sesión. Los no disponibles se muestran desactivados con el motivo.
const ENGINES: [string, string, string | null][] = [
  ['claude', 'claude code', null],
  ['opencode', 'opencode', 'llega en el tramo 3c'],
  ['agy', 'antigravity', 'llega en el tramo 3c'],
  ['devin', 'devin', 'llega en el tramo 3c'],
];

type TerminalTab = { id: number; project: string; number: number };

export default function App() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<Change | null>(null);
  // Cada pestaña tiene su propio PTY. Siguen vivos al cambiar de proyecto.
  const [terms, setTerms] = useState<TerminalTab[]>([]);
  const [selectedTerm, setSelectedTerm] = useState<Record<string, number>>({});
  const nextTermId = useRef(1);
  const [termOpen, setTermOpen] = useState(false);
  // Pestaña activa: el coordinador o el archivo/diff abierto.
  // Un número es el id de una sesión de agente.
  const [view, setView] = useState<'coach' | 'file' | number>('coach');
  const [coach, setCoach] = useState('hansi');
  const [agentSessions, setAgentSessions] = useState<Session[]>([]);
  const [engineMenu, setEngineMenu] = useState(false);

  const openTerminal = useCallback((path: string, newTab = false) => {
    const existing = terms.filter((t) => t.project === path);
    if (!newTab && existing.length) {
      setSelectedTerm((current) => ({ ...current, [path]: current[path] ?? existing[0].id }));
    } else {
      const id = nextTermId.current++;
      const number = Math.max(0, ...existing.map((t) => t.number)) + 1;
      setTerms((current) => [...current, { id, project: path, number }]);
      setSelectedTerm((current) => ({ ...current, [path]: id }));
    }
    setTermOpen(true);
  }, [terms]);

  const closeTerminal = (id: number) => {
    const tab = terms.find((t) => t.id === id);
    if (!tab) return;
    const remaining = terms.filter((t) => t.project === tab.project && t.id !== id);
    setTerms((current) => current.filter((t) => t.id !== id));
    if (selectedTerm[tab.project] === id) {
      if (remaining.length) setSelectedTerm((current) => ({ ...current, [tab.project]: remaining[remaining.length - 1].id }));
      else {
        setSelectedTerm((current) => {
          const next = { ...current };
          delete next[tab.project];
          return next;
        });
        setTermOpen(false);
      }
    }
  };

  const refresh = useCallback(() => {
    api.workspace().then(setWs, (e) => setError(String(e)));
  }, []);

  // Recargar cuando el núcleo detecta cambios en la raíz o al volver a la ventana.
  useEffect(() => {
    refresh();
    let timer: number | undefined;
    const unlisten = listen('workspace-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 250);
    });
    window.addEventListener('focus', refresh);
    return () => {
      window.clearTimeout(timer);
      unlisten.then((off) => off());
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  // Si el proyecto abierto desaparece o se archiva, cerrarlo.
  useEffect(() => {
    if (project && ws && !ws.projects.some((p) => p.path === project && !p.archived)) {
      setProject(null);
      setFile(null);
    }
  }, [ws, project]);

  // Sesiones de agentes del proyecto abierto.
  useEffect(() => {
    setAgentSessions([]);
    if (project) sessions.list(project).then(setAgentSessions, (e) => setError(String(e)));
  }, [project]);

  const newSession = (engine: string) => {
    setEngineMenu(false);
    if (!project) return;
    sessions.create(project, engine).then(
      (s) => {
        setAgentSessions((list) => [...list, s]);
        setView(s.id);
      },
      (e) => setError(String(e)),
    );
  };

  const closeSession = (id: number) => {
    sessions.close(id).then(
      () => {
        setAgentSessions((list) => list.filter((s) => s.id !== id));
        setView((v) => (v === id ? 'coach' : v));
      },
      (e) => setError(String(e)),
    );
  };

  // Observar solo el proyecto abierto.
  useEffect(() => {
    setDiff(null);
    git.watch(project).catch((e) => setError(String(e)));
  }, [project]);

  // ⌃` muestra u oculta el terminal del proyecto, como en otros editores.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === 'Backquote' && project) {
        e.preventDefault();
        if (termOpen) setTermOpen(false);
        else openTerminal(project);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, termOpen, openTerminal]);

  const showDiff = (c: Change) => {
    setDiff(c);
    setView('file');
  };

  const update = (p: Promise<Workspace>) => p.then(setWs, (e) => setError(String(e)));

  if (!ws) return <div className="app" />;
  if (!ws.root) return <Onboarding onDone={setWs} />;

  const current = ws.projects.find((p) => p.path === project);
  const active = ws.projects.filter((p) => !p.archived).length;
  const projectTerms = terms.filter((t) => t.project === project);
  const activeTerm = project ? selectedTerm[project] ?? projectTerms[0]?.id : undefined;

  return (
    <div className={`app${current ? ' has-git' : ''}`}>
      <Sidebar
        ws={ws}
        project={project}
        file={file}
        onProject={(p) => {
          setProject(p);
          setFile(null);
          setView('coach');
        }}
        onFile={(f) => {
          setFile(f);
          setDiff(null);
          setView('file');
        }}
        onUpdate={update}
      />
      <div className="tabs" data-tauri-drag-region>
        {current && (
          <button className={`tab${view === 'coach' ? ' is-active' : ''}`} onClick={() => setView('coach')}>
            <span className="dot dot-coach" aria-hidden="true" />
            {coach.replace('-', ' ')}
          </button>
        )}
        {current &&
          agentSessions.map((s) => (
            <div className={`tab${view === s.id ? ' is-active' : ''}`} key={s.id}>
              <button onClick={() => setView(s.id)} title={`sesión de ${s.engine}`}>
                <span className="dot dot-agent" aria-hidden="true" />
                {s.name}
              </button>
              <button className="tab-close" aria-label={`Cerrar la sesión ${s.name}`} title="cerrar sesión" onClick={() => closeSession(s.id)}>
                ×
              </button>
            </div>
          ))}
        {current && (
          <div className="tab-new">
            <button aria-label="Nueva sesión de agente" aria-expanded={engineMenu} title="nueva sesión" onClick={() => setEngineMenu((o) => !o)}>
              +
            </button>
            {engineMenu && (
              <div className="menu engine-menu" role="menu" onMouseLeave={() => setEngineMenu(false)}>
                {ENGINES.map(([id, label, reason]) => (
                  <button key={id} role="menuitem" disabled={!!reason} title={reason ?? undefined} onClick={() => newSession(id)}>
                    {label}
                    {reason && <span className="muted"> · {reason}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {current && (diff || file) && (
          <button className={`tab${view === 'file' ? ' is-active' : ''}`} onClick={() => setView('file')}>
            {(diff?.path ?? file ?? '').split(/[\\/]/).pop()}
            {diff && <span className="muted">diff</span>}
          </button>
        )}
      </div>
      <main className="main">
        <div className="main-view">
          {current && <Coordinator key={current.path} project={current.path} onDiff={showDiff} onProfile={setCoach} hidden={view !== 'coach'} />}
          {current &&
            agentSessions.map((s) => <SessionView key={s.id} session={s} project={current.path} hidden={view !== s.id} onDiff={showDiff} />)}
          {view === 'file' && current && diff ? (
            <Diff project={current.path} change={diff} />
          ) : view === 'file' && file ? (
            <Editor path={file} root={current?.path ?? ''} onError={setError} />
          ) : (
            !current && <div className="empty" />
          )}
        </div>
        <section className="terminal" aria-label="Terminal" hidden={!(current && termOpen)}>
          <div className="terminal-head">
            <span>terminal</span>
            <div className="terminal-tabs" role="tablist" aria-label="Terminales del proyecto">
              {projectTerms.map((tab) => (
                <div className={`terminal-tab${tab.id === activeTerm ? ' is-active' : ''}`} key={tab.id}>
                  <button
                    role="tab"
                    aria-selected={tab.id === activeTerm}
                    onClick={() => setSelectedTerm((s) => ({ ...s, [tab.project]: tab.id }))}
                  >
                    {tab.number}
                  </button>
                  <button className="terminal-close" aria-label={`Cerrar terminal ${tab.number}`} title="cerrar terminal" onClick={() => closeTerminal(tab.id)}>×</button>
                </div>
              ))}
              <button className="terminal-new" aria-label="Nuevo terminal" title="nuevo terminal" onClick={() => current && openTerminal(current.path, true)}>+</button>
            </div>
            <button className="push" onClick={() => setTermOpen(false)} title="ocultar · ⌃`">
              ocultar
            </button>
          </div>
          {terms
            .filter((t) => ws.projects.some((w) => w.path === t.project))
            .map((t) => (
              <Terminal key={t.id} project={t.project} hidden={!termOpen || t.project !== project || t.id !== activeTerm} />
            ))}
        </section>
      </main>
      {current && <GitPanel project={current.path} selected={diff} onDiff={showDiff} />}
      <footer className="status">
        <span>{current ? current.name : ws.root}</span>
        {current && !termOpen && (
          <button
            onClick={() => {
              openTerminal(current.path);
            }}
            title="abrir terminal · ⌃`"
          >
            terminal
          </button>
        )}
        {error && (
          <button className="status-error" onClick={() => setError(null)} title="cerrar">
            {error}
          </button>
        )}
        <span className="push">{active} proyectos</span>
      </footer>
    </div>
  );
}
