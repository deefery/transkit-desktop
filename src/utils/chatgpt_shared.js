// Pure helpers for settings shared by the two ChatGPT-plan services (translate `chatgpt` and AI
// `chatgpt_ai`). No Tauri / store access here so it can be unit-tested; the I/O half is
// `chatgpt_settings.js`.
import { DEFAULT_SYSTEM_PROMPT } from '../services/ai/chatgpt_ai/prompt.js';
import { defaultPromptList } from '../services/translate/chatgpt/prompt.js';

// Store key of the settings both services share (currently just the default model).
export const SHARED_SETTINGS_KEY = 'chatgpt_settings';

// Same as INSTANCE_NAME_CONFIG_KEY in service_instance.ts (a TS file, not importable from node tests).
const INSTANCE_NAME_KEY = 'instanceName';

// The model for a request: the service's own override, else the shared default, else '' (Rust then
// uses the first model ChatGPT lists for the account).
export function pickModel(own, shared) {
    const mine = typeof own === 'string' ? own.trim() : '';
    if (mine !== '') return mine;
    const common = typeof shared?.model === 'string' ? shared.model.trim() : '';
    return common;
}

const serviceNameOf = (instanceKey) => String(instanceKey).split('@')[0];

export function hasServiceInstance(list, serviceName) {
    return Array.isArray(list) && list.some((key) => serviceNameOf(key) === serviceName);
}

export function appendUnique(list, key) {
    const base = Array.isArray(list) ? list : [];
    return base.includes(key) ? base : [...base, key];
}

// For each service: the *other* service that gets offered alongside it, and where it is listed.
export const COMPANIONS = {
    chatgpt: {
        serviceName: 'chatgpt_ai',
        listKey: 'ai_service_list',
        defaultList: ['transkit_cloud_ai'],
        titleKey: 'services.ai.chatgpt_ai.title',
        labelKey: 'chatgpt.also_add_ai',
    },
    chatgpt_ai: {
        serviceName: 'chatgpt',
        listKey: 'translate_service_list',
        defaultList: ['google', 'bing', 'transkit_cloud_translate'],
        titleKey: 'services.translate.chatgpt.title',
        labelKey: 'chatgpt.also_add_translate',
    },
};

// Default config of a freshly created instance. `model: ''` means "follow the shared default model".
export function buildDefaultConfig(serviceName, title) {
    if (serviceName === 'chatgpt_ai') {
        return { [INSTANCE_NAME_KEY]: title, model: '', systemPrompt: DEFAULT_SYSTEM_PROMPT };
    }
    if (serviceName === 'chatgpt') {
        return {
            [INSTANCE_NAME_KEY]: title,
            model: '',
            stream: true,
            promptList: defaultPromptList.map((item) => ({ ...item })),
        };
    }
    throw new Error(`Unknown ChatGPT service: ${serviceName}`);
}
