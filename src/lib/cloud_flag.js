// Whether this build has Transkit Cloud (Supabase) available, and which services depend on it.
// Kept free of Tauri and Supabase imports so config code and plain-Node tests can use it.

/** True when Supabase credentials were baked in and cloud was not disabled explicitly. */
export function computeCloudEnabled(env = {}) {
    return env.VITE_DISABLE_CLOUD !== 'true' && !!env.VITE_SUPABASE_URL && !!env.VITE_SUPABASE_ANON_KEY;
}

// `import.meta.env` exists under Vite; plain Node has none, which means a local-only build.
export const CLOUD_ENABLED = computeCloudEnabled(import.meta.env ?? {});

/** True for a Transkit Cloud service name or instance key (`transkit_cloud_tts@abc`). */
export function isCloudService(nameOrKey) {
    return typeof nameOrKey === 'string' && nameOrKey.split('@')[0].startsWith('transkit_cloud_');
}

/** Whether a service can be offered in this build: cloud services only when cloud is enabled. */
export function isServiceAvailable(nameOrKey, cloudEnabled = CLOUD_ENABLED) {
    return cloudEnabled || !isCloudService(nameOrKey);
}
