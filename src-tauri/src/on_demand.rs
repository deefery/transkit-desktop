//! Windows created on first use instead of at startup (fork task P2).
//!
//! Live Interpreter (`monitor`), the Voice Anywhere button (`voice_anywhere`) and its caption
//! (`voice_anywhere_caption`) used to be declared in tauri.conf.json, so their pages (one WebView2
//! renderer each) were loaded at every start whether or not they were ever used. They are now built
//! here, with the same properties, the first time they are needed. Once created they are only
//! hidden, never destroyed, exactly as before.
use crate::APP;
use log::info;
use tauri::{Manager, Window, WindowBuilder, WindowUrl};

pub const MONITOR: &str = "monitor";
pub const VOICE_ANYWHERE: &str = "voice_anywhere";
pub const VOICE_ANYWHERE_CAPTION: &str = "voice_anywhere_caption";

/// The window with `label`, built on first use. Returns `(window, created_now)`.
pub fn window(label: &str) -> Option<(Window, bool)> {
    let app = APP.get()?;
    if let Some(existing) = app.get_window(label) {
        return Some((existing, false));
    }
    let builder = WindowBuilder::new(app, label, WindowUrl::App("index.html".into()))
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false);
    let builder = match label {
        MONITOR => builder
            .title("Live Interpreter")
            .inner_size(720.0, 400.0)
            .min_inner_size(400.0, 60.0),
        VOICE_ANYWHERE => builder
            .title("Voice Input")
            .inner_size(144.0, 144.0)
            .min_inner_size(120.0, 120.0)
            .resizable(false),
        VOICE_ANYWHERE_CAPTION => builder
            .title("Voice Input Caption")
            .inner_size(380.0, 92.0)
            .min_inner_size(280.0, 64.0)
            .resizable(false),
        _ => return None,
    };
    match builder.build() {
        Ok(window) => {
            info!("[OnDemand] created window '{label}'");
            Some((window, true))
        }
        Err(error) => {
            log::warn!("[OnDemand] could not create window '{label}': {error}");
            None
        }
    }
}
