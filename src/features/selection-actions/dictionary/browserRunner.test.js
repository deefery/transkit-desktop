// Run with: node --test src/features/selection-actions/dictionary/browserRunner.test.js
// The browser runner inlines run() arguments into an inline <script> on the page. An argument that
// contains "</script>" (or "<!--") must reach run() unchanged instead of ending the script early.
// The escaping check always runs; the in-browser round trip needs Edge/Chrome and is skipped without one.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findBrowser, inlineScriptJson, runInBrowser } from './testing/browserRunner.mjs';

const HOSTILE = {
    close: 'a</script><script>window.__pwned = 1</script>b',
    upper: '</SCRIPT >',
    comment: '<!-- <script>',
    nested: ['</script>', { deeper: 'x</script>y' }],
};

test('inlineScriptJson leaves no "<" in the output and round-trips through JSON.parse', () => {
    const inlined = inlineScriptJson(HOSTILE);
    assert.equal(inlined.includes('<'), false);
    assert.deepEqual(JSON.parse(inlined), HOSTILE);
    // The inlined text is evaluated as a JavaScript literal on the page, not only parsed as JSON.
    assert.deepEqual(new Function(`return ${inlined};`)(), HOSTILE);
});

describe('browser runner arguments', { skip: findBrowser() ? false : 'no Edge/Chrome available' }, () => {
    test('arguments containing </script> reach run() unchanged', async () => {
        const run = await runInBrowser({
            module: 'src/features/selection-actions/dictionary/testing/echoCase.js',
            args: HOSTILE,
        });
        assert.deepEqual(run.value, HOSTILE);
    });
});
