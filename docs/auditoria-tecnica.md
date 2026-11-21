# Auditoría técnica de Filigranas IDE

21 de noviembre de 2026 · base auditada `c7046f55609b2a5981dcbd355abbba195f394849` · macOS arm64.

## Base y hallazgos antes de intervenir

El checkout empezó limpio en `main`; la referencia local `origin/main` y el HEAD de GitHub coincidían. GitHub mostraba `main` y `chore/npm-run-app`, cero workflows y cero PR abiertas. `origin/windows-marc` era una referencia local de seguimiento sin rama remota actual. Los commits recientes incluyen la separación de datos de desarrollo, la integración de Windows y la actualización automática de CLI.

| Severidad | Evidencia en la base auditada | Impacto |
| --- | --- | --- |
| Alta | `claude.rs` indexa permisos por el identificador emitido por cada proceso; dos procesos pueden producir la misma clave. | La segunda solicitud puede reemplazar el permiso pendiente de otra sesión y recibir una decisión dirigida a aquella. |
| Alta | `lib.rs` ejecuta `runs::recovery` en cada arranque sin exclusión entre procesos. | Otra instancia con el mismo perfil puede marcar interrumpidos turnos vivos y liberar sus reservas de trabajo. |
| Alta | `work.rs` separa ámbitos con comparación sensible a mayúsculas, incluso en un checkout insensible. | Asignaciones con distinta capitalización pueden acceder al mismo archivo a la vez. |
| Alta | No existe `.github/workflows` y la API devuelve cero workflows. | Ningún check automático comprueba las PR del repositorio. |
| Alta | Los ámbitos de `work.rs` se inyectan en el prompt. El PM comparte la misma carpeta y existen ejecutores históricos en worktrees. | Los ámbitos ofrecen coordinación, pero no restringen a nivel de sistema los archivos que escribe cada CLI. |
| Media | `pr.rs` guarda el intento antes de enviar el POST y bloquea para siempre el mismo SHA si la respuesta se pierde y GitHub nunca lo recibió. | Actualizar el estado no permite completar ese cierre de trabajo. |
| Media | `pr.rs` ejecuta Git y GitHub CLI sin plazo y propaga sus diagnósticos. El push directo permite credenciales HTTP incrustadas en la URL. | Una operación remota puede retener el bloqueo de publicación. Una URL con credenciales también puede quedar expuesta en los argumentos de Git. |
| Media | `work.rs` valida limpieza, SHA y espacios; `github.rs` comprueba el estado de merge de GitHub. | Los conflictos de una PR aparecen en GitHub tras publicar. La integración local de worktrees ya tiene comprobaciones propias. |
| Media | `jev/mod.rs` y `codex.rs` usan metadatos acotados, presupuesto diario y fallback para el PM de Codex. | Las recomendaciones de evento y escalado son informativas. El alcance actual no cubre selección transversal de ejecutor. |
| Baja | El build inicial genera una entrada de aproximadamente 819 kB (229 kB gzip). `monacoLoader.ts` ya carga Monaco bajo demanda. | Hay un candidato para perfilado de arranque. No se midió tiempo de interacción ni se verificó una dependencia eliminable. |

No se confirmó un hallazgo crítico en el recorrido realizado.

## Arquitectura comprobada

