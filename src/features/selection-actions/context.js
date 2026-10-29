import { languageList } from '../../utils/language';
import { resolveActiveTtsInstanceKey } from '../../utils/tts_service';
import { DEFAULT_FAVORITE_LANGUAGES, normalizeFavoriteLanguages } from './favorites';
import { TranslationStatus } from './translationRecords';

export const SELECTION_WINDOW_TYPE = '[SELECTION_TRANSLATE]';

const isLanguageCode = (value) => typeof value === 'string' && languageList.includes(value);

/**
 * Derive the action context from the values the Translate window already owns (jotai atoms
 * and useConfig state). Nothing here is stored: the context is recomputed from the current
 * inputs every time, so it can never drift from what the window shows.
 *
 * Malformed inputs (non-string text, unknown language codes, non-array lists) degrade to
 * "not available" instead of throwing.
 */
export function deriveActionContext({
    windowType,
    sourceText,
    detectLanguage,
    sourceLanguage,
    targetLanguage,
    translateServiceInstanceList,
    translationRecords,
    ttsServiceList,
    ttsActiveService,
    favoriteLanguages,
}) {
    const rawText = typeof sourceText === 'string' ? sourceText : '';
    const text = rawText.trim();
    const detected = isLanguageCode(detectLanguage) ? detectLanguage : '';
    const declaredSource = isLanguageCode(sourceLanguage) ? sourceLanguage : sourceLanguage === 'auto' ? 'auto' : null;
    const target = isLanguageCode(targetLanguage) ? targetLanguage : null;

    // Same inputs the Translate request is made from: only a record whose request-time
    // snapshot equals the current context (and whose provider is still configured) counts.
    let record = null;
    if (translationRecords && typeof translationRecords === 'object' && Array.isArray(translateServiceInstanceList)) {
        for (const candidate of Object.values(translationRecords)) {
            if (
                candidate &&
                translateServiceInstanceList.includes(candidate.instanceKey) &&
                candidate.text === text &&
                candidate.sourceLanguage === sourceLanguage &&
                candidate.targetLanguage === targetLanguage &&
                (!record || candidate.requestId > record.requestId)
            ) {
                record = candidate;
            }
        }
    }
    const speakable =
        record?.status === TranslationStatus.SUCCESS &&
        record.speakText !== '' &&
        isLanguageCode(record.effectiveTargetLanguage);

    return {
        windowType,
        isSelectionWindow: windowType === SELECTION_WINDOW_TYPE,
        rawText,
        text,
        hasText: text !== '',
        sourceLanguage: declaredSource,
        detectLanguage: detected,
        // Language of the original text: the declared source language, else the detected one.
        // null = still unknown (Speak Original detects it on demand).
        originalLanguage: declaredSource && declaredSource !== 'auto' ? declaredSource : detected || null,
        targetLanguage: target,
        translation: {
            status: record ? record.status : 'none',
            record,
            speakable,
            instanceKey: record?.instanceKey ?? null,
            speakText: speakable ? record.speakText : '',
            language: speakable ? record.effectiveTargetLanguage : null,
            error: record?.status === TranslationStatus.ERROR ? record.error : '',
        },
        tts: {
            instanceKey: resolveActiveTtsInstanceKey(
                Array.isArray(ttsServiceList) ? ttsServiceList : null,
                ttsActiveService
            ),
        },
        favoriteLanguages: normalizeFavoriteLanguages(favoriteLanguages ?? DEFAULT_FAVORITE_LANGUAGES),
    };
}
