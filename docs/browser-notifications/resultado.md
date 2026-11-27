# Browser y Notificaciones · aceptación nativa

27 de noviembre de 2026 · macOS arm64 · Tauri 2.12.5 / WKWebView · rama `fix/browser-notifications-native`.

## HECHO

Browser conserva el WebView nativo existente como mecanismo de navegación. Se ha corregido su superficie flex, se rechazan dimensiones colapsadas, se agrupan las actualizaciones geométricas y se observan tanto cambios de tamaño como de posición. Cada proyecto tiene su propio WebView: ocultar Browser, cambiar de proyecto o abrir un desplegable conserva el documento y su historial interno. SQLite guarda la última URL por proyecto, incluidos cambios mediante History API; se recupera al reiniciar. Historial y marcadores mantienen sus tablas y comandos.

La barra muestra carga, permite atrás/adelante según el estado real de WKWebView, recarga, reintento y apertura en el navegador del sistema. Un fallo detenido sin confirmación o una espera superior a 30 segundos produce un aviso. El modo web informa de que la navegación integrada requiere Tauri; se ha retirado el iframe que no podía garantizar una navegación externa fiable. No se han relajado CSP, TLS, permisos remotos ni restricciones de las páginas.

Notificaciones presenta filas de título, resumen, tipo y fecha. La selección expande el texto completo, los diagnósticos y las acciones relevantes, y marca el evento como leído. Los grupos conservan diagnósticos distintos sin duplicar los idénticos. Se distinguen errores, avisos, información y finalizaciones de agentes. Los permisos y otros asuntos pendientes permanecen arriba, con desplazamiento independiente del historial y sin desaparecer al limpiarlo. Se ha eliminado el enlace incondicional a Inicio. El panel usa el material global de menús y un radio de 8 puntos.

El WebView se oculta temporalmente al abrir el desplegable para que su superficie nativa no tape el menú DOM; se vuelve a mostrar sin navegar ni recrearlo. Los avisos breves permanecen por encima del comienzo de la página y no ocultan el WebView.

## CAUSA RAÍZ

La integración Trama monta Browser bajo `.tool-body`. El estilo que hacía de Browser una columna flex estaba limitado a `.panel-body > .browser-panel`, correspondiente al contenedor anterior.

Medición en la aplicación nativa anterior al arreglo:

| Elemento | Anchura × altura lógica | Display |
| --- | --- | --- |
| `.tool-body` | 887 × 818 | flex |
| `.browser-panel` | 887 × 818 | block |
| `.browser-surface` tras abrir Google | 887 × **0** | grid |

Al desaparecer el texto de bienvenida, la superficie colapsaba. El observador anterior descartaba las medidas con altura cero, por lo que el WebView conservaba el rectángulo pequeño anterior. La [captura anterior](evidence/before-browser.png) reproduce la franja blanca comunicada por el usuario.

Aplicando **solo** el selector flex a `.browser-panel`, sin cambiar Rust, URL, CSP ni motor, la superficie pasó a 887 × **732,765625**. La [captura del cambio aislado de layout](evidence/layout-only-browser.png) muestra el resultado. La [captura final equivalente](evidence/after-browser.png), también a 1440 × 900, muestra Google completo. El estado nativo confirma 887 × 733, diferencia de redondeo inferior a un punto: [medición final](evidence/native-comparison-state.json).

El fallo demostrado es geométrico. En Tauri no se usaba iframe ni descarga HTTP para reconstruir la página. La CSP de la interfaz y las restricciones de enmarcado no explican esta reproducción.

## VERIFICADO

Todas las pruebas de navegación de esta tabla usan el motor nativo, sin mock de IPC ni imágenes de páginas en sustitución de un navegador.

