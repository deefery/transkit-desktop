//! Calls made with the ChatGPT access token: the Responses API (streaming) and the model catalog.
//!
//! Requests are always `store: false` and `stream: true`; the stream is accumulated here and
//! optionally forwarded delta-by-delta to the caller. Redirects are disabled (see `oauth::http`).

use super::errors::{api_error, ChatGptError};
use super::oauth::http;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const API_BASE: &str = "https://api.openai.com/v1";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct InputMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ModelInfo {
    pub slug: String,
    pub display_name: String,
}

fn request_id_of(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

pub fn validate_input(input: &[InputMessage]) -> Result<(), ChatGptError> {
    let bad = input.is_empty()
        || input
            .iter()
            .any(|m| !matches!(m.role.as_str(), "user" | "assistant" | "developer"));
    if bad {
        return Err(ChatGptError::new(
            "invalid_request",
            "Use text messages with user, assistant or developer roles; put system guidance in instructions.",
            false,
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Server-sent events

/// Incremental SSE decoder. Feed it raw chunks; it returns the `data:` payload of every complete
/// event. Handles `\r\n`, multi-line `data:` fields and events split across chunks.
#[derive(Default)]
pub struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        loop {
            let Some((end, sep)) = find_event_end(&self.buffer) else {
                break;
            };
            let block: Vec<u8> = self.buffer.drain(..end + sep).collect();
            let text = String::from_utf8_lossy(&block[..end]);
            let data: Vec<&str> = text
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|rest| rest.strip_prefix(' ').unwrap_or(rest))
                .collect();
            if !data.is_empty() {
                events.push(data.join("\n"));
            }
        }
        events
    }
}

/// Position of the first blank line (event terminator) and its length.
fn find_event_end(buf: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < buf.len() {
        if buf[i..].starts_with(b"\r\n\r\n") {
            return Some((i, 4));
        }
        if buf[i..].starts_with(b"\n\n") {
            return Some((i, 2));
        }
        i += 1;
    }
    None
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Delta(String),
    Completed,
    Ignore,
}

/// Interpret one decoded event payload.
pub fn interpret_event(data: &str, status: u16, request_id: Option<&str>) -> Result<Step, ChatGptError> {
    if data.trim() == "[DONE]" {
        return Ok(Step::Completed);
    }
    let event: Value = serde_json::from_str(data).map_err(|_| {
        ChatGptError::new(
            "invalid_stream",
            "The response stream contained an invalid event. Try again.",
            true,
        )
    })?;
    match event.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta") => Ok(event
            .get("delta")
            .and_then(Value::as_str)
            .map_or(Step::Ignore, |d| Step::Delta(d.to_string()))),
        Some("response.completed") => Ok(Step::Completed),
        Some("response.failed") => Err(api_error(
            event.get("response").unwrap_or(&event),
            Some(status),
            request_id,
        )),
        Some("error") => Err(api_error(&event, Some(status), request_id)),
        Some("response.incomplete") => Err(ChatGptError::new(
            "response_incomplete",
            "ChatGPT stopped before completing the response. Try again.",
            true,
        )),
        _ => Ok(Step::Ignore),
    }
}

pub async fn stream_response(
    access_token: &str,
    model: &str,
    instructions: Option<&str>,
    input: &[InputMessage],
    mut on_delta: impl FnMut(&str),
) -> Result<String, ChatGptError> {
    validate_input(input)?;
    if model.trim().is_empty() {
        return Err(ChatGptError::new("invalid_request", "No model selected.", false));
    }
    let mut body = json!({
        "model": model,
        "input": input.iter().map(|m| json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
        "store": false,
        "stream": true,
    });
    if let Some(text) = instructions.filter(|t| !t.trim().is_empty()) {
        body["instructions"] = json!(text);
    }

    let mut response = http()
        .post(format!("{API_BASE}/responses"))
        .bearer_auth(access_token)
        .header("Accept", "text/event-stream")
        .json(&body)
        .timeout(RESPONSE_TIMEOUT)
        .send()
        .await
        .map_err(|_| ChatGptError::network())?;
    let status = response.status();
    let request_id = request_id_of(&response);

    if !status.is_success() {
        let parsed: Value = response.json().await.unwrap_or(Value::Null);
        return Err(api_error(&parsed, Some(status.as_u16()), request_id.as_deref()));
    }
    // The direct route can omit Content-Type; only reject a clearly wrong one.
    if let Some(content_type) = response.headers().get("content-type").and_then(|v| v.to_str().ok()) {
        let essence = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if !essence.is_empty() && essence != "text/event-stream" {
            return Err(ChatGptError::new(
                "invalid_stream",
                "ChatGPT did not return the expected response stream.",
                true,
            )
            .with_status(Some(status.as_u16())));
        }
    }

    let interrupted = || {
        ChatGptError::new(
            "stream_interrupted",
            "The response ended before completion. Try again.",
            true,
        )
    };
    let mut decoder = SseDecoder::default();
    let mut text = String::new();
    let mut completed = false;
    'read: while let Some(chunk) = response.chunk().await.map_err(|_| interrupted())? {
        for data in decoder.push(&chunk) {
            match interpret_event(&data, status.as_u16(), request_id.as_deref())? {
                Step::Delta(delta) => {
                    text.push_str(&delta);
                    if text.len() > MAX_RESPONSE_BYTES {
                        return Err(ChatGptError::new(
                            "response_too_large",
                            "The response was too large. Try a smaller request.",
                            false,
                        ));
                    }
                    on_delta(&delta);
                }
                Step::Completed => {
                    completed = true;
                    break 'read;
                }
                Step::Ignore => {}
            }
        }
    }
    if !completed {
        return Err(interrupted());
    }
    Ok(text)
}

