//! Built-in Microsoft Edge TTS client — matches the edge-tts Python reference implementation.
//!
//! Key auth requirements (as of edge-tts v1.4+):
//!   - `Sec-MS-GEC` and `Sec-MS-GEC-Version` go in the **URL query string**, not headers.
//!   - `Sec-MS-GEC` is the v2 token "<16 hex CS64>-<64 hex SHA256 variant>" of
//!     "{windows_filetime_rounded_300s}{TRUSTED_CLIENT_TOKEN}" (see `gec_v2`).
//!     The old plain-SHA256 v1 token is now rejected with HTTP 403.
//!   - `Cookie: muid={random_32_hex};` must be present in WS headers.
//!   - Chrome/Edge version in User-Agent must match the GEC version string.
//!
//! Reference: https://github.com/rany2/edge-tts (v7.3.1, drm.py / constants.py)

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::Window;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use uuid::Uuid;

// ── Constants (keep in sync with edge-tts constants.py) ───────────────────

const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const ENDPOINT: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

/// Chromium version used by the current edge-tts release.
/// Must match the major version in USER_AGENT and the SEC_MS_GEC_VERSION string.
const CHROMIUM_FULL_VERSION: &str = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION: &str = "143";

/// "2-{CHROMIUM_FULL_VERSION}" — put in the URL query string, NOT as a header.
/// The "2-" prefix selects the v2 token format produced by `generate_sec_ms_gec`.
const SEC_MS_GEC_VERSION: &str = "2-143.0.3650.75";

const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) \
    Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

// ── Helpers ────────────────────────────────────────────────────────────────

fn unix_timestamp() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn now_ms() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn new_id() -> String {
    Uuid::new_v4().to_string().replace('-', "")
}

