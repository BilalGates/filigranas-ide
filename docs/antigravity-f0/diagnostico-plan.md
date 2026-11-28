# Antigravity: diagnóstico F0 y plan para aprobación

28 de noviembre de 2026. Base Git `7988c91`, CLI `agy 1.5.18`, macOS. Rama de auditoría `audit/antigravity-f0`, worktree `/private/tmp/filigranas-antigravity-f0`.

**Conclusión:** la vía oficial `agy acp` es viable y funciona con la autenticación existente. El producto todavía no ofrece una integración completa ni seguridad demostrada para todas sus herramientas. F1–F5 requieren aprobación del usuario; esta intervención solo añade documentación, sondas y evidencia de F0. No se ha cambiado código de aplicación, creado otra `.app`, instalado/actualizado una CLI, hecho push ni merge.

## Alcance y procedencia

Se han revisado las reglas del proyecto, la norma del semáforo y `docs/aceptacion-v1.md`. El inventario es histórico: sus referencias a Antigravity no acreditan pruebas autenticadas actuales. Se han leído en Obsidian `Inicio`, `Preferencias`, `Filigranas IDE - Sesiones y entregas` y `Filigranas IDE - Desarrollo con pnpm`; influyen la separación de tareas, las autorizaciones de entrega, pnpm y la prohibición de crear otra instalación.

El checkout principal contiene cambios ajenos de Entrega. `source-state.json` identifica rutas y hashes observados durante F0. Se ha inspeccionado ese árbol actual, pero las sondas y el informe están separados sobre su HEAD; cualquier integración posterior deberá reconciliar los cambios en curso sin sobrescribirlos.

## Arquitectura actual y puntos de extensión