// ---------------------------------------------------------------------------------------------
// Model catalog

pub fn parse_models(body: &Value) -> Vec<ModelInfo> {
    body.get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
                .filter_map(|m| {
                    let slug = m.get("slug")?.as_str()?.trim();
                    let name = m.get("display_name").and_then(Value::as_str).unwrap_or(slug).trim();
                    (!slug.is_empty() && slug.len() <= 200).then(|| ModelInfo {
                        slug: slug.to_string(),
                        display_name: if name.is_empty() { slug } else { name }.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub async fn list_models(access_token: &str) -> Result<Vec<ModelInfo>, ChatGptError> {
    let response = http()
        .get(format!("{API_BASE}/models"))
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| ChatGptError::network())?;
    let status = response.status();
    let request_id = request_id_of(&response);
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(api_error(&body, Some(status.as_u16()), request_id.as_deref()));
    }
    if !body.get("models").is_some_and(Value::is_array) {
        return Err(ChatGptError::new(
            "invalid_model_catalog",
            "ChatGPT returned an unexpected model list. Try again.",
            true,
        ));
    }
    Ok(parse_models(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_handles_split_and_crlf_events() {
        let mut d = SseDecoder::default();
        assert!(d.push(b"data: {\"a\":").is_empty());
        assert_eq!(d.push(b"1}\n\ndata: two\r\n\r\nevent: x\ndata: a\ndata: b\n\n"), vec!["{\"a\":1}", "two", "a\nb"]);
        assert!(d.push(b": comment\n\n").is_empty());
    }

    #[test]
    fn interpret_known_events() {
        let delta = r#"{"type":"response.output_text.delta","delta":"Hi"}"#;
        assert_eq!(interpret_event(delta, 200, None).unwrap(), Step::Delta("Hi".into()));
        assert_eq!(interpret_event(r#"{"type":"response.completed"}"#, 200, None).unwrap(), Step::Completed);
        assert_eq!(interpret_event(r#"{"type":"response.created"}"#, 200, None).unwrap(), Step::Ignore);
        assert_eq!(interpret_event("[DONE]", 200, None).unwrap(), Step::Completed);
        assert_eq!(interpret_event("{}", 200, None).unwrap(), Step::Ignore);
    }

    #[test]
    fn failed_and_incomplete_events_error_without_echoing_text() {
        let failed = r#"{"type":"response.failed","response":{"error":{"code":"model_not_found","message":"user text here"}}}"#;
        let err = interpret_event(failed, 200, Some("req_1")).unwrap_err();
        assert_eq!(err.code, "model_not_found");
        assert!(!err.message.contains("user text"));
        let err = interpret_event(r#"{"type":"error","error":{"code":"subscription_sharing_usage_limit_exceeded"}}"#, 200, None).unwrap_err();
        assert_eq!(err.code, "subscription_sharing_usage_limit_exceeded");
        assert_eq!(interpret_event(r#"{"type":"response.incomplete"}"#, 200, None).unwrap_err().code, "response_incomplete");
        assert_eq!(interpret_event("not json", 200, None).unwrap_err().code, "invalid_stream");
    }

    #[test]
    fn input_validation() {
        let msg = |role: &str| InputMessage { role: role.into(), content: "x".into() };
        assert!(validate_input(&[msg("user"), msg("assistant"), msg("developer")]).is_ok());
        assert!(validate_input(&[]).is_err());
        assert!(validate_input(&[msg("system")]).is_err());
    }

    #[test]
    fn model_catalog_keeps_only_listed_models() {
        let body = json!({"models": [
            {"slug": "a", "display_name": "Model A", "visibility": "list"},
            {"slug": "hidden", "display_name": "H", "visibility": "hide"},
            {"slug": "", "display_name": "Empty", "visibility": "list"},
            {"slug": "b", "visibility": "list"},
            "garbage"
        ]});
        assert_eq!(
            parse_models(&body),
            vec![
                ModelInfo { slug: "a".into(), display_name: "Model A".into() },
                ModelInfo { slug: "b".into(), display_name: "b".into() },
            ]
        );
    }
}
