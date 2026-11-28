# Paneles de uso de proveedores

28 de noviembre de 2026 · rama `fix/model-usage-panels` · base `02e4072` de `fix/lote-correcciones`. Worktree independiente `filigranas-ide-model-panels`.

## Cambios

- Claude, Codex y Antigravity: tarjetas por ventana con consumo, porcentaje disponible, cuenta atrás y fecha local de renovación. La ausencia de fecha o cuota permanece explícita. No se calcula una renovación a partir del nombre de la ventana.
- La vista general de Claude incluye las cuotas específicas de Opus y Sonnet cuando existen. Las vistas con un modelo seleccionado mantienen su filtro.
- Codex permite consultar de nuevo los límites sin enviar un turno. Un fallo conserva los datos anteriores y muestra el error.
- Accesos a gestión de Codex y Claude, y a las opciones oficiales de planes de Antigravity. El comando nativo solo acepta proveedores conocidos y abre destinos HTTPS fijos con el navegador del sistema.
- Jev comparte el diseño, muestra intentos de las últimas 24 horas, tokens y coste estimado. Su límite usa una ventana móvil, conforme a `jev_attempts`.
- Actividad del proyecto separada de la cuota de cuenta. Los fallos y el límite de 40 tareas consultadas se señalan como actividad incompleta.

## Alcance de los restablecimientos

El panel ofrece acceso a la gestión oficial. No conoce el saldo de restablecimientos o créditos de la cuenta y no compra ni canjea desde Filigranas. La confirmación ocurre en el proveedor. Actualizar consulta la cuota, sin restablecerla.

Referencias oficiales consultadas:

- [Restablecimientos de Codex](https://help.openai.com/en/articles/20001498-how-resets-work-in-codex): disponibilidad por cuenta y canje desde ajustes de uso.
- [Créditos de uso de Claude](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans): gestión desde Settings → Usage.
- [Planes de Antigravity](https://antigravity.google/docs/plans/): opciones de cuota y créditos según el plan.

## Verificado

- `pnpm install --frozen-lockfile` y `pnpm build` desde la raíz del worktree.
- `pnpm test`: 99 correctas.
- `cargo test --locked --offline --manifest-path src-tauri/Cargo.toml --quiet`: 206 correctas, 15 externas ignoradas. Incluye rechazo de proveedores arbitrarios y destinos de gestión fijos.
- `cargo clippy --locked --offline --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: correcto.
- `python tests/model_usage_browser.py`: Edge Chromium headless con IPC simulado; cuota de 5 horas, semanal, Opus, renovación ausente, datos antiguos, error al consultar y al abrir gestión, recuperación tras error, límites vencidos, teclado, clic exterior y fallo al consultar actividad del proyecto.
- Capturas revisadas a 1440 × 900 y 960 × 720. Comparación antes/después de Codex con el mismo consumo (22 % / 47 %). Región del semáforo de 90 × 48 píxeles idéntica. No se modifican ventana, cabecera ni configuración Tauri.
- `git diff --check` correcto.

Capturas locales fuera del repositorio en `../filigranas-model-usage-evidence/`. Para reproducirlas: `pnpm dev -- --port 1432`; en otra terminal, `python tests/model_usage_browser.py`. `MODEL_USAGE_URL` y `MODEL_USAGE_ARTIFACTS` permiten elegir URL y carpeta de evidencia.

## Pendiente

Recorrido nativo con cuentas reales, incluida la apertura del navegador desde Tauri. No se ha instalado una aplicación. El usuario ha autorizado crear los commits e integrarlos localmente en `fix/lote-correcciones`; la publicación y la PR quedan fuera de esta entrega.
