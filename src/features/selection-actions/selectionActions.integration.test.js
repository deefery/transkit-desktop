// Run with: node --test src/features/selection-actions/selectionActions.integration.test.js
//
// Production-path tests: the real SourceArea/LanguageArea atoms, registry, context derivation,
// runtime dispatch, active-TTS helper (utils/tts_service), shared playback owner (hooks/useVoice)
// and translation record tracker run unmodified. Only boundaries are injected:
//  - built-in TTS services / audio (fake, deterministic, controlled by the test),
//  - the translation provider request (the mounted TargetArea cannot run without a DOM; its
//    effect inputs and request-time publication are mirrored by mountTranslateStandIn).
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { createScenario, loadProduction, mountTranslateStandIn, tick } from './testing/harness.js';

let p;
let s;

before(async () => {
    p = await loadProduction();
});
after(async () => {
    await p.loader.close();
});
beforeEach(() => {
    s = createScenario(p);
});
afterEach(() => {
    s.cleanup();
});

const itemsByKey = () => Object.fromEntries(s.runtime.getItems().map((i) => [i.key, i]));

// Drive one Speak action through TTS synthesis and audio decode to "playing".
async function speakToPlaying(actionId, service, bytes = [1, 2, 3]) {
    const outcome = s.runtime.dispatch(actionId);
    await tick();
    const call = service.calls.at(-1);
    call.resolve(new Uint8Array(bytes));
    await tick();
    s.audio.decodes.at(-1).finish();
    return { outcome: await outcome, call };
}

describe('registry / palette items from the live context', () => {
    test('default favorites zh_cn/en/ja/es in order, active follows the target language, speak actions listed', () => {
        const items = s.runtime.getItems();
        assert.deepEqual(
            items.filter((i) => i.actionId === 'translate').map((i) => i.params.language),
            ['zh_cn', 'en', 'ja', 'es']
        );
        assert.equal(itemsByKey()['translate:zh_cn'].active, true);
        assert.equal(itemsByKey()['translate:en'].active, false);
        // 'ai' items come from the AI actions slice (see selectionActions.ai.test.js)
        assert.ok(items.every((i) => ['translate', 'dictionary', 'speak', 'ai'].includes(i.group)));
        assert.deepEqual(
            items.filter((i) => i.group === 'dictionary').map((i) => i.actionId),
            ['dictionary']
        );
        assert.deepEqual(
            items.filter((i) => i.group === 'speak').map((i) => i.actionId),
            ['speak_original', 'speak_translation']
        );
        assert.ok(
            items.every((i) => i.enabled || i.code),
            'every disabled item carries a reason code'
        );
    });

    test('items follow selection/target changes without any copied state', () => {
        s.set('targetLanguage', 'ja');
        assert.equal(itemsByKey()['translate:ja'].active, true);
        assert.equal(itemsByKey()['translate:zh_cn'].active, false);
        s.set('sourceText', '   ');
        assert.ok(s.runtime.getItems().every((i) => !i.enabled && i.code === 'empty-selection'));
    });

    test('input and image windows get no enabled actions (selection window only)', () => {
        for (const type of ['[INPUT_TRANSLATE]', '[IMAGE_TRANSLATE]']) {
            s.set('windowType', type);
            assert.ok(
                s.runtime.getItems().every((i) => !i.enabled && i.code === 'wrong-window'),
                type
            );
        }
    });

    test('speak translation is disabled with a specific reason until a current success exists', () => {
        const state = () => itemsByKey().speak_translation;
        assert.equal(state().code, 'no-translation');
        const tracking = s.publishSuccess('x');
        assert.equal(state().enabled, true);
        s.set('targetLanguage', 'en');
        assert.equal(state().code, 'no-translation', 'record of another target is not current');
        s.set('targetLanguage', 'zh_cn');
        assert.equal(state().enabled, true);
        assert.ok(tracking.requestId > 0);
    });

    test('the registry is data-driven: a further action registers without touching palette/dispatch code', async () => {
        const registry = p.createSelectionActionRegistry();
        registry.register({
            id: 'later_action',
            group: 'other',
            order: 99,
            labelKey: 'x',
            defaultLabel: 'Later',
            availability: () => ({ enabled: true }),
            run: async () => ({ ok: true, status: 'ran' }),
        });
        const ctx = s.runtime.getContext();
        assert.ok(registry.items(ctx).some((i) => i.actionId === 'later_action'));
        assert.deepEqual(await p.dispatchAction(registry, 'later_action', {}, ctx, {}), { ok: true, status: 'ran' });
        assert.equal((await p.dispatchAction(registry, 'nope', {}, ctx, {})).code, 'unknown-action');
        assert.throws(() => registry.register({ id: 5 }), TypeError);
    });
});

