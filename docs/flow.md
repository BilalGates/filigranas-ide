# Flow · contrato F1a/F1b

Esquema aditivo sobre tasks/task_sessions/task_runs. task_plans guarda id estable,
project, title (1–110 caracteres), goal, criteria, createdAt y updatedAt.
No se reconstruyen planes ni prompts históricos. Los nuevos campos desconocidos
son null, incluido attempt: no se deduce un intento histórico de retry.

IPC: taskPlans.create(project, {title, goal, criteria}) devuelve ID;
taskPlans.list(project) devuelve TaskPlan[]; taskPlans.detail(project, plan) devuelve
TaskPlan y rechaza IDs ajenos. Los tres comandos Rust son task_plan_create,
task_plans_list y task_plan_detail. tasks.flow(project) añade plans al snapshot
{plans, tasks, runs}. runs sigue siendo un mapa taskId → últimos 30 turnos.
Sin campo events: no existe un registro histórico de eventos en esta fase.

Task añade planId/prompt/agent/role (nullable). tasks.save acepta esos campos
opcionales; omitirlos o enviar null conserva los existentes. El prompt explícito
se conserva literalmente, incluso sus espacios; título y objetivo son distintos.
SQLite y el servicio rechazan asociar un plan de otro proyecto. El rol pm no es
válido como rol de una tarea ejecutora. No cambia el cierre validado existente.

TaskRun añade attempt/prompt/result/dispatchedMs, todos nullable. F1a solo añade
almacenamiento y lectura; no afirma captura del runtime ni despacho de colas.
F1b conecta escrituras de proveedores, separa el cupo técnico del PM y añade
phase derivado. La cola recuperable y las herramientas PM se describen en
«Cola recuperable y herramientas del PM».
Se mantienen los comandos anteriores y tasks-changed al crear un plan.

## Verificación F1a · 2026-11-28

Worktree filigranas-ide-flow, rama feat/flow-orquestacion, base 7988c91.
No se modificó el checkout original ni se generó/instaló una aplicación .app.

- `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml flow_ -- --nocapture`: código 0, 4 pruebas nuevas correctas.
- `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml tasks::tests -- --nocapture`: código 0, 6 correctas.
- `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml runs::tests -- --nocapture`: código 0, 3 correctas (9 distintas entre ambos módulos, incluidas las 4 nuevas).
- `pnpm build`: código 0, TypeScript sin errores y Vite 1367 módulos, 6,32 s.
- `git diff --check`: código 0.

Las pruebas nuevas cubren una base legacy sin columnas Flow, migración repetida,
ausencia de backfill, reapertura, prompt exacto, rechazo de planes ajenos desde
servicio y SQLite, editores legacy, rol/agente/título inválidos y serialización
de metadatos de intentos en detalle y consulta por proyecto.

Dependencias web ya presentes y utilizables; no hizo falta reinstalarlas.
El primer typecheck detectó un await inválido en el mock, corregido antes del build.
El primer intento de Cargo fue denegado por el sandbox al escribir target;
las comprobaciones Rust posteriores usaron el escalado aprobado del entorno.
Esto verifica persistencia/contratos locales; no verifica turnos reales de proveedores.

## Runtime esencial F1b · 2026-11-28

- Claude y Codex delegan por `delegate::dispatch_delegation`: cada encargo crea
  tarea y plan propios, con parent_id cuando hay tarea coordinada. La subsesión
  se vincula mediante el mismo servicio y los errores de vinculación se propagan.
  El prompt `tarea` se conserva literalmente; `titulo` y `objetivo` son campos
  separados. Los chats técnicos sin tarea crean una antes del primer intento.
- `runs::prepare` confirma en SQLite prompt literal, intento y hora antes de
  crear el hilo/proceso y antes de `begin_prepared`. Estado interno preparing,
  sin consumir cupo técnico hasta comenzar el runtime. Si falla el arranque,
  quedan prompt, error y hora final; repetir es un intento nuevo explícito.
- El límite cuenta ejecuciones técnicas, incluidas sesiones sin vínculo y varias
  sesiones de la misma tarea. Excluye PM explícitos y coordinadores legacy
  identificados por hilo o sesión. Un PM no cambia el estado técnico de su tarea.
- Claude guarda result y error del resultado del proveedor; Codex conserva el
  último mensaje de agente completado y el error del turno; ACP acumula texto
  recibido y guarda errores. Resultados tardíos no sobrescriben intentos cerrados.
  `esperar_sesion` lee SQLite como fuente recuperable y admite ID numérico como
  string (`"20"` o `"#20"`); títulos ambiguos se rechazan. Puede consultar una
  sesión cerrada por ID. Continuar requiere una sesión abierta y del proyecto.
