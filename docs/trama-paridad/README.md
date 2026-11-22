# Paridad visual con el Artifact Trama v2

Cada imagen pone el Artifact aprobado a la izquierda y Filigranas a la derecha, a la misma resolución: `<sección>-1600.png` es 1600 × 900 y `<sección>-1280.png` es 1280 × 800.

Las capturas de Filigranas se hicieron en Chromium contra `pnpm dev` con el núcleo simulado (`src/mock.ts`). Para regenerarlas: `python3 parity.py` (script de trabajo; necesita el Artifact servido localmente).

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
