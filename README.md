# Filigranas IDE

IDE personal y ultraligero centrado en proyectos, agentes y trabajo paralelo sobre varias ramas. macOS primero, también Windows.

**Estado:** las cinco entregas de V1 tienen implementación. La [aceptación de V1](docs/aceptacion-v1.md) distingue los flujos comprobados y los pendientes por plataforma y proveedor.

- Proyectos, grupos y archivo; editor Monaco, terminales y Git local (estado, diffs, ramas, historial gráfico).
- Coordinador Codex por proyecto (perfiles Hansi, Pep, Luis Enrique y Cruyff) que delega en sesiones de Claude Code, OpenCode, Antigravity y Devin.
- Cada sesión trabaja en su propia rama y worktree; integración guiada, pausa por cuota, reanudación y relevo entre motores.
- Larry comprueba el diff y crea commits locales. El tablero vincula ramas, commits y PR. La publicación y el merge en GitHub requieren aprobaciones separadas.

- [Plan de implementación](PLAN.md)
- [Mockup v2](https://claude.ai/artifact/JxK8TYzEXneM6Ca1Wr476L) — datos de ejemplo, sin conexión a agentes ni repositorios.

## Stack

Tauri 2 · Rust y SQLite (`src-tauri/`) · React y TypeScript (`src/`) · Git mediante la CLI del sistema.

## Requisitos

- Node.js 20+ y npm
- Rust estable (`rustup`)
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Windows: Visual Studio Build Tools con «Desarrollo para el escritorio con C++» y WebView2 (incluido en Windows 11)

## Desarrollo

```sh
npm install
npm run tauri dev      # app con recarga en caliente
npm run tauri build    # instalador (.dmg / .msi)
cd src-tauri && cargo test
```

Las CLI de los agentes (`codex`, `claude`, `opencode`, `agy`, `devin`), `node` y `gh` deben estar instaladas y con la sesión iniciada; la app las busca con el PATH del shell de login. Los tests marcados `#[ignore]` hablan con esas CLI de verdad y gastan un turno corto: `cargo test -- --ignored`.

Los worktrees de las sesiones también viven en el directorio de datos de la app (`worktrees/`), fuera de la carpeta de proyectos.

Los datos locales (ajustes, grupos, proyectos archivados, hilos del coordinador y sesiones) viven en SQLite dentro del directorio de datos de la app: `~/Library/Application Support/com.filigranas.ide` en macOS y `%APPDATA%\com.filigranas.ide` en Windows. Detectar o abrir un proyecto no escribe en su repositorio. Editar, crear un worktree o ejecutar una operación de Git sí puede modificarlo.
