import { languageList } from '../../utils/language';
import { TranslationStatus } from './translationRecords';

// Outcome codes shared by availability checks and action results. The UI translates each
// code through i18n (`selection_actions.messages.<code>`); `message` is the English fallback.
export const ActionCode = Object.freeze({
    WRONG_WINDOW: 'wrong-window',
    EMPTY_SELECTION: 'empty-selection',
    INVALID_LANGUAGE: 'invalid-language',
    NO_TRANSLATION: 'no-translation',
    TRANSLATION_PENDING: 'translation-pending',
    TRANSLATION_FAILED: 'translation-failed',
    TTS_UNCONFIGURED: 'tts-unconfigured',
    TTS_UNAVAILABLE: 'tts-unavailable',
    UNSUPPORTED_LANGUAGE: 'unsupported-language',
    SYNTH_FAILED: 'synth-failed',
    UNKNOWN_ACTION: 'unknown-action',
    SELECTION_TOO_LONG: 'selection-too-long',
    AI_NOT_CONFIGURED: 'ai-not-configured',
    AI_INSTANCE_MISSING: 'ai-instance-missing',
    AI_UNSUPPORTED_SERVICE: 'ai-unsupported-service',
    AI_FAILED: 'ai-failed',
    AI_EMPTY_RESULT: 'ai-empty-result',
    CUSTOM_ACTION_MISSING: 'custom-action-missing',
    CUSTOM_ACTION_CHANGED: 'custom-action-changed',
    CUSTOM_OUTPUT_UNSUPPORTED: 'custom-output-unsupported',
});

const MESSAGES = {
    [ActionCode.WRONG_WINDOW]: 'Selection actions are only available for selected text.',
    [ActionCode.EMPTY_SELECTION]: 'No selected text.',
    [ActionCode.INVALID_LANGUAGE]: 'Unsupported language.',
    [ActionCode.NO_TRANSLATION]: 'No translation yet.',
    [ActionCode.TRANSLATION_PENDING]: 'Translation in progress.',
    [ActionCode.TRANSLATION_FAILED]: 'Translation failed.',
    [ActionCode.TTS_UNCONFIGURED]: 'No TTS service configured.',
    [ActionCode.TTS_UNAVAILABLE]: 'The TTS service is not available.',
    [ActionCode.UNSUPPORTED_LANGUAGE]: 'The TTS service does not support this language.',
    [ActionCode.SYNTH_FAILED]: 'Speech synthesis failed.',
    [ActionCode.UNKNOWN_ACTION]: 'Unknown action.',
    [ActionCode.SELECTION_TOO_LONG]: 'The selection is too long for an AI action.',
    [ActionCode.AI_NOT_CONFIGURED]: 'No AI service is configured.',
    [ActionCode.AI_INSTANCE_MISSING]: 'The chosen AI service is no longer configured. Choose another one.',
    [ActionCode.AI_UNSUPPORTED_SERVICE]: 'This AI service cannot run selection actions.',
    [ActionCode.AI_FAILED]: 'The AI service returned an error.',
    [ActionCode.AI_EMPTY_RESULT]: 'The AI service returned an empty result.',
    [ActionCode.CUSTOM_ACTION_MISSING]: 'This custom action no longer exists.',
    [ActionCode.CUSTOM_ACTION_CHANGED]: 'This custom action was changed. Run it again from the updated list.',
    [ActionCode.CUSTOM_OUTPUT_UNSUPPORTED]: 'This custom action uses an output mode that is not supported.',
};

export const messageFor = (code) => MESSAGES[code] ?? String(code);
export const rejected = (code, detail) => ({
    ok: false,
    status: 'rejected',
    code,
    message: detail ? `${messageFor(code)} ${detail}` : messageFor(code),
});
export const accepted = (status) => ({ ok: true, status });

const available = { enabled: true };
export const unavailable = (code) => ({ enabled: false, code, reason: messageFor(code) });

/**
 * Data-driven action registry. An action definition is:
 *   id, group, order,
 *   labelKey / defaultLabel  - i18n key and English fallback of the action
 *   expand(ctx)              - optional; the palette entries of this action (default: one),
 *                              each { key, params, label?, active? }
 *   availability(ctx, params)- { enabled, code?, reason? }
 *   run(ctx, params, env)    - Promise<outcome>; env is supplied by the runtime
 * Later features (dictionary, AI actions) register further definitions; the palette and
 * the dispatcher do not change.
 */
