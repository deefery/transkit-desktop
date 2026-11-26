// Run with: node --test src/window/Config/pages/Welcome/welcome.browser.test.js
// Rendered check (headless Chrome/Edge) of the first-run Welcome page (O1). Not a native window.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { findBrowser, runInBrowser } from '../../../../features/selection-actions/dictionary/testing/browserRunner.mjs';

const skip = findBrowser() ? false : 'no Edge/Chrome available for the rendered check';

describe('Welcome page (headless browser)', { skip }, () => {
    let out;
    before(async () => {
        const run = await runInBrowser({
            module: 'src/window/Config/pages/Welcome/testing/welcomeCases.js',
            stubTauri: true,
            timeoutMs: 120000,
        });
        out = run.value;
    });

    test('three steps: languages, translation service, shortcut', () => {
        assert.deepEqual(out.steps, ['welcome-step-language', 'welcome-step-service', 'welcome-step-shortcut']);
        assert.equal(out.heading, "Let's set up TransKit");
        assert.equal(out.appLanguage, 'English');
        assert.equal(out.targetLanguage, 'Simplified Chinese');
    });

    test('the checked services show their result; the first working one is recommended', () => {
        assert.equal(out.before[0].key, 'bing');
        assert.match(out.before[0].text, /Bing Primary .*Failed: service unavailable/);
        assert.match(out.before[1].text, /Google Recommended .*OK · 640 ms/);
        assert.match(out.before[1].text, /Use as primary/);
    });

    test('Use as primary puts the service first in the stored list', () => {
        assert.deepEqual(out.after.map((s) => s.key), ['google', 'bing']);
        assert.match(out.after[0].text, /Google Primary/);
        assert.deepEqual(out.storedList, ['google', 'bing']);
    });

    test('the shortcut step names the configured keys and waits for a press', () => {
        assert.match(out.shortcut, /press Ctrl \+ Alt \+ Q/);
        assert.match(out.shortcut, /Translation tools work best when they stay out of your way\./);
        assert.equal(out.shortcutState, 'waiting');
    });

    test('Finish clears the first-run flag and moves on to General', () => {
        assert.equal(out.pendingAfterFinish, false);
    });
});
