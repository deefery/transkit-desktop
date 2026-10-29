import { atom } from 'jotai';

// What the mounted TargetArea publishes about its translation request. The record is bound to
// the request-time text / languages / provider, so consumers can tell whether a result still
// belongs to the current selection context before using it (e.g. to speak it).
//
// instanceKey -> record
export const translationRecordsAtom = atom({});

// Bumped by the Translate action to re-run the translation for an unchanged context
// (retry after an error). TargetArea lists it in its translation effect dependencies.
export const retranslateNonceAtom = atom(0);

let sequence = 0;

export const TranslationStatus = Object.freeze({
    LOADING: 'loading',
    SUCCESS: 'success',
    ERROR: 'error',
});

// Plain text of a provider result: string results as-is, dictionary-style results through
// their `translation` field. Anything else is not speakable text.
export function resultToText(result) {
    const value = typeof result === 'string' ? result : result?.translation;
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Start tracking one translation request for `instanceKey`; replaces any older record of the
 * same instance. `setRecords` is a jotai-style updater (accepts a function).
 * The returned handle only affects the record while this request is still the latest one.
 */
export function trackTranslation(
    setRecords,
    { instanceKey, text, sourceLanguage, targetLanguage, effectiveTargetLanguage, detectLanguage }
) {
    sequence += 1;
    const requestId = sequence;
    const base = {
        requestId,
        instanceKey,
        text,
        sourceLanguage,
        targetLanguage,
        effectiveTargetLanguage: effectiveTargetLanguage ?? targetLanguage,
        detectLanguage: detectLanguage ?? '',
    };
    const write = (patch) =>
        setRecords((records) => {
            const latest = records?.[instanceKey];
            // First write of this request, or an update of this very request only.
            if (patch.status !== TranslationStatus.LOADING && latest?.requestId !== requestId) return records;
            return { ...records, [instanceKey]: { ...base, ...patch } };
        });
    write({ status: TranslationStatus.LOADING, speakText: '', error: '' });
    return {
        requestId,
        success(result) {
            write({ status: TranslationStatus.SUCCESS, speakText: resultToText(result), error: '' });
        },
        failure(error) {
            write({ status: TranslationStatus.ERROR, speakText: '', error: String(error ?? '') });
        },
    };
}

// Drop the record of an instance (unmount, translate-back changed the visible result, ...).
export function clearTranslationRecord(setRecords, instanceKey) {
    setRecords((records) => {
        if (!records || !(instanceKey in records)) return records;
        const { [instanceKey]: _removed, ...rest } = records;
        return rest;
    });
}
