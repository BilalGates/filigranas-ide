# Antigravity nativo — implementación y aceptación parcial

Fecha: 2026-11-28. Base: `7988c91`. Rama independiente `audit/antigravity-f0`, worktree `/private/tmp/filigranas-antigravity-f0`. El usuario aprobó continuar tras F0. No se ha publicado ni integrado la rama ni sustituido la aplicación instalada.

## Diagnóstico

La [auditoría F0](../antigravity-f0/diagnostico-plan.md) documenta adaptadores, sesiones/subsesiones, permisos, persistencia, PM, Jev y herramientas existentes. Antigravity CLI 1.5.18 ofrece `agy acp`, JSON-RPC sobre stdio, protocolo 1, sesiones persistentes, streaming, permisos y configuración dinámica. La cuenta Google existente funciona sin API key. Las sondas y primeras pruebas usaron 1.5.18; la captura final de Ajustes observó 1.5.19 después de un cambio externo de la CLI, sin ejecutar su actualización desde esta prueba. Las sondas reales descubrieron 27 variantes y 11 opciones base; no son un catálogo codificado en producto. Sus límites y la documentación oficial están en F0.

## Implementado

- Adaptación de Antigravity sobre `acp.rs`/`rpc.rs`, no un segundo motor de delegación: negociación, sesiones nuevas, carga/continuación, configuración real, streaming, herramientas, permisos y errores. Una carga fallida conserva la identidad y devuelve error; no crea otra conversación silenciosamente.
- Tabla SQLite aditiva `acp_transcripts`, con transcript visible, opciones y último resultado. No guarda pensamientos ni credenciales. Replay local sin arrancar procesos inactivos; checkpoint antes de notificar el fin del turno. Se mantienen las tablas y motores anteriores.
- Cancelación acotada, cancelación de autorizaciones pendientes, cierre de stdio, terminación del grupo como respaldo, límite de procesos y recolección tras 180 segundos inactivos. Cambiar de vista no cancela el turno.
- Registro compartido de proveedor/empresa/transporte/rol y estado observado. Ajustes detecta CLI, versión y cuenta mediante operación oficial, ofrece `agy acp --login` y la actualización oficial existente. Estado cacheado y diagnóstico sin prompt. No se ha implementado un almacén de API keys opcionales.
- PM Claude/Codex conserva las herramientas comunes y puede solicitar `agy` o `auto`; catálogo consultable mediante `catalogo_proveedores`. Asociación con tarea, padre y subsesión; las tareas delegadas sin copia existente crean worktree. Resultados ACP durables disponibles para el PM.
- Jev selecciona antes de la ejecución entre proveedores autenticados, con observaciones recientes y plazas disponibles, evitando bloqueos de cuota recientes. Conserva política local/activo/sombra, consentimiento y límite del servicio existente. Registra candidatos, proveedor elegido y motivo en la traza común. Costes/cuotas no informados permanecen desconocidos. No traslada ni reintenta ejecuciones con efectos persistentes.
- Workspace y Flow incorporan Antigravity: modelo de ejecución separado del modelo de enrutamiento, prompt delegado, resultado e inspector con acceso a subsesión. Entrega y Brain reutilizan tareas, worktrees, turnos y procedencia existentes; no hay motores nuevos propios de Antigravity.
- Compositor con modelos/razonamiento ofrecidos por la cuenta y permisos restringidos. Un cambio de proveedor que involucra Antigravity crea conversación separada. El PM sigue limitado a Claude/Codex.
- Barra inferior Claude → Codex → Antigravity con logos neutros, barras y porcentaje **utilizado**, sin nombres ni puntos. CPU, RAM y Jev conservados. Desplegables compartidos con conexión, ventanas disponibles, renovación/frescura, modelo afectado y acceso a Ajustes. Desconocido se representa con `—`; contexto y tokens no se convierten en cuota.