describe('Translate action -> existing translation boundary', () => {
    test('switching favorite sets the target; provider receives request-time source/target/text', async () => {
        const requests = [];
        mountTranslateStandIn(p, s.store, {
            instanceKey: 'google',
            provider: async (req) => {
                requests.push(req);
                return `T(${req.targetLanguage}):${req.text}`;
            },
        });
        assert.deepEqual(await s.runtime.dispatch('translate', { language: 'ja' }), { ok: true, status: 'started' });
        await tick();
        assert.equal(s.store.get(p.atoms.targetLanguage), 'ja');
        assert.deepEqual(requests, [
            { text: 'Hello world', sourceLanguage: 'auto', targetLanguage: 'ja', detectLanguage: 'en' },
        ]);
        const ctx = s.runtime.getContext();
        assert.equal(ctx.translation.status, 'success');
        assert.equal(ctx.translation.speakText, 'T(ja):Hello world');
        assert.equal(ctx.translation.language, 'ja');
    });

    test('an explicit source language and the full language list are preserved', async () => {
        s.set('sourceLanguage', 'fr');
        const requests = [];
        mountTranslateStandIn(p, s.store, { instanceKey: 'google', provider: async (r) => (requests.push(r), 'ok') });
        await s.runtime.dispatch('translate', { language: 'es' });
        await tick();
        assert.equal(requests[0].sourceLanguage, 'fr');
        assert.equal(requests[0].targetLanguage, 'es');
        // any language of the existing list can be chosen as a favorite and translated to
        assert.equal((await s.runtime.dispatch('translate', { language: 'he' })).ok, true);
        assert.equal(s.store.get(p.atoms.targetLanguage), 'he');
    });

    test('auto detection: favorite equal to the detected language translates to the second language (existing rule)', async () => {
        s.set('detectLanguage', 'zh_cn');
        s.set('sourceText', '你好，世界');
        s.set('targetLanguage', 'en');
        const requests = [];
        mountTranslateStandIn(p, s.store, {
            instanceKey: 'google',
            provider: async (r) => (requests.push(r), 'Hello world'),
        });
        await s.runtime.dispatch('translate', { language: 'zh_cn' });
        await tick();
        assert.equal(requests.at(-1).targetLanguage, 'en', 'effective target is the second language');
        const ctx = s.runtime.getContext();
        assert.equal(ctx.translation.language, 'en');
        assert.equal(ctx.targetLanguage, 'zh_cn', 'the selected target itself is untouched');
        // Speaking the translation uses the effective target language, not the selected one
        const { call } = await speakToPlaying('speak_translation', s.edge);
        assert.equal(call.voice, 'edge-en');
        assert.equal(call.text, 'Hello world');
    });

    test('repeating the active language does not re-run a running or finished translation, but retries after an error', async () => {
        let runs = 0;
        let fail = true;
        mountTranslateStandIn(p, s.store, {
            instanceKey: 'google',
            provider: async () => {
                runs += 1;
                if (fail) throw new Error('provider down');
                return 'ok';
            },
        });
        await s.runtime.dispatch('translate', { language: 'en' });
        await tick();
        assert.equal(runs, 1);
        assert.equal(s.runtime.getContext().translation.status, 'error');
        fail = false;
        assert.equal((await s.runtime.dispatch('translate', { language: 'en' })).status, 'started');
        await tick();
        assert.equal(runs, 2, 'error -> retranslate nonce re-runs the request');
        assert.equal(s.runtime.getContext().translation.status, 'success');
        assert.equal((await s.runtime.dispatch('translate', { language: 'en' })).status, 'unchanged');
        await tick();
        assert.equal(runs, 2, 'success -> no extra provider request');
    });

    test('blank, whitespace-only and non-string selections trigger no request and change nothing', async () => {
        let runs = 0;
        mountTranslateStandIn(p, s.store, { instanceKey: 'google', provider: async () => (runs++, 'x') });
        for (const value of ['', '  \n\t ', null, undefined, 42, { a: 1 }, ['x']]) {
            s.set('sourceText', value);
            const outcome = await s.runtime.dispatch('translate', { language: 'ja' });
            assert.equal(outcome.ok, false, String(value));
            assert.equal(outcome.code, 'empty-selection');
        }
        assert.equal(runs, 0);
        assert.equal(s.store.get(p.atoms.targetLanguage), 'zh_cn');
    });

    test('invalid language params are rejected without side effects', async () => {
        for (const language of [undefined, null, 5, '', 'auto', 'xx', 'EN', {}, ['ja']]) {
            const outcome = await s.runtime.dispatch('translate', { language });
            assert.equal(outcome.code, 'invalid-language', String(language));
        }
        assert.equal((await s.runtime.dispatch('translate', undefined)).code, 'invalid-language');
        assert.equal(s.store.get(p.atoms.targetLanguage), 'zh_cn');
    });

    test('rapid repeated actions with provider results arriving out of order keep only the newest context', async () => {
        const pending = [];
        mountTranslateStandIn(p, s.store, {
            instanceKey: 'google',
            provider: (req) =>
                new Promise((resolve) => {
                    pending.push({ req, resolve });
                }),
        });
        await s.runtime.dispatch('translate', { language: 'ja' });
        await s.runtime.dispatch('translate', { language: 'en' });
        await s.runtime.dispatch('translate', { language: 'es' });
        await tick();
        assert.deepEqual(
            pending.map((x) => x.req.targetLanguage),
            ['ja', 'en', 'es']
        );
        pending[2].resolve('ES result');
        await tick();
        pending[0].resolve('JA result (late)');
        pending[1].resolve('EN result (late)');
        await tick();
        const ctx = s.runtime.getContext();
        assert.equal(ctx.targetLanguage, 'es');
        assert.equal(ctx.translation.speakText, 'ES result');
        assert.equal(ctx.translation.language, 'es');
    });

    test('translation records of a provider no longer configured are ignored', async () => {
        s.set('targetLanguage', 'ja');
        s.publishSuccess('JA', { instanceKey: 'bing@x1' });
        assert.equal(s.runtime.getContext().translation.instanceKey, 'bing@x1');
        s.env.translateServiceInstanceList = ['google'];
        assert.equal(s.runtime.getContext().translation.status, 'none');
        s.env.translateServiceInstanceList = null;
        assert.equal(s.runtime.getContext().translation.status, 'none');
        s.env.translateServiceInstanceList = 'not-an-array';
        assert.equal(s.runtime.getContext().translation.status, 'none');
    });
});

