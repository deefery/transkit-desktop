//! Error type shared by every ChatGPT-subscription operation.
//!
//! Errors cross the Tauri IPC boundary as plain objects (`{ code, message, retryable, ... }`), so
//! the webview can branch on `code` (for example to offer "sign in again") without ever seeing a
//! credential. Messages are written here, never taken from a server response, because validation
//! errors from the service can echo the submitted text.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl std::fmt::Display for ChatGptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl ChatGptError {
    pub fn new(code: &str, message: &str, retryable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            retryable,
            status: None,
            request_id: None,
        }
    }

    pub fn with_status(mut self, status: Option<u16>) -> Self {
        self.status = status;
        self
    }

    pub fn with_request_id(mut self, request_id: Option<&str>) -> Self {
        self.request_id = request_id.and_then(safe_identifier).map(str::to_string);
        self
    }

    pub fn network() -> Self {
        Self::new(
            "network_error",
            "Could not reach ChatGPT. Check your connection and try again.",
            true,
        )
    }

    pub fn not_connected() -> Self {
        Self::new(
            "not_connected",
            "Not signed in to ChatGPT. Sign in from the service settings first.",
            false,
        )
    }

    pub fn reauth_required() -> Self {
        Self::new(
            "reauth_required",
            "Your ChatGPT connection can no longer be renewed. Sign in again.",
            false,
        )
    }

    pub fn sharing_not_enabled() -> Self {
        Self::new(
            "sharing_not_enabled",
            "You are signed in, but ChatGPT plan usage sharing was not granted. Sign in again and allow it.",
            false,
        )
    }

    pub fn storage(detail: &str) -> Self {
        Self::new(
            "storage_error",
            &format!("The saved ChatGPT connection could not be accessed: {detail}"),
            false,
        )
    }
}

/// Only short, boring identifiers are echoed back (request ids, error codes).
pub fn safe_identifier(value: &str) -> Option<&str> {
    let ok = !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-' | '[' | ']'))
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    ok.then_some(value)
}

/// Codes from a failed refresh that mean the saved session is gone for good.
pub fn requires_reauth(code: &str) -> bool {
    matches!(
        code,
        "invalid_grant"
            | "invalid_refresh_token"
            | "token_expired"
            | "refresh_token_expired"
            | "refresh_token_invalidated"
            | "refresh_token_reused"
    )
}

fn known(code: &str) -> Option<(&'static str, bool)> {
    Some(match code {
        "subscription_sharing_user_not_eligible" | "subscription_sharing_v2_user_not_eligible" => (
            "Using your plan in other apps is not available for this ChatGPT account or workspace.",
            false,
        ),
        "subscription_sharing_usage_limit_exceeded" => (
            "A ChatGPT usage limit has been reached. Check your usage in ChatGPT settings.",
            false,
        ),
        "subscription_sharing_usage_unavailable" => (
            "ChatGPT usage could not be checked. Try again shortly.",
            true,
        ),
        "subscription_sharing_unsupported_capability" => (
            "This request uses a capability that plan sharing does not support.",
            false,
        ),
        "subscription_sharing_route_not_supported"
        | "subscription_sharing_v2_route_not_supported" => (
            "This request uses a route that plan sharing does not support.",
            false,
        ),
        "subscription_sharing_invalid_user" | "subscription_sharing_v2_invalid_user" => (
            "ChatGPT could not validate this account's subscription. Sign in again.",
            false,
        ),
        "subscription_sharing_user_unavailable"
        | "subscription_sharing_v2_user_unavailable" => (
            "Your ChatGPT account is temporarily unavailable. Try again shortly.",
            true,
        ),
        "subscription_sharing_v2_client_not_enabled" => (
            "ChatGPT has not enabled plan sharing for this app.",
            false,
        ),
        "chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context" => (
            "The permissions granted to this app do not allow this request. Sign in again.",
            false,
        ),
        "invalid_client" => (
            "ChatGPT rejected this app's saved registration. Sign out and sign in again.",
            false,
        ),
        "invalid_grant" => (
            "ChatGPT did not accept this authorization. Start sign-in again.",
            false,
        ),
        "invalid_refresh_token"
        | "token_expired"
        | "refresh_token_expired"
        | "refresh_token_invalidated"
        | "refresh_token_reused" => (
            "Your ChatGPT connection can no longer be renewed. Sign in again.",
            false,
        ),
        "invalid_token" | "invalid_api_key" => (
            "ChatGPT did not accept the saved credential. Sign in again.",
            false,
        ),
        "access_denied" => ("Sign-in was not completed.", false),
        "model_not_found" => (
            "This model is not available for your ChatGPT connection. Pick another model.",
            false,
        ),
        _ => return None,
    })
}

