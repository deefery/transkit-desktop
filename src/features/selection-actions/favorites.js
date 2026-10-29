import { languageList } from '../../utils/language';

// Persisted through the existing useConfig/store mechanism.
export const FAVORITE_LANGUAGES_CONFIG_KEY = 'selection_action_favorite_languages';
export const DEFAULT_FAVORITE_LANGUAGES = ['zh_cn', 'en', 'ja', 'es'];
export const MAX_FAVORITE_LANGUAGES = 8;

const isLanguage = (value) => typeof value === 'string' && languageList.includes(value);

// Turn whatever is stored (missing, null, wrong type, unknown codes, duplicates) into a
// usable ordered list. Never throws and never mutates the input. An unusable value falls
// back to the defaults; nothing is written back here, so unrelated config stays untouched.
export function normalizeFavoriteLanguages(value) {
    if (!Array.isArray(value)) return [...DEFAULT_FAVORITE_LANGUAGES];
    const result = [];
    for (const item of value) {
        if (isLanguage(item) && !result.includes(item)) result.push(item);
        if (result.length >= MAX_FAVORITE_LANGUAGES) break;
    }
    return result.length > 0 ? result : [...DEFAULT_FAVORITE_LANGUAGES];
}

// Edit helpers return a new normalized list (or the unchanged one when the edit is invalid).
export function addFavoriteLanguage(list, language) {
    const current = normalizeFavoriteLanguages(list);
    if (!isLanguage(language) || current.includes(language) || current.length >= MAX_FAVORITE_LANGUAGES) {
        return current;
    }
    return [...current, language];
}

// The list must never become empty: removing the last favorite is a no-op.
export function removeFavoriteLanguage(list, language) {
    const current = normalizeFavoriteLanguages(list);
    if (current.length <= 1 || !current.includes(language)) return current;
    return current.filter((x) => x !== language);
}

export function moveFavoriteLanguage(list, language, offset) {
    const current = normalizeFavoriteLanguages(list);
    const from = current.indexOf(language);
    const to = from + offset;
    if (from < 0 || !Number.isInteger(offset) || to < 0 || to >= current.length) return current;
    const next = [...current];
    next.splice(from, 1);
    next.splice(to, 0, language);
    return next;
}

export function availableFavoriteCandidates(list) {
    const current = normalizeFavoriteLanguages(list);
    return languageList.filter((x) => !current.includes(x));
}
