// Shared setup for the selection action integration tests: loads the real production modules
// and provides the injected boundaries (TTS services, audio, Translate request) around them.
import { createStore } from 'jotai';
import { createProductionLoader } from './loadProduction.mjs';
import { FakeAudioContext, deferred, tick } from './fakes.js';

export { deferred, tick };

export async function loadProduction() {
    const loader = await createProductionLoader();
    const [
        sourceArea,
        languageArea,
        runtimeModule,
        records,
        voiceModule,
        ttsService,
        favorites,
        registry,
        context,
        speech,
        configStore,
        aiActions,
        aiRunner,
        aiServices,
    ] = await Promise.all([
        loader.load('/src/window/Translate/components/SourceArea/index.jsx'),
        loader.load('/src/window/Translate/components/LanguageArea/index.jsx'),
        loader.load('/src/features/selection-actions/runtime.js'),
        loader.load('/src/features/selection-actions/translationRecords.js'),
        loader.load('/src/hooks/useVoice.jsx'),
        loader.load('/src/utils/tts_service.js'),
        loader.load('/src/features/selection-actions/favorites.js'),
        loader.load('/src/features/selection-actions/registry.js'),
        loader.load('/src/features/selection-actions/context.js'),
        loader.load('/src/features/selection-actions/speech.js'),
        loader.load('/src/utils/store.js'),
        loader.load('/src/features/selection-actions/aiActions.js'),
        loader.load('/src/features/selection-actions/aiRunner.js'),
        loader.load('/src/services/ai/index.jsx'),
    ]);
    return {
        loader,
        atoms: {
            windowType: sourceArea.windowTypeAtom,
            sourceText: sourceArea.sourceTextAtom,
            detectLanguage: sourceArea.detectLanguageAtom,
            sourceLanguage: languageArea.sourceLanguageAtom,
            targetLanguage: languageArea.targetLanguageAtom,
        },
        ...runtimeModule,
        ...records,
        ...voiceModule,
        ...ttsService,
        ...favorites,
        ...registry,
        ...context,
        ...speech,
        ...aiActions,
        ...aiRunner,
        aiServices,
        configStore: configStore.store,
    };
}

// The Web Audio boundary of the real shared playback owner (hooks/useVoice).
// The production owner creates its AudioContext once per webview, so tests share one fake.
let sharedAudio = null;
export function installFakeAudio() {
    const ctx = (sharedAudio ??= new FakeAudioContext());
    ctx.reset();
    globalThis.window = {
        AudioContext: function AudioContext() {
            return ctx;
        },
    };
    return ctx;
}

// A built-in TTS service double; every call waits for the test to resolve it.
export function fakeTtsService(languages, { auto = false } = {}) {
    const calls = [];
    return {
        Language: languages,
        calls,
        tts(text, voice, options) {
            const d = deferred();
            const call = { text, voice, config: options?.config, ...d };
            calls.push(call);
            if (auto) d.resolve(new Uint8Array([calls.length]));
            return d.promise;
        },
    };
}

/**
 * Stand-in for the mounted TargetArea in Node (no DOM): same inputs as its translation effect
 * (sourceText / source / target / retranslate nonce), same request-time snapshot publication
 * through the real `trackTranslation`, provider call injected.
 */
