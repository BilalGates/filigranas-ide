import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type * as Monaco from 'monaco-editor';
import { git, type Change } from './ipc';
import { darkQuery, loadMonaco, themeName } from './monacoLoader';

/**
 * Diff de un archivo cambiado: versión en HEAD frente a la del disco. Solo
 * lectura; para editar se abre el archivo desde el árbol. Se refresca cuando
 * cambia algo en el proyecto.
 */
export default function Diff({ project, change }: { project: string; change: Change }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let diff: Monaco.editor.IStandaloneDiffEditor | null = null;
    let models: Monaco.editor.ITextModel[] = [];

    const load = () =>
      Promise.all([loadMonaco(), git.diffTexts(project, change.path, change.orig)]).then(
        ([{ monaco, baseOptions, languageFor }, texts]) => {
          if (!alive || !host.current) return;
          setError(null);
          if (!diff) {
            diff = monaco.editor.createDiffEditor(host.current, { ...baseOptions(), readOnly: true, renderOverviewRuler: false });
            const lang = languageFor(change.path);
            models = [monaco.editor.createModel(texts.old, lang), monaco.editor.createModel(texts.new, lang)];
            diff.setModel({ original: models[0], modified: models[1] });
          } else {
            models[0].setValue(texts.old);
            models[1].setValue(texts.new);
          }
        },
        (e) => alive && setError(String(e)),
      );

    load();
    let timer: number | undefined;
    const unlisten = listen('project-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 300);
    });
    const onScheme = () => loadMonaco().then(({ monaco }) => monaco.editor.setTheme(themeName()));
    darkQuery.addEventListener('change', onScheme);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      unlisten.then((off) => off());
      darkQuery.removeEventListener('change', onScheme);
      diff?.dispose();
      models.forEach((m) => m.dispose());
    };
  }, [project, change.path, change.orig]);

  const sep = change.path.search(/[^\\/]*$/);

  return (
    <section className="viewer" aria-label="Diff">
      <div className="viewer-head">
        <span className="muted">{change.orig ? `${change.orig} → ` : ''}{change.path.slice(0, sep)}</span>
        <span>{change.path.slice(sep)}</span>
        <span className="muted">diff · HEAD</span>
      </div>
      {error && <div className="viewer-msg">{error}</div>}
      <div ref={host} className="monaco" hidden={!!error} />
    </section>
  );
}
