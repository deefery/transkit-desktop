// Run with: node --test src/features/selection-actions/selectionActions.combined.test.js
//
// T-SA-005 integration of the composed palette: Translate/favorites, Speak Original/Translation,
// Dictionary, Sentence Analysis, Improve presets and Custom AI Actions in ONE runtime.
//
// Production path: real atoms, registry (with the AI definitions), context derivation, runtime
// dispatch, dictionary controller + source selection + mappers, shared AI runner, REAL services/ai
// modules and their real HTTP request, custom-action persistence, TTS helper and the shared
// playback owner. Controlled external boundaries only: the dictionary adapters' network calls, the
// AI services' HTTP (tauri `fetch`), the TTS service doubles and the Web Audio context. None of
// them is a product substitute; these tests do not claim any live provider behaviour.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { createScenario, deferred, loadProduction, mountTranslateStandIn, tick } from './testing/harness.js';

let p;
let dict;
let custom;
let serviceInstance;
let aiActions;
before(async () => {
    p = await loadProduction();
    const [controller, sources, cambridgeInfo, bingInfo] = await Promise.all([
        p.loader.load('/src/features/selection-actions/dictionary/controller.js'),
        p.loader.load('/src/features/selection-actions/dictionary/sources.js'),
        p.loader.load('/src/services/translate/cambridge_dict/info.ts'),
        p.loader.load('/src/services/translate/bing_dict/info.ts'),
    ]);
    dict = { ...controller, ...sources, cambridgeLanguage: cambridgeInfo.Language, bingLanguage: bingInfo.Language };
    custom = await p.loader.load('/src/features/selection-actions/customActions.js');
    serviceInstance = await p.loader.load('/src/utils/service_instance.ts');
    aiActions = await p.loader.load('/src/features/selection-actions/aiActions.js');
});
after(() => p.loader.close());

const A1 = 'openai_compat_ai@a1';
const A2 = 'openai_compat_ai@a2';
const SECRET1 = 'sk-test-SECRET-111111';
const SECRET2 = 'sk-test-SECRET-222222';
const WORD = 'resilience';

// Remote endpoint of the AI services: every request waits for the test to answer it.
function installHttp() {
    const requests = [];
    globalThis.__transkitTestHttp = (url, options) => {
        const d = deferred();
        requests.push({ url, method: options.method, headers: options.headers, body: options.body?.payload, ...d });
        return d.promise;
    };
    return requests;
}
const openAiReply = (content) => ({ ok: true, status: 200, data: { choices: [{ message: { content } }] } });

// A dictionary adapter double: the real service Language enum, a call log, answers on demand.
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
const entryPage = (headword) => ({
    page: 'entry',
    match: 'exact',
    entries: [
        {
            headword,
            kind: 'word',
            partOfSpeech: 'noun',
            pronunciations: [{ region: 'uk', ipa: '/x/' }],
            senses: [{ partOfSpeech: 'noun', definition: `definition of ${headword}`, meanings: [`${headword}-zh`], examples: [] }],
        },
    ],
});

let s = null;
let requests = null;
let cambridge = null;
let bing = null;
let api = null;

const resolveAi = (instanceKey) =>
    p.resolveAiSelection({
        aiServiceList: s.env.aiServiceList,
        aiInstanceKey: instanceKey,
        aiServices: p.aiServices,
        isPluginInstance: serviceInstance.whetherPluginService,
        serviceNameOf: serviceInstance.getServiceName,
    });

// What useConfig hands the hook after a custom-actions change: the value now in the config store.
async function syncCustom() {
    s.env.customActions = structuredClone(await p.configStore.get(custom.CUSTOM_ACTIONS_CONFIG_KEY));
    s.runtime.reconcile();
}

