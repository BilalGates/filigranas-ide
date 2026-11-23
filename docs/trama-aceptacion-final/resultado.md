# Trama v2 · Correcciones y aceptación

22–23 de noviembre de 2026 · macOS 27.2.1 arm64 · base `136dc6d` · rama `codex/trama-aceptacion-final`.

**El rendimiento mejoró en los recorridos medidos. La aceptación integral de Trama v2 sigue abierta.**

## Referencia

[Filigranas · Trama v2](../../design/trama-v2/reference/index.html) es la copia exacta del export del Escritorio seleccionado por Bilal. SHA-256 `7e20b6e508b43c0f76c54f42da6e423ee9e9b280265f9d0767d2bf1e2d18fd38`. [El manifiesto](../../design/trama-v2/reference/manifest.json) identifica y verifica el contenido incrustado y los recursos originales. Las capturas de referencia se hicieron a 1440 × 900, escala 1×, con movimiento reducido y las fuentes archivadas. [Reproducción de las capturas](../../design/trama-v2/reference/README.md).

Se cotejaron las 19 evidencias de «Evidencias visuales de Trama v2» del Escritorio con las copias archivadas. Coinciden byte a byte. Las 24 capturas y montajes del trabajo de integración amplían la referencia de tamaños y estados. [Auditoría anterior](../auditoria-trama/) · [Integración anterior](../trama-paridad/).

## Comparativas de las siete vistas en una misma WKWebView

El recorrido del 23 de noviembre renderiza Filigranas y el HTML canónico en la misma ventana de desarrollo, a 1440 × 900 y 1×. Valida el SHA-256 del HTML y de sus fuentes archivadas. Durante las capturas fija los estados de los agentes del HTML, dibuja el campo de reposo y espera a que la aplicación confirme cada escena. Las tomas mantienen el marco nativo. El cálculo de píxeles usa la intersección de las superficies de trabajo.

| Vista | Estado compartido que se comprobó | Qué queda por igualar |
| --- | --- | --- |
| Inicio | Nueve nombres de proyecto, tres grupos y sigilos de 68 × 68. | Orden dentro de los grupos, agentes activos y avisos de CI y permisos. |
| Workspace | El plan de ocho tareas y diez enlaces en el historial local del PM. | Las tarjetas de arquitectura y actividad y el estado de permiso del turno. |
| Flow | Ejecución con t2 seleccionada en el conjunto de ejemplo. | Cronología e inspector con los mismos eventos de Jev. |
| Studio | Panel de Git, v3 aprobada y seleccionada, cuatro versiones y seis referencias. | Vista previa interactiva y distribución del inspector. |
| Entrega | El antes y después de git_ops.rs y los dos hallazgos en línea. | Los estados de GitHub e integración y el encuadre del diff. |
| Brain | Diez recuerdos confirmados y m1 seleccionado en el mapa. | Inferencias, orden de nodos y composición de la ficha. |
| Ajustes | Skills y reglas globales, con 42 asignaciones y 11 activas. | Filas de las instrucciones y catálogo del turno comparable. |

En Inicio se recuperan la retícula de proyectos y el generador de sigilos del HTML. La franja de commits usa una clase propia para que los estilos del botón de acción de la aplicación no pinten su fondo. En Studio se agrupan las coordenadas y la edición de restricciones en controles desplegables. En Entrega se usa una cabecera para el archivo y se conserva su ruta y la de origen cuando hay un renombre. Flow muestra el porcentaje del ejemplo en el inspector y Ajustes restaura los indicadores de la matriz del HTML.

La primera pasada en modo Completo encontró un viaje en el que la opacidad de Ajustes quedó por debajo de 0,99 durante la ventana de 3,5 s. También se conservó una captura anterior con el diff montado y la vista de Entrega negra. En macOS la entrada usa el mismo desplazamiento de 6 puntos, fundido y duración de 420 ms, sin aplicar un filtro a toda la capa. En tres vueltas con la ventana de desarrollo siempre visible, las 21 visitas alcanzaron la opacidad final. El p95 de los intervalos de WebKit fue de 17–18 ms y el máximo de 38 ms. La cadencia del compositor y las sesiones de varias horas quedan por verificar.

