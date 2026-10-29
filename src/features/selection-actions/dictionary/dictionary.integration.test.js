// Run with: node --test src/features/selection-actions/dictionary/dictionary.integration.test.js
//
// Production path for the Dictionary action: real atoms, registry, context derivation, runtime
// dispatch, dictionary controller/source selection/mappers, active-TTS helper and the shared
// playback owner. Injected boundaries only: the dictionary adapters' network calls (controlled by
// the test, answering with the shapes the real adapters return - the real Cambridge parser runs
// in cambridge.adapter.test.js) and the TTS service / audio.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { createScenario, deferred, loadProduction, tick } from '../testing/harness.js';

let p;
let dict;
let s;
let cambridge;
let bing;

before(async () => {
    p = await loadProduction();
    const [controller, sources, result, cambridgeInfo, bingInfo] = await Promise.all([
        p.loader.load('/src/features/selection-actions/dictionary/controller.js'),
        p.loader.load('/src/features/selection-actions/dictionary/sources.js'),
        p.loader.load('/src/features/selection-actions/dictionary/result.js'),
        p.loader.load('/src/services/translate/cambridge_dict/info.ts'),
        p.loader.load('/src/services/translate/bing_dict/info.ts'),
    ]);
    dict = { ...controller, ...sources, ...result, cambridgeLanguage: cambridgeInfo.Language, bingLanguage: bingInfo.Language };
});
after(async () => {
    await p.loader.close();
});

// An adapter double: the real service Language enum, a call log and a response the test completes.
function adapter(Language, method) {
    const calls = [];
    return {
        Language,
        calls,
        [method]: (text, from, to, options) => {
            const d = deferred();
            calls.push({ text, from, to, options, ...d });
            return d.promise;
        },
    };
}

const entryPage = (headword, extra = {}) => ({
    page: 'entry',
    match: 'exact',
    entries: [
        {
            headword,
            kind: 'word',
            partOfSpeech: 'noun',
            pronunciations: [{ region: 'uk', ipa: '/x/' }],
            senses: [{ partOfSpeech: 'noun', definition: `definition of ${headword}`, meanings: [`${headword}-zh`], examples: [] }],
            ...extra,
        },
    ],
});

beforeEach(() => {
    cambridge = adapter(dict.cambridgeLanguage, 'lookup');
    bing = adapter(dict.bingLanguage, 'translate');
    s = createScenario(p, {
        dictionaryServices: { cambridge_dict: cambridge, bing_dict: bing },
        dictionarySourcePreference: '',
    });
    s.set('sourceText', 'resilience');
});
afterEach(() => s.cleanup());

const state = () => s.runtime.dictionary.getState(s.runtime.getContext());
const lookup = (params) => s.runtime.dispatch('dictionary', params);

describe('Dictionary action in the registry', () => {
    test('is listed once, enabled for a selection and disabled (with a reason) for blank text', () => {
        const items = s.runtime.getItems().filter((i) => i.actionId === 'dictionary');
        assert.equal(items.length, 1);
        assert.equal(items[0].enabled, true);
        s.set('sourceText', '   ');
        const blank = s.runtime.getItems().find((i) => i.actionId === 'dictionary');
        assert.equal(blank.enabled, false);
        assert.equal(blank.code, 'empty-selection');
    });

    test('is rejected outside the selection window and never calls a source', async () => {
        s.set('windowType', '[INPUT_TRANSLATE]');
        const outcome = await lookup();
        assert.equal(outcome.ok, false);
        assert.equal(outcome.code, 'wrong-window');
        assert.equal(cambridge.calls.length, 0);
    });
});

