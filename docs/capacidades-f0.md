# Capacidades, extensiones y especialización de agentes — F0

Auditoría del 28 de noviembre de 2026 sobre `feat/entrega-reestructuracion-visual` (`7988c91` más cambios sin confirmar de Entrega de otro frente). No se ha modificado código. Las cifras de tokens son estimaciones (bytes ÷ 4) hasta medirlas con ejecuciones reales en F1.

Estados usados: **implementado** (código y prueba), **parcial**, **simulado** (solo demostración), **ausente**.

## 1. Arquitectura actual

### Cómo llegan hoy las instrucciones a un agente

| Capa | Fuente | Claude Code | Codex | Antigravity (ACP) |
|---|---|---|---|---|
| Reglas `reglas.md` (986 B) | `skills::RULES` | `--append-system-prompt` (`claude.rs:310`) | `developerInstructions` (`codex.rs:29`) | **no llega** |
| Política del PM `politica.md` (3,6 KB) | `include_str!` | solo PM (`claude.rs:314`) | PM y `retire_persona` (`codex.rs:32,41`) | no aplica |
| Prompt de ejecutor o subsesión | `system_prompt` (`claude.rs:147`) | sí | texto propio más corto (`codex.rs:30`) | **no llega** |
| Catálogo de skills del turno | `with_catalog` (`skills.rs:117`) | añadido al mensaje (`claude.rs:875`) | añadido al mensaje (`codex.rs:705`) | añadido al mensaje (misma ruta que Claude) |
| Historial archivado | `chat::with_context` (`chat.rs:100`), hasta 18 000 caracteres | sí, si el turno previo no terminó | sí | sí |
| Configuración personal del proveedor | CLI del proveedor | **hereda** `~/.claude/CLAUDE.md`, 8 skills de usuario (19 KB) y plugins | **hereda** `~/.codex/AGENTS.md` | desconocido |
| `AGENTS.md` del proyecto | CLI del proveedor | sí (cwd) | sí (cwd) | desconocido |

**Conclusión principal.** Una skill de Filigranas nunca se carga: el backend solo añade al mensaje una línea con nombre, descripción y ruta del `SKILL.md`, y el modelo decide si lo abre. Nada registra si lo abrió. Hoy no se puede demostrar el estado «Cargada».

### Componentes revisados

| Componente | Estado | Evidencia |
|---|---|---|
| Matriz de skills por rol en Ajustes | implementado; llega al motor como catálogo | `skills.rs:91,134`, pruebas `turn_catalog_*`, `Settings.tsx:99` |
| Ámbitos | global y proyecto; **sin** sesión ni tarea | tabla `skill_assignments(scope, role, skill)` |
| Roles | 7: `pm, researcher, designer, senior, junior, auditor, auditor2` | `skills.rs:44` |
| Delegación | `delegar`, `continuar_sesion`, `estado_sesiones`, `esperar_sesion`, `asignar_archivos` | `delegate.rs:27`, `TOOLS_VERSION = 4` |
| Motores en la delegación | **5**: claude, codex, opencode, agy, devin | `delegate.rs:17,38,109` |
| PM con Claude | restricción técnica: sin Bash, Edit, Read, Glob, Grep, Web, Agent ni Task | `claude.rs:326` |
| PM con Codex | sandbox `read-only`: puede **leer** archivos y ejecutar comandos de lectura | `codex.rs:49` |
| Jev | parcial. Solo turnos automáticos de tareas del coordinador Codex. Decide el esfuerzo (low/medium/high) y da consejos categóricos de complejidad, revisión, contexto y modelo ligero. No elige rol, proveedor ni capacidades. Recurre a reglas locales y registra la traza en `jev_routes` | `jev/mod.rs:420`, `codex.rs:719` |
| Consentimiento de Jev | ligado a `jev.routing.v1`; el código exige un ajuste nuevo si cambian los datos enviados | `jev/mod.rs:15` |
| Flow | ejecuciones reales con traza de Jev. La demostración está marcada como tal. Sin datos de capacidades | `Flow.tsx:20,49,166` |
| Entrega · Auditorías | `health_runs` y hallazgos con revisión. Marca la evidencia obsoleta si cambia HEAD o el árbol | `AuditsView.tsx:22` |
| Studio | pantallas, capturas, referencias, revisión y `design_send` a un agente. Sin capacidades | `design.rs:558` |
| Compositor | el menú + solo adjunta imágenes, archivos y enlaces | `Conversation.tsx:759` |
| MCP | solo el servidor interno `filigranas`. No gestiona MCP externos, hooks ni plugins | `claude.rs:335` |
| Herramientas | estado, inicio de sesión y actualización de CLI, incluidos OpenCode y Devin | `tools.rs:45` |
| Permisos `full` | aprueban cualquier ruta, incluso fuera del proyecto | `autoapprove.rs:94`, prueba en `:187` |
| Larry | módulo propio con script y reglas de commit; no es un rol | `larry.rs:19` |

