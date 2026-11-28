# P0 · Permisos, sesiones y Jev

Reparación previa a la rama de capacidades (`feat/capacidades-agentes`, PR #44): sin permisos efectivos y verificables no se pueden construir capacidades encima. Rama `fix/p0-permisos-sesiones-jev`.

## Alcance

1. **Motor único de permisos** (`autoapprove::evaluate`), usado por Claude Code (`can_use_tool`), Codex (app-server) y ACP, con cuatro modos:
   - **Solo lectura**: lecturas y una lista corta de comandos de consulta. Claude arranca además sin `Bash`, `Edit` ni `Write`.
   - **Con autorización** (por defecto): toda petición llega al usuario con su origen y motivo.
   - **Automático**: lecturas, ediciones y `test/build/lint/check` dentro del proyecto; el resto pregunta.
   - **Control total**: aprueba dentro del alcance autorizado. Las rutas fuera del proyecto, las operaciones protegidas (`git push/merge/rebase/reset --hard/clean -f/branch -D/config`, `gh pr merge/close`, borrados, intérpretes y `sudo`) y las ediciones sin rutas declaradas siguen preguntando.
   - En todos los modos: los comandos catastróficos (`rm -rf /`, `mkfs`, `dd` a un disco…) se deniegan.
2. **Los proveedores no se saltan la política**: Claude arranca en `--permission-mode default` con `ask` explícito para las herramientas de escritura. Codex trabaja con sandbox `read-only` y `approvalPolicy: untrusted` también en Control total, para que cada escritura pase por Filigranas. «Aceptar para la sesión» se reduce a «aceptar una vez» en los tres proveedores.
3. **Herencia y cambios de modo**: una subsesión hereda el modo de su padre en el momento de crearla. Bajar a Solo lectura reinicia el proceso de Claude para quitarle las herramientas de escritura.
4. **PM**: en Claude, sin herramientas (`--tools ""`) ni MCP ajenos. En Codex, sin shell, multiagente, apps, navegador ni búsqueda web.
5. **Sesiones sin trabajo Git**: una sesión directa puede conversar y trabajar sin abrir antes un trabajo de Entrega. Si hay un trabajo en revisión, se bloquea cualquier turno.
6. **Jev**: credencial personal de TypeSafe guardada y borrada desde Ajustes, en el llavero de macOS o el Administrador de credenciales de Windows (nunca en variables de entorno, argumentos, base de datos ni registros). Prueba de conexión real. Consentimiento nuevo `jev.routing.v2`, porque ahora se envían rol y tamaño de la delegación. `delegar` acepta `agente: "auto"`: Jev elige entre los proveedores autenticados y, si no puede, decide una regla local. La traza distingue `jev`, `shadow`, `local`, `manual`, `api_error` y `unconfigured`, y registra si hubo llamada, el endpoint y el estado HTTP.

## Criterio de hecho

Cada punto se comprueba con la prueba indicada. No se considera hecho lo que no haya pasado.

| # | Criterio | Prueba |
|---|---|---|
| 1 | Los cuatro modos producen decisiones distintas y deterministas | `cargo test --lib autoapprove` |
| 2 | Ninguna ruta fuera del proyecto se aprueba sola, tampoco mediante enlaces simbólicos, `../` o rutas absolutas en un comando | `autoapprove::tests` y revisión adversarial |
| 3 | Las operaciones protegidas y catastróficas no se aprueban solas en ningún modo | `autoapprove::tests` y revisión adversarial |
| 4 | Claude y Codex reales: en Solo lectura y Con autorización no se crea el archivo; en Automático y Control total sí, sin preguntar al usuario | aceptación nativa: 8 casos `P0_NATIVE_CASE` con `passed: true` |
| 5 | Una subsesión hereda el modo; tras bajar el padre a Solo lectura, ni el padre ni una subsesión nueva pueden escribir | aceptación nativa: `permission_inheritance` y `mode_change_revokes_write` |
| 6 | `delegar` con `agente: "auto"` crea la subsesión en el proveedor que registra la traza | aceptación nativa: `routing.executionProvider == delegation_provider` |
| 7 | La credencial de Jev se guarda, se sustituye y se borra sin tocar la personal, y no aparece en ningún objeto Git | `real_keychain_roundtrip` y `real_typesafe_personal_api` (ignoradas, con credencial real) |
| 8 | El fixture nativo no existe en compilaciones normales ni de release | `#[cfg(all(debug_assertions, feature = "p0-acceptance"))]`, el identificador `.dev.p0` y el marcador `p0-acceptance.started` (una sola ejecución) |
| 9 | Sin regresiones | `cargo test --lib`, `cargo clippy --lib --tests`, `pnpm build` y `pnpm test` |
| 10 | Revisión adversarial con veredicto APTO, o hallazgos corregidos | informe de la revisión en la PR |

## Aceptación nativa

Abre una instancia de desarrollo aislada (identificador `com.filigranas.ide.dev.p0`, datos propios) en un repositorio desechable. Hace turnos reales y facturables de Claude y Codex con esfuerzo bajo:

```sh
pnpm tauri dev --config src-tauri/tauri.dev.conf.json \
  --config '{"identifier":"com.filigranas.ide.dev.p0"}' -- --features p0-acceptance
```

Al terminar escribe `filigranas-p0-native-evidence.json` en el directorio temporal del sistema y una línea `P0_NATIVE_ACCEPTANCE complete=…`. Para repetirla hay que borrar `p0-acceptance.started` de los datos de esa instancia. `FILIGRANAS_P0_PROVIDERS=claude` limita los proveedores.

## Fuera de alcance

- Antigravity: no tiene estado de sesión oficial, así que no es candidato automático de Jev y no forma parte de la aceptación nativa.
- Retirar OpenCode y Devin de `delegar` (lo hace la rama de capacidades).
