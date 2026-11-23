//! OAuth 2.0 authorization-code + PKCE sign-in against OpenAI's authorization server, using a
//! loopback redirect and dynamic client registration, plus refresh and revocation.
//!
//! This is an independent implementation of the public protocol described in OpenAI's
//! "Sign in with ChatGPT" documentation. No code from the (non-commercially licensed) DevKit is
//! copied here, which keeps this GPL-3.0 project free of that license's restrictions.
//!
//! ID token handling: the ID token arrives straight from the token endpoint over TLS, so (per OIDC
//! Core 3.1.3.7) we validate its claims (issuer, audience, expiry, nonce, subject) but do not
//! re-verify the signature against the JWKS.

use super::errors::{api_error, ChatGptError};
use super::store::{Connection, ConnectionStatus, Tokens};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use once_cell::sync::Lazy;
use rand::{rngs::OsRng, RngCore};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

pub const ISSUER: &str = "https://auth.openai.com";
pub const RESOURCE: &str = "https://api.openai.com/v1";
pub const SCOPES: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
pub const SHARING_SCOPE: &str = "chatgpt.tokens.use.direct";
pub const CALLBACK_PATH: &str = "/auth/callback";
/// Fixed so the dynamically registered redirect URI stays valid between sign-ins.
/// Deliberately not 8787: that is the port the OpenAI DevKit example uses, and other local tools
/// (e.g. a browser extension that rewrites `127.0.0.1:8787/auth/callback`) may already claim it.
pub const REDIRECT_PORT: u16 = 18787;
pub const APP_NAME: &str = "TransKit";
const MAX_APP_NAME_LEN: usize = 64;

/// The name this machine's registration shows up under in ChatGPT's connection management:
/// `TransKit (<machine name>)`, so several computers can be told apart. Only the first sign-in on a
/// machine registers a name; later sign-ins reuse the saved registration.
pub fn registration_name() -> String {
    let host = ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok());
    format_registration_name(host.as_deref())
}

/// Pure formatting half of [`registration_name`]: keep it short and free of anything odd, since it is
/// shown in a settings list and sent as a query parameter.
pub fn format_registration_name(host: Option<&str>) -> String {
    let clean: String = host
        .unwrap_or("")
        .trim()
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        return APP_NAME.to_string();
    }
    let room = MAX_APP_NAME_LEN - APP_NAME.len() - 3;
    let shown: String = clean.chars().take(room).collect();
    format!("{APP_NAME} ({shown})")
}
const PLACEHOLDER_CLIENT_ID: &str = "dynamic_agent_client";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        // A redirect could forward credentials or request bodies to another origin.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("TransKit-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client")
});

pub fn http() -> &'static reqwest::Client {
    &HTTP
}

#[derive(Clone)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
}

static DISCOVERY: Lazy<tauri::async_runtime::Mutex<Option<Discovery>>> =
    Lazy::new(|| tauri::async_runtime::Mutex::new(None));

fn same_issuer_origin(url: &str) -> bool {
    reqwest::Url::parse(url)
        .map(|u| u.origin().ascii_serialization() == ISSUER)
        .unwrap_or(false)
}

async fn discovery() -> Result<Discovery, ChatGptError> {
    let mut cached = DISCOVERY.lock().await;
    if let Some(found) = cached.as_ref() {
        return Ok(found.clone());
    }
    let failed = || {
        ChatGptError::new(
            "discovery_failed",
            "ChatGPT sign-in configuration could not be verified.",
            true,
        )
    };
    let response = HTTP
        .get(format!("{ISSUER}/.well-known/openid-configuration"))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| ChatGptError::network())?;
    if !response.status().is_success() {
        return Err(failed());
    }
    let data: Value = response.json().await.map_err(|_| failed())?;
    if data.get("issuer").and_then(Value::as_str) != Some(ISSUER) {
        return Err(failed());
    }
    let endpoint = |key: &str| -> Option<String> {
        data.get(key)
            .and_then(Value::as_str)
            .filter(|u| same_issuer_origin(u))
            .map(str::to_string)
    };
    let found = Discovery {
        authorization_endpoint: endpoint("authorization_endpoint").ok_or_else(failed)?,
        token_endpoint: endpoint("token_endpoint").ok_or_else(failed)?,
        revocation_endpoint: endpoint("revocation_endpoint"),
    };
    *cached = Some(found.clone());
    Ok(found)
}

fn random_value() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------
// Authorization URL

pub struct AuthRequest<'a> {
    pub authorization_endpoint: &'a str,
    pub client_id: Option<&'a str>,
    pub redirect_uri: &'a str,
    pub state: &'a str,
    pub nonce: &'a str,
    pub code_challenge: &'a str,
    pub login_hint: Option<&'a str>,
    pub reconsent: bool,
    /// Shown in ChatGPT for a new registration; ignored when `client_id` is already registered.
    pub app_name: &'a str,
}