## 2. Inventario de skills internas

Todas se compilan en el binario con `include_str!` y se copian como recurso. Tamaños en bytes.

| Skill | Tamaño | Responsabilidad | Roles por defecto | Carga | Solapes y problemas | Propuesta |
|---|---|---|---|---|---|---|
| `implement` | 455 | flujo real, datos persistidos, migración SQLite | senior, junior | catálogo por turno | solapa con la regla 2 y con Ponytail | conservar como método de rol; Ponytail aporta la simplicidad |
| `debug` | 379 | reproducir, primer punto de divergencia, regresión | senior, junior | catálogo | ninguno | conservar |
| `design-loop` | 461 | capturas antes y después, medidas aprobadas, semáforo | designer, **senior** | catálogo | la norma del semáforo se repite en `AGENTS.md` (lo detecta `rule_status`) | conservar en el diseñador y el verificador visual; sacarla del senior |
| `code-review` | 434 | hallazgos con evidencia y severidad | auditor, auditor2 | catálogo | solapa con `ponytail-review` | conservar como método base del auditor |
| `github-flow` | 466 | ramas, commits, PR y merge | **pm** | catálogo | contradice que el PM no opera Git y que los ejecutores dejan Git a Larry | retirarla del PM; queda como referencia de Larry y de Entrega |
| `research` | 374 | fuentes, versiones, fechas | **pm**, researcher | catálogo | el PM con Claude no puede abrirla (Read bloqueado) | solo investigador |
| ref. `semaforo-macos.md` | 759 | norma de ventana | vía design-loop | bajo demanda | duplicada en `AGENTS.md` | una sola fuente |
| ref. `larry.md` | 1 510 | agrupación y mensajes de commit | Larry | `larry.rs` la incrusta | ninguno | conservar |
| `reglas.md` | 986 | 10 reglas de trabajo | todos menos ACP | system prompt | la regla 1 («ejecuta cambios simples directamente») contradice la política del PM | separar políticas fundamentales y reglas de ejecutor |
| `politica.md` | 3 633 | coordinación del PM | PM | system prompt | cita Devin y OpenCode; recomienda motores fuera del alcance | reescribir con los tres motores |

Evidencia de uso real: ninguna. No hay telemetría de lectura de `SKILL.md`.

## 3. Matriz de responsabilidades (propuesta frente a lo actual)

| Rol pedido | Rol actual | Acción |
|---|---|---|
| Project Manager | `pm` | conservar; quitar skills técnicas |
| Arquitecto | no existe | añadir `architect` |
| Programador sénior y júnior | `senior`, `junior` | conservar |
| Diseñador UI/UX | `designer` | conservar |
| Diseñador gráfico | no existe | añadir `graphic` |
| Investigador | `researcher` | conservar |
| Auditor de seguridad | `auditor` (genérico) | añadir `security` |
| Auditor de calidad | `auditor`, `auditor2` | `auditor` = calidad; `auditor2` = segundo revisor independiente (Goldfish) |
| Verificador | no existe | añadir `verifier` |
| Analista de datos | no existe | añadir `data` |
| Larry | módulo | sigue fuera de la enumeración de roles |

Los roles son perfiles (una fila de `Role`), no procesos.

## 4. Duplicidades y contradicciones

1. **Cinco motores frente a tres.** `delegar`, `politica.md` y `tools.rs` ofrecen OpenCode y Devin.
2. **PM con skills técnicas.** La matriz por defecto da `github-flow` y `research` al PM. Además, el PM de Claude no puede leerlas y el de Codex sí puede leer el repositorio, cuando la política lo prohíbe.
3. **Regla 1 frente a la política del PM.** El PM recibe «Ejecuta cambios simples directamente».
4. **Antigravity sin políticas.** Una subsesión `agy` no recibe reglas, ni la prohibición de delegar, ni la de hacer commits.
5. **Configuración personal heredada.** Cada sesión de Claude carga tu `CLAUDE.md` global (que escribe en el vault de Obsidian, fuera del proyecto) y tus 8 skills. Entre ellas está `filigrana`, con un modo «delega» en claude, codex, opencode o agy que compite con `delegar`. Codex hereda tu `AGENTS.md` global. Esto escapa a la precedencia de Filigranas y al aislamiento de proyectos.
6. **Simplicidad en tres sitios.** La regla 2, `implement` y la skill personal `filigrana` repiten el principio de Ponytail.
7. **Semáforo en dos sitios** (skill y `AGENTS.md`).
8. **Prompts de ejecutor distintos** en Claude y Codex.
9. **`full` sin límite de proyecto.** Choca con «Full Control no implica confiar en extensiones».