export function createActionRegistry(definitions = []) {
    const actions = new Map();
    const register = (definition) => {
        if (!definition || typeof definition.id !== 'string' || typeof definition.run !== 'function') {
            throw new TypeError('Invalid selection action definition');
        }
        actions.set(definition.id, definition);
    };
    definitions.forEach(register);
    return {
        register,
        get: (id) => actions.get(id) ?? null,
        list: () => [...actions.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        // Palette entries for the current context, grouped/ordered by the registry.
        items(ctx) {
            const items = [];
            for (const action of this.list()) {
                const entries = action.expand ? action.expand(ctx) : [{ key: action.id, params: {} }];
                for (const entry of entries) {
                    const state = action.availability(ctx, entry.params ?? {});
                    items.push({
                        key: entry.key,
                        actionId: action.id,
                        group: action.group,
                        params: entry.params ?? {},
                        labelKey: action.labelKey,
                        label: entry.label ?? action.defaultLabel,
                        active: Boolean(entry.active),
                        enabled: state.enabled,
                        code: state.code,
                        reason: state.reason,
                    });
                }
            }
            return items;
        },
    };
}

// Re-check against the *current* context at dispatch time, then run. A stale palette item
// (rendered for an older selection) therefore can never act on the new one.
export async function dispatchAction(registry, actionId, params, ctx, env) {
    const action = registry.get(actionId);
    if (!action) return rejected(ActionCode.UNKNOWN_ACTION);
    const state = action.availability(ctx, params ?? {});
    if (!state.enabled) return rejected(state.code);
    return action.run(ctx, params ?? {}, env);
}

export const requireSelection = (ctx) => {
    if (!ctx.isSelectionWindow) return unavailable(ActionCode.WRONG_WINDOW);
    if (!ctx.hasText) return unavailable(ActionCode.EMPTY_SELECTION);
    return available;
};

export const translateAction = {
    id: 'translate',
    group: 'translate',
    order: 10,
    labelKey: 'selection_actions.translate',
    defaultLabel: 'Translate',
    // One entry per favorite target language, in the user's configured order.
    expand: (ctx) =>
        ctx.favoriteLanguages.map((language) => ({
            key: `translate:${language}`,
            params: { language },
            active: ctx.targetLanguage === language,
        })),
    availability(ctx, params) {
        const base = requireSelection(ctx);
        if (!base.enabled) return base;
        if (typeof params.language !== 'string' || !languageList.includes(params.language)) {
            return unavailable(ActionCode.INVALID_LANGUAGE);
        }
        return available;
    },
    async run(ctx, params, env) {
        if (ctx.targetLanguage !== params.language) {
            // The existing Translate window reacts to the target-language change and
            // translates through its providers; no second provider path exists here.
            env.setTargetLanguage(params.language);
            return accepted('started');
        }
        // Already the target: do not spam the provider while a request is running or done.
        if (
            ctx.translation.status === TranslationStatus.LOADING ||
            ctx.translation.status === TranslationStatus.SUCCESS
        ) {
            return accepted('unchanged');
        }
        env.requestRetranslate();
        return accepted('started');
    },
};

export const speakOriginalAction = {
    id: 'speak_original',
    group: 'speak',
    order: 20,
    labelKey: 'selection_actions.speak_original',
    defaultLabel: 'Speak original',
    availability: requireSelection,
    run: (ctx, _params, env) => env.speakOriginal(ctx),
};

export const speakTranslationAction = {
    id: 'speak_translation',
    group: 'speak',
    order: 30,
    labelKey: 'selection_actions.speak_translation',
    defaultLabel: 'Speak translation',
    availability(ctx) {
        const base = requireSelection(ctx);
        if (!base.enabled) return base;
        if (ctx.translation.speakable) return available;
        switch (ctx.translation.status) {
            case TranslationStatus.LOADING:
                return unavailable(ActionCode.TRANSLATION_PENDING);
            case TranslationStatus.ERROR:
                return unavailable(ActionCode.TRANSLATION_FAILED);
            default:
                return unavailable(ActionCode.NO_TRANSLATION);
        }
    },
    run: (ctx, _params, env) => env.speakTranslation(ctx),
};

// Dictionary lookup of the selected word / short phrase. Runs through the dictionary controller
// (real dictionary sources, source-attributed result); unsupported input or language is a visible
// result state of that controller, not an action rejection.
export const dictionaryAction = {
    id: 'dictionary',
    group: 'dictionary',
    order: 15,
    labelKey: 'selection_actions.dictionary',
    defaultLabel: 'Dictionary',
    availability: requireSelection,
    run: (ctx, params, env) => env.lookupDictionary(ctx, params),
};

// `extraDefinitions` lets feature slices (AI actions, ...) register without editing this list.
export const createSelectionActionRegistry = (extraDefinitions = []) =>
    createActionRegistry([
        translateAction,
        dictionaryAction,
        speakOriginalAction,
        speakTranslationAction,
        ...extraDefinitions,
    ]);
