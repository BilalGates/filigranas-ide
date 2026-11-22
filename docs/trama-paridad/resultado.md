# Trama v2 · resultado de integración

22 de noviembre de 2026 · rama local `codex/trama-v2-integracion` sobre `main` (`924f542`). La rama original `feat/trama-v2` conserva sus nueve commits, hasta `683a52c`. Cambios de implementación en `ca6681a` y `2b67c63`.

## Hecho

- Recuperada la integración previa de Inicio, Workspace, Flow, Studio, Entrega, Brain y Ajustes sobre los proveedores, IPC y datos del IDE. La rama conserva el CSS original de V2 y las comparativas históricas. El HTML adjunto incluye las siete vistas. Su CSS incrustado difiere de los dos estilos V2 archivados en la rama.
- **Marco.** La cabecera recupera proyecto, rama, búsqueda de órdenes y estado de agentes con accesos a proyectos y Flow. La barra inferior muestra rama, sincronización y actividad a la izquierda, y Jev y las cuotas reales a la derecha. En la esquina superior derecha, Atención queda al final junto a Agentes. Navegador y perfil de GitHub siguen accesibles. WKWebView usa una transición de opacidad y desplazamiento.
- **Inicio y Workspace.** Retomar espera a que termine la carga de sesiones del proyecto destino y mantiene la conversación elegida. Inicio excluye proyectos archivados de esa acción.
- **Entrega.** Cambios usa las filas de archivo del diseño V2 y deja el diff unificado de Monaco en el centro. El cálculo acotado usa las dos versiones del fichero sin esperar al worker de la vista de comparación. Rama reúne el historial y los controles Git reutilizados. El alcance conserva el worktree del diff y descarta respuestas antiguas al cambiar de alcance. Tests refleja ejecuciones de pruebas registradas como tales.
- **Brain.** Retirados el panel lateral inaccesible, sus tres componentes sin referencias, su CSS y la orden duplicada de la paleta. El destino restante permite crear y editar memoria global sin proyecto y corregir recuerdos desde su proyecto de origen. Recupera alcance de tarea, fuente de tarea o turno, fecha local con hora, encargo de vista previa, búsqueda sin tildes y filtros por proyecto y rango de fechas inclusivo. Guardar exige confirmar la versión actual del formulario y compartir con agentes requiere marcar la opción.
- **Capturas.** El script acepta el export completo como entrada y puede generar montajes y diferencias de píxel. Carga las fixtures exclusivamente en el servidor de desarrollo de Chromium. El bundle macOS de pruebas usa SQLite y un repositorio Git temporal con su propio identificador.

## Verificado

| Comprobación | Resultado |
| --- | --- |
| `pnpm install --frozen-lockfile --offline`, `pnpm build`, `pnpm typecheck` | Correctos. Instalación desde la caché local |
| `pnpm test` | 5 correctas |
| `cargo test --locked --offline` | 123 correctas y 10 ignoradas. El bloqueo de perfil requirió la ejecución con permiso para el bloqueo de archivos de macOS |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | Correcto |
| [Regresiones de Chromium](../../tests/trama_browser.py) | Retomar sesión, crear y corregir memoria global, renovar confirmación, diff central, filtros de proyecto y fechas, auditoría, revisión del push simulado diff del worktree de sesión, barra inferior y accesos de la esquina derecha |
| Chromium a 1600 × 900, 1440 × 900, 1280 × 800, 1050 × 720 y 820 × 600 | 40 pares de capturas con el HTML adjunto y Filigranas, con movimiento reducido y sin excepciones JavaScript en Filigranas. Los datos de ambos lados difieren. [Evidencias](README.md) |
| WKWebView macOS 27.2.1, perfil aislado, 1440 × 900 | Se recorrieron las seis vistas y Ajustes. Monaco leyó el archivo temporal, el terminal ejecutó `printf` en `zsh`, Flow marcó la demo y deshabilitó acciones, Entrega cargó el diff Git real y Brain persistió en SQLite un recuerdo privado con su fuente. En el bundle final se vieron las líneas añadidas con movimiento completo. Se comprobó el contador de Jev, su menú y la esquina derecha. [Comparativa del marco](marco-1440x900.webp). El semáforo nativo se observó en capturas sin el indicador de compartir ventana |

## Auditoría y trazabilidad

**A** vigente · **B** interfaz por reemplazar · **C** obsoleta confirmada · **D** requiere migración o verificación adicional.

