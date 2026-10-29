// Run with: node --test src/features/selection-actions/translationRecords.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createProductionLoader } from './testing/loadProduction.mjs';

let loader;
let r;

before(async () => {
    loader = await createProductionLoader();
    r = await loader.load('/src/features/selection-actions/translationRecords.js');
});
after(() => loader.close());

const request = (over = {}) => ({
    instanceKey: 'google',
    text: 'hello',
    sourceLanguage: 'auto',
    targetLanguage: 'ja',
    effectiveTargetLanguage: 'ja',
    detectLanguage: 'en',
    ...over,
});

function createRecords() {
    let records = {};
    const set = (fn) => {
        records = fn(records);
    };
    return { set, get: () => records };
}

describe('trackTranslation', () => {
    test('request-time snapshot, loading -> success with speakable text', () => {
        const rec = createRecords();
        const t = r.trackTranslation(rec.set, request());
        assert.equal(rec.get().google.status, 'loading');
        assert.equal(rec.get().google.speakText, '');
        t.success('こんにちは');
        assert.deepEqual(
            { ...rec.get().google, requestId: undefined },
            {
                requestId: undefined,
                instanceKey: 'google',
                text: 'hello',
                sourceLanguage: 'auto',
                targetLanguage: 'ja',
                effectiveTargetLanguage: 'ja',
                detectLanguage: 'en',
                status: 'success',
                speakText: 'こんにちは',
                error: '',
            }
        );
    });

    test('dictionary-style results speak their translation field only', () => {
        const rec = createRecords();
        r.trackTranslation(rec.set, request()).success({ translation: ' 你好 ', explanations: [{ trait: 'n.' }] });
        assert.equal(rec.get().google.speakText, '你好');
        r.trackTranslation(rec.set, request()).success({ explanations: [] });
        assert.equal(rec.get().google.speakText, '');
    });

    test('a newer request replaces the older one; late results of the older request are ignored', () => {
        const rec = createRecords();
        const older = r.trackTranslation(rec.set, request({ targetLanguage: 'ja', effectiveTargetLanguage: 'ja' }));
        const newer = r.trackTranslation(rec.set, request({ targetLanguage: 'en', effectiveTargetLanguage: 'en' }));
        newer.success('EN');
        older.success('JA (late)');
        older.failure(new Error('late error'));
        assert.equal(rec.get().google.speakText, 'EN');
        assert.equal(rec.get().google.targetLanguage, 'en');
        assert.equal(rec.get().google.status, 'success');
    });

    test('records are per provider instance and failures keep the message', () => {
        const rec = createRecords();
        const a = r.trackTranslation(rec.set, request({ instanceKey: 'google' }));
        const b = r.trackTranslation(rec.set, request({ instanceKey: 'bing@x1' }));
        a.success('A');
        b.failure(new Error('bing down'));
        assert.equal(rec.get().google.status, 'success');
        assert.equal(rec.get()['bing@x1'].status, 'error');
        assert.equal(rec.get()['bing@x1'].error, 'Error: bing down');
        assert.equal(rec.get()['bing@x1'].speakText, '');
    });

    test('clearing drops the record and later results of the cleared request are ignored', () => {
        const rec = createRecords();
        const t = r.trackTranslation(rec.set, request());
        r.clearTranslationRecord(rec.set, 'google');
        assert.deepEqual(rec.get(), {});
        t.success('late');
        assert.deepEqual(rec.get(), {});
        const before = rec.get();
        r.clearTranslationRecord(rec.set, 'never-existed');
        assert.equal(rec.get(), before, 'no state churn for unknown keys');
    });

    test('odd inputs never throw', () => {
        const rec = createRecords();
        const t = r.trackTranslation(
            rec.set,
            request({ effectiveTargetLanguage: undefined, detectLanguage: undefined })
        );
        assert.equal(rec.get().google.effectiveTargetLanguage, 'ja');
        assert.equal(rec.get().google.detectLanguage, '');
        for (const value of [null, undefined, 0, false, [], {}, Symbol.iterator.toString()]) {
            assert.doesNotThrow(() => t.success(value));
        }
        assert.doesNotThrow(() => t.failure(undefined));
    });
});

describe('production wiring guards (the mounted component cannot run without a DOM)', () => {
    // sources of upstream files use CRLF; normalize before matching
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const target = read('../../window/Translate/components/TargetArea/index.jsx');
    const source = read('../../window/Translate/components/SourceArea/index.jsx');
    const translateWindow = read('../../window/Translate/index.jsx');
    const count = (text, needle) => text.split(needle).length - 1;

    test('TargetArea publishes every translation request outcome in both provider paths', () => {
        assert.equal(count(target, 'const tracking = track('), 2, 'plugin + built-in request');
        assert.equal(count(target, 'tracking.success(v)'), 2);
        assert.equal(count(target, 'tracking.failure(e)'), 2);
        assert.equal(count(target, "track(targetLanguage).failure('Language not supported')"), 2);
    });

    test('TargetArea re-runs the translation on the retranslate signal and clears its record on unmount / translate-back', () => {
        assert.match(target, /clipboardMonitor,\n\s+retranslateNonce,\n\s+\]\);/);
        assert.match(
            target,
            /return \(\) => clearTranslationRecord\(setTranslationRecords, currentTranslateServiceInstanceKey\)/
        );
        const back = target.slice(target.indexOf('translate_back'));
        assert.match(
            back.slice(0, back.indexOf('let newTargetLanguage = sourceLanguage')),
            /clearTranslationRecord\(setTranslationRecords/
        );
    });

    test('Source and Target Speak go through the shared playback owner with intents (no direct speak(data) after synthesis)', () => {
        for (const [name, text] of [
            ['SourceArea', source],
            ['TargetArea', target],
        ]) {
            assert.match(text, /await speak\.speak\(/, name);
            assert.doesNotMatch(text, /\n\s+speak\(data\);/, name);
        }
        // pronunciation audio from the provider keeps the legacy toggle call
        assert.match(target, /speak\(pronunciation\['voice'\]\)/);
    });

    test('the palette is mounted only for the selection window, next to the language selector', () => {
        assert.match(
            translateWindow,
            /windowType === '\[SELECTION_TRANSLATE\]' && serviceInstanceConfigMap !== null && \(\s*<SelectionActionPalette/
        );
        const palette = translateWindow.indexOf('<SelectionActionPalette');
        assert.ok(palette > translateWindow.indexOf('<LanguageArea />'));
    });
});
