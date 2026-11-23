// Store-backed half of the shared ChatGPT-plan settings (see chatgpt_shared.js for the pure part).
import { emit } from '@tauri-apps/api/event';

import {
    COMPANIONS,
    SHARED_SETTINGS_KEY,
    appendUnique,
    buildDefaultConfig,
    hasServiceInstance,
    pickModel,
} from './chatgpt_shared';
import { createServiceInstanceKey } from './service_instance';
import { store } from './store';

// The model to send: the service's own override, else the shared default.
export async function resolveChatGPTModel(own) {
    const mine = typeof own === 'string' && own.trim() !== '';
    return pickModel(own, mine ? null : await store.get(SHARED_SETTINGS_KEY));
}

async function readList(companion) {
    const list = await store.get(companion.listKey);
    return Array.isArray(list) ? list : companion.defaultList;
}

// True when `mainService` has no sibling instance yet in the other service list.
export async function companionMissing(mainService) {
    const companion = COMPANIONS[mainService];
    return !hasServiceInstance(await readList(companion), companion.serviceName);
}

// Create the sibling instance (with default settings that follow the shared model) and list it.
// Returns its instance key, or null when one already exists.
export async function addCompanion(mainService, title) {
    const companion = COMPANIONS[mainService];
    const list = await readList(companion);
    if (hasServiceInstance(list, companion.serviceName)) return null;
    const instanceKey = createServiceInstanceKey(companion.serviceName);
    await store.set(instanceKey, buildDefaultConfig(companion.serviceName, title));
    const next = appendUnique(list, instanceKey);
    await store.set(companion.listKey, next);
    await store.save();
    // Same event useConfig listens to, so an open service page refreshes its list.
    await emit(`${companion.listKey}_changed`, next);
    return instanceKey;
}