/// Generate a random MUID (16 random bytes as uppercase hex).
/// Equivalent to Python's `secrets.token_hex(16).upper()`.
fn generate_muid() -> String {
    let bytes = Uuid::new_v4().as_bytes().to_vec();
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

/// Compute the `Sec-MS-GEC` token for the current time.
fn generate_sec_ms_gec() -> String {
    generate_sec_ms_gec_at(unix_timestamp())
}

/// Mirrors `generate_sec_ms_gec_v2()` in the Python package:
///   1. Add Windows epoch offset (11_644_473_600 seconds → 1601-01-01).
///   2. Round down to the nearest 300-second window.
///   3. Convert to 100-nanosecond Windows FILETIME ticks (* 10_000_000).
///   4. Hash "{ticks:.0}{TRUSTED_CLIENT_TOKEN}" → "{CS64 hex}-{SHA256 variant hex}".
fn generate_sec_ms_gec_at(unix_ts: f64) -> String {
    let mut ticks = unix_ts;
    ticks += 11_644_473_600.0_f64;
    ticks -= ticks % 300.0;
    ticks *= 10_000_000.0_f64;
    // {ticks:.0} = integer representation (matches Python f"{ticks:.0f}")
    let data = format!("{:.0}{}", ticks, TRUSTED_CLIENT_TOKEN);
    gec_v2::token(data.as_bytes())
}

/// Port of the v2 token digests from edge-tts `drm.py`. All arithmetic is mod 2^32,
/// which matches the Python code because every result there is masked to 32 bits.
mod gec_v2 {
    const SHA_INITIAL: [u32; 8] = [
        0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB,
        0x5BE0CD19,
    ];
    const SHA_STATE: [u32; 8] = [
        0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4,
        0x03EFFBD2,
    ];
    const SHA_SCHEDULE: [u32; 14] = [
        0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0,
        0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564,
    ];
    const K: [u32; 64] = [
        0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4,
        0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE,
        0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F,
        0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
        0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC,
        0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B,
        0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070, 0x19A4C116,
        0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
        0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7,
        0xC67178F2,
    ];
    const SHA_ADJUSTMENT: u32 = 0xC9DC06A7;
    const SIGMA0_ADJUSTMENT: u32 = 0x059C0B80;
    const SIGMA1_ADJUSTMENT: u32 = 0x000B92C0;

    const CS64_COEFFICIENTS: [(u32, u32); 14] = [
        (0xE82E91B1, 0xB32700D0),
        (0x44DE24C6, 0x88DFF51D),
        (0x3BEB65BC, 0x29514038),
        (0xC89C5933, 0xB328CBDF),
        (0x8D1EC211, 0xD405B4D5),
        (0x314EF5D5, 0x26E55F3C),
        (0xE92491B1, 0x607801C6),
        (0xF0A5B9D5, 0x82B2C1FB),
        (0x06064CF3, 0xFA51A3DA),
        (0xDA79FA60, 0x207CC464),
        (0xBED20560, 0x3C3C74F3),
        (0x89F9C9F8, 0xD2D14B61),
        (0x35FA38C6, 0xBB04A2C1),
        (0xCB49E3C6, 0xC5626167),
    ];
    const CS64_FACTOR: u32 = 0x82893933;
    const CS64_ADJUSTMENT0: u32 = 0xF2F90B1A;
    const CS64_ADJUSTMENT1: u32 = 0x0B1A0000;

    fn rol16(v: u32) -> u32 {
        v.rotate_left(16)
    }

    fn sigma0(v: u32) -> u32 {
        v.rotate_right(7) ^ v.rotate_right(18) ^ (v >> 3)
    }

    fn sigma1(v: u32) -> u32 {
        v.rotate_right(17) ^ v.rotate_right(19) ^ (v >> 10)
    }

    /// Standard SHA-256 compression rounds, optionally resuming at `first_round`.
    /// Round 14 uses SHA_ADJUSTMENT instead of K[14] when resuming at round 14.
    fn rounds(state: [u32; 8], w: &[u32; 64], first_round: usize) -> [u32; 8] {
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in first_round..64 {
            let k = if first_round == 14 && i == 14 { SHA_ADJUSTMENT } else { K[i] };
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = g ^ (e & (f ^ g));
            let t1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(k).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) | (c & (a | b));
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        [a, b, c, d, e, f, g, h]
    }

    fn expand(w: &mut [u32; 64], first: usize) {
        for i in first..64 {
            w[i] = sigma1(w[i - 2])
                .wrapping_add(w[i - 7])
                .wrapping_add(sigma0(w[i - 15]))
                .wrapping_add(w[i - 16]);
        }
    }

    fn add_state(x: [u32; 8], y: [u32; 8]) -> [u32; 8] {
        let mut out = [0u32; 8];
        for i in 0..8 {
            out[i] = x[i].wrapping_add(y[i]);
        }
        out
    }

    /// Initial state derived from the first seven bytes of the token data.
    fn init(prefix: &[u8]) -> [u32; 8] {
        let mut w = [0u32; 64];
        w[14] = u32::from_be_bytes([0, prefix[0], prefix[1], prefix[2]]);
        w[15] = u32::from_be_bytes([prefix[3], prefix[4], prefix[5], prefix[6]]);
        for i in 16..30 {
            let mut v = SHA_SCHEDULE[i - 16];
            if i - 2 >= 14 {
                let s = sigma1(w[i - 2]);
                v = v.wrapping_add(if i == 16 { s ^ SIGMA1_ADJUSTMENT } else { s });
            }
            if i - 7 >= 14 {
                v = v.wrapping_add(w[i - 7]);
            }
            if i - 15 >= 14 {
                let s = sigma0(w[i - 15]);
                v = v.wrapping_add(if i == 29 { s ^ SIGMA0_ADJUSTMENT } else { s });
            }
            w[i] = v;
        }
        w[30] = sigma1(w[28])
            .wrapping_add(w[23])
            .wrapping_add(sigma0(w[15]))
            .wrapping_add(w[14])
            .wrapping_add(SHA_ADJUSTMENT)
            .wrapping_sub(K[14]);
        expand(&mut w, 31);
        add_state(SHA_INITIAL, rounds(SHA_STATE, &w, 14))
    }

    fn sha256(data: &[u8]) -> [u8; 32] {
        assert!(data.len() >= 7, "token salt must contain at least seven bytes");
        let length = 57 + data.len();
        let mut padded = data[7..].to_vec();
        padded.push(0x80);
        let zeros = (55_i64 - length as i64).rem_euclid(64) as usize;
        padded.extend(std::iter::repeat(0u8).take(zeros));
        padded.extend_from_slice(&((length as u64) * 8).to_be_bytes());

        let mut state = init(&data[..7]);
        for block in padded.chunks(64) {
            let mut w = [0u32; 64];
            for (i, word) in block.chunks(4).enumerate() {
                w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
            }
            expand(&mut w, 16);
            state = add_state(state, rounds(state, &w, 0));
        }
        let mut out = [0u8; 32];
        for (i, v) in state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
        }
        out
    }

    /// Little-endian 32-bit words, zero-padded to an even word count.
    fn words_le4_even(data: &[u8]) -> Vec<u32> {
        let mut padded = data.to_vec();
        while padded.len() % 4 != 0 {
            padded.push(0);
        }
        let mut words: Vec<u32> = padded
            .chunks(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        if words.len() % 2 == 1 {
            words.push(0);
        }
        words
    }

    fn cs64(data: &[u8], digest: &[u8; 32]) -> (u32, u32) {
        let key_a = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) | 1;
        let key_b = u32::from_le_bytes([digest[4], digest[5], digest[6], digest[7]]) | 1;
        let factors = [
            key_a.wrapping_mul(CS64_FACTOR),
            key_b.wrapping_mul(CS64_FACTOR),
        ];
        let mut terms: Vec<u32> = CS64_COEFFICIENTS
            .iter()
            .enumerate()
            .map(|(i, (coef, _))| coef.wrapping_mul(factors[i % 2]))
            .collect();
        let mut offsets: Vec<u32> = CS64_COEFFICIENTS.iter().map(|(_, off)| *off).collect();

        let mut prefixed = Vec::with_capacity(data.len() + 1);
        prefixed.push(0u8);
        prefixed.extend_from_slice(data);
        for (i, word) in words_le4_even(&prefixed).into_iter().enumerate() {
            let even = i % 2 == 0;
            let mut term = word.wrapping_mul(if even { key_a } else { key_b });
            let mut offset = rol16(word).wrapping_mul(if even { 0xEF0569FB } else { 0xC31713DB });
            if i == 0 {
                term = term.wrapping_add(CS64_ADJUSTMENT0.wrapping_mul(factors[0]));
                offset = offset.wrapping_add(CS64_ADJUSTMENT1);
            }
            terms.push(term);
            offsets.push(offset);
        }

        let (mut swap_acc, mut swap_last, mut state, mut acc) = (0u32, 0u32, 0u32, 0u32);
        for i in (0..terms.len()).step_by(2) {
            let (x, y) = (terms[i], terms[i + 1]);
            let t = rol16(offsets[i].wrapping_add(x));
            let q = t.wrapping_mul(0x76F50F34);
            swap_acc = swap_acc.wrapping_add(rol16(q).wrapping_mul(0xC3EFEA97).wrapping_add(q));
            let t = rol16(offsets[i + 1].wrapping_add(y));
            let q = t.wrapping_mul(0x1881CE3C);
            swap_last = rol16(q).wrapping_mul(0x35BD1EC9).wrapping_add(q);
            swap_acc = swap_acc.wrapping_add(swap_last);

            state = state.wrapping_mul(key_a).wrapping_add(x);
            state = rol16(state).wrapping_mul(0xCF98B111);
            state = rol16(state).wrapping_mul(0x87085B9F);
            state = rol16(state).wrapping_mul(0x12CEB96D);
            state = rol16(state).wrapping_mul(0x257E1D83);
            acc = acc.wrapping_add(state);
            let mut t = state.wrapping_mul(key_b).wrapping_add(y);
            t = rol16(t).wrapping_mul(0xA27416F5);
            t = rol16(t).wrapping_mul(0xD38396FF);
            state = rol16(rol16(t).wrapping_mul(0x7C932B89)).wrapping_mul(0xBFA49F69);
            acc = acc.wrapping_add(state);
        }
        (swap_last ^ state, swap_acc ^ acc)
    }

    fn hex_upper(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02X}")).collect()
    }

    pub fn token(data: &[u8]) -> String {
        let digest = sha256(data);
        let (lo, hi) = cs64(data, &digest);
        let mut cs = [0u8; 8];
        cs[..4].copy_from_slice(&lo.to_le_bytes());
        cs[4..].copy_from_slice(&hi.to_le_bytes());
        format!("{}-{}", hex_upper(&cs), hex_upper(&digest))
    }
}

