import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { listen } from '@tauri-apps/api/event';
import { api } from './ipc';
import { loadMonaco, themeName } from './monacoLoader';

// Los modelos de Monaco sobreviven al componente para conservar el historial
// de deshacer. La versión guardada también debe pertenecer a cada modelo.
const saved = new WeakMap<Monaco.editor.ITextModel, { version: number | null; disk: string }>();

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
  const [conflict, setConflict] = useState<{ model: Monaco.editor.ITextModel; text: string } | null>(null);
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
    setConflict(null);
    Promise.all([loadMonaco(), api.readText(path, session)]).then(
      ([{ monaco, languageFor }, text]) => {
        if (!alive) return;
        const uri = monaco.Uri.file(path);
        let model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(text, languageFor(path), uri);
          saved.set(model, { version: model.getAlternativeVersionId(), disk: text });
        } else if (model.getAlternativeVersionId() === saved.get(model)?.version || model.getValue() === text) {
          // Sin cambios locales: tomar la versión del disco.
          if (model.getValue() !== text) model.setValue(text);
          saved.set(model, { version: model.getAlternativeVersionId(), disk: text });
        }
        const ed = editor.current;
        if (!ed) return;
        if (!saved.has(model)) saved.set(model, { version: model.getAlternativeVersionId(), disk: text });
        ed.setModel(model);
        setDirty(model.getAlternativeVersionId() !== saved.get(model)?.version);
        const sub = model.onDidChangeContent(() => setDirty(model!.getAlternativeVersionId() !== saved.get(model!)?.version));
        let saving = false;
        let readId = 0;
        const save = ed.addAction({
          id: 'filigranas.save',
          label: 'guardar',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: async () => {
            if (saving) return;
            saving = true;
            readId++;
            const version = model.getAlternativeVersionId();
            const content = model.getValue();
            try {
              await api.writeText(path, content, session, saved.get(model)!.disk);
              saved.set(model, { version, disk: content });
              if (alive) {
                setDirty(model.getAlternativeVersionId() !== version);
                setConflict(null);
              }
            } catch (e) {
              onErrorRef.current(String(e));
            } finally {
              saving = false;
              if (alive) later();
            }
          },
        });
        ed.focus();

        if (saved.get(model)?.disk !== text) setConflict({ model, text });
        let timer: number | undefined;
        const reload = () => {
          if (saving) return;
          const request = ++readId;
          const base = saved.get(model)!;
          return api.readText(path, session).then(
            (now) => {
              if (!alive || request !== readId || saved.get(model) !== base) return;
              if (now === base.disk) {
                setConflict(null);
                return;
              }
              if (now === model.getValue()) {
                saved.set(model, { version: model.getAlternativeVersionId(), disk: now });
                setDirty(false);
                setConflict(null);
              } else if (model.getAlternativeVersionId() === base.version) {
                const view = ed.saveViewState();
                model.setValue(now);
                saved.set(model, { version: model.getAlternativeVersionId(), disk: now });
                setDirty(false);
                setConflict(null);
                if (view) ed.restoreViewState(view);
              } else {
                setConflict({ model, text: now });
              }
            },
            () => {}, // borrado o ilegible: se mantiene lo que hay en pantalla
          );
        };
        const later = () => {
          window.clearTimeout(timer);
          timer = window.setTimeout(reload, 300);
        };
        const unlisten = listen('project-changed', later);
        void unlisten.then(() => { if (alive) later(); }, () => {});
        const unlistenSession = session == null ? null
          : listen<{ id: number; msg: any }>('session', ({ payload }) => {
              if (payload.id === session && ['result', 'turn_end'].includes(payload.msg?.type)) later();
            });
        cleanup = () => {
          window.clearTimeout(timer);
          unlisten.then((off) => off());
          unlistenSession?.then((off) => off());
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
  const keepDraft = () => {
    if (!conflict || editor.current?.getModel() !== conflict.model) return;
    const isSaved = conflict.model.getValue() === conflict.text;
    saved.set(conflict.model, { disk: conflict.text, version: isSaved ? conflict.model.getAlternativeVersionId() : null });
    setDirty(!isSaved);
    setConflict(null);
  };

  return (
    <section className="viewer" aria-label="Editor">
      <div className="viewer-head">
        <span className="muted">{rel.slice(0, sep)}</span>
        <span>{rel.slice(sep)}</span>
        {dirty && <span className="dirty" role="img" aria-label="sin guardar" title="sin guardar · ⌘S" />}
      </div>
      {conflict && <details className="share-file-conflict">
        <summary>Hay cambios guardados. Ver versión actual</summary>
        <pre>{conflict.text}</pre>
        <button className="co-btn" onClick={keepDraft}>Mantener mi borrador sobre esta versión</button>
      </details>}
      {error && <div className="viewer-msg">{error}</div>}
      <div ref={host} className="monaco" hidden={!!error} />
    </section>
  );
}
