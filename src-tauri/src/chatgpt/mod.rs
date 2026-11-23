//! "Use my ChatGPT plan" support: sign in with a ChatGPT account and spend its plan quota instead of
//! an API key.
//!
//! Everything credential-related stays in this Rust process. The webview only gets account state
//! (`chatgpt_status`) and results of requests (`chatgpt_respond`); it never receives a token.
//! Design notes: `.ai/architecture/CHATGPT-SUBSCRIPTION-v1.md`.

mod errors;
mod oauth;
mod responses;
mod store;

use errors::{requires_reauth, ChatGptError};
use responses::{InputMessage, ModelInfo};
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use store::{Connection, ConnectionStatus};
use tauri::{Manager, State};

/// Refresh when the access token has less than this long to live.
const REFRESH_MARGIN_MS: i64 = 60_000;
const MODEL_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

pub struct ChatGptState {
    /// Serializes every read-modify-write of the saved connection, in particular token refresh:
    /// a rotated refresh token is single-use, so two concurrent refreshes would lose the account.
    lock: tauri::async_runtime::Mutex<()>,
    sign_in_cancel: Mutex<Option<Arc<AtomicBool>>>,
    default_model: Mutex<Option<(String, Instant)>>,
}

impl ChatGptState {
    pub fn new() -> Self {
        Self {
            lock: tauri::async_runtime::Mutex::new(()),
            sign_in_cancel: Mutex::new(None),
            default_model: Mutex::new(None),
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub status: &'static str,
    /// Whether the plan-sharing permission was granted (required to actually use the plan).
    pub sharing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

fn session_of(connection: Option<&Connection>) -> SessionState {
    let disconnected = SessionState { status: "disconnected", sharing: false, email: None, name: None };
    let Some(c) = connection else { return disconnected };
    let status = match (c.status, c.tokens.is_some()) {
        (ConnectionStatus::Connected, true) => "connected",
        (ConnectionStatus::ReauthRequired, _) => "reauth_required",
        _ => return disconnected,
    };
    SessionState {
        status,
        sharing: status == "connected" && c.has_sharing(),
        email: c.email.clone(),
        name: c.name.clone(),
    }
}

fn path() -> Result<PathBuf, ChatGptError> {
    store::default_path()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A usable access token, refreshed (and persisted) first when it is about to expire.
async fn access_token(state: &ChatGptState) -> Result<String, ChatGptError> {
    let _guard = state.lock.lock().await;
    let path = path()?;
    let connection = store::load(&path)?.ok_or_else(ChatGptError::not_connected)?;
    match connection.status {
        ConnectionStatus::ReauthRequired => return Err(ChatGptError::reauth_required()),
        ConnectionStatus::Disconnected => return Err(ChatGptError::not_connected()),
        ConnectionStatus::Connected => {}
    }
    if !connection.has_sharing() {
        return Err(ChatGptError::sharing_not_enabled());
    }
    let tokens = connection.tokens.clone().ok_or_else(ChatGptError::not_connected)?;
    if tokens.expires_at_ms - REFRESH_MARGIN_MS > now_ms() {
        return Ok(tokens.access_token);
    }
    match oauth::refresh(&connection).await {
        Ok(next) => {
            // Persist before use: the previous refresh token is already consumed.
            store::save(&path, &next)?;
            Ok(next.tokens.map(|t| t.access_token).unwrap_or_default())
        }
        Err(error) if requires_reauth(&error.code) => {
            store::save(&path, &connection.signed_out(ConnectionStatus::ReauthRequired))?;
            Err(error)
        }
        Err(error) => Err(error),
    }
}

async fn resolve_model(state: &ChatGptState, token: &str, requested: &str) -> Result<String, ChatGptError> {
    let requested = requested.trim();
    if !requested.is_empty() {
        return Ok(requested.to_string());
    }
    if let Some((model, at)) = state.default_model.lock().unwrap().as_ref() {
        if at.elapsed() < MODEL_CACHE_TTL {
            return Ok(model.clone());
        }
    }
    let first = responses::list_models(token)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| {
            ChatGptError::new(
                "no_models",
                "ChatGPT listed no models for this account. Enter a model name manually.",
                false,
            )
        })?;
    *state.default_model.lock().unwrap() = Some((first.slug.clone(), Instant::now()));
    Ok(first.slug)
}

// ---------------------------------------------------------------------------------------------
// Tauri commands

#[tauri::command]
pub async fn chatgpt_status(state: State<'_, ChatGptState>) -> Result<SessionState, ChatGptError> {
    let _guard = state.lock.lock().await;
    Ok(session_of(store::load(&path()?)?.as_ref()))
}

#[tauri::command]
pub async fn chatgpt_sign_in(
    window: tauri::Window,
    state: State<'_, ChatGptState>,
    reconsent: Option<bool>,
) -> Result<SessionState, ChatGptError> {
    let cancel = Arc::new(AtomicBool::new(false));
    // A newer sign-in supersedes one that is still waiting for its browser callback (typically left
    // over after the settings window was closed), instead of failing with "already in progress".
    let superseded = state.sign_in_cancel.lock().unwrap().replace(cancel.clone());
    if let Some(old) = superseded {
        log::info!("[chatgpt] cancelling the earlier sign-in that was still waiting");
        old.store(true, Ordering::SeqCst);
        // Give its listener a moment to notice and release the port.
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(600))).await;
    }
    log::info!("[chatgpt] sign-in requested");
    let result = run_sign_in(&window, &state, reconsent.unwrap_or(false), cancel.clone()).await;
    {
        // Only clear the slot if it is still ours; a newer sign-in may have taken it over.
        let mut slot = state.sign_in_cancel.lock().unwrap();
        if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
            *slot = None;
        }
    }
    match &result {
        Ok(session) => log::info!("[chatgpt] sign-in finished: {}", session.status),
        Err(e) => log::warn!("[chatgpt] sign-in failed: {} ({})", e.code, e.message),
    }
    result
}

