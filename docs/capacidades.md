# Capacidades, extensiones y especialización de agentes

Estado al 28 de noviembre de 2026, rama `feat/capacidades-agentes`. La auditoría previa está en [capacidades-f0.md](capacidades-f0.md). Este documento explica lo que funciona, cómo comprobarlo y lo que queda pendiente.

Estados: **implementado** (código y prueba automática), **verificado con red** (prueba real contra GitHub), **pendiente de validación nativa** (no se ha ejecutado en Tauri con proveedores autenticados).

## 1. Arquitectura

```
encargo ─▶ PM (coordina; Rust le quita herramientas técnicas)
            │ delegar{rol, tipo, capacidades?}
            ▼
      subsesión ejecutora ──▶ capabilities::prepare (antes de cada turno)
                                 1. rol y tipo (indicado › regla local por palabras › tipo del rol)
                                 2. resolve(): desactivada › incompatible › obligatoria › solicitada › automática
                                 3. build(): políticas (ACP) + skill de rol + métodos + núcleos verificados por SHA-256
                                 4. traza en capability_runs (estado, origen, motivo, huella, tokens)
            ▼
      proveedor (Claude / Codex / Antigravity) ──▶ observe_*: herramientas invocadas → capability_tools
            ▼
      usage_for_runs(): contrato de evidencia sobre artefactos reales → Flow, Entrega, Brain
```

Todo pasa por el motor existente (`runs`, `delegate`, `claude`, `codex`, `acp`, `health`, `brain`). No hay un orquestador, gestor de sesiones ni sistema de permisos paralelo.

### Niveles y precedencia

| Nivel | Fuente | Cómo llega |
|---|---|---|
| 1. Políticas fundamentales | `resources/politicas.md` (≈379 tokens) | system prompt en Claude y Codex; primer turno de cada sesión de proveedor en ACP |
| 2. Skill de rol | `resources/roles/*.md` (una línea por rol) y métodos internos (`skills/*/SKILL.md`, sin frontmatter) | bloque administrado del turno |
| 3. Extensiones | núcleo `entry` de cada extensión seleccionada | bloque administrado, delimitado como material de terceros no confiable |
| 4. Proyecto y tarea | `AGENTS.md` (lo carga el CLI), Brain y resultados como datos, encargo delegado | sin cambios |

Precedencia: políticas › mensaje del usuario › `AGENTS.md` › skill de rol › extensiones › memoria y resultados. Las restricciones críticas no dependen del texto: herramientas del PM (`claude.rs`), sandbox de Codex, aprobaciones (`autoapprove.rs`), Git solo con Larry, y permisos de extensiones aprobados por hash.

### Cambios en las skills internas

| Elemento | Acción |
|---|---|
| `reglas.md` | conservada; ya no la recibe el PM (contradecía «delega siempre») |
| `politica.md` del PM | reescrita: tres motores, roles nuevos, `tipo` obligatorio al delegar y flujo Elephant-Goldfish |
| `politicas.md` | nueva: nivel 1 común a todos los ejecutores |
| `github-flow` y `research` | retiradas del PM; `github-flow` queda como referencia de Larry |
| `design-loop` | del senior pasa al diseñador gráfico; el diseñador UI/UX la conserva |
| `debug` | también para el verificador |
| `code-review` | también para seguridad |
| Catálogo de rutas por turno | sustituido por el texto de los métodos y una huella cuando no cambia |
| Roles | 7 → 12: `architect`, `graphic`, `security`, `verifier` y `data` son perfiles nuevos, no procesos |
| Motores de `delegar` | 5 → 3 (se retiran OpenCode y Devin); `TOOLS_VERSION` 5 |
| Configuración personal | el PM y las subsesiones de Claude arrancan con `--setting-sources project,local --strict-mcp-config --disable-slash-commands`; las sesiones directas la conservan. Ajustable en Ajustes › Extensiones › Contexto |

## 2. Registro de extensiones

`src-tauri/src/capabilities.rs` y `resources/extensions/catalog.json`.

- Manifiesto con identificador, tipo (`skill`, `plugin`, `mcp`, `tool`, `flow`…), repositorio, commit fijado, licencia, atribución, SHA-256 y tamaño de cada archivo, compatibilidad por motor, roles, tipos de tarea, política por defecto, permisos, dependencias, presupuesto, incompatibilidades, condición de Filigranas (`guard`), criterio de aplicación y contrato de evidencia.
- Almacén: `<app_data>/extensions/<id>/<commit>/`. Cada lectura comprueba el hash; un archivo alterado bloquea la carga y se notifica.
- Instalar o importar (GitHub o carpeta local) solo copia archivos. No se ejecuta ningún script.
- Permisos distintos de `context` (`exec:python3`, `network:npm`…) necesitan aprobación expresa. Una actualización que añade permisos los deja pendientes. El control total de una sesión no los aprueba.
- Ámbitos de política: sesión › proyecto y rol › proyecto › global y rol › global › manifiesto.
- Registro de operaciones (`extension_log`): instalación, aprobación, política, habilitación, verificación, propuestas a Brain y desinstalación (que revoca solicitudes).