Los nueve sigilos coincidieron en los cuatro canales del lienzo, a 68 × 68 por proyecto. Las comparativas del Escritorio incluyen las dos tomas originales, montajes, superposiciones y mapas de diferencias. La aceptación de las siete vistas sigue abierta. [Mediciones de la comparación](evidencias/comparativa-wkwebview.json).

## Workspace e inspectores · segunda comparación nativa

Se amplió el recorrido a 13 estados en la misma WKWebView a 1440 × 900 y 1×. Incluye las siete vistas, la arquitectura y observación de Workspace, Dependencias en Flow, la comparación v3/v4 de Studio, el hallazgo f1 de Entrega y la agrupación de Brain. Las dos páginas se capturan con sus datos fijados antes de medir el movimiento.

- Workspace representa cadenas horizontales de Mermaid en tarjetas, usa el diff del propio mensaje para la vista previa y lee el plan y las sesiones vinculadas desde el núcleo. «Observar» abre a la derecha el historial de la sesión montada y sus cambios. El PM sigue en el panel principal. Al cerrar, regresa la disposición anterior. Los permisos se deciden en el hilo que los recibió.
- El inspector de Flow presenta alcance, candidatos, avance y eventos en la demostración. Las sesiones reales muestran el coste y el consejo del historial cuando están registrados. Entrega localiza la línea de un hallazgo sin salir del diff del archivo cambiado. Studio antepone las versiones comparadas al resto de su inspector. La ficha de Brain reúne procedencia, ámbito, uso y relaciones, y conserva la edición y la vigencia.
- Se comparan en código los nueve sigilos de Inicio, cuatro nodos de arquitectura, tres líneas del diff, tres filas de actividad, tres puntuaciones de candidatos y seis marcadores de Flow. La prueba también comprueba que «Observar» es de solo lectura, el divisor responde al teclado y el bloque de actividad conserva la altura de sus filas.
- Completo conserva la respiración, la deriva, el doble latido, el flujo y el campo. Sin ambiente conserva las señales con el campo fijo. Reducido deja las señales quietas. En tres vueltas, las 21 transiciones alcanzaron su opacidad final. Los p95 quedaron entre 17 y 18 ms. Entrega registró el único intervalo superior a 50 ms, de 66 ms. Workspace registró 19 ms de máximo.

La paridad de la superficie completa sigue abierta. Quedan diferencias de composición, datos de permisos efectivos, inferencias y estados de CI. La selección de Studio usa imágenes importadas y conserva el divisor y las protecciones. La vista previa interactiva de la referencia sigue siendo un estado distinto. [Mediciones por vista, estado y modo](evidencias/inspectores-wkwebview.json).

## Resultado por área

