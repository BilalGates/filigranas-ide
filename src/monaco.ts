// Monaco se carga solo al abrir el primer archivo o diff (import dinámico
// desde monacoLoader.ts), para que el arranque de la app no pague su peso.
import * as monaco from 'monaco-editor';
// El worker de diffs debe arrancar también desde el protocolo de assets de Tauri en WKWebView.
import EditorWorker from 'monaco-editor/editor/editor.worker?worker&inline';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';

const THEME = 'filigranas-dark';

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    switch (label) {
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      default:
        return new EditorWorker();
    }
  },
};

// Sin el proyecto completo cargado, el análisis semántico solo daría falsos
// errores (imports sin resolver). Se mantiene la validación de sintaxis.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

// Paleta sobria: casi todo en grises; solo cadenas y números llevan un
// tinte apagado. El fondo es transparente: se ve el negro del panel.
monaco.editor.defineTheme(THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'e5e5e5' },
    { token: 'keyword', foreground: '8c8c8c' },
    { token: 'string', foreground: 'b9d3c2' },
    { token: 'number', foreground: 'dcc7a1' },
    { token: 'type', foreground: 'ffffff' },
    { token: 'type.identifier', foreground: 'ffffff' },
    { token: 'comment', foreground: '5e5e5e', fontStyle: 'italic' },
    { token: 'regexp', foreground: 'dcc7a1' },
    { token: 'tag', foreground: 'ffffff' },
    { token: 'attribute.name', foreground: '8c8c8c' },
    { token: 'attribute.value', foreground: 'b9d3c2' },
    { token: 'delimiter', foreground: '6e6e6e' },
  ],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#e5e5e5',
    'editor.lineHighlightBackground': '#ffffff08',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#ffffff24',
    'editor.inactiveSelectionBackground': '#ffffff14',
    'editorCursor.foreground': '#ffffff',
    'editorLineNumber.foreground': '#3d3d3d',
    'editorLineNumber.activeForeground': '#a3a3a3',
    'editorIndentGuide.background1': '#ffffff0d',
    'editorIndentGuide.activeBackground1': '#ffffff1f',
    'editorWhitespace.foreground': '#ffffff1a',
    'editorWidget.background': '#0b0b0b',
    'editorWidget.border': '#262626',
    'editorSuggestWidget.background': '#0b0b0b',
    'editorSuggestWidget.border': '#262626',
    'editorSuggestWidget.selectedBackground': '#1c1c1c',
    'editorHoverWidget.background': '#0b0b0b',
    'editorHoverWidget.border': '#262626',
    'diffEditor.insertedTextBackground': '#3fb27f1f',
    'diffEditor.removedTextBackground': '#e5484d1f',
    'diffEditor.insertedLineBackground': '#3fb27f12',
    'diffEditor.removedLineBackground': '#e5484d12',
    'scrollbarSlider.background': '#ffffff12',
    'scrollbarSlider.hoverBackground': '#ffffff1f',
    'scrollbarSlider.activeBackground': '#ffffff2b',
    'editorGutter.background': '#00000000',
    focusBorder: '#00000000',
  },
});

monaco.editor.defineTheme('filigranas-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '141a2c' },
    { token: 'keyword', foreground: 'a3124a' },
    { token: 'string', foreground: '7d6100' },
    { token: 'number', foreground: 'b0301f' },
    { token: 'type', foreground: '4a3fb0' },
    { token: 'type.identifier', foreground: '4a3fb0' },
    { token: 'comment', foreground: '677089', fontStyle: 'italic' },
    { token: 'tag', foreground: '1f4fb5' },
    { token: 'delimiter', foreground: '565e74' },
  ],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#141a2c',
    'editor.lineHighlightBackground': '#1432a00d',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#1f4fb530',
    'editorCursor.foreground': '#b5123a',
    'editorLineNumber.foreground': '#8a91a6',
    'editorLineNumber.activeForeground': '#141a2c',
    'editorIndentGuide.background1': '#0a143c12',
    'editorWidget.background': '#fbfcff',
    'editorGutter.background': '#00000000',
    focusBorder: '#00000000',
  },
});

/** Lenguaje de Monaco a partir del nombre del archivo. */
export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id;
    if (lang.extensions?.some((ext) => name.endsWith(ext.toLowerCase()))) return lang.id;
  }
  return 'plaintext';
}

/** Opciones comunes del editor y del diff, con el tema del sistema. */
export function baseOptions() {
  return {
    theme: THEME,
    fontFamily: "Iosevka, Menlo, Consolas, monospace",
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
  } satisfies monaco.editor.IStandaloneEditorConstructionOptions;
}

export { monaco };