Archivos principales: `src-tauri/src/{antigravity,providers,acp,rpc,claude,delegate,jev/mod,runs,tools,db,lib,handoff,cli,chat,autoapprove}.rs`; `src/{providers,ipc,usageStore,App,ModelConfigMenu,ProviderLogo,Session,Tools,Usage,designCanvasAgent}`; `src/trama/{EngineUsage,Flow,SessionBar,Settings,trama.css,shell.css}`. Las rutas y agrupaciones definitivas se consultan en los commits locales.

## Seguridad y límites

Perfil privado por sesión, configuración oficial estricta, sin customizaciones por defecto, MCP/browser/subagentes internos deshabilitados. API keys heredadas retiradas del entorno. Lecturas/escrituras ACP comprueban rutas canónicas; comandos requieren autorización. El modo Full no se ofrece para Antigravity. Roles de investigación/auditoría usan agente sin escritura.

En macOS se aplica además contención de proceso y descendientes: metadatos Git y configuración gestionada protegidos; otros proyectos/worktrees registrados inaccesibles; lectura sola protegida por el sistema; plugins, hooks y MCP del workspace no se activan. Se corrigió experimentalmente la resolución `/var` → `/private/var` en políticas. Un worktree no se trata como frontera de seguridad. La contención no se presenta como protección universal de todos los archivos del usuario: los comandos siguen requiriendo revisión y la CLI conserva sus servicios de autenticación/red oficiales. Ejecución deshabilitada fuera de macOS hasta validar contención equivalente.

Antigravity **no** está habilitado como PM. Studio **no** ofrece aún generación con Antigravity: aunque F0 confirmó JSON estructurado en headless, falta validar su camino de producto con idéntica contención. Tampoco se habilitan inspección visual, imágenes o audio por anunciarse solamente en capacidades.

## Verificado

| Prueba | Evidencia / resultado real |
|---|---|
| CLI, cuenta existente, catálogo | F0 y `native.json`: agy 1.5.18, cuenta autenticada sin key |
| Conversación, streaming, continuación y recuperación tras reiniciar CLI | Sondas reales F0 `discovery.json`, `lifecycle.json`, `capabilities.json` |
| Cancelación y recuperación; opciones inválidas; denegaciones | Sondas F0 reales; no equivalen a aceptación completa de la nueva UI |
| Persistencia Tauri tras reinicio | `native.json` → `recovery`: historial y resultado ACP recuperados de SQLite |
| Sandbox macOS y descendientes | Test ignorado ejecutado explícitamente: `macos_policy_is_effective_for_native_operations_and_descendants`, pasado |
| MCP del workspace no inicia procesos | Test real autenticado sin prompt: `real_antigravity_does_not_autostart_workspace_mcp`, pasado |
| Tres turnos nativos simultáneos | Intento real **no superado**: Antigravity y Claude pausados por cuota; Codex completó y su archivo exacto fue verificado |
| PM, Jev y resultado delegado | PM Codex → `auto` → Codex disponible → resultado recuperado, ambas ejecuciones completadas; `routingPassed: true` |
| Larry | Commit real en fixture: `f0e2792 feat: confirm native test marker`, solo `result-codex.txt`, sin push |
| Interfaz | DOM real de WKWebView: orden de tres proveedores, gris `rgb(188,193,201)`, ancho homogéneo 101 px, cero puntos/nombres; compositor con modelo real |
| Compilación y pruebas | `pnpm install --frozen-lockfile`, `pnpm build`, 55 tests frontend, 168 Rust pasados/12 ignorados; Clippy con `-D warnings` pasado |

Las 28 comprobaciones de `docs/antigravity-f0/verify.py` validan evidencia de sondas; no son 28 pruebas nativas de producto. La suite ordinaria no ejecuta los tests ignorados. No se declaran superados mediante mocks los recorridos reales pendientes.

