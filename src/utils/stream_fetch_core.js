/**
 * A `fetch` for streaming responses, made by the native side (`http_stream` command) instead of
 * the WebView. Returns a standard `Response` whose `body` is a `ReadableStream` of the response
 * bytes as they arrive, so code written for `window.fetch` (`res.ok`, `res.body.getReader()`,
 * `res.json()`) works unchanged. Supports `method`, `headers`, a string `body`, `signal` (abort)
 * and `timeoutMs` (longest wait between two reads).
 *
 * `createStreamFetch` takes the transport so tests can run it without Tauri.
 */
export function createStreamFetch({ invoke: call, listen }) {
    return async function streamFetch(input, init = {}) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const { method = 'GET', headers, body, signal, timeoutMs } = init;
        if (body != null && typeof body !== 'string') throw new TypeError('streamFetch only sends string bodies');
        if (signal?.aborted) throw abortError(signal);

        const id = randomId();
        let controller;
        let settled = false;
        let unlisten = () => {};
        const cleanup = () => {
            if (settled) return;
            settled = true;
            unlisten();
            signal?.removeEventListener('abort', onAbort);
        };
        const cancel = () => {
            call('http_stream_cancel', { id }).catch(() => {});
            cleanup();
        };
        const stream = new ReadableStream({
            start(c) {
                controller = c;
            },
            cancel,
        });
        function onAbort() {
            cancel();
            try {
                controller.error(abortError(signal));
            } catch (_) {}
        }

        unlisten = await listen(`http_stream://${id}`, ({ payload }) => {
            if (settled) return;
            if (payload.type === 'chunk') {
                controller.enqueue(decodeBase64(payload.data));
            } else if (payload.type === 'end') {
                cleanup();
                controller.close();
            } else if (payload.type === 'error') {
                cleanup();
                controller.error(new TypeError(`Network error: ${payload.message}`));
            }
        });
        signal?.addEventListener('abort', onAbort);

        let head;
        try {
            head = await call('http_stream', {
                id,
                request: { method, url, headers: headerPairs(headers), body: body ?? null, timeoutMs: timeoutMs ?? null },
            });
        } catch (error) {
            const aborted = signal?.aborted;
            cleanup();
            if (aborted) throw abortError(signal);
            throw new TypeError(`Network error: ${error}`);
        }
        if (signal?.aborted) throw abortError(signal);
        // Response only accepts 200-599; other codes are reported as-is on a plain object.
        const responseHeaders = new Headers(head.headers);
        const nullBody = [204, 205, 304].includes(head.status);
        if (head.status >= 200 && head.status <= 599) {
            const response = new Response(nullBody ? null : stream, {
                status: head.status,
                statusText: head.statusText,
                headers: responseHeaders,
            });
            if (nullBody) cancel();
            return response;
        }
        return { ok: false, status: head.status, statusText: head.statusText, headers: responseHeaders, body: stream };
    };
}

function headerPairs(headers) {
    if (!headers) return [];
    return [...new Headers(headers).entries()];
}

function randomId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replaceAll('-', '');
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function decodeBase64(data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function abortError(signal) {
    return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}
