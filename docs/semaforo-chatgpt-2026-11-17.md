# Semáforo nativo como ChatGPT — 17 de noviembre de 2026

El usuario señaló que el espaciado de la app seguía sin respetar la referencia y pidió igualarlo al de ChatGPT. La herramienta de UI no permite inspeccionar ChatGPT (`com.openai.codex`), por lo que se utilizó la captura proporcionada por el usuario, conservada en `referencias/semaforo-macos.png`.

## Causa y corrección

En Tao, `inset_traffic_lights` usa `trafficLightPosition` para desplazar el grupo y calcula el paso horizontal a partir de la posición previa de los dos primeros botones. Ese parámetro no fija la separación entre botones y tampoco garantiza por sí solo el margen visual desde el borde superior.

`src-tauri/src/window.rs` coloca ahora explícitamente Close, Miniaturize y Zoom usando sus NSView reales y sus coordenadas en la ventana:

- Margen superior e izquierdo hasta el botón: 16 puntos lógicos.
- Paso horizontal: 23 puntos (los botones tienen el mismo tamaño nativo).
- Se mantiene el tamaño y el comportamiento nativos.
- Se reaplica después de redimensionar, cambiar de escala o recuperar el foco. No se mueve el semáforo en pantalla completa; el evento de redimensionado permite recolocarlo al volver.

Se añadieron dependencias AppKit solo para macOS. Se actualizaron `AGENTS.md`, `PLAN.md` y el comentario del mock: la norma exige la colocación nativa, no solo `trafficLightPosition`.

## Comprobación e instalación

- `cargo check --offline`: correcto.
- Compilación release empaquetada con frontend: correcta.
- Instalada en `/Applications/Filigranas.app`, firma local ad hoc verificada.
- SHA-256 del ejecutable instalado: `dfebb2130c5a95214ee1de4da1f181551a9c00af4027b82507394172d737c91b`.
- Arranque comprobado desde `tauri://localhost`. La primera captura mostró los tres botones nativos sin superposición: margen de 16 y centros en torno a x=23,46,69, coincidentes con la referencia.
- El intento de arrastre posterior no acreditó un cambio de tamaño de la ventana y activó el indicador de compartir ventana sobre los botones; no se afirma una prueba visual completa de resize/fullscreen a partir de él.

Para instalar se reutilizó la copia congelada de la instalación anterior actualizando `window.rs`, `Cargo.toml` y `Cargo.lock`; no se incorporaron los desarrollos concurrentes del resto de la interfaz. El hash anterior queda sustituido por el de este informe para identificar la app instalada. Los cambios nuevos siguen sin commit.
