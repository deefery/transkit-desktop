// Run with: node --test src/utils/voice_player.test.js
// Lifecycle tests for the shared Translate popup playback owner (no native audio involved).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampPlaybackRate, createVoicePlayer } from './voice_player.js';
import { FakeAudioContext, deferred, tick } from '../features/selection-actions/testing/fakes.js';

function setup({ rate = 1 } = {}) {
    const ctx = new FakeAudioContext();
    const state = { rate };
    const player = createVoicePlayer({ getAudioContext: () => ctx, getRate: () => state.rate });
    return { ctx, player, state };
}

const bytes = (...values) => new Uint8Array(values);

test('clampPlaybackRate: 0.1-4 range, invalid values fall back to 1', () => {
    assert.equal(clampPlaybackRate(1), 1);
    assert.equal(clampPlaybackRate(0.05), 0.1);
    assert.equal(clampPlaybackRate(10), 4);
    assert.equal(clampPlaybackRate('1.5'), 1.5);
    for (const bad of [null, undefined, '', '   ', 'abc', NaN, Infinity, -1, 0, {}, [], true]) {
        assert.equal(clampPlaybackRate(bad), 1, `value ${String(bad)}`);
    }
    assert.equal(clampPlaybackRate(undefined, 2), 2);
});

test('plays decoded audio at the clamped global playback rate', async () => {
    const { ctx, player } = setup({ rate: 99 });
    const pending = player.speak('a', async () => bytes(1, 2, 3));
    await tick();
    assert.equal(ctx.decodes.length, 1);
    assert.deepEqual(ctx.decodes[0].bytes, [1, 2, 3]);
    ctx.decodes[0].finish();
    assert.deepEqual(await pending, { status: 'playing' });
    assert.equal(ctx.sources.length, 1);
    assert.equal(ctx.sources[0].started, true);
    assert.equal(ctx.sources[0].playbackRate.value, 4);
    assert.equal(player.getState().phase, 'playing');
});

test('same intent repeated while pending or playing stops; no audio starts afterwards', async () => {
    const { ctx, player } = setup();
    const synth = deferred();
    const first = player.speak('a', () => synth.promise);
    await tick();
    assert.equal(player.getState().phase, 'pending');
    assert.deepEqual(await player.speak('a', async () => bytes(9)), { status: 'stopped' });
    assert.equal(player.getState().phase, 'idle');
    synth.resolve(bytes(1));
    assert.deepEqual(await first, { status: 'stale' });
    assert.equal(ctx.decodes.length, 0);
    assert.equal(ctx.sources.length, 0);

    // playing, then repeat -> stop the source
    const second = player.speak('a', async () => bytes(2));
    await tick();
    ctx.decodes[0].finish();
    await second;
    const source = ctx.sources[0];
    assert.deepEqual(await player.speak('a', async () => bytes(3)), { status: 'stopped' });
    assert.equal(source.stopped, true);
    assert.equal(source.disconnected, true);
    assert.equal(player.getState().phase, 'idle');
});

test('a different intent replaces the old one: old source stops, new one plays', async () => {
    const { ctx, player } = setup();
    const a = player.speak('a', async () => bytes(1));
    await tick();
    ctx.decodes[0].finish();
    await a;
    const b = player.speak('b', async () => bytes(2));
    assert.equal(ctx.sources[0].stopped, true);
    await tick();
    ctx.decodes[1].finish();
    assert.deepEqual(await b, { status: 'playing' });
    assert.equal(player.getState().intent, 'b');
    assert.equal(ctx.sources[1].started, true);
});

test('two overlapping syntheses completing in reverse order: only the newest plays', async () => {
    const { ctx, player } = setup();
    const s1 = deferred();
    const s2 = deferred();
    const first = player.speak('first', () => s1.promise);
    const second = player.speak('second', () => s2.promise);
    s2.resolve(bytes(2)); // newest finishes first
    await tick();
    ctx.decodes[0].finish();
    assert.deepEqual(await second, { status: 'playing' });
    s1.resolve(bytes(1)); // the older one finishes late
    assert.deepEqual(await first, { status: 'stale' });
    assert.equal(ctx.decodes.length, 1, 'stale synthesis must not even be decoded');
    assert.equal(ctx.sources.length, 1);
    assert.equal(player.getState().intent, 'second');
});

test('two overlapping decodes completing in reverse order: only the newest plays', async () => {
    const { ctx, player } = setup();
    const first = player.speak('first', async () => bytes(1));
    await tick();
    // 'first' is now decoding; a newer request supersedes it
    const second = player.speak('second', async () => bytes(2));
    await tick();
    assert.equal(ctx.decodes.length, 2);
    ctx.decodes[1].finish(); // newest decode finishes first
    assert.deepEqual(await second, { status: 'playing' });
    ctx.decodes[0].finish(); // stale decode finishes late
    assert.deepEqual(await first, { status: 'stale' });
    assert.equal(ctx.sources.length, 1);
    assert.equal(ctx.sources[0].started, true);
    assert.equal(player.getState().intent, 'second');
});