describe('Speak Original', () => {
    test('speaks the selected text with the active instance voice/config at the global playback rate', async () => {
        p.configStore.data.set('tts_playback_rate', 1.75);
        const { outcome, call } = await speakToPlaying('speak_original', s.edge);
        assert.deepEqual(await outcome, { ok: true, status: 'playing' });
        assert.equal(call.text, 'Hello world');
        assert.equal(call.voice, 'edge-en', 'voice of the detected language');
        assert.deepEqual(call.config, { voice: 'cfg-edge', rate: '+10%' }, 'provider synthesis config untouched');
        assert.equal(s.audio.sources[0].playbackRate.value, 1.75);
        assert.equal(s.audio.sources[0].started, true);
        p.configStore.data.delete('tts_playback_rate');
    });

    test('active instance that is not list[0] and non-default instance keys select the right service/config', async () => {
        s.env.ttsActiveService = 'google_tts@abc';
        const { call } = await speakToPlaying('speak_original', s.google);
        assert.equal(call.voice, 'g-en');
        assert.deepEqual(call.config, { voice: 'cfg-google' });
        assert.equal(s.edge.calls.length, 0);
    });

    test('an active instance that left the list falls back to the first listed one', async () => {
        s.env.ttsActiveService = 'removed_tts';
        const { call } = await speakToPlaying('speak_original', s.edge);
        assert.equal(call.voice, 'edge-en');
    });

    test('declared source language wins over detection; unknown language is detected on demand', async () => {
        s.set('sourceLanguage', 'ja');
        s.set('detectLanguage', 'en');
        s.set('sourceText', 'こんにちは');
        let r = await speakToPlaying('speak_original', s.edge);
        assert.equal(r.call.voice, 'edge-ja');
        s.voice.stop();
        s.audio.reset();

        s.set('sourceLanguage', 'auto');
        s.set('detectLanguage', '');
        s.set('sourceText', 'Hola mundo');
        s.setDetectResult('es');
        r = await speakToPlaying('speak_original', s.edge);
        assert.equal(r.call.voice, 'edge-es');
        assert.deepEqual(s.detectCalls, ['Hola mundo']);
    });

    test('multilingual / emoji / RTL / mixed text is passed through unchanged (only trimmed)', async () => {
        const texts = ['你好，世界！ 🌏', 'مرحبا بالعالم', 'Hello 世界 — こんにちは 👨‍👩‍👧', 'á ñ ​ zero-width'];
        for (const text of texts) {
            s.voice.stop();
            s.set('sourceText', `  ${text}\n`);
            const { call } = await speakToPlaying('speak_original', s.edge);
            assert.equal(call.text, text);
        }
    });

    test('empty, blank or malformed selection: rejected, no synthesis, recoverable', async () => {
        for (const value of ['', '   ', null, undefined, 7, {}]) {
            s.set('sourceText', value);
            const outcome = await s.runtime.dispatch('speak_original');
            assert.equal(outcome.code, 'empty-selection', String(value));
        }
        assert.equal(s.edge.calls.length, 0);
        s.set('sourceText', 'Back again');
        const { outcome } = await speakToPlaying('speak_original', s.edge);
        assert.equal((await outcome).ok, true);
    });

    test('no TTS service configured / malformed service config', async () => {
        for (const list of [[], null, undefined, 'edge_tts', {}]) {
            s.env.ttsServiceList = list;
            assert.equal((await s.runtime.dispatch('speak_original')).code, 'tts-unconfigured', JSON.stringify(list));
        }
        assert.equal(s.edge.calls.length, 0);
    });

    test('unavailable, unsupported-language and failing providers give distinct recoverable outcomes', async () => {
        s.env.builtinTtsServices = {};
        let outcome = await s.runtime.dispatch('speak_original');
        assert.equal(outcome.code, 'tts-unavailable');
        assert.equal(s.voice.getState().phase, 'idle');

        s.env.builtinTtsServices = { edge_tts: s.edge, google_tts: s.google };
        s.set('detectLanguage', 'ko');
        outcome = await s.runtime.dispatch('speak_original');
        assert.equal(outcome.code, 'unsupported-language');

        s.set('detectLanguage', 'en');
        const pending = s.runtime.dispatch('speak_original');
        await tick();
        s.edge.calls.at(-1).reject(new Error('quota exceeded'));
        outcome = await pending;
        assert.equal(outcome.code, 'synth-failed');
        assert.match(outcome.message, /quota exceeded/);
        assert.equal(s.voice.getState().phase, 'idle');

        const { outcome: ok } = await speakToPlaying('speak_original', s.edge);
        assert.equal((await ok).status, 'playing', 'recovers after failures');
    });

    test('plugin TTS instance: plugin info missing is reported, present info maps language and passes instance config', async () => {
        s.env.ttsServiceList = ['plugin.demo@1'];
        s.env.ttsActiveService = 'plugin.demo@1';
        s.env.serviceInstanceConfigMap = { 'plugin.demo@1': { key: 'secret-ref' } };
        let outcome = await s.runtime.dispatch('speak_original');
        assert.equal(outcome.code, 'tts-unavailable');

        const calls = [];
        s.env.ttsPluginInfo = { language: { en: 'plugin-en' } };
        s.env.invokePlugin = async (type, name) => [
            async (text, lang, options) => {
                calls.push({ type, name, text, lang, config: options.config });
                return new Uint8Array([5]);
            },
            { util: true },
        ];
        const pending = s.runtime.dispatch('speak_original');
        await tick();
        await tick();
        s.audio.decodes.at(-1).finish();
        outcome = await pending;
        assert.equal(outcome.status, 'playing');
        assert.deepEqual(calls, [
            { type: 'tts', name: 'plugin.demo', text: 'Hello world', lang: 'plugin-en', config: { key: 'secret-ref' } },
        ]);
    });

    test('playback rate: invalid stored values play at 1x, out-of-range values are clamped', async () => {
        const rateFor = async (stored) => {
            s.voice.stop();
            s.audio.reset();
            if (stored === undefined) p.configStore.data.delete('tts_playback_rate');
            else p.configStore.data.set('tts_playback_rate', stored);
            await speakToPlaying('speak_original', s.edge);
            return s.audio.sources.at(-1).playbackRate.value;
        };
        assert.equal(await rateFor(undefined), 1);
        assert.equal(await rateFor('nonsense'), 1);
        assert.equal(await rateFor(null), 1);
        assert.equal(await rateFor(0), 1);
        assert.equal(await rateFor(0.01), 0.1);
        assert.equal(await rateFor(12), 4);
        assert.equal(await rateFor('2'), 2);
        p.configStore.data.delete('tts_playback_rate');
    });
});