async fn run_sign_in(
    window: &tauri::Window,
    state: &ChatGptState,
    reconsent: bool,
    cancel: Arc<AtomicBool>,
) -> Result<SessionState, ChatGptError> {
    let path = path()?;
    let previous = {
        let _guard = state.lock.lock().await;
        store::load(&path)?
    };
    let scope = window.shell_scope();
    let known_client = previous.as_ref().map(|c| c.client_id.clone());
    let connection = oauth::sign_in(
        previous.as_ref(),
        reconsent,
        cancel,
        |url| tauri::api::shell::open(&scope, url, None).map_err(|e| e.to_string()),
        |client_id| {
            // Keep the issued registration even if the code exchange fails afterwards.
            if known_client.as_deref() != Some(client_id) && previous.is_none() {
                store::save(&path, &Connection::registration_only(client_id))?;
            }
            Ok(())
        },
    )
    .await?;
    let _guard = state.lock.lock().await;
    store::save(&path, &connection)?;
    *state.default_model.lock().unwrap() = None;
    Ok(session_of(Some(&connection)))
}

#[tauri::command]
pub fn chatgpt_cancel_sign_in(state: State<'_, ChatGptState>) {
    if let Some(cancel) = state.sign_in_cancel.lock().unwrap().as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignOutResult {
    /// `false` when ChatGPT could not confirm the remote revocation (local credentials are gone anyway).
    pub revoked: bool,
}

#[tauri::command]
pub async fn chatgpt_sign_out(state: State<'_, ChatGptState>) -> Result<SignOutResult, ChatGptError> {
    let _guard = state.lock.lock().await;
    let path = path()?;
    *state.default_model.lock().unwrap() = None;
    let connection = match store::load(&path) {
        Ok(found) => found,
        Err(_) => {
            // An unreadable file must not trap the user: removing it is the recovery.
            store::delete(&path)?;
            return Ok(SignOutResult { revoked: true });
        }
    };
    let Some(connection) = connection else {
        return Ok(SignOutResult { revoked: true });
    };
    // Remove local credentials first, keeping only the OAuth registration so the next sign-in does
    // not register another app. Identity is dropped so a different account can be used next.
    store::save(&path, &Connection::registration_only(&connection.client_id))?;
    Ok(SignOutResult { revoked: oauth::revoke(&connection).await.is_ok() })
}

#[tauri::command]
pub async fn chatgpt_list_models(state: State<'_, ChatGptState>) -> Result<Vec<ModelInfo>, ChatGptError> {
    let token = access_token(&state).await?;
    responses::list_models(&token).await
}

/// Run one request on the signed-in plan. With `stream`, each text delta is also emitted to the
/// calling window as `chatgpt-delta` `{ id, delta }`; the full text is always the return value.
#[tauri::command]
pub async fn chatgpt_respond(
    window: tauri::Window,
    state: State<'_, ChatGptState>,
    request_id: String,
    model: String,
    instructions: Option<String>,
    input: Vec<InputMessage>,
    stream: bool,
) -> Result<String, ChatGptError> {
    responses::validate_input(&input)?;
    let token = access_token(&state).await?;
    let model = resolve_model(&state, &token, &model).await?;
    responses::stream_response(&token, &model, instructions.as_deref(), &input, |delta| {
        if stream {
            let _ = window.emit("chatgpt-delta", json!({ "id": request_id, "delta": delta }));
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use store::Tokens;

    fn connection(status: ConnectionStatus, with_tokens: bool, sharing: bool) -> Connection {
        Connection {
            version: 1,
            client_id: "c".into(),
            status,
            scopes: if sharing { vec![oauth::SHARING_SCOPE.into()] } else { vec!["openid".into()] },
            subject: Some("s".into()),
            email: Some("a@b.c".into()),
            name: None,
            tokens: with_tokens.then(|| Tokens { access_token: "t".into(), refresh_token: Some("r".into()), expires_at_ms: 1 }),
        }
    }

    #[test]
    fn session_state_mapping() {
        assert_eq!(session_of(None).status, "disconnected");
        let ok = session_of(Some(&connection(ConnectionStatus::Connected, true, true)));
        assert_eq!((ok.status, ok.sharing), ("connected", true));
        let no_share = session_of(Some(&connection(ConnectionStatus::Connected, true, false)));
        assert_eq!((no_share.status, no_share.sharing), ("connected", false));
        let reauth = session_of(Some(&connection(ConnectionStatus::ReauthRequired, false, true)));
        assert_eq!((reauth.status, reauth.sharing), ("reauth_required", false));
        assert_eq!(session_of(Some(&connection(ConnectionStatus::Disconnected, false, true))).status, "disconnected");
        // A "connected" record without tokens is not usable.
        assert_eq!(session_of(Some(&connection(ConnectionStatus::Connected, false, true))).status, "disconnected");
    }

    #[test]
    fn session_state_never_serializes_tokens() {
        let json = serde_json::to_string(&session_of(Some(&connection(ConnectionStatus::Connected, true, true)))).unwrap();
        assert!(!json.contains("token") && !json.contains("\"t\""));
        assert!(json.contains("\"email\":\"a@b.c\""));
    }
}
