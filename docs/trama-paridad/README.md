# Paridad visual con el Artifact Trama v2

Los PNG históricos de 1600 × 900 y 1280 × 800 muestran el Artifact a la izquierda y Filigranas en Chromium a la derecha. Los escenarios contienen datos diferentes. La tabla inferior registra la valoración de la integración previa.

## Capturas de la rama de integración

Cada hoja compara el HTML adjunto a la izquierda con Filigranas a la derecha. Incluye las seis vistas, Flow en demostración y Ajustes. Los datos de los dos lados difieren. Filigranas usa el núcleo simulado de desarrollo en Chromium. [Cabecera y barra inferior](marco-1440x900.webp). [Registro de capturas](chromium-capturas.json). [1600 × 900](chromium-1600x900.webp) · [1440 × 900](chromium-1440x900.webp) · [1280 × 800](chromium-1280x800.webp) · [1050 × 720](chromium-1050x720.webp) · [820 × 600](chromium-820x600.webp).

Desde la raíz, iniciar `pnpm dev`. En un entorno Python con `playwright` y `Pillow`, instalar Chromium con `python -m playwright install chromium` o pasar `--channel chrome` si está instalado Chrome. Ejecutar:

```sh
python tests/trama_browser.py
python design/trama-v2/parity.py --output /tmp/filigranas-trama-capturas
```

Añadir `--artifact /ruta/al/export-v2/index.html` para capturar ambas vistas. Usar `--diff` cuando se hayan alineado datos y estados. El script comprueba que el export incluya navegación y Ajustes. Para el archivo adjunto se usó `--reference-label "HTML adjunto"`. La revisión exacta de esa exportación queda por confirmar.

Última revisión de Workspace, Studio, Ajustes y Brain. [1440 × 900](continuacion-1440x900.webp) · [1050 × 720](continuacion-1050x720.webp).

[Resultado y matriz de trazabilidad](resultado.md).

## Cómo se consigue la fidelidad

- **Estilos del Artifact.** `design/trama-v2/style.css` y `v2.css` se convierten en `src/trama/artifact.css` con `design/trama-v2/scope.py`. El resultado queda envuelto en `@scope (.tv) to (.legacy)`: las vistas nuevas usan las clases y el marcado del Artifact, y los componentes existentes que se incrustan (GitPanel, Larry, Publish, CodeHealth, Tools…) quedan fuera del ámbito y conservan su estilo.
- **Integración en la app.** `src/trama/shell.css` contiene solo lo necesario para encajar esas vistas en el marco de la aplicación.

## Resultado por sección

| Sección | Estructura | Escala y tipografía | Luz | Estados | Diferencias que quedan |
| --- | --- | --- | --- | --- | --- |
| Inicio | igual | igual | campo y esfera iguales | reposo propio (hilos «libre» y esfera que respira) | sin sesiones activas en el simulador, la trama muestra el reposo |
| Workspace | igual (Conversaciones · chat · código) | igual | igual | real | los mensajes ricos del prototipo (diagramas, filas de agentes con Observar) dependen del contenido de cada conversación real |
| Flow | igual (carriles, leyenda, Jev, cuotas, inspector) | igual | igual | vacío propio y demostración en memoria | sin barra de progreso: el núcleo no da porcentajes |
| Studio | igual (pantallas, versiones, lienzo, barra vertical, compositor, inspector) | igual | igual | vacío propio | sin galería de referencias: `design_send` no admite adjuntos |
| Entrega | igual (nueve etapas, archivos, diff, auditoría) | igual | igual | sin cambios: el historial pasa a ser protagonista | el treemap se construye a partir de los hallazgos reales |
| Brain | igual (columnas por tipo, foco, índice, contexto) | igual | igual | vacío propio | todo está confirmado: no hay «inferidos» |
| Ajustes | igual (navegación y filas con ámbito) | igual | igual | real | no hay matriz de skills por rol: el núcleo no asigna skills por rol |

`flow-demo-*.png` muestra Flow con agentes y tareas simultáneos. Los datos son de demostración, en memoria y marcados como tales.
