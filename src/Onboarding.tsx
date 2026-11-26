import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import GithubConnect from './GithubConnect';
import { api, type Tool, type Workspace } from './ipc';
import AmbientField from './trama/AmbientField';

/** Pantalla de arranque: elegir la carpeta raíz de proyectos o unirse a una sesión compartida. */
export default function Onboarding({ initialRoot, onDone, onJoin, github, onToolsRefresh, recoveryError, onRetry }: {
  initialRoot?: string | null;
  onDone: (ws: Workspace) => void;
  onJoin: () => void;
  github?: Tool;
  onToolsRefresh: () => void;
  recoveryError: string | null;
  onRetry: () => void;
}) {
  const [path, setPath] = useState(initialRoot ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialRoot) {
      setPath((current) => current || initialRoot);
      return;
    }
    let active = true;
    api.defaultRoot().then((root) => {
      if (active) setPath((current) => current || root);
    }, () => {});
    return () => { active = false; };
  }, [initialRoot]);

  const pick = async () => {
    setError(null);
    try {
      const chosen = await open({ directory: true, defaultPath: path || undefined });
      if (typeof chosen === 'string') setPath(chosen);
    } catch (reason) { setError(String(reason)); }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const target = path.trim();
    if (!target || busy) return;
    setError(null);
    setBusy(true);
    api.setRoot(target).then(onDone, (err) => setError(String(err))).finally(() => setBusy(false));
  };

  return (
    <div className="onboarding-shell">
      <AmbientField dim={0.85} />
      <div className="onboarding" data-tauri-drag-region>
        <form className="onboarding-card" onSubmit={submit}>
          <div className="onboarding-head">
            <h1>Filigranas</h1>
            <p>Elige la carpeta general de tus proyectos o únete a una sesión compartida.</p>
          </div>
          <div className="onboarding-group">
            <label htmlFor="root" className="onboarding-label">
              Carpeta de proyectos
            </label>
            <div className="field">
              <span className="prompt" aria-hidden="true">
                ›
              </span>
              <input id="root" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} autoFocus disabled={busy} />
              <button type="button" className="ghost" onClick={pick} disabled={busy}>
                Elegir…
              </button>
            </div>
          </div>
          {(error || recoveryError) && <p className="error" role="alert">{error ?? recoveryError}</p>}
          <div className="onboarding-actions">
            <button className="primary" type="submit" disabled={!path.trim() || busy}>
              {busy ? 'Abriendo…' : 'Continuar'}
            </button>
            {recoveryError && (
              <button className="ghost" type="button" onClick={onRetry} disabled={busy}>
                Reintentar carpeta actual
              </button>
            )}
            <div className="onboarding-sep" aria-hidden="true">
              <span>o</span>
            </div>
            <button className="ghost onboarding-join" type="button" onClick={onJoin} disabled={busy}>
              Unirse a una sesión compartida
            </button>
          </div>
          <GithubConnect tool={github} onRefresh={onToolsRefresh} />
        </form>
      </div>
    </div>
  );
}
