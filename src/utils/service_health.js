// Service health (roadmap task H1): the last known outcome of each service instance, from a test
// in Settings or from real use in the Translate window, and the tests themselves.
//
// Stored per instance key under `service_health`: { ok, at, ms?, kind?, status?, source }.
// Only the kind of failure and its HTTP status are kept, never the error text: provider errors
// can carry request URLs or keys.
import { classifyTranslateError } from '../window/Translate/providerFallback.js';

export const HEALTH_CONFIG_KEY = 'service_health';
export const HealthSource = Object.freeze({ TEST: 'test', USE: 'use' });

// A repeated failure of the same kind from real use is written at most once a minute.
const REPEAT_WINDOW_MS = 60 * 1000;

const statusOf = (error) => {
    const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    const match = /(?:http\s*status|status(?:\s*code)?|failed:?)\s*[:=]?\s*(\d{3})\b/i.exec(text) ?? /\b([45]\d\d)\b/.exec(text);
    return match ? Number(match[1]) : null;
};

/**
 * The record to store after `outcome` ({ ok, error?, ms?, source }), or null when nothing worth
 * writing changed (real use that keeps succeeding; the same failure again within a minute).
 */
export function nextHealthRecord(previous, outcome, now = Date.now()) {
    if (!outcome || typeof outcome.ok !== 'boolean') return null;
    const source = outcome.source === HealthSource.TEST ? HealthSource.TEST : HealthSource.USE;
    const ms = Number.isFinite(outcome.ms) ? Math.round(outcome.ms) : undefined;
    if (outcome.ok) {
        if (source === HealthSource.USE && previous?.ok === true) return null;
        return { ok: true, at: now, ...(ms !== undefined ? { ms } : {}), source };
    }
    const kind = classifyTranslateError(outcome.error);
    const status = statusOf(outcome.error);
    // A language pair the service does not offer says nothing about whether the service works.
    if (source === HealthSource.USE && kind === 'unsupported-language') return null;
    if (
        source === HealthSource.USE &&
        previous?.ok === false &&
        previous.kind === kind &&
        now - (previous.at ?? 0) < REPEAT_WINDOW_MS
    ) {
        return null;
    }
    return { ok: false, at: now, kind, ...(status ? { status } : {}), ...(ms !== undefined ? { ms } : {}), source };
}

/**
 * Store the outcome of `instanceKey` and tell every window (useConfig listens for
 * `service_health_changed`). `store` is the config store, `emit` the Tauri event emitter.
 */
export async function recordServiceOutcome({ store, emit, instanceKey, outcome, now = Date.now() }) {
    if (typeof instanceKey !== 'string' || instanceKey === '') return false;
    const all = (await store.get(HEALTH_CONFIG_KEY)) ?? {};
    const record = nextHealthRecord(all[instanceKey], outcome, now);
    if (!record) return false;
    const next = { ...all, [instanceKey]: record };
    await store.set(HEALTH_CONFIG_KEY, next);
    await store.save();
    await emit(`${HEALTH_CONFIG_KEY}_changed`, next);
    return true;
}

async function timed(run) {
    const start = performance.now();
    try {
        const value = await run();
        return { ok: true, ms: performance.now() - start, value };
    } catch (error) {
        return { ok: false, ms: performance.now() - start, error };
    }
}

const TEST_TEXT = 'Hello';

/**
 * One small translation through the instance (English to Simplified Chinese, or the first other
 * language pair the service supports). `module` is the built-in service module; plugins pass
 * `plugin` ({ func, utils, language }).
 */
export async function testTranslateService({ module = null, plugin = null, config = {} }) {
    const languages = plugin ? plugin.language : module?.Language;
    if (!languages) return { ok: false, error: new Error('Service not available'), ms: 0 };
    const target = ['zh_cn', 'ja', 'en'].find((key) => key in languages && key !== 'en') ?? null;
    if (!('en' in languages) || !target) return { ok: false, error: new Error('Language not supported'), ms: 0 };
    const outcome = await timed(() =>
        plugin
            ? plugin.func(TEST_TEXT, languages.en, languages[target], { config, detect: 'en', setResult: () => {}, utils: plugin.utils })
            : module.translate(TEST_TEXT, languages.en, languages[target], { config, detect: 'en', setResult: () => {} })
    );
    if (outcome.ok && (outcome.value === '' || outcome.value === null || outcome.value === undefined)) {
        return { ok: false, ms: outcome.ms, error: new Error('Empty result') };
    }
    return { ok: outcome.ok, ms: outcome.ms, error: outcome.error };
}

/** Speak a short phrase through the instance (the audio is not played). */
export async function testTtsService({ synthesize }) {
    const outcome = await timed(() => synthesize(TEST_TEXT));
    if (outcome.ok && !outcome.value) return { ok: false, ms: outcome.ms, error: new Error('Empty result') };
    return { ok: outcome.ok, ms: outcome.ms, error: outcome.error };
}

/** One tiny request to an AI instance (asks for a one-word reply). */
export async function testAiService({ module, config = {} }) {
    if (typeof module?.summarize !== 'function') return { ok: false, error: new Error('Service not available'), ms: 0 };
    const outcome = await timed(() =>
        module.summarize('Reply with the single word OK.', {
            config: { ...config, systemPrompt: 'Reply with the single word OK.' },
        })
    );
    if (outcome.ok && (typeof outcome.value !== 'string' || outcome.value.trim() === '')) {
        return { ok: false, ms: outcome.ms, error: new Error('Empty result') };
    }
    return { ok: outcome.ok, ms: outcome.ms, error: outcome.error };
}