describe('word and phrase lookups through the default source', () => {
    test('a word: the default keyless Cambridge source is called with the adapter language values and the result is attributed', async () => {
        const outcome = lookup();
        await tick();
        assert.equal(state().status, 'loading');
        assert.equal(cambridge.calls.length, 1);
        assert.deepEqual(
            [cambridge.calls[0].text, cambridge.calls[0].from, cambridge.calls[0].to],
            ['resilience', 'english', 'chinese-simplified']
        );
        cambridge.calls[0].resolve(entryPage('resilience'));
        assert.equal((await outcome).status, 'completed');
        const st = state();
        assert.equal(st.status, 'success');
        assert.equal(st.sourceId, 'cambridge_dict');
        assert.equal(st.result.sourceId, 'cambridge_dict');
        assert.equal(st.result.headwordMatch, 'exact');
        assert.equal(st.result.entries[0].senses[0].meanings[0], 'resilience-zh');
    });

    test('a short phrase: surrounding quotes/punctuation and whitespace are stripped; the phrase is looked up whole', async () => {
        s.set('sourceText', '  “take   off.”\n');
        const outcome = lookup();
        await tick();
        assert.equal(cambridge.calls[0].text, 'take off');
        cambridge.calls[0].resolve(entryPage('take off', { kind: 'phrasal-verb', partOfSpeech: 'phrasal verb', pronunciations: [] }));
        await outcome;
        assert.equal(state().result.entries[0].kind, 'phrasal-verb');
        assert.deepEqual(state().result.entries[0].pronunciations, []);
    });

    test('Traditional Chinese target uses the traditional dataset value', async () => {
        s.set('targetLanguage', 'zh_tw');
        const outcome = lookup();
        await tick();
        assert.equal(cambridge.calls[0].to, 'chinese-traditional');
        cambridge.calls[0].resolve(entryPage('resilience'));
        await outcome;
    });
});

describe('honest non-success states (no provider call where none is possible)', () => {
    const errorOf = () => state().error;

    test('a sentence is too long: Sentence Analysis is suggested, nothing is looked up or invented', async () => {
        s.set('sourceText', 'This is a full sentence about resilience in teams.');
        const outcome = await lookup();
        assert.equal(outcome.ok, true);
        assert.equal(state().status, 'error');
        assert.equal(errorOf().code, 'too-long');
        assert.equal(errorOf().suggestSentenceAnalysis, true);
        assert.equal(state().result, undefined);
        assert.equal(cambridge.calls.length + bing.calls.length, 0);
    });

    test('text without letters is unsupported input', async () => {
        for (const text of ['12345', '!!!', 'https://example.com/a', 'a@b.co']) {
            s.set('sourceText', text);
            await lookup();
            assert.equal(errorOf().code, 'unsupported-input', text);
        }
        assert.equal(cambridge.calls.length, 0);
    });

    test('a target language the source cannot serve is unsupported-language, without a request', async () => {
        s.set('targetLanguage', 'ja');
        await lookup();
        assert.equal(errorOf().code, 'unsupported-language');
        assert.equal(cambridge.calls.length, 0);
    });

    test('a source language the source cannot serve (detected French) is unsupported-language', async () => {
        s.set('detectLanguage', 'fr');
        await lookup();
        assert.equal(errorOf().code, 'unsupported-language');
        assert.equal(cambridge.calls.length, 0);
    });

    test('source and target language that are the same are unsupported-language', async () => {
        s.set('targetLanguage', 'en');
        await lookup();
        assert.equal(errorOf().code, 'unsupported-language');
    });

    test('absent entry, unreadable response and provider failure are distinct states', async () => {
        const codes = [];
        for (const outcome of [
            { page: 'not-found', match: 'none', entries: [] },
            { page: 'unrecognized', match: 'none', entries: [] },
            new Error('Http Request Error\nHttp Status: 503'),
            'plain string',
            { page: 'entry', match: 'none', entries: [] },
            { page: 'entry', match: 'exact', entries: [{ headword: 'x', senses: 'bad' }] },
            null,
        ]) {
            const running = lookup();
            await tick();
            const call = cambridge.calls.at(-1);
            outcome instanceof Error ? call.reject(outcome) : call.resolve(outcome);
            await running;
            codes.push(errorOf().code);
        }
        assert.deepEqual(codes, [
            'not-found',
            'unsupported-response',
            'provider-failed',
            'unsupported-response',
            'not-found',
            'unsupported-response',
            'unsupported-response',
        ]);
    });

    test('provider failure keeps the status detail, and Retry (the same request again) can succeed', async () => {
        const first = lookup();
        await tick();
        cambridge.calls[0].reject(new Error('Http Request Error\nHttp Status: 503'));
        await first;
        assert.equal(errorOf().code, 'provider-failed');
        assert.match(errorOf().detail, /Http Status: 503/);
        assert.equal(state().result, undefined);

        const retry = lookup({ sourceKey: state().sourceKey });
        await tick();
        assert.equal(state().status, 'loading');
        assert.equal(cambridge.calls.length, 2);
        cambridge.calls[1].resolve(entryPage('resilience'));
        await retry;
        assert.equal(state().status, 'success');
    });
});