| Área | Implementación revisada | Diagnóstico |
| --- | --- | --- |
| Claude | `src-tauri/src/claude.rs`, `src/Session.tsx` | Proceso por sesión, entrada/salida stream JSON y aprobaciones por stdio. UUID y transcript del proveedor. El mismo módulo contiene buena parte del ciclo común de sesiones, incluidos ejecutores ACP. |
| Codex | `src-tauri/src/codex.rs`, `rpc.rs`, `Coordinator.tsx` | Un `app-server` compartido con hilos por proyecto/sesión, eventos, modelos, aprobaciones y cuotas. El transporte por líneas se comparte con ACP. |
| ACP existente | `src-tauri/src/acp.rs` | Ya admite `agy`, OpenCode y Devin; no hace falta un tercer orquestador. Crea/carga sesiones, expone modelo/razonamiento, emite herramientas, gestiona permisos y cancelación. No negocia todas las capacidades, descarta stderr y no fuerza sandbox. |
| Sesiones e identidad | `db.rs`, `chat.rs`, `handoff.rs`, `workspaceContext.ts` | IDs del proveedor separados del ID local, opciones y vínculos persistidos. Problemas: ACP crea otra conversación si falla la carga; el selector actual solo acepta Claude/Codex y cambia el motor de la misma fila con intercambio binario de opciones. No extender ese intercambio a tres proveedores. |
| Persistencia | `db.rs`, `chat.rs`, `runs.rs`, `tasks.rs` | SQLite WAL, claves foráneas y migraciones aditivas. `sessions.engine` es texto y ya admite `agy`; no necesita renombrar datos existentes. ACP depende del replay del proveedor para el historial visible; el transcript común no cubre por sí solo todas las conversaciones ACP. |
| Ejecución común | `claude.rs::send_content`, `runs.rs`, `tracker.rs` | Admisión del turno, tareas, contexto, Brain, skills y seguimiento ya se reutilizan antes de enviar a ACP. `runs::begin` controla turno activo y paralelismo de tareas por proyecto. Falta un límite explícito por proveedor y un resultado durable independiente del proceso para todos los casos de recuperación. |
| Delegación y PM | `delegate.rs`, `claude.rs::create_pm_subsession`, `create_subsession` | Los esquemas de ambos PM ya enumeran `agy`, con seguimiento/espera/continuación comunes. La ruta Codex crea/vincula tarea y marca delegación; Claude crea hijos con padre. No equivale a haber demostrado el recorrido completo: hay que unificar vínculos, propagar errores de `tasks::link` y conservar padre, tarea y alcance en ambos caminos. |
| Protección del PM | `codex.rs::thread_params`, manejo de aprobaciones; `claude.rs::proc` | Codex configura lectura y rechaza solicitudes de comandos/edición del PM. Claude excluye herramientas directas e impide subagentes internos. ACP se lanza con `mcpServers: []` y sin restricciones equivalentes de coordinación: Antigravity no debe ser PM. |
| Aislamiento | `isolate.rs`, `work.rs`, `autoapprove.rs`, `approval.rs` | Las sesiones directas vinculadas a tareas pueden crear worktrees. Las subsesiones comparten/heredan carpeta y rama; no todas crean una copia aislada. Las reservas de rutas coordinan agentes cooperativos y los permisos automáticos comprueban rutas; ninguna de esas medidas es una frontera de seguridad del proceso. |
| Skills | `skills.rs`, catálogo por rol | El camino común añade catálogo a ACP. Falta comprobar lectura real de skills incluidas desde el sandbox y fijar las reglas de ejecución que Claude recibe en su prompt. Las personalizaciones y subagentes nativos de Antigravity requieren control propio. |
| CLI y autenticación | `tools.rs`, `cli.rs`, `Tools.tsx` | Hay especificación antigua de `agy` y actualización `agy update`, pero `tools_status` y el frontend la filtran. Su autenticación está como desconocida. Se reutilizan resolución del PATH, bloqueo de actualización en uso y notificaciones `cli-updates`; no se debe inferir conexión de `--version`. |
| Jev | `jev/mod.rs`, `typesafe.rs`, `credential.rs`, llamada desde `codex.rs` | Actualmente recomienda esfuerzo y, bajo política económica, un modelo alternativo de Codex. `route` consulta `state.codex.jev_models()`. No existe todavía selección general de proveedor con salud/cuota/concurrencia. Mantener consentimiento, límites, privacidad de señales, fallback local y trazas. |
| Flow | `trama/Flow.tsx`, `workspaceContext.ts` | El modelo real deriva proveedor, modelo, duración, estado, sesión y rutas Jev de tareas/ejecuciones comunes. Aprovecharlo; completar trazabilidad del prompt y proveedor asignado. El modelo demo no prueba integración. |
| Entrega | `delivery_auto.rs`, `git_ops.rs`, `larry.rs`, `trama/entrega/*` | La automatización despacha al PM Claude/Codex. Antigravity debe entrar por la misma delegación y relaciones tarea/sesión/worktree/commit. Larry conserva la creación de commits y las autorizaciones de publicación. Hay cambios ajenos activos en esta área. |
| Brain | `brain.rs`, `runs.rs::task_input` | Entradas y recuperación acotadas por proyecto/tarea con procedencia de ejecución. ACP ya pasa por el camino de contexto común. No copiar estado interno de agentes; completar la procedencia del resultado durable. |
| Studio | `design.rs`, `Studio.tsx`, `attachments.rs` | `CanvasEngine` limita generación a Claude/Codex; las sesiones de diseño y envío de capturas tienen restricciones de proveedor. Imagen está anunciada por ACP, pero aún no se ha probado; no habilitar inspección visual hasta hacerlo. |
| Consumo y diseño | `usageStore.ts`, `EngineUsage.tsx`, `Usage.tsx`, `Settings.tsx`, `ProviderLogo.tsx` | Solo Claude/Codex; datos fuente en porcentaje usado, UI en restante. Hay puntos de color y nombres permanentes. Antigravity tiene monograma, no logo oficial. Se pueden reutilizar tokens `--menu-*` y superficies existentes. Falta estado explícito de frescura y conexión. |
| Errores y recursos | `rpc.rs`, `acp.rs`, `trama/notifications.ts`, `updates.rs` | Centro de notificaciones reutilizable. RPC pierde códigos/datos de error y usa mensajes de Codex para ACP. `Drop` mata al hijo inmediato; falta cierre ACP gradual, límites y comprobación del árbol de procesos. Procesos ligados al estado backend, no a la vista: conservar esa independencia. |

## Viabilidad experimental

