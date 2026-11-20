import { useEffect, useRef, useState } from 'react';
import type { Tool } from './ipc';
import GithubConnect from './GithubConnect';

function Avatar({ account }: { account: string | null }) {
  const [failed, setFailed] = useState(false);
  return account && !failed
    ? <img src={`https://github.com/${encodeURIComponent(account)}.png?size=80`} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    : <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.73 1.16 1.73 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.4-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.43.11-2.98 0 0 .94-.3 3.1 1.15a10.8 10.8 0 0 1 5.64 0c2.15-1.46 3.09-1.15 3.09-1.15.61 1.55.23 2.69.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.27-5.14 5.55.41.35.76 1.03.76 2.08v3.1c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z" /></svg>;
}

export default function GithubProfile({ tool, open, onOpenChange, onRefresh }: {
  tool?: Tool; open: boolean; onOpenChange: (open: boolean) => void; onRefresh: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const account = tool?.loggedIn ? tool.account ?? null : null;
  const label = account ? `GitHub · @${account}` : 'Cuenta de GitHub';
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        onOpenChange(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, onOpenChange]);

  return <div className="github-profile" ref={root}>
    <button ref={button} className="github-profile-button" aria-label={label} title={label}
      aria-expanded={open} aria-controls={open ? 'github-profile-popup' : undefined} onClick={() => { if (!open) onRefresh(); onOpenChange(!open); }}>
      <Avatar key={account} account={account} />
    </button>
    {open && <section id="github-profile-popup" className="github-profile-popup" aria-label="Perfil de GitHub">
      <header><span className="github-profile-image"><Avatar key={account} account={account} /></span>
        <div><strong>{account ? `@${account}` : 'GitHub'}</strong><p>{tool?.loggedIn ? 'Cuenta activa en Filigranas' : 'Conecta tu cuenta de GitHub'}</p></div>
      </header>
      {tool == null ? <p role="status">Comprobando cuenta…</p> : !tool.installed
        ? <p>Instala GitHub CLI para conectar tu cuenta.</p> : <GithubConnect tool={tool} onRefresh={onRefresh} />}
    </section>}
  </div>;
}
