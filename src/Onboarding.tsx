import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import GithubConnect from './GithubConnect';
import { api, type Tool, type Workspace } from './ipc';

/** Primer arranque: elegir la carpeta raíz de proyectos. */
export default function Onboarding({ onDone, onJoin, github, onToolsRefresh }: {
  onDone: (ws: Workspace) => void;
  onJoin: () => void;
  github?: Tool;
  onToolsRefresh: () => void;
}) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.defaultRoot().then(setPath, () => {});
  }, []);

  const pick = async () => {
    const chosen = await open({ directory: true, defaultPath: path || undefined });
    if (typeof chosen === 'string') setPath(chosen);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    api.setRoot(path).then(onDone, (err) => setError(String(err)));
  };

  return (
    <div className="onboarding" data-tauri-drag-region>
      <form className="onboarding-card" onSubmit={submit}>
        <label htmlFor="root" className="muted">
          carpeta de proyectos
        </label>
        <div className="field">
          <span className="prompt" aria-hidden="true">
            ›
          </span>
          <input id="root" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} autoFocus />
          <button type="button" className="ghost" onClick={pick}>
            elegir
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={!path.trim()}>
          continuar
        </button>
        <button className="ghost" type="button" onClick={onJoin}>Unirse a un proyecto</button>
        <GithubConnect tool={github} onRefresh={onToolsRefresh} />
      </form>
    </div>
  );
}