| Área | Referencia a 1440 × 900 | Paridad visual | Función comprobada | Pendiente para aceptar | Resultado |
| --- | --- | --- | --- | --- | --- |
| Inicio | [Original](evidencias/inicio-1440x900-artifact.png) | Retícula de 8 pt del HTML, esfera del lienzo y filas compactas, con fecha y jerarquía de acciones del export. El campo en reposo coincide píxel a píxel. | Navegación nativa, 32 repositorios Git y estado de 240 tareas desde SQLite. | Misma composición con proyectos, sesiones, actividad y atenciones equivalentes. | Abierto |
| Workspace | [Original](evidencias/workspace-1440x900-artifact.png) | Plan enriquecido, grafo en el historial local y transición de entrada. | Los ocho títulos del export y sus diez dependencias se leyeron desde SQLite. Intro selecciona la tarea en Flow. | Permisos efectivos y detalles del turno con el mismo ciclo de conversación. | Abierto |
| Flow | [Original](evidencias/flow-1440x900-artifact.png) | Se restauraron la cabecera del ejemplo, los carriles de Jev y del segundo auditor y el encuadre del export. Las posiciones de los 16 nodos y la selección de t2 coinciden con el export. [Medidas](evidencias/flow-posiciones.json). | Grafo y cambio Ejecución/Dependencias en macOS con 240 tareas. Regresiones de historial agrupado y rutas sin origen. | Misma cronología, inspector y actividad de agentes reales. | Abierto |
| Studio | [Original](evidencias/studio-1440x900-artifact.png) | Lienzo centrado, columnas de 212 y 316 pt, barra inferior y encargo en el inspector. | Cuatro PNG, seis referencias y cabecera protegida. v3 figura como aprobada y seleccionada. [Evidencia nativa](evidencias/studio-wkwebview.json). | Comparar la vista previa interactiva, la herramienta de selección y las iteraciones con sesiones reales. | Abierto |
| Entrega | [Original](evidencias/entrega-1440x900-artifact.png) | El diff unificado coloca los hallazgos abiertos de la revisión en las líneas del archivo. | WKWebView verificó ambas versiones de `git_ops.rs`, cuatro hallazgos importados y las marcas en las líneas 20 y 27. | Estados de PR, CI, permisos e integración del pipeline con una fixture común. | Abierto |
| Brain | [Original](evidencias/brain-1440x900-artifact.png) | Mapa abre una distribución radial por tipo con agrupación opcional. Se conserva la red del proyecto para explorar tareas, proyectos y PR. | Filtro SQLite antes del límite, caducidad y procedencia. Creación con teclado en Chromium. | Capturas nativas de Mapa, Foco, Índice y Contexto con todas las relaciones de la referencia. | Abierto |
| Ajustes | [Original](evidencias/ajustes-1440x900-artifact.png) | Ámbito en la navegación lateral, catálogo y duplicidades junto a la matriz. | WKWebView comprobó los siete roles, las 42 asignaciones, las 11 activas y el vínculo local a la norma. Los tres modos sobreviven a la recarga en Chromium. | Configuración de modelos, permisos y ámbito por sesión con los mismos estados del export. | Abierto |

El perfil de carga y el ejemplo de Flow son dos conjuntos de datos distintos. Las capturas completas de las siete vistas necesitan datos equivalentes de sesiones, decisiones, eventos de Jev, permisos y hallazgos.

| Comparación | Alcance | Evidencia nativa y contraste |
| --- | --- | --- |
| Workspace | Petición, texto del plan y ocho tareas del Artifact en el historial y la base local. Se verificó el salto al nodo por teclado. La pantalla de permisos en el mismo hilo sigue pendiente. | [Recorte nativo](evidencias/workspace-wkwebview-recorte.webp) · [Superposición](evidencias/workspace-superposicion.webp) · [Diferencias](evidencias/workspace-diferencias.webp) · [Fixture](evidencias/fixture-workspace.json) |
| Flow | Ocho tareas, ocho carriles y selección de t2. La cabecera, las cuotas, el inspector y la cronología aún difieren. | [Recorte nativo](evidencias/flow-wkwebview-recorte.webp) · [Superposición](evidencias/flow-superposicion.webp) · [Diferencias](evidencias/flow-diferencias.webp) |
| Studio | Panel de Git con cuatro versiones, v3 aprobada y visible, y las seis imágenes del export. El Artifact dibuja HTML interactivo y el ensayo nativo importa el mismo contenido como PNG, por eso cambia la selección disponible. | [Recorte nativo](evidencias/studio-wkwebview-recorte.webp) · [Superposición](evidencias/studio-superposicion.webp) · [Diferencias](evidencias/studio-diferencias.webp) · [Fixture](evidencias/fixture-studio/manifest.json) |
| Entrega | Texto base y final de `git_ops.rs` extraído del Artifact y reproducido en Git. Cuatro hallazgos del ejemplo recorren la importación SARIF. El identificador persiste según el contrato de auditoría. Las etapas del pipeline todavía tienen datos distintos. | [Recorte nativo](evidencias/entrega-wkwebview-recorte.webp) · [Superposición](evidencias/entrega-superposicion.webp) · [Diferencias](evidencias/entrega-diferencias.webp) · [Fixture](evidencias/fixture-entrega.json) |
| Ajustes | Matriz base de las seis skills y siete roles. El catálogo y el análisis reflejan los datos del perfil de prueba. | [Recorte nativo](evidencias/ajustes-wkwebview-recorte.webp) · [Superposición](evidencias/ajustes-superposicion.webp) · [Diferencias](evidencias/ajustes-diferencias.webp) · [Comprobaciones](evidencias/escenas-nativas.json) |

