# Aceptación de V1 y puerta de V2

18 de noviembre de 2026 · macOS arm64 · base local `5d8f4cc`. El commit de Windows `5499d61` de `origin/main` queda fuera de esta ejecución. La compilación del árbol de trabajo incluyó dos cambios locales previos de guardado (`src/Editor.tsx` y `src-tauri/src/files.rs`), que se revisan por separado de P0.

## Inventario

| Área | Implementación y puntos de extensión |
| --- | --- |
| Espacio de trabajo y escritorio | `src/App.tsx`, `Editor.tsx`, `Terminal.tsx`, `GitPanel.tsx` e `ipc.ts` llaman a `workspace`, `files`, `watch`, `pty`, `git`, `git_ops` y `containers`. Git usa la CLI del sistema. `window.rs`, la configuración Tauri y [la referencia aprobada](referencias/semaforo-macos.png) fijan el semáforo. |
| SQLite | `db::open` usa WAL y activa claves foráneas. Crea `settings`, `groups`, `projects`, `sessions` y `container_links`. `migrate` añade columnas por introspección, sin `user_version` ni borrado de datos. `projects` guarda hilo, perfil y versión de herramientas. `sessions` guarda IDs de proveedor, rama, worktree, base, encargo, relevo, huella de integración, pausa y opciones. |
| Coordinación | `Coordinator.tsx`, `codex.rs` y `delegate.rs`. Un hilo `app-server` por proyecto, cuatro perfiles y tres herramientas de delegación. Hay sesiones ejecutoras persistentes, pero faltan el registro de tareas padre, el DAG y el relevo del coordinador que describe la política de V1. |
| Ejecutores y continuidad | `Session.tsx`, `claude.rs` (stream JSON), `acp.rs` (OpenCode, Antigravity y Devin), `tracker`, `isolate` y `handoff`. Los repositorios sin commits se abren sin worktree aislado. Un relevo cambia de sesión ejecutora conservando la copia de trabajo. El código intenta reanudar al proveedor, sin recuperación universal de un transcript que ya no existe. |
| Herramientas y permisos | `tools.rs` inspecciona CLI y autenticación. Codex usa `workspace-write` y `on-request`. Claude y ACP reenvían solicitudes del proveedor. Las rutas de IPC se validan en Rust. La aprobación de publicación de PR en V1 es la confirmación del panel; no existe un flujo de merge en GitHub dentro de la app. |
| Larry y GitHub | `larry.rs` y el script incluido agrupan y validan; Codex redacta con esquema JSON y hay salida determinista si falla. P1 trasladó la skill original de Larry a [la referencia de GitHub](../src-tauri/resources/skills/github-flow/references/larry.md). `pr.rs` y `Publish.tsx` preparan el borrador, ejecutan `git push` y `gh pr create` tras confirmación y consultan estado/checks. Aún no hay vínculo con tareas e Issues ni estado de protección de rama. |
| Instrucciones y skills | `AGENTS.md` protege el semáforo. La política y los cuatro perfiles se incluyen desde `resources/coordinadores`; Claude tiene su prompt de ejecución en `claude.rs`. Larry es la única skill incluida en V1. El prompt histórico de TypeSafe en [la política del coordinador](coordinador-codex.md) no configura una API ni habilita Jev. |
| Pruebas | Rust tiene pruebas locales en los módulos y seis pruebas de CLI/motores marcadas `#[ignore]`. `npm run build` ejecuta TypeScript y Vite. No hay un script npm de lint ni una suite React automatizada en esta base. La [validación anterior](validacion-macos-2026-11-17.md) corresponde a otra compilación. |

## Escenarios de regresión