## 3. Estado real de las once integraciones

Las once se descargan e instalan desde su commit fijado con todos los hashes correctos (`cargo test --lib real_catalog_installs -- --ignored`, pasó el 28-11-2026 en 38 s). Por defecto **no** están instaladas: el usuario las instala en Ajustes.

| Extensión | Commit | Licencia | Tipo | Política inicial | Roles | Evidencia que comprueba el backend |
|---|---|---|---|---|---|---|
| Ponytail | `ebd8654c2c62` | MIT | skill | obligatoria en implementación, corrección, refactorización y revisión | senior, junior, calidad | diff real de la sesión (archivos, +/−); queda «evidenciada» hasta que alguien la verifica |
| Grim Prompter | `2a94457c7bc6` | MIT | skill | obligatoria en modelado de amenazas | seguridad, arquitecto | informe `*threat*.md` nuevo; todas sus referencias `archivo:línea` existen; los hallazgos pasan a Entrega con la revisión |
| Elephant-Goldfish | `46933754e63c` | Apache-2.0 | flujo | automática en planificación, arquitectura y revisión independiente | arquitecto, revisor independiente | especificación, ≥ 2 subsesiones `auditor2` completadas y documento de resolución |
| Unslop | `620163eedb35` | CC-BY-4.0 (atribución visible) | skill | automática en auditoría visual | diseñador UI/UX | capturas de Studio posteriores al turno |
| UI Skills | `49289efa4ce2` | MIT | skill (4 de 12) | automática en frontend | diseñador, senior, junior, calidad | diff real |
| UI UX Pro Max | `11ca2b3bdd55` | MIT | skill + `scripts/search.py` | automática en diseño inicial | diseñador UI/UX | documento de dirección visual; el script necesita aprobar `exec:python3` |
| Logo Design | `e9eaddc07895` | MIT | skill + scripts Python | obligatoria en logotipos | diseñador gráfico | SVG nuevos con `viewBox` y cierre correcto |
| PixelFX | `5294518ce7c7` | MIT | skill + librería Node | manual | diseñador gráfico | herramientas invocadas; necesita `exec:node` y `network:npm` |
| Agent Reach | `8d9ecc1f5521` | MIT | herramienta | manual | investigador | invocaciones observadas de `agent-reach`; credenciales y canales del usuario |
| Claude Code Setup | `0fbfda5a91f4` | Apache-2.0 | plugin | automática en configuración del repositorio | investigador | informe de recomendaciones; **incompatible** con Codex y Antigravity |
| StatsPAI | `943f4a0d1320` | MIT | MCP / paquete Python | manual | datos | herramientas invocadas; entorno Python del proyecto, nunca global |

La matriz es configurable por rol, proyecto y sesión en Ajustes › Extensiones › Asignación por rol.

## 4. Compatibilidad por proveedor

| | Claude Code | Codex | Antigravity (ACP) |
|---|---|---|---|
| Políticas fundamentales | system prompt | `developerInstructions` | primer turno de cada sesión del proveedor (antes no recibía ninguna) |
| Skill de rol y núcleos | bloque del turno | bloque del turno | bloque del turno |
| Herramientas observadas | `tool_use` del asistente | `item/started` | `tool_call` |
| Skills de texto | directa | directa | directa |
| EGM | adaptada a subsesiones `delegar` (Claude desactiva `Agent`/`Task`) | adaptada | adaptada |
| Scripts, CLI y MCP | parcial: se ejecutan con las herramientas del proveedor y la aprobación de la sesión | parcial | parcial |
| Claude Code Setup | directa | ninguna | ninguna |

Una extensión incompatible queda «bloqueada: incompatible con X»; no se simula.

## 5. Selección: PM, Jev y reglas locales