Las superposiciones y diferencias aplican el mismo recorte en ambas capturas, sin reescalar. El recorte excluye el estado de cuenta y se limita al cuerpo de la vista. Las capturas completas están en el Escritorio. Estas comparaciones muestran la colocación de elementos, el tamaño del lienzo y los pendientes de cada composición.

## Rendimiento nativo

Mismo Mac mini arm64 con 16 GiB, 1440 × 900 a 1×, mismo perfil de pruebas y mismas copias Git. La ventana de desarrollo cargó el frontend en WKWebView y ejecutó las operaciones Rust y SQLite reales. Cada copia contiene código de Filigranas extraído de `136dc6d`, historial Git local y un cambio sin commit. Flow usó 240 tareas y dependencias. La prueba abrió un PTY real, recibió salida y lo cerró sin enviar instrucciones a proveedores externos.

Los pasos fueron cinco ciclos de Inicio, Flow, Dependencias, Studio y Entrega, seguidos de navegación repetida entre Inicio y Flow con el PTY abierto. La duración indica el mínimo del tramo sostenido. Se repitieron el arranque y la secuencia de navegación con tramos de 60 y 300 segundos. El comando de salida del PTY emite 120 líneas durante el primer minuto de cada tramo.

| Sesión | Métrica | Antes | Después |
| --- | --- | ---: | ---: |
| 60 s | Arranque, mayor intervalo entre fotogramas | 2.130 ms | 92 ms |
| 60 s | Navegación, latencia p95 | 1.411 ms | 91 ms |
| 60 s | Navegación, mayor intervalo entre fotogramas | 1.374 ms | 141 ms |
| 60 s | Sostenida, latencia p95 | 1.375 ms | 102 ms |
| 60 s | Sostenida, mayor intervalo entre fotogramas | 1.397 ms | 60 ms |
| 60 s | Sostenida, intervalos de más de 100 ms | 11 | 0 |
| 60 s | Sostenida, comandos IPC | 3.330 | 39 |
| 60 s | Sostenida, commits de React | 383 | 92 |
| 300 s | Arranque, mayor intervalo entre fotogramas | 1.895 ms | 100 ms |
| 300 s | Navegación, latencia p95 | 1.414 ms | 136 ms |
| 300 s | Navegación, mayor intervalo entre fotogramas | 1.381 ms | 170 ms |
| 300 s | Sostenida, cambios de vista | 96 | 142 |
| 300 s | Sostenida, latencia p95 | 1.638 ms | 101 ms |
| 300 s | Sostenida, mayor intervalo entre fotogramas | 36.650 ms | 86 ms |
| 300 s | Sostenida, intervalos de más de 100 ms | 49 | 0 |
| 300 s | Sostenida, comandos IPC | 14.674 | 171 |
| 300 s | Sostenida, commits de React | 1.699 | 422 |