| Funcionalidad anterior | Destino Trama | Backend reutilizado | Estado y verificación |
| --- | --- | --- | --- |
| Proyectos y sesiones recientes | Inicio · Retomar y proyectos | `get_workspace`, `session_list`, tareas y sesión compartida | A · restauración en Chromium y apertura nativa |
| Conversaciones, permisos y herramientas de código | Workspace | IPC de sesiones, agentes, archivos, diffs y PTY | A/B · archivos, Monaco y terminal nativos. Permisos y turnos autenticados pendientes en esta rama |
| Tareas, dependencias, agentes y Jev | Flow · Ejecución, Dependencias y Lista | `tasks_list`, `task_runs`, sesiones | A/B · grafo demo nativo y fixtures. Verificación autenticada de Jev pendiente |
| Diseño, regiones, versiones y aprobación | Studio | `design_*`, sesión de Claude | A · comparador y lienzo de variantes verificados en la app aislada. Studio conserva el generador y la referencia de barra lateral |
| Git, historial, operaciones y Larry | Entrega · Cambios, Rama y Commit | `git_*`, `git_review_push`, `larry_*` | A/B · diff Git nativo y revisión simulada. Workspace aún ofrece Cambios y Rama conserva controles compartidos del GitPanel |
| PR, checks, auditoría e integración | Entrega · PR, CI, Tests e Integración | `pr_*`, `health_*`, `session_integrate*`, `work_session_*` | B · evidencias simuladas. Aprobación remota y ramas históricas aún por verificar |
| Panel lateral y orden duplicada de Brain | Brain · Mapa, Foco, Índice y Contexto | `brain_graph`, `brain_search`, `brain_entry`, `brain_save`, `brain_forget`, `brain_preview`, `brain_links` | C para cableado retirado. A para alta, edición, origen y ámbito; pruebas nativa y Chromium |
| Topología histórica de Brain y exploración directa de nodos de proyecto, tarea y PR | Brain | `brain_graph`, apertura de PR del sistema | A · red radial, inspector y apertura de tarea comprobados en macOS. Navegación entre tarea y PR comprobada con datos simulados |
| Proveedores, Jev, skills, permisos, uso y preferencias | Ajustes y utilidades globales | `tools_*`, `jev_*`, `skills_list`, cuotas | A · herramientas y presupuestos en Ajustes verificados en macOS. Catálogo real de skills disponible |

## Pendiente

- El HTML adjunto es ejecutable y sirvió para la comparación. Queda por confirmar si contiene la revisión exacta que generó las comparativas históricas de V2. Su estilo incrustado difiere de los archivos V2 guardados. Falta alinear datos y estados, comprobar las interacciones a ese nivel y repetir las capturas antes de aceptar paridad.
- Faltan la consolidación de Git fuera de Workspace y el reemplazo de controles heredados en las etapas de Entrega.
- Falta medir el semáforo tras redimensionar y salir de pantalla completa, comprobar más tamaños nativos y medir animaciones con Monaco y agentes en actividad. El manifiesto nativo fija 960 × 600 como mínimo. La prueba de 820 × 600 se hizo en Chromium. Quedan pendientes Windows y la regresión autenticada de agentes, permisos, Jev, publicación e integración.

## Continuación · Workspace, Studio, Ajustes y Brain

La comparación usa `Filigranas · Trama.html` como referencia. [1440 × 900](continuacion-1440x900.webp) · [1050 × 720](continuacion-1050x720.webp) · [Registro](continuacion-capturas.json). Las ocho parejas usan el HTML a la izquierda y Filigranas en Chromium con datos simulados a la derecha. Las conversaciones, las pantallas capturadas y los recuerdos son distintos en ambas fuentes.

- **Workspace.** Las disposiciones están accesibles al abrir un proyecto, incluso antes de iniciar una conversación. El editor recupera la banda de cambios del HTML. Lee el checkout o el worktree del archivo abierto, abre sus diffs y conserva el alcance al saltar a Entrega. El panel Git avanzado sigue disponible para rama, historial, revisión y comandos existentes.
- **Studio.** Retirado Design Loop como panel lateral y su segunda implementación de capturas. Studio reúne pantallas, versiones y el editor de variantes de barra lateral. Conserva anchos y altos personalizados, notas, regiones numéricas, comparación por región y apertura de sesión Claude. Se pueden comparar versiones del mismo tamaño. La aprobación mantiene la confirmación explícita y funciona desde la primera captura.
- **Ajustes.** Herramientas y consumo usan el marco de Ajustes y reutilizan la actualización de CLI, inicio de sesión, enrutamiento de Jev y lectura de cuotas. Skills conserva el catálogo real. La matriz por rol se documenta en la continuación de Studio y Ajustes.
- **Brain.** Mapa conserva los grupos de recuerdos y añade una red radial con nodos de proyecto, recuerdo, tarea y PR. Los tipos, fechas y texto filtran el grafo real. Los nodos relacionados siguen accesibles en el inspector. Las tareas abren su ficha en Workspace y las PR usan la apertura del sistema. Los recuerdos conservan corrección, procedencia y foco.

