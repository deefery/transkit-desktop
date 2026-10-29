// Run with: node --test src/features/selection-actions/dictionary/palette.browser.test.js
// Rendered check in headless Edge: the real SelectionActionPalette React tree is mounted with the
// real hook / atoms / registry / dictionary controller / Cambridge adapter / mapper / panel, the
// Dictionary button is clicked, and the DOM is inspected. Only the Tauri native API (in-memory
// stub) and the HTTP transport (Cambridge-structured fixtures) are replaced.
// This is a browser check, NOT a native Windows/Tauri window check. Skipped without Edge/Chrome.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { findBrowser, runInBrowser } from './testing/browserRunner.mjs';
import { cambridgeResponder } from './testing/cambridgeFixtures.js';

const skip = findBrowser() ? false : 'no Edge/Chrome available for the rendered check';

describe('Dictionary action in the rendered palette (headless Edge)', { skip }, () => {
    let log;
    let panelAfterClose;
    before(async () => {
        const run = await runInBrowser({
            module: 'src/features/selection-actions/dictionary/testing/guiCases.js',
            stubTauri: true,
            respond: cambridgeResponder({ statusFor: { failing: 503 } }),
            timeoutMs: 150000,
            args: {
                steps: [
                    { text: 'resilience' },
                    { text: 'take off' },
                    { text: 'xqzvbnmkw' },
                    { text: 'The quick brown fox jumps over' },
                    { text: 'failing' },
                    { text: 'resilience', target: 'ja' },
                    { text: 'hostile word', target: 'zh_cn' },
                    { text: 'resilience', click: false },
                ],
            },
        });
        log = Object.fromEntries(run.value.log.map((entry, i) => [i, entry]));
        panelAfterClose = run.value.panelAfterClose;
    });

    test('word: clicking Dictionary shows the attributed result and a TTS Pronounce control', () => {
        const e = log[0];
        assert.equal(e.hasResult, true);
        assert.equal(e.source, 'Source: Cambridge Dictionary');
        assert.match(e.panel, /resilience.*noun.*UK \/rɪˈzɪl\.jəns\/.*US/);
        assert.match(e.panel, /复原力；恢复力/);
        assert.equal(e.hasPronounce, true);
        const dictionaryButton = e.toolbar.find((b) => b.text === 'Dictionary');
        assert.equal(dictionaryButton.pressed, 'true');
        assert.equal(dictionaryButton.disabled, false);
    });

    test('phrase: the old result is gone when the selection changes, then the phrase is looked up', () => {
        const e = log[1];
        assert.equal(e.panelBefore, false, 'stale panel cleared on selection change');
        assert.match(e.panel, /take off.*phrasal verb.*起飞；飞起/);
        assert.match(e.panel, /take-off.*noun/);
        assert.doesNotMatch(e.panel, /take something off/);
    });

    test('absent entry, sentence, failure and unsupported target are different visible states', () => {
        assert.equal(log[2].errorCode, 'not-found');
        assert.match(log[2].panel, /No entry for “xqzvbnmkw” in Cambridge Dictionary\./);
        assert.equal(log[3].errorCode, 'too-long');
        assert.match(log[3].panel, /Use Sentence Analysis for longer text/);
        assert.equal(log[3].hasResult, false);
        assert.equal(log[4].errorCode, 'provider-failed');
        assert.match(log[4].panel, /Cambridge Dictionary lookup failed\..*503.*Retry/);
        assert.equal(log[5].errorCode, 'unsupported-language');
        assert.equal(log[5].hasResult, false);
        for (const i of [2, 3, 4, 5]) assert.equal(log[i].hasPronounce, false, 'no pronunciation for a non-result');
    });

    test('provider text is rendered as text, never as markup', () => {
        const e = log[6];
        assert.equal(e.hasResult, true);
        assert.equal(e.scriptElementsInPanel, 0);
        assert.ok(e.panel.includes('<img src=x onerror=alert(1)>'));
        assert.ok(e.panel.includes('<script>alert(2)</script>'));
        assert.ok(e.panel.includes('<b>bold</b>'));
    });

    test('a result is not shown for another selection; Close dismisses the panel', () => {
        assert.equal(log[7].panelBefore, false);
        assert.equal(log[7].panel, null);
        assert.equal(panelAfterClose, false);
    });
});
