// Run with: node --test src/features/selection-actions/selectionActions.language.test.js
//
// C-AI-001 closure: the built-in AI instructions state the declared / detected language of the
// selection, so an AI result (pending or shown) is only current for the language context it was
// requested with - not just for the same text, target language and AI instance. Production path:
// runtime.dispatch -> shared runner -> the real services/ai request; only the HTTP boundary is a fixture.
import assert from 'node:assert/strict';
import { afterEach, after, before, beforeEach, describe, test } from 'node:test';
import { createScenario, deferred, loadProduction, tick } from './testing/harness.js';

let p;
before(async () => {
    p = await loadProduction();
});
after(() => p.loader.close());

const KEY = 'openai_compat_ai@a1';
const TEXT = 'Bonjour tout le monde, comment allez-vous ?';
const openAiReply = (content) => ({ ok: true, status: 200, data: { choices: [{ message: { content } }] } });

let scenario = null;
let requests = null;

beforeEach(async () => {
    p.configStore.data.clear();
    await p.configStore.set(KEY, { instanceName: 'Work GPT', requestPath: 'https://llm.example.test/v1/chat', model: 'm' });
    scenario = createScenario(p, { aiServiceList: [KEY], aiInstanceKey: KEY });
    scenario.set('sourceText', TEXT);
    scenario.set('sourceLanguage', 'auto');
    scenario.set('detectLanguage', 'fr');
    scenario.set('targetLanguage', 'zh_cn');
    requests = [];
    globalThis.__transkitTestHttp = (url, options) => {
        const d = deferred();
        requests.push({ url, body: options.body?.payload, ...d });
        return d.promise;
    };
});
afterEach(() => {
    scenario?.cleanup();
    scenario = null;
    delete globalThis.__transkitTestHttp;
});

const result = () => scenario.store.get(p.aiResultAtom);
const prompt = (index) => requests[index].body.messages[0].content;
const dispatchers = {
    sentence_analysis: () => scenario.runtime.dispatch('sentence_analysis', {}),
    'improve_writing/natural': () => scenario.runtime.dispatch('improve_writing', { preset: 'natural' }),
};

