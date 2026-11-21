# Limpieza técnica y migración a pnpm

21 de noviembre de 2026 · macOS arm64 · base `4d01e9d` · rama `codex/limpieza-pnpm`. El checkout principal empezó limpio. Durante el trabajo, `main` avanzó a `0c9d9d7` con cambios solo en `docs/auditoria-tecnica.md`, un archivo ajeno a esta rama. En la base pasaron el build web, Clippy y 118 pruebas Rust, con 10 pruebas de integración optativas.

## Hecho

| Clasificación | Hallazgo y evidencia |
| --- | --- |
| Obsoleto confirmado | El editor escuchaba un evento sin emisor y el diff volvía a aplicar el mismo tema ante cambios de apariencia. Se retiraron los listeners y el import circular. Monaco sigue cargándose al abrir el primer archivo o diff. |
| Obsoleto confirmado | Se retiraron los selectores `.tb-sep`, `.side-usage .is-out`, `.mtr` y sus variantes, `.pending-row` y `.pending-task`. Se contrastaron con las clases literales y las generadas por la interfaz. `.xterm-viewport` sigue activa porque la genera xterm. Se hicieron privados 14 símbolos TS usados solo en su archivo. |
| Obsoleto confirmado | Los cuatro perfiles antiguos del coordinador salieron de los recursos activos. Codex y Claude incluyen únicamente `politica.md`. Los textos originales se conservan como [referencia histórica](coordinador-codex.md#perfiles-retirados) y se mantiene la migración del perfil en SQLite. |
| Duplicado | Editor y diff reutilizaban una función que siempre devolvía el mismo tema. Monaco usa ahora una constante para registrar y seleccionar ese tema. |
| Necesario y activo | ACP y Codex comparten `rpc.rs`. `cli.rs` contiene la resolución de ejecutables, el PATH de Finder y la espera durante actualizaciones. Las pruebas del transporte y de esa espera se trasladaron con su código. |
| Necesario y activo | Las 14 dependencias directas tienen consumidores en el frontend, TypeScript, Vite o Tauri. Las 97 entradas del lockfile nuevo coinciden en nombre, versión e integridad con las del anterior. Se conserva DOMPurify 3.4.18 y se permite el script de `fsevents` para el observador opcional de macOS. |
| Pendiente de confirmar | Se conservaron el ZIP de Claude, los mockups y los iconos de distribución de Windows. La auditoría no confirmó que fuera seguro retirarlos. |

Filigranas, Tauri y CI usan pnpm 11.13.1 con Node 26. Code Health elige el gestor del proyecto abierto y conserva la compatibilidad con npm. Las menciones restantes a npm en informes previos identifican herramientas o resultados históricos.

## Verificado

- `pnpm install --frozen-lockfile` desde un almacén vacío y repetición con `--offline` tras retirar `node_modules`. El lockfile quedó idéntico.
- `pnpm build`, `pnpm typecheck`, `pnpm audit --audit-level=high` y comprobación de sintaxis de Relay y Larry. La auditoría de pnpm devolvió cero vulnerabilidades conocidas. El proyecto carece de scripts `test` y `lint` para JavaScript.
- 119 pruebas Rust ordinarias y Clippy con `--all-targets -- -D warnings`. Pasaron también siete pruebas optativas de relay, Jev local, captura de Design Loop, borrador de PR, lectura en GitHub, detección de herramientas y Docker.
- `pnpm tauri dev` arrancó con un perfil SQLite aislado. Desde una ventana nativa se abrió un proyecto y un archivo en Monaco, el terminal devolvió la carpeta esperada y Code Health registró `pnpm run typecheck` como correcto en SQLite.
- `pnpm tauri build` produjo la app y el DMG arm64. `hdiutil verify` validó la imagen. Se revisó el marco en la ventana nativa. El indicador de macOS cubrió el semáforo y el diff de Tauri solo afecta a los comandos de Vite.

## Pendiente

- CI de GitHub y recorrido nativo en Windows sobre esta rama. La configuración conserva las tres comprobaciones de rama.
- Turnos con Codex, Claude y OpenCode. La revisión automática bloqueó la ejecución por el posible consumo de cuota sin autorización específica.
- Problema preexistente observado durante la prueba. El panel Cambios muestra un error de Git en repositorios sin commit inicial. `git_log` ya consultaba `HEAD` en `4d01e9d`.