## 5. Problemas de carga de contexto

| Elemento | Estimación | Problema |
|---|---|---|
| PM: política, envoltorio y reglas | ≈ 1 300 tokens por sesión | aceptable; contiene contradicciones |
| Ejecutor: prompt y reglas | ≈ 450 tokens | aceptable |
| Catálogo por turno | ≈ 150–250 tokens **por mensaje** | se repite y se acumula en el historial |
| Historial recuperado | hasta ≈ 4 500 tokens | solo si el turno previo quedó incompleto |
| Configuración personal heredada | sin medir; ≥ 350 tokens más las descripciones de 8 skills y 2 plugins | no la controla Filigranas |
| Extensiones propuestas completas | Unslop 32 KB, EGM 106 KB, UI Skills 112 KB, StatsPAI 147 KB | inviable cargarlas enteras |

`task_runs.context_tokens` ya existe. F1 tomará la línea base con ejecuciones reales equivalentes antes de cambiar nada.

## 6. Evaluación de repositorios externos

Commits fijados en la inspección (clonado superficial de solo lectura; no se ejecutó nada).

| # | Repositorio | Commit | Licencia | Contenido real | Ejecutable | Claude / Codex / Antigravity | Encaje |
|---|---|---|---|---|---|---|---|
| 1 | Ponytail | `ebd8654c2c62` (v5.3.3) | MIT | 6 skills (núcleo de 3,5 KB) | hooks JS para Claude y Codex, statusline y un registro en `~/.config/ponytail`; webhook opcional | texto portable a los tres; hooks no | importar `ponytail` y `ponytail-review` como texto; **sin hooks** |
| 2 | Grim Prompter | `2a94457c7bc6` | MIT | 1 skill `threat-model` (5,4 KB) | no | portable | directo |
| 3 | Elephant-Goldfish | `46933754e63c` | Apache-2.0 | 8 skills (106 KB), personas `agents/` y estándares | Python opcional e instalador de OpenCode | depende de subagentes, que Filigranas desactiva (`Agent`/`Task`) | adaptar: Goldfish = subsesión `delegar` nueva sin historial; motor común de tareas |
| 4 | Unslop | `620163eedb35` | **CC-BY-4.0** (exige atribución) | 1 skill de 32 KB | referencias a `node` | portable con presupuesto | cargar por secciones |
| 5 | UI Skills | `49289efa4ce2` | MIT | 12 skills (112 KB) | no en las útiles | portable | solo `baseline-ui`, `fixing-accessibility`, `fixing-motion-performance` e `improve-ui` (≈ 21 KB) |
| 6 | UI UX Pro Max | `11ca2b3bdd55` | MIT | skill de 18 KB y más skills | **`python scripts/search.py`** sobre datos CSV (15 usos); `setup.sh`; `.mcp.json` | texto portable; el script necesita aprobación | importar la skill y aprobar el script aparte |
| 7 | Logo Design | `e9eaddc07895` | MIT (más `TRADEMARKS.md`) | skill de 17,6 KB | **Python**: `svg_audit`, `render_png`, `export_variants`… | igual | `svg_audit` como evidencia; revisar licencias de referencias |
| 8 | PixelFX | `5294518ce7c7` | MIT | skill de 12 KB y una librería Node con 244 efectos | **`npm i`**, `tools/*.mjs`, ffmpeg opcional | igual | opcional, solo por proyecto |
| 9 | Agent Reach | `8d9ecc1f5521` (renombrado `Panniantong/Agent-Reach`) | MIT | CLI Python con canales (X, Reddit, YouTube, GitHub, LinkedIn, Xiaohongshu…) y skill de 7,9 KB en chino | **CLI y `login` con cookies** | herramienta externa | alto riesgo: credenciales y términos de uso. Opcional y por canal |
| 10 | Claude Code Setup | `claude-plugins-official@0fbfda5a91f4` | Apache-2.0 | 1 skill de recomendaciones y 5 referencias | no | **solo Claude**; incompatible con Codex y Antigravity | recomendaciones revisables en Ajustes |
| 11 | StatsPAI | `943f4a0d1320` (muy activo) | MIT | paquete Python (numpy, pandas, scipy, statsmodels, numba, sklearn…), servidor MCP, skills de 10,8 y 147 KB | **Python y MCP** | MCP en Claude y Codex; ACP desconocido | opcional, entorno virtual por proyecto, MCP solo con el rol `data` |