for (const [name, dispatch] of Object.entries(dispatchers)) {
    describe(`${name}: source / original language is part of the request identity`, () => {
        test('a source-language-only change while pending drops the old answer; a fresh run sends the new instruction', async () => {
            const pending = dispatch();
            await tick();
            assert.match(prompt(0), /appears to be French \(automatic detection, it may be wrong\)/);
            // text, target language and AI instance are unchanged; only the declared source changes
            scenario.set('sourceLanguage', 'ja');
            assert.equal(result(), null, 'the old interpretation is withdrawn at once');
            requests[0].resolve(openAiReply('answer for the automatic interpretation'));
            assert.deepEqual(await pending, { ok: true, status: 'superseded' });
            assert.equal(result(), null, 'never published under the new language context');

            const fresh = dispatch();
            await tick();
            assert.equal(requests.length, 2, 'a new request is sent, not "unchanged"');
            assert.match(prompt(1), /The text is written in Japanese\./);
            assert.doesNotMatch(prompt(1), /automatic detection/);
            requests[1].resolve(openAiReply('answer for Japanese'));
            assert.deepEqual(await fresh, { ok: true, status: 'success' });
            assert.equal(result().output, 'answer for Japanese');
            assert.equal(result().sourceLanguage, 'ja');
        });

        test('an automatic-detection (original language) change while pending drops the old answer', async () => {
            const pending = dispatch();
            await tick();
            scenario.set('detectLanguage', 'es');
            assert.equal(scenario.runtime.getContext().originalLanguage, 'es');
            requests[0].resolve(openAiReply('answer for French'));
            assert.deepEqual(await pending, { ok: true, status: 'superseded' });
            assert.equal(result(), null);

            const fresh = dispatch();
            await tick();
            assert.equal(requests.length, 2);
            assert.match(prompt(1), /appears to be Spanish/);
            requests[1].resolve(openAiReply('answer for Spanish'));
            await fresh;
            assert.equal(result().originalLanguage, 'es');
        });

        test('after success, a source-language-only change removes the result and the next run is not "unchanged"', async () => {
            let pending = dispatch();
            await tick();
            requests[0].resolve(openAiReply('first answer'));
            await pending;
            assert.equal(result().output, 'first answer');
            assert.deepEqual(await dispatch(), { ok: true, status: 'unchanged' }, 'same context: rapid dedup preserved');
            assert.equal(requests.length, 1);

            scenario.set('sourceLanguage', 'de');
            assert.equal(result(), null);
            assert.equal(scenario.runtime.getContext().ai.result, null);
            pending = dispatch();
            await tick();
            assert.equal(requests.length, 2);
            assert.match(prompt(1), /The text is written in German\./);
            requests[1].resolve(openAiReply('second answer'));
            assert.deepEqual(await pending, { ok: true, status: 'success' });
            assert.equal(result().output, 'second answer');
        });

        test('after success, a detection-only change removes the result and the next run is not "unchanged"', async () => {
            let pending = dispatch();
            await tick();
            requests[0].resolve(openAiReply('first answer'));
            await pending;
            scenario.set('detectLanguage', 'it');
            assert.equal(result(), null);
            pending = dispatch();
            await tick();
            assert.equal(requests.length, 2);
            assert.match(prompt(1), /appears to be Italian/);
            requests[1].resolve(openAiReply('second answer'));
            await pending;
            assert.equal(result().output, 'second answer');
        });

        test('auto -> the same language as detected still changes the wording of the instruction, so it is a new context', async () => {
            const pending = dispatch();
            await tick();
            requests[0].resolve(openAiReply('answer'));
            await pending;
            scenario.set('sourceLanguage', 'fr');
            assert.equal(scenario.runtime.getContext().originalLanguage, 'fr', 'original language itself did not change');
            assert.equal(result(), null);
            const fresh = dispatch();
            await tick();
            assert.equal(requests.length, 2);
            assert.match(prompt(1), /The text is written in French\./);
            requests[1].resolve(openAiReply('answer 2'));
            await fresh;
        });

        test('a change that does not reach the instruction keeps the result (declared source, detection varies)', async () => {
            scenario.set('sourceLanguage', 'fr');
            const pending = dispatch();
            await tick();
            scenario.set('detectLanguage', 'es'); // the declared source wins: original language stays French
            assert.equal(scenario.runtime.getContext().originalLanguage, 'fr');
            requests[0].resolve(openAiReply('still valid'));
            assert.deepEqual(await pending, { ok: true, status: 'success' });
            scenario.set('detectLanguage', 'de');
            assert.equal(result().output, 'still valid');
            assert.deepEqual(await dispatch(), { ok: true, status: 'unchanged' });
            assert.equal(requests.length, 1);
        });

        test('rapid repeated activation in an unchanged context still sends exactly one request', async () => {
            const first = dispatch();
            const second = dispatch();
            const third = dispatch();
            await tick();
            assert.equal(requests.length, 1);
            requests[0].resolve(openAiReply('ok'));
            await first;
            assert.deepEqual(await second, { ok: true, status: 'unchanged' });
            assert.deepEqual(await third, { ok: true, status: 'unchanged' });
        });

        test('the predicate itself, without any subscription (the context is the only authority)', async () => {
            scenario.dispose();
            const pending = dispatch();
            await tick();
            const snapshot = result();
            const ctx = () => scenario.runtime.getContext();
            assert.equal(p.isAiResultCurrent(ctx(), snapshot), true);
            scenario.set('sourceLanguage', 'ko');
            assert.equal(p.isAiResultCurrent(ctx(), snapshot), false, 'source language only');
            assert.equal(ctx().ai.result, null);
            scenario.set('sourceLanguage', 'auto');
            assert.equal(p.isAiResultCurrent(ctx(), snapshot), true);
            scenario.set('detectLanguage', 'pt');
            assert.equal(p.isAiResultCurrent(ctx(), snapshot), false, 'original language only');
            scenario.set('detectLanguage', 'fr');
            requests[0].resolve(openAiReply('done'));
            assert.deepEqual(await pending, { ok: true, status: 'success' });
        });

        test('an old request completing late after a language round trip cannot overwrite the newer one', async () => {
            const first = dispatch();
            await tick();
            scenario.set('sourceLanguage', 'ja');
            const second = dispatch();
            await tick();
            requests[1].resolve(openAiReply('Japanese answer'));
            assert.deepEqual(await second, { ok: true, status: 'success' });
            requests[0].resolve(openAiReply('stale automatic answer'));
            assert.deepEqual(await first, { ok: true, status: 'superseded' });
            assert.equal(result().output, 'Japanese answer');
        });
    });
}

describe('custom actions use none of the language context, so it neither invalidates nor duplicates them', () => {
    test('a source / detection / target change leaves a pending and a shown custom result intact', async () => {
        const custom = await p.loader.load('/src/features/selection-actions/customActions.js');
        const serviceInstance = await p.loader.load('/src/utils/service_instance.ts');
        const api = custom.createCustomActionsApi({
            getStore: () => p.configStore,
            emit: async () => {},
            resolveAi: (instanceKey) =>
                p.resolveAiSelection({
                    aiServiceList: scenario.env.aiServiceList,
                    aiInstanceKey: instanceKey,
                    aiServices: p.aiServices,
                    isPluginInstance: serviceInstance.whetherPluginService,
                    serviceNameOf: serviceInstance.getServiceName,
                }),
        });
        const made = await api.create({ name: 'Mine', instanceKey: KEY, instruction: 'Do my thing.' });
        scenario.env.customActions = structuredClone(await p.configStore.get(custom.CUSTOM_ACTIONS_CONFIG_KEY));
        const params = { customId: made.action.id, revision: 1 };
        const pending = scenario.runtime.dispatch('custom_ai', params);
        await tick();
        scenario.set('sourceLanguage', 'ja');
        scenario.set('detectLanguage', 'es');
        scenario.set('targetLanguage', 'en');
        requests[0].resolve(openAiReply('custom answer'));
        assert.deepEqual(await pending, { ok: true, status: 'success' });
        scenario.set('sourceLanguage', 'de');
        assert.equal(result().output, 'custom answer');
        assert.deepEqual(await scenario.runtime.dispatch('custom_ai', params), { ok: true, status: 'unchanged' });
        assert.equal(requests.length, 1);
        assert.ok(!prompt(0).includes('Japanese') && !prompt(0).includes('French'), 'no language text in a custom instruction');
    });
});
