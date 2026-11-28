# F2 · validación de interfaz

2026-11-28 · worktree `filigranas-ide-flow`, rama `feat/flow-orquestacion`.

- `pnpm test`: 61 correctas; seis pruebas nuevas en `tests/flow.test.ts`.
- `pnpm build`: código 0, TypeScript y Vite correctos (1369 módulos en la primera compilación completa).
- `git diff --check`: código 0.
- Chrome headless contra `pnpm dev --port 1428 --host 127.0.0.1`: recorrido UI correcto, sin errores JavaScript. Revisadas las capturas de ejecución, dependencias, lista, inspector y ventana estrecha.

`resultado.json` registra el recorrido. `recorrido.mjs` lo reproduce con Playwright instalado externamente: `F2_PLAYWRIGHT_MODULE=/ruta/a/playwright/index.mjs node docs/flow/visual/recorrido.mjs`. No se ha añadido Playwright como dependencia. `F2_URL` permite elegir otro servidor de desarrollo.

La fixture se inyecta exclusivamente en el mock del navegador. Incluye cancelación, fase de verificación, prompt con espacios/saltos exactos y ejecución de hace tres días. Se comprobaron además copia real al portapapeles, apertura con Intro, Escape con foco restaurado, cierre exterior, límites del inspector, divisor de actividad con teclado/persistencia y rechazo del formulario sin criterios. Esto no acredita despacho ni ejecuciones del backend ni proveedores reales.

Pendiente de integración en App: `onOpenDelivery(taskId)`, `onSendToPm(task)` y `onCompactWorkspace()`. `onOpenSession(sessionId)` conserva el punto de entrada existente a Workspace. El snapshot no contiene un registro de eventos de Entrega ni skills aplicadas; no se sintetizan. El historial disponible está limitado por el backend a 30 turnos por tarea.

No se creó/instaló ninguna aplicación ni se modificaron superficies nativas. Los cambios backend/IPC concurrentes pertenecen a F1, no a este diff F2.
