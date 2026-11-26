// Run with: node --test src/window/Config/pages/Service/serviceHealth.browser.test.js
// Rendered check (headless Chrome/Edge) of the service health rows (H1) with the real Lingva
// request code answered by fixtures. Not a native Windows/Tauri window check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { findBrowser, runInBrowser } from '../../../../features/selection-actions/dictionary/testing/browserRunner.mjs';

const skip = findBrowser() ? false : 'no Edge/Chrome available for the rendered check';

describe('service health (headless browser)', { skip }, () => {
    let out;
    let requests;
    before(async () => {
        let calls = 0;
        const run = await runInBrowser({
            module: 'src/window/Config/pages/Service/testing/healthCases.js',
            stubTauri: true,
            respond: (url) => {
                if (!url.startsWith('https://lingva.transkit.app/')) return { status: 404, body: {} };
                calls += 1;
                return calls === 3 ? { status: 429, body: { error: 'Too many requests' } } : { status: 200, body: { translation: '你好' } };
            },
            timeoutMs: 120000,
        });
        out = run.value;
        requests = run.requests;
    });

    test('an untested instance says so; a failure seen in use shows its kind and when', () => {
        assert.deepEqual(out.initial.lingva, { state: 'untested', summary: 'Not tested yet' });
        assert.equal(out.initial['lingva@second'].state, 'failed');
        assert.equal(out.initial['lingva@second'].summary, 'Failed: service unavailable · 2 minutes ago');
    });

    test('Test sends one real request and shows OK with the latency', () => {
        assert.equal(out.afterTest.lingva.state, 'ok');
        assert.match(out.afterTest.lingva.summary, /^OK · \d+ ms · now$/);
        assert.match(requests[0].url, /^https:\/\/lingva\.transkit\.app\/api\/v1\/en\/zh\/Hello$/);
    });

    test('Test all runs every instance; a rate limit shows its kind and HTTP status', () => {
        assert.equal(out.afterTestAll.lingva.state, 'ok');
        assert.equal(out.afterTestAll['lingva@second'].state, 'failed');
        assert.equal(out.afterTestAll['lingva@second'].summary, 'Failed: too many requests (HTTP 429) · now');
        assert.equal(requests.filter((r) => r.url.startsWith('https://lingva.transkit.app/')).length, 3);
    });

    test('only kind, status, latency and time are stored, never response or error text', () => {
        const second = out.stored['lingva@second'];
        assert.deepEqual(Object.keys(second).sort(), ['at', 'kind', 'ms', 'ok', 'source', 'status']);
        assert.doesNotMatch(JSON.stringify(out.stored), /Too many requests|你好|Http Request Error/);
    });
});

describe('service health wiring', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

    test('every translate, TTS and AI service row has a health line and each list has Test all', () => {
        for (const [folder, kind] of [['Translate', 'TRANSLATE'], ['Tts', 'TTS'], ['Ai', 'AI']]) {
            assert.match(read(`./${folder}/ServiceItem/index.jsx`), new RegExp(`<ServiceHealth\\s+kind=\\{ServiceKind\\.${kind}\\}`), folder);
            assert.match(read(`./${folder}/index.jsx`), new RegExp(`<TestAllButton\\s+kind=\\{ServiceKind\\.${kind}\\}`), folder);
        }
    });

    test('the Translate window records real-use outcomes of the shown provider', () => {
        const hook = read('../../../Translate/useProviderFallback.js');
        assert.match(hook, /recordUse\(record\.instanceKey, true\)/);
        assert.match(hook, /recordUse\(record\.instanceKey, false, record\.error\)/);
    });
});