- **PM**: indica `tipo` y, si hace falta, `capacidades` al delegar. No puede habilitar una extensión desactivada ni conceder permisos.
- **Reglas locales**: deciden siempre las obligatorias, automáticas, compatibilidad, permisos y presupuesto. Cada fila de `capability_runs` guarda su origen (`politica`, `automatica`, `usuario`, `pm`, `sesión padre`, `Studio`) y el motivo.
- **Jev**: no interviene en las capacidades en esta versión, y Flow lo indica («decisión de reglas locales»). Jev solo enruta los turnos automáticos del coordinador Codex, que no reciben capacidades de ejecutor. Para que eligiera extensiones haría falta una consulta por cada turno de ejecutor y un consentimiento nuevo (`jev.routing.v2`), porque TypeSafe recibiría rol y tipo de trabajo. Esa ampliación de la API no se ha validado con credenciales reales, así que no se presenta como una decisión de Jev. La traza de Jev existente (esfuerzo, complejidad, revisión, contexto) sigue igual.

Las nueve situaciones de selección del encargo tienen prueba: tarea sin mencionar extensiones, automática correcta, obligatoria disponible, obligatoria ausente (bloquea y avisa al agente), desactivada aunque se pida, selección manual, incompatibilidad con el proveedor, conflicto y presupuesto excedido (se conserva lo obligatorio y se avisa).

## 6. Evidencias de utilización

| Estado | Prueba |
|---|---|
| Disponible | instalada, habilitada, hashes y permisos correctos |
| Seleccionada | fila en `capability_runs` con su origen |
| Cargada | el backend leyó el núcleo verificado y registró la huella del bloque inyectado |
| Aplicación evidenciada | el contrato del manifiesto se cumple con artefactos o herramientas observadas |
| Verificada | comprobación automática del contrato (referencias que existen, SVG válido, EGM completo) o aceptación de una persona |

La autodeclaración del agente nunca cuenta. Una extensión cargada sin aplicación demostrable se muestra así. Si cambia `HEAD` después de una verificación, la evidencia se marca como obsoleta.

## 7. Superficies

- **Ajustes › Extensiones** (el apartado «Skills y reglas» con otro nombre, sin icono nuevo): catálogo filtrable por tipo, detalle con procedencia, licencia, compatibilidad, ejecutables y diagnóstico; instalar, habilitar, aprobar permisos, actualizar, restaurar, desinstalar; importación desde GitHub o carpeta; matriz rol × capacidad; presupuesto y aislamiento de configuración personal; registro.
- **Compositor**: entrada «Capacidades…» en el menú + existente con el tipo de trabajo y las extensiones compatibles; fichas discretas en la fila superior que distinguen solicitadas (eliminables), obligatorias y automáticas.
- **Flow**: sección «Capacidades» en el inspector flotante (estado, política, origen, versión y commit, tokens, motivo, evidencias, herramientas, verificación, aceptar o rechazar) y marca de color bajo cada ejecución de la línea temporal. Se conservan las tres vistas.
- **Studio**: selector de fase creativa (dirección, identidad, implementación, revisión, efectos) que fija el tipo del turno de `design_send`; comparar usa la revisión estética.
- **Entrega**: los hallazgos de Grim Prompter entran en `health_runs` con la revisión, el digest y la detección de obsolescencia existente. No hay otro sistema de auditoría.
- **Brain**: aceptar una evidencia propone una entrada `evidence` pendiente de aprobación, con la ejecución, la versión y la revisión como procedencia. No guarda el texto de la extensión.

## 8. Rendimiento y contexto

Medición reproducible con `cargo test --lib measure_context -- --ignored --nocapture` (bytes ÷ 4, no tokens reales del proveedor):

| Rol | Bloque inicial | Turno sin cambios | Núcleos de su tipo por defecto |
|---|---|---|---|
| senior | 274 | 20 | 874 (Ponytail) |
| junior | 250 | 20 | 874 |
| diseñador | 264 | 20 | 4 490 (UI UX Pro Max) |
| arquitecto | 138 | 20 | 4 394 (EGM) |
| investigador | 193 | 20 | 0 |

- Antes, cada mensaje repetía el catálogo de rutas (≈150–250 tokens) y el modelo tenía que abrir el `SKILL.md`. Ahora el bloque completo solo se envía en el primer turno, cuando cambia, cuando cambia la sesión del proveedor o cada 20 turnos. El resto lleva una huella de ≈20 tokens. En una conversación de diez turnos de un senior sin extensiones: ≈1 800 → ≈450 tokens estimados.
- Aislar la configuración personal en el PM y las subsesiones de Claude bajó el contexto inicial de ≈32 400 a ≈13 800 tokens (medido con Claude Code 2.1.332 en este equipo).
- Presupuesto por defecto: 12 000 tokens de núcleos por turno, configurable entre 1 000 y 200 000.
- Ningún servidor MCP ni proceso nuevo arranca por defecto. La resolución es local y no consulta la red. En Codex, las herramientas observadas se registran en un hilo aparte para no bloquear la lectura del proveedor.
- No se ha medido CPU, memoria, latencia ni concurrencia con proveedores reales: queda para la validación nativa.