Sondas Python de biblioteca estándar, mediante JSON-RPC 2.0 oficial sobre stdin/stdout; **no son pruebas de integración Tauri ni del adaptador Rust**. Fixture Git desechable `/private/tmp/filigranas-agy-fixture` y un segundo directorio sintético. Sin leer credenciales, SQLite privada del proveedor, endpoints privados ni automatización de interfaz. Se empleó `--sandbox --disable-telemetry`, sin saltar permisos. Las sondas posteriores excluyeron `GEMINI_API_KEY` y `GOOGLE_API_KEY` del entorno.

| Comprobación real | Resultado | Evidencia |
| --- | --- | --- |
| Detección y versión | CLI encontrada en `~/.local/bin/agy`, versión 1.5.18; `agy acp --help` reconoce transporte stdio | Ayuda local y `discovery.json` |
| Inicialización | Protocolo 1, servidor Antigravity, métodos OAuth personal/empresa, API key y Agent Platform anunciados | `discovery.json` |
| Cuenta existente | Sesión y turnos correctos reutilizando credenciales; sin API key en el entorno en pruebas de continuación; nivel de cuenta informado por el servidor | `lifecycle.json`, `capabilities.json` |
| Conversación y streaming | Texto `F0-ACP-OK`, notificaciones de texto y fin `end_turn` | `discovery.json` |
| Modelos reales | `models.availableModels` devuelve 27 variantes; `configOptions` devuelve 11 opciones base de modelo y niveles dependientes del modelo | `discovery.json` |
| Selección de modelo | Cambio oficial a `gemini-3.8-flash`, razonamiento bajo y respuesta `F0-MODEL-OK` | `capabilities.json` |
| Persistencia CLI | Cierre del proceso, nuevo proceso, `session/load` con el mismo ID, replay del primer turno y recuerdo exacto del marcador | `lifecycle.json` |
| Reanudación sin replay | `session/resume` aceptado | `capabilities.json`; no sustituir el historial visible por un replay inexistente |
| Herramientas | Lectura nativa del archivo sintético, eventos `tool_call` y `tool_call_update` y respuesta con su contenido | `lifecycle.json` |
| Escritura rechazada | Petición real `session/request_permission`; respuesta de cancelación del permiso, herramienta fallida y archivo ausente | `lifecycle.json` |
| Cancelación | `session/cancel` durante una autorización pendiente, fin `cancelled`, archivo ausente y siguiente turno `F0-RECOVERED` | `lifecycle.json` |
| Error recuperable | Modelo deliberadamente inválido rechazado con `-32602`; selección válida y turno posterior correctos | `capabilities.json` |
| Acceso externo | Lectura y escritura nativas a segundo proyecto sintético pidieron permiso; se rechazaron, no devolvió contenido ni creó archivo | `boundaries.json` |
| Salida estructurada puntual | `agy --print ... --json-schema ... --output-format json`, salida 0 y campo `structured_output` correcto | `structured.json` |
| Consumo | `session/prompt.result.usage` incluye tokens; `usage_update.used/size` informa contexto | `discovery.json`; el adaptador actual solo guarda el segundo |

`verify.py` comprueba 28 propiedades sobre las capturas reales. Son propiedades de un conjunto acotado de escenarios, no 28 recorridos integrales de producto. La lista de modelos procede de la cuenta, pero no se ha ejecutado cada modelo ni comprobado su cuota individual. No se anunció opción automática de modelo en las opciones observadas. No se ha probado login nuevo ni API key: se verificó reutilización de cuenta existente.

No se encontró una interfaz de cuota estructurada verificada en la negociación ACP observada. La documentación de `/usage` describe un panel TUI. No se debe raspar ese panel ni inferir una cuota del plan a partir del contexto o tokens. Mostrar «no disponible» hasta confirmar una interfaz oficial utilizable. No se ejecutó una actualización para no alterar la versión auditada.

## Seguridad: condiciones antes de habilitar ejecución