pub fn build_authorization_url(req: &AuthRequest) -> Result<String, ChatGptError> {
    let mut url = reqwest::Url::parse(req.authorization_endpoint)
        .map_err(|_| ChatGptError::new("discovery_failed", "Invalid sign-in endpoint.", false))?;
    {
        let mut q = url.query_pairs_mut();
        q.clear()
            .append_pair("client_id", req.client_id.unwrap_or(PLACEHOLDER_CLIENT_ID))
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", req.redirect_uri)
            .append_pair("scope", SCOPES)
            .append_pair("resource", RESOURCE)
            .append_pair("state", req.state)
            .append_pair("nonce", req.nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", req.code_challenge);
        if req.client_id.is_none() {
            q.append_pair("agent_name_hint", req.app_name);
        }
        if let Some(hint) = req.login_hint {
            q.append_pair("login_hint", hint);
        }
        if req.reconsent {
            q.append_pair("prompt", "consent");
        }
    }
    Ok(url.into())
}

// ---------------------------------------------------------------------------------------------
// Loopback callback

#[derive(Debug, PartialEq, Eq)]
pub struct CallbackResult {
    pub code: String,
    pub client_id: String,
}

fn client_id_is_valid(id: &str) -> bool {
    (1..=200).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && id != PLACEHOLDER_CLIENT_ID
}

/// Outcome of examining one request on the loopback listener.
#[derive(Debug, PartialEq, Eq)]
pub enum CallbackVerdict {
    /// Not our callback (wrong method/host/path): answer 404 and keep waiting.
    Ignore,
    /// Our path but the wrong `state`: answer 400 and keep waiting, so an unrelated local request
    /// cannot consume the pending sign-in.
    BadState,
    Done(Result<CallbackResult, ChatGptError>),
}

/// Pure decision function for a callback request, kept free of I/O for testing.
pub fn judge_callback(
    method_is_get: bool,
    host_header: Option<&str>,
    request_url: &str,
    port: u16,
    expected_state: &str,
    saved_client_id: Option<&str>,
) -> CallbackVerdict {
    let origin = format!("http://127.0.0.1:{port}");
    let Ok(url) = reqwest::Url::parse(&format!("{origin}{request_url}")) else {
        return CallbackVerdict::Ignore;
    };
    if !method_is_get
        || host_header != Some(&format!("127.0.0.1:{port}"))
        || url.origin().ascii_serialization() != origin
        || url.path() != CALLBACK_PATH
    {
        return CallbackVerdict::Ignore;
    }
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let all = |key: &str| -> Vec<&str> {
        pairs
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .collect()
    };
    let states = all("state");
    if states.len() != 1 || !constant_time_eq(states[0].as_bytes(), expected_state.as_bytes()) {
        return CallbackVerdict::BadState;
    }
    if let Some(error) = all("error").first() {
        return CallbackVerdict::Done(Err(api_error(
            &serde_json::json!({ "error": error }),
            None,
            None,
        )));
    }
    let codes = all("code");
    let returned_ids = all("client_id");
    let incomplete = || {
        CallbackVerdict::Done(Err(ChatGptError::new(
            "registration_incomplete",
            "ChatGPT did not complete app registration. Please try signing in again.",
            false,
        )))
    };
    if codes.len() != 1 || returned_ids.len() > 1 {
        return incomplete();
    }
    let returned = returned_ids.first().copied();
    let Some(client_id) = returned.or(saved_client_id) else {
        return incomplete();
    };
    if !client_id_is_valid(client_id) || matches!((saved_client_id, returned), (Some(s), Some(r)) if s != r)
    {
        return incomplete();
    }
    CallbackVerdict::Done(Ok(CallbackResult {
        code: codes[0].to_string(),
        client_id: client_id.to_string(),
    }))
}

const CALLBACK_SCRIPT: &str = "history.replaceState(null, \"\", \"/auth/complete\");";

fn callback_page() -> (String, String) {
    let hash = STANDARD.encode(Sha256::digest(CALLBACK_SCRIPT.as_bytes()));
    let csp = format!(
        "default-src 'none'; script-src 'sha256-{hash}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
    );
    let html = format!(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>TransKit</title>\
         <style>body{{font:17px system-ui;max-width:32rem;margin:18vh auto;padding:24px;color:#202123}}h1{{font-size:26px}}</style>\
         <h1>Return to TransKit</h1><p>TransKit is finishing the ChatGPT connection. You can close this tab.</p>\
         <script>{CALLBACK_SCRIPT}</script></html>"
    );
    (html, csp)
}

/// Bind the loopback listener. Non-blocking so the wait loop can poll for cancellation and timeout.
///
/// This is deliberately a tiny listener of our own rather than `tiny_http`: that crate's accept
/// thread `unwrap()`s while setting up each connection, so a single connection that is reset right
/// after it is accepted (browser pre-connects, proxies, antivirus probes) panics the thread and
/// silently closes the port, leaving the browser with "can't open this page" and no log entry.
pub fn bind_listener(port: u16) -> std::io::Result<TcpListener> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

#[derive(Debug, PartialEq, Eq)]
struct RequestHead {
    method_is_get: bool,
    target: String,
    host: Option<String>,
}

fn parse_request_head(buf: &[u8]) -> Option<RequestHead> {
    let text = std::str::from_utf8(buf).ok()?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target, version) = (first.next()?, first.next()?, first.next()?);
    if !version.starts_with("HTTP/1.") || first.next().is_some() || target.is_empty() {
        return None;
    }
    let host = lines.take_while(|l| !l.is_empty()).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim().eq_ignore_ascii_case("host").then(|| value.trim().to_string())
    });
    Some(RequestHead { method_is_get: method == "GET", target: target.to_string(), host })
}

