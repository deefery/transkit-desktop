// Canonical first-run defaults for config keys that several components read.
//
// `useConfig(key, default)` writes its caller's default to the store when the key is missing, so
// when two components pass different defaults the value a new user ends up with depends on which
// window happened to read the key first. Keys listed here have one canonical default: the store is
// seeded with it before any window renders, and `useConfig` falls back to it instead of the
// caller's value. Existing stored values are never changed.
//
// Keep this module free of Tauri imports so it can be tested in plain Node.

export const SERVICE_LIST_DEFAULTS = Object.freeze({
    translate_service_list: ['bing', 'google', 'transkit_cloud_translate'],
    recognize_service_list: ['system', 'tesseract'],
    tts_service_list: ['edge_tts', 'google_tts', 'transkit_cloud_tts'],
    transcription_service_list: ['transkit_cloud_stt', 'deepgram_stt'],
    ai_service_list: ['transkit_cloud_ai'],
});

export const CONFIG_DEFAULTS = Object.freeze({
    ...SERVICE_LIST_DEFAULTS,
    translate_source_language: 'auto',
    translate_target_language: 'zh_cn',
    translate_second_language: 'en',
    history_disable: false,
    tts_active_service: 'edge_tts',
    // Empty means "not chosen yet": Monitor and Voice Anywhere fall back on their own.
    transcription_active_service: '',
});

const clone = (value) => (value !== null && typeof value === 'object' ? structuredClone(value) : value);

export function hasConfigDefault(key) {
    return Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key);
}

/** The default `useConfig` should use for `key`: the canonical one when listed, else the caller's. */
export function resolveConfigDefault(key, callerDefault) {
    return hasConfigDefault(key) ? clone(CONFIG_DEFAULTS[key]) : callerDefault;
}

/**
 * Writes every canonical default whose key is missing (null) in `store`. Returns true when anything
 * was written; the caller decides when to save.
 */
export async function seedConfigDefaults(store) {
    let changed = false;
    for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
        if ((await store.get(key)) === null) {
            await store.set(key, clone(value));
            changed = true;
        }
    }
    return changed;
}