/// Classify an error body returned by the auth or Responses endpoints. OAuth errors carry a string
/// `error`; Responses errors carry `error.code`. Free-text `detail` is never a machine code.
pub fn api_error(body: &Value, status: Option<u16>, request_id: Option<&str>) -> ChatGptError {
    let mut detail = body;
    for _ in 0..4 {
        if let Some(inner) = detail.get("error").filter(|v| v.is_object()) {
            detail = inner;
        } else if let Some(inner) = detail.get("detail").filter(|v| v.is_object()) {
            detail = inner;
        } else {
            break;
        }
    }
    let raw_code = detail
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| detail.get("code").and_then(Value::as_str));
    let code = raw_code
        .and_then(|c| (c.len() <= 100).then_some(c))
        .and_then(safe_identifier)
        .unwrap_or("api_error");

    let make = |message: &str, retryable: bool| {
        ChatGptError::new(code, message, retryable)
            .with_status(status)
            .with_request_id(request_id)
    };
    if let Some((message, retryable)) = known(code) {
        return make(message, retryable);
    }
    match status {
        Some(400) | Some(422) => make(
            "ChatGPT rejected this request. Check the model and the request options.",
            false,
        ),
        _ if code == "invalid_request_error" || code == "invalid_request" => make(
            "ChatGPT rejected this request. Check the model and the request options.",
            false,
        ),
        Some(401) => make(
            "ChatGPT did not accept the signed-in identity or its plan-sharing permission. Sign in again.",
            false,
        ),
        Some(403) => make(
            "A ChatGPT policy or permission restriction prevented this request.",
            false,
        ),
        Some(429) => make("Too many requests. Wait a moment before trying again.", true),
        Some(s) if s >= 500 => make(
            "ChatGPT is temporarily unavailable. Try again shortly.",
            true,
        ),
        _ => make("ChatGPT could not complete this request.", false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn oauth_error_string_maps_to_reauth() {
        let err = api_error(&json!({"error": "invalid_grant"}), Some(400), None);
        assert_eq!(err.code, "invalid_grant");
        assert!(requires_reauth(&err.code));
        assert!(!err.retryable);
    }

    #[test]
    fn nested_responses_error_code_is_used() {
        let body = json!({"error": {"code": "subscription_sharing_usage_limit_exceeded", "message": "secret user text"}});
        let err = api_error(&body, Some(429), Some("req_123"));
        assert_eq!(err.code, "subscription_sharing_usage_limit_exceeded");
        assert!(!err.message.contains("secret"));
        assert_eq!(err.request_id.as_deref(), Some("req_123"));
    }

    #[test]
    fn unknown_code_falls_back_on_status() {
        assert!(api_error(&json!({}), Some(429), None).retryable);
        assert!(api_error(&json!({}), Some(503), None).retryable);
        assert!(!api_error(&json!({}), Some(403), None).retryable);
        assert_eq!(api_error(&json!("not an object"), None, None).code, "api_error");
    }

    #[test]
    fn unsafe_identifiers_are_dropped() {
        let err = api_error(&json!({"error": "has spaces and <script>"}), Some(400), Some("bad id!"));
        assert_eq!(err.code, "api_error");
        assert!(err.request_id.is_none());
    }

    #[test]
    fn free_text_detail_is_not_a_code() {
        let err = api_error(&json!({"detail": "Usage limit hit, buy more"}), Some(429), None);
        assert_eq!(err.code, "api_error");
    }
}