/// Read up to the end of the request headers. `None` for anything that is not a complete, small
/// HTTP/1.x request (idle pre-connections, probes, garbage): those are dropped without a reply.
fn read_request_head(stream: &mut TcpStream) -> Option<RequestHead> {
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        if buf.len() > 8192 {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    parse_request_head(&buf)
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str, csp: Option<&str>) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
         Content-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(csp) = csp {
        head.push_str(&format!("Content-Security-Policy: {csp}\r\n"));
    }
    head.push_str("\r\n");
    let sent = stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body.as_bytes()))
        .and_then(|_| stream.flush());
    if let Err(e) = sent {
        log::warn!("[chatgpt] could not answer a loopback request: {e}");
    }
    let _ = stream.shutdown(Shutdown::Write);
}

type CallbackOutcome = Result<CallbackResult, ChatGptError>;

fn serve_connection(
    mut stream: TcpStream,
    port: u16,
    state: &str,
    saved_client_id: Option<&str>,
    outcome: &mpsc::Sender<CallbackOutcome>,
) {
    let _ = stream.set_nonblocking(false);
    let Some(head) = read_request_head(&mut stream) else {
        log::debug!("[chatgpt] loopback connection closed without a complete request");
        return;
    };
    let verdict = judge_callback(
        head.method_is_get,
        head.host.as_deref(),
        &head.target,
        port,
        state,
        saved_client_id,
    );
    // Only the path is logged, never the query (it carries the one-time code).
    let path_only = head.target.split('?').next().unwrap_or("");
    match verdict {
        CallbackVerdict::Ignore => {
            log::info!("[chatgpt] loopback request {path_only} ignored (host {:?})", head.host);
            write_response(&mut stream, 404, "Not found", None);
        }
        CallbackVerdict::BadState => {
            log::info!("[chatgpt] loopback request {path_only} rejected: state mismatch");
            write_response(
                &mut stream,
                400,
                "Invalid sign-in state. Return to the browser tab that started sign-in.",
                None,
            );
        }
        CallbackVerdict::Done(result) => {
            match &result {
                Ok(_) => log::info!("[chatgpt] loopback callback received"),
                Err(e) => log::warn!("[chatgpt] loopback callback carried error {}", e.code),
            }
            let (html, csp) = callback_page();
            write_response(&mut stream, 200, &html, Some(&csp));
            let _ = outcome.send(result);
        }
    }
}

const MAX_OPEN_CONNECTIONS: usize = 32;

/// Blocks (call from `spawn_blocking`) until the browser returns to the loopback listener. Every
/// connection is served on its own thread, so an idle pre-connection cannot delay the real callback,
/// and no single connection can stop the listener.
fn wait_for_callback(
    listener: TcpListener,
    port: u16,
    state: String,
    saved_client_id: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<CallbackResult, ChatGptError> {
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    let (tx, rx) = mpsc::channel::<CallbackOutcome>();
    let state: Arc<str> = state.into();
    let saved_client_id: Option<Arc<str>> = saved_client_id.map(Into::into);
    let open = Arc::new(AtomicUsize::new(0));
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(ChatGptError::new("cancelled", "Sign-in was cancelled.", false));
        }
        if Instant::now() >= deadline {
            return Err(ChatGptError::new(
                "sign_in_timeout",
                "Sign-in timed out. Try again.",
                true,
            ));
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if open.fetch_add(1, Ordering::SeqCst) >= MAX_OPEN_CONNECTIONS {
                    open.fetch_sub(1, Ordering::SeqCst);
                    continue; // drop the connection
                }
                let (tx, state, saved, open) =
                    (tx.clone(), state.clone(), saved_client_id.clone(), open.clone());
                std::thread::spawn(move || {
                    serve_connection(stream, port, &state, saved.as_deref(), &tx);
                    open.fetch_sub(1, Ordering::SeqCst);
                });
                continue; // there may be more connections waiting
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            // A failed accept (e.g. a connection reset before it was accepted) must never end sign-in.
            Err(e) => log::debug!("[chatgpt] loopback accept error ignored: {e}"),
        }
        // Doubles as the polling sleep between accept attempts.
        if let Ok(result) = rx.recv_timeout(Duration::from_millis(50)) {
            return result;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Token endpoint

async fn token_request(form: &[(&str, &str)]) -> Result<Value, ChatGptError> {
    let disc = discovery().await?;
    let response = HTTP
        .post(&disc.token_endpoint)
        .header("Accept", "application/json")
        .form(form)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| ChatGptError::network())?;
    let status = response.status();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(api_error(&body, Some(status.as_u16()), request_id.as_deref()));
    }
    if !body.is_object() {
        return Err(ChatGptError::new(
            "invalid_token_response",
            "ChatGPT returned an invalid token response. Please sign in again.",
            false,
        ));
    }
    Ok(body)
}

