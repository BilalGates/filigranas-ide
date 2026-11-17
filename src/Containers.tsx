import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { containers, type Container, type ContainersView } from './ipc';

type Props = { project: string; header: ReactNode; onCount: (n: number | null) => void };

const STATE_LABEL: Record<string, string> = { running: 'en marcha', exited: 'detenido', paused: 'en pausa', restarting: 'reiniciando', created: 'creado', dead: 'muerto' };

function Row({ c, action }: { c: Container; action?: ReactNode }) {
  const running = c.state === 'running';
  return (
    <div className="ctr-row">
      <span className={`ctr-dot${running ? (c.health === 'unhealthy' ? ' is-bad' : ' is-on') : ''}`} aria-hidden="true" />
      <div className="ctr-main">
        <div className="ctr-name" title={`${c.name} · ${c.id}`}>
          {c.service ?? c.name}
        </div>
        <div className="ctr-sub" title={c.image}>
          {STATE_LABEL[c.state] ?? c.state}
          {c.health ? ` · ${c.health === 'healthy' ? 'sano' : c.health === 'unhealthy' ? 'no sano' : c.health}` : ''} · {c.image}
        </div>
        {c.ports.length > 0 && <div className="ctr-ports">{c.ports.join('  ')}</div>}
      </div>
      {action}
    </div>
  );
}

/**
 * Contenedores Docker del proyecto, solo lectura. Se consulta al abrir, a
 * demanda y cada 10 s mientras la vista está visible; nunca en segundo plano.
 */
export default function Containers({ project, header, onCount }: Props) {
  const [view, setView] = useState<ContainersView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    containers
      .list(project)
      .then(
        (v) => {
          setView(v);
          setError(null);
          onCount(v.status === 'ok' ? v.compose.length + v.linked.length : null);
        },
        (e) => setError(String(e)),
      )
      .finally(() => setBusy(false));
  }, [project, onCount]);

  useEffect(() => {
    setView(null);
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const link = (c: Container) => containers.link(project, c.id, c.name).then(load, (e) => setError(String(e)));
  const unlink = (c: Container) => containers.unlink(c.id).then(load, (e) => setError(String(e)));

  const total = view ? view.compose.length + view.linked.length : 0;

  return (
    <aside className="git containers" aria-label="Contenedores">
      <div className="git-top" data-tauri-drag-region />
      {header}
      <div className="git-label">
        <span>{view?.status === 'ok' ? `${total} contenedor${total === 1 ? '' : 'es'}` : 'docker'}</span>
        <button className="co-link" onClick={load} disabled={busy}>
          {busy ? '…' : 'actualizar'}
        </button>
      </div>
      {error && <div className="git-error">{error}</div>}
      {view && view.status !== 'ok' && <div className={view.status === 'absent' ? 'muted' : 'git-error'}>{view.message}</div>}
      {view?.status === 'ok' && (
        <div className="ctr-list">
          {total === 0 && <div className="muted">Este proyecto no tiene contenedores asociados.</div>}
          {view.compose.length > 0 && <div className="git-label">compose</div>}
          {view.compose.map((c) => (
            <Row key={c.id} c={c} />
          ))}
          {view.linked.length > 0 && <div className="git-label">asociados a mano</div>}
          {view.linked.map((c) => (
            <Row
              key={c.id}
              c={c}
              action={
                <button className="co-link" onClick={() => unlink(c)} title="quitar la asociación con este proyecto">
                  quitar
                </button>
              }
            />
          ))}
          {view.unlinked.length > 0 && (
            <details className="ctr-unlinked">
              <summary className="git-label">sin asociar a ningún proyecto · {view.unlinked.length}</summary>
              <div className="muted ctr-hint">Contenedores sin Compose: asócialos si son de este proyecto. Si se recrean, habrá que volver a asociarlos.</div>
              {view.unlinked.map((c) => (
                <Row
                  key={c.id}
                  c={c}
                  action={
                    <button className="co-link" onClick={() => link(c)}>
                      asociar
                    </button>
                  }
                />
              ))}
            </details>
          )}
        </div>
      )}
    </aside>
  );
}