### Referencias arquitectónicas (inspección de metadatos y estructura; el análisis profundo queda para F8)

| Repositorio | Commit | Licencia | Valoración preliminar |
|---|---|---|---|
| Tether | `402bbaf02198` | Apache-2.0, Rust | 1 estrella: madurez insuficiente como dependencia. Ideas: política declarativa y traza reproducible |
| DeepCode | `bfe34b668831` | MIT, Python | orquestador propio: no adoptar. Ideas: bucle implementar-reparar y recuperación estructurada |
| OmniRoute | `3e23a8afe026` | MIT, TS | pasarela de 375 proveedores, contraria al alcance. Ideas: respaldo según cuota e interruptores de error para Jev |
| Munder Difflin | `e0570ef859ff` | MIT más `LICENSE-ASSETS` | Electron. Ideas de organización de sesiones; no copiar recursos visuales |

## 7. Arquitectura propuesta

### Precedencia (se resuelve antes de cada turno)

1. **Políticas fundamentales**, aplicadas en Rust: herramientas por rol, sandbox, rutas, aprobaciones, Git solo con Larry, PM sin ejecución.
2. Instrucción del usuario en el turno.
3. `AGENTS.md` del proyecto.
4. Skill interna de rol.
5. Extensiones seleccionadas.
6. Brain y resultados previos, como **datos**, nunca como instrucciones.

Las extensiones no pueden ampliar herramientas ni permisos. Se insertan en una sección delimitada como «material de referencia no confiable subordinado a las políticas».

### Backend: `capabilities.rs`, que reutiliza y amplía `skills.rs`

- **Registro**: las 6 skills internas pasan a ser extensiones `builtin`. Las externas se guardan en `<app_data>/extensions/<id>/<commit>/` con su manifiesto y el SHA-256 de cada archivo.
- **Manifiesto** (JSON): incluye los campos del encargo. Añade `entry` (núcleo que se inyecta), `resources` (bajo demanda), `executables[]` (con ruta y hash), `evidence` (contrato verificable) y `providers{claude, codex, agy: direct | adapted | partial | none}`.
- **SQLite** (migración aditiva): `extensions`, `extension_versions`, `extension_policies(scope, role, task_kind, ext, policy)`, que sustituye a `skill_assignments` migrando sus filas, `capability_selections(run_id, ext, version, origin, state, reason)` y `capability_evidence(run_id, ext, kind, ref, revision, verified)`.
- **Resolución determinista** `resolve(task_kind, role, provider, project, session, manual) → {selected, blocked, warnings}`. Orden: desactivada > incompatible con el proveedor > obligatoria (si falta, bloquea con motivo) > manual > automática dentro del presupuesto.
- **Carga real**: el backend inyecta el núcleo de cada extensión seleccionada (no una ruta) y registra el hash inyectado. Eso demuestra «Cargada» sin depender de lo que declare el modelo. En Claude va en el prompt al arrancar el proceso, para aprovechar la caché; en Codex en `developerInstructions` o en el turno; en ACP en el turno. Los recursos quedan en disco con ruta para consultarlos bajo demanda.
- **Presupuesto por rol** configurable. Si se excede, se conserva lo obligatorio, se recorta lo automático y se avisa.

### PM y Jev

- `delegar` gana `tipo` (enumeración de la matriz del apartado 9 del encargo) y `capacidades` (manual), y pierde OpenCode y Devin. Sube `TOOLS_VERSION`.
- Jev añade, solo para candidatas **automáticas** ya filtradas localmente, una pregunta categórica de recomendación. Requiere el consentimiento nuevo `jev.routing.v2`. No puede tocar obligatorias, desactivadas ni permisos. La traza guarda origen, alternativas y respaldo. Las decisiones deterministas no consultan Jev.

### Evidencias por estado

| Estado | Prueba |
|---|---|
| Disponible | registro e integridad válidos |
| Seleccionada | fila en `capability_selections` con su origen |
| Cargada | hash inyectado en el turno |
| Aplicación evidenciada | el contrato del manifiesto se cumple con artefactos o eventos reales: informe con referencias a código que existen en la revisión (Grim); SVG y `svg_audit` (Logo); especificación, ≥ 2 subsesiones Goldfish distintas y resolución (EGM); herramientas invocadas en los eventos del proveedor (Agent Reach, StatsPAI); estadísticas del diff y revisión (Ponytail); capturas antes y después de Studio (Unslop) |
| Verificada | lo valida un verificador o auditor distinto, o una comprobación del backend |

