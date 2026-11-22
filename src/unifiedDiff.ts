import { linesDiffComputers } from 'monaco-editor/editor/common/diff/linesDiffComputers.js';

type Line = { text: string; original?: number; modified?: number; type?: 'removed' | 'added' };

/** Compara las versiones reales con el algoritmo de líneas de Monaco, sin depender del worker. */
export function unifiedDiff(original: string, modified: string) {
  const before = original.split(/\r\n|\n|\r/);
  const after = modified.split(/\r\n|\n|\r/);
  const result = linesDiffComputers.getDefault().computeDiff(before, after, {
    ignoreTrimWhitespace: false,
    maxComputationTimeMs: 200,
    computeMoves: false,
  });
  const rows: Line[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const { original: from, modified: to } of result.changes) {
    while (oldLine < from.startLineNumber && newLine < to.startLineNumber) {
      rows.push({ text: after[newLine - 1], original: oldLine++, modified: newLine++ });
    }
    while (oldLine < from.endLineNumberExclusive) {
      if (original !== '') rows.push({ text: before[oldLine - 1], original: oldLine, type: 'removed' });
      oldLine++;
    }
    while (newLine < to.endLineNumberExclusive) {
      if (modified !== '') rows.push({ text: after[newLine - 1], modified: newLine, type: 'added' });
      newLine++;
    }
  }
  while (newLine <= after.length && oldLine <= before.length) {
    rows.push({ text: after[newLine - 1], original: oldLine++, modified: newLine++ });
  }
  return { rows, limited: result.hitTimeout };
}
