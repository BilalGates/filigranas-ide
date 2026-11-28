# Instrucciones del proyecto

- Aplica las [reglas de trabajo](src-tauri/resources/reglas.md).
- Respeta la [norma obligatoria del semáforo macOS](src-tauri/resources/skills/design-loop/references/semaforo-macos.md).
- Consulta el [inventario de aceptación](docs/aceptacion-v1.md) antes de cambiar flujos de V1. Abre solo la skill pertinente en [`src-tauri/resources/skills`](src-tauri/resources/skills).
- Usa una sola instalación de Filigranas en macOS. Para verificar cambios, usa las pruebas, el navegador o el modo de desarrollo desde el repositorio. Crear otra aplicación `.app` o reemplazar la instalada requiere autorización expresa del usuario.
- Usa `pnpm install --frozen-lockfile` y `pnpm build` desde la raíz del repositorio.

## Trabajo en paralelo entre sesiones

- La carpeta principal `filigranas-ide` es del usuario: está en la rama de integración (ahora `fix/lote-correcciones`) y ahí ejecuta `pnpm app`. Ninguna sesión cambia de rama ni edita archivos en ella.
- Cada sesión trabaja en su propio worktree, creado desde la rama de integración:
  `git fetch && git worktree add ../filigranas-ide-worktrees/<tema> -b sesion/<tema> origin/fix/lote-correcciones`, y después `pnpm install --frozen-lockfile` dentro del worktree.
- Para entregar: `git fetch && git rebase origin/fix/lote-correcciones && git push origin HEAD:fix/lote-correcciones`. No abras PR salvo que el usuario lo pida.
- Al terminar, desde la carpeta principal: `git worktree remove ../filigranas-ide-worktrees/<tema>` y `git branch -D sesion/<tema>`.

## Commits del repositorio

- Cuando el usuario pida crear commits, el propio agente revisa el diff, agrupa los cambios, redacta los mensajes y crea los commits locales, con los hooks activos. No depende de ninguna herramienta externa como GitHub Copilot. Si se está en la rama principal, crea antes una rama.
- Separa los cambios independientes por tipo y unidad funcional (`feat`, `fix`, `refactor`, `docs`, `test`, `build` o `chore`) siguiendo la [referencia de Larry](src-tauri/resources/skills/github-flow/references/larry.md). Mantén juntos los cambios inseparables y omite siempre `Co-authored-by`.
- Comprueba después los commits nuevos, las rutas de cada uno y el estado del árbol de trabajo. Publicar requiere autorización aparte.