Reproducción de checks sin consumir modelos:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml antigravity::tests::macos_policy_is_effective -- --ignored
cargo test --locked --offline --manifest-path src-tauri/Cargo.toml antigravity::tests::real_antigravity_does_not_autostart_workspace_mcp -- --ignored
```

La aceptación nativa usa `tests/antigravity_native.mjs` y `tests/antigravity_native_webview.js`, frontend compilado y Tauri IPC real. Identificador exclusivo `com.filigranas.ide.antigravity-acceptance`, perfil SQLite separado y fixture `/private/tmp/filigranas-agy-acceptance/repos/fixture`. `native.json` evita repetir automáticamente turnos ya ejecutados. Un perfil nuevo sí consume modelos y crea commits locales de prueba autorizados. No ejecutar contra repositorios personales ni la instalación de producción.

## Diseño

[Barra inferior, compositor y Flow](barra-compositor.png), [desplegable de consumo](consumo.png) y [Ajustes](ajustes.png): capturas nativas reales. El fixture muestra los bloqueos de cuota auténticos; no se retocaron estados para aparentar éxito. El semáforo inactivo corresponde a una ventana de desarrollo sin foco. No se modificaron AmbientField, Liquid Glass ni el marco de macOS.

## Rendimiento

`native.json.metrics` contiene muestras **globales del Mac**, no consumo atribuible a Filigranas: antes 66,6 % CPU y 83,1 % RAM; durante el intento 37,0–80,5 % CPU y 83,5–84,9 % RAM. Había otras aplicaciones/agentes activos. El solapamiento de arranque fue breve por las cuotas; **no** es una medición válida de tres motores trabajando sostenidamente. Se observó la liberación del proceso ACP tras inactividad. Medición comparativa y prueba de carga triple pendientes.

El último intento de recompilar el binario nativo falló por falta de espacio al escribir la caché incremental. Las capturas posteriores usan el binario de aceptación compilado correctamente antes, con el frontend final. Build frontend y Clippy final sí pasaron; véase `checks.json`. Solo se limpió con `cargo clean` el target temporal accidental de este worktree (62,1 MiB); no se limpiaron targets de otros agentes.

## Pendiente / bloqueos

F5 **no está completada**. La cuenta de Antigravity devolvió `Individual quota reached`; Claude alcanzó su límite semanal. No se reintentaron sus turnos para ocultar el bloqueo.

- Recorrido obligatorio completo PM → investigación Claude → implementación Antigravity → auditoría Codex → corrección → verificación → Larry.
- Delegación nativa efectiva desde ambos PM hacia Antigravity, elección efectiva de Antigravity por Jev, implementación permitida y denegaciones/cancelación en el nuevo camino nativo con modelo disponible.
- Ciclo real de diagnóstico/corrección de PR con Antigravity, procedencia Brain e inspección Flow/Entrega de una tarea Antigravity completada. Flow conserva un contador preexistente que incluye tareas en verificación como «en marcha»; no es evidencia de procesos activos.
- Autenticación desde cero y actualización real de la CLI no se ejecutaron: se reutilizó cuenta instalada y se preservó su versión. API key opcional pendiente.
- Proveedor ausente/desconectado, carreras de reconexión/cancelación y navegación bajo carga: validación nativa completa pendiente. La suite de regresión pasa, pero no demuestra ausencia universal de regresiones.
- Cuotas estructuradas y coste de Antigravity no disponibles por interfaz oficial verificada; sin scraping ni endpoints privados. Un aviso de agotamiento por modelo no representa el porcentaje global.
- Studio, multimodalidad, Antigravity PM y contención de otras plataformas deshabilitados hasta demostración.

## Commits

Producto: `e37e67a feat(providers): integra Antigravity nativo con ACP y permisos` (33 archivos, hooks activos). Auditoría/evidencias se entregan en un commit documental posterior; consultar `git log 7988c91..HEAD`. El commit `f0e2792` pertenece **solo al fixture de aceptación**, no al repositorio de Filigranas. No hubo push ni merge.
