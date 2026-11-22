# Instrucciones del proyecto

- Aplica las [reglas de trabajo](src-tauri/resources/reglas.md).
- Respeta la [norma obligatoria del semáforo macOS](src-tauri/resources/skills/design-loop/references/semaforo-macos.md).
- Consulta el [inventario de aceptación](docs/aceptacion-v1.md) antes de cambiar flujos de V1. Abre solo la skill pertinente en [`src-tauri/resources/skills`](src-tauri/resources/skills).
- Usa una sola instalación de Filigranas en macOS. Para verificar cambios, usa las pruebas, el navegador o el modo de desarrollo desde el repositorio. Crear otra aplicación `.app` o reemplazar la instalada requiere autorización expresa del usuario.
- Usa `pnpm install --frozen-lockfile` y `pnpm build` desde la raíz del repositorio.
