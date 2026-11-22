# Trama v2 · integración

Rama `feat/trama-v2`, creada a partir de `codex/limpieza-pnpm` (pnpm 11, sin `package-lock.json`). Para volver a la interfaz anterior basta con cambiar de rama; las migraciones son aditivas.

## Fases

| Fase | Commit | Contenido |
| --- | --- | --- |
| 1 · Fundación | `ffc8c23` | Tokens, iconos propios (`src/trama/icons.tsx`), modos de movimiento, campo ambiental, motor de grafos, columna de destinos, Inicio |
| 2 · Workspace | `c5fa457` | Disposiciones chat, dividida y código; acción principal en perla y permisos en ámbar |
| 3 · Flow | `2f497f8` | Ejecución, Dependencias, Lista e inspector con Jev |
| 4 · Studio | `d16e54e` | Lienzo, regiones, comparación, versiones, revisión, encargo y bloqueos |
| 5 · Entrega | `550048a` | Recorrido Git → Larry → revisión → PR/CI; límite de errores por destino |
| 6 · Brain y Ajustes | `e86087a` | Cuatro vistas de Brain, `brain_links` y `skills_list`; Ajustes reales |
| 7 · Pulido | (este commit) | Ventanas pequeñas, rejilla de Inicio, documentación |

## Corrección de fidelidad (segunda pasada)

Los destinos se rehicieron con el marcado y el CSS del propio Artifact. Las comparaciones están en `docs/trama-paridad/`.

- **Navegación duplicada eliminada.** El antiguo panel «Filigranas Brain» (Grafo y Recuerdos) ya no se abre: su botón en la barra de título y su orden llevan al destino Brain, que añade el ámbito «Todos» para la vista entre proyectos.
- **Workspace.** La columna «Conversaciones» sustituye por defecto al árbol de proyectos. El árbol completo, con grupos, archivo y compartir, sigue disponible desde «Proyectos y grupos».

## Marco nativo

No cambia. La barra de título conserva `data-tauri-drag-region` y su reserva de 84 px para el semáforo real de macOS. Los círculos que se ven en el navegador de desarrollo son los del simulador (`html[data-browser]`), igual que antes.

## Correspondencia de funciones

