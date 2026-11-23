// Thin client for the Rust-side "use my ChatGPT plan" feature (src-tauri/src/chatgpt).
//
// Credentials never reach the webview: sign-in, token refresh and requests all run in Rust. This
// module only sees account state and request results.
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

export class ChatGPTError extends Error {
    constructor({ code = 'unknown', message = 'ChatGPT request failed', retryable = false, status, requestId } = {}) {
        super(message);
        this.name = 'ChatGPTError';
        this.code = code;
        this.retryable = retryable;
        this.status = status;
        this.requestId = requestId;
    }
}

// Tauri rejects with whatever the Rust command returned in `Err(..)`: our serialized error object,
// or a plain string for framework-level failures.
export function toChatGPTError(error) {
    if (error instanceof ChatGPTError) return error;
    if (error && typeof error === 'object' && typeof error.code === 'string') return new ChatGPTError(error);
    return new ChatGPTError({ message: typeof error === 'string' ? error : (error?.message ?? String(error)) });
}

async function call(command, args) {
    try {
        return await invoke(command, args);
    } catch (error) {
        throw toChatGPTError(error);
    }
}

// -> { status: 'disconnected' | 'connected' | 'reauth_required', sharing, email?, name? }
export const getChatGPTStatus = () => call('chatgpt_status');

// Opens the system browser and resolves once the user finished (or rejects with a ChatGPTError).
export const signInChatGPT = ({ reconsent = false } = {}) => call('chatgpt_sign_in', { reconsent });
export const cancelChatGPTSignIn = () => call('chatgpt_cancel_sign_in');

// -> { revoked } ; `revoked: false` means remote revocation could not be confirmed.
export const signOutChatGPT = () => call('chatgpt_sign_out');

// -> [{ slug, display_name }]
export const listChatGPTModels = () => call('chatgpt_list_models');

let requestCounter = 0;

/**
 * One request on the user's ChatGPT plan.
 * @param {object} p
 * @param {string} [p.model] empty -> the first model ChatGPT lists for the account
 * @param {string} [p.instructions] system-level guidance
 * @param {{role: 'user'|'assistant'|'developer', content: string}[]} p.input
 * @param {(delta: string) => void} [p.onDelta] receive text as it streams in
 * @returns {Promise<string>} the full output text
 */
export async function chatgptRespond({ model = '', instructions, input, onDelta }) {
    requestCounter += 1;
    const id = `${Date.now().toString(36)}-${requestCounter}`;
    const stream = typeof onDelta === 'function';
    let unlisten = null;
    if (stream) {
        unlisten = await listen('chatgpt-delta', (event) => {
            if (event.payload?.id === id && typeof event.payload.delta === 'string') onDelta(event.payload.delta);
        });
    }
    try {
        return await call('chatgpt_respond', {
            requestId: id,
            model: model ?? '',
            instructions: instructions ?? null,
            input,
            stream,
        });
    } finally {
        if (unlisten) unlisten();
    }
}

// A prompt list as the OpenAI translate provider stores it ([{role, content}], first entry usually
// `system`) -> the Responses API shape: system text becomes `instructions`, the rest `input`.
export function splitPromptList(promptList) {
    const instructions = [];
    const input = [];
    for (const item of Array.isArray(promptList) ? promptList : []) {
        const content = typeof item?.content === 'string' ? item.content : '';
        if (content.trim() === '') continue;
        if (item.role === 'system' || item.role === 'developer') instructions.push(content);
        else input.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content });
    }
    return { instructions: instructions.join('\n\n'), input };
}

// Replace `$name` placeholders in a single pass, so a placeholder-looking string inside the user's
// own text (e.g. "$to") is never substituted, and `$&` / `$1` in that text is never interpreted as
// a replacement pattern.
export function fillPlaceholders(template, values) {
    const names = Object.keys(values).sort((a, b) => b.length - a.length);
    if (names.length === 0) return template;
    const pattern = new RegExp(`\\$(${names.join('|')})`, 'g');
    return template.replace(pattern, (_, name) => String(values[name] ?? ''));
}

export function describeChatGPTError(error) {
    const e = toChatGPTError(error);
    return e.requestId ? `${e.message} (${e.code}, ${e.requestId})` : `${e.message} (${e.code})`;
}