1. **ACP no es un sandbox.** La especificación lo declara expresamente. Anunciar `fs: false` y `terminal: false` impide operaciones del cliente; no elimina herramientas nativas del agente.
2. Las negativas observadas son evidencia de los casos concretos, no una garantía universal. `--sandbox` protege terminal según las reglas del proveedor y tiene rutas temporales/cachés permitidas. No demuestra que todas las herramientas de archivo, MCP, navegador o subagentes queden confinadas al proyecto.
3. El adaptador actual hereda configuración de CLI y solo interviene cuando recibe solicitudes. Antes de habilitar Antigravity, verificar un perfil efectivo por sesión mediante mecanismos oficiales que impida eludir política con herramientas nativas, reglas globales preaprobadas, Git directo y subagentes internos. Las personalizaciones oficiales ofrecen listas de herramientas, pero su aplicación exacta al agente principal ACP está pendiente de prueba. Si no se puede demostrar el control, bloquear la capacidad afectada; no presentar un prompt como una protección.
4. Mantener permisos y alcance al delegar, comprobar rutas canónicas y symlinks, separar investigación de lectura e implementación autorizada y fijar límites por proyecto/proveedor. Los ejecutores delegados deben recibir las mismas restricciones de commits, push, merge y subdelegación que Claude/Codex.
5. Autenticación por CLI oficial; no copiar tokens a Filigranas. Si se incorpora API key opcional, escritura directa en almacén seguro y entrega solo al proceso hijo, con eliminación del entorno heredado incompatible. No persistir payloads de autenticación ni transmitirlos al frontend, logs o notificaciones. Diagnóstico estructurado y redactado.
6. Cancelar permisos pendientes, esperar terminación de turno, cierre de sesión/stdio gradual y terminación del árbol solo como respaldo acotado. Probar guardado ante cierre y recuperación sin cambiar el ID silenciosamente. Corregir también los caminos de error de arranque y cierre.

**Antigravity permanece ejecutor.** No hay demostración de herramientas de coordinación Filigranas ni de restricción de ejecución directa suficiente para habilitarlo como PM.

## Plan propuesto: F1–F5

### F1 · Adaptador sobre la arquitectura existente

- Añadir un registro común pequeño de proveedores/capacidades que distinga identidad (`agy` existente), empresa, transporte, roles, modelos y operaciones soportadas. No crear otro sistema de sesiones/delegación ni refactorizar todo `claude.rs`.
- Especializar el lanzamiento/negociación Antigravity dentro del ACP compartido en Rust. Conservar errores JSON-RPC tipados y contratos existentes de eventos, turnos, resultados y cancelación. No introducir un cliente Python en producción.
- Descubrir capacidades y catálogos con la cuenta real; validar cambios contra opciones ofrecidas y actualizar capacidades dinámicas. Mantener modelo, esfuerzo y contexto separados. API key opcional; cuenta Google suficiente cuando funciona.
- Persistir ID y opciones sin renombrar sesiones. Recuperación fallida debe devolver un error recuperable y conservar la identidad; creación de sesión nueva solo mediante acción explícita. Usar `load` para replay y `resume` cuando exista transcript local.
- Añadir almacenamiento aditivo del transcript visible/resultados por sesión y turno, si el almacenamiento común no basta, evitando duplicados de replay. Guardar tokens del resultado final con su semántica real, además del contexto.
- Estado de conexión/autenticación obtenido por operación oficial y caché; fallos de red distintos de falta de cuenta. Actualizar con `agy update` bajo el bloqueo común. No arrancar procesos ACP en cada render/consulta.
- Puerta de salida: pruebas reales Rust de nueva sesión, streaming, recuperación, opciones, persistencia y cancelación. Ejecución de producto sujeta a F2.

### F2 · Herramientas, reglas y seguridad efectiva

- Validar mecanismos oficiales de configuración por sesión/agent para restringir herramientas, configuración heredada y subagentes. Negar capacidades no controlables. Forzar sandbox cuando esté disponible y verificarlo; nunca sustituirlo por una etiqueta de worktree.
- Reutilizar `runs::begin`, `work::before_turn`, `isolate`, `autoapprove`, aprobaciones y catálogo de skills. Asignar worktree autorizado según tarea; no asumir que la subsesión heredada ya está aislada.
- Ensayar lectura, escritura denegada, escritura permitida, rutas externas, symlinks, terminal/Git, MCP y subagentes con reglas globales que intenten interferir. No habilitar PM.
- Cierre gradual, grupos de procesos, cancelación con timeout, no procesos huérfanos, límite por proveedor e inactividad sin detener turnos al cambiar de vista/proyecto.
- Puerta de salida: controles comprobados tanto en el proveedor como en Rust; cualquier hueco bloquea la capacidad afectada.