Se verificaron instalación congelada, compilación, TypeScript, cinco pruebas unitarias y ocho recorridos Chromium. El recorrido simulado cubre comparar una región, confirmar una captura, abrir el lienzo de variantes, navegar por conexiones de tarea y PR, consultar herramientas y presupuestos y pasar del editor a Entrega. Las pruebas visuales comparan composición y controles con datos de ejemplo diferentes.

En macOS 27.2.1 se abrió el bundle Tauri con un perfil aislado. Workspace mostró el README y su cambio Git real y abrió el diff en Entrega. Studio cargó las dos versiones PNG del perfil de prueba, mostró el divisor antes y después y abrió el lienzo de variantes. Ajustes mostró el estado de las CLI, controles de Jev y presupuestos. En Brain se siguió el enlace de un recuerdo a una tarea y se abrió la tarea en Workspace.

## Continuación · Componentes, referencias y skills por rol

- **Selección de Studio.** Las nuevas capturas en Chrome guardan los elementos visibles, sus selectores, dimensiones y radio junto con el PNG. Se puede elegir desde el lienzo con la herramienta Seleccionar o desde el inspector. Al proteger un componente se conserva su selector y se usa su posición en cada nueva captura cuando vuelve a aparecer. Las versiones previas y los PNG importados admiten selección por región.
- **Referencias de Studio.** Cada pantalla guarda sus referencias PNG, JPEG, WebP o GIF. Se pueden previsualizar y marcar para un encargo. La confirmación indica cuántas imágenes se adjuntarán. El encargo comprueba que pertenezcan a la misma pantalla y que la sesión Claude sea del mismo proyecto. Los chats de Studio siguen el reparto y la carpeta que Filigranas asigna a su sesión de trabajo.
- **Skills y reglas.** La matriz permite activar las skills incluidas por rol en todo el IDE y definir excepciones heredables por proyecto. El PM toma su rol del coordinador. Las conversaciones nuevas de Studio empiezan como Diseñador, las demás como Senior y Ajustes permite cambiarlo. El catálogo de Filigranas se calcula para cada turno. Las reglas generales y las del repositorio se mantienen vigentes.

En macOS 27.2.1, con el perfil aislado, Studio capturó una página local de 1440 × 900. Al pulsar el botón de la página mostró su nombre, `#confirmar` y el radio de 18 px. Se guardó la protección, se importó un PNG desde el selector de archivos de macOS, se abrió la vista previa y se marcó la imagen para un encargo. La confirmación indicaba una referencia y el botón de envío quedaba desactivado hasta completarla. Se creó una conversación Claude con rol Diseñador. Se probó desactivar su skill de diseño en global, habilitarla para el proyecto y volver a heredar. El cambio global, la protección y la referencia siguieron disponibles tras reiniciar.

Pasaron la instalación congelada, la compilación del bundle, cinco pruebas de TypeScript, diez recorridos Chromium y 125 pruebas Rust. La suite Rust comprobó el catálogo efectivo y el contenido de las referencias al preparar el envío. La prueba con Chrome instalado leyó el PNG y los elementos de la misma página local. En Windows continúa disponible la captura y la selección por región.

### Recepción de imágenes en Claude autenticado · 22 de noviembre de 2026

Se probó el bundle de `ebeb6e9` en macOS 27.2.1 con el perfil aislado y una sesión de trabajo activa en un repositorio temporal. En Studio se seleccionó una captura de Chrome de 1440 × 900, se marcaron dos referencias PNG de ejemplo y se dejó una tercera desmarcada. El botón de envío se habilitó tras confirmar «Enviar captura y protecciones con 2 referencias».

Claude Code completó el turno con Opus 5.5. Identificó tres imágenes, transcribió «Página de prueba» y «Confirmar diseño QA» de la captura y leyó los códigos `B39GWW5` y `9YKED82` de las dos láminas en orden. Los códigos solo figuraban en las imágenes. Los SHA-256 de los tres bloques de imagen del transcript coincidieron con la captura y las referencias seleccionadas. La referencia desmarcada quedó fuera. El turno no registró llamadas a herramientas.

### Marco y cuotas por motor · 22 de noviembre de 2026

Se incorporó el cambio de interfaz de `d8fc11d`. El selector de proyecto y el de rama ocupan la cabecera. El navegador y GitHub pasan a la columna de destinos, mientras que Agentes y Atención conservan su sitio en la esquina superior derecha. La barra inferior mantiene actividad, terminal y Jev. Cada motor tiene un acceso de cuota con las sesiones y el trabajo registrado en tareas de los últimos siete días. La sesión autenticada de Studio descrita arriba se probó antes de este cambio de marco.