async function setup(overrides = {}, { text = WORD, target = 'zh_cn' } = {}) {
    s?.cleanup();
    p.configStore.data.clear();
    await p.configStore.set(A1, { instanceName: 'Work GPT', requestPath: 'https://llm.one.test/v1/chat/completions', apiKey: SECRET1, model: 'gpt-one' });
    await p.configStore.set(A2, { instanceName: 'Home GPT', requestPath: 'https://llm.two.test/v1/chat/completions', apiKey: SECRET2, model: 'gpt-two' });
    cambridge = adapter(dict.cambridgeLanguage, 'lookup');
    bing = adapter(dict.bingLanguage, 'translate');
    s = createScenario(p, {
        aiServiceList: [A1, A2],
        aiInstanceKey: A1,
        dictionaryServices: { cambridge_dict: cambridge, bing_dict: bing },
        dictionarySourcePreference: '',
        customActions: undefined,
        ...overrides,
    });
    s.set('sourceText', text);
    s.set('targetLanguage', target);
    requests = installHttp();
    api = custom.createCustomActionsApi({ getStore: () => p.configStore, emit: async () => {}, resolveAi });
    return s;
}

async function define(overrides = {}) {
    const made = await api.create({
        name: 'Explain',
        icon: 'idea',
        instanceKey: A2,
        instruction: 'Explain the selected text in simple words.',
        ...overrides,
    });
    assert.equal(made.ok, true, JSON.stringify(made));
    await syncCustom();
    return made.action;
}

beforeEach(async () => {
    await setup();
});
afterEach(() => {
    s?.cleanup();
    s = null;
    delete globalThis.__transkitTestHttp;
});

const dictState = () => s.runtime.dictionary.getState(s.runtime.getContext());
const aiResult = () => s.runtime.getContext().ai.result;
const lookup = (params) => s.runtime.dispatch('dictionary', params);
const items = () => s.runtime.getItems();

// Drive one Speak action through synthesis and decode to "playing".
async function speakToPlaying(actionId, service, bytes = [1, 2, 3]) {
    const outcome = s.runtime.dispatch(actionId);
    await tick();
    const call = service.calls.at(-1);
    call.resolve(new Uint8Array(bytes));
    await tick();
    s.audio.decodes.at(-1).finish();
    return { outcome: await outcome, call };
}