| Escenario | Evidencia |
| --- | --- |
| Arranque nativo y descubrimiento | Bundle temporal macOS con identificador `com.filigranas.ide.p0`, firmado ad hoc. Ventana `tauri://localhost`, vista del proyecto Git `demo` y base SQLite separada de la instalación habitual. |
| Sesiones y recuperación | `real_codex_turn`, `real_claude_permission` y `real_opencode_turn` pasaron contra las CLI autenticadas. Claude respondió en la interfaz. Tras reiniciar, OpenCode recuperó la rama y el historial del relevo. |
| Aislamiento y cambios externos | La sesión abrió su terminal en `ide/cruyff-1` y los cambios de prueba quedaron allí. Tras la corrección, crear `acceptance.md` desde ese terminal elevó de uno a dos el recuento sin cambiar de pestaña. `session_changes_include_committed_work` verifica que la lectura incluye commits, borrados y archivos nuevos, y conserva el índice. |
| Relevo y fallo parcial | Relevo nativo Claude → OpenCode con respuesta `HOLA P0` en la misma rama y expediente de origen. `progress_reports_untracked_work_without_changing_the_index` verifica reapertura de SQLite, copia y estado Git. Un fallo de cierre inyectado verifica el rollback y un segundo relevo desde el origen cerrado se rechaza. |
| Permisos | Claude real solicitó escritura, el rechazo impidió crear el archivo y el mismo UUID recuperó el encargo. Pruebas locales para opciones ACP, política de Codex y rechazo de rutas y symlinks externos. |
| Integración | Los tests de `isolate` usan repositorios Git temporales y prueban conflicto, cambios binarios, archivos borrados, symlinks y rechazo de limpieza con conflictos. |
| Larry | La interfaz propuso los dos archivos de prueba y creó `18160ca` en la rama aislada. El checkout principal siguió limpio. Los tests locales verifican rutas exactas y parada ante hooks que fallan o modifican archivos. |
| GitHub y modo local | `real_draft_on_this_repo` leyó las bases con Git y `gh`. `gh pr view 6 --repo BilalGates/filigranas-ide --json number,state` devolvió `MERGED`; `gh pr checks 6` indicó que no había checks. La UI deshabilitó Publicar sin remoto. Con un remoto bare de prueba mostró la confirmación y permitió cancelarla. La publicación real requiere una acción autorizada. |

## Reproducción

