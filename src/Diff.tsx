import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type * as Monaco from 'monaco-editor';
import { git, sessions, type DiffTarget, type HealthRun } from './ipc';
import { loadMonaco } from './monacoLoader';

/**
 * Diff de un archivo cambiado: versión en HEAD frente a la del disco, o, en
 * una sesión aislada, frente al commit del que partió. Solo lectura; para
 * editar se abre el archivo desde el árbol. Se refresca cuando cambia algo
 * en el proyecto o la sesión termina un turno.
 */
export default function Diff({ project, change, inline = false, findings, showHeader = true }: {
  project: string; change: DiffTarget; inline?: boolean; findings?: HealthRun['findings']; showHeader?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const findingsRef = useRef(findings);
  const showFindings = useRef<(() => void) | null>(null);
  useEffect(() => {
    findingsRef.current = findings;
    showFindings.current?.();
  }, [findings]);


  useEffect(() => {
    let alive = true;
    let diff: Monaco.editor.IStandaloneDiffEditor | null = null;
    let code: Monaco.editor.IStandaloneCodeEditor | null = null;
    let decorations: Monaco.editor.IEditorDecorationsCollection | null = null;
    let models: Monaco.editor.ITextModel[] = [];
    let zones: string[] = [];
    let latest = 0;

    const load = async () => {
      const request = ++latest;
      try {
        const [{ monaco, baseOptions, languageFor }, texts, inlineModel] = await Promise.all([
          loadMonaco(),
          change.session != null ? sessions.diffTexts(change.session, change.path, change.orig) : git.diffTexts(project, change.path, change.orig),
          inline ? import('./unifiedDiff') : null,
        ]);
        if (!alive || request !== latest || !host.current) return;
        setError(null);
        const lang = languageFor(change.path);
        if (inlineModel) {
          const { rows, limited } = inlineModel.unifiedDiff(texts.old, texts.new);
          const value = rows.map((row) => row.text).join('\n');
          const number = (n: number, marks: number | undefined) => String(marks ?? '').padStart(n, ' ');
          const digits = String(rows.length).length;
          const lineNumbers = (n: number) => {
            const row = rows[n - 1];
            if (!row) return '';
            const sign = row.type === 'removed' ? '−' : row.type === 'added' ? '+' : ' ';
            return `${number(digits, row.original)} ${number(digits, row.modified)} ${sign}`;
          };
          if (!code) {
            models = [monaco.editor.createModel(value, lang)];
            code = monaco.editor.create(host.current, {
              ...baseOptions(), model: models[0], readOnly: true, ariaLabel: 'Diff unificado',
              lineNumbers, lineNumbersMinChars: digits * 2 + 3, folding: false,
            });
            decorations = code.createDecorationsCollection();
          } else {
            models[0].setValue(value);
            code.updateOptions({ lineNumbers, lineNumbersMinChars: digits * 2 + 3 });
          }
          decorations?.set(rows.flatMap((row, i) => row.type ? [{
            range: new monaco.Range(i + 1, 1, i + 1, 1),
            options: { isWholeLine: true, className: `diff-unified-${row.type}` },
          }] : []));
          let lines: Map<number, number> | undefined;
          showFindings.current = () => {
            const current = findingsRef.current ?? [];
            if (current.length && !lines) {
              const modifiedLines = new Map<number, number>();
              rows.forEach((row, i) => { if (row.modified != null) modifiedLines.set(row.modified, i + 1); });
              lines = modifiedLines;
            }
            const byLine = new Map<number, HealthRun['findings']>();
            for (const finding of current) {
              const line = finding.line == null ? undefined : lines?.get(finding.line);
              if (line == null) continue;
              const current = byLine.get(line) ?? [];
              current.push(finding);
              byLine.set(line, current);
            }
            code?.changeViewZones((accessor) => {
              zones.forEach((zone) => accessor.removeZone(zone));
              zones = [];
              for (const [line, items] of byLine) {
                const node = document.createElement('div');
                node.className = 'diff-finding';
                node.setAttribute('role', 'note');
                const severe = items.some((item) => item.severity === 'error');
                node.classList.toggle('diff-finding-error', severe);
                node.textContent = items.map((item) => `L${item.line} · ${item.rule}`).join(' · ');
                node.title = node.textContent;
                zones.push(accessor.addZone({ afterLineNumber: line, heightInLines: 1.65, domNode: node }));
              }
            });
          };
          showFindings.current();
          setLimited(limited);
        } else if (!diff) {
          diff = monaco.editor.createDiffEditor(host.current, { ...baseOptions(), readOnly: true, renderOverviewRuler: false });
          models = [monaco.editor.createModel(texts.old, lang), monaco.editor.createModel(texts.new, lang)];
          diff.setModel({ original: models[0], modified: models[1] });
        } else {
          models[0].setValue(texts.old);
          models[1].setValue(texts.new);
        }
      } catch (error) {
        if (alive && request === latest) setError(String(error));
      }
    };

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
      showFindings.current = null;
      window.clearTimeout(timer);
      unlisten.then((off) => off());
      unlistenSession.then((off) => off());
      diff?.dispose();
      code?.dispose();
      models.forEach((m) => m.dispose());
    };
  }, [project, change.path, change.orig, change.session, inline]);

  const sep = change.path.search(/[^\\/]*$/);

  return (
    <section className="viewer" aria-label="Diff">
      {showHeader && <div className="viewer-head">
        <span className="muted">{change.orig ? `${change.orig} → ` : ''}{change.path.slice(0, sep)}</span>
        <span>{change.path.slice(sep)}</span>
        <span className="muted">diff · {change.label ?? 'HEAD'}</span>
      </div>}
      {error && <div className="viewer-msg" role="alert">{error}</div>}
      {!error && inline && limited && <div className="viewer-msg" role="status">Comparación aproximada por tamaño del archivo.</div>}
      <div ref={host} className={`monaco${inline ? ' is-unified' : ''}`} hidden={!!error} />
    </section>
  );
}