fn invalid_response(message: &str) -> ChatGptError {
    ChatGptError::new("invalid_token_response", message, false)
}

/// Extract granted scopes and credentials from a token response.
pub fn parse_token_response(
    data: &Value,
    previous_scopes: &[String],
    require_refresh: bool,
    now_ms: i64,
) -> Result<(Vec<String>, Tokens), ChatGptError> {
    let scopes: Vec<String> = match data.get("scope").and_then(Value::as_str) {
        Some(scope) => scope.split_whitespace().map(str::to_string).collect(),
        // A refresh may omit `scope` when the grant is unchanged.
        None if !previous_scopes.is_empty() => previous_scopes.to_vec(),
        None => {
            return Err(invalid_response(
                "ChatGPT did not confirm the granted permissions. Please sign in again.",
            ))
        }
    };
    let incomplete = || invalid_response("ChatGPT returned incomplete credentials. Please sign in again.");
    let access_token = data
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(incomplete)?;
    let bearer = data
        .get("token_type")
        .and_then(Value::as_str)
        .is_some_and(|t| t.eq_ignore_ascii_case("bearer"));
    let expires_in = data
        .get("expires_in")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .ok_or_else(incomplete)?;
    let refresh_token = data
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    let wants_refresh = require_refresh || scopes.iter().any(|s| s == "offline_access");
    if !bearer || (wants_refresh && refresh_token.is_none()) {
        return Err(incomplete());
    }
    Ok((
        scopes,
        Tokens {
            access_token: access_token.to_string(),
            refresh_token,
            expires_at_ms: now_ms + (expires_in * 1000.0) as i64,
        },
    ))
}

// ---------------------------------------------------------------------------------------------
// ID token claims

#[derive(Debug, PartialEq, Eq)]
pub struct Identity {
    pub subject: String,
    pub email: Option<String>,
    pub name: Option<String>,
}

fn identity_error() -> ChatGptError {
    ChatGptError::new(
        "invalid_id_token",
        "The ChatGPT identity could not be verified. Please sign in again.",
        false,
    )
}

/// Validate the claims of an ID token received directly from the token endpoint.
pub fn verify_id_token(
    id_token: &str,
    client_id: &str,
    expected_nonce: Option<&str>,
    now_secs: i64,
) -> Result<Identity, ChatGptError> {
    let payload = id_token.split('.').nth(1).ok_or_else(identity_error)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| identity_error())?;
    let claims: Value = serde_json::from_slice(&bytes).map_err(|_| identity_error())?;
    let text = |key: &str| claims.get(key).and_then(Value::as_str);

    let audiences: Vec<&str> = match claims.get("aud") {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    let subject = text("sub").filter(|s| !s.is_empty()).ok_or_else(identity_error)?;
    let exp = claims.get("exp").and_then(Value::as_i64).ok_or_else(identity_error)?;
    let azp_ok = match text("azp") {
        Some(azp) => azp == client_id,
        None => audiences.len() <= 1,
    };
    if text("iss") != Some(ISSUER)
        || !audiences.contains(&client_id)
        || exp + 5 < now_secs
        || !azp_ok
        || expected_nonce.is_some_and(|n| text("nonce") != Some(n))
    {
        return Err(identity_error());
    }
    Ok(Identity {
        subject: subject.to_string(),
        email: text("email").map(str::to_string),
        name: text("name").map(str::to_string),
    })
}

// ---------------------------------------------------------------------------------------------
// Public operations

