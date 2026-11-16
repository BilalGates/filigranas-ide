use tauri::WebviewWindow;

/// Aplica el material translúcido nativo de cada plataforma:
/// vibrancy «sidebar» en macOS y Mica en Windows 11.
pub fn apply_effects(window: &WebviewWindow) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use tauri::window::{Effect, EffectState, EffectsBuilder};

        #[cfg(target_os = "macos")]
        let effect = Effect::Sidebar;
        #[cfg(target_os = "windows")]
        let effect = Effect::Mica;

        let effects = EffectsBuilder::new()
            .effect(effect)
            .state(EffectState::FollowsWindowActiveState)
            .build();
        if let Err(e) = window.set_effects(effects) {
            eprintln!("efectos de ventana no disponibles: {e}");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = window;
}
