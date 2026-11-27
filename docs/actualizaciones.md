# CI y actualizaciones de Filigranas

Implementación preparada el 27 de noviembre de 2026. La consulta autenticada de GitHub confirmó que BilalGates/filigranas-ide es público. No se ha publicado una Release durante esta tarea.

## Funcionamiento

CI verifica PR y main en macOS y Windows con TypeScript, Vite, pruebas Node, Rust, Clippy y auditorías de dependencias. Release reutiliza esa verificación y vuelve a probar el código seleccionado antes de empaquetar macOS arm64, macOS x86_64 y Windows x86_64 NSIS. Intel se compila desde Apple Silicon mediante el target oficial de Rust. Su ejecución nativa requiere comprobarse en Intel.

Tras un push a main, Release genera desarrollo. Una ejecución manual desde main puede promover una Release de desarrollo validada indicando su tag como candidate y el canal stable. Se comprueba que el candidato es una prerelease publicada y pertenece a la historia de main. Se recompila y verifica antes de publicar.

El esquema de versión es 0.2.RUN_NUMBER-dev.0 para desarrollo y 0.2.RUN_NUMBER para estable. El contador pertenece al mismo workflow para ambos canales. Los cuatro archivos de versión se ajustan únicamente en el checkout efímero del runner. Cada Release conserva SHA, canal, PR asociadas y notas generadas por GitHub. Mantener el workflow y su contador. Si se sustituye por otro workflow, asignar un esquema superior antes de activarlo. Un reintento de publicación con el mismo tag falla y requiere inspeccionar la Release borrador. Las publicaciones se serializan con queue max para conservar hasta 100 ejecuciones pendientes. GitHub cancela las adicionales si se supera ese límite.

Los paquetes se firman con Tauri. Antes de subirlos se comprueba la firma con la clave pública y la versión incluida en el comentario firmado. La CLI debe producir firmas con campo version, o la comprobación detiene la publicación. El manifiesto se genera solo con la matriz completa. Primero se publican los paquetes y después el manifiesto del canal. Un fallo deja el manifiesto anterior o un borrador para diagnóstico.

La app consulta por HTTPS un manifiesto fijo por canal en las Releases channel-stable y channel-development. Solo acepta paquetes bajo el repositorio aprobado. El plugin oficial verifica la firma al descargar y al instalar, incluida la versión firmada. Estable rechaza toda versión prerelease aunque aparezca en su manifiesto. El canal elegido se guarda en SQLite y empieza en estable.

Ajustes → Actualizaciones permite buscar, ver notas, descargar, posponer y autorizar instalación y reinicio. Hay consulta al arrancar y cada seis horas. La campana utiliza el centro de notificaciones de Trama. Las descargas verificadas permanecen en memoria durante la sesión. Reiniciar exige descargarlas de nuevo.

La instalación vuelve a comprobar turnos/tareas persistidos, Claude y agentes ACP abiertos, terminales, servicios, actualizaciones de CLI, comprobaciones externas, arranque de Codex, operaciones estructuradas de Codex y operaciones Git. Se bloquea el arranque concurrente de terminales/servicios y las reservas de nuevos turnos durante la instalación. Los procesos de agente abiertos pueden exigir cerrar su sesión aunque estén esperando entrada. Codex utiliza las reservas de turnos de SQLite para distinguir actividad de su servidor persistente en reposo. El actualizador conserva el identificador com.filigranas.ide, el directorio de datos y SQLite. Ejecuta un checkpoint WAL antes del reemplazo. Guardar los borradores del editor antes de autorizar el reinicio.

## Configuración de GitHub

Crear el entorno release-signing y el entorno release-publishing. Configurar revisores obligatorios en release-publishing durante el despliegue inicial. Para automatizar desarrollo después de validarlo, ajustar esa protección según la política del repositorio. Las versiones estables siguen requiriendo ejecutar manualmente la promoción.

