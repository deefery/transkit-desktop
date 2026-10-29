// Pick the TTS service instance that Speak should use: the configured active
// instance while it is still in the service list, otherwise the first listed one.
// Returns null when there is no TTS service instance at all.
export function resolveActiveTtsInstanceKey(serviceList, activeInstanceKey) {
    if (!Array.isArray(serviceList) || serviceList.length === 0) return null;
    return serviceList.includes(activeInstanceKey) ? activeInstanceKey : serviceList[0];
}

// Synthesize `text` with one TTS service instance and return the audio data.
// The service (plugin or built-in), its instance config and the language code all
// come from the same `instanceKey`, so they can never refer to different services.
export async function synthesizeSpeech({
    instanceKey,
    serviceName,
    isPlugin,
    text,
    languageKey,
    serviceInstanceConfigMap,
    pluginInfo,
    builtinTtsServices,
    invokePlugin,
}) {
    const config = serviceInstanceConfigMap?.[instanceKey];
    if (isPlugin) {
        if (!pluginInfo?.language) {
            throw new Error(`TTS plugin info not loaded: ${serviceName}`);
        }
        if (!(languageKey in pluginInfo.language)) {
            throw new Error('Language not supported');
        }
        const [func, utils] = await invokePlugin('tts', serviceName);
        return await func(text, pluginInfo.language[languageKey], { config, utils });
    }
    const service = builtinTtsServices[serviceName];
    if (!service) {
        throw new Error(`TTS service not available: ${serviceName}`);
    }
    if (!(languageKey in service.Language)) {
        throw new Error('Language not supported');
    }
    return await service.tts(text, service.Language[languageKey], { config });
}
