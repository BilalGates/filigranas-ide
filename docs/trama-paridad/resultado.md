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
| Diseño, regiones, versiones y aprobación | Studio | `design_*`, sesión de Claude | A/B · lienzo nativo en reposo y capturas en Chromium. Design Loop lateral conserva el generador y la referencia de barra lateral |
| Git, historial, operaciones y Larry | Entrega · Cambios, Rama y Commit | `git_*`, `git_review_push`, `larry_*` | A/B · diff Git nativo y revisión simulada. Workspace aún ofrece Cambios y Rama conserva controles compartidos del GitPanel |
| PR, checks, auditoría e integración | Entrega · PR, CI, Tests e Integración | `pr_*`, `health_*`, `session_integrate*`, `work_session_*` | B · evidencias simuladas. Aprobación remota y ramas históricas aún por verificar |
| Panel lateral y orden duplicada de Brain | Brain · Mapa, Foco, Índice y Contexto | `brain_graph`, `brain_search`, `brain_entry`, `brain_save`, `brain_forget`, `brain_preview`, `brain_links` | C para cableado retirado. A para alta, edición, origen y ámbito; pruebas nativa y Chromium |
| Topología histórica de Brain y exploración directa de nodos de proyecto, tarea y PR | Brain | `brain_graph`, apertura de PR del sistema | D · faltan capacidades de exploración de la topología anterior. Los componentes retirados siguen recuperables en el historial Git |
| Proveedores, Jev, skills, permisos, uso y preferencias | Ajustes y utilidades globales | `tools_*`, `jev_*`, `skills_list`, cuotas | B · navegación nativa. Quedan componentes compartidos con estilo heredado |

## Pendiente

- El HTML adjunto es ejecutable y sirvió para la comparación. Queda por confirmar si contiene la revisión exacta que generó las comparativas históricas de V2. Su estilo incrustado difiere de los archivos V2 guardados. Falta alinear datos y estados, comprobar las interacciones a ese nivel y repetir las capturas antes de aceptar paridad.
- Faltan la consolidación de Git fuera de Workspace, el reemplazo de controles heredados en las etapas de Entrega, la migración de la topología restante de Brain, Design Loop lateral y las superficies secundarias de Ajustes. Studio sigue pendiente de referencias adjuntas y de selección semántica de componentes. Las capturas de Studio son imágenes y se pueden marcar regiones.
- Falta medir el semáforo tras redimensionar y salir de pantalla completa, comprobar más tamaños nativos y medir animaciones con Monaco y agentes en actividad. El manifiesto nativo fija 960 × 600 como mínimo. La prueba de 820 × 600 se hizo en Chromium. Quedan pendientes Windows y la regresión autenticada de agentes, permisos, Jev, publicación e integración.