### F3 · PM, Jev y herramientas del proyecto

- Conservar las herramientas de `delegate.rs` y los dos PM actuales. Completar asociación obligatoria proyecto/tarea/padre/subsesión/turno para ambos, incluyendo raíz de coordinación Codex y manejo de errores transaccionales. Resultado durable consultable por PM tras reconectar.
- Generalizar el punto de selección de Jev en la admisión de la delegación: candidatos reales por autenticación, capacidad, rol, modelo, cuota conocida, concurrencia y política. No insertar ejecución técnica en Jev. Mantener señales categóricas/consentimiento y respaldo local; costes desconocidos quedan desconocidos.
- Persistir selección, motivo, intento, resultado y motivo de fallback en las trazas comunes que ya consume Flow. Fallback previo al arranque cuando sea seguro; después de efectos persistentes, reconciliar estado y exigir un punto de continuidad seguro antes de delegar de nuevo. Sin reintento ciego ni trasplante de estado interno.
- Flow: proveedor/modelo/duración/estado real, prompt delegado y navegación a la subsesión desde inspector. Entrega: trazabilidad y ciclos de corrección por el PM, verificaciones y commits de Larry. Brain: procedencia por ejecución y aislamiento. Studio: generación estructurada puntual con el modo headless probado; capturas/imagen solo tras prueba específica.
- Puerta de salida: delegación real desde Claude PM y Codex PM, resultados recuperados, elección real de Jev y estados verificables en Flow/Entrega.

### F4 · Compositor, Ajustes y consumo

- Proveedores visibles de ejecución: Claude Code/Anthropic, Codex/OpenAI y Antigravity/Google. Conservar registros y compatibilidad de motores históricos. Tipo de proveedor ejecutor distinto del tipo PM permitido.
- Extender `ModelConfigMenu`, `ProviderLogo`, `Tools`, Ajustes e IPC desde metadatos/capacidades compartidos. Sin modelo automático o razonamiento si no se ofrece. Seleccionar otro proveedor abre/recupera una sesión compatible o utiliza el relevo común con contexto explícito; nunca reutiliza un ID interno incompatible ni añade un tercer caso al intercambio binario de opciones de `chat.rs`.
- Fuente oficial para el logo de Antigravity y su variante monocromática; no usar el monograma actual como sustituto. Estado inferior en orden Claude → Codex → Antigravity: logo neutro, barra discreta y porcentaje **utilizado**, alineado, sin nombres ni puntos de color permanentes. Mantener CPU/RAM/Jev.
- Unificar `EngineUsage`, `Usage` y Ajustes en semántica de consumo usado. Estados conocidos/agotado/desconocido/desconectado/desactualizado explícitos, con hora/fuente. Sin 0 % ficticio ni media de cuotas independientes. Si se representa una ventana concreta, identificarla en tooltip/desplegable.
- Desplegable sobre superficies/tokens `--menu-*`: conexión, ventanas, modelos/grupos, renovación, frescura, configuración y diagnóstico. Caché compartida y refresco acotado por eventos, apertura manual y caducidad; sin polling intensivo.
- Errores operativos en el centro de notificaciones existente. No tocar AmbientField, Liquid Glass, marco nativo ni semáforo.

### F5 · Aceptación y entrega

