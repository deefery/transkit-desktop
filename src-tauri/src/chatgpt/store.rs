//! Persistence of the signed-in ChatGPT connection.
//!
//! The file lives next to `config.json` but is deliberately a separate file: the backup/restore
//! code only archives `config.json`, `history.db` and plugins, so credentials never leave the
//! machine in a backup. The webview never reads this file; tokens stay in the Rust process.
//!
//! Protection at rest:
//! * Windows: encrypted with DPAPI (bound to the current Windows user).
//! * Other platforms: **not yet OS-encrypted**. The file is written owner-only (0600) as a stopgap;
//!   wiring Keychain / Secret Service is a known follow-up. See `.ai/architecture/CHATGPT-SUBSCRIPTION-v1.md`.

use super::errors::ChatGptError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "chatgpt-connection.bin";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix epoch milliseconds.
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Connected,
    Disconnected,
    ReauthRequired,
}

/// One saved connection. `client_id` is the dynamically issued OAuth registration; it is kept after
/// sign-out so signing in again does not register a new app every time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Connection {
    pub version: u32,
    pub client_id: String,
    pub status: ConnectionStatus,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tokens: Option<Tokens>,
}

impl Connection {
    pub fn registration_only(client_id: &str) -> Self {
        Self {
            version: 1,
            client_id: client_id.to_string(),
            status: ConnectionStatus::Disconnected,
            scopes: Vec::new(),
            subject: None,
            email: None,
            name: None,
            tokens: None,
        }
    }

    pub fn has_sharing(&self) -> bool {
        self.scopes.iter().any(|s| s == super::oauth::SHARING_SCOPE)
    }

    /// Drop credentials but keep the registration and who the account was.
    pub fn signed_out(mut self, status: ConnectionStatus) -> Self {
        self.tokens = None;
        self.status = status;
        self
    }
}

pub fn default_path() -> Result<PathBuf, ChatGptError> {
    let identifier = crate::APP
        .get()
        .map(|app| app.config().tauri.bundle.identifier.clone())
        .ok_or_else(|| ChatGptError::storage("application not ready"))?;
    let dir = dirs::config_dir()
        .ok_or_else(|| ChatGptError::storage("no config directory"))?
        .join(identifier);
    Ok(dir.join(FILE_NAME))
}

pub fn load(path: &Path) -> Result<Option<Connection>, ChatGptError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ChatGptError::storage(&e.to_string())),
    };
    let plain = platform::unprotect(&bytes).map_err(|e| ChatGptError::storage(&e))?;
    let connection: Connection = serde_json::from_slice(&plain)
        .map_err(|_| ChatGptError::storage("saved data is damaged; sign out and sign in again"))?;
    if connection.version != 1 {
        return Err(ChatGptError::storage("saved data has an unknown version"));
    }
    Ok(Some(connection))
}

pub fn save(path: &Path, connection: &Connection) -> Result<(), ChatGptError> {
    let plain = serde_json::to_vec(connection).map_err(|e| ChatGptError::storage(&e.to_string()))?;
    let protected = platform::protect(&plain).map_err(|e| ChatGptError::storage(&e))?;
    write_atomic(path, &protected).map_err(|e| ChatGptError::storage(&e.to_string()))
}

pub fn delete(path: &Path) -> Result<(), ChatGptError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ChatGptError::storage(&e.to_string())),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(windows)]
mod platform {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    const MAGIC: &[u8] = b"TKGPT-DPAPI1\n";
    // Binds the blob to this feature; other DPAPI users of the same Windows account cannot reuse it.
    const ENTROPY: &[u8] = b"transkit-chatgpt-connection-v1";

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(out.pbData as *mut _));
        bytes
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(plain);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|e| format!("Windows could not encrypt the credentials: {e}"))?;
            let mut result = MAGIC.to_vec();
            result.extend(take(out));
            Ok(result)
        }
    }

    pub fn unprotect(stored: &[u8]) -> Result<Vec<u8>, String> {
        let body = stored
            .strip_prefix(MAGIC)
            .ok_or_else(|| "saved data was not written by this version".to_string())?;
        let input = blob(body);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|_| {
                "Windows could not decrypt the saved credentials (different Windows user?)".to_string()
            })?;
            Ok(take(out))
        }
    }
}

#[cfg(not(windows))]
mod platform {
    const MAGIC: &[u8] = b"TKGPT-FILE0\n";

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let mut result = MAGIC.to_vec();
        result.extend_from_slice(plain);
        Ok(result)
    }

    pub fn unprotect(stored: &[u8]) -> Result<Vec<u8>, String> {
        stored
            .strip_prefix(MAGIC)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "saved data was not written by this version".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Connection {
        Connection {
            version: 1,
            client_id: "client_abc".into(),
            status: ConnectionStatus::Connected,
            scopes: vec!["openid".into(), super::super::oauth::SHARING_SCOPE.into()],
            subject: Some("sub_1".into()),
            email: Some("user@example.com".into()),
            name: None,
            tokens: Some(Tokens {
                access_token: "synthetic-access-token".into(),
                refresh_token: Some("synthetic-refresh-token".into()),
                expires_at_ms: 1_900_000_000_000,
            }),
        }
    }

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("transkit-chatgpt-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join(FILE_NAME)
    }

    #[test]
    fn round_trip_and_missing_file() {
        let path = temp_path("rt");
        assert_eq!(load(&path).unwrap(), None);
        save(&path, &sample()).unwrap();
        assert_eq!(load(&path).unwrap(), Some(sample()));
        delete(&path).unwrap();
        assert_eq!(load(&path).unwrap(), None);
        delete(&path).unwrap();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn tokens_are_not_readable_in_the_file() {
        let path = temp_path("enc");
        save(&path, &sample()).unwrap();
        let raw = std::fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&raw);
        #[cfg(windows)]
        {
            assert!(!text.contains("synthetic-access-token"));
            assert!(!text.contains("synthetic-refresh-token"));
        }
        #[cfg(not(windows))]
        let _ = text;
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn damaged_file_is_an_error_not_a_silent_reset() {
        let path = temp_path("bad");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"garbage").unwrap();
        assert_eq!(load(&path).unwrap_err().code, "storage_error");
        assert!(path.exists(), "a damaged file must be preserved");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn signed_out_keeps_registration_and_identity() {
        let out = sample().signed_out(ConnectionStatus::Disconnected);
        assert!(out.tokens.is_none());
        assert_eq!(out.client_id, "client_abc");
        assert_eq!(out.email.as_deref(), Some("user@example.com"));
    }
}