- Ejecutar `npm run build`, `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml` y `cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- Con las CLI autenticadas, repetir `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored <nombre> --nocapture` para cada prueba real de la tabla. Los turnos de proveedor se ejecutaron con acceso a red. En el entorno restringido, Codex se cerró y `gh` no alcanzó la API.
- Para repetir el recorrido nativo, crear un repositorio Git desechable como hijo de una carpeta raíz de pruebas y arrancar un bundle con identificador distinto de `com.filigranas.ide`. Seleccionar el repositorio, abrir Claude, pedir una respuesta breve de solo lectura y relevar a OpenCode. Reiniciar y, en la sesión recuperada, crear un Markdown desde su terminal. Debe aparecer inmediatamente entre los cambios. Abrir Larry en esa sesión, revisar rutas y crear el commit local. Abrir Publicar sobre el repo sin `origin` y comprobar el bloqueo.

## Aceptación de P1

- `AGENTS.md` enlaza las [reglas comunes](../src-tauri/resources/reglas.md) y la [norma del semáforo](../src-tauri/resources/skills/design-loop/references/semaforo-macos.md). Codex y Claude reciben el catálogo de skills del bundle. Cada entrada indica cuándo abrir su `SKILL.md`; las referencias se leen si corresponde. Los adaptadores ACP conservan su configuración propia.
- Los seis frontmatters pasaron la validación YAML. La prueba de catálogo verifica rutas, nombres y que el prompt inicial omita los cuerpos. `npm run build`, Clippy y 61 pruebas Rust locales pasaron en el árbol de trabajo, incluidas tres de guardado previas.
- En un repositorio de prueba con `AGENTS.md` propio, pedir a Codex `Usa $implement y crea acceptance.txt con una línea SKILL-P1`. La interfaz registró la lectura de `implement/SKILL.md` como única skill abierta, el archivo quedó verificado con `cmp` y el agente respondió según el formato `Done / Verified` y el marcador del proyecto. El cambio simple se completó sin pedir permiso adicional.
- En una sesión Claude aislada, pedir que cree un archivo con `Write` y pulsar Rechazar. La tarjeta se cerró, Claude indicó el rechazo y el archivo no existía en disco. La política se verifica por las acciones del proveedor y por el worktree.
- La captura del bundle confirmó el arranque, pero el indicador de compartir ventana tapó los botones en esa toma. El cambio de configuración Tauri añadió recursos de skills y la captura de referencia. La configuración de ventana y `window.rs` conservan las medidas ya aprobadas.

## Puertas

- [x] P0 · Aceptación mínima macOS verificada en una copia aislada. Build, Clippy y 60 pruebas locales correctas en el árbol de trabajo, incluidas tres pruebas previas de guardado. Windows, Antigravity, Devin y una nueva publicación en GitHub quedan fuera de este recorrido.
- [x] P1 · Reglas y skills con precedencia, carga selectiva y rechazo efectivo de permiso verificados.
- [x] P2 · Tablero, tareas y subtareas, dependencias, sesiones vinculadas y observaciones por turno. Migración y recuperación verificadas en macOS. Véase la [aceptación de P2](#aceptación-de-p2).
- [ ] P3 · Ampliar el flujo existente de PR con estado, checks y autorizaciones. Conservar la separación entre Larry, publicación y merge.
- [ ] P4 · Integrar Jev por API oficial una vez verificadas capacidades y configuración, con política local de respaldo.
- [ ] P5 · Auditoría y Design Loop con evidencia y la referencia macOS.
- [ ] P6 · Memoria estructurada y recuperación contextual en SQLite antes del grafo.

## Aceptación de P2

El tablero usa `tasks`, `task_dependencies`, `task_sessions` y `task_runs`. La migración añade tablas a la misma base SQLite. Las sesiones y sus identificadores anteriores se conservan y se pueden vincular desde el tablero. Las delegaciones del PM registran una tarea o se vinculan a la tarea seleccionada. El límite de tareas simultáneas es por proyecto y se puede ajustar desde el tablero.

| Escenario | Evidencia |
| --- | --- |
| Conversaciones | Bundle `com.filigranas.ide.p2` con copia de la base de P1. En una tarea nueva respondieron el PM de Codex, un hilo directo de Codex en su worktree y una sesión existente de Claude vinculada desde el tablero. Ambos catálogos se obtuvieron de las CLI. El modelo fijado y el historial de Codex directo volvieron al reabrir la app. |
| Reinicio durante un turno | Claude esperaba permiso de escritura. Se cerró la app sin concederlo. Tras arrancar, la tarea pasó a lista, el turno quedó interrumpido y se recuperaron las dos sesiones vinculadas con sus ramas, historial y métricas anteriores. El archivo solicitado no se creó. |
| Dependencias y paralelismo | `graph_rejects_cross_project_links_and_cycles_without_losing_previous_edges` y `legacy_sessions_and_parallel_runs_survive_restart_with_worktrees_and_handoff` comprueban ciclos mixtos, aislamiento por proyecto, bloqueo de ejecución, dos worktrees en paralelo, límite configurable, reintento y conservación tras relevo. |
| Cierre | `closing_requires_user_evidence_and_current_worktree_integration` comprueba que un turno exitoso deja la tarea en verificación. Para cerrar se registra el resultado de pruebas y evidencia, y se valida la huella de los worktrees con cambios. |
| Métricas | Se observaron duración, modelo, tokens y cuota en las respuestas de Codex y Claude. Se registró el coste estimado que devolvió Claude y el coste de Codex quedó desconocido. ACP conserva la ocupación de contexto cuando la informa, con consumo API desconocido. |

Para repetir, abrir **tareas**, crear una tarea **lista**, usar **hablar con el PM**, **nuevo chat Codex** y **vincular sesión**. En Claude, solicitar una escritura en el worktree de prueba y cerrar la app con la tarjeta de permiso pendiente. Reabrir el proyecto y comprobar el turno interrumpido en **Últimos turnos**. Ejecutar también `npm run build`, `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml` y `cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