describe('stale and rapid calls', () => {
    test('rapid selection change with out-of-order completion: the current selection wins, the old one never shows', async () => {
        s.set('sourceText', 'alpha');
        const a = lookup();
        await tick();
        s.set('sourceText', 'beta');
        assert.equal(state().status, 'idle', 'the old lookup is dropped as soon as the selection changes');
        const b = lookup();
        await tick();
        assert.deepEqual(cambridge.calls.map((c) => c.text), ['alpha', 'beta']);

        cambridge.calls[1].resolve(entryPage('beta'));
        assert.equal((await b).status, 'completed');
        assert.equal(state().result.entries[0].headword, 'beta');

        cambridge.calls[0].resolve(entryPage('alpha'));
        assert.equal((await a).status, 'stale');
        assert.equal(state().result.entries[0].headword, 'beta', 'late completion of the old lookup is ignored');
        assert.equal(s.runtime.getContext().text, 'beta');
    });

    test('a failure of the old lookup arriving late does not replace the current result either', async () => {
        s.set('sourceText', 'alpha');
        const a = lookup();
        await tick();
        s.set('sourceText', 'beta');
        const b = lookup();
        await tick();
        cambridge.calls[1].resolve(entryPage('beta'));
        await b;
        cambridge.calls[0].reject(new Error('boom'));
        assert.equal((await a).status, 'stale');
        assert.equal(state().status, 'success');
    });

    test('target language change while pending drops the result', async () => {
        const running = lookup();
        await tick();
        s.set('targetLanguage', 'zh_tw');
        cambridge.calls[0].resolve(entryPage('resilience'));
        assert.equal((await running).status, 'stale');
        assert.equal(state().status, 'idle');
    });

    test('the same request while one is running is not sent twice', async () => {
        const first = lookup();
        await tick();
        const second = await lookup();
        assert.equal(second.status, 'unchanged');
        assert.equal(cambridge.calls.length, 1);
        cambridge.calls[0].resolve(entryPage('resilience'));
        await first;
        assert.equal(state().status, 'success');
    });

    test('a repeat after completion looks up again (refresh)', async () => {
        const first = lookup();
        await tick();
        cambridge.calls[0].resolve(entryPage('resilience'));
        await first;
        const again = lookup();
        await tick();
        assert.equal(cambridge.calls.length, 2);
        cambridge.calls[1].resolve(entryPage('resilience'));
        await again;
    });

    test('unknown source language is detected on demand; a selection change during detection starts no request', async () => {
        s.set('detectLanguage', '');
        const running = lookup();
        s.set('sourceText', 'other');
        assert.equal((await running).status, 'stale');
        assert.equal(cambridge.calls.length, 0);
        assert.equal(s.detectCalls.length, 1, 'detection was asked for');
    });

    test('detection that finds English proceeds to the lookup', async () => {
        s.set('detectLanguage', '');
        s.setDetectResult('en');
        const running = lookup();
        await tick();
        assert.equal(cambridge.calls.length, 1);
        cambridge.calls[0].resolve(entryPage('resilience'));
        await running;
        assert.equal(state().status, 'success');
    });

    test('dismiss and dispose drop pending lookups', async () => {
        const first = lookup();
        await tick();
        s.runtime.dictionary.dismiss();
        cambridge.calls[0].resolve(entryPage('resilience'));
        assert.equal((await first).status, 'stale');
        assert.equal(state().status, 'idle');

        const second = lookup();
        await tick();
        s.dispose();
        cambridge.calls[1].resolve(entryPage('resilience'));
        assert.equal((await second).status, 'stale');
        assert.equal(s.store.get(dict.dictionaryStateAtom).status, 'idle');
    });
});