Configurar en el repositorio o en release-signing la variable UPDATER_PUBLIC_KEY con el contenido base64 de la clave pública generada por Tauri. La misma clave pública queda incorporada en plugins.updater.pubkey de tauri.conf.json. El cliente utiliza esa configuración también en compilaciones locales. FILIGRANAS_UPDATER_PUBLIC_KEY permite al workflow comprobar que su clave de verificación coincide con la incorporada en la app. Una discrepancia detiene la compilación publicable.

Guardar en release-signing los secretos siguientes.

| Nombre | Contenido |
| --- | --- |
| TAURI_SIGNING_PRIVATE_KEY | Clave privada de actualización Tauri, contenido completo |
| TAURI_SIGNING_PRIVATE_KEY_PASSWORD | Contraseña de esa clave, vacía si se creó sin contraseña |
| APPLE_CERTIFICATE | Opcional, certificado Developer ID Application con su clave privada en p12 codificado base64 |
| APPLE_CERTIFICATE_PASSWORD | Contraseña del p12 |
| APPLE_SIGNING_IDENTITY | Identidad Developer ID Application correspondiente |
| APPLE_ID | Apple ID para notarización |
| APPLE_PASSWORD | Contraseña específica de aplicación del Apple ID |
| APPLE_TEAM_ID | Equipo Apple Developer |

El par de claves se generó una sola vez fuera del checkout con pnpm tauri signer generate y se comprobó con una firma real y un rechazo tras alterar el archivo. Se custodia en ~/.config/filigranas/updater con directorio 0700, clave privada y contraseña aleatoria en archivos 0600. Conservar una copia privada segura en otro medio. No regenerarlo entre versiones. La pérdida de la clave impide actualizar las instalaciones que confían en ella. No añadir claves privadas, p12 ni contraseñas al repositorio. La firma Tauri es obligatoria. Para el uso personal solicitado, el workflow usa firma ad hoc mediante APPLE_SIGNING_IDENTITY=- cuando no se aporta identidad Apple. Verifica el bundle con codesign antes de subirlo. Gatekeeper puede bloquear la primera apertura y pedir aprobación en Ajustes del Sistema → Privacidad y seguridad. La firma Apple y la notarización se aplicarían al aportar el juego completo de credenciales Apple. Windows necesita firma Authenticode adicional para distribución sin advertencias de SmartScreen.

El token efímero de Actions tiene contents read salvo en el trabajo de publicación, que recibe contents write y pull-requests read. No se incorpora ningún token al cliente. Habilitar Actions y permitir las acciones fijadas por SHA. Las ramas deben requerir CI antes de fusionar. La variable de repositorio RELEASES_ENABLED debe valer true para habilitar la preparación y publicación. Hasta entonces solo se ejecuta la verificación reutilizable.

La publicación comprueba de nuevo que el repositorio es público. Si pasa a privado, se bloquea. Las descargas privadas requerirían un servicio autenticado o URLs temporales y una decisión de distribución. Un PAT embebido en la app expondría el acceso. No cambiar el repositorio a público como mecanismo de despliegue.

## Activación y primera instalación

1. Revisar e integrar los cambios mediante el flujo habitual del IDE. Configurar entornos, variables, secretos y protección de rama.
2. Activar RELEASES_ENABLED y fusionar una PR en main. Revisar CI, las tres compilaciones y la verificación de firmas. Autorizar release-publishing si tiene revisión obligatoria.
3. Revisar la prerelease v0.2.N-dev.0 y sus paquetes. Una app antigua sin plugin necesita instalar una primera compilación con actualizador. Reemplazar la instalación existente requiere la autorización expresa del usuario. No crear una segunda aplicación local.
4. Elegir Desarrollo en Ajustes para probar una actualización posterior de desarrollo. Descargarla y verificar la firma. Intentar instalar con un agente, terminal y servicio activos por separado. Debe posponerse sin perder la descarga.
5. Terminar procesos, guardar archivos y autorizar instalar/reiniciar. Comprobar versión nueva, proyectos, conversaciones, sesiones y reapertura de SQLite.
6. Ejecutar Release manualmente desde main con channel stable y candidate igual al tag de desarrollo validado. Se genera una nueva versión estable superior.
7. Comprobar en Estable que detecta esa versión y que ignora prereleases. Repetir Buscar actualizaciones usando ya la última versión.