La latencia empieza en el clic automatizado y acaba al estar visible el destino y transcurrir dos callbacks de animación. Es una medida de respuesta visible y el informe guarda por separado los tiempos de cada comando. El máximo de 36,65 s se observó una vez en la sesión larga anterior y su causa concreta quedó sin atribuir. En la versión corregida aún hubo dos saltos superiores a 100 ms en la secuencia de cinco ciclos que combina Studio, Entrega y grafos. Un intervalo mediano de 17 ms equivale aproximadamente a la cadencia de 60 Hz. Los intervalos p95 y máximos detectan saltos que la mediana esconde. La cadencia de `requestAnimationFrame` mide el bucle de WebKit. La confirmación de cuadros presentados requiere instrumentación del compositor o GPU.

[Mediciones de 60 s](evidencias/rendimiento-60s-antes.json) · [60 s corregido](evidencias/rendimiento-60s-despues.json) · [300 s antes](evidencias/rendimiento-300s-antes.json) · [300 s corregido](evidencias/rendimiento-300s-despues.json).

### Repetición con el acabado actualizado

El perfil final de 60 s volvió a usar 32 réplicas y 240 tareas a 1440 × 900 y escala 1×. Se mantuvieron activos la nueva retícula, el lienzo de Inicio y el fundido con desenfoque del HTML. El p95 de navegación fue 117 ms y el p95 sostenido con el PTY fue 126 ms. Durante el tramo sostenido la mediana entre fotogramas fue 17 ms, el p95 fue 18 ms y el mayor intervalo fue 114 ms. Se registraron dos intervalos de más de 100 ms. El recorrido de cinco minutos y el de proveedores preceden a estas correcciones visuales. [Resultados del último recorrido](evidencias/rendimiento-60s-reticula-transicion.json).

### Causa y corrección

- Time Profiler de Xcode tomó una traza antes de la corrección. Se observaron 56 muestras de la pila principal con `git_log`, incluyendo actividad de creación y espera de procesos. Durante el bloqueo de arranque, Inicio pidió 90 veces cada una de cinco operaciones. El p95 de un commit de React fue 6 ms. El coste observado sitúa el atasco principal en la cola de I/O nativa.
- Inicio agrupa el resumen en una llamada. Las lecturas Git se ejecutan después de liberar SQLite con concurrencia limitada a cuatro procesos por resumen. Las lecturas Git, escaneo de proyectos y las consultas de auditoría y CI del recorrido pasan al grupo de trabajo en segundo plano.
- Flow sustituye las consultas por tarea y el sondeo periódico por un resultado agrupado y una actualización desde el evento de cambios. SQLite obtiene dependencias, esperas y sesiones en lotes. El historial de detalle conserva las referencias a memoria. La regresión prueba el límite de 30 ejecuciones recientes por tarea y el alcance de proyecto.
- Brain aplica FTS, tipo, vigencia y alcance antes de limitar la selección. La regresión usa más de 300 recuerdos y recupera un resultado anterior con acento, comprueba su caducidad y excluye resultados de otro proyecto.
- Se retiró la función ambiental sin referencias y las reglas que apagaban animaciones informativas en Sin ambiente. La actualización de ventanas cancela fotogramas pendientes. El canvas ambiental reduce el cálculo por fuente a las dos dimensiones separadas y se detiene al ocultar la ventana.

### Recursos observados y límites

En el tramo de cinco minutos, el proceso principal pasó de 4,3 % a 3,4 % de CPU mediana y de 99,41 a 102,25 MiB de RSS mediana. Los picos fueron 26,9 % y 40,4 % de CPU, y 125,86 y 114,66 MiB de RSS. La entrada del sistema incluye muestras de arranque. Las cifras corresponden al proceso de Filigranas. [Muestras resumidas](evidencias/cpu-memoria.json).

El perfil React se obtuvo insertando `Profiler` en la entrada de desarrollo. El perfilado de Instruments tomó muestras del proceso Rust. Animation Hitches llegó al límite temporal y quedó sin exportación utilizable en dos intentos. El primero coincidió con el disco lleno. Se recuperó espacio y se completaron las escenas nativas. Sigue pendiente medir con Safari Web Inspector, extraer contadores GPU y buscar fugas en los procesos de WebKit. El tramo comparable de cinco minutos usó un PTY local. El 23 de noviembre, tras obtener el permiso explícito del usuario, se hizo además una prueba nativa de concurrencia con Codex y Claude. Quedan por medir sesiones de horas y 2× Retina. El volumen de memoria muestreado en estos recorridos sirve como línea de base, con una ventana insuficiente para confirmar ausencia de fugas.

