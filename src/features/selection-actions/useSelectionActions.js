import { BaseDirectory, readTextFile } from '@tauri-apps/api/fs';
import { useAtomValue, useStore } from 'jotai';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { sourceTextAtom, detectLanguageAtom, windowTypeAtom } from '../../window/Translate/components/SourceArea';
import { sourceLanguageAtom, targetLanguageAtom } from '../../window/Translate/components/LanguageArea';
import * as builtinTtsServices from '../../services/tts';
import * as builtinAiServices from '../../services/ai';
import * as builtinTranslateServices from '../../services/translate';
import { store as configStore } from '../../utils/store';
import { emit } from '@tauri-apps/api/event';
import { getServiceName, getServiceSouceType, ServiceSourceType, whetherPluginService } from '../../utils/service_instance';
import { resolveActiveTtsInstanceKey, synthesizeSpeech } from '../../utils/tts_service';
import { invoke_plugin } from '../../utils/invoke_plugin';
import detect from '../../utils/lang_detect';
import { useConfig, useVoice } from '../../hooks';
import { FAVORITE_LANGUAGES_CONFIG_KEY, DEFAULT_FAVORITE_LANGUAGES, normalizeFavoriteLanguages } from './favorites';
import { translationRecordsAtom } from './translationRecords';
import { resolveAiSelection } from './aiActions';
import { aiResultAtom } from './aiRunner';
import {
    CUSTOM_ACTIONS_CONFIG_KEY,
    EMPTY_CUSTOM_ACTIONS,
    createCustomActionsApi,
} from './customActions';
import { createSelectionActionRuntime } from './runtime';
import { dictionaryStateAtom } from './dictionary/controller';
import { DICTIONARY_SOURCE_CONFIG_KEY } from './dictionary/sources';

// Persisted choice of the AI service instance the AI actions use (an instance key only, never a
// config or key). Empty = the first configured AI service.
export const AI_INSTANCE_CONFIG_KEY = 'selection_action_ai_instance';

const loadAiConfig = (instanceKey) => configStore.get(instanceKey);

// Display names of the AI instances (their own `instanceName`, else the service name).
function useAiInstanceLabels(instanceKeys) {
    const [labels, setLabels] = useState({});
    const signature = JSON.stringify(instanceKeys ?? []);
    useEffect(() => {
        let cancelled = false;
        Promise.all(
            (JSON.parse(signature) ?? []).map(async (key) => {
                const config = await configStore.get(key).catch(() => null);
                const name = typeof config?.instanceName === 'string' ? config.instanceName.trim() : '';
                return [key, name !== '' ? name : getServiceName(key)];
            })
        ).then((pairs) => {
            if (!cancelled) setLabels(Object.fromEntries(pairs));
        });
        return () => {
            cancelled = true;
        };
    }, [signature]);
    return labels;
}

const atoms = {
    windowType: windowTypeAtom,
    sourceText: sourceTextAtom,
    detectLanguage: detectLanguageAtom,
    sourceLanguage: sourceLanguageAtom,
    targetLanguage: targetLanguageAtom,
};

// Plugin info of the TTS instance Speak will use (same source as SourceArea/TargetArea).
function useTtsPluginInfo(instanceKey) {
    const [info, setInfo] = useState();
    useEffect(() => {
        setInfo(undefined);
        if (typeof instanceKey === 'string' && getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN) {
            let cancelled = false;
            readTextFile(`plugins/tts/${getServiceName(instanceKey)}/info.json`, { dir: BaseDirectory.AppConfig })
                .then((text) => {
                    if (!cancelled) setInfo(JSON.parse(text));
                })
                .catch(() => {});
            return () => {
                cancelled = true;
            };
        }
    }, [instanceKey]);
    return info;
}

/**
 * React binding of the selection action runtime for the Translate window.
 * Returns what the palette renders plus `run(actionId, params)` and favorite editing.
 */
