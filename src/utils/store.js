import { Store } from 'tauri-plugin-store-api';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { watch } from 'tauri-plugin-fs-watch-api';
import { invoke } from '@tauri-apps/api';
import { pruneUnavailableCloudServices, seedConfigDefaults } from './config_defaults';

export let store = new Store();

export async function initStore() {
    const appConfigDirPath = await appConfigDir();
    const appConfigPath = await join(appConfigDirPath, 'config.json');
    store = new Store(appConfigPath);
    try { await store.load(); } catch (_) { /* first run — config.json doesn't exist yet */ }

    // Write the canonical defaults (service lists, languages, history, active services) before
    // React renders, so a new user's settings do not depend on which window reads a key first.
    // See config_defaults.js.
    // A build without Transkit Cloud also drops cloud services left in the user's lists.
    const pruned = await pruneUnavailableCloudServices(store);
    const seeded = await seedConfigDefaults(store);
    if (pruned || seeded) await store.save();

    // Do NOT await watch() — on Windows, watching a non-existent file can hang the promise
    // indefinitely, blocking React from rendering. Fire-and-forget is safe here since the
    // callback only fires on subsequent file changes, not during initial load.
    watch(appConfigPath, async () => {
        await store.load();
        await invoke('reload_store');
    }).catch(() => {});
}