describe('one registry, every accepted action', () => {
    test('registered ids, groups and palette entries of the composed runtime', async () => {
        const action = await define();
        const registry = p.createSelectionActionRegistry(p.aiActionDefinitions);
        assert.deepEqual(
            registry.list().map((x) => `${x.order}:${x.id}`),
            [
                '10:translate',
                '15:dictionary',
                '20:speak_original',
                '30:speak_translation',
                '40:sentence_analysis',
                '50:improve_writing',
                '60:custom_ai',
            ]
        );
        const count = (id) => items().filter((i) => i.actionId === id).length;
        assert.equal(count('translate'), 4, 'four default favorites');
        assert.equal(count('dictionary'), 1);
        assert.equal(count('speak_original'), 1);
        assert.equal(count('speak_translation'), 1);
        assert.equal(count('sentence_analysis'), 1);
        assert.equal(count('improve_writing'), 5, 'five Improve presets share one definition');
        assert.deepEqual(
            items().filter((i) => i.actionId === 'improve_writing').map((i) => i.params.preset),
            ['natural', 'concise', 'professional', 'casual', 'correct_grammar']
        );
        assert.deepEqual(
            items().filter((i) => i.actionId === 'custom_ai').map((i) => i.params.customId),
            [action.id]
        );
        // keys are unique across the whole palette
        const keys = items().map((i) => i.key);
        assert.equal(new Set(keys).size, keys.length);
        // grouping order of the palette
        assert.deepEqual([...new Set(items().map((i) => i.group))], ['translate', 'dictionary', 'speak', 'ai', 'custom']);
    });

    test('a registered definition without a combined dispatch case fails this test (no action is left uncovered)', () => {
        const covered = new Set([
            'translate',
            'dictionary',
            'speak_original',
            'speak_translation',
            'sentence_analysis',
            'improve_writing',
            'custom_ai',
        ]);
        const registered = p.createSelectionActionRegistry(p.aiActionDefinitions).list().map((x) => x.id);
        assert.deepEqual([...covered].sort(), [...registered].sort());
        assert.equal(aiActions.aiActionDefinitions.length, 3);
    });

    test('one session dispatches every action through the real adapters; results coexist and are attributed', async () => {
        const action = await define();
        const stop = mountTranslateStandIn(p, s.store, {
            instanceKey: 'google',
            provider: async (r) => `T(${r.targetLanguage}):${r.text}`,
        });

        // dictionary (real default Cambridge source, adapter boundary controlled)
        const dictRun = lookup();
        await tick();
        assert.equal(cambridge.calls.length, 1);
        assert.deepEqual([cambridge.calls[0].text, cambridge.calls[0].from, cambridge.calls[0].to], [WORD, 'english', 'chinese-simplified']);
        cambridge.calls[0].resolve(entryPage(WORD));
        assert.equal((await dictRun).status, 'completed');
        assert.equal(dictState().sourceId, 'cambridge_dict');

        // sentence analysis on the palette's AI instance A1
        let run = s.runtime.dispatch('sentence_analysis');
        await tick();
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'https://llm.one.test/v1/chat/completions');
        assert.equal(requests[0].headers.Authorization, `Bearer ${SECRET1}`);
        requests[0].resolve(openAiReply('chunks: resilience'));
        assert.equal((await run).status, 'success');
        assert.equal(aiResult().actionId, 'sentence_analysis');
        assert.equal(dictState().status, 'success', 'dictionary result is untouched by the AI action');

        // an Improve preset replaces the AI panel only
        run = s.runtime.dispatch('improve_writing', { preset: 'concise' });
        await tick();
        assert.equal(requests.length, 2);
        requests[1].resolve(openAiReply('resilience'));
        await run;
        assert.equal(aiResult().preset, 'concise');
        assert.equal(dictState().status, 'success');

        // a custom action runs on its OWN instance (A2), not the palette's A1
        run = s.runtime.dispatch('custom_ai', { customId: action.id, revision: action.revision });
        await tick();
        assert.equal(requests.length, 3);
        assert.equal(requests[2].url, 'https://llm.two.test/v1/chat/completions');
        assert.equal(requests[2].headers.Authorization, `Bearer ${SECRET2}`);
        assert.ok(requests[2].body.messages[0].content.endsWith('Instruction:\nExplain the selected text in simple words.'));
        assert.equal(requests[2].body.messages[1].content, WORD);
        requests[2].resolve(openAiReply('simple words'));
        await run;
        assert.equal(aiResult().customId, action.id);
        assert.equal(aiResult().instanceKey, A2);
        assert.equal(dictState().status, 'success');

        // Translate through the existing provider path, then Speak Original / Translation
        assert.equal((await s.runtime.dispatch('translate', { language: 'zh_cn' })).status, 'started');
        await tick();
        assert.equal(s.runtime.getContext().translation.speakText, `T(zh_cn):${WORD}`);
        const original = await speakToPlaying('speak_original', s.edge);
        assert.equal(original.call.text, WORD);
        assert.equal(original.call.voice, 'edge-en');
        assert.equal(s.runtime.getActiveSpeech().kind, 'original');
        const translated = await speakToPlaying('speak_translation', s.edge);
        assert.equal(translated.call.text, `T(zh_cn):${WORD}`);
        assert.equal(translated.call.voice, 'edge-zh');
        assert.equal(s.runtime.getActiveSpeech().kind, 'translation');
        assert.equal(s.audio.sources.filter((x) => x.started && !x.stopped).length, 1, 'exactly one audible source: one owner');
        // none of the speech touched the AI or dictionary panels
        assert.equal(dictState().status, 'success');
        assert.equal(aiResult().customId, action.id);
        assert.equal(requests.length, 3);
        assert.equal(cambridge.calls.length, 1);
        stop();
    });
});