describe('Speak Translation', () => {
    test('speaks the current successful translation in the effective target language, with instance voice/config', async () => {
        s.set('targetLanguage', 'ja');
        s.publishSuccess({ translation: 'こんにちは世界', explanations: [{ trait: 'x' }] });
        const { outcome, call } = await speakToPlaying('speak_translation', s.edge);
        assert.equal((await outcome).status, 'playing');
        assert.equal(call.text, 'こんにちは世界');
        assert.equal(call.voice, 'edge-ja');
        assert.deepEqual(call.config, { voice: 'cfg-edge', rate: '+10%' });
    });

    test('non-default translate provider instance with the TTS instance chosen independently', async () => {
        s.env.ttsActiveService = 'google_tts@abc';
        s.set('targetLanguage', 'ja');
        s.publishSuccess('JA text', { instanceKey: 'bing@x1' });
        const { call } = await speakToPlaying('speak_translation', s.google);
        assert.equal(call.voice, 'g-ja');
        assert.deepEqual(call.config, { voice: 'cfg-google' });
    });

    test('no translation / loading / failed translation: rejected with specific reason and no synthesis', async () => {
        assert.equal((await s.runtime.dispatch('speak_translation')).code, 'no-translation');
        const tracking = p.trackTranslation((fn) => s.store.set(p.translationRecordsAtom, fn), {
            instanceKey: 'google',
            text: 'Hello world',
            sourceLanguage: 'auto',
            targetLanguage: 'zh_cn',
            effectiveTargetLanguage: 'zh_cn',
            detectLanguage: 'en',
        });
        assert.equal((await s.runtime.dispatch('speak_translation')).code, 'translation-pending');
        tracking.failure(new Error('boom'));
        assert.equal((await s.runtime.dispatch('speak_translation')).code, 'translation-failed');
        assert.equal(s.runtime.getContext().translation.error, 'Error: boom');
        for (const empty of ['', '   ', null, undefined, {}, { translation: 5 }, 7, []]) {
            s.publishSuccess(empty);
            assert.equal((await s.runtime.dispatch('speak_translation')).code, 'no-translation', JSON.stringify(empty));
        }
        assert.equal(s.edge.calls.length, 0);
    });

    test('a result for an older selection, source, target or provider is never spoken', async () => {
        s.publishSuccess('old');
        for (const mutate of [
            () => s.set('sourceText', 'A different selection'),
            () => s.set('sourceLanguage', 'en'),
            () => s.set('targetLanguage', 'ja'),
        ]) {
            mutate();
            assert.equal((await s.runtime.dispatch('speak_translation')).code, 'no-translation');
        }
        assert.equal(s.edge.calls.length, 0);
    });

    test('translate-back / cleared record is not speakable', async () => {
        s.publishSuccess('translated');
        p.clearTranslationRecord((fn) => s.store.set(p.translationRecordsAtom, fn), 'google');
        assert.equal((await s.runtime.dispatch('speak_translation')).code, 'no-translation');
    });

    test('target language the TTS service does not support is reported', async () => {
        s.set('targetLanguage', 'ko');
        s.publishSuccess('안녕');
        assert.equal((await s.runtime.dispatch('speak_translation')).code, 'unsupported-language');
    });
});

