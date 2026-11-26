// Runs the health test of one service instance (H1) through the same code paths real use takes:
// the built-in service modules, plugins via invoke_plugin, TTS via synthesizeSpeech.
import * as translateServices from '../../../../services/translate';
import * as ttsServices from '../../../../services/tts';
import * as aiServices from '../../../../services/ai';
import { emit } from '@tauri-apps/api/event';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import { store } from '../../../../utils/store';
import { getServiceName, whetherPluginService } from '../../../../utils/service_instance';
import { synthesizeSpeech } from '../../../../utils/tts_service';
import {
    HealthSource,
    recordServiceOutcome,
    testAiService,
    testTranslateService,
    testTtsService,
} from '../../../../utils/service_health';

export const ServiceKind = Object.freeze({ TRANSLATE: 'translate', TTS: 'tts', AI: 'ai' });

// Rows in this window refresh from here after a test; other windows hear the config event.
export const healthUpdates = new EventTarget();

async function runTest({ kind, instanceKey, pluginList }) {
    const name = getServiceName(instanceKey);
    const isPlugin = whetherPluginService(instanceKey);
    const config = (await store.get(instanceKey)) ?? {};
    if (kind === ServiceKind.TRANSLATE) {
        if (isPlugin) {
            const info = pluginList?.[name];
            if (!info?.language) return { ok: false, ms: 0, error: new Error('Plugin not available') };
            const [func, utils] = await invoke_plugin('translate', name);
            return testTranslateService({ plugin: { func, utils, language: info.language }, config: { ...config, enable: 'true' } });
        }
        return testTranslateService({ module: translateServices[name], config });
    }
    if (kind === ServiceKind.TTS) {
        return testTtsService({
            synthesize: (text) =>
                synthesizeSpeech({
                    instanceKey,
                    serviceName: name,
                    isPlugin,
                    text,
                    languageKey: 'en',
                    serviceInstanceConfigMap: { [instanceKey]: config },
                    pluginInfo: pluginList?.[name],
                    builtinTtsServices: ttsServices,
                    invokePlugin: invoke_plugin,
                }),
        });
    }
    if (kind === ServiceKind.AI) {
        if (isPlugin) return { ok: false, ms: 0, error: new Error('Plugin AI services cannot be tested') };
        return testAiService({ module: aiServices[name], config });
    }
    return { ok: false, ms: 0, error: new Error(`Unknown service kind: ${kind}`) };
}

/** Test one instance and store the outcome (Settings and every other window see it). */
export async function testAndRecord({ kind, instanceKey, pluginList }) {
    let outcome;
    try {
        outcome = await runTest({ kind, instanceKey, pluginList });
    } catch (error) {
        outcome = { ok: false, ms: 0, error };
    }
    await recordServiceOutcome({ store, emit, instanceKey, outcome: { ...outcome, source: HealthSource.TEST } });
    healthUpdates.dispatchEvent(new Event('change'));
    return outcome;
}