describe('a changed selection or target obsoletes every panel and speech at once', () => {
    async function everythingActive() {
        mountTranslateStandIn(p, s.store, { instanceKey: 'google', provider: async (r) => `T:${r.text}` });
        const d = lookup();
        await tick();
        cambridge.calls[0].resolve(entryPage(WORD));
        await d;
        const a = s.runtime.dispatch('sentence_analysis');
        await tick();
        requests[0].resolve(openAiReply('analysis'));
        await a;
        s.publishSuccess('T:resilience');
        await speakToPlaying('speak_original', s.edge);
        assert.equal(dictState().status, 'success');
        assert.ok(aiResult());
        assert.ok(s.runtime.getActiveSpeech());
    }

    test('new selection text', async () => {
        await everythingActive();
        s.set('sourceText', 'another');
        assert.equal(dictState().status, 'idle');
        assert.equal(aiResult(), null);
        assert.equal(s.runtime.getActiveSpeech(), null);
        assert.ok(s.audio.sources.every((x) => !x.started || x.stopped));
    });

    test('new target language (a favorite is chosen): panels go; Speak Original (not target dependent) keeps playing, Speak Translation stops', async () => {
        await everythingActive();
        await s.runtime.dispatch('translate', { language: 'ja' });
        assert.equal(dictState().status, 'idle');
        assert.equal(aiResult(), null);
        assert.equal(s.runtime.getActiveSpeech().kind, 'original', 'the original text and its language did not change');
        await speakToPlaying('speak_translation', s.edge);
        assert.equal(s.runtime.getActiveSpeech().kind, 'translation');
        await s.runtime.dispatch('translate', { language: 'es' });
        assert.equal(s.runtime.getActiveSpeech(), null, 'a translation of another target is never spoken on');
        assert.equal(s.audio.sources.filter((x) => x.started && !x.stopped).length, 0, 'nothing audible remains');
    });

    test('a different source language', async () => {
        await everythingActive();
        s.set('sourceLanguage', 'fr');
        assert.equal(dictState().status, 'idle');
        assert.equal(aiResult(), null);
    });

    test('switching out of the selection window', async () => {
        await everythingActive();
        s.set('windowType', '[INPUT_TRANSLATE]');
        assert.equal(dictState().status, 'idle');
        assert.equal(aiResult(), null);
        // inherited foundation behaviour: palette speech is bound to text / languages / TTS instance,
        // not to the window type, so a playback that is already running simply finishes.
        assert.equal(s.runtime.getActiveSpeech().kind, 'original');
        assert.ok(items().every((i) => !i.enabled), 'no action is available outside the selection window');
    });
});