| Recorrido ejecutado | Evidencia |
| --- | --- |
| Google y Example Domain | [Google final](evidence/after-browser.png), [estado nativo de Example Domain](evidence/native-public-site.json) |
| HTTP real en `localhost:3000` | Servidor de prueba local; [captura](evidence/after-localhost.png), [eventos de la página con tamaño y nonce de documento](evidence/localhost-events.json) |
| Atrás, adelante y recarga desde botones | [Recorrido nativo](evidence/native-navigation.json) |
| Seis ajustes del divisor por teclado, Workspace dividido y compacto | [Dimensiones DOM frente al motor](evidence/native-navigation.json) |
| Maximizar/restaurar herramienta cuatro veces mediante ⌘⇧F | [Estados nativos](evidence/native-maximize.json) |
| Cinco tamaños de ventana: 1440×900, 960×600, 1280×800, 960×600, 1440×900 | `native-resize-0.json` a `native-resize-4.json`; [captura de 960×600](evidence/resize-1-960x600.png) |
| Semáforo después de cada resize | [Medición de los PNG](evidence/semaforo.json): bordes 16/39/62, margen superior 16, diámetro 14, separación entre centros 23, escala 1× |
| Dos proyectos con páginas diferentes, retorno sin perder atrás, cerrar y reabrir Browser | [Recorrido nativo](evidence/native-navigation.json); nonce de documento en los eventos del servidor |
| Reinicio completo del binario de desarrollo | [Recupera la última URL del proyecto](evidence/restart-recovery.json); la pila interna empieza vacía, como se documenta abajo |
| Guardar marcador, abrir su lista y consultar el historial | Comprobaciones DOM en [recorrido nativo](evidence/native-navigation.json); conservados al reiniciar |
| Conexión rechazada a un puerto sin servidor | Error nativo y mensaje visible en [recorrido](evidence/native-navigation.json) |
| Petición real que no responde | [Cargando](evidence/native-loading.json), [aviso tras 30 segundos](evidence/native-load-timeout.json), [captura](evidence/after-browser-timeout.png) |
| SPA que llama a `history.pushState` | [URL adoptada](evidence/native-spa-persistence.json), [confirmación SQLite](evidence/native-isolation-and-sqlite.json) |
| Aislamiento de páginas externas | La página de prueba intentó `get_workspace`: el IPC fue **rechazado**, [registro](evidence/native-isolation-and-sqlite.json) |
| Navegador del sistema | El comando real de macOS terminó correctamente al abrir Example Domain: [resultado](evidence/native-system-browser.json) |
| Nuevos avisos, agrupación, tipos, expansión y lectura | [Resultado nativo](evidence/native-notifications.json), [cuatro tipos y diagnóstico expandido](evidence/after-notifications-expanded.png) |
| Marcar todas leídas, limpiar, cerrar/reabrir, Escape y clic exterior | [Resultado nativo](evidence/native-notification-actions.json) |
| Permiso fijado y navegación a la sesión/proyecto propietario | [Fixture del componente real en WKWebView](evidence/native-permission-fixture.json), incluso después de 70 eventos y limpieza del historial |
| Posicionamiento y presentación comparables | [Antes](evidence/before-notifications.png), [después](evidence/after-notifications.png), [expandida](evidence/after-notifications-comparison-expanded.png): misma ventana de 1440×900, estado global, Google y los mismos dos eventos |

Los permisos y eventos de notificaciones se alimentaron con fixtures explícitas; no se concedió autorización a ningún proveedor ni se ejecutó un turno autenticado para producirlas. La navegación HTTP y la carga de Google/Example Domain sí fueron reales. No se instrumentó la consola de las páginas externas; el controlador recoge errores de la interfaz principal y comprueba estados del motor y mensajes visibles. Durante la edición por HMR, React avisó de un cambio en la longitud del array de dependencias de un efecto; se reinició el proceso nativo antes de la validación final. No se atribuyeron a sitios externos los errores de preparación del controlador o de HMR.

Comprobaciones finales ejecutadas:

