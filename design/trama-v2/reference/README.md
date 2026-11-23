# Referencia canónica de Filigranas · Trama v2

El 22 de noviembre de 2026 Bilal indicó el archivo `Filigranas · Trama.html` del Escritorio como referencia de Trama v2. [index.html](index.html) conserva los bytes de ese archivo. El título interno dice «Filigranas · Trama». La selección del usuario identifica la revisión adoptada.

[El manifiesto](manifest.json) registra SHA-256 del HTML, sus bloques CSS y JavaScript y los recursos externos. El JavaScript contiene las plantillas SVG, el conjunto de datos de ejemplo y el dibujo de los lienzos. Los iconos y dibujos forman parte del mismo HTML. Se conserva la respuesta de Google Fonts para Safari, las fuentes WOFF2 de Inter, JetBrains Mono y Doto, y sus licencias OFL.

[style.css](../style.css), [v2.css](../v2.css) y [artifact.css](../../../src/trama/artifact.css) pertenecen al historial de implementación. Su relación con el export y su función se documentan en [la integración de Trama v2](../../../docs/trama-v2-integracion.md).

Para verificar los hashes y capturar el HTML localmente con Playwright y Pillow:

```sh
python design/trama-v2/parity.py --reference-only --channel chrome --width 1440 --output /private/tmp/trama-referencia
```

El navegador recibe las fuentes archivadas al solicitar sus URL originales. Así se ejecuta el HTML exacto con los recursos conservados.