describe('in-flight dictionary + AI + speech requests complete out of order', () => {
    test('selection changes while all three are pending: late completions (reverse order) publish and play nothing', async () => {
        const d = lookup();
        const a = s.runtime.dispatch('sentence_analysis');
        const sp = s.runtime.dispatch('speak_original');
        await tick();
        assert.equal(cambridge.calls.length, 1);
        assert.equal(requests.length, 1);
        assert.equal(s.edge.calls.length, 1);
        s.set('sourceText', 'second selection');
        s.edge.calls[0].resolve(new Uint8Array([9]));
        await tick();
        requests[0].resolve(openAiReply('OLD analysis'));
        await tick();
        cambridge.calls[0].resolve(entryPage(WORD));
        await Promise.all([d, a, sp]);
        assert.equal(dictState().status, 'idle');
        assert.equal(aiResult(), null);
        assert.equal(s.audio.sources.some((x) => x.started), false);
        assert.equal(s.runtime.getActiveSpeech(), null);
    });

    test('the new selection result wins when the OLD completions arrive after it', async () => {
        const d1 = lookup();
        const a1 = s.runtime.dispatch('sentence_analysis');
        await tick();
        s.set('sourceText', 'fresh');
        const d2 = lookup();
        const a2 = s.runtime.dispatch('sentence_analysis');
        await tick();
        assert.equal(cambridge.calls.length, 2);
        assert.equal(requests.length, 2);
        cambridge.calls[1].resolve(entryPage('fresh'));
        requests[1].resolve(openAiReply('NEW analysis'));
        await Promise.all([d2, a2]);
        cambridge.calls[0].resolve(entryPage(WORD));
        requests[0].resolve(openAiReply('OLD analysis'));
        await Promise.all([d1, a1]);
        assert.equal(dictState().result.entries[0].headword, 'fresh');
        assert.equal(aiResult().output, 'NEW analysis');
    });

    test('unmounting the palette drops late dictionary, AI and speech completions', async () => {
        const d = lookup();
        const a = s.runtime.dispatch('sentence_analysis');
        const sp = s.runtime.dispatch('speak_original');
        await tick();
        s.dispose();
        s.edge.calls[0].resolve(new Uint8Array([1]));
        await tick();
        cambridge.calls[0].resolve(entryPage(WORD));
        requests[0].resolve(openAiReply('late'));
        await Promise.all([d, a, sp]);
        assert.equal(s.store.get(dict.dictionaryStateAtom).status, 'idle');
        assert.equal(s.store.get(p.aiResultAtom), null);
        assert.equal(s.audio.sources.some((x) => x.started), false);
    });
});

describe('repeated invocation does not duplicate requests', () => {
    test('dictionary: a repeat while loading is unchanged and reaches the source once', async () => {
        const first = lookup();
        await tick();
        const second = await lookup();
        assert.equal(second.status, 'unchanged');
        assert.equal(cambridge.calls.length, 1);
        cambridge.calls[0].resolve(entryPage(WORD));
        await first;
    });

    test('AI + custom: repeats are unchanged while loading and after success; an error is retried', async () => {
        const action = await define();
        const params = { customId: action.id, revision: action.revision };
        const first = s.runtime.dispatch('custom_ai', params);
        await tick();
        assert.equal((await s.runtime.dispatch('custom_ai', params)).status, 'unchanged');
        assert.equal(requests.length, 1);
        requests[0].reject(new Error(`boom ${SECRET2}`));
        assert.equal((await first).code, 'ai-failed');
        // after an error a repeat is a fresh request
        const retry = s.runtime.dispatch('custom_ai', params);
        await tick();
        assert.equal(requests.length, 2);
        requests[1].resolve(openAiReply('ok'));
        assert.equal((await retry).status, 'success');
        assert.equal((await s.runtime.dispatch('custom_ai', params)).status, 'unchanged');
        assert.equal(requests.length, 2);
    });

    test('Dictionary + AI in flight together: neither request cancels or duplicates the other', async () => {
        const d = lookup();
        const a = s.runtime.dispatch('improve_writing', { preset: 'natural' });
        await tick();
        assert.equal(cambridge.calls.length, 1);
        assert.equal(requests.length, 1);
        assert.equal(dictState().status, 'loading');
        assert.equal(aiResult().status, 'loading');
        requests[0].resolve(openAiReply('smooth'));
        cambridge.calls[0].resolve(entryPage(WORD));
        await Promise.all([d, a]);
        assert.equal(dictState().status, 'success');
        assert.equal(aiResult().status, 'success');
    });

    test('repeated Speak: same intent while playing stops, a different intent replaces; AI/dictionary stay', async () => {
        s.publishSuccess('T:resilience');
        const d = lookup();
        await tick();
        cambridge.calls[0].resolve(entryPage(WORD));
        await d;
        await speakToPlaying('speak_original', s.edge);
        const stopped = await s.runtime.dispatch('speak_original');
        assert.equal(stopped.status, 'stopped');
        assert.equal(s.runtime.getActiveSpeech(), null);
        await speakToPlaying('speak_original', s.edge);
        await speakToPlaying('speak_translation', s.edge);
        assert.equal(s.runtime.getActiveSpeech().kind, 'translation');
        assert.equal(dictState().status, 'success');
    });
});

