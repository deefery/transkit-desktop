# ChatGPT subscription ("use my plan") — design note v1

Status: implemented, uncommitted. Not yet exercised against a live ChatGPT account (see "Verification").

## Outcome

A user can sign in with their ChatGPT account and have TransKit spend that plan's usage quota for
translation and AI actions, with no API key. Surfaces:

- translate provider `chatgpt` (`src/services/translate/chatgpt`)
- AI provider `chatgpt_ai` (`src/services/ai/chatgpt_ai`) — same `summarize(text, { config })`
  contract, so selection-actions, polish and suggestion features work unchanged.

## Protocol (OpenAI "Sign in with ChatGPT")

OAuth 2.0 authorization code + PKCE (S256) + OIDC nonce against `https://auth.openai.com`
(endpoints from `/.well-known/openid-configuration`, origin-checked), loopback redirect
`http://127.0.0.1:18787/auth/callback`, **dynamic client registration** (`client_id=dynamic_agent_client`
+ `agent_name_hint=TransKit` on first sign-in; the issued `client_id` comes back on the callback and is
persisted). Scopes: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`;
`resource=https://api.openai.com/v1`. The access token is then used as a bearer on
`POST https://api.openai.com/v1/responses` (`store:false`, `stream:true`) and
`GET https://api.openai.com/v1/models` (entries with `visibility == "list"`). Refresh tokens rotate and
are single-use.

The `chatgpt.tokens.use.direct` scope is the "plan sharing" grant; without it requests fail, so the UI
shows a warning and offers re-consent (`prompt=consent`).

## Boundaries

- All credential handling is in Rust (`src-tauri/src/chatgpt/`). The webview only calls
  `chatgpt_status | sign_in | cancel_sign_in | sign_out | list_models | respond` and never receives a
  token. Streaming deltas reach the window as `chatgpt-delta` events.
- A single async mutex serializes every read-modify-write of the saved connection (refresh rotation).
  The rotated token is persisted before use.
- Credentials live in `chatgpt-connection.bin` beside `config.json`. Backup/restore archives only
  `config.json`, `history.db` and plugins, so credentials are not backed up or synced.
- Windows: DPAPI-encrypted (entropy-bound). **Other platforms: 0600 file, not OS-encrypted** — known gap;
  add Keychain / Secret Service before relying on this off Windows. Damaged or foreign-user files are
  an error (never silently reset); "Sign out" deletes an unreadable file as the recovery path.
- ID token: claims validated (iss, aud/azp, exp, nonce, sub); signature not re-verified because the token
  is received directly from the token endpoint over TLS (OIDC Core 3.1.3.7).
- Loopback listener: binds 127.0.0.1 only, checks Host, path and `state` (constant-time); a request with a
  wrong state does not consume the pending sign-in; 5-minute timeout; cancellable.
- No redirects are followed on any OpenAI request. Error text shown to users is fixed copy keyed by
  error code; server messages (which can echo the prompt) are never displayed.

## Shared settings and the two services

The account is one connection in Rust, shared by both services. Service *instances* stay per type
(translate list / AI list), as everywhere else in the app, but they no longer duplicate the model:

- `chatgpt_settings.model` (store key `chatgpt_settings`) is the default model for both services.
- An instance's own `model` is an optional override; empty means "follow the default". The model is
  resolved at request time (`resolveChatGPTModel`), so changing the default takes effect immediately.
- When adding either service, a switch (default on) also creates the sibling instance in the other
  list, with default settings that follow the shared model. It is only offered when no sibling exists
  (`companionMissing`). Pure logic: `src/utils/chatgpt_shared.js`; store I/O: `src/utils/chatgpt_settings.js`.
- Registration name is `TransKit (<machine name>)` so several machines are distinguishable in ChatGPT's
  connection management. It is only sent on the first registration; sign-out keeps the registration.

## Licensing

OpenAI's DevKit is under a **noncommercial** license; TransKit is GPL-3.0. This is an independent
implementation of the public protocol — no DevKit source or assets are vendored. If reviewing for
distribution beyond personal use, have someone confirm that independent implementation is acceptable
and that OpenAI's terms for Sign in with ChatGPT apply to this use.

## Deviations from upstream

- New Cargo dep `rand` (already in the lockfile transitively); `windows` crate gains
  `Win32_Security_Cryptography`.
- Service allow-lists in `config.rs` gain `chatgpt` / `chatgpt_ai`.
- Redirect port 18787 is fixed so a saved registration's redirect stays valid (8787 deliberately avoided; see the report).

## Verification so far

- `cargo test chatgpt`: 27 unit tests (PKCE vector, auth URL, callback hardening, token/ID-token
  validation, SSE decoding, error mapping, DPAPI round-trip, store failure modes).
- `node --test src/utils/chatgpt.test.js` and the existing selection-actions/utils suites; `vite build`.
- **Not verified:** a real sign-in, `/v1/responses` and `/v1/models` against a live account; UI rendering.

## Open follow-ups

1. Live smoke test with a ChatGPT account (sign in, models list, translate, AI action, refresh after
   expiry, sign out, re-consent).
2. OS-backed storage on macOS/Linux.
3. i18n for the remaining locales (they fall back to English).
4. Optional: per-request cancellation (`summarize()` has no abort signal today).