- `Task.phase`: pending, waiting_dependencies, running, waiting_permission,
  verifying, blocked, done, failed, cancelled, paused_quota o interrupted.
  queued corresponde a un intento persistido en cola (ver la sección siguiente).
  `Plan.progress` devuelve `{total, done}` calculado desde las tareas.
  `TaskRun.error` es nullable; waitingPermissions es el indicador 0/1 de espera
  registrada del runtime, no un recuento de solicitudes concurrentes.
- Run completed deja la tarea en verifying. El cierre done conserva los controles
  anteriores de evidencia, pruebas, dependencias y huella de integración.
  Cancelled ya no se traduce a ready. Recovery liquida los intentos activos como
  interrupted y limpia sus esperas, conservando los resultados persistidos.
- La espera fantasma de Claude tenía una causa verificable en el código previo:
  se marcaba waiting_approval antes de rechazar herramientas directas del PM o
  subagentes internos. Ahora solo se marca tras registrar una petición pendiente.
  Codex correlaciona cada aprobación con el hilo y limpia la fase al responder;
  también se limpia al terminar/reiniciar. No se inspeccionó ni modificó la base
  de la aplicación instalada: el estado vivo de las tareas 18/20 sigue desconocido.
- Se conservan `tasks-changed` como invalidación sin payload y los eventos
  coordinator/session con sus IDs existentes. No se añadió un registro de eventos.
  F3 puede leer attempts/result/error y distinguir completed de done; no hay un
  hook nuevo que autorice publicación ni cambios en delivery_auto/pr/work.

Comprobaciones: `pnpm build` código 0 (TypeScript y 1369 módulos Vite, 3,41 s).
`CARGO_INCREMENTAL=0 cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1`:
código 0, 176 correctas, 0 fallos, 10 externas omitidas. La primera ejecución
paralela terminó código 101 (171 correctas, 5 fallos por Out of diskspace/
database or disk is full). Se eliminaron con aprobación los 646 MB de caché
incremental generada en este worktree y se repitió en serie correctamente.
No se ejecutaron turnos reales de proveedor ni operaciones externas de GitHub.

Revisión final: `CARGO_INCREMENTAL=0 cargo test --locked --offline --manifest-path src-tauri/Cargo.toml flow_ -- --test-threads=1`:
código 0, 12 correctas, 0 fallos. Incluye cancelación idempotente, limpieza de
espera, fallos por dependencias y mensaje final Codex. `git diff --check`: código 0.

## Cola recuperable y herramientas del PM · 2026-11-28

- **Cola.** `runs::enqueue_session` (IPC `flow_enqueue`) crea el intento con el
  prompt literal y lo deja en `outcome='queued'`. `claim_queued` lo reclama una
  sola vez (`queued` → `preparing`) cuando la tarea no está bloqueada, hecha,
  cancelada ni en backlog, sus dependencias están `done`, la sesión sigue abierta
  y hay cupo técnico. El orden es prioridad y después ID de intento. Un solo
  trabajador (`flow_dispatch`) despacha; `wake_queue` se llama al arrancar.
- **Cupo.** Un intento `queued` no consume cupo técnico: sin ello el propio
  intento en cola ocupaba el cupo y nunca podía reclamarse con límite 1. Esto se
  corrigió el 2026-11-28 en `technical_active`.
- **Reinicio.** `recovery` conserva los intentos `queued` y liquida como
  `interrupted` los demás activos. El mismo intento se reclama tras reiniciar.
- **Cancelar.** `flow_cancel_run` cancela un intento en cola de inmediato, rechaza
  uno en `preparing` y interrumpe uno en marcha mediante su proveedor.
- **Herramientas del PM.** `flow_plan_create`, `flow_plans`, `flow_plan`,
  `flow_tasks`, `flow_task`, `flow_delivery`, `flow_task_create`, `flow_task_edit`,
  `flow_review` y `flow_block` están en los catálogos de Codex y Claude, con una
  prueba que exige que ambos coincidan. El PM solo edita meta, criterios,
  dependencias, prioridad y título.
- **Pendiente.** La interfaz de Flow no llama todavía a `flow.enqueue` ni a
  `flow.cancelRun`: solo etiqueta las fases. No se han ejecutado turnos reales de
  proveedores contra la cola.

Comprobaciones (2026-11-28): `cargo test --lib -- --test-threads=1` 178
correctas, 0 fallos, 10 externas omitidas; `cargo clippy --all-targets -- -D warnings`
sin avisos; `pnpm build` y `pnpm test` (61) en verde; `git diff --check` limpio.
