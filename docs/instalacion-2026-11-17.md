# Instalación y comprobaciones en macOS — 17 de noviembre de 2026

## Paquete instalado

- Ubicación: `/Applications/Filigranas.app`, versión declarada `0.1.0`, arm64.
- Base Git: `5f4e7b8` más cambios del árbol de trabajo, incluidos el rediseño actual y las correcciones de integración binaria/temporales. Se congeló el código en `/private/tmp/filigranas-install-17-eik8uka1` antes de compilar para evitar cambios concurrentes. Después se añadió a esa copia la corrección de pausa descrita abajo.
- Manifiesto SHA-256 de los archivos fuente de la copia final: `docs/instalacion-2026-11-17-fuentes.json`.
- Compilación: `tauri build --bundles app --ci`, release con frontend empaquetado; TypeScript y Vite correctos. Batería de la copia congelada: **46 correctas, 0 fallos, 6 externas ignoradas por defecto**. La última corrección, solo de interfaz, pasó de nuevo la compilación de producción.
- SHA-256 del ejecutable instalado después de firmarlo: `160e2d0bad35701d46842f5aa4f08a57db36149f6117d708a97f241382048f11`.
- Respaldo de la app anterior: `/private/tmp/Filigranas-anterior-17.app`. Es temporal; macOS puede eliminarlo.
- El paquete generado inicialmente no superaba `codesign --verify --deep --strict` (firma del ejecutable sin sellar recursos del bundle). Se completó una firma **ad hoc local** del paquete instalado y se verificó correctamente. No es firma Developer ID ni notarización y no acredita distribución a otros Mac.

## Comprobado en la app instalada

1. **Arranque empaquetado:** abre desde `/Applications` con URL `tauri://localhost`, carga 13 proyectos y la interfaz actual. No usa la página `localhost:1420`. Se detuvo nuestra ejecución de desarrollo; quedó otro Vite en ese puerto. Por tanto, se ha observado carga desde recursos internos, pero no se ha hecho una prueba con todos los servidores Vite del Mac apagados.
2. **Persistencia:** aparecen las sesiones iniesta y puyol, historial del coordinador y ramas sin integrar existentes, sin migración manual ni borrado de datos.
3. **Perfil corregido:** en el hilo existente se seleccionó Pep; se mostró la marca del cambio y el modelo contestó «Pep Guardiola». Las respuestas anteriores permanecieron etiquetadas como coordinador. Al terminar se restauró Hansi Flick.
4. **Pausa con permiso pendiente:** se pidió a Claude crear únicamente `docs/qa-permiso-pendiente-17.md`. Con Write esperando permiso, «pausar» conservaba la tarjeta de aprobación y mostraba error de ejecución: fallo reproducido.
5. **Corrección instalada y repetida:** `Session.tsx` retira los permisos al recibir `paused`, deja de arrancar/ejecutar y evita presentar el resultado de la interrupción como error si la sesión está pausada. Se volvió a compilar, instalar y verificar el paquete. Al repetir la misma prueba, la cabecera pasó a «en pausa», desapareció la tarjeta y no apareció el error. No se otorgó permiso para escribir.
6. **Cierre forzado:** se reanudó la sesión de prueba y se cerró con SIGKILL exclusivamente el proceso de `/Applications/Filigranas.app`. Al reabrir se recuperaron historial, rama y conversación; el proveedor había registrado la cancelación de la petición sin respuesta. No se creó el archivo sin permiso. Esta prueba se hizo coincidiendo con la reinstalación final; acredita recuperación de datos, no continuidad transparente del mismo proceso de proveedor.
7. **Turno posterior:** después del reinicio y de repetir la pausa se envió una orden sin herramientas. Claude respondió «recuperacion correcta» y quedó inactivo. Se verificó en disco que el archivo no aprobado sigue ausente.

## Pendientes que no quedan acreditados aquí

- Windows/MSI; firma Developer ID y notarización.
- Agotamiento real de cuota, caída real de red y credenciales caducadas. No se gastó la cuota artificialmente ni se cambiaron credenciales del usuario.
- Resolución por bloques del componente específico de conflictos; ejecutables, renombres, enlaces y borrado/modificación en integración. La fusión de binarios y el aislamiento de rutas sí tienen pruebas automatizadas previas.
- Cierre forzado en medio de una escritura ya aprobada o integración: no se provocó sobre trabajo real del usuario.
- La app conserva versión `0.1.0`; identificar esta instalación por el hash anterior y el manifiesto, no solo por el número.

La instalación contiene una copia fija de los cambios; las modificaciones posteriores del repositorio no entran automáticamente en ella. Los documentos y la corrección de pausa quedan en el árbol de trabajo para revisión, sin crear commits ni publicar otra PR.