No borrar los paquetes referenciados por manifiestos. Si hay que retirar una versión, publicar una versión corregida superior y actualizar el canal mediante el workflow. El mecanismo no permite downgrades automáticos.

## Evidencia y aceptación pendiente

Las pruebas locales cubren el versionado sincronizado, la matriz incompleta, las URLs por arquitectura y el rechazo de orígenes ajenos. Las suites habituales cubren migraciones y persistencia existentes. Las pruebas del generador usan archivos sintéticos y no acreditan una firma ni publicación real.

La prueba release_artifacts_verify permanece ignorada en la suite local porque requiere artefactos firmados y la clave pública. El workflow la ejecuta explícitamente antes de subir cada plataforma.

Quedan pendientes en GitHub los casos PR correcta/fallida, merge real, subida de paquetes, firma efectiva, notarización y publicación. También quedan pendientes la detección, ausencia de actualización en última versión, descarga, rechazo de firma alterada, instalación/reinicio y persistencia con una aplicación empaquetada real. Requieren configurar credenciales y autorizar el reemplazo de la instalación habitual. pnpm tauri dev no acredita esa aceptación.

Fuentes consultadas el 27 de noviembre de 2026. [Cola de concurrencia de GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency). [Actualizador oficial Tauri](https://v2.tauri.app/plugin/updater/) y [firma y notarización macOS](https://v2.tauri.app/distribute/sign/macos/). La integración utiliza tauri-plugin-updater 2.14.1 y la CLI 2.12.4 fijada en pnpm-lock.yaml.


## Estado de activación del 27 de noviembre de 2026

- Actions habilitado y repositorio público, con permisos de administración comprobados.
- Entornos release-signing y release-publishing creados y restringidos a la rama main.
- release-publishing requiere aprobación de BilalGates, incluida la posibilidad de aprobar sus propias ejecuciones.
- Secretos TAURI_SIGNING_PRIVATE_KEY y TAURI_SIGNING_PRIVATE_KEY_PASSWORD cargados en release-signing. GitHub permite comprobar su existencia, pero no recuperar su valor.
- Variable UPDATER_PUBLIC_KEY configurada y comprobada contra la clave local. La clave pública también está en la configuración de Tauri.
- RELEASES_ENABLED está explícitamente en false.
- La firma de un archivo real de preflight se verificó con la clave pública. Una modificación del archivo fue rechazada. Esta prueba todavía no acredita la instalación de una aplicación.
- El ruleset activo main · CI obligatoria exige PR y los checks Desktop (macos-15), Desktop (windows-2025) y Dependency security. Sus nombres coinciden con CI. El resultado real de los nuevos workflows sigue pendiente antes de autorizar la publicación.
- La implementación está en el checkout local. GitHub todavía solo informa del workflow CI y no tiene Releases publicadas.
- La instalación actual utiliza com.filigranas.ide y versión 0.1.0. Se obtuvo un respaldo consistente de su SQLite con integrity_check correcto en /private/tmp/filigranas-before-updater-activation. Ese respaldo es local y privado.

El usuario ha decidido continuar sin Apple Developer por ahora. La alternativa preparada combina firma ad hoc para el bundle y firma Tauri para los paquetes de actualización. Una cuenta Apple gratuita tampoco permite notarizar. Developer ID y notarización quedarían como mejora futura para reducir las intervenciones de Gatekeeper. También se puede mantener la instalación manual de paquetes ad hoc revisados mientras se valida el actualizador. No se debe desactivar Gatekeeper globalmente.

## Prueba real A → B preparada

La prueba utiliza dos ejecuciones del workflow sobre el mismo commit integrado. El contador da versiones diferentes y evita introducir un commit artificial solo para probar la actualización.

1. Tras autorizar push y merge, integrar el código y comprobar CI en GitHub. Mantener RELEASES_ENABLED en false durante esa revisión. Inspeccionar el diff, la clave pública y la configuración de los entornos.
2. Con autorización expresa para activar y publicar, fijar RELEASES_ENABLED=true y ejecutar Release desde main con channel=development. Revisar las tres compilaciones, verificación de firmas y bundle macOS. El entorno release-publishing espera la aprobación del usuario. Esta es la versión A.
3. Descargar el paquete A. Verificar la firma Tauri, la versión firmada y codesign. Con autorización expresa, guardar los archivos, finalizar turnos y reemplazar la única instalación de /Applications/Filigranas.app. Aprobar su primera apertura en Privacidad y seguridad si macOS lo solicita.
4. Abrir A y comprobar proyectos, conversaciones, sesiones y datos. Seleccionar Desarrollo en Ajustes. Obtener un respaldo e inventario de referencia A con el script profile-snapshot.py.
5. Con la autorización correspondiente, volver a ejecutar Release desde main con channel=development. Confirmar que B tiene versión superior, el mismo origen previsto y firma válida. Aprobar su publicación y comprobar que el manifiesto development apunta a B.
6. En A, Buscar actualizaciones debe anunciar B en la campana. Comprobar notas y versión. Descargar B y verificar que la interfaz indica descarga verificada.
7. Intentar instalar con un terminal abierto, con un servicio y con un turno de agente activos, por separado. La instalación debe quedar pospuesta. Terminar esos procesos y comprobar que la descarga sigue disponible.
8. Guardar los borradores. Finalizar todos los turnos, incluido el PM si está ejecutándose dentro de Filigranas. El usuario autoriza Instalar y reiniciar desde la interfaz. Un PM activo no debe eludir la protección de sesiones para instalar su propia actualización.
9. Tras reiniciar en B, comprobar la versión, proyectos y conversaciones visibles, y obtener un segundo respaldo. Comparar integridad, identidades y contenido de SQLite. Las diferencias de metadatos por cierre/reapertura se revisan explícitamente. Buscar actualizaciones debe indicar que ya se utiliza la última versión.
10. Comprobar que el canal Estable no anuncia B como actualización de desarrollo. La promoción a estable requiere su validación y autorización propias.

El script local scripts/release/profile-snapshot.py abre SQLite en modo lectura, realiza un respaldo consistente y genera inventarios con hashes. El respaldo contiene datos personales y debe permanecer fuera del repositorio con permisos privados. compare informa cambios y no declara automáticamente aprobada la migración.

Ejemplo de respaldo, usando una carpeta nueva cada vez.

```sh
python3 scripts/release/profile-snapshot.py snapshot --database "$HOME/Library/Application Support/com.filigranas.ide/filigranas.db" --output /private/tmp/filigranas-update-before-A
python3 scripts/release/profile-snapshot.py compare /private/tmp/filigranas-update-before-A /private/tmp/filigranas-update-after-B
```

La aceptación operativa exige observar realmente A → B con instalación y reinicio. Las pruebas de firma, compilación y configuración por sí solas dejan esta aceptación pendiente.


## Evidencia local de paquetes A y B

Se generaron, con autorización del usuario, dos paquetes reales macOS arm64 desde una copia del checkout con versiones sincronizadas 0.2.0-dev.1 y 0.2.0-dev.2. Ambos bundles pasaron codesign --verify --deep --strict y ambos archivos de actualización pasaron la verificación Tauri con su versión firmada. El rechazo de un archivo de prueba alterado también se comprobó. Los artefactos y su manifest.json están en /private/tmp/filigranas-packaged-preflight-6tvfaox0. El manifiesto registra el SHA base, la huella de los archivos del checkout y los hashes de cada paquete. Son candidatos de prueba locales.

La evaluación real spctl del bundle ad hoc devolvió rejected. Su identidad de bundle es com.filigranas.ide, arquitectura arm64 y Signature=adhoc. Esto confirma que el paquete necesita aprobación manual en macOS. La aplicación instalada conserva la versión 0.1.0 durante esta preparación. Todavía falta descargar una actualización por el plugin, autorizar su instalación, observar el reinicio y comparar el perfil después de la actualización.
