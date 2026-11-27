// Run with: node --test src/utils/stream_fetch.test.js
// The streaming fetch wrapper (roadmap S1) over a fake native transport.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createStreamFetch } from './stream_fetch_core.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** A fake `http_stream` transport: `respond(request, emit)` returns the head and may emit events. */
function fakeTransport(respond) {
    const handlers = new Map();
    const calls = [];
    const transport = {
        calls,
        listening: () => handlers.size,
        emit: (id, payload) => handlers.get(`http_stream://${id}`)?.({ payload }),
        listen: async (event, handler) => {
            handlers.set(event, handler);
            return () => handlers.delete(event);
        },
        invoke: async (cmd, args) => {
            calls.push({ cmd, args });
            if (cmd === 'http_stream_cancel') return null;
            return respond(args, (payload) => transport.emit(args.id, payload));
        },
    };
    return transport;
}

async function readAll(response) {
    const reader = response.body.getReader();
    const parts = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return parts;
        parts.push(new TextDecoder().decode(value));
    }
}

describe('streamFetch', () => {
    test('sends the request and streams the body chunk by chunk', async () => {
        const t = fakeTransport((args, emit) => {
            // Chunks may arrive before the command resolves with the head.
            emit({ type: 'chunk', data: b64('data: {"a":1}\n\n') });
            setTimeout(() => {
                emit({ type: 'chunk', data: b64('data: [DONE]\n\n') });
                emit({ type: 'end' });
            }, 5);
            return { status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream']] };
        });
        const streamFetch = createStreamFetch(t);
        const res = await streamFetch(new URL('https://api.example.com/v1/chat/completions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k' },
            body: '{"stream":true}',
        });
        assert.equal(res.ok, true);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'text/event-stream');
        assert.deepEqual(await readAll(res), ['data: {"a":1}\n\n', 'data: [DONE]\n\n']);
        const { args } = t.calls[0];
        assert.equal(args.request.url, 'https://api.example.com/v1/chat/completions');
        assert.equal(args.request.method, 'POST');
        assert.equal(args.request.body, '{"stream":true}');
        assert.deepEqual(args.request.headers, [
            ['authorization', 'Bearer k'],
            ['content-type', 'application/json'],
        ]);
        assert.equal(t.listening(), 0, 'listener removed after end');
    });

    test('an HTTP error is a normal response with its body', async () => {
        const t = fakeTransport((args, emit) => {
            setTimeout(() => {
                emit({ type: 'chunk', data: b64('{"error":{"message":"bad key"}}') });
                emit({ type: 'end' });
            }, 1);
            return { status: 401, statusText: 'Unauthorized', headers: [] };
        });
        const res = await createStreamFetch(t)('https://api.example.com/x');
        assert.equal(res.ok, false);
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { error: { message: 'bad key' } });
    });

    test('a failed connection rejects like fetch does', async () => {
        const t = fakeTransport(async () => {
            throw 'error sending request: connection refused';
        });
        await assert.rejects(createStreamFetch(t)('http://127.0.0.1:9/'), (e) => e instanceof TypeError && /connection refused/.test(e.message));
        assert.equal(t.listening(), 0);
    });

    test('a read error mid-stream errors the body', async () => {
        const t = fakeTransport((args, emit) => {
            setTimeout(() => {
                emit({ type: 'chunk', data: b64('partial') });
                emit({ type: 'error', message: 'operation timed out' });
            }, 1);
            return { status: 200, statusText: 'OK', headers: [] };
        });
        const res = await createStreamFetch(t)('https://api.example.com/x');
        await assert.rejects(readAll(res), /operation timed out/);
    });

    test('cancelling the reader stops the native request', async () => {
        const t = fakeTransport((args, emit) => {
            setTimeout(() => emit({ type: 'chunk', data: b64('first') }), 1);
            return { status: 200, statusText: 'OK', headers: [] };
        });
        const res = await createStreamFetch(t)('https://api.example.com/x');
        const reader = res.body.getReader();
        assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
        await reader.cancel();
        const cancel = t.calls.find((c) => c.cmd === 'http_stream_cancel');
        assert.equal(cancel.args.id, t.calls[0].args.id);
        assert.equal(t.listening(), 0);
    });

    test('abort before the response rejects with AbortError and cancels', async () => {
        const controller = new AbortController();
        let release;
        const t = fakeTransport(
            () =>
                new Promise((_, reject) => {
                    release = () => reject('Request cancelled');
                })
        );
        const pending = createStreamFetch(t)('https://api.example.com/x', { signal: controller.signal });
        await new Promise((r) => setTimeout(r, 5));
        controller.abort();
        release();
        await assert.rejects(pending, { name: 'AbortError' });
        assert.ok(t.calls.some((c) => c.cmd === 'http_stream_cancel'));
    });

    test('abort while reading errors the body', async () => {
        const controller = new AbortController();
        const t = fakeTransport(() => ({ status: 200, statusText: 'OK', headers: [] }));
        const res = await createStreamFetch(t)('https://api.example.com/x', { signal: controller.signal });
        const reading = readAll(res);
        controller.abort();
        await assert.rejects(reading, { name: 'AbortError' });
        assert.ok(t.calls.some((c) => c.cmd === 'http_stream_cancel'));
    });

    test('only string bodies are sent', async () => {
        const t = fakeTransport(() => ({ status: 200, statusText: 'OK', headers: [] }));
        await assert.rejects(createStreamFetch(t)('https://x/', { method: 'POST', body: new Uint8Array([1]) }), TypeError);
        assert.equal(t.calls.length, 0);
    });

    test('a 204 response has no body and frees the listener', async () => {
        const t = fakeTransport(() => ({ status: 204, statusText: 'No Content', headers: [] }));
        const res = await createStreamFetch(t)('https://x/');
        assert.equal(res.status, 204);
        assert.equal(res.body, null);
        assert.equal(t.listening(), 0);
    });
});
