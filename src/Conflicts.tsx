import { useCallback, useEffect, useState } from 'react';
import { api } from './ipc';
import { conflictCount, parse, resolve, type Choice, type Segment } from './conflictMarks';

type Props = {
  project: string;
  /** Rutas relativas al proyecto con marcas de conflicto. */
  files: string[];
  hidden: boolean;
  onOpenFile: (path: string) => void;
};

type FileState = { path: string; segments: Segment[] | null; error: string | null };

/**
 * Resolución de los conflictos que deja «integrar con conflictos»: cada
 * bloque con la versión del proyecto y la de la sesión, y la elección se
 * escribe en el archivo. Lo que no encaje en un botón se edita a mano.
 */
export default function Conflicts({ project, files, hidden, onOpenFile }: Props) {
  const [state, setState] = useState<FileState[]>([]);
  const abs = (path: string) => `${project}/${path}`;

  const load = useCallback(() => {
    setState(files.map((path) => ({ path, segments: null, error: null })));
    files.forEach((path) =>
      api.readText(abs(path)).then(
        (text) => setState((list) => list.map((f) => (f.path === path ? { ...f, segments: parse(text), error: null } : f))),
        (e) => setState((list) => list.map((f) => (f.path === path ? { ...f, error: String(e) } : f))),
      ),
    );
  }, [project, files.join('\n')]);

  useEffect(load, [load]);

  const choose = (f: FileState, index: number, choice: Choice) => {
    if (!f.segments) return;
    const text = resolve(f.segments, index, choice);
    api.writeText(abs(f.path), text).then(
      () => setState((list) => list.map((x) => (x.path === f.path ? { ...x, segments: parse(text), error: null } : x))),
      (e) => setState((list) => list.map((x) => (x.path === f.path ? { ...x, error: String(e) } : x))),
    );
  };

  const left = state.reduce((n, f) => n + (f.segments ? conflictCount(f.segments) : 0), 0);

  return (
    <section className="coach" aria-label="Conflictos" hidden={hidden}>
      <div className="co-head">
        <span>conflictos</span>
        <span className={left ? 'co-state is-esperando-permiso' : 'add'}>{left ? `${left} por resolver` : 'resueltos'}</span>
        <span className="push" />
        <button className="co-link" onClick={load}>
          releer
        </button>
      </div>
      <div className="co-log">
        {state.map((f) => {
          let n = -1;
          return (
            <div className="conflict-file" key={f.path}>
              <div className="pending-head">
                <span>{f.path}</span>
                {f.segments && <span className="muted">{conflictCount(f.segments) || 'sin conflictos'}</span>}
                <span className="push" />
                <button className="co-link" onClick={() => onOpenFile(abs(f.path))}>
                  abrir en el editor
                </button>
              </div>
              {f.error && <div className="co-error">{f.error}</div>}
              {f.segments?.map((s, i) => {
                if (s.kind === 'text') return null;
                const index = ++n;
                return (
                  <div className="conflict-block" key={i}>
                    <div className="conflict-sides">
                      <div>
                        <div className="co-by">{s.oursLabel}</div>
                        <pre className="co-code">{s.ours || '(vacío)'}</pre>
                      </div>
                      <div>
                        <div className="co-by">{s.theirsLabel}</div>
                        <pre className="co-code">{s.theirs || '(vacío)'}</pre>
                      </div>
                    </div>
                    <div className="co-actions">
                      <button className="co-btn" onClick={() => choose(f, index, 'ours')}>
                        quedarme con {s.oursLabel}
                      </button>
                      <button className="co-btn" onClick={() => choose(f, index, 'theirs')}>
                        quedarme con {s.theirsLabel}
                      </button>
                      <button className="co-btn" onClick={() => choose(f, index, 'both')} title="ambas, una tras otra">
                        ambas
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        {!left && state.length > 0 && <div className="co-notice">Sin conflictos pendientes. Revisa el resultado en el panel Git; Larry propondrá los commits.</div>}
      </div>
    </section>
  );
}