describe('stale synthesis / decode, ownership and lifecycle', () => {
    test('selection changes while synthesis is pending: the old audio never plays', async () => {
        const pending = s.runtime.dispatch('speak_original');
        await tick();
        s.set('sourceText', 'Something else entirely');
        s.edge.calls[0].resolve(new Uint8Array([1]));
        assert.deepEqual(await pending, { ok: true, status: 'stale' });
        assert.equal(s.audio.decodes.length, 0);
        assert.equal(s.audio.sources.length, 0);
        assert.equal(s.voice.getState().phase, 'idle');
    });

    test('selection changes while the audio is playing: playback stops', async () => {
        const { outcome } = await speakToPlaying('speak_original', s.edge);
        assert.equal((await outcome).status, 'playing');
        const source = s.audio.sources[0];
        s.set('sourceText', 'New selection');
        assert.equal(source.stopped, true);
        assert.equal(s.voice.getState().phase, 'idle');
    });

    for (const [name, mutate] of [
        ['target language', () => s.set('targetLanguage', 'en')],
        ['source language', () => s.set('sourceLanguage', 'ja')],
        ['translation provider result', () => s.publishSuccess('another result')],
        ['selected text', () => s.set('sourceText', 'Changed')],
        [
            'active TTS instance',
            () => {
                s.env.ttsActiveService = 'google_tts@abc';
                s.runtime.reconcile();
            },
        ],
    ]) {
        test(`translation speech is invalidated when the ${name} changes (pending synthesis)`, async () => {
            s.set('targetLanguage', 'ja');
            s.publishSuccess('JA');
            const pending = s.runtime.dispatch('speak_translation');
            await tick();
            mutate();
            s.edge.calls[0].resolve(new Uint8Array([1]));
            assert.equal((await pending).status, 'stale');
            assert.equal(s.audio.decodes.length, 0);
        });
    }

    test('translation speech is invalidated when the provider is removed from the configured list', async () => {
        s.publishSuccess('x');
        const pending = s.runtime.dispatch('speak_translation');
        await tick();
        s.env.translateServiceInstanceList = ['bing@x1'];
        s.runtime.reconcile();
        s.edge.calls[0].resolve(new Uint8Array([1]));
        assert.equal((await pending).status, 'stale');
    });

    test('reverse-order completion: Speak Original then Speak Translation, the older synthesis finishing last', async () => {
        s.publishSuccess('Translated');
        const first = s.runtime.dispatch('speak_original');
        await tick();
        const second = s.runtime.dispatch('speak_translation');
        await tick();
        assert.equal(s.edge.calls.length, 2);
        s.edge.calls[1].resolve(new Uint8Array([2])); // newest first
        await tick();
        s.audio.decodes[0].finish();
        assert.equal((await second).status, 'playing');
        s.edge.calls[0].resolve(new Uint8Array([1])); // stale, late
        assert.equal((await first).status, 'stale');
        assert.equal(s.audio.decodes.length, 1);
        assert.equal(s.audio.sources.length, 1);
        assert.deepEqual(s.audio.decodes[0].bytes, [2]);
    });

    test('reverse-order decode completion across Original and Translation', async () => {
        s.publishSuccess('Translated');
        const first = s.runtime.dispatch('speak_original');
        await tick();
        s.edge.calls[0].resolve(new Uint8Array([1]));
        await tick(); // first is now decoding
        const second = s.runtime.dispatch('speak_translation');
        await tick();
        s.edge.calls[1].resolve(new Uint8Array([2]));
        await tick();
        assert.equal(s.audio.decodes.length, 2);
        s.audio.decodes[1].finish();
        assert.equal((await second).status, 'playing');
        s.audio.decodes[0].finish();
        assert.equal((await first).status, 'stale');
        assert.equal(s.audio.sources.length, 1);
        assert.equal(s.audio.sources[0].started, true);
    });

    test('same-intent repeat while pending cancels; while playing stops; a later press starts again', async () => {
        const first = s.runtime.dispatch('speak_original');
        await tick();
        const repeat = await s.runtime.dispatch('speak_original');
        assert.equal(repeat.status, 'stopped');
        s.edge.calls[0].resolve(new Uint8Array([1]));
        assert.equal((await first).status, 'stale');
        assert.equal(s.audio.decodes.length, 0);

        const { outcome } = await speakToPlaying('speak_original', s.edge);
        assert.equal((await outcome).status, 'playing');
        const source = s.audio.sources[0];
        assert.equal((await s.runtime.dispatch('speak_original')).status, 'stopped');
        assert.equal(source.stopped, true);

        const again = await speakToPlaying('speak_original', s.edge);
        assert.equal((await again.outcome).status, 'playing');
    });

    test('active speech state follows pending -> playing -> ended and onended clears only its own playback', async () => {
        assert.equal(s.runtime.getActiveSpeech(), null);
        const pending = s.runtime.dispatch('speak_original');
        await tick();
        assert.deepEqual(s.runtime.getActiveSpeech(), { kind: 'original', phase: 'pending' });
        s.edge.calls[0].resolve(new Uint8Array([1]));
        await tick();
        s.audio.decodes[0].finish();
        await pending;
        assert.deepEqual(s.runtime.getActiveSpeech(), { kind: 'original', phase: 'playing' });
        const first = s.audio.sources[0];
        // replaced by another intent; the stopped source's late end event must not clear the new owner
        s.publishSuccess('T');
        const second = s.runtime.dispatch('speak_translation');
        await tick();
        s.edge.calls[1].resolve(new Uint8Array([2]));
        await tick();
        s.audio.decodes[1].finish();
        await second;
        first.end();
        assert.deepEqual(s.runtime.getActiveSpeech(), { kind: 'translation', phase: 'playing' });
        s.audio.sources[1].end();
        assert.equal(s.runtime.getActiveSpeech(), null);
    });

    test('unmount stops playing palette speech and discards pending synthesis', async () => {
        const { outcome } = await speakToPlaying('speak_original', s.edge);
        await outcome;
        const playing = s.audio.sources[0];
        s.dispose();
        assert.equal(playing.stopped, true);
        assert.equal(s.voice.getState().phase, 'idle');

        s.cleanup();
        s = createScenario(p);
        const pending = s.runtime.dispatch('speak_original');
        await tick();
        s.dispose();
        s.edge.calls[0].resolve(new Uint8Array([1]));
        assert.equal((await pending).status, 'stale');
        assert.equal(s.audio.decodes.length, 0);
    });

    test('unmount leaves Source/Target area playback alone', async () => {
        const play = s.voice.speak('target-area-intent', async () => new Uint8Array([9]), { owner: 'target-area' });
        await tick();
        s.audio.decodes[0].finish();
        await play;
        s.dispose();
        assert.equal(s.voice.getState().phase, 'playing');
        assert.equal(s.audio.sources[0].stopped, false);
    });

    test('context changes do not stop Source/Target area playback', async () => {
        const play = s.voice.speak('source-area-intent', async () => new Uint8Array([9]), { owner: 'source-area' });
        await tick();
        s.audio.decodes[0].finish();
        await play;
        s.set('sourceText', 'another');
        s.set('targetLanguage', 'ja');
        assert.equal(s.voice.getState().phase, 'playing');
    });

    test('Source/Target-area style speak (shared owner) and the palette cannot play at the same time', async () => {
        const area = s.voice.speak('target-area-intent', async () => new Uint8Array([4]), { owner: 'target-area' });
        await tick();
        s.audio.decodes[0].finish();
        await area;
        const areaSource = s.audio.sources[0];
        const palette = speakToPlaying('speak_original', s.edge);
        await palette;
        assert.equal(areaSource.stopped, true);
        assert.equal(s.audio.sources.filter((x) => x.started && !x.stopped).length, 1);
    });
});