- `pnpm install --frozen-lockfile`: correcto, lockfile intacto.
- `pnpm test`: **48 correctas**, 0 fallidas.
- `pnpm build`: TypeScript y Vite correctos.
- `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml`: **151 correctas**, 0 fallidas, **10 ignoradas**; no se declararon ejecutadas las ignoradas.
- `cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: correcto. Una advertencia previa de `home.rs` se corrigió en un commit independiente.
- `pnpm tauri build --no-bundle --config '{"identifier":"com.filigranas.ide.browser-acceptance"}'`: binario nativo optimizado correcto. No instala la aplicación.
- `git diff --check`: correcto.

Los resúmenes de comandos quedan en [checks.json](evidence/checks.json). AmbientField, los efectos de ventana y el semáforo no se modificaron.

## PENDIENTE Y LÍMITES REALES

- WKWebView puede presentar restricciones propias del sitio: autenticación, CAPTCHA, contenido protegido, descargas o esquemas no HTTP(S). No se evitan esas restricciones. La salida disponible es el navegador del sistema.
- La API pública de Tauri ofrece eventos `Started` y `Finished`, no el diagnóstico completo de todos los fallos de navegación de WKWebView. Se lee además `isLoading` nativo y se informa de una carga detenida/no confirmada o de una espera de 30 segundos. El aviso no inventa un código TLS, HTTP o una causa concreta. [Referencia oficial de la API](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewBuilder.html#method.on_page_load).
- Una carga terminada no garantiza que cada recurso de una web arbitraria haya tenido éxito. No hay inspección de red ni consola remota en este cambio. Los intentos muy breves de navegación iniciados dentro de una página que fallen antes del commit pueden no ser observables por el sondeo público del motor; no se presenta esto como un inspector completo.
- Ocultar/cerrar el panel y alternar proyectos conserva el documento y la pila atrás/adelante durante el proceso. Tras salir completamente de la aplicación se recupera **la última URL**, no se serializan la pila privada de WKWebView, cookies de incógnito, formularios ni scroll.
- Los diagnósticos de notificaciones se conservan completos dentro del historial existente, limitado a 60 grupos y a la vida del proceso. No se añadió persistencia nueva para ese historial.
- Falta ejecutar el flujo con permisos y finalizaciones de proveedores autenticados y validar Windows/WebView2. Las fixtures nativas comprueban presentación y destinos, no sustituyen esos recorridos.
- Este agente no ejecutó push ni merge. En la comprobación final, `git ls-remote` confirmó que la referencia remota de esta rama está en `d5042df`, la instantánea previa. El reflog registra `update by push` a las 13:16:55; no se ha determinado su autoría. Los commits propios de implementación, pruebas e informe permanecen por delante de ese SHA remoto. [Comprobación de entrega](evidence/git-delivery.json). La instalación habitual no se ha reemplazado. La copia inicial de caché arrastró inadvertidamente un `.app` antiguo; se retiró del worktree a la papelera, sin ejecutarlo ni instalarlo. Las ejecuciones de aceptación utilizaron exclusivamente `target/debug/filigranas`.

## ARCHIVOS Y COMMITS

- Browser: `src/Browser.tsx`, `src/ipc.ts`, `src/styles.css`, `src-tauri/src/browser.rs`, `src-tauri/src/lib.rs`.
- Notificaciones: `src/trama/Attention.tsx`, `src/trama/notifications.ts`, `src/trama/shell.css`, `src/App.tsx`, `src/Coordinator.tsx`, `src/Session.tsx`, `tests/notifications.test.ts`.
- Comprobación estricta: una línea en `src-tauri/src/home.rs`.
- Controlador y escenarios reproducibles: `tests/browser_notifications_{server.mjs,fixture.mjs,native.js,scenarios.js,command.py}`; informe y evidencias bajo `docs/browser-notifications/`.

`d5042df` es exclusivamente la instantánea de los 24 archivos de trabajo **previos** que se recibieron sin commit. Mantiene esos cambios fuera de los diffs propios de esta tarea y no se aplicó al checkout original.

Implementación propia: `d6ba441` (advertencia previa de Home), `0b32bba` (Browser), `69a96f5` (Notificaciones). Los commits posteriores añaden el controlador, este informe y evidencias.

## REPRODUCCIÓN

Desde un worktree preparado con `pnpm install --frozen-lockfile`, preparar los repositorios y desactivar actualizaciones en el perfil de prueba antes del primer arranque:

```sh
python3 - <<'PYSETUP'
from pathlib import Path
import sqlite3, subprocess
root = Path('/tmp/filigranas-browser-acceptance/repos')
for name in ('uno', 'dos'):
    repo = root / name
    repo.mkdir(parents=True, exist_ok=True)
    subprocess.run(['git', '-C', str(repo), 'init', '-q'], check=True)
profile = Path.home() / 'Library/Application Support/com.filigranas.ide.browser-acceptance'
profile.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(profile / 'filigranas.db') as conn:
    conn.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    conn.execute("INSERT OR REPLACE INTO settings VALUES ('cli_auto_update', 'false')")
PYSETUP
```

```sh
export FILIGRANAS_BROWSER_EVIDENCE="$PWD/docs/browser-notifications/evidence"
node tests/browser_notifications_server.mjs
# En otra terminal, si el puerto 3000 está libre:
node tests/browser_notifications_fixture.mjs
# En otra terminal:
pnpm tauri dev --no-watch --no-dev-server --config '{"identifier":"com.filigranas.ide.browser-acceptance","build":{"devUrl":"http://127.0.0.1:14620/__native","beforeDevCommand":""},"app":{"security":{"capabilities":["default",{"identifier":"acceptance-window-resize","webviews":["main"],"permissions":["core:window:allow-set-size"]}]}}}'
```

El controlador solo admite ese identificador. Usa una base separada, repositorios Git desechables `uno` y `dos`, y desactiva las actualizaciones de CLI. Antes del primer arranque debe existir `settings.cli_auto_update = false` en la base de ese perfil para que tampoco se actualicen herramientas durante el arranque Rust. El permiso adicional de resize es **solo configuración de pruebas**, no se añadió a las capacidades de producción. El control por HTTP requiere un token temporal con permisos 0600 fuera del repositorio y no habilita CORS para páginas externas.

```sh
python3 tests/browser_notifications_command.py "$FILIGRANAS_BROWSER_EVIDENCE" recorrido <<'JS'
const {runBrowser}=await import('/tests/browser_notifications_scenarios.js');
return await runBrowser();
JS
```

`runNotifications`, `runNotificationActions`, `runPending`, `resizeWindow` y `prepareComparison` son escenarios separados. Antes del recorrido, confirmar la carpeta de los repositorios desechables en la pantalla inicial y abrir Browser. Para una nueva aceptación guardar capturas nativas del mismo PID, región, escala y estado. No crear un bundle `.app` ni reutilizar el perfil habitual.
