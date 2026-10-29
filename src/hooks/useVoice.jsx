import { createVoicePlayer, clampPlaybackRate } from '../utils/voice_player';
import { store } from '../utils/store';

// One playback owner for the whole Translate webview: SourceArea, TargetArea and the
// selection action palette share it, so they can never play over each other.
let audioContext = null;
const player = createVoicePlayer({
    getAudioContext: () => {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        return audioContext;
    },
    // Global tts_playback_rate applied as a local multiplier; provider synthesis
    // voice/rate config is never touched. Read at play time so config changes apply at once.
    getRate: async () => {
        try {
            return clampPlaybackRate(await store.get('tts_playback_rate'));
        } catch (_) {
            return 1;
        }
    },
});

// Existing call style stays valid: `const speak = useVoice(); speak(data)` toggles playback of
// ready audio. `speak.speak(intent, produce, { owner })` is the stale-safe entry for callers
// that synthesize first; `.stop()` / `.invalidate(owner)` / `.getState()` expose the lifecycle.
const playOrStop = Object.assign((data) => player.playOrStop(data), {
    speak: player.speak,
    stop: player.stop,
    invalidate: player.invalidate,
    getState: player.getState,
    subscribe: player.subscribe,
});

export const useVoice = () => playOrStop;
