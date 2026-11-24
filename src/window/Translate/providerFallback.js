// Translation provider fallback (roadmap task F1). Pure rules plus a small controller, so the
// window only wires them up: classify a provider error, put a failing provider on a short
// cool-down, and pick the next provider to try for the same request.

export const AUTO_FALLBACK_CONFIG_KEY = 'translate_auto_fallback';

export const ErrorKind = Object.freeze({
    RATE_LIMIT: 'rate-limit',
    AUTH: 'auth',
    TIMEOUT: 'timeout',
    NETWORK: 'network',
    UNSUPPORTED_LANGUAGE: 'unsupported-language',
    SERVICE: 'service',
});

// How long a provider that failed is skipped when a new request starts. An unsupported language
// pair says nothing about other pairs, so it never cools down. A rejected key stays rejected until
// the user changes the service config (which clears every cool-down).
export const COOLDOWN_MS = Object.freeze({
    [ErrorKind.RATE_LIMIT]: 60 * 1000,
    [ErrorKind.AUTH]: 30 * 60 * 1000,
    [ErrorKind.TIMEOUT]: 2 * 60 * 1000,
    [ErrorKind.NETWORK]: 5 * 60 * 1000,
    [ErrorKind.SERVICE]: 5 * 60 * 1000,
    [ErrorKind.UNSUPPORTED_LANGUAGE]: 0,
});

const textOf = (error) => {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    if (error && typeof error === 'object') {
        try {
            return JSON.stringify(error);
        } catch (_) {
            return String(error);
        }
    }
    return String(error ?? '');
};

/** What kind of failure a provider error is (by HTTP status first, then by its wording). */
export function classifyTranslateError(error) {
    const text = textOf(error);
    if (/language not supported/i.test(text)) return ErrorKind.UNSUPPORTED_LANGUAGE;
    const status = /(?:http\s*status|status(?:\s*code)?)\s*[:=]?\s*(\d{3})/i.exec(text)?.[1] ?? /\b(4\d\d|5\d\d)\b/.exec(text)?.[1];
    if (status === '429') return ErrorKind.RATE_LIMIT;
    if (status === '401' || status === '403') return ErrorKind.AUTH;
    if (status === '408' || status === '504') return ErrorKind.TIMEOUT;
    if (/too many requests|rate.?limit|quota/i.test(text)) return ErrorKind.RATE_LIMIT;
    if (/api.?key|unauthori[sz]ed|forbidden|invalid (?:key|token|credential)|authenticat/i.test(text)) return ErrorKind.AUTH;
    if (/timed?\s*out|timeout/i.test(text)) return ErrorKind.TIMEOUT;
    if (/network|connect|dns|resolve|unreachable|refused|offline|socket|ECONN|ENOTFOUND|sending request/i.test(text)) {
        return ErrorKind.NETWORK;
    }
    return ErrorKind.SERVICE;
}

/** The enabled providers, in the user's order. */
export function enabledProviders(list, configMap) {
    return (Array.isArray(list) ? list : []).filter((key) => (configMap?.[key] ?? {}).enable ?? true);
}

const cooling = (cooldowns, key, now) => (cooldowns.get(key) ?? 0) > now;

/**
 * Fallback state of one Translate window. `now` is injectable for tests.
 *
 * - `onRequest(requestKey, selected, enabled)`: a new request (text/languages) starts. Returns the
 *   provider to show: the selected one, unless it is cooling down and another one is not.
 * - `onFailure({ requestKey, provider, error, enabled, manual, autoFallback })`: the shown provider
 *   failed. Returns `{ kind, next }`; `next` is the provider to switch to, or null to stay (manual
 *   choice, fallback off, or every provider has failed for this request).
 * - `nextUntried(requestKey, enabled)`: the provider a "Try …" button offers.
 */
export function createFallbackController({ now = () => Date.now() } = {}) {
    const cooldowns = new Map();
    let request = null;
    let tried = new Set();

    const begin = (requestKey) => {
        if (requestKey !== request) {
            request = requestKey;
            tried = new Set();
        }
    };
    const nextUntried = (requestKey, enabled) => {
        begin(requestKey);
        return (enabled ?? []).find((key) => !tried.has(key)) ?? null;
    };

    return {
        onRequest(requestKey, selected, enabled) {
            begin(requestKey);
            const list = enabled ?? [];
            if (!list.includes(selected)) return list[0] ?? selected ?? null;
            if (!cooling(cooldowns, selected, now())) return selected;
            return list.find((key) => !cooling(cooldowns, key, now())) ?? selected;
        },
        onFailure({ requestKey, provider, error, enabled, manual = false, autoFallback = true }) {
            begin(requestKey);
            const kind = classifyTranslateError(error);
            tried.add(provider);
            const ms = COOLDOWN_MS[kind] ?? 0;
            if (ms > 0) cooldowns.set(provider, now() + ms);
            const next = manual || autoFallback === false ? null : nextUntried(requestKey, enabled);
            if (next !== null) tried.add(next);
            return { kind, next };
        },
        onSuccess(provider) {
            cooldowns.delete(provider);
        },
        // The user picked a provider: it counts as tried for this request.
        onManualChoice(requestKey, provider) {
            begin(requestKey);
            tried.add(provider);
        },
        nextUntried,
        // Service config changed (a key fixed, a service added): give every provider a new chance.
        reset() {
            cooldowns.clear();
            tried = new Set();
        },
        isCooling: (key) => cooling(cooldowns, key, now()),
    };
}