// ── Protocol message builders ──────────────────────────────────────────────

/// X-Timestamp value used in speech.config and SSML frames.
/// Microsoft's service accepts epoch-milliseconds as a plain integer string.
fn timestamp() -> String {
    now_ms().to_string()
}

/// speech.config text frame — sent once right after the WS handshake.
fn speech_config_msg() -> String {
    format!(
        "X-Timestamp:{ts}\r\n\
         Content-Type:application/json; charset=utf-8\r\n\
         Path:speech.config\r\n\r\n\
         {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":\
         {{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"}},\
         \"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}}}}\r\n",
        ts = timestamp()
    )
}

/// SSML text frame — triggers synthesis of `text` with the given voice/prosody.
fn ssml_msg(req_id: &str, voice: &str, rate: &str, pitch: &str, text: &str) -> String {
    // XML-escape user text to prevent malformed SSML.
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");

    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
         <voice name='{voice}'>\
         <prosody pitch='{pitch}' rate='{rate}' volume='+0%'>{escaped}</prosody>\
         </voice></speak>"
    );

    // Note: Python appends "Z" to the timestamp in the SSML frame (ssml_headers_plus_data).
    format!(
        "X-RequestId:{req_id}\r\n\
         Content-Type:application/ssml+xml\r\n\
         X-Timestamp:{ts}Z\r\n\
         Path:ssml\r\n\r\n\
         {ssml}",
        ts = timestamp()
    )
}

// ── Tauri event payloads ───────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct EdgeTtsChunk {
    pub id: String,
    /// Base64-encoded MP3 bytes.
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct EdgeTtsDone {
    pub id: String,
    pub error: Option<String>,
}

// ── Tauri command ──────────────────────────────────────────────────────────

/// Synthesize `text` via Microsoft Edge TTS and stream MP3 chunks to the frontend.
///
/// Emits on `window`:
///   `edge_tts_chunk` { id, data: base64 }  — one per audio chunk received
///   `edge_tts_done`  { id, error? }         — once, when the stream ends
#[tauri::command]
pub async fn synthesize_edge_tts(
    id: String,
    text: String,
    voice: String,
    rate: String,
    pitch: String,
    window: Window,
) -> Result<(), String> {
    let conn_id = new_id();
    let req_id = new_id();
    let sec_ms_gec = generate_sec_ms_gec();
    let muid = generate_muid();

    // Sec-MS-GEC and Sec-MS-GEC-Version go in the URL query string (not headers).
    let url = format!(
        "{ENDPOINT}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}\
         &ConnectionId={conn_id}\
         &Sec-MS-GEC={sec_ms_gec}\
         &Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}"
    );

    let mut request = url
        .into_client_request()
        .map_err(|e| format!("Invalid URL: {e}"))?;

    {
        let h = request.headers_mut();
        h.insert("Origin",          ORIGIN.parse().unwrap());
        h.insert("User-Agent",      USER_AGENT.parse().unwrap());
        h.insert("Pragma",          "no-cache".parse().unwrap());
        h.insert("Cache-Control",   "no-cache".parse().unwrap());
        h.insert("Accept-Encoding", "gzip, deflate, br, zstd".parse().unwrap());
        h.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());
        // MUID cookie is required by Microsoft's auth layer.
        h.insert("Cookie", format!("muid={muid};").parse().unwrap());
    }

    let (mut ws, _) = connect_async(request)
        .await
        .map_err(|e| format!("WebSocket connect failed: {e}"))?;

    // ── Send protocol messages ─────────────────────────────────────────────

    ws.send(Message::Text(speech_config_msg()))
        .await
        .map_err(|e| format!("Failed to send speech.config: {e}"))?;

    ws.send(Message::Text(ssml_msg(&req_id, &voice, &rate, &pitch, &text)))
        .await
        .map_err(|e| format!("Failed to send SSML: {e}"))?;

    // ── Stream audio chunks ────────────────────────────────────────────────
    //
    // Binary frame layout:
    //   [0..2]      u16 big-endian  — header byte length (N)
    //   [2..2+N]    UTF-8 text      — frame header (e.g. "Path:audio\r\nContent-Type:audio/mpeg\r\n...")
    //   [2+N..]     bytes           — MP3 audio payload
    //
    // Text frames with "Path:turn.end" signal end of stream.

    let mut stream_error: Option<String> = None;

    while let Some(msg) = ws.next().await {
        match msg {
            Ok(Message::Binary(data)) => {
                if data.len() < 2 {
                    continue;
                }
                let header_len = u16::from_be_bytes([data[0], data[1]]) as usize;
                if data.len() < 2 + header_len {
                    continue;
                }
                let header = std::str::from_utf8(&data[2..2 + header_len]).unwrap_or("");
                if header.contains("Path:audio") {
                    let audio = &data[2 + header_len..];
                    if !audio.is_empty() {
                        window
                            .emit(
                                "edge_tts_chunk",
                                EdgeTtsChunk {
                                    id: id.clone(),
                                    data: STANDARD.encode(audio),
                                },
                            )
                            .ok();
                    }
                }
            }

            Ok(Message::Text(txt)) => {
                if txt.contains("Path:turn.end") {
                    break;
                }
            }

            Err(e) => {
                stream_error = Some(e.to_string());
                break;
            }

            _ => {}
        }
    }

    window
        .emit(
            "edge_tts_done",
            EdgeTtsDone {
                id: id.clone(),
                error: stream_error,
            },
        )
        .ok();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors from edge-tts 7.3.1: drm.generate_sec_ms_gec_v2(unix_timestamp)
    #[test]
    fn sec_ms_gec_v2_matches_reference() {
        let cases = [
            (1700000000.0, "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2"),
            (1761800000.0, "C338E44013EC6A42-56CF5AB7E371B3C984C1E1E9DE512F31C46FE3E4F78F93C6B6D37503227DE8BF"),
            (0.0, "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6"),
        ];
        for (ts, expected) in cases {
            assert_eq!(generate_sec_ms_gec_at(ts), expected, "timestamp {ts}");
        }
    }
}
