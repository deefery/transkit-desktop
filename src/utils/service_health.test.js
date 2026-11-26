// Run with: node --test src/utils/service_health.test.js
// Service health (H1): what is stored after an outcome, and the per-kind service tests.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createProductionLoader } from '../features/selection-actions/testing/loadProduction.mjs';

let loader;
let H;
before(async () => {
    loader = await createProductionLoader();
    H = await loader.load('/src/utils/service_health.js');
});
after(() => loader.close());

describe('nextHealthRecord', () => {
    test('a test result is always stored, with latency', () => {
        assert.deepEqual(H.nextHealthRecord(null, { ok: true, ms: 412.6, source: 'test' }, 1000), {
            ok: true,
            at: 1000,
            ms: 413,
            source: 'test',
        });
        assert.deepEqual(
            H.nextHealthRecord({ ok: true, at: 1 }, { ok: false, error: 'Http Request Error\nHttp Status: 429', ms: 90, source: 'test' }, 2000),
            { ok: false, at: 2000, kind: 'rate-limit', status: 429, ms: 90, source: 'test' }
        );
    });

    test('only the kind and HTTP status of a failure are kept, never the error text', () => {
        const record = H.nextHealthRecord(null, { ok: false, error: new Error('AI request failed: 401 key=sk-secret') }, 5);
        assert.deepEqual(record, { ok: false, at: 5, kind: 'auth', status: 401, source: 'use' });
        assert.doesNotMatch(JSON.stringify(record), /secret|key=/);
    });

    test('real use: a success after a success, or the same failure within a minute, is not written again', () => {
        assert.equal(H.nextHealthRecord({ ok: true, at: 1 }, { ok: true, source: 'use' }, 2), null);
        const failure = { ok: false, at: 1000, kind: 'service', source: 'use' };
        assert.equal(H.nextHealthRecord(failure, { ok: false, error: 'Get Token Failed', source: 'use' }, 30000), null);
        assert.equal(H.nextHealthRecord(failure, { ok: false, error: 'Get Token Failed', source: 'use' }, 70000).at, 70000);
        assert.equal(H.nextHealthRecord(failure, { ok: false, error: 'Network Error', source: 'use' }, 2000).kind, 'network');
        assert.equal(H.nextHealthRecord(failure, { ok: true, source: 'use' }, 3000).ok, true, 'recovery is written');
    });

    test('an unsupported language pair seen in use is not a health problem; a test still records it', () => {
        assert.equal(H.nextHealthRecord(null, { ok: false, error: 'Language not supported', source: 'use' }, 1), null);
        assert.equal(H.nextHealthRecord(null, { ok: false, error: 'Language not supported', source: 'test' }, 1).kind, 'unsupported-language');
    });

    test('malformed outcomes are ignored', () => {
        assert.equal(H.nextHealthRecord(null, null), null);
        assert.equal(H.nextHealthRecord(null, { ms: 3 }), null);
    });
});

describe('recordServiceOutcome', () => {
    const fakeStore = (initial = {}) => {
        const data = new Map(Object.entries(initial));
        return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => data.set(k, v), save: async () => {} };
    };

    test('writes the record, saves, and tells every window', async () => {
        const store = fakeStore();
        const events = [];
        const wrote = await H.recordServiceOutcome({
            store,
            emit: async (name, payload) => events.push([name, payload]),
            instanceKey: 'bing',
            outcome: { ok: false, error: 'Get Token Failed', source: 'use' },
            now: 10,
        });
        assert.equal(wrote, true);
        assert.deepEqual(store.data.get('service_health'), { bing: { ok: false, at: 10, kind: 'service', source: 'use' } });
        assert.deepEqual(events, [['service_health_changed', { bing: { ok: false, at: 10, kind: 'service', source: 'use' } }]]);
    });

    test('nothing is written when nothing changed, or for a missing key', async () => {
        const store = fakeStore({ service_health: { google: { ok: true, at: 1, source: 'use' } } });
        const events = [];
        const emit = async (...a) => events.push(a);
        assert.equal(await H.recordServiceOutcome({ store, emit, instanceKey: 'google', outcome: { ok: true, source: 'use' } }), false);
        assert.equal(await H.recordServiceOutcome({ store, emit, instanceKey: '', outcome: { ok: true } }), false);
        assert.equal(events.length, 0);
    });
});

describe('service tests', () => {
    const translateModule = (impl) => ({ Language: { auto: '', en: 'EN', zh_cn: 'ZH' }, translate: impl });

    test('translate: English to Simplified Chinese through the module, timed', async () => {
        const calls = [];
        const r = await H.testTranslateService({
            module: translateModule(async (...args) => {
                calls.push(args.slice(0, 3));
                return '你好';
            }),
            config: { k: 1 },
        });
        assert.equal(r.ok, true);
        assert.ok(r.ms >= 0);
        assert.deepEqual(calls, [['Hello', 'EN', 'ZH']]);
    });

    test('translate: failures, empty results and unsupported services are failures', async () => {
        assert.equal((await H.testTranslateService({ module: translateModule(async () => Promise.reject(new Error('Http Status: 403'))) })).ok, false);
        assert.equal((await H.testTranslateService({ module: translateModule(async () => '') })).ok, false);
        assert.match(String((await H.testTranslateService({ module: { Language: { fr: 'f' } } })).error), /Language not supported/);
        assert.match(String((await H.testTranslateService({})).error), /not available/);
    });

    test('translate: plugins go through their own function and language table', async () => {
        const r = await H.testTranslateService({
            plugin: { language: { en: 'en', ja: 'ja' }, utils: {}, func: async (text, from, to) => `${text}:${from}>${to}` },
        });
        assert.equal(r.ok, true);
    });

    test('TTS and AI tests', async () => {
        assert.equal((await H.testTtsService({ synthesize: async () => new Uint8Array([1]) })).ok, true);
        assert.equal((await H.testTtsService({ synthesize: async () => null })).ok, false);
        const ai = await H.testAiService({ module: { summarize: async (_t, o) => (o.config.systemPrompt ? 'OK' : '') }, config: { apiKey: 'x' } });
        assert.equal(ai.ok, true);
        assert.equal((await H.testAiService({ module: { summarize: async () => '   ' } })).ok, false);
        assert.equal((await H.testAiService({ module: {} })).ok, false);
    });
});
