# Filigranas IDE

IDE personal y ultraligero centrado en proyectos, agentes y trabajo paralelo sobre varias ramas. macOS primero, también Windows.

**Estado:** las cinco entregas del [plan](PLAN.md) están implementadas y pendientes de las pruebas de aceptación en la app (§6 del plan).

- Proyectos, grupos y archivo; editor Monaco, terminales y Git local (estado, diffs, ramas, historial gráfico).
- Coordinador Codex por proyecto (perfiles Hansi, Pep, Luis Enrique y Cruyff) que delega en sesiones de Claude Code, OpenCode, Antigravity y Devin.
- Cada sesión trabaja en su propia rama y worktree; integración guiada, pausa por cuota, reanudación y relevo entre motores.
- Larry propone y crea los commits; publicar la rama y abrir la PR en GitHub con `gh`.

- [Plan de implementación](PLAN.md)
- [Mockup v2](https://claude.ai/artifact/JxK8TYzEXneM6Ca1Wr476L) — datos de ejemplo, sin conexión a agentes ni repositorios.

## Stack

Tauri 2 · núcleo en Rust (`src-tauri/`) · interfaz en React + TypeScript (`src/`) dentro del WebView del sistema.

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

Los datos locales (ajustes, grupos, proyectos archivados, hilos del coordinador y sesiones) viven en SQLite dentro del directorio de datos de la app: `~/Library/Application Support/com.filigranas.ide` en macOS y `%APPDATA%\com.filigranas.ide` en Windows. La app nunca escribe en los repositorios que detecta.