describe('configurable source selection (existing translate service instances)', () => {
    const configure = (list, extra = {}) => {
        s.env.translateServiceInstanceList = list;
        Object.assign(s.env, extra);
    };

    test('with no dictionary service configured the keyless Cambridge built-in is the only candidate', () => {
        const { candidates, selected } = s.runtime.dictionary.sources();
        assert.deepEqual(candidates.map((c) => c.key), ['cambridge_dict']);
        assert.equal(selected.key, 'cambridge_dict');
        assert.equal(candidates[0].configured, false);
    });

    test('configured dictionary instances come first in the user order; Cambridge is still offered', () => {
        configure(['google', 'bing_dict@b1', 'ecdict', 'plugin.x@1']);
        const { candidates, selected } = s.runtime.dictionary.sources();
        assert.deepEqual(candidates.map((c) => c.key), ['bing_dict@b1', 'ecdict', 'cambridge_dict']);
        assert.equal(selected.key, 'bing_dict@b1');
    });

    test('the persisted preference wins when it is still configured, otherwise the first candidate is used', () => {
        configure(['bing_dict@b1', 'cambridge_dict@c1'], { dictionarySourcePreference: 'cambridge_dict@c1' });
        assert.equal(s.runtime.dictionary.sources().selected.key, 'cambridge_dict@c1');
        s.env.dictionarySourcePreference = 'ecdict';
        assert.equal(s.runtime.dictionary.sources().selected.key, 'bing_dict@b1');
        s.env.dictionarySourcePreference = 42;
        assert.equal(s.runtime.dictionary.sources().selected.key, 'bing_dict@b1');
    });

    test('the selected instance is called with its own instance config', async () => {
        configure(['bing_dict@b1'], { serviceInstanceConfigMap: { ...s.env.serviceInstanceConfigMap, 'bing_dict@b1': { instanceName: 'My Bing' } } });
        const running = lookup();
        await tick();
        assert.equal(bing.calls.length, 1);
        assert.equal(cambridge.calls.length, 0);
        assert.deepEqual(bing.calls[0].options.config, { instanceName: 'My Bing' });
        assert.deepEqual([bing.calls[0].from, bing.calls[0].to], ['en-us', 'zh-cn']);
        bing.calls[0].resolve({
            pronunciations: [{ region: 'US', symbol: '[x]', voice: 'ignored' }],
            explanations: [{ trait: 'n.', explains: ['复原力', '弹性'] }],
            associations: ['resiliences'],
            sentence: [{ source: '<b>unsafe</b>', target: '' }],
        });
        await running;
        const result = state().result;
        assert.equal(state().sourceId, 'bing_dict');
        assert.deepEqual(result.entries[0].pronunciations, [{ region: 'US', ipa: '[x]' }]);
        assert.deepEqual(result.entries[0].senses[0], { partOfSpeech: 'n.', definition: null, meanings: ['复原力', '弹性'], examples: [] });
        assert.deepEqual(result.associations, ['resiliences']);
        assert.equal(JSON.stringify(result).includes('unsafe'), false, 'unverified HTML sentence fields are not mapped');
    });

    test('an explicit source request overrides the preference (panel source switch)', async () => {
        configure(['bing_dict@b1', 'cambridge_dict'], { dictionarySourcePreference: 'bing_dict@b1' });
        const running = lookup({ sourceKey: 'cambridge_dict' });
        await tick();
        assert.equal(bing.calls.length, 0);
        assert.equal(cambridge.calls.length, 1);
        cambridge.calls[0].resolve(entryPage('resilience'));
        await running;
        assert.equal(state().sourceKey, 'cambridge_dict');
    });

    test('Bing/ECDICT are single-word sources: a phrase is refused as unsupported input before any request', async () => {
        configure(['bing_dict@b1']);
        s.set('sourceText', 'take off');
        await lookup();
        assert.equal(state().error.code, 'unsupported-input');
        assert.equal(bing.calls.length, 0);
    });

    test("Bing's 'not yet included' and network strings keep their meaning; unknown shapes are unsupported", async () => {
        configure(['bing_dict@b1']);
        const outcomes = [
            () => bing.calls.at(-1).reject('Words not yet included: resilience'),
            () => bing.calls.at(-1).reject('Http Request Error\nHttp Status: 403\n{}'),
            () => bing.calls.at(-1).resolve({ unexpected: true }),
            () => bing.calls.at(-1).resolve({ pronunciations: [], explanations: [], associations: [] }),
        ];
        const codes = [];
        for (const settle of outcomes) {
            const running = lookup();
            await tick();
            settle();
            await running;
            codes.push(state().error.code);
        }
        assert.deepEqual(codes, ['not-found', 'provider-failed', 'unsupported-response', 'not-found']);
    });

    test('removing the source from the configuration drops its shown result', async () => {
        configure(['bing_dict@b1']);
        const running = lookup();
        await tick();
        bing.calls[0].resolve({ pronunciations: [], explanations: [{ trait: 'n.', explains: ['x'] }], associations: [] });
        await running;
        assert.equal(state().status, 'success');
        configure(['google']);
        s.runtime.reconcile();
        assert.equal(state().status, 'idle');
    });

    test('a missing adapter module is a no-source error, not a crash', async () => {
        s.env.dictionaryServices = {};
        await lookup();
        assert.equal(state().error.code, 'no-source');
    });
});

