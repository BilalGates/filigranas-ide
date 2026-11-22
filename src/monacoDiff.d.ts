declare module 'monaco-editor/editor/common/diff/linesDiffComputers.js' {
  type LineRange = { startLineNumber: number; endLineNumberExclusive: number };
  type DiffOptions = { ignoreTrimWhitespace: boolean; maxComputationTimeMs: number; computeMoves: boolean };

  export const linesDiffComputers: {
    getDefault(): {
      computeDiff(original: string[], modified: string[], options: DiffOptions): {
        changes: { original: LineRange; modified: LineRange }[];
        hitTimeout: boolean;
      };
    };
  };
}
