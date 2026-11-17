use tauri::WebviewWindow;

/// Referencia aprobada de ChatGPT: margen hasta el borde del botón y
/// distancia entre sus centros, en puntos lógicos de macOS (no píxeles Retina).
#[cfg(target_os = "macos")]
fn layout_traffic_lights(window: &WebviewWindow) {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() { return; }
    // SAFETY: Tauri entrega el NSWindow de esta ventana. Esta función se
    // llama desde setup o run_on_main_thread; no se retiene el puntero.
    let native = unsafe { &*ptr.cast::<NSWindow>() };
    if native.styleMask().contains(objc2_app_kit::NSWindowStyleMask::FullScreen) { return; }
    let kinds = [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton];
    for (i, kind) in kinds.into_iter().enumerate() {
        let Some(button) = native.standardWindowButton(kind) else { continue };
        let in_window = button.convertRect_toView(button.bounds(), None);
        let mut frame = NSView::frame(&button);
        let desired_x = 16.0 + i as f64 * 23.0;
        let actual_top = native.frame().size.height - in_window.origin.y - in_window.size.height;
        frame.origin.x += desired_x - in_window.origin.x;
        frame.origin.y += actual_top - 16.0;
        button.setFrameOrigin(frame.origin);
    }
}

/// macOS: la ventana lleva Liquid Glass oscuro (HudWindow como reserva en
/// macOS 15 o anterior). La interfaz pinta todo de negro opaco salvo la
/// barra lateral, que deja ver el material. En Windows, fondo negro.
pub fn apply_effects(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use tauri::window::{Color, Effect, EffectState, EffectsBuilder};

        let effects = EffectsBuilder::new()
            .effect(Effect::LiquidGlassRegular)
            .effect(Effect::HudWindow)
            .state(EffectState::Active)
            .color(Color(0, 0, 0, 150))
            .build();
        if let Err(e) = window.set_effects(effects) {
            eprintln!("efectos de ventana no disponibles: {e}");
        }
        layout_traffic_lights(window);
        let handle = window.clone();
        window.on_window_event(move |event| {
            // AppKit/Tao vuelven a colocar los botones al redimensionar o
            // salir de pantalla completa. Aplicar después su layout nativo.
            if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Focused(true)) {
                let target = handle.clone();
                let _ = handle.run_on_main_thread(move || layout_traffic_lights(&target));
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));
}