describe('configuration edits while work is in flight', () => {
    test('deleting the custom action drops its pending result; the dictionary lookup in parallel survives', async () => {
        const action = await define();
        const d = lookup();
        const run = s.runtime.dispatch('custom_ai', { customId: action.id, revision: action.revision });
        await tick();
        const deleted = await api.remove(action.id, action.revision);
        assert.equal(deleted.ok, true, JSON.stringify(deleted));
        await syncCustom();
        requests[0].resolve(openAiReply('late'));
        cambridge.calls[0].resolve(entryPage(WORD));
        await Promise.all([run, d]);
        assert.equal(aiResult(), null);
        assert.equal(dictState().status, 'success');
        assert.equal(items().filter((i) => i.actionId === 'custom_ai').length, 0);
    });

    test('editing the custom action (new revision) invalidates the old run and the old palette entry cannot run', async () => {
        const action = await define();
        const run = s.runtime.dispatch('custom_ai', { customId: action.id, revision: action.revision });
        await tick();
        const edited = await api.update(action.id, action.revision, {
            name: 'Explain',
            icon: 'idea',
            instanceKey: A2,
            instruction: 'A different instruction.',
        });
        assert.equal(edited.ok, true, JSON.stringify(edited));
        await syncCustom();
        requests[0].resolve(openAiReply('old instruction answer'));
        await run;
        assert.equal(aiResult(), null);
        const stale = await s.runtime.dispatch('custom_ai', { customId: action.id, revision: action.revision });
        assert.equal(stale.ok, false);
        assert.equal(stale.code, 'custom-action-changed');
        assert.equal(requests.length, 1, 'the stale entry produced no request');
    });

    test('removing the AI instance in use drops the pending result and disables AI actions; Dictionary keeps working', async () => {
        const run = s.runtime.dispatch('sentence_analysis');
        await tick();
        s.env.aiServiceList = [A2];
        s.runtime.reconcile();
        requests[0].resolve(openAiReply('late'));
        await run;
        assert.equal(aiResult(), null);
        // the persisted choice A1 no longer exists: honest, not silently replaced
        const outcome = await s.runtime.dispatch('sentence_analysis');
        assert.equal(outcome.ok, false);
        assert.equal(requests.length, 1);
        const d = lookup();
        await tick();
        cambridge.calls[0].resolve(entryPage(WORD));
        assert.equal((await d).status, 'completed');
        assert.equal(dictState().status, 'success');
    });

    test('removing the chosen dictionary source in flight drops its result; AI result is unaffected', async () => {
        s.env.translateServiceInstanceList = ['google', 'bing_dict@d1'];
        s.env.dictionarySourcePreference = 'bing_dict@d1';
        s.set('sourceLanguage', 'en');
        s.set('targetLanguage', 'zh_cn');
        const a = s.runtime.dispatch('sentence_analysis');
        const d = lookup({ sourceKey: 'bing_dict@d1' });
        await tick();
        assert.equal(bing.calls.length, 1);
        s.env.translateServiceInstanceList = ['google'];
        s.runtime.reconcile();
        bing.calls[0].resolve({ word: WORD, pronunciations: [], explanations: [] });
        requests[0].resolve(openAiReply('analysis'));
        await Promise.all([a, d]);
        assert.equal(dictState().status, 'idle');
        assert.equal(aiResult().output, 'analysis');
    });

    test('unknown / malformed data is safe: missing services, broken custom store, unknown action and params', async () => {
        for (const bad of ['garbage', 42, null, { version: 99, actions: 'x' }, { version: 1, actions: [null, 5, 'x', {}] }]) {
            s.env.customActions = bad;
            s.runtime.reconcile();
            assert.doesNotThrow(() => items());
            assert.equal(items().filter((i) => i.actionId === 'custom_ai').length, 0);
            assert.equal(items().filter((i) => i.actionId === 'improve_writing').length, 5);
        }
        assert.equal((await s.runtime.dispatch('no_such_action')).code, 'unknown-action');
        assert.equal((await s.runtime.dispatch('improve_writing', { preset: 'bogus' })).ok, false);
        assert.equal((await s.runtime.dispatch('translate', { language: 'zz_nope' })).code, 'invalid-language');
        assert.equal((await s.runtime.dispatch('custom_ai', { customId: 'ca_missing', revision: 1 })).ok, false);
        assert.equal((await s.runtime.dispatch('custom_ai')).ok, false);
        assert.equal(requests.length, 0);
        assert.equal(cambridge.calls.length, 0);

        // missing dictionary services module: provider failure state, not a throw, AI still works
        s.env.dictionaryServices = undefined;
        assert.equal((await lookup()).status, 'completed');
        assert.equal(dictState().status, 'error');
        s.env.aiServices = undefined;
        assert.equal((await s.runtime.dispatch('sentence_analysis')).ok, false);
    });
});

