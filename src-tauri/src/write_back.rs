//! Write back (fork task W1): remember the window a selection came from, and paste a rewrite of
//! that selection back over it.
//!
//! Safety limits:
//! - The target is only ever the window captured when the selection hotkey ran. The frontend
//!   passes text, never a window, so it cannot paste into an arbitrary window.
//! - The frontend must name the original text, and it must equal the captured selection
//!   (whitespace-insensitive). Text typed into the Translate window, or sent over the local HTTP
//!   API, has no source window and is never written back.
//! - The replacement always goes to the clipboard first, so every failure still leaves it ready
//!   to paste by hand. A successful paste clears the source: a second paste would duplicate it.
//! - Windows only for now; other platforms get the clipboard copy and "unsupported".
use log::{info, warn};
use once_cell::sync::Lazy;
use std::sync::Mutex;

#[derive(Clone)]
struct Source {
    window: isize,
    text: String,
}

static SOURCE: Lazy<Mutex<Option<Source>>> = Lazy::new(|| Mutex::new(None));

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The window in the foreground right now, unless it belongs to this app (a selection made inside
/// a TransKit window has nothing to write back to). Call before reading the selection.
pub fn foreground_window() -> Option<isize> {
    platform::foreground_window()
}

/// Remember where the selection `text` came from (None forgets the previous one).
pub fn remember(window: Option<isize>, text: &str) {
    let text = normalize(text);
    let source = match window {
        Some(window) if !text.is_empty() => Some(Source { window, text }),
        _ => None,
    };
    info!("[WriteBack] source {}", if source.is_some() { "captured" } else { "cleared" });
    *SOURCE.lock().unwrap() = source;
}

/// Forget the source (the Translate window now shows text that was not selected in another app).
pub fn clear() {
    *SOURCE.lock().unwrap() = None;
}

fn matching_source(original: &str) -> Result<Source, String> {
    let source = SOURCE.lock().unwrap().clone().ok_or_else(|| "no-source".to_string())?;
    if normalize(original) != source.text {
        return Err("source-changed".into());
    }
    Ok(source)
}

/// Can `original` be replaced in the window it was selected in?
#[tauri::command]
pub fn can_replace_selection(original: String) -> bool {
    cfg!(windows) && matching_source(&original).map(|s| platform::is_window(s.window)).unwrap_or(false)
}

/// Copy `text` to the clipboard, then paste it over the original selection in its window.
/// Errors (the text is on the clipboard in every case except "clipboard-failed"): "no-source",
/// "source-changed", "source-closed", "focus-failed", "paste-failed", "unsupported".
#[tauri::command(async)]
pub fn replace_selection(original: String, text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|_| "clipboard-failed".to_string())?;
    clipboard.set_text(&text).map_err(|_| "clipboard-failed".to_string())?;
    if !cfg!(windows) {
        return Err("unsupported".into());
    }
    let source = matching_source(&original)?;
    let outcome = platform::paste_into(source.window);
    match &outcome {
        Ok(()) => {
            info!("[WriteBack] pasted into the source window");
            clear();
        }
        Err(code) => warn!("[WriteBack] paste failed: {code}"),
    }
    outcome
}

#[cfg(windows)]
mod platform {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_V,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindow, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    fn hwnd(window: isize) -> HWND {
        HWND(window as *mut _)
    }

    pub fn foreground_window() -> Option<isize> {
        unsafe {
            let window = GetForegroundWindow();
            if window.0.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(window, Some(&mut pid));
            if pid == std::process::id() {
                return None;
            }
            Some(window.0 as isize)
        }
    }

    pub fn is_window(window: isize) -> bool {
        unsafe { IsWindow(hwnd(window)).as_bool() }
    }

    pub fn paste_into(window: isize) -> Result<(), String> {
        if !is_window(window) {
            return Err("source-closed".into());
        }
        let target = hwnd(window);
        unsafe {
            if IsIconic(target).as_bool() {
                let _ = ShowWindow(target, SW_RESTORE);
            }
            let _ = SetForegroundWindow(target);
        }
        // Give the window time to take the focus; never send keys to whatever else is in front.
        let mut focused = false;
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(30));
            if unsafe { GetForegroundWindow() } == target {
                focused = true;
                break;
            }
        }
        if !focused {
            return Err("focus-failed".into());
        }
        let key = |vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        };
        let inputs = [
            key(VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
            key(VK_V, KEYBD_EVENT_FLAGS(0)),
            key(VK_V, KEYEVENTF_KEYUP),
            key(VK_CONTROL, KEYEVENTF_KEYUP),
        ];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Err("paste-failed".into());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn foreground_window() -> Option<isize> {
        None
    }
    pub fn is_window(_window: isize) -> bool {
        false
    }
    pub fn paste_into(_window: isize) -> Result<(), String> {
        Err("unsupported".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test: the source is process-wide state.
    #[test]
    fn source_matching() {
        remember(Some(42), "  hello\n  world ");
        assert!(matching_source("hello world").is_ok());
        assert_eq!(matching_source("hello there").err().as_deref(), Some("source-changed"));
        remember(None, "hello");
        assert_eq!(matching_source("hello").err().as_deref(), Some("no-source"));
        remember(Some(42), "   ");
        assert_eq!(matching_source("").err().as_deref(), Some("no-source"));
        remember(Some(7), "text");
        clear();
        assert_eq!(matching_source("text").err().as_deref(), Some("no-source"));
    }
}
