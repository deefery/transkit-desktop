// Run with: node --test src/features/selection-actions/selectionActions.edge.test.js
// Adversarial / defence-in-depth cases for the speech lifecycle that the main integration
// suite exercises through the normal path.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createScenario, loadProduction, tick } from './testing/harness.js';

let p;
let s;

before(async () => {
    p = await loadProduction();
});
after(() => p.loader.close());
beforeEach(() => {
    s = createScenario(p);
});
afterEach(() => s.cleanup());

test('a late `ended` event of a replaced source cannot clear the new owner (handler invoked directly)', async () => {
    const a = s.voice.speak('a', async () => new Uint8Array([1]), { owner: 'x' });
    await tick();
    s.audio.decodes[0].finish();
    await a;
    const staleHandler = s.audio.sources[0].onended;
    assert.equal(typeof staleHandler, 'function');
    const b = s.voice.speak('b', async () => new Uint8Array([2]), { owner: 'x' });
    await tick();
    s.audio.decodes[1].finish();
    await b;
    staleHandler(); // event queued by the engine before stop() and delivered afterwards
    assert.equal(s.voice.getState().intent, 'b');
    assert.equal(s.voice.getState().phase, 'playing');
});

test('environment changes without any atom change still discard a finishing synthesis (active TTS instance)', async () => {
    const pending = s.runtime.dispatch('speak_original');
    await tick();
    s.env.ttsActiveService = 'google_tts@abc'; // no reconcile(): checked when synthesis completes
    s.edge.calls[0].resolve(new Uint8Array([1]));
    assert.equal((await pending).status, 'stale');
    assert.equal(s.audio.decodes.length, 0);
});

test('environment changes without any atom change still discard a finishing synthesis (translation provider removed)', async () => {
    s.publishSuccess('Translated');
    const pending = s.runtime.dispatch('speak_translation');
    await tick();
    s.env.translateServiceInstanceList = ['bing@x1'];
    s.edge.calls[0].resolve(new Uint8Array([1]));
    assert.equal((await pending).status, 'stale');
    assert.equal(s.audio.decodes.length, 0);
});

test('speech functions reject an empty selection on their own, independent of the registry check', async () => {
    const speech = p.createSelectionSpeech({
        voice: s.voice,
        synthesizeSpeech: async () => assert.fail('must not synthesize'),
        detect: async () => assert.fail('must not detect'),
        getContext: () => s.runtime.getContext(),
        getEnv: () => s.env,
    });
    s.store.set(p.atoms.sourceText, '   ');
    const ctx = s.runtime.getContext();
    assert.equal((await speech.speakOriginal(ctx)).code, 'empty-selection');
    assert.equal((await speech.speakTranslation(ctx)).code, 'empty-selection');
});

test('detection failure on demand is reported as a synthesis failure and recovers', async () => {
    s.set('detectLanguage', '');
    s.set('sourceText', 'Texto sin idioma');
    const speech = p.createSelectionSpeech({
        voice: s.voice,
        synthesizeSpeech: p.synthesizeSpeech,
        detect: async () => {
            throw new Error('detector offline');
        },
        getContext: () => s.runtime.getContext(),
        getEnv: () => s.env,
    });
    const outcome = await speech.speakOriginal(s.runtime.getContext());
    assert.equal(outcome.code, 'synth-failed');
    assert.match(outcome.message, /detector offline/);
    assert.equal(s.voice.getState().phase, 'idle');
});

test('detection that yields no language is an unsupported-language outcome, never a request with an empty language', async () => {
    s.set('detectLanguage', '');
    s.set('sourceText', '???');
    s.setDetectResult('');
    const outcome = await s.runtime.dispatch('speak_original');
    assert.equal(outcome.code, 'unsupported-language');
    assert.equal(s.edge.calls.length, 0);
});

test('hundreds of rapid alternating presses leave exactly one consistent owner and no leaked playback', async () => {
    s.publishSuccess('Translated');
    const results = [];
    for (let i = 0; i < 200; i += 1) {
        results.push(s.runtime.dispatch(i % 3 === 0 ? 'speak_translation' : 'speak_original'));
    }
    await tick();
    // resolve every synthesis in reverse order
    for (const call of [...s.edge.calls].reverse()) call.resolve(new Uint8Array([call.text.length]));
    await tick();
    for (const decode of [...s.audio.decodes].reverse()) decode.finish();
    const settled = await Promise.all(results);
    assert.ok(
        settled.every((r) => r.ok),
        'no press produced an error'
    );
    const playing = s.audio.sources.filter((x) => x.started && !x.stopped);
    assert.ok(playing.length <= 1, `at most one source plays, got ${playing.length}`);
    const state = s.voice.getState();
    assert.equal(playing.length === 1, state.phase === 'playing');
});

test('speaking after the window content was replaced by a blank selection stops and stays quiet', async () => {
    const pending = s.runtime.dispatch('speak_original');
    await tick();
    s.set('sourceText', '');
    s.edge.calls[0].resolve(new Uint8Array([1]));
    assert.equal((await pending).status, 'stale');
    assert.equal((await s.runtime.dispatch('speak_original')).code, 'empty-selection');
});
