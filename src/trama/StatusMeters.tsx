import { useEffect, useState, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import { jev, type JevStatusbar } from '../ipc';
import { Icon } from './icons';

const JEV_MODE = { local: 'local', shadow: 'sombra', active: 'activo' };
export default function JevStatusButton({ open, buttonRef, onClick }: {
  open: boolean; buttonRef: RefObject<HTMLButtonElement | null>; onClick: () => void;
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
  }, [open]);

  return (
    <button ref={buttonRef} className={`status-action status-jev${open ? ' is-on' : ''}`} onClick={onClick}
      aria-controls={open ? 'usage-popup' : undefined} aria-expanded={open}
      title={status ? 'Intentos de Jev en las últimas 24 horas' : 'Abrir herramientas y Jev'}>
      <Icon name="route" size={13} />
      <span>Jev{status ? ` ${JEV_MODE[status.mode]}` : ''}</span>
      {status && <span className="status-jev-budget">{status.used}/{status.limit}</span>}
    </button>
  );
}