| Función anterior | Componente nuevo | Comando(s) | Estado | Prueba |
| --- | --- | --- | --- | --- |
| Proyectos, crear, abrir carpeta | Inicio | `get_workspace`, `create_project`, `set_root` | conectado | Playwright (simulador) |
| Retomar | Inicio | localStorage `filigranas.retomar` | conectado | Playwright |
| Atención y en marcha | Inicio | `tasks_list`, `session_list`, `work_session_current` + actividad | conectado | Playwright |
| Chats, PM, historial, recuperación | Workspace (sin cambios funcionales) | `session_*`, `chat_*`, `coordinator_*` | intacto | build y tsc |
| Monaco, explorador, diff | Workspace · disposición código/dividida | `read_file`, `git_diff_texts` | intacto | Playwright |
| Terminales reales | Workspace (montados al cambiar de destino) | `pty_*` | intacto | tsc |
| Atajos | ⌘⇧1–6, ⌘, y ⌘⌥1–3 nuevos; los anteriores siguen | — | conectado | Playwright (teclado) |
| Tareas (crear, editar, dependencias) | Flow · Lista + edición en Trabajo | `tasks_list`, `task_save` | conectado | Playwright |
| Ejecución, Jev | Flow · inspector | `task_runs` | conectado | Playwright |
| Hablar con el PM, chat directo | Flow · inspector | acciones existentes | conectado | tsc |
| Bucle de diseño | Studio | `design_list/save/shots/image/capture/import/review/send/preview` | conectado | Playwright + `pnpm test` |
| Bloqueos de diseño | Studio | `design_save` (restricciones) | conectado | `pnpm test` |
| Modelo de la sesión de diseño | Studio | `claude_chat_options`, `session_set_option` | conectado | tsc |
| Lienzo de barra lateral (`DesignCanvas`) | Workspace · panel Diseño | `design_generate` | intacto | — |
| Git, commit, push, stash, ramas | Entrega · Cambios (GitPanel) | `git_*`, `git_review_push`, `git_push` | conectado | Playwright |
| Larry | Entrega · Commits | `larry_*` | conectado | Playwright |
| Salud del código | Entrega · Revisión | `health_*` | conectado | tsc |
| PR, CI, merge | Entrega · PR y CI (Publish) | `pr_*`, `health_ci` | conectado | tsc |
| Ramas de sesión, integrar | Entrega · Integrar rama (Pending) | `session_changes`, `session_integrate*` | conectado | tsc |
| Sesión de trabajo | Entrega + Trabajo | `work_session_*` | conectado | tsc |
| Brain (lista, editar, olvidar) | Brain · Índice e inspector | `brain_search/entry/save/forget` | conectado | Playwright |
| Grafo global de Brain | Barra de título (sin cambios) | `brain_graph` | intacto | — |
| Grafo del proyecto | Brain · Mapa y Foco | `brain_graph` + `brain_links` | conectado | Playwright |
| Contexto que recibe un agente | Brain · Contexto | `brain_preview` | conectado | Playwright |
| Relaciones tipadas | Brain · inspector | `brain_links`, `brain_link_save`, `brain_link_remove` (nuevos) | conectado | `cargo test brain_links` (4) |
| Herramientas, cuentas, Jev | Ajustes (Tools) | `tools_*`, `jev_status`, `jev_configure` | conectado | Playwright |
| Uso | Ajustes (UsagePanel) | `jev_usage` y cuotas | conectado | tsc |
| Tareas en paralelo | Ajustes · Proyecto | `task_parallel_limit` | conectado | tsc |
| Skills | Ajustes (solo lectura) | `skills_list` (nuevo) | conectado | clippy |
| Movimiento y tema | Ajustes · Visual | localStorage + `prefers-reduced-motion` | conectado | Playwright (`reduced_motion`) |

## Backend

- `brain_links.rs` crea una tabla nueva (`CREATE TABLE IF NOT EXISTS`, FK con `ON DELETE CASCADE`). No modifica `brain_entries` ni infiere relaciones. Las relaciones solo se guardan con `confirmed = true`.
- `skills_list` lee el catálogo ya incluido en el binario.
- No se ha tocado SQLite, los adaptadores de agentes ni ningún control de permisos más allá de esto.

## Pruebas ejecutadas

- `pnpm typecheck` y `pnpm build`: correctos.
- `pnpm tauri build --no-bundle` en Linux: binario de release compilado sin errores.
- `pnpm test` (nuevo, Node `--experimental-strip-types`): 3 de 3.
- `cargo clippy --all-targets`: sin avisos.
- `cargo test`: 122 correctas y 1 fallida. La fallida, `isolate::tests::merging_leaves_markers_only_where_it_clashes`, ya fallaba antes de los cambios (git 2.43 del contenedor).
- Playwright contra `pnpm dev` con el núcleo simulado:
  - todos los destinos a 1440×900, 1050×720 y 820×600, sin errores de consola;
  - modo reducido emulado;
  - recorridos de Flow, Studio y Brain.

## Limitaciones pendientes

- **Sin prueba nativa.** No se ha ejecutado en macOS ni en WKWebView: el entorno de trabajo es Linux. Antes de fusionar hay que comprobar el semáforo, la vibrancia y la máscara CSS del campo en la app real.
- **Animaciones con agentes.** El campo solo se anima con agentes trabajando. Falta medir su coste en WKWebView con Monaco abierto.
- **Restricciones de Studio.** Los bloqueos se guardan como líneas `[bloqueo x,y,w,h] texto`, que el núcleo envía tal cual en el encargo.
- **Rama base.** `feat/trama-v2` depende de `codex/limpieza-pnpm`. Si esa rama no se integra, habrá que hacer rebase sobre `main`.