### Concurrencia con Codex y Claude

Los dos proveedores terminaron con estado `completed` y compartieron 8.391 ms de ejecución. El p95 de 42 cambios de vista durante el recorrido fue 48 ms. El p95 de los intervalos de animación fue 18 ms y el máximo 45 ms. El perfil principal registró una mediana de 4 % de CPU y de 111,36 MiB de RSS. La prueba cubre un turno por proveedor y usa un repositorio ficticio en la aplicación nativa.

Los agentes recibieron la misma ruta relativa. Cada uno partió del mismo commit, escribió una marca distinta e hizo el cambio en su propia rama. La copia original conservó la edición previa. La única aprobación individual fue el cambio sintético `Edit` solicitado por Claude. El comprobador inicial esperaba el texto `ok` para un turno terminado y se corrigió después de verificar contenido, ramas y tiempos por separado. [Resultados](evidencias/agentes-nativo.json).

## Movimiento

El inventario se extrae del CSS y JavaScript de la referencia. Los nombres de la segunda columna corresponden a la implementación o al mecanismo de la aplicación.

| Referencia | Implementación | Evidencia |
| --- | --- | --- |
| `viewIn` | `tv-viewIn` en navegador. WKWebView usa el mismo fundido de 420 ms y desplazamiento de 6 puntos que Workspace. | En 21 visitas la opacidad llegó a 0,99. El filtro de capa completa se retiró de la entrada nativa tras detectar una vista negra. |
| `spin`, `glow`, `core` | Halo de ejecución, `tv-spin`, `tv-glow`, `tv-core` | Comprobación de la activación de `tv-spin` en Ajustes. Falta prueba con proveedor activo. |
| `drift`, `thinkCore` | `tv-drift`, `tv-thinkCore` y fuente separada del PM en el canvas | Comprobación de `tv-drift` y cambios de píxel con actividad sintética. |
| `beat`, `beatHalo` | `tv-beat`, `tv-beatHalo`, doble latido de permisos | Comprobación de `tv-beat`. Falta aprobación real pendiente en Workspace. |
| `flowd`, `svgb`, `svgbeat` | `tv-flowd` para dependencias activas y Ejecución. `tv-svgb` y `tv-svgbeat` para halos del grafo | Ejecución/Dependencias se recorrieron en macOS. Falta rendimiento aislado de los halos. |
| Campo y trama de Inicio | Canvas con campo y respiración, detenidos en Sin ambiente y Reducido | Preferencias probadas por separado. Falta contraste espacial con los mismos agentes. |
| Ajuste, zoom y desplazamiento del grafo | Motor SVG compartido con transformación y transición imperativas | Cambios de lente nativos. Verificación de zoom, foco y teclado con todos los estados pendiente. |
| `tdot`, `pop`, `fade`, `toastIn`, `toastOut` | Estilos portados `tv-tdot`, `tv-pop`, `tv-fade`, `tv-toastIn`, `tv-toastOut` | La presencia de la regla no confirma su uso. Falta registrar su activación y duración con cada disparador. |

El recorrido de WKWebView detectó cambios de píxel en el canvas con actividad simulada solo en Completo. En Completo y Sin ambiente observó halo, razonamiento, doble latido y flujo activos. En Reducido quedaron inmóviles. La recarga de los tres modos y la prioridad de la preferencia del sistema pasaron en Chromium. [Resultado nativo, campo `motion`](evidencias/rendimiento-300s-despues.json).

### Retícula del campo ambiental

