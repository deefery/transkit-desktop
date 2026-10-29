// Deterministic test doubles for the native audio boundary. Used by tests only.

export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export class FakeSource {
    constructor() {
        this.playbackRate = { value: 1 };
        this.started = false;
        this.stopped = false;
        this.disconnected = false;
        this.buffer = null;
        this.onended = null;
    }
    connect() {}
    disconnect() {
        this.disconnected = true;
    }
    start() {
        this.started = true;
    }
    stop() {
        this.stopped = true;
    }
    // Simulates natural end of playback.
    end() {
        this.onended?.();
    }
}

// decodeAudioData completes only when the test says so, so tests can finish two overlapping
// decodes in reverse order. `auto: true` completes immediately.
export class FakeAudioContext {
    constructor({ auto = false } = {}) {
        this.auto = auto;
        this.decodes = [];
        this.sources = [];
        this.destination = {};
    }
    decodeAudioData(arrayBuffer, ok, fail) {
        const entry = {
            bytes: Array.from(new Uint8Array(arrayBuffer)),
            finish: (buffer) => ok(buffer ?? { id: entry.bytes.join(',') }),
            fail: (error) => fail(error ?? new Error('decode failed')),
        };
        this.decodes.push(entry);
        if (this.auto) entry.finish();
    }
    createBufferSource() {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
    }
    reset() {
        this.decodes.length = 0;
        this.sources.length = 0;
    }
}