/// Interactive sign-in. `open_url` launches the system browser; `on_registration` is invoked with
/// the issued client id *before* the one-time code is exchanged so a failure after that point does
/// not leak a fresh registration on every retry.
pub async fn sign_in(
    previous: Option<&Connection>,
    reconsent: bool,
    cancel: Arc<AtomicBool>,
    open_url: impl FnOnce(&str) -> Result<(), String>,
    on_registration: impl Fn(&str) -> Result<(), ChatGptError>,
) -> Result<Connection, ChatGptError> {
    let disc = discovery().await?;
    let state = random_value();
    let nonce = random_value();
    let verifier = random_value();
    let saved_client_id = previous.map(|c| c.client_id.clone());

    // Retry briefly: a sign-in we just cancelled may still be releasing the port.
    let server = tauri::async_runtime::spawn_blocking(|| {
        let mut last = None;
        for _ in 0..10 {
            match bind_listener(REDIRECT_PORT) {
                Ok(listener) => return Ok(listener),
                Err(e) => {
                    last = Some(e.to_string());
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        }
        Err(last.unwrap_or_default())
    })
    .await
    .map_err(|_| ChatGptError::new("callback_failed", "Sign-in stopped unexpectedly.", true))?
    .map_err(|detail| {
        log::warn!("[chatgpt] could not listen on 127.0.0.1:{REDIRECT_PORT}: {detail}");
        ChatGptError::new(
            "callback_port_unavailable",
            &format!(
                "Port {REDIRECT_PORT} is in use. Close the program using it (or another copy of TransKit) and try again."
            ),
            true,
        )
    })?;
    log::info!("[chatgpt] sign-in listener bound on 127.0.0.1:{REDIRECT_PORT} (registered client: {})", saved_client_id.is_some());
    let redirect_uri = format!("http://127.0.0.1:{REDIRECT_PORT}{CALLBACK_PATH}");
    let url = build_authorization_url(&AuthRequest {
        authorization_endpoint: &disc.authorization_endpoint,
        client_id: saved_client_id.as_deref(),
        redirect_uri: &redirect_uri,
        state: &state,
        nonce: &nonce,
        code_challenge: &pkce_challenge(&verifier),
        login_hint: previous.and_then(|c| c.email.as_deref()),
        reconsent,
        app_name: &registration_name(),
    })?;
    open_url(&url).map_err(|_| {
        ChatGptError::new(
            "browser_unavailable",
            "The browser could not be opened. Check your default browser and try again.",
            false,
        )
    })?;

    log::info!("[chatgpt] browser opened, waiting for the callback");
    let callback = tauri::async_runtime::spawn_blocking({
        let state = state.clone();
        let cancel = cancel.clone();
        move || wait_for_callback(server, REDIRECT_PORT, state, saved_client_id, cancel)
    })
    .await
    .map_err(|e| {
        log::warn!("[chatgpt] listener task failed: {e}");
        ChatGptError::new("callback_failed", "Sign-in stopped unexpectedly.", true)
    })?
    .map_err(|e| {
        log::warn!("[chatgpt] waiting for the callback ended with {}", e.code);
        e
    })?;

    on_registration(&callback.client_id)?;
    log::info!("[chatgpt] exchanging the authorization code");
    let data = token_request(&[
        ("grant_type", "authorization_code"),
        ("client_id", &callback.client_id),
        ("code", &callback.code),
        ("code_verifier", &verifier),
        ("redirect_uri", &redirect_uri),
        ("resource", RESOURCE),
    ])
    .await
    .map_err(|e| {
        log::warn!("[chatgpt] code exchange failed: {} (status {:?})", e.code, e.status);
        e
    })?;
    log::info!("[chatgpt] code exchange succeeded");
    let id_token = data
        .get("id_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ChatGptError::new(
                "invalid_id_token",
                "ChatGPT did not return a verifiable identity. Please try signing in again.",
                false,
            )
        })?;
    let now = now_ms();
    let identity = verify_id_token(id_token, &callback.client_id, Some(&nonce), now / 1000)?;
    if let Some(prev_subject) = previous.and_then(|c| c.subject.as_deref()) {
        if prev_subject != identity.subject {
            return Err(ChatGptError::new(
                "account_mismatch",
                "This sign-in returned a different ChatGPT account. Sign out first to switch accounts.",
                false,
            ));
        }
    }
    let (scopes, tokens) = parse_token_response(&data, &[], false, now)?;
    Ok(Connection {
        version: 1,
        client_id: callback.client_id,
        status: ConnectionStatus::Connected,
        scopes,
        subject: Some(identity.subject),
        email: identity.email,
        name: identity.name,
        tokens: Some(tokens),
    })
}

