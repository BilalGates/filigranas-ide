import { useEffect, useState, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import { jev, type JevStatusbar } from '../ipc';
import { shortcut } from '../ui';
import { percentLabel, type ProviderQuota, type QuotaWindow } from '../usageStore';
import { Icon } from './icons';

const JEV_MODE = { local: 'local', shadow: 'sombra', active: 'activo' };
const dots = Array.from({ length: 10 }, (_, i) => i);

function Meter({ label, window }: { label: string; window?: QuotaWindow }) {
  if (!window) return <span className="status-meter"><b>{label}</b> <i>cuota desconocida</i></span>;
  const filled = Math.round(window.percent / 10);
  return <span className="status-meter" title={`${label} · ${percentLabel(window.percent)} usado`}>
    <b>{label}{window.label !== label ? ` ${window.label}` : ''}</b>
    <span className={`status-meter-dots${window.percent >= 90 ? ' is-near' : ''}`} aria-hidden="true">
      {dots.map((i) => <i key={i} className={i < filled ? 'is-filled' : undefined} />)}
    </span>
    <span>{percentLabel(window.percent)}</span>
  </span>;
}

export default function StatusMeters({ quota, usage, tools, usageButton, onUsage, onJev }: {
  quota: ProviderQuota;
  usage: boolean;
  tools: boolean;
  usageButton: RefObject<HTMLButtonElement | null>;
  onUsage: () => void;
  onJev: () => void;
}) {
  const [status, setStatus] = useState<JevStatusbar | null>(null);
  useEffect(() => {
    let version = 0;
    const refresh = () => {
      const request = ++version;
      void jev.statusbar().then((value) => { if (request === version) setStatus(value); },
        () => { if (request === version) setStatus(null); });
    };
    refresh();
    const off = listen('tasks-changed', refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      version++;
      window.clearInterval(timer);
      void off.then((stop) => stop());
    };
  }, [tools]);

  const codex = quota.providerWindows.codex;
  const claude = quota.providerWindows.claude;
  return (
    <>
      <button className={`status-action status-jev${usage && tools ? ' is-on' : ''}`} onClick={onJev}
        aria-controls={usage && tools ? 'usage-popup' : undefined} aria-expanded={usage && tools}
        title={status ? 'Intentos de Jev en las últimas 24 horas' : 'Abrir herramientas y Jev'}>
        <Icon name="route" size={13} />
        <span>Jev{status ? ` ${JEV_MODE[status.mode]}` : ''}</span>
        {status && <span className="status-jev-budget">{status.used}/{status.limit}</span>}
      </button>
      <button ref={usageButton} className={`status-action status-usage${usage && !tools ? ' is-on' : ''}`}
        aria-controls={usage && !tools ? 'usage-popup' : undefined} aria-expanded={usage && !tools}
        aria-label="Uso de los modelos" onClick={onUsage} title={shortcut('Uso de los modelos · ⌘U')}>
        <Meter label="Codex" window={codex.find((window) => window.label === '5 h') ?? codex[0]} />
        <span className="status-claude"><Meter label="Claude" window={claude.find((window) => window.label === 'semana') ?? claude.find((window) => window.label === '5 h')} /></span>
        <span className="status-opus"><Meter label="Opus" window={claude.find((window) => window.label === 'Opus')} /></span>
      </button>
    </>
  );
}
