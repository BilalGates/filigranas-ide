# Plan de implementación — Filigranas IDE

**Estado:** entrega 1 en curso · **Plataformas:** macOS (prioridad) y Windows, desarrollo en ambas · **Fecha:** 2026-11-16  
**Referencia visual:** [mockup v2](https://claude.ai/artifact/JxK8TYzEXneM6Ca1Wr476L) (estética de terminal, ultra minimalista). [`docs/mockup.html`](docs/mockup.html) queda como primera versión. Los mockups usan datos de ejemplo y no ejecutan agentes ni comandos.

## 1. Resultado esperado

Una aplicación de escritorio para desarrollar en los repositorios de `~/repositorios` con una conversación coordinadora por proyecto, varias sesiones de agentes y ramas activas a la vez, editor y terminal, control de Git y creación de pull requests. La primera versión funciona con Codex, Claude Code, OpenCode, Antigravity y Devin instalados localmente. Filigranas viene incluida en la aplicación y no modifica un repositorio solo por abrirlo.

El usuario selecciona una carpeta raíz de proyectos en el primer arranque; `~/repositorios` es la propuesta inicial, no una ruta fija. La aplicación descubre repositorios Git hijos directos y observa altas, renombres y bajas. Una carpeta nueva aparece sin reiniciar. Archivar un proyecto solo lo oculta de la lista activa; nunca borra ni mueve su carpeta.

## 2. Interfaz y comportamiento

- **Columna izquierda:** grupos plegables de proyectos, contador, búsqueda, grupo «Sin clasificar» y sección «Archivados». Proponer grupos por contexto o tipo (Asserta, Webs, Aplicaciones, Herramientas), permitir crear/renombrar grupos y mover proyectos manualmente. La elección manual prevalece sobre cualquier sugerencia automática. Al seleccionar un proyecto, mostrar su árbol de archivos y abrirlos en el editor.
- **Centro:** editor de código y conversación visibles lado a lado; terminal ajustable debajo. El editor se puede minimizar para dar todo el ancho a la conversación. El coordinador es la pestaña fija de cada proyecto y abre el checkout principal. Cada tarea abre una pestaña con el nombre de su agente, motor y estado. Editor y terminal siguen la copia de trabajo de la pestaña seleccionada.
- **Controles de sesión:** en la cabecera de cada conversación, siempre visibles: motor actual con acceso al handoff (lista de motores con su cuota; los que no tienen cuota, desactivados), nivel de rendimiento (bajo, medio, alto, máx; se traduce al parámetro de esfuerzo o modelo de cada proveedor cuando lo admite) y tokens o cuota restantes. La cuota también aparece en la barra de estado.
- **Derecha:** rama actual y destino, archivos modificados, diffs, y gráfico de ramas locales y remotas conocidas. El botón de commits (Larry) va justo encima del gráfico y se desactiva sin cambios. «Crear pull request» solo aparece cuando la rama de la tarea está lista para revisar y aún no tiene PR. Mostrar los conflictos pendientes de cada tarea.
- **Persistencia:** tras reiniciar, recuperar grupos, proyectos archivados, tareas, relación con sesiones de proveedor y ramas. No importar las sesiones antiguas de MonoCode u otras aplicaciones en la primera versión.
- **Estados visibles:** inactiva, en marcha, esperando permiso, pausada por cuota, fallida, lista para revisar, integrada. Las acciones que no estén disponibles para un proveedor se muestran desactivadas con su motivo.
- **Identidad (Barça):** paleta blaugrana: negro azulado de base, rojo como acento, azul para estados y dorado para «esperando permiso». Tipografía monoespaciada (Geist Mono) en toda la interfaz, sin textos ni elementos superfluos. En macOS, paneles con vibrancy nativa; en Windows, Mica/Acrylic.
- **Coordinadores:** el coordinador de cada proyecto se elige entre Hansi Flick (directo y eficaz, por defecto), Pep Guardiola (perfeccionista y controlador), Luis Enrique (innovador, identidad propia) y Johan Cruyff (completo, el mejor en todos los terrenos). Cada uno es un perfil de instrucciones sobre el mismo motor de coordinación: cambia el tono, el nivel de control y el criterio de delegación, no las capacidades.
- **Agentes:** cada sesión nueva recibe el nombre de un futbolista histórico del Barça (xavi, iniesta, puyol, messi, ronaldinho, kubala, koeman, stoichkov, laudrup, rivaldo, busquets…), sin repetir entre las sesiones activas de un proyecto. El nombre identifica la sesión en pestañas, conversación y relevos; el motor se muestra aparte.

## 3. Arquitectura y contratos internos

- **Aplicación:** Tauri 2. Núcleo en Rust; interfaz en TypeScript + React dentro del WebView del sistema (WKWebView en macOS, WebView2 en Windows), sin Chromium empaquetado. Monaco para el editor y xterm.js para la terminal, con `portable-pty` (ConPTY en Windows). El núcleo administra archivos (`notify`), Git (`gix`, con la CLI `git` para operaciones de escritura), procesos de agentes y credenciales delegadas a las CLI existentes. La interfaz no ejecuta comandos ni accede directamente al sistema de archivos: solo comandos y eventos Tauri tipados, delimitados por proyecto/tarea, con los permisos (capabilities) mínimos.
- **Eficiencia:** objetivo de app ligera: instalador de pocas decenas de MB, arranque rápido y RAM en reposo baja. Vigilar solo las carpetas abiertas, calcular diffs y gráfico bajo demanda, y no bloquear nunca el hilo de la interfaz.
- **Multiplataforma:** rutas a través de los directorios de datos del sistema (Application Support en macOS, `%APPDATA%` en Windows), nunca rutas fijas. Las diferencias de plataforma (vibrancy, shell por defecto, empaquetado) quedan aisladas en módulos propios.
- **Datos locales:** SQLite (`rusqlite`) en el directorio de datos de la app para ajustes, grupos, proyectos, tareas, ramas de trabajo, IDs de sesiones y eventos resumidos. Guardar referencias a credenciales, nunca tokens. La carpeta raíz seleccionada y las copias de trabajo se validan por ruta canónica antes de operar.
- **Adaptadores de agentes:** interfaz común `start`, `send`, `stream`, `approve/deny`, `interrupt`, `resume`, `status` y `dispose`. Codex usa `app-server`; Claude Code usa su salida estructurada en streaming; OpenCode, Antigravity y Devin usan ACP. Cada adaptador traduce eventos nativos a mensajes, llamadas de herramienta, peticiones de permiso, uso/cuota y errores. Las CLI mantienen su autenticación habitual; el IDE muestra el paso de inicio de sesión cuando falte.
- **Filigranas:** incluir una versión del kit en el paquete de la app. Hansi usa sus roles y criterio de delegación; cada sesión recibe las reglas pertinentes y las instrucciones propias del proyecto, con prioridad para estas últimas. El kit incluido se actualiza al publicar una versión de la app. No instalar `.agents`, hooks ni otros archivos en los repositorios detectados.
- **Coordinación:** una conversación persistente del coordinador por proyecto. Cada encargo crea una tarea con objetivo, criterios de terminado, motor/rol elegidos, rama de origen y rama de trabajo. El coordinador explica su elección y puede abrir sesiones adicionales; los permisos de escritura siguen pasando por el mecanismo del proveedor y se muestran en el IDE.

## 4. Ramas, handoff y Git

- **Paralelismo:** cada tarea que escribe recibe su propia rama `ide/<tarea>-<id>` y un worktree bajo Application Support, fuera de la carpeta raíz de proyectos. Dos agentes pueden trabajar en el mismo proyecto sin compartir árbol de archivos. El gráfico incluye esas ramas, pero los worktrees no aparecen como proyectos. Una tarea parte del último commit de la rama de origen; si el checkout principal tiene cambios sin commit, avisar de que no se incluyen automáticamente.
- **Handoff:** generar un relevo verificable con objetivo, decisiones, rama/worktree, diff y commits, pruebas y resultados, bloqueos, próximos pasos y referencias a sesiones. El nuevo motor continúa en el mismo worktree, sin copiar razonamiento privado ni suponer que puede reabrir la sesión de otro proveedor. Registrar origen y destino del relevo.
- **Cuota y reanudación:** cuando el proveedor informe de un límite, pausar la tarea y conservar worktree y sesión. Permitir pausa manual si el límite no se puede detectar. «Retomar» intenta reabrir la sesión nativa; si no es posible, crea una nueva sesión del mismo motor usando el relevo. También se puede hacer handoff a otro motor. Nunca eliminar una tarea pausada por falta de cuota.
- **Larry:** en la rama seleccionada, proponer grupos por unidad funcional con el script de Filigranas incluido, revisar los diffs dudosos, mostrar el plan y crear commits locales con rutas explícitas. Larry no hace push, merge, rebase ni descarta cambios. Si un hook modifica archivos o falla, detenerse y mostrar el estado.
- **Integración:** mostrar diff y commits de cada rama de tarea frente a su destino. La acción del usuario aplica la integración guiada; ante conflictos, preservar rama y worktree y abrir la resolución en el editor. Limpiar el worktree solo tras integración completa y confirmada, nunca si queda trabajo sin guardar.
- **Pull requests:** los repositorios actuales usan GitHub; en V1, soportar GitHub mediante la autenticación local de `gh`. Desde una rama de tarea, elegir base, revisar título/descripción generados a partir de commits y pruebas, optar por borrador o lista para revisión y publicar mediante una acción explícita. El push y la apertura de la PR son independientes de Larry. Mostrar URL, estado y checks; el merge queda en manos del usuario.

## 5. Entregas de implementación

1. **Base de la aplicación:** estructura Tauri/React, ventana translúcida en macOS y Windows, persistencia, selección de carpeta, detección de repositorios, grupos, archivo/restauración y navegación de archivos. El mockup es la referencia visual; adaptar sus datos ficticios a datos reales.
2. **Editor y Git local:** Monaco, PTY, estado/diffs, selección de rama, gráfico e historial. Probar apertura de proyectos grandes y cambios externos de archivos.
3. **Sesiones y coordinación:** adaptadores de los cinco motores, Hansi por proyecto, streaming, permisos, cancelación, persistencia y recuperación tras reinicio.
4. **Trabajo paralelo:** creación de ramas/worktrees aislados, handoff entre motores, pausa por cuota, reanudación e integración guiada.
5. **Cierre de tareas:** Larry, generación de commits por unidad funcional, publicación de rama y creación/seguimiento de PR en GitHub. Empaquetar la app instalable para macOS (.dmg) y Windows (.msi).

## 6. Comprobaciones de aceptación

- La app detecta los 12 repositorios existentes y uno nuevo sin reiniciar; agrupar, archivar y restaurar no mueve ni borra carpetas.
- Editor y terminal operan en la ruta que muestra la sesión activa; al cambiar de tarea no se mezclan archivos ni procesos.
- Cada uno de los cinco motores puede iniciar una sesión, enviar y recibir eventos, pedir permisos, interrumpirse y recuperar trabajo según su capacidad; un error de autenticación queda visible y recuperable.
- Dos agentes editan a la vez ramas distintas del mismo proyecto. Un handoff a otro motor conserva los cambios y el contexto de tarea. Una tarea pausada por cuota sobrevive a reinicio y se puede retomar.
- La integración sin conflictos aplica solo los commits elegidos; con conflictos conserva ambas ramas y permite resolverlos sin perder cambios.
- Larry separa cambios independientes, no incluye archivos ajenos y no hace push. Una PR se abre únicamente tras la acción explícita del usuario, con base y contenido revisados.
- La interfaz funciona en tema claro y oscuro, con teclado, foco visible y movimiento reducido. Las operaciones lentas no bloquean el editor.

## 7. Límites de la primera versión

macOS (prioridad) y Windows; solo GitHub. Las CLI y sus cuentas deben estar instaladas/autenticadas por el usuario. La detección de cuota depende de la información que entregue cada proveedor; siempre existe pausa manual. El historial antiguo de MonoCode y de otras aplicaciones permanece donde está. Los grupos iniciales son sugerencias editables: la aplicación no asume que un repositorio pertenece a una organización solo por su nombre.
