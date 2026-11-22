import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type * as Monaco from 'monaco-editor';
import { git, sessions, type DiffTarget } from './ipc';
import { loadMonaco } from './monacoLoader';

/**
 * Diff de un archivo cambiado: versión en HEAD frente a la del disco, o, en
 * una sesión aislada, frente al commit del que partió. Solo lectura; para
 * editar se abre el archivo desde el árbol. Se refresca cuando cambia algo
 * en el proyecto o la sesión termina un turno.
 */
export default function Diff({ project, change, inline = false }: { project: string; change: DiffTarget; inline?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let diff: Monaco.editor.IStandaloneDiffEditor | null = null;
    let models: Monaco.editor.ITextModel[] = [];

    const load = () =>
      Promise.all([
        loadMonaco(),
        change.session != null ? sessions.diffTexts(change.session, change.path, change.orig) : git.diffTexts(project, change.path, change.orig),
      ]).then(
        ([{ monaco, baseOptions, languageFor }, texts]) => {
          if (!alive || !host.current) return;
          setError(null);
          if (!diff) {
            diff = monaco.editor.createDiffEditor(host.current, { ...baseOptions(), readOnly: true, renderOverviewRuler: false, renderSideBySide: !inline });
            const lang = languageFor(change.path);
            models = [monaco.editor.createModel(texts.old, lang), monaco.editor.createModel(texts.new, lang)];
            diff.setModel({ original: models[0], modified: models[1] });
          } else {
            models[0].setValue(texts.old);
            models[1].setValue(texts.new);
          }
        },
      ).catch((error) => { if (alive) setError(String(error)); });

    load();
    let timer: number | undefined;
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 300);
    };
    const unlisten = listen('project-changed', later);
    const unlistenSession = listen<{ id: number; msg: any }>('session', ({ payload }) => {
      if (payload.id === change.session && ['result', 'turn_end'].includes(payload.msg?.type)) later();
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
      unlisten.then((off) => off());
      unlistenSession.then((off) => off());
      diff?.dispose();
      models.forEach((m) => m.dispose());
    };
  }, [project, change.path, change.orig, change.session, inline]);

  const sep = change.path.search(/[^\\/]*$/);

  return (
    <section className="viewer" aria-label="Diff">
      <div className="viewer-head">
        <span className="muted">{change.orig ? `${change.orig} → ` : ''}{change.path.slice(0, sep)}</span>
        <span>{change.path.slice(sep)}</span>
        <span className="muted">diff · {change.label ?? 'HEAD'}</span>
      </div>
      {error && <div className="viewer-msg">{error}</div>}
      <div ref={host} className="monaco" hidden={!!error} />
    </section>
  );
}