describe('pronunciation delegates to the current TTS controller', () => {
    async function successFor(text) {
        s.set('sourceText', text);
        const running = lookup();
        await tick();
        cambridge.calls.at(-1).resolve(entryPage(text));
        await running;
    }

    test('Pronounce speaks the selected text through the active TTS instance, voice and playback owner', async () => {
        await successFor('resilience');
        const outcome = s.runtime.dispatch('speak_original');
        await tick();
        assert.equal(s.edge.calls.length, 1);
        assert.equal(s.edge.calls[0].text, 'resilience');
        assert.equal(s.edge.calls[0].voice, 'edge-en');
        assert.equal(s.edge.calls[0].config.rate, '+10%', 'provider rate config is passed through, not rewritten');
        s.edge.calls[0].resolve(new Uint8Array([1, 2]));
        await tick();
        s.audio.decodes.at(-1).finish();
        assert.equal((await outcome).status, 'playing');
        assert.equal(s.runtime.getActiveSpeech().kind, 'original');
        assert.equal(state().status, 'success', 'speaking does not disturb the shown dictionary result');
    });

    test('pronunciation of an old selection is never played after the selection changed', async () => {
        await successFor('resilience');
        const outcome = s.runtime.dispatch('speak_original');
        await tick();
        s.set('sourceText', 'another');
        s.edge.calls[0].resolve(new Uint8Array([1]));
        await tick();
        await outcome;
        assert.equal(s.audio.sources.some((x) => x.started), false);
        assert.equal(s.runtime.getActiveSpeech(), null);
    });

    test('no TTS configured: Pronounce is rejected visibly while the dictionary result stays', async () => {
        await successFor('resilience');
        s.env.ttsServiceList = [];
        s.env.ttsActiveService = '';
        const outcome = await s.runtime.dispatch('speak_original');
        assert.equal(outcome.ok, false);
        assert.equal(outcome.code, 'tts-unconfigured');
        assert.equal(state().status, 'success');
    });
});
