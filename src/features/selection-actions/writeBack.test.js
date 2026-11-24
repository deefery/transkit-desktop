// Run with: node --test src/features/selection-actions/writeBack.test.js
// Write back (W1): when "Replace original" is offered, how the native outcome is read, what is said.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createProductionLoader } from './testing/loadProduction.mjs';

let loader;
let W;
before(async () => {
    loader = await createProductionLoader();
    W = await loader.load('/src/features/selection-actions/writeBack.js');
});
after(() => loader.close());

const result = (over = {}) => ({
    status: 'success',
    outputKind: 'text',
    output: 'A better sentence.',
    text: 'a sentence that is worse',
    ...over,
});

describe('offersWriteBack', () => {
    test('finished plain-text rewrites of a selection are offered', () => {
        assert.equal(W.offersWriteBack(result()), true);
    });

    test('Markdown analysis, unfinished or empty results and missing originals are not', () => {
        assert.equal(W.offersWriteBack(result({ outputKind: 'markdown' })), false);
        assert.equal(W.offersWriteBack(result({ status: 'loading' })), false);
        assert.equal(W.offersWriteBack(result({ status: 'error' })), false);
        assert.equal(W.offersWriteBack(result({ output: '   ' })), false);
        assert.equal(W.offersWriteBack(result({ text: '' })), false);
        assert.equal(W.offersWriteBack(null), false);
    });
});

describe('createWriteBack', () => {
    test('passes the original and the text to the native commands', async () => {
        const calls = [];
        const wb = W.createWriteBack({
            invoke: async (cmd, args) => {
                calls.push([cmd, args]);
                return cmd === 'can_replace_selection' ? true : null;
            },
        });
        assert.equal(await wb.canReplace('orig'), true);
        assert.deepEqual(await wb.replace('orig', 'new'), { ok: true });
        assert.deepEqual(calls, [
            ['can_replace_selection', { original: 'orig' }],
            ['replace_selection', { original: 'orig', text: 'new' }],
        ]);
    });

    test('native refusals keep their code; anything unexpected is a paste failure', async () => {
        const failing = (error) => W.createWriteBack({ invoke: async () => Promise.reject(error) });
        assert.deepEqual(await failing('source-closed').replace('o', 't'), { ok: false, code: 'source-closed' });
        assert.deepEqual(await failing('focus-failed').replace('o', 't'), { ok: false, code: 'focus-failed' });
        assert.deepEqual(await failing(new Error('boom')).replace('o', 't'), { ok: false, code: 'paste-failed' });
        assert.deepEqual(await failing('weird').replace('o', 't'), { ok: false, code: 'paste-failed' });
        assert.equal(await failing('x').canReplace('o'), false);
        const throwing = W.createWriteBack({
            invoke: () => {
                throw new Error('no ipc');
            },
        });
        assert.equal(await throwing.canReplace('o'), false);
        assert.deepEqual(await throwing.replace('o', 't'), { ok: false, code: 'paste-failed' });
        const truthy = W.createWriteBack({ invoke: async () => 'yes' });
        assert.equal(await truthy.canReplace('o'), false, 'only a real true counts');
    });
});

describe('writeBackMessage', () => {
    test('success, copied-instead with a reason, and clipboard failure', () => {
        assert.deepEqual(W.writeBackMessage({ ok: true }), { key: 'done' });
        assert.deepEqual(W.writeBackMessage({ ok: false, code: 'source-closed' }), {
            key: 'copied_instead',
            reason: 'source-closed',
        });
        assert.deepEqual(W.writeBackMessage({ ok: false, code: 'nope' }), { key: 'copied_instead', reason: 'paste-failed' });
        assert.deepEqual(W.writeBackMessage({ ok: false, code: 'clipboard-failed' }), { key: 'clipboard_failed' });
        assert.equal(W.writeBackMessage(null), null);
    });
});
