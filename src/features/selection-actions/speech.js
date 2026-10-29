import { getServiceName, getServiceSouceType, ServiceSourceType } from '../../utils/service_instance';
import { ActionCode, accepted, rejected } from './registry';

// Owner id of the palette inside the shared popup playback owner (see hooks/useVoice).
export const SPEECH_OWNER = 'selection-actions';

const asMessage = (e) => (e instanceof Error ? e.message : String(e));

// Map synthesis failures (thrown by utils/tts_service) to recoverable, user-visible outcomes.
export function classifySpeechError(error) {
    const message = asMessage(error);
    if (/Language not supported/i.test(message)) return rejected(ActionCode.UNSUPPORTED_LANGUAGE);
    if (/not available|plugin info not loaded/i.test(message)) return rejected(ActionCode.TTS_UNAVAILABLE, message);
    return rejected(ActionCode.SYNTH_FAILED, message);
}

// Does the playback described by `d` still correspond to the live context `ctx`?
export function isSpeechCurrent(ctx, d) {
    if (!d || !ctx.hasText || d.instanceKey !== ctx.tts.instanceKey) return false;
    if (d.kind === 'original') {
        if (ctx.text !== d.text || ctx.sourceLanguage !== d.sourceLanguage) return false;
        // A language that is still unknown (being detected) never invalidates; a different one does.
        return !ctx.originalLanguage || !d.language || ctx.originalLanguage === d.language;
    }
    const { translation } = ctx;
    return Boolean(
        translation.speakable &&
            translation.record.requestId === d.requestId &&
            translation.language === d.language &&
            translation.speakText === d.text
    );
}

/**
 * Speak Original / Speak Translation on top of the existing active-TTS synthesis helper and
 * the shared popup playback owner.
 *
 * `getEnv()` returns the live TTS inputs: { serviceInstanceConfigMap, ttsPluginInfo,
 * builtinTtsServices, invokePlugin }. `getContext()` returns the freshly derived action context.
 */
export function createSelectionSpeech({ voice, synthesizeSpeech, detect, getContext, getEnv }) {
    // What the owned playback was started for; context changes are reconciled against it.
    let descriptor = null;

    const synthesize = (instanceKey, text, languageKey) => {
        const env = getEnv();
        return synthesizeSpeech({
            instanceKey,
            serviceName: getServiceName(instanceKey),
            isPlugin: getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN,
            text,
            languageKey,
            serviceInstanceConfigMap: env.serviceInstanceConfigMap,
            pluginInfo: env.ttsPluginInfo,
            builtinTtsServices: env.builtinTtsServices,
            invokePlugin: env.invokePlugin,
        });
    };

    // Synthesis must still match the live context when it finishes; otherwise the shared
    // owner is invalidated, which makes the player discard the audio as stale.
    const synthesizeIfCurrent = async (d, text, language) => {
        const data = await synthesize(d.instanceKey, text, language);
        if (!isSpeechCurrent(getContext(), d)) {
            voice.invalidate(SPEECH_OWNER);
        }
        return data;
    };

    const start = async (intentParts, next, produce) => {
        descriptor = next;
        try {
            const result = await voice.speak(JSON.stringify(intentParts), produce, { owner: SPEECH_OWNER });
            if (result.status !== 'playing' && descriptor === next) descriptor = null;
            return accepted(result.status);
        } catch (error) {
            if (descriptor === next) descriptor = null;
            return classifySpeechError(error);
        }
    };

    const ttsInstance = (ctx) => {
        const key = ctx.tts.instanceKey;
        return typeof key === 'string' && key !== '' ? key : null;
    };

    async function speakOriginal(ctx) {
        if (!ctx.hasText) return rejected(ActionCode.EMPTY_SELECTION);
        const instanceKey = ttsInstance(ctx);
        if (!instanceKey) return rejected(ActionCode.TTS_UNCONFIGURED);
        const d = {
            kind: 'original',
            text: ctx.text,
            sourceLanguage: ctx.sourceLanguage,
            language: ctx.originalLanguage,
            instanceKey,
        };
        return start(['original', d.text, d.sourceLanguage, instanceKey], d, async () => {
            // Language of exactly this text: declared/detected from the context, else detect now.
            if (!d.language) d.language = await detect(d.text);
            if (typeof d.language !== 'string' || d.language === '') {
                throw new Error('Language not supported');
            }
            return synthesizeIfCurrent(d, d.text, d.language);
        });
    }

    async function speakTranslation(ctx) {
        const { translation } = ctx;
        if (!ctx.hasText) return rejected(ActionCode.EMPTY_SELECTION);
        if (!translation.speakable) {
            if (translation.status === 'loading') return rejected(ActionCode.TRANSLATION_PENDING);
            if (translation.status === 'error') return rejected(ActionCode.TRANSLATION_FAILED);
            return rejected(ActionCode.NO_TRANSLATION);
        }
        const instanceKey = ttsInstance(ctx);
        if (!instanceKey) return rejected(ActionCode.TTS_UNCONFIGURED);
        const d = {
            kind: 'translation',
            requestId: translation.record.requestId,
            text: translation.speakText,
            language: translation.language,
            instanceKey,
        };
        return start(['translation', d.requestId, d.text, d.language, instanceKey], d, () =>
            synthesizeIfCurrent(d, d.text, d.language)
        );
    }

    // Call on every relevant context change: stops and invalidates palette speech whose text,
    // languages, provider result or TTS instance are no longer current.
    function reconcile() {
        const state = voice.getState();
        if (state.owner !== SPEECH_OWNER || state.phase === 'idle') return;
        if (!isSpeechCurrent(getContext(), descriptor)) {
            descriptor = null;
            voice.invalidate(SPEECH_OWNER);
        }
    }

    // Which palette speech (if any) is pending/playing right now.
    function getActive() {
        const state = voice.getState();
        if (state.owner !== SPEECH_OWNER || state.phase === 'idle' || !descriptor) return null;
        return { kind: descriptor.kind, phase: state.phase };
    }

    function dispose() {
        descriptor = null;
        voice.invalidate(SPEECH_OWNER);
    }

    return { speakOriginal, speakTranslation, reconcile, getActive, dispose };
}