test('stale decode failure and stale synthesis failure do not surface or clear the new owner', async () => {
    const { ctx, player } = setup();
    const s1 = deferred();
    const first = player.speak('first', () => s1.promise);
    const second = player.speak('second', async () => bytes(2));
    await tick();
    ctx.decodes[0].finish();
    await second;
    s1.reject(new Error('late synthesis failure'));
    assert.deepEqual(await first, { status: 'stale' });
    assert.equal(player.getState().intent, 'second');
    assert.equal(player.getState().phase, 'playing');
});

test('error of the current request rejects and recovers to idle', async () => {
    const { player } = setup();
    await assert.rejects(
        player.speak('a', async () => {
            throw new Error('synthesis failed');
        }),
        /synthesis failed/
    );
    assert.equal(player.getState().phase, 'idle');
    const { ctx, player: p2 } = setup();
    const pending = p2.speak('a', async () => bytes(1));
    await tick();
    ctx.decodes[0].fail(new Error('bad audio'));
    await assert.rejects(pending, /bad audio/);
    assert.equal(p2.getState().phase, 'idle');
});

test('onended only clears the playback that owns it', async () => {
    const { ctx, player } = setup();
    const a = player.speak('a', async () => bytes(1));
    await tick();
    ctx.decodes[0].finish();
    await a;
    const oldSource = ctx.sources[0];
    const b = player.speak('b', async () => bytes(2));
    await tick();
    ctx.decodes[1].finish();
    await b;
    // stopped source reports its end after the replacement already started
    oldSource.end();
    assert.equal(player.getState().intent, 'b');
    assert.equal(player.getState().phase, 'playing');
    // natural end of the owner returns to idle
    ctx.sources[1].end();
    assert.equal(player.getState().phase, 'idle');
});

test('invalidate(owner) only affects playback of that owner', async () => {
    const { ctx, player } = setup();
    const a = player.speak('a', async () => bytes(1), { owner: 'source-area' });
    await tick();
    ctx.decodes[0].finish();
    await a;
    player.invalidate('selection-actions');
    assert.equal(player.getState().phase, 'playing');
    assert.equal(ctx.sources[0].stopped, false);
    player.invalidate('source-area');
    assert.equal(player.getState().phase, 'idle');
    assert.equal(ctx.sources[0].stopped, true);
});

test('invalidate during pending synthesis discards the audio', async () => {
    const { ctx, player } = setup();
    const synth = deferred();
    const pending = player.speak('a', () => synth.promise, { owner: 'selection-actions' });
    player.invalidate('selection-actions');
    synth.resolve(bytes(1));
    assert.deepEqual(await pending, { status: 'stale' });
    assert.equal(ctx.decodes.length, 0);
});

test('rate is read when playback starts, so config changes apply to the next playback', async () => {
    const { ctx, player, state } = setup({ rate: 1 });
    state.rate = 2.5;
    const a = player.speak('a', async () => bytes(1));
    await tick();
    ctx.decodes[0].finish();
    await a;
    assert.equal(ctx.sources[0].playbackRate.value, 2.5);
});

test('legacy playOrStop(data) keeps toggle semantics and swallows decode errors', async () => {
    const { ctx, player } = setup();
    const play = player.playOrStop(bytes(1));
    await tick();
    ctx.decodes[0].finish();
    assert.deepEqual(await play, { status: 'playing' });
    assert.deepEqual(await player.playOrStop(bytes(2)), { status: 'stopped' });
    assert.equal(ctx.sources[0].stopped, true);

    const failing = player.playOrStop(bytes(3));
    await tick();
    ctx.decodes[1].fail(new Error('bad audio'));
    const originalError = console.error;
    console.error = () => {};
    try {
        assert.deepEqual(await failing, { status: 'error' });
    } finally {
        console.error = originalError;
    }
    assert.equal(player.getState().phase, 'idle');
});

test('accepts plain arrays, typed arrays and array buffers as audio data', async () => {
    const { ctx, player } = setup();
    for (const data of [
        [7, 8],
        new Uint8Array([7, 8]),
        new Uint8Array([0, 7, 8]).subarray(1),
        new Uint8Array([7, 8]).buffer,
    ]) {
        const done = player.speak(`d${ctx.decodes.length}`, async () => data);
        await tick();
        const entry = ctx.decodes.at(-1);
        assert.deepEqual(entry.bytes, [7, 8]);
        entry.finish();
        await done;
    }
});

test('subscribers are notified about pending/playing/idle transitions', async () => {
    const { ctx, player } = setup();
    const seen = [];
    const unsubscribe = player.subscribe(() => seen.push(player.getState().phase));
    const a = player.speak('a', async () => bytes(1));
    await tick();
    ctx.decodes[0].finish();
    await a;
    ctx.sources[0].end();
    unsubscribe();
    assert.ok(seen.includes('pending') && seen.includes('playing') && seen.at(-1) === 'idle', seen.join(','));
    const before = seen.length;
    const x = player.speak('x', async () => bytes(2));
    await tick();
    ctx.decodes[1].finish();
    await x;
    assert.equal(seen.length, before);
});
