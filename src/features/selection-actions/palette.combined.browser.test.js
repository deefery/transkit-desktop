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

    test('the action row is one row: speak original, dictionary, the AI slot, more', () => {
        assert.deepEqual(out.actionRow.labels, ['Speak original', 'Dictionary', 'Analyze sentence', 'More']);
        assert.equal(out.actionRow.rows, 1);
        assert.equal(out.actionRow.overflowsRow, false);
    });

    test('at 320px the action row is icon-only (labels kept as accessible names) and still one row', () => {
        assert.ok(out.narrowRow.width < 340, `row width ${out.narrowRow.width}px`);
        assert.deepEqual(out.narrowRow.labels, ['Speak original', 'Dictionary', 'Analyze sentence', 'More']);
        assert.deepEqual(out.narrowRow.visibleText, ['', '', '', '']);
        assert.equal(out.narrowRow.rows, 1);
        assert.equal(out.narrowRow.overflowsRow, false);
    });

    test('ArrowRight walks the action row and wraps around, ArrowLeft goes back', () => {
        assert.deepEqual(out.walk.slice(0, 9), [
            'Speak original',
            'Dictionary',
            'Analyze sentence',
            'More',
            'Speak original',
            'Dictionary',
            'Analyze sentence',
            'More',
            'Speak original',
        ]);
        assert.equal(out.afterLeft, out.walk[7]);
    });

    test('with Dictionary and an AI action both open, the newer one is expanded and the other folds to a line', () => {
        assert.equal(out.afterBoth.aiExpanded, true);
        assert.equal(out.afterBoth.dictionaryCollapsed, true);
        assert.match(out.afterBoth.collapsedText, /Dictionary.*resilience/);
        assert.equal(out.afterExpand.dictionaryExpanded, true);
        assert.equal(out.afterExpand.aiCollapsed, true);
        assert.equal(out.slotLabel, 'Analyze sentence');
    });

    test('Dictionary and the AI action each come from their own real request', () => {
        assert.equal(out.dictionarySource, 'Source: Cambridge Dictionary');
        // The automatic lookup plus the one reopened with D; Analyze sentence by click, then by A.
        assert.equal(requests.filter((r) => r.url.startsWith('https://dictionary.cambridge.org/')).length, 2);
        assert.equal(requests.filter((r) => r.url.startsWith('https://llm.one.test/')).length, 2);
    });

    test('a selected word opens the dictionary by itself', () => {
        assert.equal(out.autoDictionary, true);
    });

    test('Esc closes the expanded panel, then the other, then hides the window; D and A reopen', () => {
        const k = out.keys;
        assert.deepEqual(k.escape1, { dictionary: false, dictionaryCollapsed: false, ai: true, aiCollapsed: false });
        assert.deepEqual(k.afterD, { dictionary: true, dictionaryCollapsed: false, ai: false, aiCollapsed: true });
        assert.deepEqual(k.escape2, { dictionary: false, dictionaryCollapsed: false, ai: true, aiCollapsed: false });
        assert.deepEqual(k.escape3, { dictionary: false, dictionaryCollapsed: false, ai: false, aiCollapsed: false });
        assert.equal(k.hidesBefore, 0);
        assert.equal(k.hidesAfter, 1);
        // The window-closing Esc handler of App.jsx never sees an Esc the panel handled.
        assert.equal(k.documentEscapes, 0);
        assert.equal(k.afterA.ai, true);
    });

    test('M opens More with the focus inside it and Esc closes it', () => {
        assert.equal(out.keys.moreOpen, true);
        assert.equal(out.keys.focusInMore, true);
        assert.equal(out.keys.moreAfterEscape, false);
    });

    test('C copies the translation; Ctrl+C is left alone', () => {
        assert.equal(out.keys.clipboardAfterCtrlC, null);
        assert.equal(out.keys.clipboard, '韧性');
        assert.equal(out.keys.copiedNotice, 'Translation copied');
    });

    test('keys typed in a text field are not shortcuts', () => {
        assert.equal(out.keys.inFieldDictionary, false);
        assert.equal(out.keys.inFieldHides, 1);
    });

    test('tooltips name the shortcut keys', () => {
        assert.deepEqual(out.keys.titles, ['Speak original (S)', 'Dictionary (D)', 'Analyze sentence (A)', 'More (M)']);
    });

    test('Alt+2 switches to the second favorite language', () => {
        assert.equal(out.keys.targetAfterAlt2, 'en');
    });

    test('a sentence puts the focus on the AI slot and opens no dictionary', () => {
        assert.equal(out.keys.sentenceFocus, 'ai-slot');
        assert.equal(out.keys.sentenceDictionary, false);
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
