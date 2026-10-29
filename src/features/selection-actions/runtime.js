import { getServiceName, whetherPluginService } from '../../utils/service_instance';
import { aiActionDefinitions, isAiResultCurrent, resolveAiSelection } from './aiActions';
import { CUSTOM_AI_ACTION_ID, readCustomActions } from './customActions';
import { aiResultAtom, createAiRunner } from './aiRunner';
import { deriveActionContext } from './context';
import { createDictionaryController } from './dictionary/controller';
import { createSelectionActionRegistry, dispatchAction } from './registry';
import { createSelectionSpeech } from './speech';
import { retranslateNonceAtom, translationRecordsAtom } from './translationRecords';

// The dispatch parameters that reproduce the action a result came from.
function retryParams(result) {
    if (result.actionId === CUSTOM_AI_ACTION_ID) {
        return { customId: result.customId, revision: result.customRevision };
    }
    return result.preset ? { preset: result.preset } : {};
}

/**
 * Connects the registry to the live Translate window state without keeping a copy of it.
 *
 * - `store` is the jotai store the Translate window renders with (`useStore()`); `atoms` are the
 *   existing SourceArea/LanguageArea atoms. Every read happens at call time, so dispatch always
 *   sees the current selection/language/provider, never a value captured at render time.
 * - `getEnv()` supplies the live useConfig / service-instance inputs (kept in React state):
 *   { translateServiceInstanceList, ttsServiceList, ttsActiveService, favoriteLanguages,
 *     serviceInstanceConfigMap, ttsPluginInfo, builtinTtsServices, invokePlugin,
 *     aiServiceList, aiInstanceKey, aiServices, customActions }  (ai_service_list, the persisted AI
 *     instance choice, the built-in services/ai modules and the stored custom AI actions value),
 *     dictionaryServices, dictionarySourcePreference }.
 * - `loadAiConfig(instanceKey)` reads an AI instance's config from the existing store.
 * - Translation itself stays in TargetArea/existing providers; Translate only changes the target
 *   language (or bumps the retranslate nonce). Speech goes through the existing TTS helper and
 *   the shared popup playback owner. AI actions run through the shared AI runner over the
 *   user's existing AI service instances.
 */
export function createSelectionActionRuntime({
    store,
    atoms,
    getEnv,
    voice,
    synthesizeSpeech,
    detect,
    loadAiConfig = async () => null,
    registry = createSelectionActionRegistry(aiActionDefinitions),
}) {
    const getContext = () => {
        const env = getEnv();
        const base = deriveActionContext({
            windowType: store.get(atoms.windowType),
            sourceText: store.get(atoms.sourceText),
            detectLanguage: store.get(atoms.detectLanguage),
            sourceLanguage: store.get(atoms.sourceLanguage),
            targetLanguage: store.get(atoms.targetLanguage),
            translateServiceInstanceList: env.translateServiceInstanceList,
            translationRecords: store.get(translationRecordsAtom),
            ttsServiceList: env.ttsServiceList,
            ttsActiveService: env.ttsActiveService,
            favoriteLanguages: env.favoriteLanguages,
        });
        const resolveAi = (aiInstanceKey) =>
            resolveAiSelection({
                aiServiceList: env.aiServiceList,
                aiInstanceKey,
                aiServices: env.aiServices,
                isPluginInstance: whetherPluginService,
                serviceNameOf: getServiceName,
            });
        const selection = resolveAi(env.aiInstanceKey);
        // Custom actions as stored right now, each with the state of the AI service instance it
        // names (a missing / unsupported instance is reported, never replaced by another one).
        const stored = readCustomActions(env.customActions);
        const customActions = stored.actions.map((action) => ({
            ...action,
            ai: action.problem ? null : resolveAi(action.instanceKey),
        }));
        const ctx = { ...base, ai: selection, customActions, customFormat: stored.format, customUnreadable: stored.unreadable.length };
        // Only a result that still belongs to this selection / target / AI service is visible.
        const result = store.get(aiResultAtom);
        ctx.ai = { ...selection, result: isAiResultCurrent(ctx, result) ? result : null };
        return ctx;
    };

    const speech = createSelectionSpeech({ voice, synthesizeSpeech, detect, getContext, getEnv });
    const ai = createAiRunner({ store, getEnv, getContext, loadConfig: loadAiConfig });
    const dictionary = createDictionaryController({ store, getContext, getEnv, detect });

    const actionEnv = {
        setTargetLanguage: (language) => store.set(atoms.targetLanguage, language),
        requestRetranslate: () => store.set(retranslateNonceAtom, (n) => n + 1),
        speakOriginal: (ctx) => speech.speakOriginal(ctx),
        speakTranslation: (ctx) => speech.speakTranslation(ctx),
        runAi: (ctx, request) => ai.run(ctx, request),
        lookupDictionary: (ctx, params) => dictionary.lookup(ctx, params),
    };

    return {
        getContext,
        getItems: () => registry.items(getContext()),
        dispatch: (actionId, params) => dispatchAction(registry, actionId, params, getContext(), actionEnv),
        reconcile: () => {
            speech.reconcile();
            ai.reconcile(getContext());
            dictionary.reconcile();
        },
        retryAi: () => {
            const result = ai.getResult();
            const ctx = getContext();
            return result && isAiResultCurrent(ctx, result)
                ? dispatchAction(registry, result.actionId, retryParams(result), ctx, {
                      ...actionEnv,
                      runAi: (c, request) => ai.run(c, request, { force: true }),
                  })
                : Promise.resolve(null);
        },
        dismissAi: () => ai.dismiss(),
        dictionary,
        getActiveSpeech: () => speech.getActive(),
        // Any change of what palette speech depends on stops speech that is no longer current.
        // Returns the cleanup (unsubscribe + stop/invalidate palette speech), e.g. for unmount.
        start() {
            const unsubscribers = [
                atoms.windowType,
                atoms.sourceText,
                atoms.detectLanguage,
                atoms.sourceLanguage,
                atoms.targetLanguage,
                translationRecordsAtom,
            ].map((atom) =>
                store.sub(atom, () => {
                    speech.reconcile();
                    ai.reconcile(getContext());
                    dictionary.reconcile();
                })
            );
            return () => {
                unsubscribers.forEach((unsubscribe) => unsubscribe());
                speech.dispose();
                ai.dispose();
                dictionary.dispose();
            };
        },
    };
}
