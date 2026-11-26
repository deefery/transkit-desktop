//! Opening local folders and files in the system file manager / default app.
//!
//! The front end may only open web links itself; local locations go through these commands, which
//! resolve the folder on this side or check the file before handing it to the OS.

use std::path::{Path, PathBuf};
use tauri::api::path::{app_config_dir, app_log_dir, document_dir};
use tauri::AppHandle;

/// Folder name under Documents where Live Interpreter keeps transcripts.
const TRANSCRIPTS_DIR: &str = "TransKit";
/// File types `open_saved_file` will open; transcripts are written as Markdown or plain text.
const OPENABLE_EXTENSIONS: [&str; 2] = ["md", "txt"];

fn launch(target: &Path, select: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = {
        let mut command = std::process::Command::new("explorer");
        if select {
            // One argument: explorer parses "/select,<path>" itself.
            let mut arg = std::ffi::OsString::from("/select,");
            arg.push(target);
            command.arg(arg);
        } else {
            command.arg(target);
        }
        command.spawn()
    };
    #[cfg(target_os = "macos")]
    let result = {
        let mut command = std::process::Command::new("open");
        if select {
            command.arg("-R");
        }
        command.arg(target).spawn()
    };
    #[cfg(target_os = "linux")]
    let result = {
        let target = if select { target.parent().unwrap_or(target) } else { target };
        std::process::Command::new("xdg-open").arg(target).spawn()
    };
    result.map(|_| ()).map_err(|e| format!("Failed to open {}: {}", target.display(), e))
}

/// The folder for `kind`: `config`, `log` or `transcripts`.
pub fn app_folder(app: &AppHandle, kind: &str) -> Result<PathBuf, String> {
    let config = app.config();
    let dir = match kind {
        "config" => app_config_dir(&config),
        "log" => app_log_dir(&config),
        "transcripts" => document_dir().map(|d| d.join(TRANSCRIPTS_DIR)),
        _ => return Err(format!("Unknown folder: {kind}")),
    };
    dir.ok_or_else(|| format!("Could not resolve the {kind} folder"))
}

/// Opens one of the app's own folders (see `app_folder`), creating it first if needed.
#[tauri::command]
pub fn open_app_folder(app: AppHandle, kind: String) -> Result<(), String> {
    let dir = app_folder(&app, &kind)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    launch(&dir, false)
}

/// Checks that `path` is an existing transcript-type file (absolute, `.md` or `.txt`).
pub fn check_openable_file(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("Path must be absolute".into());
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !OPENABLE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Only saved text files can be opened".into());
    }
    let canonical = path.canonicalize().map_err(|e| format!("File not found: {e}"))?;
    if !canonical.is_file() {
        return Err("Not a file".into());
    }
    Ok(path.to_path_buf())
}

/// Opens a saved transcript with the default app, or shows it in its folder when `reveal` is set.
#[tauri::command]
pub fn open_saved_file(path: String, reveal: bool) -> Result<(), String> {
    let file = check_openable_file(&path)?;
    launch(&file, reveal)
}

#[cfg(test)]
mod tests {
    use super::check_openable_file;

    #[test]
    fn only_existing_text_files_are_openable() {
        let dir = std::env::temp_dir().join(format!("transkit-open-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let md = dir.join("transcript.MD");
        let exe = dir.join("tool.exe");
        let sub = dir.join("folder.md");
        std::fs::write(&md, "x").unwrap();
        std::fs::write(&exe, "x").unwrap();
        std::fs::create_dir_all(&sub).unwrap();

        assert!(check_openable_file(md.to_str().unwrap()).is_ok());
        assert!(check_openable_file(exe.to_str().unwrap()).is_err());
        assert!(check_openable_file(sub.to_str().unwrap()).is_err());
        assert!(check_openable_file(dir.join("missing.md").to_str().unwrap()).is_err());
        assert!(check_openable_file("transcript.md").is_err());

        std::fs::remove_dir_all(&dir).ok();
    }
}
