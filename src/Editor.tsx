import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { listen } from '@tauri-apps/api/event';
import { api } from './ipc';
import { loadMonaco, themeName } from './monacoLoader';

// Los modelos de Monaco sobreviven al componente para conservar el historial
// de deshacer. La versión guardada también debe pertenecer a cada modelo.
const savedVersions = new WeakMap<Monaco.editor.ITextModel, number>();

/**
 * Editor del archivo seleccionado. Guarda con ⌘S / Ctrl+S y marca con un
 * punto dorado los cambios sin guardar. Un modelo por archivo: al volver a
 * un archivo se conserva su deshacer mientras la app siga abierta.
 */
export default function Editor({ path, root, session = null, onError }: { path: string; root: string; session?: number | null; onError: (msg: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Crear el editor una vez.
  useEffect(() => {
    let disposed = false;
    loadMonaco().then(({ monaco, baseOptions }) => {
      if (disposed || !host.current) return;
      editor.current = monaco.editor.create(host.current, { ...baseOptions(), model: null });
      setReady(true);
    }, (e) => !disposed && setError(String(e)));
    const onScheme = () => loadMonaco().then(({ monaco }) => monaco.editor.setTheme(themeName()));
    window.addEventListener('filigranas-theme-changed', onScheme);
    return () => {
      disposed = true;
      window.removeEventListener('filigranas-theme-changed', onScheme);
      editor.current?.dispose();
      editor.current = null;
    };
  }, []);

  // Cargar el archivo al cambiar de ruta.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setError(null);
    Promise.all([loadMonaco(), api.readText(path, session)]).then(
      ([{ monaco, languageFor }, text]) => {
        if (!alive) return;
        const uri = monaco.Uri.file(path);
        let model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(text, languageFor(path), uri);
          savedVersions.set(model, model.getAlternativeVersionId());
        } else if (model.getAlternativeVersionId() === savedVersions.get(model) && model.getValue() !== text) {
          // Sin cambios locales: tomar la versión del disco.
          model.setValue(text);
          savedVersions.set(model, model.getAlternativeVersionId());
        }
        const ed = editor.current;
        if (!ed) return;
        if (!savedVersions.has(model)) savedVersions.set(model, model.getAlternativeVersionId());
        ed.setModel(model);
        setDirty(model.getAlternativeVersionId() !== savedVersions.get(model));
        const sub = model.onDidChangeContent(() => setDirty(model!.getAlternativeVersionId() !== savedVersions.get(model!)));
        const save = ed.addAction({
          id: 'filigranas.save',
          label: 'guardar',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: async () => {
            const version = model!.getAlternativeVersionId();
            const content = model!.getValue();
            try {
              const currentDisk = await api.readText(path, session);
              if (currentDisk !== disk) {
                onErrorRef.current(`${path.slice(path.lastIndexOf('/') + 1)} cambió en disco; vuelve a abrirlo antes de guardar`);
                return;
              }
              await api.writeText(path, content, session);
              disk = content;
              savedVersions.set(model!, version);
              if (alive) setDirty(model!.getAlternativeVersionId() !== version);
            } catch (e) {
              onErrorRef.current(String(e));
            }
          },
        });
        ed.focus();

        // Cambios externos (un agente, un cambio de rama): sin cambios
        // locales se toma la versión del disco; con ellos no se toca nada y
        // se avisa, porque guardar sobrescribiría lo que hay en disco.
        let disk = text;
        if (model.getValue() !== text && model.getAlternativeVersionId() !== savedVersions.get(model)) {
          onErrorRef.current(`${path.slice(path.lastIndexOf('/') + 1)} cambió en disco; vuelve a abrirlo antes de guardar`);
        }
        let timer: number | undefined;
        const reload = () =>
          api.readText(path, session).then(
            (now) => {
              if (!alive || now === disk) return;
              disk = now;
              // Lo guardado desde aquí también llega por el observador.
              if (now === model!.getValue()) return;
              if (model!.getAlternativeVersionId() === savedVersions.get(model!)) {
                const view = ed.saveViewState();
                model!.setValue(now);
                savedVersions.set(model!, model!.getAlternativeVersionId());
                if (view) ed.restoreViewState(view);
              } else {
                onErrorRef.current(`${path.slice(path.lastIndexOf('/') + 1)} cambió en disco; guardar sobrescribirá esa versión`);
              }
            },
            () => {}, // borrado o ilegible: se mantiene lo que hay en pantalla
          );
        const later = () => {
          window.clearTimeout(timer);
          timer = window.setTimeout(reload, 300);
        };
        // Archivos de una sesión: su carpeta no se observa; se relee cuando
        // el agente termina un turno.
        const unlisten =
          session == null
            ? listen('project-changed', later)
            : listen<{ id: number; msg: any }>('session', ({ payload }) => {
                if (payload.id === session && ['result', 'turn_end'].includes(payload.msg?.type)) later();
              });
        cleanup = () => {
          window.clearTimeout(timer);
          unlisten.then((off) => off());
          sub.dispose();
          save.dispose();
        };
      },
      (e) => alive && setError(String(e)),
    );
    let cleanup = () => {};
    return () => {
      alive = false;
      cleanup();
    };
  }, [path, session, ready]);

  const rel = root && path.startsWith(root) ? path.slice(root.length + 1) : path;
  const sep = rel.search(/[^\\/]*$/);

  return (
    <section className="viewer" aria-label="Editor">
      <div className="viewer-head">
        <span className="muted">{rel.slice(0, sep)}</span>
        <span>{rel.slice(sep)}</span>
        {dirty && <span className="dirty" role="img" aria-label="sin guardar" title="sin guardar · ⌘S" />}
      </div>
      {error && <div className="viewer-msg">{error}</div>}
      <div ref={host} className="monaco" hidden={!!error} />
    </section>
  );
}