Los dos lienzos se compararon en la misma WKWebView a 1440 × 900 y 1×. Se fijaron Inicio, intensidad 1 y reposo. Los 1.296.000 píxeles coincidieron en los cuatro canales. El cálculo conserva el umbral Bayer, el tamaño variable de cada punto y las fuentes gaussianas del HTML. Durante 3,5 s de actividad sintética del Project manager, se registraron 210 fotogramas con p95 y máximo de 18 ms. El lienzo nativo cambió con la actividad. [Comparación y tiempos](evidencias/campo-wkwebview.json).

## Semáforo

[Regresión de la ventana nativa](../../tests/trama_semaforo.py) y [medidas](evidencias/semaforo.json). En macOS, AppKit reposicionaba los controles después de la primera corrección. Se añadió una segunda aplicación agrupada en la cola de ventana con margen de 48 ms. En 1440 × 900, 960 × 600, 1280 × 800 al volver de pantalla completa y de nuevo 960 × 600, los orígenes medidos fueron `(16,16)`, `(39,16)` y `(62,16)`, diámetro de 14 pt, separación de 23 pt. Los PNG del repositorio recortan la región medida de las capturas, para excluir el contenido del perfil. Las coordenadas se obtuvieron de las capturas completas a escala 1×. Los botones siguen siendo controles de macOS.

## Seguridad, limpieza y regresiones

- R-01. Las sesiones nuevas vinculadas a una tarea abren un worktree bajo el perfil y una rama propia desde el último commit. Se verificó la edición concurrente con Codex y Claude. Los chats generales conservan el checkout compartido y las reservas por ruta. El cierre de una sesión de trabajo y la publicación comprueban la integración de los worktrees asociados. Si hay un relevo se comprueba la huella del último titular. Una tarea aislada requiere un primer commit.
- R-02 y R-03 tienen corrección y pruebas específicas. R-05 conserva el filtro IPC por webview y la validación de rutas. El descubrimiento de proyectos excluye enlaces simbólicos y la regresión prueba el caso. Fetch y el listado de stashes validan el proyecto contra el workspace antes de invocar Git. La revisión completa de IPC privilegiado y procesos sigue abierta.
- Se retiraron la consulta de metadatos adicionales de Brain limitada a 60, el sondeo individual de Flow, la máscara que reemplazaba los puntos del Artifact y los estilos de calma obsoletos. La limpieza de rutas y componentes antiguos depende de comprobar las siete sustituciones funcionales.
- Pasaron `pnpm install --frozen-lockfile`, `pnpm build`, 5 pruebas TypeScript, 132 Rust y Clippy. Pasaron 17 recorridos en Chromium, incluida la selección por teclado en el plan de Workspace. La suite Rust conserva sus 10 pruebas ignoradas. El perfil de rendimiento se ejecutó en `tauri dev` con el perfil aislado. La instalación habitual de macOS y su base SQLite quedaron fuera de las pruebas.

## Reproducción

