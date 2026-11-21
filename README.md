# Filigranas IDE

IDE personal y ultraligero centrado en proyectos, agentes y trabajo paralelo en una rama compartida por sesión. macOS primero, también Windows.

**Estado:** las cinco entregas de V1 tienen implementación. La [aceptación de V1](docs/aceptacion-v1.md) distingue los flujos comprobados y los pendientes por plataforma y proveedor.

- Proyectos, grupos y archivo; editor Monaco, terminales y Git local (estado, diffs, ramas, historial gráfico).
- Coordinador Codex por proyecto (perfiles Hansi, Pep, Luis Enrique y Cruyff) que delega en sesiones de Claude Code, OpenCode, Antigravity y Devin.
- Cada sesión de trabajo reúne varios chats en el checkout del proyecto y una rama descriptiva (`feat/brain-global`, `fix/guardado-editor`). El reparto por rutas coordina el paralelismo; se conservan los worktrees históricos, la pausa y los relevos.
- Larry comprueba el diff y crea commits locales. El tablero vincula ramas, commits y PR. La publicación y el merge en GitHub requieren aprobaciones separadas.

## Sesiones de trabajo

1. En **Trabajo**, introduce el objetivo, el tipo y el nombre descriptivo de la rama. Se parte de la referencia local disponible de `origin/main` o `main`; actualiza las referencias si necesitas incorporar cambios remotos recientes. Para incorporar cambios previos, revísalos y marca la opción correspondiente: en ese caso se conserva la base actual y todo su diff hacia `main`.
2. Abre chats de agentes. Todos comparten la carpeta y rama de esa sesión. Asigna archivos o carpetas relativos, uno por línea; `.` reserva todo el proyecto. El coordinador puede delegar con `archivos`, modificar el reparto con `asignar_archivos` y reintentar en el mismo chat con `continuar_sesion`.
3. Dos turnos con áreas solapadas no arrancan a la vez. Las áreas diferentes pueden avanzar en paralelo, dentro del límite de tareas del proyecto. El reparto se comunica a todas las CLI como instrucciones; no constituye un sandbox por archivo. Las operaciones Git del IDE esperan a que terminen los turnos. Las CLI y terminales externos deben respetar el mismo reparto.
4. Crea los commits con Larry. Registra el resultado y la evidencia de las comprobaciones y pulsa **Finalizar sesión y revisar PR**. La app exige un árbol limpio, commits hacia `origin/main` y un diff válido. Durante la revisión se bloquean los nuevos turnos y las mutaciones Git del IDE.
5. Revisa el título, la descripción, el destino `main` y el SHA. **Publicar PR y finalizar sesión** usa la confirmación existente; el merge sigue siendo independiente. Si falla la red, la sesión y la rama se conservan para reintentar sin duplicar la PR. Puedes reanudar el trabajo, invalidando la revisión anterior.

Cerrar un chat o salir de la aplicación no finaliza el trabajo. Tras una PR confirmada, la siguiente sesión crea otra rama y usa chats nuevos; los anteriores conservan su historial y su rama. Las sesiones antiguas con worktree mantienen sus acciones de integración y limpieza.

- [Compartir proyectos y configurar el servicio de conexión](relay/README.md)
- [Plan de implementación](PLAN.md)
- [Mockup v2](https://claude.ai/artifact/JxK8TYzEXneM6Ca1Wr476L) — datos de ejemplo, sin conexión a agentes ni repositorios.

## Stack

Tauri 2 · Rust y SQLite (`src-tauri/`) · React y TypeScript (`src/`) · Git mediante la CLI del sistema.

## Requisitos

- Node.js 26 y [pnpm 11.13.1](https://github.com/pnpm/pnpm/releases/tag/v11.13.1), fijado en `package.json`.
- Rust estable (`rustup`)
- Git 2.38 o posterior para comprobar conflictos antes de publicar
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Windows: Visual Studio Build Tools con «Desarrollo para el escritorio con C++» y WebView2 (incluido en Windows 11)

## Desarrollo

Con Corepack instalado, `corepack enable pnpm` activa la versión declarada por el proyecto.

```sh
pnpm install --frozen-lockfile
pnpm app                       # recarga en caliente y datos de desarrollo separados
pnpm tauri dev                 # usa el perfil de la app instalada
pnpm tauri build               # genera el instalador (.dmg / .msi)
pnpm build                     # comprobación TypeScript y build web
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

`pnpm app` usa el identificador `com.filigranas.ide.dev`, así que su base SQLite y sus worktrees no se mezclan con los de la app instalada. Los cambios de la interfaz (`src/`) se ven al guardar; los de Rust (`src-tauri/src/`) recompilan y reinician la app solos. El instalador solo hace falta para distribuir o probar la instalación.

Las CLI de los agentes (`codex`, `claude`, `opencode`, `agy`, `devin`), `node` y `gh` deben estar instaladas y con la sesión iniciada; la app las busca con el PATH del shell de login. Las pruebas marcadas `#[ignore]` requieren comprobaciones externas o servicios locales. Algunas usan CLI autenticadas y consumen un turno. Ejecuta por nombre las que correspondan.

Los worktrees de las sesiones también viven en el directorio de datos de la app (`worktrees/`), fuera de la carpeta de proyectos.

Los datos locales (ajustes, grupos, proyectos archivados, hilos del coordinador y sesiones) viven en SQLite dentro del directorio de datos de la app: `~/Library/Application Support/com.filigranas.ide` en macOS y `%APPDATA%\com.filigranas.ide` en Windows. Detectar o abrir un proyecto no escribe en su repositorio. Editar, crear un worktree o ejecutar una operación de Git sí puede modificarlo.


## Estructura

- `src/` contiene la interfaz y el contrato con Tauri en `ipc.ts`. `mock.ts` simula el núcleo en el navegador durante el desarrollo.
- `src-tauri/src/` contiene los comandos del escritorio y SQLite. `codex.rs`, `claude.rs` y `acp.rs` implementan los adaptadores, con transporte en `rpc.rs` y procesos externos en `cli.rs`. Los módulos `work`, `tasks` y `isolate` gestionan el trabajo y las sesiones. `git`, `github` y `pr` gestionan control de versiones y publicación.
- `src-tauri/resources/` contiene las instrucciones, las skills y el script de Larry. `relay/` contiene el servicio de colaboración.
