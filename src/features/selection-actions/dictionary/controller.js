import { atom } from 'jotai';
import { accepted } from '../registry';
import { classifyDictionaryInput, InputKind } from './input';
import { DictionaryError, DictionaryErrorCode } from './result';
import { checkSourceSupport, DICTIONARY_SOURCES, resolveDictionarySources, runDictionaryLookup } from './sources';

export const DictionaryStatus = Object.freeze({
    IDLE: 'idle',
    LOADING: 'loading',
    SUCCESS: 'success',
    ERROR: 'error',
});

// Observable lookup state, shared by the controller and the palette:
//   { status: 'idle' }
//   { status, requestId, snapshot, sourceKey, sourceId, result?, error? }
// `snapshot` is what the lookup was made for (text/languages/source); the state is only shown
// while it still equals the live context.
export const dictionaryStateAtom = atom({ status: DictionaryStatus.IDLE });

const IDLE = Object.freeze({ status: DictionaryStatus.IDLE });

const errorState = (code, detail, extra = {}) => ({
    code,
    detail: detail ?? '',
    // Longer text is a sentence; point at Sentence Analysis but never produce dictionary output for it.
    suggestSentenceAnalysis: code === DictionaryErrorCode.TOO_LONG,
    ...extra,
});

/**
 * Does `snapshot` (a lookup's request-time inputs) still describe the live context?
 * A language that is still being detected never invalidates; a different one does.
 * `candidateKeys` are the currently available dictionary source instance keys.
 */
export function isLookupCurrent(ctx, snapshot, candidateKeys) {
    if (!snapshot || !ctx.isSelectionWindow || !ctx.hasText) return false;
    if (ctx.text !== snapshot.text) return false;
    if (ctx.sourceLanguage !== snapshot.sourceLanguage || ctx.targetLanguage !== snapshot.targetLanguage) return false;
    if (ctx.originalLanguage && snapshot.from && ctx.originalLanguage !== snapshot.from) return false;
    // Choosing another source only affects the next lookup, but a source that is no longer
    // available (removed from the configured services) can no longer vouch for its result.
    return Array.isArray(candidateKeys) && candidateKeys.includes(snapshot.sourceKey);
}

/**
 * Dictionary lookups for the selection palette. Reads the live context and config at call and
 * completion time (never captured copies); a monotonic request id plus the snapshot check make
 * every late completion a no-op, so an old selection can never replace the current one.
 *
 * `getEnv()` -> { translateServiceInstanceList, serviceInstanceConfigMap, dictionarySourcePreference,
 *                 dictionaryServices (the translate service modules) }
 */
export function createDictionaryController({ store, getContext, getEnv, detect }) {
    let generation = 0;

    const sourcesFor = (preference) => {
        const env = getEnv();
        return resolveDictionarySources({
            translateServiceInstanceList: env.translateServiceInstanceList,
            preference: preference ?? env.dictionarySourcePreference,
        });
    };
    const candidateKeys = () => sourcesFor().candidates.map((c) => c.key);
    const publish = (state) => store.set(dictionaryStateAtom, state);

    async function lookup(ctx, params = {}) {
        const existing = store.get(dictionaryStateAtom);
        const requested = sourcesFor(params.sourceKey).selected.key;
        // Same request already running: do not restart it (and do not hit the provider again).
        if (
            existing.status === DictionaryStatus.LOADING &&
            existing.snapshot.sourceKey === requested &&
            isLookupCurrent(ctx, existing.snapshot, candidateKeys())
        ) {
            return accepted('unchanged');
        }
        generation += 1;
        const requestId = generation;
        const { selected, candidates } = sourcesFor(params.sourceKey);
        const env = getEnv();
        const input = classifyDictionaryInput(ctx.text);
        const base = {
            requestId,
            sourceKey: selected.key,
            sourceId: selected.id,
            candidates: candidates.map((c) => c.key),
        };
        const snapshot = {
            text: ctx.text,
            query: input.query,
            sourceLanguage: ctx.sourceLanguage,
            targetLanguage: ctx.targetLanguage,
            from: ctx.originalLanguage,
            to: ctx.targetLanguage,
            sourceKey: selected.key,
        };
        // A newer request (or context change) makes this one stale: do not publish anything.
        const isCurrent = () => requestId === generation && isLookupCurrent(getContext(), snapshot, candidateKeys());
        const fail = (code, detail) =>
            publish({ ...base, status: DictionaryStatus.ERROR, snapshot, error: errorState(code, detail) });

        if (input.kind === InputKind.TOO_LONG) {
            fail(DictionaryErrorCode.TOO_LONG);
            return accepted('completed');
        }
        if (input.kind !== InputKind.WORD && input.kind !== InputKind.PHRASE) {
            fail(DictionaryErrorCode.UNSUPPORTED_INPUT);
            return accepted('completed');
        }

        publish({ ...base, status: DictionaryStatus.LOADING, snapshot });
        try {
            const source = DICTIONARY_SOURCES[selected.id];
            // Language of exactly this text: declared/detected from the context, else detect now.
            let from = ctx.originalLanguage;
            if (!from) {
                from = await detect(ctx.text);
                if (!isCurrent()) return accepted('stale');
                snapshot.from = typeof from === 'string' && from !== '' ? from : null;
                from = snapshot.from;
            }
            const unsupported = checkSourceSupport(source, { inputKind: input.kind, from, to: ctx.targetLanguage });
            if (unsupported) throw unsupported;
            const result = await runDictionaryLookup({
                source,
                services: env.dictionaryServices,
                query: input.query,
                from,
                to: ctx.targetLanguage,
                config: env.serviceInstanceConfigMap?.[selected.key] ?? {},
            });
            if (!isCurrent()) return accepted('stale');
            publish({ ...base, status: DictionaryStatus.SUCCESS, snapshot, result });
            return accepted('completed');
        } catch (error) {
            if (!isCurrent()) return accepted('stale');
            const dictionaryError =
                error instanceof DictionaryError
                    ? error
                    : new DictionaryError(DictionaryErrorCode.PROVIDER_FAILED, String(error?.message ?? error));
            fail(dictionaryError.code, dictionaryError.detail);
            return accepted('completed');
        }
    }

    return {
        lookup,
        // The state to show for `ctx`: the published one while its snapshot is still current.
        getState(ctx) {
            const state = store.get(dictionaryStateAtom);
            if (state.status === DictionaryStatus.IDLE) return IDLE;
            return isLookupCurrent(ctx, state.snapshot, candidateKeys()) ? state : IDLE;
        },
        // Call on every relevant context/config change: drops state that is no longer current and
        // invalidates its in-flight request.
        reconcile() {
            const state = store.get(dictionaryStateAtom);
            if (state.status === DictionaryStatus.IDLE) return;
            if (!isLookupCurrent(getContext(), state.snapshot, candidateKeys())) {
                generation += 1;
                publish(IDLE);
            }
        },
        dismiss() {
            generation += 1;
            publish(IDLE);
        },
        dispose() {
            generation += 1;
            publish(IDLE);
        },
        sources: (preference) => sourcesFor(preference),
    };
}
