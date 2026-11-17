# Instrucciones del proyecto

## Norma obligatoria: semáforo de macOS

Igualar el espaciado del semáforo de ChatGPT, según la referencia aprobada por el usuario el 2026-11-17. Referencia: [captura](docs/referencias/semaforo-macos.png), especificación en `PLAN.md`.

- Margen superior e izquierdo: 16 puntos lógicos (`trafficLightPosition: { x: 16, y: 16 }`).
- Diámetro aproximado: 14 puntos; 23 entre centros en la referencia; controles nativos en macOS.
- Reservar 48 puntos para la cabecera lateral; reproducir la referencia en la vista de navegador.
- No compactar, desplazar ni cambiar este espaciado en rediseños sin petición expresa del usuario. Verificar visualmente tras cambios de ventana o Tauri.

`trafficLightPosition` solo desplaza el grupo: no fija la separación. `window.rs` debe colocar también los botones nativos a 23 puntos entre centros y reaplicar el layout tras redimensionar, recuperar foco o salir de pantalla completa.