- **React y Tauri.** `src/ipc.ts` concentra los contratos con Rust. El manejador de `lib.rs` acepta comandos del IDE desde la vista principal. El navegador integrado se abre en otra vista, con navegación HTTP(S) filtrada y sin capacidad remota. `paths.rs`, `workspace.rs` e `isolate.rs` validan rutas canónicas y worktrees registrados. La colaboración remota usa su propia validación de rutas versionadas, permisos, revisiones y revocación.
- **Persistencia y agentes.** SQLite conserva proyectos, IDs de proveedor, asignaciones, dependencias, turnos, enlaces de tarea y observaciones GitHub. La base usa WAL, claves foráneas y migraciones aditivas. Codex usa un app-server y Claude y ACP gestionan procesos de sesión. La recuperación marca turnos interrumpidos y reabre los chats que el proveedor aún conserva. Se conservan los worktrees históricos y el flujo actual de checkout compartido.
- **Permisos, CLI y modelos.** Codex aplica `workspace-write` y `on-request`. Claude y ACP tramitan decisiones solicitadas por sus CLI. La política del PM, el catálogo de seis skills y las instrucciones del proyecto se cargan a través de `skills.rs`. Codex y Claude consultan sus catálogos y permiten fijar un modelo. El estado de modelos y autenticación depende de la cuenta. Las cinco CLI estaban disponibles en el PATH del Mac al auditar, sin ejecutar turnos autenticados.
- **Tareas, Larry y GitHub.** Las dependencias y la evidencia de pruebas se guardan en `tasks.rs`. Larry valida operación por archivo y registra commits por rama. `github.rs` guarda PR y checks por proyecto, repositorio y rama; las tareas heredan las observaciones de las ramas vinculadas. La rama compartida puede tener varias tareas en una PR. La revisión de publicación y la de merge son aprobaciones independientes y vinculadas al SHA. GitHub informó que `main` no tenía protección ni checks requeridos.
- **Jev.** TypeSafe recibe metadatos acotados con consentimiento. La credencial se lee del almacén del sistema y se pasa a curl por stdin. El límite local es de 100 consultas diarias y el ajuste de plazo permite de uno a diez segundos. La traza registra el esfuerzo, la revisión de Jev, los tokens informados y el coste estimado a partir del catálogo cuando hay datos. `task_runs` conserva proveedor, modelo, reintento y desenlace. La cuota de TypeSafe sigue como desconocida. Los modos local, observación y activo mantienen los modelos fijados manualmente y delegan el control de permisos al orquestador.
- **Documentación y alcance.** `PLAN.md` conserva la planificación inicial, que asignaba ramas separadas a agentes y trataba el merge remoto como fase posterior. El flujo vigente se describe en el README y en «Sesión de trabajo compartida y PR hacia main» del [inventario de aceptación](aceptacion-v1.md). Las pruebas de aceptación históricas documentan las compilaciones en que se ejecutaron.

## Correcciones y evidencia

| Área | Cambio comprobado |
| --- | --- |
| Seguridad | El identificador de aprobación Claude pertenece al IDE y queda ligado al proceso emisor. La prueba usa dos solicitudes simultáneas con el mismo ID de proveedor. Se desactivan trazas heredadas para las operaciones de publicación y el push rechaza credenciales HTTP incrustadas. DOMPurify pasa de 3.4.15 a 3.4.18 mediante una sobreescritura acotada a Monaco. La auditoría de npm pasó de avisos a cero vulnerabilidades. |
| Continuidad | La exclusión por perfil antecede a la recuperación SQLite. Las asignaciones con distinta capitalización se bloquean de forma conservadora y un reparto inválido se procesa antes de vincular el chat. Codex conserva la reserva si vence el plazo de confirmación, hasta que aparezca el desenlace o se cierre el proveedor. El relevo persiste objetivo, rama y evidencia de estado en la misma transacción que cierra el origen. La prueba reabre SQLite, interrumpe el primer intento y comprueba que el resumen se reutiliza hasta terminar un turno correcto. |
| GitHub | Un segundo intento renovado consulta primero el servidor, recupera la PR si existe y puede repetir la creación si faltaba. Una consulta fallida impide la mutación. Las regresiones simuladas cubren respuesta perdida tras crear, solicitud nunca recibida, rechazo de la aprobación, cambio de SHA y merge en dos fases. Git y GitHub CLI de publicación tienen un plazo de 90 s por proceso y salida acotada. La comprobación local de conflictos prueba la base de seguimiento sin tocar rama, índice ni archivos del checkout. El merge exige checks observados y que ninguno informe fallo o espera. |
| CI | La [configuración](../.github/workflows/ci.yml) ejecuta build TypeScript/Vite, pruebas Rust/Tauri y Clippy en macOS y Windows. El trabajo de seguridad comprueba npm y RustSec. Las acciones están fijadas por SHA, el token tiene permiso de lectura y checkout no persiste credenciales. [Configuración segura de GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use) |
| Rendimiento | El tablero consulta commits y PR una vez por rama y por carga, aunque muchas sesiones compartan la rama. El lector de procesos drena las salidas sin retenerlas completas. La prueba fuerza un descendiente que retiene abierto el pipe y comprueba que el plazo libera la operación. |
| Jev | El fallback registra clasificación y revisión local aunque TypeSafe esté caído. Una tarea de alcance grande o con fallo ambiguo eleva el esfuerzo mínimo a medio. Un fallo ambiguo sugiere inspección. La elección de un modelo ligero sigue requiriendo señales explícitas de Jev, catálogo compatible y decisión del orquestador. |
| Interfaz | Publicar ofrece actualizar el estado cuando la consulta inicial falla y no hay PR visible. Conserva el título y la descripción editados. Se comprobó en Chrome con IPC simulado y datos de prueba, incluidos el reintento y el bloqueo del merge con cero checks. |

