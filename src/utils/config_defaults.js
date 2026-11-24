// Canonical first-run defaults for config keys that several components read.
//
// `useConfig(key, default)` writes its caller's default to the store when the key is missing, so
// when two components pass different defaults the value a new user ends up with depends on which
// window happened to read the key first. Keys listed here have one canonical default: the store is
// seeded with it before any window renders, and `useConfig` falls back to it instead of the
// caller's value. Existing stored values are never changed by seeding.
//
// Keep this module free of Tauri imports so it can be tested in plain Node.
import { CLOUD_ENABLED, isCloudService, isServiceAvailable } from '../lib/cloud_flag.js';

// Full lists, including Transkit Cloud services; a build without cloud drops those (see below).
export const SERVICE_LIST_DEFAULTS = Object.freeze({
    translate_service_list: ['bing', 'google', 'transkit_cloud_translate'],
    recognize_service_list: ['system', 'tesseract'],
    tts_service_list: ['edge_tts', 'google_tts', 'transkit_cloud_tts'],
    transcription_service_list: ['transkit_cloud_stt', 'deepgram_stt'],
    ai_service_list: ['transkit_cloud_ai'],
});

// Keys that hold a single selected service instance.
const ACTIVE_SERVICE_FALLBACKS = Object.freeze({
    tts_active_service: 'edge_tts',
    // Empty means "not chosen yet": Monitor and Voice Anywhere fall back on their own.
    transcription_active_service: '',
    selection_action_ai_instance: '',
});

/** The canonical defaults for a build with or without Transkit Cloud. */
export function buildConfigDefaults(cloudEnabled) {
    const lists = Object.fromEntries(
        Object.entries(SERVICE_LIST_DEFAULTS).map(([key, list]) => [
            key,
            list.filter((name) => isServiceAvailable(name, cloudEnabled)),
        ])
    );
    return Object.freeze({
        ...lists,
        translate_source_language: 'auto',
        translate_target_language: 'zh_cn',
        translate_second_language: 'en',
        history_disable: false,
        tts_active_service: ACTIVE_SERVICE_FALLBACKS.tts_active_service,
        transcription_active_service: ACTIVE_SERVICE_FALLBACKS.transcription_active_service,
    });
}

export const CONFIG_DEFAULTS = buildConfigDefaults(CLOUD_ENABLED);

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
export async function seedConfigDefaults(store, defaults = CONFIG_DEFAULTS) {
    let changed = false;
    for (const [key, value] of Object.entries(defaults)) {
        if ((await store.get(key)) === null) {
            await store.set(key, clone(value));
            changed = true;
        }
    }
    return changed;
}

/**
 * In a build without Transkit Cloud, removes cloud services from the stored service lists and resets
 * selections that point at one, since they can only fail here. A list left empty gets the cloud-free
 * defaults (an empty AI list stays empty: no AI is usable until one is added). Each instance's own settings stay in
 * the store, so re-adding the service in a cloud build restores them. Does nothing when cloud is
 * enabled. Returns true when anything was changed.
 */
export async function pruneUnavailableCloudServices(store, cloudEnabled = CLOUD_ENABLED) {
    if (cloudEnabled) return false;
    const defaults = buildConfigDefaults(false);
    let changed = false;
    for (const key of Object.keys(SERVICE_LIST_DEFAULTS)) {
        const list = await store.get(key);
        if (!Array.isArray(list)) continue;
        const kept = list.filter((item) => !isCloudService(item));
        if (kept.length !== list.length) {
            // A list that held only cloud services was effectively unconfigured: use the defaults.
            await store.set(key, kept.length > 0 ? kept : clone(defaults[key]));
            changed = true;
        }
    }
    for (const [key, fallback] of Object.entries(ACTIVE_SERVICE_FALLBACKS)) {
        if (isCloudService(await store.get(key))) {
            await store.set(key, fallback);
            changed = true;
        }
    }
    return changed;
}
