// Single-owner audio playback for the Translate popup.
//
// Generic playback lifecycle (kept free of fork/feature code so it can be split into an
// upstream PR): a monotonic generation guards every asynchronous step, so a synthesis or
// decode that finishes after it was superseded can never start audio or touch the owner.

export const MIN_PLAYBACK_RATE = 0.1;
export const MAX_PLAYBACK_RATE = 4;

// Same clamp and meaning as the Monitor player (0.1-4.0). Anything that is not a finite
// positive number (null, '', 'abc', NaN, Infinity, objects) falls back to normal speed.
export function clampPlaybackRate(value, fallback = 1) {
    const rate = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    if (!Number.isFinite(rate) || rate <= 0) return fallback;
    return Math.min(Math.max(rate, MIN_PLAYBACK_RATE), MAX_PLAYBACK_RATE);
}

const toArrayBuffer = (data) => {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    return new Uint8Array(data).buffer;
};

/**
 * @param {object} options
 * @param {() => AudioContext} options.getAudioContext created lazily on first playback
 * @param {() => number | Promise<number>} [options.getRate] local playback multiplier source
 */
export function createVoicePlayer({ getAudioContext, getRate = () => 1 }) {
    let generation = 0;
    // { intent, owner, generation, phase: 'pending' | 'playing', source }
    let active = null;
    const listeners = new Set();

    const emit = () => {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (_) {
                // a faulty listener must not break playback
            }
        }
    };

    const decode = (ctx, data) =>
        new Promise((resolve, reject) => {
            try {
                const maybePromise = ctx.decodeAudioData(toArrayBuffer(data), resolve, reject);
                // Modern engines also return a promise; its rejection is already routed to `reject`.
                if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(() => {});
            } catch (e) {
                reject(e);
            }
        });

    const halt = () => {
        generation += 1;
        const old = active;
        active = null;
        const source = old?.source;
        if (source) {
            source.onended = null;
            try {
                source.stop();
            } catch (_) {
                // already stopped
            }
            try {
                source.disconnect();
            } catch (_) {
                // already disconnected
            }
        }
        if (old) emit();
        return old;
    };

    // Stop whatever is pending/playing. Everything still in flight becomes stale.
    const stop = () => {
        halt();
    };

    // Invalidate only when `owner` currently owns playback (e.g. the palette on context
    // change/unmount must not cut off the source/target Speak buttons).
    const invalidate = (owner) => {
        if (active && (owner === undefined || active.owner === owner)) halt();
    };

    const getState = () => ({
        intent: active?.intent ?? null,
        owner: active?.owner ?? null,
        phase: active?.phase ?? 'idle',
        generation,
    });

    /**
     * Play the audio produced by `produce` under `intent`.
     *  - same intent already pending/playing -> stop it (toggle), result `stopped`
     *  - different intent -> replaces the old one
     * Results: 'playing' | 'stopped' | 'stale'. Synthesis/decode errors reject, but only
     * when this request still owns playback; a superseded request resolves 'stale'.
     */
    const speak = async (intent, produce, { owner = 'default' } = {}) => {
        if (active && active.intent === intent) {
            halt();
            return { status: 'stopped' };
        }
        halt();
        const mine = { intent, owner, generation, phase: 'pending', source: null };
        active = mine;
        emit();
        const isCurrent = () => active === mine && generation === mine.generation;
        try {
            const data = await produce({ isCurrent });
            if (!isCurrent()) return { status: 'stale' };
            const ctx = getAudioContext();
            const buffer = await decode(ctx, data);
            const rate = clampPlaybackRate(await getRate());
            // a decode or rate read that finished after being superseded must not start audio
            if (!isCurrent()) return { status: 'stale' };
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.playbackRate.value = rate;
            source.connect(ctx.destination);
            mine.source = source;
            mine.phase = 'playing';
            // End callbacks only clear the playback this source owns.
            source.onended = () => {
                const owned = active === mine;
                if (owned) active = null;
                try {
                    source.disconnect();
                } catch (_) {
                    // already disconnected
                }
                if (owned) emit();
            };
            source.start();
            emit();
            return { status: 'playing' };
        } catch (e) {
            if (!isCurrent()) return { status: 'stale' };
            active = null;
            emit();
            throw e;
        }
    };

    // Backwards-compatible entry used by existing callers with ready audio data:
    // toggles - stops when anything is playing/pending, otherwise plays `data`.
    const playOrStop = (data) => {
        if (active) {
            halt();
            return Promise.resolve({ status: 'stopped' });
        }
        // The old hook never surfaced decode errors to its callers; keep that.
        return speak('legacy', async () => data, { owner: 'legacy' }).catch((e) => {
            console.error('Audio playback failed:', e);
            return { status: 'error' };
        });
    };

    // Called whenever the pending/playing/idle state changes; returns an unsubscribe function.
    const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    };

    return { speak, stop, invalidate, getState, playOrStop, subscribe };
}
