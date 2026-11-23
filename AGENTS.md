# Instrucciones del proyecto

- Aplica las [reglas de trabajo](src-tauri/resources/reglas.md).
- Respeta la [norma obligatoria del semáforo macOS](src-tauri/resources/skills/design-loop/references/semaforo-macos.md).
- Consulta el [inventario de aceptación](docs/aceptacion-v1.md) antes de cambiar flujos de V1. Abre solo la skill pertinente en [`src-tauri/resources/skills`](src-tauri/resources/skills).
- Usa una sola instalación de Filigranas en macOS. Para verificar cambios, usa las pruebas, el navegador o el modo de desarrollo desde el repositorio. Crear otra aplicación `.app` o reemplazar la instalada requiere autorización expresa del usuario.
- Usa `pnpm install --frozen-lockfile` y `pnpm build` desde la raíz del repositorio.

## Commits del repositorio

- Cuando el usuario pida crear commits, delega en GitHub Copilot CLI la revisión del diff, la agrupación, la redacción y la creación de los commits locales. Indícale la rama y las rutas autorizadas. Dale acceso de lectura y permiso para preparar esas rutas y crear commits locales, con los hooks activos. Si Copilot no está disponible, comunica el bloqueo.
- Copilot separa los cambios independientes por tipo y unidad funcional (`feat`, `fix`, `refactor`, `docs`, `test`, `build` o `chore`) siguiendo la [referencia de Larry](src-tauri/resources/skills/github-flow/references/larry.md). Mantén juntos los cambios inseparables y omite siempre `Co-authored-by`.
- Comprueba después los commits nuevos, las rutas de cada uno y el estado del árbol de trabajo. Publicar requiere autorización aparte.
