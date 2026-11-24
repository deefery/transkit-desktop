// Run with: node --test src/features/selection-actions/panelKeys.test.js
// Keyboard and smart-default rules of the selection panel: what opens by itself for a selection,
// which key does what, what Esc closes.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createProductionLoader } from './testing/loadProduction.mjs';

let loader;
let K;
before(async () => {
    loader = await createProductionLoader();
    K = await loader.load('/src/features/selection-actions/panelKeys.js');
});
after(() => loader.close());

const key = (code, over = {}) => ({
    key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
    code,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...over,
});

describe('planAutoActions', () => {
    test('a word or short phrase opens the dictionary; nothing else is automatic', () => {
        for (const text of ['resilience', 'take off', '  "serendipity"  ', '你好']) {
            assert.deepEqual(
                { ...K.planAutoActions({ text }), kind: undefined },
                { kind: undefined, dictionary: true, focusAiSlot: false },
                text
            );
        }
    });

    test('a sentence focuses the AI slot and never opens the dictionary', () => {
        const plan = K.planAutoActions({ text: 'The quick brown fox jumps over the lazy dog.' });
        assert.equal(plan.kind, 'too-long');
        assert.equal(plan.dictionary, false);
        assert.equal(plan.focusAiSlot, true);
    });

    test('links, symbols and empty text only translate', () => {
        for (const text of ['https://example.com/a', '!!! ???', '12345', '', '   ', null, undefined]) {
            const plan = K.planAutoActions({ text });
            assert.equal(plan.dictionary, false, String(text));
            assert.equal(plan.focusAiSlot, false, String(text));
        }
    });

    test('the setting turns automatic dictionary off', () => {
        assert.equal(K.planAutoActions({ text: 'resilience', autoDictionary: false }).dictionary, false);
        assert.equal(K.planAutoActions({ text: 'resilience', autoDictionary: undefined }).dictionary, true);
        assert.equal(K.AUTO_DICTIONARY_CONFIG_KEY, 'selection_panel_auto_dictionary');
    });
});

describe('keyCommandFor', () => {
    test('single letters map to the panel actions', () => {
        assert.deepEqual(K.keyCommandFor(key('KeyS')), { type: 'speak-original' });
        assert.deepEqual(K.keyCommandFor(key('KeyD')), { type: 'dictionary' });
        assert.deepEqual(K.keyCommandFor(key('KeyA')), { type: 'ai-slot' });
        assert.deepEqual(K.keyCommandFor(key('KeyM')), { type: 'more' });
        assert.deepEqual(K.keyCommandFor(key('KeyC')), { type: 'copy-translation' });
        assert.equal(K.keyCommandFor(key('KeyX')), null);
    });

    test('letters follow the physical key, so other keyboard layouts work too', () => {
        assert.deepEqual(K.keyCommandFor(key('KeyD', { key: 'в' })), { type: 'dictionary' });
    });

    test('modified letters, repeats and IME composition are left alone', () => {
        assert.equal(K.keyCommandFor(key('KeyC', { ctrlKey: true })), null, 'Ctrl+C still copies the selection');
        assert.equal(K.keyCommandFor(key('KeyC', { metaKey: true })), null);
        assert.equal(K.keyCommandFor(key('KeyS', { shiftKey: true })), null);
        assert.equal(K.keyCommandFor(key('KeyS', { altKey: true })), null);
        assert.equal(K.keyCommandFor(key('KeyS', { repeat: true })), null);
        assert.equal(K.keyCommandFor(key('KeyS', { isComposing: true })), null);
        assert.equal(K.keyCommandFor(key('KeyS', { key: 'Process' })), null);
    });

    test('Alt+1..4 pick a favorite language; other digits do not', () => {
        assert.deepEqual(K.keyCommandFor(key('Digit1', { altKey: true })), { type: 'favorite-language', index: 0 });
        assert.deepEqual(K.keyCommandFor(key('Digit4', { altKey: true })), { type: 'favorite-language', index: 3 });
        assert.deepEqual(K.keyCommandFor(key('Numpad2', { altKey: true })), { type: 'favorite-language', index: 1 });
        assert.equal(K.keyCommandFor(key('Digit5', { altKey: true })), null);
        assert.equal(K.keyCommandFor(key('Digit1')), null);
        assert.equal(K.keyCommandFor(key('Digit1', { altKey: true, ctrlKey: true })), null);
        assert.equal(K.keyCommandFor(key('Digit1', { altKey: true, shiftKey: true })), null);
    });

    test('Esc is a command; nothing fires while the focus is in a field or a menu', () => {
        assert.deepEqual(K.keyCommandFor(key('Escape')), { type: 'escape' });
        for (const event of [key('Escape'), key('KeyS'), key('Digit1', { altKey: true })]) {
            assert.equal(K.keyCommandFor(event, { targetHandlesKeys: true }), null);
        }
        assert.equal(K.keyCommandFor(null), null);
    });
});

describe('isKeyHandlingTarget', () => {
    const element = (matches, extra = {}) => ({ closest: () => (matches ? {} : null), ...extra });
    test('text fields, editable content and open menus keep their keys', () => {
        assert.equal(K.isKeyHandlingTarget(element(true)), true);
        assert.equal(K.isKeyHandlingTarget(element(false, { isContentEditable: true })), true);
        assert.equal(K.isKeyHandlingTarget(element(false)), false);
        assert.equal(K.isKeyHandlingTarget(null), false);
        assert.equal(K.isKeyHandlingTarget({}), false);
    });
});

describe('escapeTarget', () => {
    test('closes one thing per press, innermost first, and hides the window last', () => {
        const all = { managingCustom: true, editingFavorites: true, moreOpen: true, aiOpen: true, dictionaryOpen: true };
        assert.equal(K.escapeTarget(all), 'custom-editor');
        assert.equal(K.escapeTarget({ ...all, managingCustom: false }), 'favorites-editor');
        assert.equal(K.escapeTarget({ moreOpen: true, aiOpen: true }), 'more');
        assert.equal(K.escapeTarget({ aiOpen: true }), 'ai');
        assert.equal(K.escapeTarget({ dictionaryOpen: true }), 'dictionary');
        assert.equal(K.escapeTarget({}), 'window');
        assert.equal(K.escapeTarget(), 'window');
    });

    test('with both result panels open, the expanded one closes first', () => {
        assert.equal(K.escapeTarget({ aiOpen: true, dictionaryOpen: true, expanded: 'ai' }), 'ai');
        assert.equal(K.escapeTarget({ aiOpen: true, dictionaryOpen: true, expanded: 'dictionary' }), 'dictionary');
    });
});

describe('withShortcut', () => {
    test('tooltips name the key', () => {
        assert.equal(K.withShortcut('Dictionary', 'dictionary'), 'Dictionary (D)');
        assert.equal(K.withShortcut('Copy', 'unknown'), 'Copy');
    });
});
