# Norma obligatoria del semáforo de Filigranas IDE

Decisión del 17 de noviembre de 2026. La [captura aprobada](../../../../../docs/referencias/semaforo-macos.png) muestra el espaciado de ChatGPT.

- Usa 16 puntos lógicos de margen superior e izquierdo, botones nativos de unos 14 puntos de diámetro y 23 puntos entre centros.
- Reserva 48 puntos para la cabecera lateral y reproduce las medidas en navegador.
- Mantén `trafficLightPosition: { x: 16, y: 16 }` y fija expresamente los 23 puntos entre centros en `src-tauri/src/window.rs`. Tauri solo desplaza el grupo.
- Reaplica al redimensionar, recuperar el foco o salir de pantalla completa. Comprueba visualmente si cambias ventana o Tauri. Cambia estas medidas solo a petición expresa del usuario.