/// Exchange the refresh token for new credentials. The caller must persist the result before using
/// it: the old refresh token is consumed by this call.
pub async fn refresh(previous: &Connection) -> Result<Connection, ChatGptError> {
    let refresh_token = previous
        .tokens
        .as_ref()
        .and_then(|t| t.refresh_token.as_deref())
        .ok_or_else(ChatGptError::reauth_required)?;
    let data = token_request(&[
        ("grant_type", "refresh_token"),
        ("client_id", &previous.client_id),
        ("refresh_token", refresh_token),
        ("resource", RESOURCE),
    ])
    .await?;
    let now = now_ms();
    let (scopes, mut tokens) = parse_token_response(&data, &previous.scopes, true, now)?;
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token.to_string());
    }
    let mut next = previous.clone();
    if let Some(id_token) = data.get("id_token").and_then(Value::as_str) {
        let identity = verify_id_token(id_token, &previous.client_id, None, now / 1000)?;
        if previous.subject.as_deref().is_some_and(|s| s != identity.subject) {
            return Err(ChatGptError::new(
                "account_mismatch",
                "The refreshed ChatGPT identity does not match this connection. Sign in again.",
                false,
            ));
        }
        next.subject = Some(identity.subject);
        next.email = identity.email.or(next.email);
        next.name = identity.name.or(next.name);
    }
    next.scopes = scopes;
    next.tokens = Some(tokens);
    next.status = ConnectionStatus::Connected;
    Ok(next)
}