describe('selections: empty, illegal, multilingual, long', () => {
    test('blank / non-string selections: every selection action is disabled and nothing is requested', async () => {
        for (const value of ['', '   \n\t ', null, undefined, 42, { a: 1 }, ['x']]) {
            s.set('sourceText', value);
            assert.ok(items().every((i) => !i.enabled), `all disabled for ${JSON.stringify(value)}`);
            for (const [id, params] of [
                ['dictionary'],
                ['sentence_analysis'],
                ['improve_writing', { preset: 'natural' }],
                ['speak_original'],
                ['translate', { language: 'en' }],
            ]) {
                assert.equal((await s.runtime.dispatch(id, params)).ok, false);
            }
        }
        assert.equal(cambridge.calls.length + requests.length + s.edge.calls.length, 0);
    });

    test('too long for AI / dictionary: honest refusals, no provider request; Dictionary points at Sentence Analysis', async () => {
        s.set('sourceText', 'word '.repeat(2500));
        const ai = await s.runtime.dispatch('sentence_analysis');
        assert.equal(ai.code, 'selection-too-long');
        assert.equal(items().find((i) => i.actionId === 'improve_writing').code, 'selection-too-long');
        assert.equal((await lookup()).status, 'completed');
        assert.equal(dictState().status, 'error');
        assert.equal(dictState().error.suggestSentenceAnalysis, true);
        assert.equal(cambridge.calls.length + requests.length, 0);
    });

    test('multilingual selection: CJK is unsupported by the English dictionary (honest, no call) but goes to AI verbatim', async () => {
        const text = 'こんにちは、世界 🌏 مرحبا';
        s.set('detectLanguage', 'ja');
        s.set('sourceText', text);
        s.set('targetLanguage', 'en');
        await lookup();
        assert.equal(dictState().status, 'error');
        assert.equal(dictState().error.code, 'unsupported-language');
        assert.equal(cambridge.calls.length, 0);
        const run = s.runtime.dispatch('improve_writing', { preset: 'natural' });
        await tick();
        assert.equal(requests[0].body.messages[1].content, text);
        requests[0].resolve(openAiReply('<script>alert(1)</script> **ok**'));
        await run;
        // provider output stays plain text in state (the palette renders it as text / markdown, never HTML)
        assert.equal(aiResult().output, '<script>alert(1)</script> **ok**');
    });

    test('speak with the original language still unknown detects it; dictionary uses the same detection', async () => {
        s.set('detectLanguage', null);
        s.setDetectResult('en');
        const d = lookup();
        await tick();
        assert.deepEqual(s.detectCalls, [WORD]);
        assert.equal(cambridge.calls[0].from, 'english');
        cambridge.calls[0].resolve(entryPage(WORD));
        await d;
        assert.equal(dictState().status, 'success');
    });
});