Si se carga pero no hay evidencia, se marca como tal y nunca se infiere.

### Interfaz (Trama v2, sin iconos de navegación nuevos)

- **Ajustes**: «Skills y reglas» pasa a «Extensiones», con pestañas Skills · Plugins · MCP · Herramientas · Flujos, matriz rol × capacidad con política y catálogo de las 11 (instaladas o disponibles).
- **Compositor**: una entrada «Capacidades» en el menú + existente y fichas discretas que se pueden quitar, con su origen (usuario, automática u obligatoria).
- **Flow**: sección «Capacidades» en el inspector flotante y eventos en la actividad inferior.
- **Studio**: fases (dirección, identidad, implementación, revisión, efectos) que alimentan `design_send`.
- **Entrega**: los informes de Grim y EGM entran en `health_runs` con su revisión, y se reutiliza la detección de obsolescencia.
- **Brain**: solo decisiones, especificaciones aprobadas y hallazgos, con procedencia y versión.

### Seguridad de extensiones

- Importar significa copiar archivos de un commit fijado sin ejecutar nada.
- Los ejecutables se aprueban uno a uno y por hash, y solo corren mediante las herramientas del proveedor con los permisos de la sesión.
- Ninguna variable de entorno lleva credenciales. Una actualización que pida más permisos exige aprobarla de nuevo. Hay revocación y registro de operaciones.
- `full` no aprueba ejecutables de extensiones no aprobadas ni rutas fuera del proyecto.

## 8. Plan de migración

1. **F1 primero corrige la base**: políticas en ACP, prompt común de ejecutor, PM sin skills técnicas, tres motores en `delegar` y la decisión sobre la configuración personal heredada. Mide la línea base antes y después.
2. Migrar `skill_assignments` a `extension_policies` conservando cada fila guardada. La matriz de Ajustes sigue mostrando lo mismo.
3. Pasar del catálogo de rutas a la inyección de núcleos solo después de medirla.
4. Integrar las extensiones por fases (F4–F7), cada una con su contrato de evidencia y pruebas.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| Este árbol tiene trabajo de Entrega sin confirmar de otro frente | empezar F1 en un worktree desde `main` cuando ese trabajo se integre |
| Reparaciones pendientes de PM, permisos, Jev y Antigravity | F1 las verifica antes de construir encima; no avanzar con bloqueos críticos |
| Tamaño de EGM, UI Skills, Unslop y StatsPAI | núcleo más recursos bajo demanda y presupuestos |
| Ejecutables (Python, Node, CLI y MCP) | aprobación por hash, nunca al importar |
| Licencias: Unslop CC-BY-4.0 y referencias de logotipos | atribución visible y revisión separada |
| Agent Reach: credenciales y términos de plataformas | opcional, por canal, credenciales del usuario y solo lectura |
| Cambio del consentimiento de TypeSafe | `jev.routing.v2` con consentimiento explícito |
| Pruebas nativas con 3 proveedores autenticados | necesitan tus cuentas, tiempo y consumo; se programan en F9 |
| Claude Code Setup es solo de Claude | se declara incompatible en Codex y Antigravity |

## 10. Fases, pruebas y criterios de aceptación

| Fase | Entregable | Aceptación |
|---|---|---|
| F1 | políticas, roles nuevos, prompts unificados, ACP con políticas, PM limpio, 3 motores | pruebas Rust de precedencia y de herramientas por rol; un turno real de `agy` recibe las políticas; tokens medidos antes y después |
| F2 | registro, manifiestos, importación fijada, integridad, ámbitos y Ajustes | importar desde Git y local sin ejecutar; hash alterado ⇒ bloqueo; más permisos ⇒ nueva aprobación; reinicio conserva versiones |
| F3 | resolución, `delegar` con `tipo`, Jev v2, inyección, estados en Flow | los 9 casos de selección del encargo como pruebas Rust; Flow muestra filas reales |
| F4 | Ponytail, Grim Prompter, Claude Code Setup | escenarios A y B con evidencias en Entrega |
| F5 | Unslop, UI Skills, UI UX Pro Max, Logo, PixelFX y Studio | escenario C |
| F6 | EGM sobre subsesiones | escenario D con Goldfish sin historial heredado |
| F7 | Agent Reach y StatsPAI (MCP opcional) | herramientas invocadas registradas; sin dependencias globales |
| F8 | informe de Tether, DeepCode, OmniRoute y Munder Difflin | propuestas justificadas, sin dependencias nuevas |
| F9 | escenarios A–E en Tauri nativo con proveedores autenticados | sin mocks; capturas de Ajustes, compositor, Flow, Studio y Entrega |
