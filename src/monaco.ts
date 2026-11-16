// Monaco se carga solo al abrir el primer archivo o diff (import dinámico
// desde monacoLoader.ts), para que el arranque de la app no pague su peso.
import * as monaco from 'monaco-editor';
import { themeName } from './monacoLoader';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';

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

// Paleta blaugrana, la misma que styles.css. El fondo es transparente para
// que se vea el panel (y el material nativo) por detrás.
monaco.editor.defineTheme('filigranas-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'e6e9f2' },
    { token: 'keyword', foreground: 'f07193' },
    { token: 'string', foreground: 'e6c35c' },
    { token: 'number', foreground: 'ff8f8f' },
    { token: 'type', foreground: 'a8b6ff' },
    { token: 'type.identifier', foreground: 'a8b6ff' },
    { token: 'comment', foreground: '7f879c', fontStyle: 'italic' },
    { token: 'regexp', foreground: 'ff8f8f' },
    { token: 'tag', foreground: '7aa8ff' },
    { token: 'attribute.name', foreground: 'f07193' },
    { token: 'attribute.value', foreground: 'e6c35c' },
    { token: 'delimiter', foreground: '8f96aa' },
  ],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#e6e9f2',
    'editor.lineHighlightBackground': '#7896ff12',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#5b8ff045',
    'editor.inactiveSelectionBackground': '#5b8ff025',
    'editorCursor.foreground': '#ef4a66',
    'editorLineNumber.foreground': '#5d647a',
    'editorLineNumber.activeForeground': '#e6e9f2',
    'editorIndentGuide.background1': '#a0b4ff12',
    'editorIndentGuide.activeBackground1': '#a0b4ff2a',
    'editorWhitespace.foreground': '#a0b4ff20',
    'editorWidget.background': '#0c1020',
    'editorWidget.border': '#a0b4ff24',
    'editorSuggestWidget.background': '#0c1020',
    'editorSuggestWidget.selectedBackground': '#5b8ff030',
    'editorHoverWidget.background': '#0c1020',
    'scrollbarSlider.background': '#a0b4ff18',
    'scrollbarSlider.hoverBackground': '#a0b4ff2a',
    'scrollbarSlider.activeBackground': '#a0b4ff3a',
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
    theme: themeName(),
    fontFamily: "Menlo, Consolas, monospace",
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