describe('failure states stay separate, recoverable and free of secrets', () => {
    test('AI failure does not disturb Dictionary or speech; the provider error is redacted and bounded', async () => {
        const d = lookup();
        await tick();
        cambridge.calls[0].resolve(entryPage(WORD));
        await d;
        await speakToPlaying('speak_original', s.edge);
        const run = s.runtime.dispatch('sentence_analysis');
        await tick();
        requests[0].reject(new Error(`401 invalid key ${SECRET1} ${'x'.repeat(1000)}`));
        const outcome = await run;
        assert.equal(outcome.code, 'ai-failed');
        assert.equal(aiResult().status, 'error');
        assert.ok(!JSON.stringify(aiResult()).includes(SECRET1));
        assert.ok(aiResult().error.length <= 303);
        assert.equal(dictState().status, 'success');
        assert.equal(s.runtime.getActiveSpeech().kind, 'original');
        // recoverable: the same action runs again
        const retry = s.runtime.dispatch('sentence_analysis');
        await tick();
        assert.equal(requests.length, 2);
        requests[1].resolve(openAiReply('fine'));
        assert.equal((await retry).status, 'success');
    });

    test('Dictionary provider failure and not-found are distinct and leave AI actions usable', async () => {
        let d = lookup();
        await tick();
        cambridge.calls[0].reject(new Error('network down'));
        await d;
        assert.equal(dictState().error.code, 'provider-failed');
        d = lookup();
        await tick();
        assert.equal(cambridge.calls.length, 2, 'an error is retried, not cached');
        cambridge.calls[1].resolve({ page: 'not-found', match: 'none', entries: [] });
        await d;
        assert.equal(dictState().error.code, 'not-found');
        const run = s.runtime.dispatch('sentence_analysis');
        await tick();
        requests[0].resolve(openAiReply('ok'));
        assert.equal((await run).status, 'success');
    });

    test('no secret from any AI instance reaches the palette items, the custom definitions or the shown state', async () => {
        const action = await define();
        const run = s.runtime.dispatch('custom_ai', { customId: action.id, revision: action.revision });
        await tick();
        requests[0].resolve(openAiReply('ok'));
        await run;
        const shown = JSON.stringify({
            items: items(),
            ai: aiResult(),
            dictionary: dictState(),
            stored: await p.configStore.get(custom.CUSTOM_ACTIONS_CONFIG_KEY),
        });
        assert.ok(!shown.includes(SECRET1) && !shown.includes(SECRET2));
        assert.ok(!shown.includes('llm.one.test') && !shown.includes('llm.two.test'));
    });

    test('no TTS configured: Speak is refused visibly while Dictionary and AI results stay', async () => {
        const d = lookup();
        await tick();
        cambridge.calls[0].resolve(entryPage(WORD));
        await d;
        s.env.ttsServiceList = [];
        s.env.ttsActiveService = '';
        const outcome = await s.runtime.dispatch('speak_original');
        assert.equal(outcome.code, 'tts-unconfigured');
        assert.equal(dictState().status, 'success');
    });

    test('active TTS instance is a non-first / non-default one: pronunciation, original and translation all use it with its voice', async () => {
        s.env.ttsActiveService = 'google_tts@abc';
        s.publishSuccess('T:resilience');
        const orig = await speakToPlaying('speak_original', s.google);
        assert.equal(orig.call.voice, 'g-en');
        assert.equal(orig.call.config.voice, 'cfg-google');
        const tr = await speakToPlaying('speak_translation', s.google);
        assert.equal(tr.call.voice, 'g-zh');
        assert.equal(s.edge.calls.length, 0, 'the inactive instance is never called');
    });
});
