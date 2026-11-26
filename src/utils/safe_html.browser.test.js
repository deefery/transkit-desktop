// Run with: node --test src/utils/safe_html.browser.test.js
// Rendered check in headless Edge/Chrome: real DOMParser + real React DOM render of the production
// sentence-HTML sanitizer. This is a browser check, NOT a native Tauri window check.
// Skipped without Edge/Chrome (set EDGE_PATH to choose the binary).
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { findBrowser, runInBrowser } from '../features/selection-actions/dictionary/testing/browserRunner.mjs';

const skip = findBrowser() ? false : 'no Edge/Chrome available for the rendered check';

const CASES = {
    'A <b>bold</b> word': '<span>A <b>bold</b> word</span>',
    '<b class="hl" onclick="window.__xss++">x</b>': '<span><b>x</b></span>',
    '<img src="x" onerror="window.__xss++">after': '<span>after</span>',
    '<script>window.__xss++</script>kept': '<span>kept</span>',
    '<a href="javascript:window.__xss++">link</a>': '<span>link</span>',
    '<svg><script>window.__xss++</script></svg>svg': '<span>svg</span>',
    '<iframe srcdoc="<script>parent.__xss++</script>"></iframe>f': '<span>f</span>',
    '<details open ontoggle="window.__xss++">d</details>': '<span>d</span>',
    '<style>body{display:none}</style>s': '<span>s</span>',
    'Tom &amp; Jerry &lt;3': '<span>Tom &amp; Jerry &lt;3</span>',
    'line<br>break': '<span>line<br>break</span>',
    '<p>unclosed <i>it': '<span>unclosed <i>it</i></span>',
};

describe('safeHtmlToReact in a real browser', { skip }, () => {
    let value;
    before(async () => {
        const run = await runInBrowser({
            module: 'src/utils/testing/safeHtmlCases.js',
            args: { encodedFragments: Object.keys(CASES).map(encodeURIComponent) },
            timeoutMs: 120000,
        });
        value = run.value;
    });

    test('no injected script or handler runs', () => {
        assert.equal(value.xss, 0);
    });

    test('control: the same payload through raw innerHTML does run (detector works)', () => {
        assert.ok(value.controlXss > 0, `expected the innerHTML control to fire, got ${value.controlXss}`);
    });

    for (const [fragment, expected] of Object.entries(CASES)) {
        test(`renders ${JSON.stringify(fragment)} safely`, () => {
            assert.equal(value.rendered[fragment], expected);
        });
    }
});
