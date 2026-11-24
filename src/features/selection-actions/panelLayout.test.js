// Run with: node --test src/features/selection-actions/panelLayout.test.js
// Layout rules of the result-first selection panel: which AI action fills the action row's slot
// and which result panel stays expanded when both are open.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createProductionLoader } from './testing/loadProduction.mjs';

let loader;
let L;
before(async () => {
    loader = await createProductionLoader();
    L = await loader.load('/src/features/selection-actions/panelLayout.js');
});
after(() => loader.close());

const item = (key, actionId) => ({ key, actionId, params: {}, enabled: true, active: false });
const ITEMS = [
    item('speak_original', 'speak_original'),
    item('dictionary', 'dictionary'),
    item('sentence_analysis', 'sentence_analysis'),
    item('improve_writing:natural', 'improve_writing'),
    item('improve_writing:concise', 'improve_writing'),
    item('custom_ai:c1', 'custom_ai'),
];

describe('pickAiSlotItem', () => {
    test('defaults to Sentence Analysis', () => {
        assert.equal(L.pickAiSlotItem(ITEMS).key, 'sentence_analysis');
        assert.equal(L.pickAiSlotItem(ITEMS, { setting: 'recent', recentKey: '' }).key, 'sentence_analysis');
    });

    test('shows the most recently run AI action, including a custom one', () => {
        assert.equal(L.pickAiSlotItem(ITEMS, { recentKey: 'improve_writing:concise' }).key, 'improve_writing:concise');
        assert.equal(L.pickAiSlotItem(ITEMS, { recentKey: 'custom_ai:c1' }).key, 'custom_ai:c1');
    });

    test('a pinned action wins over the recent one', () => {
        assert.equal(
            L.pickAiSlotItem(ITEMS, { setting: 'improve_writing:natural', recentKey: 'custom_ai:c1' }).key,
            'improve_writing:natural'
        );
    });

    test('a stale key (deleted custom action) or a non-AI key falls back to the default', () => {
        assert.equal(L.pickAiSlotItem(ITEMS, { recentKey: 'custom_ai:deleted' }).key, 'sentence_analysis');
        assert.equal(L.pickAiSlotItem(ITEMS, { recentKey: 'dictionary' }).key, 'sentence_analysis');
        assert.equal(L.pickAiSlotItem(ITEMS, { setting: 'speak_original' }).key, 'sentence_analysis');
    });

    test('without Sentence Analysis the first AI action is used; without AI actions there is none', () => {
        const noAnalysis = ITEMS.filter((x) => x.actionId !== 'sentence_analysis');
        assert.equal(L.pickAiSlotItem(noAnalysis).key, 'improve_writing:natural');
        assert.equal(L.pickAiSlotItem(ITEMS.slice(0, 2)), null);
        assert.equal(L.pickAiSlotItem(null), null);
    });
});

describe('expandedPanel', () => {
    test('the panel opened last is expanded', () => {
        assert.equal(L.expandedPanel({ dictionary: 1, ai: 2 }), 'ai');
        assert.equal(L.expandedPanel({ dictionary: 3, ai: 2 }), 'dictionary');
    });

    test('an explicit choice wins while that panel is open', () => {
        assert.equal(L.expandedPanel({ dictionary: 1, ai: 2 }, 'dictionary'), 'dictionary');
        assert.equal(L.expandedPanel({ ai: 2 }, 'dictionary'), 'ai');
    });

    test('a single open panel is expanded; none open gives null', () => {
        assert.equal(L.expandedPanel({ dictionary: 5 }), 'dictionary');
        assert.equal(L.expandedPanel({}), null);
        assert.equal(L.expandedPanel(null), null);
    });
});