export function useSelectionActions({ serviceInstanceConfigMap }) {
    const store = useStore();
    const voice = useVoice();
    const [translateServiceInstanceList] = useConfig('translate_service_list', [
        'google',
        'bing',
        'transkit_cloud_translate',
    ]);
    const [ttsServiceList] = useConfig('tts_service_list', ['transkit_cloud_tts', 'google_tts', 'edge_tts']);
    const [ttsActiveService] = useConfig('tts_active_service', 'edge_tts');
    const [aiServiceList] = useConfig('ai_service_list', ['transkit_cloud_ai']);
    const [aiInstanceKey, setAiInstanceKey] = useConfig(AI_INSTANCE_CONFIG_KEY, '');
    const aiLabels = useAiInstanceLabels(aiServiceList);
    // The stored Custom AI Actions value. Read through useConfig (kept current across windows by its
    // change event); written only by the compare-and-set commit below, never by this setter.
    const [storedCustom, setStoredCustom] = useConfig(CUSTOM_ACTIONS_CONFIG_KEY, EMPTY_CUSTOM_ACTIONS, {
        sync: false,
    });
    const [storedFavorites, setStoredFavorites] = useConfig(FAVORITE_LANGUAGES_CONFIG_KEY, DEFAULT_FAVORITE_LANGUAGES);
    const [dictionarySourcePreference, setDictionarySourcePreference] = useConfig(DICTIONARY_SOURCE_CONFIG_KEY, '');
    const favoriteLanguages = normalizeFavoriteLanguages(storedFavorites);
    const ttsInstanceKey = resolveActiveTtsInstanceKey(ttsServiceList, ttsActiveService);
    const ttsPluginInfo = useTtsPluginInfo(ttsInstanceKey);

    // Live inputs for dispatch (always the latest render's values).
    const envRef = useRef(null);
    envRef.current = {
        translateServiceInstanceList,
        ttsServiceList,
        ttsActiveService,
        favoriteLanguages: storedFavorites,
        serviceInstanceConfigMap,
        ttsPluginInfo,
        builtinTtsServices,
        invokePlugin: invoke_plugin,
        aiServiceList,
        aiInstanceKey,
        aiServices: builtinAiServices,
        customActions: storedCustom,
        dictionaryServices: builtinTranslateServices,
        dictionarySourcePreference,
    };

    const [, rerender] = useReducer((n) => n + 1, 0);
    const runtimeRef = useRef(null);
    if (!runtimeRef.current) {
        runtimeRef.current = createSelectionActionRuntime({
            store,
            atoms,
            getEnv: () => envRef.current,
            voice,
            synthesizeSpeech,
            detect,
            loadAiConfig,
        });
    }
    const runtime = runtimeRef.current;

    // Re-render on every input the context is derived from.
    useAtomValue(windowTypeAtom);
    useAtomValue(sourceTextAtom);
    useAtomValue(detectLanguageAtom);
    useAtomValue(sourceLanguageAtom);
    useAtomValue(targetLanguageAtom);
    useAtomValue(translationRecordsAtom);
    useAtomValue(aiResultAtom);
    useAtomValue(dictionaryStateAtom);

    // Speech state (pending/playing/ended) changes outside React state.
    useEffect(() => voice.subscribe(rerender), [voice]);

    // Unmount: stop and invalidate palette speech only; Source/Target playback is untouched.
    useEffect(() => runtime.start(), [runtime]);

    // Config-driven inputs of the context (TTS instance, provider list) changed.
    useEffect(() => {
        runtime.reconcile();
    }, [
        runtime,
        ttsInstanceKey,
        translateServiceInstanceList,
        serviceInstanceConfigMap,
        ttsPluginInfo,
        aiServiceList,
        aiInstanceKey,
        storedCustom,
        dictionarySourcePreference,
    ]);

    const ctx = runtime.getContext();
    const [notice, setNotice] = useState(null);

    // A notice belongs to the selection it was produced for.
    useEffect(() => {
        setNotice(null);
    }, [ctx.text, ctx.targetLanguage]);

    const run = useCallback(
        async (actionId, params) => {
            setNotice(null);
            const outcome = await runtime.dispatch(actionId, params);
            // Provider failures of AI actions are shown in the AI result panel, not as a notice.
            if (!outcome.ok && outcome.status === 'rejected') {
                setNotice({ code: outcome.code, message: outcome.message });
            }
            return outcome;
        },
        [runtime]
    );

    const selectAiInstance = useCallback(
        (key) => {
            // Only an instance that is actually configured can be chosen.
            if (typeof key === 'string' && Array.isArray(envRef.current.aiServiceList)) {
                if (envRef.current.aiServiceList.includes(key)) setAiInstanceKey(key);
            }
        },
        [setAiInstanceKey]
    );
    const retryAi = useCallback(() => runtime.retryAi(), [runtime]);
    const dismissAi = useCallback(() => runtime.dismissAi(), [runtime]);

    // Editor operations: validated against the live AI service list, applied to the value freshly read
    // from the config store, persisted only when nothing was changed in between.
    const customApiRef = useRef(null);
    if (!customApiRef.current) {
        customApiRef.current = createCustomActionsApi({
            getStore: () => configStore,
            emit,
            resolveAi: (instanceKey) =>
                resolveAiSelection({
                    aiServiceList: envRef.current.aiServiceList,
                    aiInstanceKey: instanceKey,
                    aiServices: builtinAiServices,
                    isPluginInstance: whetherPluginService,
                    serviceNameOf: getServiceName,
                }),
            onCommitted: (next) => setStoredCustom(next),
        });
    }

    const updateFavorites = useCallback(
        (next) => {
            setStoredFavorites(normalizeFavoriteLanguages(next));
        },
        [setStoredFavorites]
    );

    // Pick the dictionary source (a configured dictionary service instance): remembered in the
    // existing config store and looked up again right away.
    const selectDictionarySource = useCallback(
        (sourceKey) => {
            setDictionarySourcePreference(sourceKey);
            return run('dictionary', { sourceKey });
        },
        [run, setDictionarySourcePreference]
    );
    const dismissDictionary = useCallback(() => runtime.dictionary.dismiss(), [runtime]);

    return {
        ctx,
        dictionary: {
            state: runtime.dictionary.getState(ctx),
            sources: runtime.dictionary.sources().candidates,
            selectSource: selectDictionarySource,
            dismiss: dismissDictionary,
        },
        items: runtime.getItems(),
        activeSpeech: runtime.getActiveSpeech(),
        notice,
        run,
        favoriteLanguages,
        updateFavorites,
        custom: {
            format: ctx.customFormat,
            actions: ctx.customActions,
            unreadableCount: ctx.customUnreadable,
            ...customApiRef.current,
        },
        ai: {
            ...ctx.ai,
            instances: (ctx.ai.instances ?? []).map((key) => ({ key, label: aiLabels[key] ?? getServiceName(key) })),
            select: selectAiInstance,
            retry: retryAi,
            dismiss: dismissAi,
        },
    };
}