export function mountTranslateStandIn(p, store, { instanceKey, provider, secondLanguage = 'en' }) {
    const run = () => {
        const rawText = store.get(p.atoms.sourceText);
        const text = typeof rawText === 'string' ? rawText.trim() : '';
        const sourceLanguage = store.get(p.atoms.sourceLanguage);
        const targetLanguage = store.get(p.atoms.targetLanguage);
        const detectLanguage = store.get(p.atoms.detectLanguage);
        if (text === '' || !sourceLanguage || !targetLanguage) return;
        const effective =
            sourceLanguage === 'auto' && targetLanguage === detectLanguage ? secondLanguage : targetLanguage;
        const tracking = p.trackTranslation((fn) => store.set(p.translationRecordsAtom, fn), {
            instanceKey,
            text,
            sourceLanguage,
            targetLanguage,
            effectiveTargetLanguage: effective,
            detectLanguage,
        });
        provider({ text, sourceLanguage, targetLanguage: effective, detectLanguage }).then(
            (v) => tracking.success(v),
            (e) => tracking.failure(e)
        );
    };
    const subs = [p.atoms.sourceText, p.atoms.sourceLanguage, p.atoms.targetLanguage, p.retranslateNonceAtom].map(
        (atom) => store.sub(atom, run)
    );
    return () => {
        subs.forEach((u) => u());
        p.clearTranslationRecord((fn) => store.set(p.translationRecordsAtom, fn), instanceKey);
    };
}

export function createScenario(p, overrides = {}) {
    const store = createStore();
    const audio = installFakeAudio();
    const edge = fakeTtsService({ en: 'edge-en', zh_cn: 'edge-zh', ja: 'edge-ja', es: 'edge-es' });
    const google = fakeTtsService({ en: 'g-en', zh_cn: 'g-zh', ja: 'g-ja' });
    const env = {
        translateServiceInstanceList: ['google', 'bing@x1'],
        ttsServiceList: ['edge_tts', 'google_tts@abc'],
        ttsActiveService: 'edge_tts',
        favoriteLanguages: undefined,
        serviceInstanceConfigMap: {
            edge_tts: { voice: 'cfg-edge', rate: '+10%' },
            'google_tts@abc': { voice: 'cfg-google' },
        },
        ttsPluginInfo: undefined,
        builtinTtsServices: { edge_tts: edge, google_tts: google },
        invokePlugin: async () => {
            throw new Error('no plugin in this scenario');
        },
        // The user's existing AI service instances (real services/ai modules, config in the store).
        aiServiceList: ['openai_compat_ai@a1', 'gemini_ai@b2'],
        aiInstanceKey: '',
        aiServices: p.aiServices,
        ...overrides,
    };
    const voice = p.useVoice();
    voice.stop();
    store.set(p.atoms.windowType, '[SELECTION_TRANSLATE]');
    store.set(p.atoms.sourceText, 'Hello world');
    store.set(p.atoms.sourceLanguage, 'auto');
    store.set(p.atoms.targetLanguage, 'zh_cn');
    store.set(p.atoms.detectLanguage, 'en');
    let detectCalls = [];
    let detectResult = 'en';
    const runtime = p.createSelectionActionRuntime({
        store,
        atoms: p.atoms,
        getEnv: () => env,
        voice,
        synthesizeSpeech: p.synthesizeSpeech,
        detect: async (text) => {
            detectCalls.push(text);
            return detectResult;
        },
        loadAiConfig: (key) => p.configStore.get(key),
    });
    const stop = runtime.start();
    audio.reset();
    return {
        store,
        audio,
        edge,
        google,
        env,
        voice,
        runtime,
        detectCalls,
        setDetectResult: (v) => {
            detectResult = v;
        },
        set: (atomName, value) => store.set(p.atoms[atomName], value),
        publishSuccess(result, extra = {}) {
            const tracking = p.trackTranslation((fn) => store.set(p.translationRecordsAtom, fn), {
                instanceKey: 'google',
                text: store.get(p.atoms.sourceText).trim(),
                sourceLanguage: store.get(p.atoms.sourceLanguage),
                targetLanguage: store.get(p.atoms.targetLanguage),
                effectiveTargetLanguage: store.get(p.atoms.targetLanguage),
                detectLanguage: store.get(p.atoms.detectLanguage),
                ...extra,
            });
            tracking.success(result);
            return tracking;
        },
        // Palette unmount: unsubscribe and stop/invalidate palette speech only.
        dispose: stop,
        cleanup() {
            stop();
            voice.stop();
        },
    };
}
