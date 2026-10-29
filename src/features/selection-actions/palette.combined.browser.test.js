// Run with: node --test src/features/selection-actions/palette.combined.browser.test.js
// Rendered check in headless Edge of the COMBINED palette: the real React tree (hook, atoms, registry,
// Dictionary controller + Cambridge adapter/parser, shared AI runner, real services/ai request code)
// with Dictionary and an AI action open together. Only the Tauri native API (in-memory stub seeded
// with one AI service instance) and the HTTP transport (fixtures) are replaced.
// This is a browser check, NOT a native Windows/Tauri window check. Skipped without Edge/Chrome.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { findBrowser, runInBrowser } from './dictionary/testing/browserRunner.mjs';
import { cambridgeResponder } from './dictionary/testing/cambridgeFixtures.js';

const skip = findBrowser() ? false : 'no Edge/Chrome available for the rendered check';
const cambridge = cambridgeResponder();
const LONG_ANALYSIS = Array.from({ length: 80 }, (_, i) => `line ${i + 1} of a long generated analysis that has to stay inside its own box`).join('\n');

describe('combined palette (headless Edge)', { skip }, () => {
    let out;
    let requests;
    before(async () => {
        const run = await runInBrowser({
            module: 'src/features/selection-actions/testing/combinedGuiCases.js',
            stubTauri: true,
            respond: (url) =>
                url.startsWith('https://llm.one.test/')
                    ? { status: 200, body: { choices: [{ message: { content: LONG_ANALYSIS } }] } }
                    : cambridge(url),
            timeoutMs: 150000,
        });
        out = run.value;
        requests = run.requests;
    });

    test('ArrowRight walks the toolbar past the Tooltip-wrapped favorites editor to Dictionary and Speak original, wraps over the disabled Speak translation, ArrowLeft goes back', () => {
        assert.deepEqual(out.walk.slice(0, 9), [
            'Simplified Chinese',
            'English',
            'Japanese',
            'Spanish',
            'Edit favorite languages',
            'Dictionary',
            'Speak original',
            'Simplified Chinese',
            'English',
        ]);
        assert.equal(out.afterLeft, out.walk[7]);
    });

    test('Dictionary and an AI action show side by side, each from its own real request', () => {
        assert.equal(out.bothPanels, true);
        assert.equal(out.dictionarySource, 'Source: Cambridge Dictionary');
        assert.equal(requests.filter((r) => r.url.startsWith('https://dictionary.cambridge.org/')).length, 1);
        assert.equal(requests.filter((r) => r.url.startsWith('https://llm.one.test/')).length, 1);
    });

    test('a long multi-line AI answer scrolls inside its own bounded box and does not widen the page', () => {
        assert.equal(out.aiOutputBox.overflowY, 'auto');
        assert.ok(out.aiOutputBox.clientHeight <= 220, `AI output box is ${out.aiOutputBox.clientHeight}px`);
        assert.ok(out.aiOutputBox.scrollHeight > out.aiOutputBox.clientHeight, 'the long answer is scrollable, not cut off');
        assert.equal(out.dictionaryBox.overflowY, 'auto');
        assert.equal(out.dictionaryBox.maxHeight, '240px');
        assert.equal(out.horizontalOverflow, false);
    });
});
