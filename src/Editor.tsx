import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { api } from './ipc';

type MonacoModule = typeof import('./monaco');

let loading: Promise<MonacoModule> | null = null;
const loadMonaco = () => (loading ??= import('./monaco'));

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const themeName = () => (darkQuery.matches ? 'filigranas-dark' : 'filigranas-light');

/**
 * Editor del archivo seleccionado. Guarda con ⌘S / Ctrl+S y marca con un
 * punto dorado los cambios sin guardar. Un modelo por archivo: al volver a
 * un archivo se conserva su deshacer mientras la app siga abierta.
 */
export default function Editor({ path, root, onError }: { path: string; root: string; onError: (msg: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const saved = useRef<number>(0);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Crear el editor una vez.
  useEffect(() => {
    let disposed = false;
    loadMonaco().then(({ monaco }) => {
      if (disposed || !host.current) return;
      editor.current = monaco.editor.create(host.current, {
        theme: themeName(),
        fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
        fontSize: 12.5,
        lineHeight: 22,
        fontLigatures: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        overviewRulerLanes: 0,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        renderLineHighlight: 'line',
        lineNumbersMinChars: 4,
        glyphMargin: false,
        folding: true,
        stickyScroll: { enabled: false },
        padding: { top: 4, bottom: 16 },
        smoothScrolling: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        cursorBlinking: 'phase',
        automaticLayout: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
        model: null,
      });
    });
    const onScheme = () => loadMonaco().then(({ monaco }) => monaco.editor.setTheme(themeName()));
    darkQuery.addEventListener('change', onScheme);
    return () => {
      disposed = true;
      darkQuery.removeEventListener('change', onScheme);
      editor.current?.dispose();
      editor.current = null;
    };
  }, []);

  // Cargar el archivo al cambiar de ruta.
  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([loadMonaco(), api.readText(path)]).then(
      ([{ monaco, languageFor }, text]) => {
        if (!alive) return;
        const uri = monaco.Uri.file(path);
        let model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(text, languageFor(path), uri);
          saved.current = model.getAlternativeVersionId();
        } else if (model.getAlternativeVersionId() === saved.current && model.getValue() !== text) {
          // Sin cambios locales: tomar la versión del disco.
          model.setValue(text);
          saved.current = model.getAlternativeVersionId();
        }
        const ed = editor.current;
        if (!ed) return;
        ed.setModel(model);
        setDirty(model.getAlternativeVersionId() !== saved.current);
        const sub = model.onDidChangeContent(() => setDirty(model!.getAlternativeVersionId() !== saved.current));
        const save = ed.addAction({
          id: 'filigranas.save',
          label: 'guardar',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: async () => {
            const version = model!.getAlternativeVersionId();
            try {
              await api.writeText(path, model!.getValue());
              saved.current = version;
              setDirty(model!.getAlternativeVersionId() !== version);
            } catch (e) {
              onErrorRef.current(String(e));
            }
          },
        });
        ed.focus();
        cleanup = () => {
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
  }, [path]);

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
