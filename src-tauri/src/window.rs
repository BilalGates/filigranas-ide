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
/// barra lateral, que deja ver el material.
pub fn apply_effects(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
        use std::time::Duration;
        use dispatch2::{DispatchQueue, DispatchTime};
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
        let pending = Arc::new(AtomicBool::new(false));
        let settle = Duration::from_millis(48);
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Focused(true)) {
                // Window events may arrive before AppKit's final titlebar layout.
                // Keep one trailing correction on the main queue during a live resize.
                if pending.swap(true, Ordering::Relaxed) {
                    return;
                }
                let target = handle.clone();
                let queued = Arc::clone(&pending);
                let scheduled = DispatchTime::try_from(settle).ok().and_then(|when| {
                    DispatchQueue::main().after(when, move || {
                        queued.store(false, Ordering::Relaxed);
                        layout_traffic_lights(&target);
                    }).ok()
                });
                if scheduled.is_none() {
                    pending.store(false, Ordering::Relaxed);
                }
            }
        });
    }
    // Windows: la ventana no lleva marco (tauri.windows.conf.json) y la
    // interfaz dibuja sus botones de ventana. Windows 11 pone Mica oscuro
    // bajo la barra lateral; en Windows 10 no hay Mica y el fondo es negro.
    #[cfg(target_os = "windows")]
    {
        let mica = window_vibrancy::apply_mica(window, Some(true)).is_ok();
        let _ = BACKDROP.set(mica);
        if !mica {
            let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));
}

#[cfg(target_os = "windows")]
static BACKDROP: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Si la ventana deja ver un material nativo detrás de la barra lateral.
#[tauri::command]
pub fn window_backdrop() -> bool {
    #[cfg(target_os = "macos")]
    return true;
    #[cfg(target_os = "windows")]
    return BACKDROP.get().copied().unwrap_or(false);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return false;
}
