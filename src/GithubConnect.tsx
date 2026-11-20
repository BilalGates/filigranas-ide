import { useEffect, useState } from 'react';
import { githubLogin, type GithubLoginStatus, type Tool } from './ipc';

export default function GithubConnect({ tool, onRefresh }: { tool?: Tool; onRefresh: () => void }) {
  const [status, setStatus] = useState<GithubLoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = status?.state === 'waiting';

  useEffect(() => {
    let active = true;
    let timer: number;
    const read = async () => {
      try {
        const result = await githubLogin.status();
        if (!active) return;
        setStatus(result);
        if (result?.state === 'complete' && tool?.loggedIn !== true) onRefresh();
        if (result?.state !== 'waiting') return;
      } catch (reason) {
        if (!active) return;
        setError(String(reason));
        if (!waiting) return;
      }
      timer = window.setTimeout(read, 700);
    };
    void read();
    return () => { active = false; window.clearTimeout(timer); };
  }, [waiting, onRefresh, tool?.loggedIn]);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!tool?.installed && !waiting) return null;
  if (status?.state === 'waiting') {
    return (
      <div className="github-connect">
        {status.code
          ? <>
              <p>Introduce este código en GitHub para autorizar Filigranas.</p>
              <code tabIndex={0} aria-label="Código de GitHub">{status.code}</code>
              <button type="button" className="co-btn is-primary" disabled={busy} onClick={() => void run(async () => {
                await githubLogin.open();
              })}>Abrir GitHub</button>
            </>
          : <span role="status">Solicitando código a GitHub…</span>}
        <button type="button" className="co-btn" disabled={busy} onClick={() => void run(async () => {
          await githubLogin.cancel();
          setStatus(await githubLogin.status());
        })}>Cancelar</button>
        {error && <p className="co-error" role="alert">{error}</p>}
      </div>
    );
  }
  if (tool?.loggedIn || status?.state === 'complete') {
    return <span className="github-connected" role="status">{tool?.account ? `@${tool.account}` : 'GitHub conectado'}</span>;
  }
  return (
    <div className="github-connect">
      <button type="button" className="co-btn" disabled={busy} onClick={() => void run(async () => {
        setStatus(await githubLogin.start());
      })}>Iniciar sesión con GitHub</button>
      {(error || status?.state === 'error') && <p className="co-error" role="alert">{error ?? (status?.state === 'error' ? status.message : '')}</p>}
    </div>
  );
}
