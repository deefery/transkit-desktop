//! Streaming HTTP for the front end (roadmap S1).
//!
//! Tauri's `http` API returns a response only once it is complete, so providers that stream (SSE
//! chat completions, Ollama) used the WebView's own `fetch`. This command makes the request here
//! instead: it resolves with the status and headers, then sends the body to the calling window as
//! events named `http_stream://<id>` (`chunk` with base64 data, then `end` or `error`).
//! `http_stream_cancel` stops a request at any point. Proxy settings apply through the same
//! environment variables `set_proxy` sets for every other request.

use base64::Engine;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::Window;

/// Longest wait for the next piece of the response (headers or body) before giving up.
const DEFAULT_READ_TIMEOUT_MS: u64 = 120_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

static STREAMS: Lazy<Mutex<HashMap<String, JoinHandle<()>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRequest {
    #[serde(default = "default_method")]
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    body: Option<String>,
    timeout_ms: Option<u64>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamHead {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum StreamEvent {
    Chunk { data: String },
    End,
    Error { message: String },
}

/// Ids name an event, so keep them to plain characters.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Only http(s) URLs; returns the parsed URL.
pub fn check_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!("Unsupported URL scheme: {other}")),
    }
}

fn finish(id: &str) {
    STREAMS.lock().unwrap().remove(id);
}

#[tauri::command]
pub async fn http_stream(window: Window, id: String, request: StreamRequest) -> Result<StreamHead, String> {
    if !valid_id(&id) {
        return Err("Invalid stream id".into());
    }
    let url = check_url(&request.url)?;
    let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| format!("Invalid method: {}", request.method))?;
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_READ_TIMEOUT_MS)))
        .build()
        .map_err(|e| e.to_string())?;
    let mut builder = client.request(method, url);
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    // Hands the status and headers (or the send error) back to this command; capacity 1, sent once.
    let (head_tx, mut head_rx) = tauri::async_runtime::channel::<Result<StreamHead, String>>(1);
    let event = format!("http_stream://{id}");
    let task_id = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut response = match builder.send().await {
            Ok(response) => response,
            Err(e) => {
                let _ = head_tx.send(Err(e.to_string())).await;
                finish(&task_id);
                return;
            }
        };
        let head = StreamHead {
            status: response.status().as_u16(),
            status_text: response.status().canonical_reason().unwrap_or("").to_string(),
            headers: response
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
                .collect(),
        };
        if head_tx.send(Ok(head)).await.is_err() {
            finish(&task_id);
            return;
        }
        loop {
            match response.chunk().await {
                Ok(Some(bytes)) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    if window.emit(&event, StreamEvent::Chunk { data }).is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = window.emit(&event, StreamEvent::End);
                    break;
                }
                Err(e) => {
                    let _ = window.emit(&event, StreamEvent::Error { message: e.to_string() });
                    break;
                }
            }
        }
        finish(&task_id);
    });
    if let Some(previous) = STREAMS.lock().unwrap().insert(id.clone(), handle) {
        previous.abort();
    }
    match head_rx.recv().await {
        Some(result) => result,
        None => Err("Request cancelled".into()),
    }
}

/// Stops a request started by `http_stream`; no-op when it already finished.
#[tauri::command]
pub fn http_stream_cancel(id: String) {
    if let Some(handle) = STREAMS.lock().unwrap().remove(&id) {
        handle.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::{check_url, valid_id};

    #[test]
    fn ids_and_urls_are_checked() {
        assert!(valid_id("a1b2-c3_d4"));
        assert!(!valid_id(""));
        assert!(!valid_id("../x"));
        assert!(!valid_id("a b"));
        assert!(!valid_id(&"x".repeat(65)));
        assert!(check_url("https://api.example.com/v1/chat/completions").is_ok());
        assert!(check_url("http://127.0.0.1:11434/api/chat").is_ok());
        assert!(check_url("file:///C:/Windows/win.ini").is_err());
        assert!(check_url("ftp://example.com/").is_err());
        assert!(check_url("not a url").is_err());
    }
}
