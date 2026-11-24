// Run with: node --test src/window/Translate/providerFallback.browser.test.js
// Rendered check (headless Chrome/Edge) of the provider fallback hook and its notice, plus guards
// that the Translate window wires them in. Not a native Windows/Tauri window check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { findBrowser, runInBrowser } from '../../features/selection-actions/dictionary/testing/browserRunner.mjs';

const skip = findBrowser() ? false : 'no Edge/Chrome available for the rendered check';

describe('provider fallback (headless browser)', { skip }, () => {
    let out;
    before(async () => {
        const run = await runInBrowser({
            module: 'src/window/Translate/testing/fallbackCases.js',
            stubTauri: true,
            timeoutMs: 120000,
        });
        out = run.value;
    });

    test('starts on the first provider without a notice', () => {
        assert.deepEqual(out.start, { active: 'bing', type: null, kind: null, text: null });
    });

    test('a failing provider hands over to the next one and says why', () => {
        assert.equal(out.afterBing.active, 'google');
        assert.equal(out.afterBing.type, 'switched');
        assert.equal(out.afterBing.text, 'Bing: service unavailable. Showing Google instead.');
        assert.equal(out.afterGoogle.active, 'deepl');
        assert.match(out.afterGoogle.text, /^Google: too many requests\. Showing DeepL/);
    });

    test('when every provider failed, it stays with guidance and no Try button', () => {
        assert.equal(out.allFailed.active, 'deepl');
        assert.equal(out.allFailed.type, 'failed');
        assert.equal(out.allFailed.kind, 'network');
        assert.match(out.allFailed.text, /Check your network or proxy/);
        assert.equal(out.allFailed.tryButton, false);
    });

    test('a new selection keeps the shown provider when every provider is cooling down', () => {
        assert.equal(out.newRequestAllCooling.active, 'deepl');
        assert.equal(out.newRequestAllCooling.type, null);
    });

    test('a provider picked by hand is not switched away from; Try and Open Settings are offered', () => {
        assert.equal(out.manualPick.active, 'google');
        assert.equal(out.manualFailure.active, 'google');
        assert.equal(out.manualFailure.type, 'failed');
        assert.equal(out.manualFailure.kind, 'auth');
        assert.match(out.manualFailure.text, /rejected the API key/);
        assert.equal(out.manualFailure.tryText, 'Try Bing');
        assert.equal(out.manualFailure.settingsButton, true);
        assert.equal(out.settingsOpened, 1);
        assert.equal(out.afterTry.active, 'bing');
        assert.equal(out.afterTry.type, null);
        assert.equal(out.afterTrySuccess.type, null);
    });

    test('a provider that failed recently is skipped for the next selection, with a notice', () => {
        assert.equal(out.cooling.active, 'bing');
        assert.equal(out.cooling.type, 'cooling');
        assert.equal(out.cooling.text, 'DeepL failed recently. Showing Bing.');
    });
});

describe('Translate window wiring guards', () => {
    const source = readFileSync(new URL('./index.jsx', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

    test('provider tabs go through the fallback hook (a hand-picked provider is remembered)', () => {
        assert.match(source, /useProviderFallback\(\{/);
        assert.equal(source.split('chooseProvider(index);').length - 1, 2, 'both tab rows');
        assert.doesNotMatch(source, /onPress=\{\(\) => \{\s*setSelectedProviderIndex\(index\);/);
    });

    test('the notice is rendered under the shown provider in both layouts, and keeps the tabs visible', () => {
        assert.equal(source.split('<ProviderNotice').length - 1, 2);
        assert.match(source, /fixedProviders \|\| providerNotice \? 'opacity-100'/);
    });
});