## 9. Referencias arquitectónicas (F8)

Inspección de solo lectura de los repositorios clonados; no se añade ninguna dependencia.

| Repositorio | Commit | Madurez | Conclusión |
|---|---|---|---|
| Tether | `402bbaf02198` (v0.5.0) | 1 estrella, creado el 17-11-2026, API inestable antes de 1.0 | **No adoptar.** Envuelve un bucle de agente propio (llamada al modelo y a herramientas); los CLI de Filigranas tienen el bucle dentro y no se pueden envolver. Su sandbox `process` se declara no seguro. Ideas útiles: reglas declarativas en orden con «preguntar» por defecto y nombre de regla en la traza; presupuestos que detienen y reanudan; traza reproducible para evaluar prompts. La primera encaja en `autoapprove.rs` cuando se cierre la reparación de permisos. |
| DeepCode | `bfe34b668831` | 16 900 estrellas | **No adoptar** (orquestador propio en Python). Ideas ya aplicadas: una skill nunca concede permisos, cada turno usa una instantánea inmutable (nuestra huella) y las referencias históricas son datos de auditoría, no se reinvocan al reanudar. Idea pendiente: que `allowed-tools` de una skill solo pueda **reducir** herramientas, y el descubrimiento de comandos de verificación del proyecto para el rol verificador. |
| OmniRoute | `5c36ba1c90a6` | 90 800 estrellas, pasarela de cientos de proveedores | **No adoptar** (amplía proveedores, fuera del alcance). Ideas para Jev: clasificar el fallo antes de reintentar (cuota agotada ≠ límite temporal), interruptor `closed/open/half_open` con sonda tras enfriamiento, y estados de cuota veraces (`unknown` no es `exhausted`; una estimación local nunca se presenta como dato del proveedor). Encajan en `jev/mod.rs` y en el selector de motores de `delegar`. |
| Munder Difflin | `384b92e9d5cc` | 10 000 estrellas, Electron | **No adoptar** código ni recursos (`LICENSE-ASSETS`). Confirma decisiones ya tomadas: un solo proceso hace commits (Larry) y los agentes son los CLI reales con la suscripción del usuario. Su pizarra compartida y buzones entre agentes duplicarían la delegación y Brain; no se incorporan. |

SceneView, Sellbird y Evolution API siguen fuera del núcleo.

## 10. Pruebas

| Comando | Resultado (28-11-2026) |
|---|---|
| `cargo test --lib` | 185 pasan, 12 ignoradas |
| `cargo test --lib capabilities` | 21 pasan (selección, carga, evidencias, seguridad, Brain) |
| `cargo test --lib real_catalog_installs -- --ignored` | pasa: las 11 descargan con hashes fijados |
| `cargo clippy --lib --tests` | sin avisos |
| `pnpm build` y `pnpm test` | compilan; 55 pruebas pasan |

## 11. Pendiente y limitaciones reales

1. **Validación nativa (F9) sin hacer.** Los escenarios A–E del encargo necesitan Filigranas en Tauri con Claude, Codex y Antigravity autenticados, repositorios controlados y consumo de tus cuentas. No se han ejecutado y no se dan por superados. Tampoco hay capturas nativas de Ajustes, compositor, Flow, Studio y Entrega; la revisión en navegador no fue posible porque la extensión de Chrome no estaba conectada.
2. **Entrega**: los hallazgos de Grim llegan a Auditorías por `health_runs`, pero no hay vista dedicada de revisiones EGM ni de capacidades. El árbol principal tiene una reestructuración de Entrega sin confirmar de otro frente. La vista se añadirá cuando esa reestructuración se integre, para no pisarla.
3. **Jev** no elige capacidades (ver §5).
4. **PM con Codex**: el sandbox `read-only` le sigue permitiendo leer el repositorio; la prohibición es de política, no técnica.
5. **Permisos `full`** siguen aprobando rutas fuera del proyecto en las herramientas del proveedor (`autoapprove.rs`). Solo las extensiones están protegidas. Se coordina con la rama `fix/p0-permisos-sesiones-jev`.
6. **Ejecutables de extensiones** (Python, Node, CLI y MCP) no se lanzan desde Filigranas: los usa el agente con sus herramientas una vez aprobados. No hay aislamiento adicional al del proveedor.
7. El clasificador por palabras clave es deliberadamente simple. Si no acierta, el tipo se fija en el compositor o el PM lo indica al delegar.