describe('hook compatibility', () => {
    test('useVoice() is callable like before and exposes the lifecycle API', async () => {
        const speak = p.useVoice();
        assert.equal(typeof speak, 'function');
        for (const m of ['speak', 'stop', 'invalidate', 'getState', 'subscribe'])
            assert.equal(typeof speak[m], 'function', m);
        assert.equal(p.useVoice(), speak, 'one shared owner for every consumer');
        const play = speak(new Uint8Array([1, 2]));
        await tick();
        s.audio.decodes[0].finish();
        assert.deepEqual(await play, { status: 'playing' });
        assert.equal(s.audio.sources[0].playbackRate.value, 1);
        assert.deepEqual(await speak(new Uint8Array([1, 2])), { status: 'stopped' });
    });
});

describe('config robustness', () => {
    test('malformed favorites / env values never break the context', () => {
        for (const favoriteLanguages of [null, 'ja', 5, {}, [], [null, 3, 'xx'], ['ja', 'ja', 'en'], ['', 'auto']]) {
            s.env.favoriteLanguages = favoriteLanguages;
            const langs = s.runtime
                .getItems()
                .filter((i) => i.actionId === 'translate')
                .map((i) => i.params.language);
            assert.ok(langs.length >= 1, JSON.stringify(favoriteLanguages));
            assert.ok(langs.every((x) => typeof x === 'string'));
            assert.equal(new Set(langs).size, langs.length);
        }
        s.env.favoriteLanguages = ['ja', 'ja', 'en'];
        assert.deepEqual(
            s.runtime
                .getItems()
                .filter((i) => i.actionId === 'translate')
                .map((i) => i.params.language),
            ['ja', 'en']
        );
    });

    test('non-string atom values degrade to "unavailable" instead of throwing', () => {
        for (const [atomName, value] of [
            ['windowType', undefined],
            ['sourceLanguage', 12],
            ['targetLanguage', {}],
            ['detectLanguage', ['en']],
        ]) {
            s.set(atomName, value);
            assert.doesNotThrow(() => s.runtime.getItems());
        }
    });
});
