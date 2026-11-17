# Validación adicional del backend en macOS — 17 de noviembre de 2026

Se consultaron `Inicio.md`, la nota de proyecto de Obsidian y los informes previos. Windows queda fuera de esta ronda por indicación del usuario.

## Casos nuevos y resultados

Batería Rust final del árbol de trabajo: **55 correctas, 0 fallos, 6 externas ignoradas por defecto**. Las cinco comprobaciones externas no destructivas ya ejecutadas se detallan en `pruebas-2026-11-17.md`; no se repitieron para gastar más cuota sin necesidad.

| Caso | Resultado |
| --- | --- |
| Sesión borra, proyecto modifica el mismo archivo | Conserva el contenido local y reporta conflicto |
| Proyecto borra, sesión modifica | Fallo reproducido y corregido: ya no recrea el archivo borrado; conserva el cambio en el worktree y reporta conflicto |
| Archivo del proyecto es un enlace al exterior | Fallo reproducido y corregido: no sigue el enlace ni escribe en su destino; reporta conflicto |
| Ancestro del destino es un enlace al exterior | Bloqueado; no crea el archivo fuera del proyecto |
| Archivo nuevo de sesión es un enlace, incluso roto | Se conserva en la sesión y se reporta conflicto; no se convierte en un archivo con el contenido del destino |
| Renombre y bit ejecutable | Fallo reproducido y corregido: conserva el texto, elimina la ruta antigua y aplica los permisos ejecutables de la sesión |
| Conflicto no resuelto seguido de limpiar rama | Se rechaza la limpieza; la rama y la copia siguen disponibles. Un reintento que integra sin conflictos permite limpiar |
| Timeout del protocolo con respuesta tardía | La petición expirada se retira; la respuesta tardía no se confunde con la siguiente |
| Error de autenticación del protocolo (401 simulado) | Devuelve el mensaje de credenciales caducadas y libera la petición; no queda esperando |
| Remoto inexistente (repositorio temporal) | Fetch y push fallan sin cambiar HEAD ni el archivo local |
| Stash y pop con archivos nuevos | Restaura tanto el archivo modificado como el no seguido |

Las tres primeras regresiones de integración defectuosa y la pérdida de permiso ejecutable se observaron como fallos de pruebas antes de corregir el código. La creación del repositorio temporal de la prueba Git necesitó corregir su preparación; ese fallo era del test, no del producto.

## Decisiones de conservación

- La integración manual es conservadora con enlaces simbólicos: los deja como conflicto para resolución explícita; no implementa una fusión automática de enlaces.
- Una integración que devuelve conflictos guarda una huella marcada `conflicts:`. No autoriza borrar la copia de trabajo solo porque el diff de la sesión no haya cambiado. Después de resolver, hay que confirmar un reintento de integración sin conflictos antes de limpiar. Si se ha elegido una resolución manual distinta de ambas versiones y el reintento vuelve a chocar, se conserva la rama; no se ofrece aquí una eliminación forzada.
- No se tocó el remoto del usuario para probar errores ni se alteraron credenciales/red del Mac. Los casos de autenticación y remoto ausente son pruebas controladas, no una simulación completa de todos los proveedores.

## Norma obligatoria de semáforo

Se conserva la captura aprobada en `docs/referencias/semaforo-macos.png` y la norma en `PLAN.md`: margen superior e izquierdo de 16 puntos, diámetro aproximado de 14, separación de 23 entre centros y cabecera lateral reservada de 48. La configuración nativa usa `{ x: 16, y: 16 }`; la separación entre controles nativos la mantiene macOS. El mock de navegador reproduce 23 puntos entre centros. No modificar este espaciado en futuros rediseños sin nueva indicación del usuario.

## Límites que permanecen

No se ha agotado de verdad la cuota de cada proveedor, caducado las credenciales ni cortado la red del usuario. Tampoco se ha provocado un apagado durante una integración o escritura ya aprobada: la recuperación tras cierre forzado con permiso pendiente consta en el informe de instalación. La resolución específica por bloques todavía no tiene un recorrido visual completo acreditado. La firma sigue siendo ad hoc local, sin notarización. No se afirma ausencia total de fallos.

## Actualización instalada al terminar

Se recompiló la copia congelada de la instalación anterior, actualizando `isolate.rs`, las nuevas pruebas de protocolo y Git y `trafficLightPosition` a 16/16. Paquete release instalado en `/Applications/Filigranas.app`, con firma ad hoc verificada y arranque observado desde `tauri://localhost`.

SHA-256 del ejecutable final firmado: `a58ce14cb894b9d9bd2e6b0d4273a103c6ab0e7dfd6a2dd6587b737f1fe44447`. Manifiesto final: `validacion-macos-2026-11-17-fuentes.json`. Sustituye al hash anterior para identificar la instalación vigente; la versión declarada sigue siendo 0.1.0.

La norma del semáforo queda además en `AGENTS.md` para futuras sesiones. La captura de la ventana en la prueba final tenía superpuesto el indicador morado de ventana compartida sobre los controles; por eso no se acredita una medición visual exacta de los tres botones durante esa captura. Sí se comprobaron la configuración nativa y las medidas del mock contra la referencia guardada.
