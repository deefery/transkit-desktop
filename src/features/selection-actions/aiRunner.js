import { atom } from 'jotai';

import { ActionCode, accepted, rejected } from './registry';
import { buildAiRequest, isAiResultCurrent } from './aiActions';

// The result of the latest AI action, bound to the request-time selection / target language /
// AI service instance. Nothing secret is ever stored in it (no config, no key).
export const aiResultAtom = atom(null);

export const AiStatus = Object.freeze({ LOADING: 'loading', SUCCESS: 'success', ERROR: 'error' });

const MAX_ERROR_LENGTH = 300;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Provider error text for display: bounded, and never echoing the instance's own API key.
export function describeError(error, config) {
    let text = error instanceof Error ? error.message : String(error ?? '');
    const apiKey = config?.apiKey;
    if (typeof apiKey === 'string' && apiKey.length >= 6) text = text.split(apiKey).join('***');
    text = text.trim();
    return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text;
}

// Instance label shown next to a result: the user's instance name, else the service name.
const instanceLabel = (config, serviceName) =>
    typeof config?.instanceName === 'string' && config.instanceName.trim() !== ''
        ? config.instanceName.trim()
        : serviceName;

/**
 * Call the `summarize(text, { config })` contract of an existing AI service with the action's
 * instruction as the system prompt. The instance's own config (endpoint, model, key, ...) is read
 * live and passed through unchanged; only `systemPrompt` is overlaid for this one call and nothing
 * is written back, the same way polishTranscript / generateAiSuggestion call these services.
 */
export function invokeAiService(module, serviceName, userText, config, systemPrompt) {
    const base = isRecord(config) ? config : {};
    const callConfig = { ...base, systemPrompt };
    const options = { config: callConfig };
    // local_sidecar_ai builds its messages from its stored `promptList` template (or a default prompt)
    // and ignores `systemPrompt`, and it substitutes `$text` in every template entry. Pass the
    // instruction as its explicit per-call override so instruction and selection reach it verbatim
    // whatever the stored promptList is; the stored config itself is not touched.
    if (serviceName === 'local_sidecar_ai') options.actionInstruction = systemPrompt;
    return module.summarize(userText, options);
}

/**
 * Shared runner of the AI selection actions.
 *
 * - `store`: the jotai store of the Translate window (result state lives in `aiResultAtom`).
 * - `getEnv()`: { aiServices } - the existing built-in AI service modules (services/ai).
 * - `getContext()`: the freshly derived action context; a completion is only published while its
 *   request-time snapshot still matches it.
 * - `loadConfig(instanceKey)`: the instance's config from the existing store (store.get).
 *
 * A monotonic generation guards every completion: a newer request, a context change (see
 * `reconcile`), dismissal or `dispose` bumps it, and an older provider completion is then dropped
 * without touching state. The provider request itself cannot be aborted (summarize() takes no
 * signal), so "cancel" means "ignore the answer".
 */
export function createAiRunner({ store, getEnv, getContext, loadConfig }) {
    let generation = 0;

    const setResult = (value) => store.set(aiResultAtom, value);
    const getResult = () => store.get(aiResultAtom);

    async function run(ctx, request, { force = false } = {}) {
        const built = buildAiRequest(ctx, request);
        if (!built.ok) return rejected(built.code);
        // A custom action names its own AI service instance; the built-in actions use the palette's.
        const ai = built.ai ?? ctx.ai;
        if (!ai || ai.status !== 'ready') return rejected(ai?.code ?? ActionCode.AI_NOT_CONFIGURED);
        const aiServices = getEnv().aiServices;
        const module = aiServices?.[ai.serviceName];
        if (typeof module?.summarize !== 'function') return rejected(ActionCode.AI_UNSUPPORTED_SERVICE);

        const preset = request.preset ?? null;
        // The built-in instructions are written for the text's languages, so a result depends on all of
        // them (C-AI-001). A custom instruction is the user's own text and uses none of them; it
        // depends on the stored version of that action instead.
        const custom = built.custom ?? null;
        const languages = custom ? [null, null, null] : [ctx.targetLanguage, ctx.sourceLanguage, ctx.originalLanguage];
        const intent = JSON.stringify([
            request.actionId,
            preset,
            ai.instanceKey,
            ctx.text,
            ...languages,
            custom?.id ?? null,
            custom?.revision ?? null,
        ]);
        const current = getResult();
        if (
            !force &&
            current?.intent === intent &&
            current.status !== AiStatus.ERROR &&
            isAiResultCurrent(ctx, current)
        ) {
            return accepted('unchanged');
        }

        generation += 1;
        const token = generation;
        const snapshot = {
            requestId: token,
            intent,
            actionId: request.actionId,
            preset,
            labelKey: built.labelKey,
            defaultLabel: built.defaultLabel,
            outputKind: built.outputKind,
            customId: custom?.id ?? null,
            customRevision: custom?.revision ?? null,
            instanceKey: ai.instanceKey,
            serviceName: ai.serviceName,
            instanceLabel: ai.serviceName,
            model: '',
            text: ctx.text,
            targetLanguage: ctx.targetLanguage,
            sourceLanguage: ctx.sourceLanguage,
            originalLanguage: ctx.originalLanguage,
            status: AiStatus.LOADING,
            output: '',
            errorCode: null,
            error: '',
        };
        setResult(snapshot);

        // A completion counts only for the latest request whose selection / target language /
        // AI service instance are still the current ones.
        const isLive = () => token === generation && isAiResultCurrent(getContext(), snapshot);
        let config = null;
        let meta = {};
        try {
            config = await loadConfig(ai.instanceKey);
            if (!isLive()) return accepted('superseded');
            meta = {
                instanceLabel: instanceLabel(config, ai.serviceName),
                model: typeof config?.model === 'string' ? config.model : '',
            };
            const output = await invokeAiService(module, ai.serviceName, built.userText, config, built.systemPrompt);
            if (!isLive()) return accepted('superseded');
            const text = typeof output === 'string' ? output.trim() : '';
            if (text === '') {
                setResult({ ...snapshot, ...meta, status: AiStatus.ERROR, errorCode: ActionCode.AI_EMPTY_RESULT });
                return { ok: false, status: 'failed', code: ActionCode.AI_EMPTY_RESULT };
            }
            setResult({ ...snapshot, ...meta, status: AiStatus.SUCCESS, output: text });
            return accepted('success');
        } catch (error) {
            if (!isLive()) return accepted('superseded');
            const detail = describeError(error, config);
            setResult({ ...snapshot, ...meta, status: AiStatus.ERROR, errorCode: ActionCode.AI_FAILED, error: detail });
            return { ok: false, status: 'failed', code: ActionCode.AI_FAILED, detail };
        }
    }

    // Drop the result (and ignore any pending completion) when it no longer matches `ctx`.
    function reconcile(ctx) {
        const result = getResult();
        if (result && !isAiResultCurrent(ctx, result)) {
            generation += 1;
            setResult(null);
        }
    }

    // User dismissed the result panel.
    function dismiss() {
        generation += 1;
        setResult(null);
    }

    return { run, reconcile, dismiss, dispose: dismiss, getResult };
}
