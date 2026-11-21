import { useEffect, useRef, useState } from 'react';
import { Icon } from './GitPanel';
import { localServices, type LocalService, type ServiceAction, type ServiceForm } from './ipc';

type Props = { project: string; onOpen: (url: string) => void };

const LABELS: Record<LocalService['state'], string> = {
  stopped: 'Detenido',
  running: 'En marcha',
  exited: 'Finalizado',
  failed: 'Falló',
};
const EMPTY: ServiceForm = { id: null, name: '', command: '', port: null };

export default function Containers({ project, onOpen }: Props) {
  const [services, setServices] = useState<LocalService[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<ServiceForm | null>(null);
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const log = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const active = services?.find((s) => s.id === selected);
  const output = active?.logs;

  useEffect(() => {
    if (busy) return;
    let current = true;
    let pending = false;
    let pollingError = false;
    const load = () => {
      if (pending) return;
      pending = true;
      localServices.list(project, selected).then((next) => {
        if (!current) return;
        setServices(next);
        if (pollingError) setError(null);
        pollingError = false;
      }, (e) => {
        if (!current) return;
        pollingError = true;
        setError(String(e));
      }).finally(() => { pending = false; });
    };
    load();
    const timer = window.setInterval(load, 1000);
    return () => { current = false; window.clearInterval(timer); };
  }, [project, selected, busy, revision]);

  useEffect(() => {
    if (log.current && follow.current) log.current.scrollTop = log.current.scrollHeight;
  }, [output, selected]);

  const select = (id: string | null) => {
    follow.current = true;
    setSelected(id);
    setDeleteFor(null);
  };

  const mutate = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (e) {
      setError(String(e));
    } finally {
      setRevision((r) => r + 1);
      setBusy(false);
    }
  };

  const act = (id: string, action: ServiceAction) => void mutate(async () => {
    await localServices.action(project, id, action);
    if (action === 'remove' && selected === id) select(null);
  });

  const save = (value: ServiceForm) => void mutate(async () => {
    const id = await localServices.save(project, value);
    select(id);
    setForm(null);
  });

  const running = services?.filter((s) => s.state === 'running').length ?? 0;

  return (
    <section className="service-panel" aria-label="Servicios locales del proyecto">
      <div className="service-head">
        <div>
          <h3>Servicios locales</h3>
          {services && <span className="muted">{running} en marcha · {services.length} en total</span>}
        </div>
        <button className="co-btn" disabled={busy || !!form} onClick={() => setForm(EMPTY)}><Icon name="plus" size={13} /> Nuevo servicio</button>
      </div>
      {error && <p className="co-error" role="alert">{error}</p>}
      {form && (
        <form className="service-form" onSubmit={(e) => { e.preventDefault(); save(form); }}>
          <h3>{form.id ? 'Editar servicio' : 'Nuevo servicio'}</h3>
          <label>Nombre<input required maxLength={120} autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Comando<textarea required rows={2} maxLength={8192} value={form.command} placeholder="pnpm dev" onChange={(e) => setForm({ ...form, command: e.target.value })} /></label>
          <label>Puerto (opcional)<input type="number" min={1} max={65535} value={form.port ?? ''} placeholder="3000" onChange={(e) => setForm({ ...form, port: e.target.value ? Number(e.target.value) : null })} /></label>
          <p className="muted">El comando se ejecuta en la carpeta del proyecto con tus permisos. Si indicas un puerto, se pasa como <code>PORT</code> y se habilita el acceso desde el navegador.</p>
          <div className="service-actions">
            <button type="submit" className="co-btn is-primary" disabled={busy || !form.name.trim() || !form.command.trim()}>Guardar</button>
            <button type="button" className="co-btn" disabled={busy} onClick={() => setForm(null)}>Cancelar</button>
          </div>
        </form>
      )}
      {services === null && !error && <p className="muted">Cargando servicios…</p>}
      {!form && services?.length === 0 && <p className="service-empty muted">Añade el comando con el que arrancas el servidor, una API u otro proceso de este proyecto.</p>}
      {!!services?.length && (
        <div className="service-list" aria-label="Servicios">
          {services.map((s) => (
            <div className="service-row" key={s.id}>
              <button className="service-select" aria-pressed={selected === s.id} onClick={() => select(s.id)}>
                <Icon name="box" size={16} />
                <span><strong>{s.name}</strong><small>{s.port ? `localhost:${s.port}` : s.command}</small></span>
                <span className="service-state" data-state={s.state}><i />{LABELS[s.state]}</span>
              </button>
              <button className="co-btn" disabled={busy} aria-label={`${s.state === 'running' ? 'Detener' : 'Arrancar'} ${s.name}`} onClick={() => act(s.id, s.state === 'running' ? 'stop' : 'start')}>
                {s.state === 'running' ? 'Detener' : 'Arrancar'}
              </button>
            </div>
          ))}
        </div>
      )}
      {active && !form && (
        <section className="service-detail" aria-label={`Detalles de ${active.name}`}>
          <div className="service-detail-head">
            <h3>{active.name}</h3>
            <span className="muted">{active.pid ? `PID ${active.pid}` : active.exitCode !== null ? `Salida ${active.exitCode}` : LABELS[active.state]}</span>
          </div>
          <code className="service-command">{active.command}</code>
          <div className="service-actions">
            {active.port && active.state === 'running' && <button className="co-btn" onClick={() => onOpen(`http://localhost:${active.port}`)}><Icon name="globe" size={14} /> Abrir en el navegador</button>}
            {active.state === 'running' ? (
              <button className="co-btn" disabled={busy} onClick={() => act(active.id, 'restart')}>Reiniciar</button>
            ) : (
              <>
                <button className="co-btn" disabled={busy} onClick={() => setForm({ id: active.id, name: active.name, command: active.command, port: active.port })}>Editar</button>
                <button className="co-btn" disabled={busy} onClick={() => setDeleteFor(active.id)}>Quitar</button>
              </>
            )}
          </div>
          {deleteFor === active.id && active.state !== 'running' && <div className="service-actions">
            <span>¿Quitar la configuración de {active.name}?</span>
            <button className="co-btn" disabled={busy} onClick={() => act(active.id, 'remove')}>Confirmar</button>
            <button className="co-btn" disabled={busy} onClick={() => setDeleteFor(null)}>Cancelar</button>
          </div>}
          <h4>Registros</h4>
          <pre ref={log} className="service-log" tabIndex={0} aria-label={`Registros de ${active.name}`} onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          }}>{output || 'Sin salida todavía.'}</pre>
        </section>
      )}
    </section>
  );
}