## Verificación de esta entrega

- `npm run build` y `cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: correctos en macOS.
- `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --quiet`: 118 correctas, 10 omitidas por defecto. Se ejecutaron aparte y pasaron `configures_and_applies_choice_over_the_wire` y `share_edit_and_revoke_over_relay` con servidores locales.
- `actionlint` 1.7.12, validación YAML y `git diff --check`: correctos.
- `npm audit --audit-level=high`: cero vulnerabilidades. `cargo audit --file src-tauri/Cargo.lock`: código 0 y tres avisos informativos. [chrono sin mantenimiento](https://rustsec.org/advisories/RUSTSEC-2026-0543), [proc-macro-error sin mantenimiento](https://rustsec.org/advisories/RUSTSEC-2024-0370), [glib y GTK de plataformas Linux/BSD](https://rustsec.org/advisories/RUSTSEC-2024-0429).
- Acceso a GitHub comprobado en solo lectura con `git ls-remote` y consultas `gh api`. Las pruebas de publicación usan un remoto simulado. Esta rama queda local.

## Pendiente y límites

- **Alta.** El checkout compartido conserva ámbitos de coordinación, con acceso más amplio por parte de las CLI y terminales externos. Falta aislamiento por archivo para ejecutores y PM si se quiere una garantía fuerte de no sobrescritura. El bloqueo por perfil protege procesos de esta versión que comparten el mismo directorio de datos.
- La PR #15 completó los workflows. GitHub exige una PR con los checks de macOS, Windows y seguridad de dependencias aprobados por GitHub Actions. [Regla activa de main](https://github.com/BilalGates/filigranas-ide/rules/27807888)
- **Media.** La consulta local de conflictos depende de las referencias de seguimiento disponibles. GitHub vuelve a evaluar la base efectiva antes de fusionar. [Git merge-tree](https://git-scm.com/docs/git-merge-tree/2.38.0)
- **Media.** Ejecutar el recorrido nativo en Windows y probar cierre forzado y cancelación con cada proveedor autenticado. Un timeout de inicio de Codex sin eventos conserva la reserva hasta que el proveedor se cierre, lo que puede exigir reiniciar. La terminación de árboles de procesos depende del SO y del adaptador.
- **Media.** Quedan pendientes el enrutamiento automático entre proveedores por capacidad y coste y la recuperación de historiales que el proveedor haya perdido. Jev ofrece recomendaciones; ningún fallo ambiguo dispara reintentos o escalados automáticos. No se activaron consultas reales de TypeSafe.
- **Baja.** Perfilar el arranque con hardware y escenarios representativos antes de cambiar partición de paquetes. No se encontró una dependencia de ejecución eliminable con evidencia suficiente.
