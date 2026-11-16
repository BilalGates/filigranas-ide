import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, type Workspace } from './ipc';
import Onboarding from './Onboarding';
import Sidebar from './Sidebar';
import Editor from './Editor';

export default function App() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);

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

  const update = (p: Promise<Workspace>) => p.then(setWs, (e) => setError(String(e)));

  if (!ws) return <div className="app" />;
  if (!ws.root) return <Onboarding onDone={setWs} />;

  const current = ws.projects.find((p) => p.path === project);
  const active = ws.projects.filter((p) => !p.archived).length;

  return (
    <div className="app">
      <Sidebar
        ws={ws}
        project={project}
        file={file}
        onProject={(p) => {
          setProject(p);
          setFile(null);
        }}
        onFile={setFile}
        onUpdate={update}
      />
      <div className="tabs" data-tauri-drag-region>
        {current && (
          <span className="tab is-active">
            <span className="dot dot-coach" aria-hidden="true" />
            hansi
          </span>
        )}
      </div>
      <main className="main">{file ? <Editor path={file} root={current?.path ?? ''} onError={setError} /> : <div className="empty" />}</main>
      <footer className="status">
        <span>{current ? current.name : ws.root}</span>
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