/// Revoke the refresh token (and with it the session). Failure is reported, not fatal: the caller
/// has already removed the local credentials.
pub async fn revoke(connection: &Connection) -> Result<(), ChatGptError> {
    let failed = || {
        ChatGptError::new(
            "revocation_failed",
            "Local credentials were removed, but ChatGPT could not confirm the disconnection. You can also remove TransKit in ChatGPT settings.",
            true,
        )
    };
    let Some(token) = connection
        .tokens
        .as_ref()
        .and_then(|t| t.refresh_token.as_deref())
    else {
        return Ok(());
    };
    let endpoint = discovery()
        .await
        .map_err(|_| failed())?
        .revocation_endpoint
        .ok_or_else(failed)?;
    let response = HTTP
        .post(endpoint)
        .form(&[
            ("token", token),
            ("token_type_hint", "refresh_token"),
            ("client_id", connection.client_id.as_str()),
        ])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| failed())?;
    if response.status().as_u16() == 200 {
        Ok(())
    } else {
        Err(failed())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const STATE: &str = "state-value";

    fn judge(url: &str) -> CallbackVerdict {
        judge_callback(true, Some("127.0.0.1:8787"), url, 8787, STATE, None)
    }

    #[test]
    fn pkce_matches_rfc7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorization_url_carries_required_parameters() {
        let url = build_authorization_url(&AuthRequest {
            authorization_endpoint: "https://auth.openai.com/oauth/authorize",
            client_id: None,
            redirect_uri: "http://127.0.0.1:8787/auth/callback",
            state: "s",
            nonce: "n",
            code_challenge: "c",
            login_hint: None,
            reconsent: true,
            app_name: "TransKit (PC-1)",
        })
        .unwrap();
        let parsed = reqwest::Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], PLACEHOLDER_CLIENT_ID);
        assert_eq!(q["agent_name_hint"], "TransKit (PC-1)");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["prompt"], "consent");
        assert_eq!(q["scope"], SCOPES);
        assert_eq!(q["resource"], RESOURCE);
        assert!(!url.contains("refresh"), "no tokens in the URL");
    }

    #[test]
    fn registered_client_skips_registration_hint() {
        let url = build_authorization_url(&AuthRequest {
            authorization_endpoint: "https://auth.openai.com/oauth/authorize",
            client_id: Some("client_abc"),
            redirect_uri: "http://127.0.0.1:8787/auth/callback",
            state: "s",
            nonce: "n",
            code_challenge: "c",
            login_hint: Some("a@b.c"),
            reconsent: false,
            app_name: "TransKit (PC-1)",
        })
        .unwrap();
        assert!(url.contains("client_id=client_abc"));
        assert!(!url.contains("agent_name_hint"));
        assert!(url.contains("login_hint=a%40b.c"));
        assert!(!url.contains("prompt="));
    }

    #[test]
    fn callback_accepts_valid_request() {
        let verdict = judge("/auth/callback?code=abc&state=state-value&client_id=client_1");
        assert_eq!(
            verdict,
            CallbackVerdict::Done(Ok(CallbackResult { code: "abc".into(), client_id: "client_1".into() }))
        );
    }

    #[test]
    fn callback_rejects_wrong_state_without_consuming() {
        assert_eq!(judge("/auth/callback?code=abc&state=nope&client_id=client_1"), CallbackVerdict::BadState);
        assert_eq!(judge("/auth/callback?code=abc&client_id=client_1"), CallbackVerdict::BadState);
        assert_eq!(
            judge("/auth/callback?code=abc&state=state-value&state=state-value&client_id=c"),
            CallbackVerdict::BadState
        );
    }

    #[test]
    fn callback_ignores_foreign_requests() {
        assert_eq!(judge("/other?state=state-value"), CallbackVerdict::Ignore);
        assert_eq!(
            judge_callback(true, Some("evil.example:8787"), "/auth/callback?state=state-value", 8787, STATE, None),
            CallbackVerdict::Ignore
        );
        assert_eq!(
            judge_callback(false, Some("127.0.0.1:8787"), "/auth/callback?state=state-value", 8787, STATE, None),
            CallbackVerdict::Ignore
        );
    }

    #[test]
    fn callback_surfaces_provider_error_and_bad_registration() {
        match judge("/auth/callback?error=access_denied&state=state-value") {
            CallbackVerdict::Done(Err(e)) => assert_eq!(e.code, "access_denied"),
            other => panic!("unexpected {other:?}"),
        }
        for url in [
            "/auth/callback?code=abc&state=state-value",
            "/auth/callback?code=abc&state=state-value&client_id=dynamic_agent_client",
            "/auth/callback?code=abc&state=state-value&client_id=has%20space",
        ] {
            match judge(url) {
                CallbackVerdict::Done(Err(e)) => assert_eq!(e.code, "registration_incomplete", "{url}"),
                other => panic!("unexpected {other:?} for {url}"),
            }
        }
    }

    #[test]
    fn saved_client_id_must_match_returned_one() {
        let url = "/auth/callback?code=abc&state=state-value&client_id=other";
        match judge_callback(true, Some("127.0.0.1:8787"), url, 8787, STATE, Some("saved")) {
            CallbackVerdict::Done(Err(e)) => assert_eq!(e.code, "registration_incomplete"),
            other => panic!("unexpected {other:?}"),
        }
        let ok = judge_callback(true, Some("127.0.0.1:8787"), "/auth/callback?code=abc&state=state-value", 8787, STATE, Some("saved"));
        assert_eq!(ok, CallbackVerdict::Done(Ok(CallbackResult { code: "abc".into(), client_id: "saved".into() })));
    }

    fn token_json() -> Value {
        json!({
            "access_token": "at", "refresh_token": "rt", "token_type": "Bearer",
            "expires_in": 3600, "scope": "openid offline_access chatgpt.tokens.use.direct"
        })
    }

    #[test]
    fn token_response_parsing() {
        let (scopes, tokens) = parse_token_response(&token_json(), &[], false, 1_000).unwrap();
        assert!(scopes.iter().any(|s| s == SHARING_SCOPE));
        assert_eq!(tokens.expires_at_ms, 1_000 + 3_600_000);
        assert_eq!(tokens.refresh_token.as_deref(), Some("rt"));

        let mut no_refresh = token_json();
        no_refresh.as_object_mut().unwrap().remove("refresh_token");
        assert!(parse_token_response(&no_refresh, &[], false, 0).is_err(), "offline_access requires a refresh token");

        let mut no_scope = token_json();
        no_scope.as_object_mut().unwrap().remove("scope");
        assert!(parse_token_response(&no_scope, &[], false, 0).is_err());
        let prev = vec!["openid".to_string()];
        assert_eq!(parse_token_response(&no_scope, &prev, true, 0).unwrap().0, prev);

        let mut bad_type = token_json();
        bad_type["token_type"] = json!("mac");
        assert!(parse_token_response(&bad_type, &[], false, 0).is_err());
        let mut bad_exp = token_json();
        bad_exp["expires_in"] = json!(-1);
        assert!(parse_token_response(&bad_exp, &[], false, 0).is_err());
    }

    fn id_token(claims: Value) -> String {
        let enc = |v: &Value| URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap());
        format!("{}.{}.sig", enc(&json!({"alg": "RS256"})), enc(&claims))
    }

    #[test]
    fn id_token_claims_are_validated() {
        let good = json!({"iss": ISSUER, "aud": "client_1", "sub": "user_1", "exp": 2_000, "nonce": "n1", "email": "a@b.c"});
        let ok = verify_id_token(&id_token(good.clone()), "client_1", Some("n1"), 1_000).unwrap();
        assert_eq!(ok.subject, "user_1");
        assert_eq!(ok.email.as_deref(), Some("a@b.c"));

        let tweak = |key: &str, value: Value| {
            let mut c = good.clone();
            c[key] = value;
            verify_id_token(&id_token(c), "client_1", Some("n1"), 1_000)
        };
        assert!(tweak("iss", json!("https://evil.example")).is_err());
        assert!(tweak("aud", json!("someone_else")).is_err());
        assert!(tweak("exp", json!(500)).is_err());
        assert!(tweak("nonce", json!("other")).is_err());
        assert!(tweak("sub", json!("")).is_err());
        assert!(tweak("aud", json!(["client_1", "other"])).is_err(), "multi-audience needs a matching azp");
        assert!(tweak("azp", json!("not_us")).is_err());
        assert!(verify_id_token("not-a-jwt", "client_1", None, 0).is_err());
        // Refresh path: no nonce expectation.
        assert!(verify_id_token(&id_token(good), "client_1", None, 1_000).is_ok());
    }

    fn http_get(port: u16, request_target: &str, host: &str) -> String {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let request = format!("GET {request_target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = stream.read_to_string(&mut out);
        out
    }

    #[test]
    fn loopback_listener_round_trip() {
        let server = bind_listener(0).unwrap();
        let port = server.local_addr().unwrap().port();
        let cancel = Arc::new(AtomicBool::new(false));
        let handle = std::thread::spawn(move || wait_for_callback(server, port, STATE.to_string(), None, cancel));
        let host = format!("127.0.0.1:{port}");

        // Unrelated requests must neither succeed nor consume the pending sign-in.
        assert!(http_get(port, "/favicon.ico", &host).starts_with("HTTP/1.1 404"));
        assert!(http_get(port, "/auth/callback?code=x&state=wrong", &host).starts_with("HTTP/1.1 400"));

        let page = http_get(port, "/auth/callback?code=abc&state=state-value&client_id=client_1", &host);
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(page.contains("Return to TransKit"));
        assert_eq!(handle.join().unwrap().unwrap(), CallbackResult { code: "abc".into(), client_id: "client_1".into() });
    }

    #[test]
    fn loopback_listener_can_be_cancelled() {
        let server = bind_listener(0).unwrap();
        let port = server.local_addr().unwrap().port();
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let handle = std::thread::spawn(move || wait_for_callback(server, port, STATE.to_string(), None, flag));
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(handle.join().unwrap().unwrap_err().code, "cancelled");
    }

    // Regression: with tiny_http, one connection that was reset right after being accepted panicked
    // its accept thread and silently closed the port, so the browser's real callback was refused.
    #[test]
    fn listener_survives_bad_and_idle_connections() {
        use std::io::Write;
        let server = bind_listener(0).unwrap();
        let port = server.local_addr().unwrap().port();
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let handle = std::thread::spawn(move || wait_for_callback(server, port, STATE.to_string(), None, flag));
        let host = format!("127.0.0.1:{port}");

        // Connect-and-drop probes, garbage, a truncated request and an idle pre-connection.
        for _ in 0..20 {
            drop(std::net::TcpStream::connect(("127.0.0.1", port)).unwrap());
        }
        let mut garbage = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        garbage.write_all(b"\x16\x03\x01 not http at all\r\n\r\n").unwrap();
        drop(garbage);
        let mut truncated = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        truncated.write_all(b"GET /auth/callback?code=abc&sta").unwrap();
        drop(truncated);
        let idle = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap(); // kept open

        std::thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        let page = http_get(port, "/auth/callback?code=abc&state=state-value&client_id=client_1", &host);
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(started.elapsed() < Duration::from_secs(2), "an idle connection must not delay the callback");
        assert_eq!(handle.join().unwrap().unwrap(), CallbackResult { code: "abc".into(), client_id: "client_1".into() });
        drop(idle);
    }

    #[test]
    fn request_head_parsing() {
        let ok = parse_request_head(b"GET /auth/callback?x=1 HTTP/1.1\r\nhOsT:  127.0.0.1:1\r\nAccept: */*\r\n\r\n").unwrap();
        assert_eq!(ok, RequestHead { method_is_get: true, target: "/auth/callback?x=1".into(), host: Some("127.0.0.1:1".into()) });
        assert!(!parse_request_head(b"POST / HTTP/1.1\r\n\r\n").unwrap().method_is_get);
        assert_eq!(parse_request_head(b"GET / HTTP/1.0\r\n\r\n").unwrap().host, None);
        assert!(parse_request_head(b"GET / SPDY/3\r\n\r\n").is_none());
        assert!(parse_request_head(b"GET /\r\n\r\n").is_none());
        assert!(parse_request_head(b"\xff\xfe\r\n\r\n").is_none());
    }

    #[test]
    fn registration_name_identifies_the_machine() {
        assert_eq!(format_registration_name(Some("DEE-GB-R")), "TransKit (DEE-GB-R)");
        assert_eq!(format_registration_name(Some("  my-mac.local\n")), "TransKit (my-mac.local)");
        // Nothing usable -> plain app name.
        assert_eq!(format_registration_name(None), "TransKit");
        assert_eq!(format_registration_name(Some("   ")), "TransKit");
        assert_eq!(format_registration_name(Some("<>&%")), "TransKit");
        // Odd characters are dropped, length is bounded.
        assert_eq!(format_registration_name(Some("PC<script>1")), "TransKit (PCscript1)");
        let long = format_registration_name(Some(&"x".repeat(200)));
        assert!(long.chars().count() <= MAX_APP_NAME_LEN, "{long}");
        assert!(long.starts_with("TransKit (x") && long.ends_with(')'));
    }

    #[test]
    fn callback_page_is_script_hash_pinned() {
        let (html, csp) = callback_page();
        assert!(html.contains(CALLBACK_SCRIPT));
        assert!(csp.contains("script-src 'sha256-"));
        assert!(!html.contains("code="));
    }
}