1. Crear un directorio constante bajo un temporal con prefijo `trama-perfil-`. Extraer `git archive 136dc6d src src-tauri/src package.json pnpm-lock.yaml` a un repositorio de origen y crear un commit inicial. Crear otros 19 commits sobre un archivo de fixture. Clonarlo como `fixture-00` a `fixture-31` en un subdirectorio `repos` y dejar un cambio seguido sin commit en cada copia.
2. Abrir una vez el perfil de desarrollo `com.filigranas.ide.perf-trama-v2`, seleccionar `repos` como raíz y cerrar la ventana. El primer recorrido guarda las 240 tareas en `fixture-00` con los comandos normales de SQLite. Reutilizar ese perfil aislado al medir ambas revisiones y evitar que las dos se ejecuten a la vez.
3. Tras `pnpm install --frozen-lockfile`, iniciar [el servidor de prueba](../../tests/trama_perfil.mjs) con `FILIGRANAS_PERFIL_RESULTADO` apuntando a un archivo JSON nuevo en el temporal. `VITE_TRAMA_SECONDS=300` amplía el tramo sostenido. `VITE_TRAMA_MOVIMIENTO=1` añade el recorrido de movimiento tras medir. `VITE_TRAMA_STUDIO=1` carga y comprueba la fixture del Studio en `fixture-30`.
4. Desde el repositorio, ejecutar el desarrollo de Tauri con configuración `{"identifier":"com.filigranas.ide.perf-trama-v2","build":{"devUrl":"http://127.0.0.1:14572/__trama_nativo","beforeDevCommand":null}}`, usando `--no-watch`. La captura de semáforo toma el PID de esa ventana de desarrollo, con permisos de Accesibilidad y Grabación de pantalla.
5. Para Entrega y Ajustes, usar `FILIGRANAS_TRAMA_SCENES=1` y `VITE_TRAMA_SCENE_ROOT` con ruta `/private/tmp/trama-escenas-…/repos`. Crear `filigranas-ide` en esa raíz, confirmar los textos `before` de la fixture y guardar `after` como cambios de trabajo. Incluir en `AGENTS.md` un enlace a `semaforo-macos.md`. El servidor sirve las escenas a `com.filigranas.ide.trama-escenas`. La salida marca los momentos de captura. Con `VITE_TRAMA_WORKSPACE=1`, el recorrido espera que el perfil contenga las tareas y el historial local del manifiesto de Workspace.
6. La prueba de agentes usa `FILIGRANAS_TRAMA_AGENTS=1`, `VITE_TRAMA_AGENT_ROOT` con ruta `/private/tmp/trama-agentes-…/repos` y el perfil `com.filigranas.ide.trama-agentes`. Crear un único repositorio `trama-agentes-fixture` con `marca.txt` confirmado como `TRAMA-BASE` y una edición en la copia inicial a `TRAMA-LOCAL`. El recorrido envía un mensaje a cada proveedor autenticado con alcance tal como se describe arriba.
7. Ejecutar `tests/auditoria_trama_browser.py --channel chrome --app URL_DEL_SERVIDOR` para comprobar la persistencia al recargar y los flujos independientes. Usar `design/trama-v2/parity.py --reference-only` para validar los hashes de la referencia y reproducir sus capturas. Con `--section studio --width 1440 --studio-fixture CARPETA` se extraen los contenidos del lienzo y las seis referencias.

8. Para comparar el campo en la misma WKWebView, usar `FILIGRANAS_TRAMA_FIELD=1` y el perfil de escenas. El servidor toma el lienzo de la aplicación y después abre una página de prueba basada en el HTML canónico. El hook conserva el dibujo original y añade la comparación. Los lienzos se cotejan sin reescalar.


9. Para repetir las siete comparativas, usar el perfil de escenas del paso 5, `FILIGRANAS_TRAMA_COMPARATIVAS` con una carpeta temporal vacía y `FILIGRANAS_PERFIL_RESULTADO` apuntando a `escena.json` dentro de esa carpeta. Con el servidor activo, ejecutar `python tests/trama_comparativas.py --prepare "$VITE_TRAMA_SCENE_ROOT"` para añadir los demás repositorios sintéticos. Mantener a la vista la ventana de 1440 × 900. Se puede fijar temporalmente `alwaysOnTop: true` en la configuración de desarrollo. Ejecutar `python tests/trama_comparativas.py --pid PID --output "$FILIGRANAS_TRAMA_COMPARATIVAS"` para capturar ambos recorridos y verificar los sigilos y la opacidad final. `--verify` comprueba los informes ya capturados.


10. Para preparar Workspace y Observación, regenerar `fixture-workspace.json` con `design/trama-v2/parity.py --reference-only --section workspace --width 1440 --workspace-fixture ARCHIVO`. Al preparar los repositorios, `--workspace-db` admite la base existente del perfil aislado de escenas. Comprueba las ocho tareas antes de guardar el historial y enlazar las sesiones de prueba. El perfil no necesita enviar turnos a un proveedor durante este recorrido.
