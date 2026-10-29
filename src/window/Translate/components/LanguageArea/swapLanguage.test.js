// Run with: node --test src/window/Translate/components/LanguageArea/swapLanguage.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { swapLanguage } from './swapLanguage.js';

const base = {
    sourceLanguage: 'auto',
    targetLanguage: 'zh_cn',
    detectLanguage: '',
    translateTargetLanguage: 'zh_cn',
    translateSecondLanguage: 'en',
};

test('auto + empty detection: non-secondary target switches to the configured second language', () => {
    assert.deepEqual(swapLanguage(base), { sourceLanguage: 'auto', targetLanguage: 'en' });
});

test('auto + empty detection: secondary target toggles back to the primary target language', () => {
    assert.deepEqual(swapLanguage({ ...base, targetLanguage: 'en' }), {
        sourceLanguage: 'auto',
        targetLanguage: 'zh_cn',
    });
});

test('auto + empty detection: uses a non-default configured second language', () => {
    const config = { ...base, translateSecondLanguage: 'ja' };
    assert.deepEqual(swapLanguage(config), { sourceLanguage: 'auto', targetLanguage: 'ja' });
    assert.deepEqual(swapLanguage({ ...config, targetLanguage: 'ja' }), {
        sourceLanguage: 'auto',
        targetLanguage: 'zh_cn',
    });
});

test('auto + empty detection: an unrelated manually chosen target switches to the second language', () => {
    assert.deepEqual(swapLanguage({ ...base, targetLanguage: 'fr' }), { sourceLanguage: 'auto', targetLanguage: 'en' });
});

test('auto + detected language: switches to the detected language, then back to the primary target', () => {
    const detected = { ...base, detectLanguage: 'ja' };
    assert.deepEqual(swapLanguage(detected), { sourceLanguage: 'auto', targetLanguage: 'ja' });
    assert.deepEqual(swapLanguage({ ...detected, targetLanguage: 'ja' }), {
        sourceLanguage: 'auto',
        targetLanguage: 'zh_cn',
    });
});

test('non-auto source: swaps source and target', () => {
    assert.deepEqual(swapLanguage({ ...base, sourceLanguage: 'ja', targetLanguage: 'en' }), {
        sourceLanguage: 'en',
        targetLanguage: 'ja',
    });
});
