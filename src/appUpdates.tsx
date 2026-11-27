import { useEffect, useState, useSyncExternalStore } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { pushNotification } from './trama/notifications';

type Status = { current: string; channel: string; version: string | null; notes: string | null; downloaded: boolean };
let status: Status | null = null;
let message = '';
let busy = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
let snapshot: { status: Status | null; message: string; busy: boolean } = { status, message, busy };
function publish() { snapshot = { status, message, busy }; notify(); }
async function operation(action: () => Promise<void>) {
  if (busy) return;
  busy = true; message = ''; publish();
  try { await action(); } catch (error) { message = String(error); }
  finally { busy = false; publish(); }
}
function check(channel?: string) {
  return operation(async () => {
    status = await invoke<Status>('update_check', { selected: channel ?? null });
    message = status.version ? 'Actualización disponible.' : 'Ya utilizas la última versión de este canal.';
    if (status.version) pushNotification({
      level: 'info', title: 'Actualización de Filigranas',
      summary: `Versión ${status.version} disponible. Puedes descargarla desde Ajustes.`,
      details: status.notes, fingerprint: `app-update-${status.version}`,
      source: 'Filigranas', action: { label: 'Ver actualización', target: 'settings', settingsSection: 'actualizaciones' },
    });
  });
}
export function useAppUpdates() {
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<Status>('update_status').then((value) => { status = value; publish(); }, (error) => { message = String(error); publish(); });
    const first = window.setTimeout(() => void check(), 15_000);
    const timer = window.setInterval(() => void check(), 6 * 60 * 60 * 1000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, []);
}
export default function AppUpdates() {
  const state = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
  const [confirmed, setConfirmed] = useState(false);
  const value = state.status;
  return <section className="pane" aria-label="Actualizaciones de Filigranas">
    <h2 className="vt">Actualizaciones de Filigranas</h2>
    <p className="mut2">Versión {value?.current ?? 'de desarrollo local'}</p>
    <div className="seg" role="group" aria-label="Canal de actualizaciones">
      {(['stable', 'development'] as const).map((channel) => <button key={channel} disabled={state.busy || !isTauri()} aria-pressed={value?.channel === channel} onClick={() => { setConfirmed(false); void check(channel); }}>{channel === 'stable' ? 'Estable' : 'Desarrollo'}</button>)}
    </div>
    <button className="tr-btn" disabled={state.busy || !isTauri()} onClick={() => void check()}>Buscar actualizaciones</button>
    {value?.version && <>
      <p>Versión disponible {value.version}</p>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{value.notes}</pre>
      {!value.downloaded ? <button className="tr-btn" disabled={state.busy} onClick={() => void operation(async () => { status = await invoke<Status>('update_download'); })}>Descargar actualización</button> : <>
        <p>La descarga está verificada. Cierra agentes, terminales y servicios antes de instalar.</p>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Autorizar instalación y reinicio</label>
        <button className="tr-btn" disabled={state.busy || !confirmed} onClick={() => void operation(async () => {
          const blockers = await invoke<string[]>('update_blockers');
          if (blockers.length) { message = `Instalación pospuesta. ${blockers.join(' · ')}`; return; }
          await invoke('update_install', { confirmed: true });
        })}>Instalar y reiniciar</button>
        <button className="tr-btn" onClick={() => { setConfirmed(false); message = 'Instalación pospuesta. La descarga sigue disponible durante esta sesión.'; publish(); }}>Posponer</button>
      </>}
    </>}
    <p role="status">{state.busy ? 'Procesando actualización…' : state.message}</p>
  </section>;
}
