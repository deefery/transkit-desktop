// Run with: node --test src/window/Translate/providerFallback.test.js
// Provider fallback rules (roadmap task F1): error classification, cool-downs, the next provider.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createProductionLoader } from '../../features/selection-actions/testing/loadProduction.mjs';

let loader;
let F;
before(async () => {
    loader = await createProductionLoader();
    F = await loader.load('/src/window/Translate/providerFallback.js');
});
after(() => loader.close());

describe('classifyTranslateError', () => {
    test('HTTP statuses map to their kind', () => {
        assert.equal(F.classifyTranslateError('Http Request Error\nHttp Status: 429\nToo Many Requests'), 'rate-limit');
        assert.equal(F.classifyTranslateError('Http Request Error\nHttp Status: 401'), 'auth');
        assert.equal(F.classifyTranslateError('Http Request Error\nHttp Status: 403'), 'auth');
        assert.equal(F.classifyTranslateError('Http Request Error\nHttp Status: 504'), 'timeout');
        assert.equal(F.classifyTranslateError('Http Request Error\nHttp Status: 503'), 'service');
        assert.equal(F.classifyTranslateError(new Error('status code 429')), 'rate-limit');
    });

    test('wording is used when there is no status', () => {
        assert.equal(F.classifyTranslateError('Language not supported'), 'unsupported-language');
        assert.equal(F.classifyTranslateError('Invalid API key provided'), 'auth');
        assert.equal(F.classifyTranslateError('Request timed out'), 'timeout');
        assert.equal(F.classifyTranslateError('error sending request for url (https://x): dns error'), 'network');
        assert.equal(F.classifyTranslateError('Network Error'), 'network');
        assert.equal(F.classifyTranslateError('quota exceeded'), 'rate-limit');
    });

    test('anything else is a service failure, and odd inputs never throw', () => {
        assert.equal(F.classifyTranslateError('Get Token Failed'), 'service');
        for (const value of [undefined, null, 0, {}, { a: 1 }, [], 'Error: 12345']) {
            assert.equal(F.classifyTranslateError(value), 'service', String(value));
        }
    });
});

describe('enabledProviders', () => {
    test('keeps the user order and drops disabled instances', () => {
        assert.deepEqual(
            F.enabledProviders(['bing', 'google', 'deepl'], { google: { enable: false }, deepl: {} }),
            ['bing', 'deepl']
        );
        assert.deepEqual(F.enabledProviders(null, null), []);
    });
});

describe('createFallbackController', () => {
    const LIST = ['bing', 'google', 'deepl'];
    const clock = () => {
        let t = 1000;
        return { now: () => t, advance: (ms) => (t += ms) };
    };

    test('a failing provider hands over to the next one, once each, then stops', () => {
        const c = F.createFallbackController();
        const r = 'req-1';
        assert.equal(c.onRequest(r, 'bing', LIST), 'bing');
        assert.deepEqual(c.onFailure({ requestKey: r, provider: 'bing', error: 'Get Token Failed', enabled: LIST }), {
            kind: 'service',
            next: 'google',
        });
        assert.deepEqual(c.onFailure({ requestKey: r, provider: 'google', error: 'Network Error', enabled: LIST }), {
            kind: 'network',
            next: 'deepl',
        });
        assert.equal(c.onFailure({ requestKey: r, provider: 'deepl', error: 'x', enabled: LIST }).next, null);
    });

    test('a provider chosen by hand, or fallback turned off, is never switched away from', () => {
        const c = F.createFallbackController();
        assert.equal(c.onFailure({ requestKey: 'r', provider: 'bing', error: 'x', enabled: LIST, manual: true }).next, null);
        assert.equal(
            c.onFailure({ requestKey: 'r2', provider: 'bing', error: 'x', enabled: LIST, autoFallback: false }).next,
            null
        );
        // ... but the "Try" button still offers the next untried provider.
        assert.equal(c.nextUntried('r2', LIST), 'google');
    });

    test('a new request starts on a provider that is not cooling down; the cool-down ends', () => {
        const t = clock();
        const c = F.createFallbackController({ now: t.now });
        c.onFailure({ requestKey: 'a', provider: 'bing', error: 'Get Token Failed', enabled: LIST });
        assert.equal(c.onRequest('b', 'bing', LIST), 'google', 'bing is skipped while cooling down');
        t.advance(F.COOLDOWN_MS.service + 1);
        assert.equal(c.onRequest('c', 'bing', LIST), 'bing');
    });

    test('cool-downs follow the kind: none for an unsupported pair, short for rate limits', () => {
        const t = clock();
        const c = F.createFallbackController({ now: t.now });
        c.onFailure({ requestKey: 'a', provider: 'bing', error: 'Language not supported', enabled: LIST });
        assert.equal(c.isCooling('bing'), false);
        c.onFailure({ requestKey: 'b', provider: 'google', error: 'Http Status: 429', enabled: LIST });
        assert.equal(c.isCooling('google'), true);
        t.advance(F.COOLDOWN_MS['rate-limit'] + 1);
        assert.equal(c.isCooling('google'), false);
    });

    test('when every provider is cooling down the selected one is kept', () => {
        const c = F.createFallbackController();
        for (const provider of LIST) c.onFailure({ requestKey: provider, provider, error: 'x', enabled: LIST });
        assert.equal(c.onRequest('new', 'google', LIST), 'google');
    });

    test('a selected provider that is no longer enabled falls back to the first enabled one', () => {
        const c = F.createFallbackController();
        assert.equal(c.onRequest('r', 'removed', LIST), 'bing');
        assert.equal(c.onRequest('r', 'x', []), 'x');
    });

    test('a success or a config change clears cool-downs', () => {
        const c = F.createFallbackController();
        c.onFailure({ requestKey: 'a', provider: 'bing', error: 'x', enabled: LIST });
        c.onSuccess('bing');
        assert.equal(c.isCooling('bing'), false);
        c.onFailure({ requestKey: 'b', provider: 'google', error: 'Http Status: 401', enabled: LIST });
        c.reset();
        assert.equal(c.isCooling('google'), false);
        assert.equal(c.nextUntried('b', LIST), 'bing');
    });

    test('a manual choice counts as tried for the request', () => {
        const c = F.createFallbackController();
        c.onManualChoice('r', 'bing');
        assert.equal(c.nextUntried('r', LIST), 'google');
        assert.equal(c.nextUntried('other', LIST), 'bing', 'a new request starts over');
    });
});
