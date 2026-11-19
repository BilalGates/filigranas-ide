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
- [x] P3 · Trazabilidad de Larry, PR y CI con reconciliación de reintentos y aprobaciones independientes. Véase la [aceptación de P3](#aceptación-de-p3).
- [x] P4 · Enrutamiento autenticado con TypeSafe y fallback local verificados en macOS. Véase la [aceptación de P4](#aceptación-de-p4).
- [x] P5 · Code Health y Design Loop verificados en macOS con un repositorio y un servidor locales. Véase la [aceptación de P5](#aceptación-de-p5).
- [x] P6 · Memoria estructurada, búsqueda y recuperación con fuentes verificadas tras reiniciar. Véase la [aceptación de P6](#aceptación-de-p6).

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

## Aceptación de P3

- Larry comprueba `git diff --cached --check` antes de cada commit y mantiene los hooks. El tablero relaciona el SHA completo con la rama de la sesión, la tarea y las PR observadas. La comprobación local y el estado de CI remoto se muestran por separado.
- Las PR se buscan en el repositorio de `origin` por rama y base, incluida la historia de un SHA ya publicado. SQLite conserva la última observación y los intentos de creación ambiguos. Los tests simulan una respuesta perdida, un reinicio y una desconexión. El reintento recupera el mismo número sin otro push ni otra creación. Si GitHub sigue sin confirmar un intento ambiguo, la app conserva la rama y espera a poder reconciliarlo.
- La revisión en la app muestra el destino y exige escribir el SHA abreviado. Rust comprueba la autorización una sola vez para esa operación. Las pruebas rechazan confirmaciones incorrectas o reutilizadas, cambios durante la revisión, revisiones pendientes y reglas bloqueantes. El merge pide autorización propia y solicita a GitHub validar el SHA de cabecera y las reglas de la rama. [API de pull requests](https://docs.github.com/en/rest/pulls/pulls) · [Campos de GitHub CLI](https://cli.github.com/manual/gh_pr_view)
- `real_github_pull` consultó la PR #6 de Filigranas en modo lectura y confirmó su estado. `gh pr view 15094 --repo cli/cli --json statusCheckRollup` consultó una PR pública con 18 checks. Los escenarios de creación y merge automatizados usan un servidor simulado.
- En el bundle macOS corregido, con Git remoto bloqueado, se comprobó que un SHA vacío o incorrecto desactiva la confirmación. Se cancelaron las revisiones de push y apertura de PR. El primer ensayo detectó una publicación prematura con el diálogo nativo y motivó sustituirlo por la revisión vinculada al SHA.

## Aceptación de P4

- [x] El adaptador pasa la clave desde el almacén del sistema al cliente HTTP por la entrada estándar. El backend exige consentimiento al activar o actualizar Jev y consulta el catálogo autenticado. La prueba HTTP reproduce el catálogo, una petición `Choice` y una respuesta que cambia el esfuerzo automático de medio a bajo. [Catálogo oficial](https://docs.typesafe.ai/api/list-models) · [API System One](https://docs.typesafe.ai/api/system-one) · [Choice](https://docs.typesafe.ai/primitives/choice)
- [x] Las pruebas cubren el fallback local ante timeout, credencial inaccesible, límite remoto, respuesta inválida o confianza insuficiente. La política local fija el mínimo de riesgo. En modo económico, un modelo alternativo necesita estar seleccionado en el catálogo de Codex y admitir texto y esfuerzo bajo. SQLite conserva el modelo habitual para recuperarlo en turnos posteriores. Shadow registra recomendaciones y aplica la política local.
- [x] El tablero muestra complejidad, revisión y preparación de contexto recomendadas. En el siguiente turno automático, Control Tower puede orientar sobre un fallo previo de Codex sin causa informada. El historial SQLite conserva las decisiones, los tokens reportados y el coste estimado para revisiones con precio publicado. La cuota de TypeSafe figura como desconocida. [Precios por revisión](https://docs.typesafe.ai/models)
- [x] **Enrutamiento autenticado en macOS (2026-11-19).** En un bundle aislado de `codex/v2-p0` sobre `1dc0696`, Filigranas leyó la clave del llavero tras la autorización en el aviso de macOS y activó `jev-latest` desde el catálogo real. En una tarea sintética, `jev-1.14.0` recomendó esfuerzo bajo con un 94 % de confianza. La traza SQLite registró el origen `jev` y 738 tokens de entrada y 157 de salida. La petición de inicio del turno envió esfuerzo bajo a Codex y el turno terminó.
- [x] **Fallback local en macOS (2026-11-19).** Con Jev todavía activo, el bundle instrumentado dirigió solo la conexión a TypeSafe a un puerto cerrado de loopback. La traza registró origen `local` y causa `unavailable`. Codex recibió esfuerzo medio y terminó el turno.
- [ ] **Comprobación nativa en Windows.** Pendiente de ejecutar en un equipo o VM Windows con una sesión de escritorio y acceso a TypeSafe y Codex.

Para reproducir el recorrido autenticado en macOS, guardar una contraseña genérica en el llavero de inicio de sesión con nombre `Filigranas IDE TypeSafe` y cuenta `jev`. En **Herramientas → Enrutamiento con Jev**, autorizar el envío de metadatos y activar Jev. Desde una tarea de prueba lista, abrir el PM con esfuerzo **automático** y comprobar el origen, el esfuerzo y los tokens en **Últimos turnos**.

Validación local con `npm run build`, `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml` y `cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`. Para repetir el recorrido HTTP, ejecutar `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml configures_and_applies_choice_over_the_wire -- --ignored` en un entorno que permita abrir un puerto de loopback.

### Recorrido de aceptación en Windows

En el repaso previo (2026-11-19, `b8c49a0`) se ejecutaron en macOS cuatro pruebas de Jev y la prueba HTTP local con una credencial ficticia. Las cinco pasaron. La lectura del almacén de Windows, la autenticación con TypeSafe y el fallback en Windows requieren la ejecución nativa descrita a continuación.

1. Con la misma cuenta de Windows que ejecuta Filigranas, abrir **Administrador de credenciales → Credenciales de Windows → Agregar una credencial genérica**. Escribir `Filigranas IDE TypeSafe` como dirección, `jev` como usuario y la clave de TypeSafe como contraseña en el cuadro del sistema. La lectura con `CredReadW` usa el nombre de destino y la sesión de Windows. [Administrador de credenciales](https://support.microsoft.com/en-us/windows/security/credential-manager-in-windows) · [CredReadW](https://learn.microsoft.com/windows/win32/api/wincred/nf-wincred-credreadw)
2. Iniciar Filigranas, autorizar el envío de metadatos y activar Jev desde **Herramientas → Enrutamiento con Jev**. Confirmar que el catálogo autenticado selecciona `jev-latest`. Abrir el PM con esfuerzo **automático** desde una tarea sintética de bajo riesgo. En **Últimos turnos**, registrar el origen `jev`, la revisión, el esfuerzo aplicado y los tokens que informe TypeSafe. Confirmar que el turno de Codex termina con el esfuerzo registrado.
3. Mantener Jev activo y provocar un fallo de conexión inmediato solo a `api.typesafe.ai` en el entorno de prueba. Repetir desde una tarea equivalente y confirmar que aparece origen `local`, causa `unavailable` y el esfuerzo de la política local. Confirmar que Codex termina el turno y restaurar la conexión a TypeSafe.
4. Registrar la versión de Windows, el SHA probado y los resultados de ambas rutas. Excluir la clave y las cabeceras de autorización de toda evidencia.

## Aceptación de P5

- **Code Health.** En un repositorio temporal, `git diff --check` detectó espacios sobrantes en `style.txt:2`. El panel mostró la regla, la versión de Git y el SHA base, y guardó una resolución explícita. La importación SARIF 2.1.0 conserva regla, severidad, ubicación y huella de informe. Los tests comprueban la deduplicación y el descarte de mensajes y fragmentos que podrían contener secretos. El CI usa las observaciones de P3 por rama, SHA y fecha. Las comprobaciones locales de npm y Cargo son de ejecución explícita.
- **Design Loop.** En el bundle aislado se capturaron dos versiones reales de una página local a 1280 × 800, se verificó la superposición con el deslizador y se aprobó la candidata tras confirmar las restricciones. La comparación de los PNG persistidos confirmó que la cabecera bloqueada seguía idéntica píxel a píxel y el panel había cambiado. Para repetir, guardar una pantalla, abrir su URL local y capturar en Chrome o importar un PNG de una app nativa. Aprobar la referencia, capturar con el mismo tamaño y seleccionar una región. SQLite conserva versiones aprobadas y descartadas. [Capturas de Chrome](https://developer.chrome.com/docs/chromium/headless)
- **Semáforo.** En el bundle aislado se midieron los marcos de los tres controles nativos en AppKit. Los bordes izquierdos quedaron a 16, 39 y 62 puntos, con margen superior de 16 puntos y botones de 14 × 14. La cabecera lateral reserva 48 puntos.
- **Verificación.** Ejecutar `npm run build`, `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml` y Clippy con `--all-targets -- -D warnings`. Para comprobar la captura real, ejecutar `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml captures_real_local_page_at_the_requested_size -- --ignored` con Chrome instalado y acceso a loopback.
- **Pendiente.** Recorrido autenticado de encargo y comparación visual con Claude, y verificación nativa de P5 en Windows.


## Aceptación de P6

- **Memoria.** Brain permite confirmar, buscar, editar y olvidar hechos, decisiones, preferencias, restricciones, evidencias y resultados. Cada recuerdo tiene fuente, fecha y ámbito global, de proyecto o de tarea. Las referencias a una tarea o turno terminado se validan por proyecto. La búsqueda de texto usa el índice SQLite FTS5 y admite palabras sin tilde. [SQLite FTS5](https://www.sqlite.org/fts5.html)
- **Contexto.** Al empezar una tarea, Codex, Claude y ACP usan el mismo preparador. Selecciona hasta seis notas vigentes autorizadas para agentes, con prioridad al ámbito de tarea y a las coincidencias textuales del proyecto. El historial del turno muestra identificador, revisión y fuente de cada referencia. Editar actualiza el índice. Olvidar elimina el recuerdo, sus resultados de búsqueda y sus referencias locales. Los mensajes que un proveedor ya recibió tienen su propio historial.
- **Reinicio.** En un bundle macOS aislado sobre una copia sintética de la base de P5, se guardó «Decisión de catálogo» con fuente «ADR-6 catálogo» y vínculo a la tarea #1. Tras cerrar y arrancar el bundle, la búsqueda `catalogo` recuperó el recuerdo y la vista previa de la tarea mostró la misma cita. Los registros previos de Code Health y Design Loop siguieron presentes.
- **Pruebas.** La prueba de reapertura comprueba el índice, las fuentes por turno y la exclusión de recuerdos caducados, locales, ajenos o irrelevantes. Otra prueba verifica edición, olvido y rechazo de fuentes inválidas y formatos habituales de credenciales. Comandos: `npm run build`, `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml` y `cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.

### Grafo de Brain

- **Relaciones.** El grafo consulta SQLite y enlaza recuerdos con su tarea de ámbito, su tarea o turno fuente y cualquier PR registrada cuya URL coincide con la fuente guardada. Las tareas se enlazan con su padre, sus dependencias y las PR observadas para las ramas de sus sesiones. El alcance de cada consulta es el proyecto elegido o la memoria global.
- **Filtros.** En **Brain → Grafo**, elegir proyecto, tipo y fechas. El intervalo incluye ambos días en hora local. Para recuerdos y tareas se usa su última actualización, y para PR su fecha de observación. Las coincidencias conservan sus vecinos directos, identificados como relacionados. La vista indica si se alcanza el límite de nodos o relaciones.
- **Navegación.** Seleccionar un nodo muestra sus vínculos y permite saltar al nodo vecino, abrir la tarea exacta en su tablero, leer el recuerdo con la fuente o abrir la URL guardada de la PR. Las pruebas de SQLite verifican los límites, los filtros y el aislamiento cuando dos proyectos comparten nombres de ramas o títulos.
- **Recorrido macOS.** Un bundle aislado con dos proyectos de prueba verificó el dibujo de aristas, el filtro por tipo, un día inclusivo, una fecha excluida y el cambio de proyecto. Desde el grafo se abrió la decisión con su fuente y se seleccionaron las tareas exactas en ambos proyectos. El comando de apertura de PR entregó al lanzador instrumentado la URL exacta de la PR observada.