- Preparar dependencias con `pnpm install --frozen-lockfile`; ejecutar `pnpm build`, pruebas frontend pertinentes y Rust/Clippy. Registrar base, versiones, perfil y estado del árbol. Pruebas simuladas separadas de las reales.
- Repositorio de pruebas controlado, datos de desarrollo separados y Tauri nativo desde el repositorio, sin otra `.app` ni reemplazar la instalación. Verificar reinicio SQLite, concurrencia de los tres motores, navegación durante ejecución y recuperación.
- Cubrir todas las pruebas obligatorias del encargo: detección/cuenta/modelos, conversación/continuación/streaming/cancelación, errores, reinicio, negativas, lectura e implementación en worktree, ambos PM, resultados, Jev, Flow, Entrega, cuota agotada/proveedor ausente, aislamiento y no regresión Claude/Codex.
- El agotamiento real depende de una condición real del proveedor; no consumir deliberadamente la cuenta para forzarlo. Si no ocurre durante la aceptación, marcar pendiente y separar la prueba de contrato/simulación.
- Recorrido real: PM → investigación Claude → implementación Antigravity → auditoría Codex → corrección delegada → verificación → commit Larry, con vínculos y evidencia nativa. Los commits de Filigranas se agrupan por unidad con hooks y sin coautoría; push/merge requieren autorización propia.
- Capturas reales de compositor, Ajustes, barra/desplegables. Medir CPU/RAM/procesos en reposo, tres turnos simultáneos y después de cancelación/cierre; informar método y valores observados.

## Estado de entrega en F0

- **Implementado:** solo sondas, evidencia e informe; ninguna capacidad nueva de producto.
- **Verificado:** handshake y escenarios reales de CLI detallados arriba; 28 comprobaciones de evidencia. Es factible construir el adaptador oficial.
- **No verificado:** integración Rust/Tauri nueva, autenticación desde cero, cuotas estructuradas, todos los modelos, imágenes, contención universal y subagentes, delegaciones completas, Jev multiproveedor, Flow/Entrega nativos, migraciones/reinicio de Filigranas, concurrencia triple, rendimiento y diseño final. No se declara superada la matriz de F5 ni la ausencia de regresiones.
- **Cambios:** únicamente esta carpeta en el worktree de auditoría. No se han ejecutado build/instalación de Filigranas porque no se ha cambiado la aplicación. No hay capturas de una interfaz que aún no está implementada.
- **Commits:** ninguno nuevo; rama independiente preparada, sin push ni merge.

## Reproducción de las sondas

Requiere `agy` autenticado, Python 3 y red. Consume tokens reales. Mantener los permisos denegados; nunca añadir `--dangerously-skip-permissions`. Los scripts usan rutas temporales sintéticas fijas y no son un cliente de producción.

```sh
cd /private/tmp/filigranas-antigravity-f0
mkdir -p /private/tmp/filigranas-agy-fixture
git init -q /private/tmp/filigranas-agy-fixture
python3 docs/antigravity-f0/probe.py
python3 docs/antigravity-f0/lifecycle.py
python3 docs/antigravity-f0/capabilities.py
python3 docs/antigravity-f0/boundaries.py
python3 docs/antigravity-f0/verify.py
```

La CLI conserva las conversaciones de prueba en su almacenamiento oficial. Los logs de proveedor quedan en el fixture local y no se incluyen como evidencia versionable; las capturas JSON solo recogen protocolo, catálogo y operaciones sintéticas. No se abrió ni exportó el almacén de credenciales.

## Fuentes oficiales consultadas

- [Google: ACP para CLI](https://antigravity.google/docs/cli/acp).
- [Google: clientes ACP, autenticación y flags](https://antigravity.google/docs/ide/extensions/acp).
- [Google: permisos](https://antigravity.google/docs/permissions).
- [Google: sandbox de terminal](https://antigravity.google/docs/sandbox/).
- [Google: cuotas `/usage`](https://antigravity.google/docs/cli/commands/usage/).
- [Google: modo no interactivo](https://antigravity.google/docs/cli/headless/).
- [Google: agentes personalizados](https://antigravity.google/docs/subagents/).
- [ACP v1: protocolo](https://agentclientprotocol.com/protocol/v1/overview).
- [ACP v1: sesiones](https://agentclientprotocol.com/protocol/v1/session-setup).
- [ACP v1: configuración](https://agentclientprotocol.com/protocol/v1/session-config-options).
- [ACP v1: seguridad y modelo de confianza](https://agentclientprotocol.com/protocol/v1/security).

**Siguiente decisión solicitada:** aprobar F1–F5 con Antigravity inicialmente ejecutor y con habilitación condicionada a las pruebas de seguridad de F2. Si no puede controlarse una herramienta mediante mecanismos oficiales, queda deshabilitada y se documenta el bloqueo.
