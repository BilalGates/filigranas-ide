# WorkspaceShell — Navegación y distribución persistente

## Arquitectura

La aplicación usa una única superficie permanente de trabajo (**Workspace**) rodeada por una barra lateral de ocho herramientas acoplables:

```text
App
 ├─ AmbientField            (capa de fondo independiente, sin cambios)
 ├─ Titlebar                (marco nativo macOS, proyecto/rama, búsqueda, terminal, agentes, atención)
 ├─ DestNav                 (8 herramientas; sin icono de Workspace)
 ├─ WorkspaceShell          (gestor centralizado de distribución)
 │   ├─ WorkspaceCompactRail (solo en modo compacto: conversación activa, actividad, permisos y recuperación)
 │   ├─ WorkspacePane       (siempre montado: Threads/Sidebar + Chat/Terminal + Right inspector)
 │   ├─ ws-splitter         (divisor vertical arrastrable y accesible por teclado)
 │   └─ ToolPane            (superficie limpia sin cabecera de subventana + botón flotante de minimizar Workspace + capa persistente de Browser)
 └─ Statusbar               (CPU/RAM a la izquierda, cuotas y Jev a la derecha)
```

Módulos principales:
- `src/trama/workspaceLayout.ts`: estado puro, transiciones, cálculo adaptable de medidas y persistencia.
- `src/trama/WorkspaceShell.tsx`: contenedor de paneles, divisor central, cabecera común de herramientas y rail compacto de Workspace.
- `src/trama/nav.tsx`: barra lateral con **Inicio**, **Flow**, **Studio**, **Entrega**, **Brain**, **Contenedores**, **Browser** y **Ajustes**.
- `src/trama/kit.tsx`: `Root` observa su propio ancho con `ResizeObserver` para que cada herramienta adapte sus rejillas al ancho real de `ToolPane`.

## Estados de distribución

| Modo | Comportamiento |
| --- | --- |
| `workspace` | Sin herramienta abierta (`activeTool: null`). Workspace ocupa el 100 % del área disponible. |
| `split` | Workspace a la izquierda (35 % por defecto, configurable entre 20 % y 65 %) y herramienta activa a la derecha (65 %), con divisor arrastrable. Si Workspace queda por debajo de `660 px`, su lista interna de hilos se repliega en un cajón bajo demanda para no aplastar el chat. |
| `compact` | Workspace se minimiza a una columna recuperable de `64 px` que muestra sigilo del proyecto, punto animado de actividad, insignia de permisos pendientes y nombre de la conversación activa. También se activa automáticamente si la ventana es demasiado estrecha para ambos paneles. |
| `maximized` | La herramienta activa ocupa el 100 % del área. `WorkspacePane` permanece montado fuera de flujo conservando su última anchura para que sesiones, scroll, borrador, Monaco y terminales sigan intactos. |

Control de superficie en `ToolPane`:
- Sin barra ni cabecera interna de subventana: cada herramienta empieza directamente en su contenido.
- Un único botón flotante y discreto en la esquina superior derecha colapsa Workspace a su columna compacta (`onMinimizeWorkspace`); desde esa columna se recupera Workspace en un clic. Los atajos globales (`⌘⇧F`, `⌘⇧W` y la barra lateral) siguen funcionando con normalidad.

## Comportamiento por herramienta

- **Inicio**: al arrancar sin proyecto válido se abre automáticamente junto a Workspace (`Workspace + Inicio`). Mientras no haya proyecto seleccionado, Workspace muestra el historial real de **Últimas sesiones** (`recent_sessions` en SQLite) para retomar cualquier conversación o proyecto en un clic. Seleccionar o crear un proyecto cierra Inicio y expande Workspace al 100 %.
- **Flow**: acoplado junto al chat; sus grafos reaccionan al ancho del panel y abrir una sesión o tarea enfoca Workspace sin cerrar procesos.
- **Studio**: lienzo y capturas adaptados al ancho de `ToolPane`; conserva la conversación activa de diseño.
- **Entrega**: diffs, Larry, Code Health y PR junto al agente; abrir un archivo lo muestra en el editor de Workspace.
- **Brain**: memoria y grafo junto al chat; el inspector incluye **Usar en chat** para insertar un recuerdo en el compositor activo.
- **Contenedores**: herramienta acoplable sobre los servicios locales del proyecto; los procesos y logs viven en Rust y sobreviven a cualquier cambio de distribución.
- **Browser**: se monta bajo demanda la primera vez que se abre y permanece oculto (`is-dormant`) al cerrarse o cambiar de herramienta para conservar la sesión del WebView nativo sin recrearlo ni perder navegación.
- **Ajustes**: se abre junto a Workspace sin interrumpir sesiones activas.

## Persistencia

Se guarda en `localStorage` bajo `filigranas.shell.v1`:
- Último proyecto válido (`lastProject`).
- Proporción elegida de Workspace (`workspaceRatio`) y último modo de herramienta (`lastToolMode`).
- Preferencias por proyecto (`projects[path]: { activeTool, mode, lastToolMode, workspaceRatio }`).

Regla de arranque:
- En cada arranque se muestra primero la pantalla de entrada (`Onboarding`) para confirmar o escoger mediante selector de carpetas la carpeta general de proyectos (pre-rellenada con la última raíz guardada o la predeterminada).
- Al confirmar la carpeta raíz, si `lastProject` no existe en ella o está archivado, se descartan las rutas inválidas y Filigranas arranca en `Workspace + Inicio`.
- Si `lastProject` es válido dentro de la carpeta elegida, se recupera su estado guardado con acceso inmediato a Inicio desde la barra lateral o el selector superior.

## Pruebas

- Suite automatizada en `tests/workspaceLayout.test.ts` (`pnpm test`): valida las 8 herramientas sin icono de Workspace, arranque sin proyecto, selección de proyecto con cierre automático de Inicio, apertura/cambio/cierre de herramientas, límites del divisor y restablecimiento, maximizar/restaurar/minimizar/recuperar, geometría adaptable en `1600`, `1440`, `1280`, `1050`, `960` y ventanas estrechas, y persistencia/recuperación por proyecto descartando rutas inaccesibles.
- `pnpm build`, `cargo test` y `cargo clippy --all-targets -- -D warnings`.

## Limitaciones

- La suite `node:test` valida el motor de distribución, geometría y persistencia en aislamiento; el arrastre con ratón sobre el WebView nativo de Browser y la verificación en Windows requieren prueba interactiva en escritorio.
- En el modo `compact` automático (ventanas por debajo de `788 px` útiles), recuperar Workspace cierra temporalmente la herramienta activa para evitar paneles inutilizables.
