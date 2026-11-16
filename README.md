# Filigranas IDE

IDE personal y ultraligero centrado en proyectos, agentes y trabajo paralelo sobre varias ramas. macOS primero, también Windows.

**Estado:** entrega 1 en curso (base de la aplicación).

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

Los datos locales (ajustes, grupos, proyectos archivados) viven en SQLite dentro del directorio de datos de la app: `~/Library/Application Support/com.filigranas.ide` en macOS y `%APPDATA%\com.filigranas.ide` en Windows. La app nunca escribe en los repositorios que detecta.
