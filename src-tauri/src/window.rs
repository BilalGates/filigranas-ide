use tauri::WebviewWindow;

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
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));
}
