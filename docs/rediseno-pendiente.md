# Rediseño · propuesta original

Diseño de referencia: artefacto «Filigranas — rediseño» (https://claude.ai/artifact/C3VRYTr5qHv7TrvCnhJcL3).
Lista original del rediseño, conservada como referencia. El [inventario de aceptación](aceptacion-v1.md) y la [auditoría técnica](auditoria-tecnica.md) recogen el estado comprobado.

## Agentes
- [ ] **Respuestas escuetas.** Añadir a las instrucciones de todos los perfiles: «responde lo justo: resultado primero, sin repetir el encargo ni narrar pasos; máximo 2–3 frases salvo que se pida detalle».
- [ ] **Nombres aleatorios** de leyendas del FC Barcelona al crear sesión (kubala, samitier, cruyff, neeskens, migueli, zubizarreta, koeman, stoichkov, romario, rivaldo, basora, cesar, rexach, laudrup, sotil, alexanco, amor, nadal…), sin repetir dentro del proyecto. Renombrar desde la pestaña.
- [ ] **Coordinador → project manager.** Renombrar el perfil y su etiqueta (`pm` en la pestaña).
- [ ] **Estado en la pestaña.** Trabajando: borde animado. Pide permiso: punto rojo. La sección «agentes» de la barra lateral desaparece.
- [ ] **Acciones plegadas.** Las lecturas y comandos de un turno se agrupan en «N acciones», desplegable.

## Sonido
- [ ] Tonos cortos (WebAudio, sin archivos): enviar, agente termina, agente pide permiso, clic suave en cambios de pestaña y menús.
- [ ] Silenciar con ⌘⇧M; guardar la preferencia. Icono en la barra inferior solo cuando está silenciado.

## Atajos (globales en la ventana)
⌘K comandos · ⌘/ atajos · ⌘1–9 pestañas · ⌘T nueva sesión · ⌘W cerrar pestaña · ⌘↩ enviar · ⌘. detener ·
⌘M modelo · ⌘⇧E esfuerzo · ⌘Y / ⌘N permitir / denegar · ⌘P abrir archivo · ⌘J terminal · ⌘B barra lateral ·
⌘I columna derecha · ⌘G git · ⌘⇧O contenedores · ⌘⇧C commit · ⌘⇧P commit y push · ⌘⇧G proponer de nuevo ·
⌘U uso · ⌘⇧M silenciar · ⌘⇧L tema
- [ ] Paleta ⌘K con navegación por flechas y Enter; cada comando muestra su atajo.

## Editor
- [ ] El editor es una pestaña más: se abre al pulsar un archivo (árbol, cambios o diff) y se cierra con × o ⌘W.

## Barra lateral
- [ ] Elegir un proyecto no despliega su carpeta; el árbol se abre con la flecha de la fila.

## Git (columna derecha)
- [ ] Cabecera: botón de rama y botón de contenedores, a la derecha. En git, el botón de rama abre el selector; en contenedores, vuelve a git.
- [ ] Commit al estilo Cursor: mensaje arriba ya redactado por Larry (editable), commits extra apilados debajo, botón «commit · N» con menú (commit, commit y push, commit y sincronizar, amend).
- [ ] Pull y push visibles; fetch, stash, stash pop, deshacer último commit y pull request en el menú «···».

## Barra inferior
- [ ] Izquierda: ruta del proyecto. Derecha: uso (5 h y semana). Fuera tema, nº de proyectos y «herramientas».
- [ ] El panel de uso incluye el estado de las CLI (antes «herramientas»), con acción para iniciar sesión si falta.

## Aspecto (tokens)
- Monocromo. Rojo sutil solo para acciones (`rgba(229,72,77,.12)` de fondo, `#ff8a8e` de texto). Azul solo para indicar (pestaña activa, proyecto abierto, rama).
- Esquinas 6–8 px en botones y recuadros, 10–12 px en menús y paleta.
- Iosevka en toda la interfaz.
- Movimiento 120–260 ms, `cubic-bezier(.22,1,.36,1)`; `prefers-reduced-motion` lo desactiva.
