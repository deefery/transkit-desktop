// Run with: node --test src/features/selection-actions/writeBack.browser.test.js
// Rendered check (headless Chrome/Edge) of the "Replace original" button of the AI result panel,
// with the native write-back replaced by a fake. Not a native Windows/Tauri window check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { findBrowser, runInBrowser } from './dictionary/testing/browserRunner.mjs';

const skip = findBrowser() ? false : 'no Edge/Chrome available for the rendered check';

describe('Replace original (headless browser)', { skip }, () => {
    let out;
    before(async () => {
        const run = await runInBrowser({
            module: 'src/features/selection-actions/testing/writeBackCases.js',
            stubTauri: true,
            timeoutMs: 120000,
        });
        out = run.value;
    });

    test('a plain-text rewrite with an original window offers "Replace original"', () => {
        assert.equal(out.offered.button, 'Replace original');
        assert.match(out.offered.title, /selected text in the app it came from/);
    });

    test('it sends the original selection and the rewrite, then says what happened', () => {
        assert.deepEqual(out.done.calls, [
            ['can', 'a sentence that is unclear'],
            ['replace', 'a sentence that is unclear', 'A clearer sentence.'],
        ]);
        assert.equal(out.done.key, 'done');
        assert.match(out.done.status, /Pasted over the original selection/);
        assert.equal(out.done.buttonAfter, false, 'no second paste over the replaced text');
    });

    test('a refusal leaves the text on the clipboard and says why', () => {
        assert.equal(out.failed.key, 'copied_instead');
        assert.equal(
            out.failed.status,
            'Could not replace the original (the window was closed). The text is on the clipboard: paste it with Ctrl+V.'
        );
    });

    test('not offered without an original window, for Markdown analysis, while loading, or without write-back', () => {
        assert.deepEqual(out.noSource, { button: false, calls: 1 });
        assert.deepEqual(out.markdown, { button: false, calls: 0 });
        assert.deepEqual(out.loading, { button: false, calls: 0 });
        assert.deepEqual(out.withoutWriteBack, { button: false });
    });
});

describe('native write-back guards', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const rust = read('../../../src-tauri/src/write_back.rs');
    const window = read('../../../src-tauri/src/window.rs');
    const main = read('../../../src-tauri/src/main.rs');

    test('the frontend names text only; the target window is the one captured at selection time', () => {
        assert.match(rust, /pub fn replace_selection\(original: String, text: String\)/);
        assert.match(rust, /pub fn can_replace_selection\(original: String\)/);
        assert.doesNotMatch(rust, /fn replace_selection\([^)]*(window|hwnd)/i);
    });

    test('the selection hotkey captures the source before reading the selection; other text sources clear it', () => {
        const selection = window.slice(window.indexOf('pub fn selection_translate()'));
        const capture = selection.indexOf('write_back::foreground_window()');
        assert.ok(capture > 0 && capture < selection.indexOf('get_text();'), 'captured before get_text');
        assert.match(selection, /write_back::remember\(source_window, &text\)/);
        for (const fn of ['pub fn input_translate()', 'pub fn text_translate(text: String)', 'pub fn image_translate()']) {
            const body = window.slice(window.indexOf(fn), window.indexOf(fn) + 120);
            assert.match(body, /write_back::clear\(\);/, fn);
        }
    });

    test('both commands are registered', () => {
        assert.match(main, /write_back::can_replace_selection,/);
        assert.match(main, /write_back::replace_selection,/);
    });
});
