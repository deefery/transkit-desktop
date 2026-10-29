// Run with: node --test src/utils/tts_service.test.js
// Regression tests for Translate popup Speak (Source + Target) honoring the active TTS service.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { resolveActiveTtsInstanceKey, synthesizeSpeech } from './tts_service.js';

// service_instance.ts is TypeScript; transpile it so the tests use the real key parsing helpers.
const serviceInstanceSource = ts.transpileModule(
    readFileSync(new URL('./service_instance.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }
).outputText;
const { getServiceName, getServiceSouceType, ServiceSourceType } = await import(
    `data:text/javascript;base64,${Buffer.from(serviceInstanceSource).toString('base64')}`
);

const LIST = ['transkit_cloud_tts', 'google_tts', 'edge_tts'];

// Fake built-in TTS services that record how they were called.
function createBuiltinServices(calls) {
    const make = (name, voices) => ({
        Language: voices,
        tts: async (text, voice, options) => {
            calls.push({ service: name, text, voice, config: options.config });
            return `${name}:${voice}`;
        },
    });
    return {
        transkit_cloud_tts: make('transkit_cloud_tts', { en: 'cloud-en', zh_cn: 'cloud-zh' }),
        google_tts: make('google_tts', { en: 'google-en', zh_cn: 'google-zh' }),
        edge_tts: make('edge_tts', { en: 'edge-en', zh_cn: 'edge-zh' }),
    };
}

// Mirrors what SourceArea / TargetArea handleSpeak do: resolve, then synthesize.
async function speakLikeComponent({ list, active, text, languageKey, configMap, pluginInfo, builtin, invokePlugin }) {
    const instanceKey = resolveActiveTtsInstanceKey(list, active);
    if (!instanceKey) throw new Error('No TTS service configured');
    return synthesizeSpeech({
        instanceKey,
        serviceName: getServiceName(instanceKey),
        isPlugin: getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN,
        text,
        languageKey,
        serviceInstanceConfigMap: configMap,
        pluginInfo,
        builtinTtsServices: builtin,
        invokePlugin,
    });
}

test('resolve: active service that is not list[0] is selected', () => {
    assert.equal(resolveActiveTtsInstanceKey(LIST, 'edge_tts'), 'edge_tts');
    assert.equal(resolveActiveTtsInstanceKey(LIST, 'google_tts'), 'google_tts');
});

test('resolve: distinct configured instances of the same provider are told apart', () => {
    const list = ['edge_tts@aaa', 'edge_tts@bbb', 'google_tts'];
    assert.equal(resolveActiveTtsInstanceKey(list, 'edge_tts@bbb'), 'edge_tts@bbb');
    assert.equal(resolveActiveTtsInstanceKey(list, 'edge_tts@aaa'), 'edge_tts@aaa');
    // same provider name without the instance id is a different (stale) key
    assert.equal(resolveActiveTtsInstanceKey(list, 'edge_tts'), 'edge_tts@aaa');
});

test('resolve: absent or stale active configuration falls back to list[0]', () => {
    for (const active of [undefined, null, '', 'deleted_tts@gone']) {
        assert.equal(resolveActiveTtsInstanceKey(LIST, active), 'transkit_cloud_tts');
    }
});

test('resolve: empty or missing service list resolves to nothing', () => {
    for (const list of [[], null, undefined]) {
        assert.equal(resolveActiveTtsInstanceKey(list, 'edge_tts'), null);
    }
});

test('built-in: Speak uses the active service, its own instance config and its own voice', async () => {
    const calls = [];
    const configMap = {
        transkit_cloud_tts: { marker: 'cloud' },
        google_tts: { marker: 'google' },
        edge_tts: { marker: 'edge', voice: 'v1' },
    };
    for (const languageKey of ['en', 'zh_cn']) {
        calls.length = 0;
        const data = await speakLikeComponent({
            list: LIST,
            active: 'edge_tts',
            text: 'hello',
            languageKey,
            configMap,
            builtin: createBuiltinServices(calls),
        });
        assert.equal(data, `edge_tts:edge-${languageKey === 'en' ? 'en' : 'zh'}`);
        assert.deepEqual(calls, [
            {
                service: 'edge_tts',
                text: 'hello',
                voice: languageKey === 'en' ? 'edge-en' : 'edge-zh',
                config: { marker: 'edge', voice: 'v1' },
            },
        ]);
    }
});

test('built-in: two instances of the same provider each use their own config', async () => {
    const list = ['edge_tts@aaa', 'edge_tts@bbb'];
    const configMap = { 'edge_tts@aaa': { voice: 'A' }, 'edge_tts@bbb': { voice: 'B' } };
    const calls = [];
    const builtin = createBuiltinServices(calls);
    await speakLikeComponent({ list, active: 'edge_tts@bbb', text: 't', languageKey: 'en', configMap, builtin });
    await speakLikeComponent({ list, active: 'edge_tts@aaa', text: 't', languageKey: 'en', configMap, builtin });
    assert.deepEqual(
        calls.map((c) => [c.service, c.config.voice]),
        [
            ['edge_tts', 'B'],
            ['edge_tts', 'A'],
        ]
    );
});

test('built-in: stale active falls back to list[0] with list[0] config', async () => {
    const calls = [];
    await speakLikeComponent({
        list: LIST,
        active: 'removed_tts',
        text: 't',
        languageKey: 'en',
        configMap: { transkit_cloud_tts: { marker: 'cloud' } },
        builtin: createBuiltinServices(calls),
    });
    assert.deepEqual(
        calls.map((c) => [c.service, c.config.marker]),
        [['transkit_cloud_tts', 'cloud']]
    );
});

test('plugin: plugin metadata, config and voice come from the selected plugin instance', async () => {
    const pluginCalls = [];
    const list = ['transkit_cloud_tts', 'plugin.com.example.tts@one', 'plugin.com.example.tts@two'];
    const configMap = {
        'plugin.com.example.tts@one': { key: 'one' },
        'plugin.com.example.tts@two': { key: 'two' },
    };
    const pluginInfo = { language: { en: 'plugin-en' } };
    const invokePlugin = async (type, name) => {
        pluginCalls.push({ type, name });
        return [
            async (text, voice, options) => ({ text, voice, config: options.config, utils: options.utils }),
            'utils-token',
        ];
    };
    const data = await speakLikeComponent({
        list,
        active: 'plugin.com.example.tts@two',
        text: 'hi',
        languageKey: 'en',
        configMap,
        pluginInfo,
        builtin: createBuiltinServices([]),
        invokePlugin,
    });
    assert.deepEqual(pluginCalls, [{ type: 'tts', name: 'plugin.com.example.tts' }]);
    assert.deepEqual(data, { text: 'hi', voice: 'plugin-en', config: { key: 'two' }, utils: 'utils-token' });
});

test('plugin: missing plugin info or unsupported language rejects without invoking the plugin', async () => {
    let invoked = false;
    const invokePlugin = async () => {
        invoked = true;
        return [async () => 'x', {}];
    };
    const base = {
        list: ['plugin.com.example.tts@one'],
        active: 'plugin.com.example.tts@one',
        text: 't',
        configMap: {},
        builtin: {},
        invokePlugin,
    };
    await assert.rejects(
        speakLikeComponent({ ...base, languageKey: 'en', pluginInfo: undefined }),
        /plugin info not loaded/
    );
    await assert.rejects(
        speakLikeComponent({ ...base, languageKey: 'fr', pluginInfo: { language: { en: 'e' } } }),
        /Language not supported/
    );
    assert.equal(invoked, false);
});

test('failures reject (caught by the UI) instead of throwing synchronously or hanging', async () => {
    const builtin = createBuiltinServices([]);
    builtin.edge_tts.tts = async () => {
        throw new Error('provider down');
    };
    const args = { list: LIST, active: 'edge_tts', text: 't', languageKey: 'en', configMap: {}, builtin };
    // provider failure
    await assert.rejects(speakLikeComponent(args), /provider down/);
    // language not supported by the selected built-in service
    await assert.rejects(speakLikeComponent({ ...args, languageKey: 'xx' }), /Language not supported/);
    // selected built-in service unavailable
    await assert.rejects(speakLikeComponent({ ...args, active: 'gone_tts', list: ['gone_tts'] }), /not available/);
    // empty service list
    await assert.rejects(speakLikeComponent({ ...args, list: [] }), /No TTS service configured/);
});

test('existing successful path: returned audio data is passed through unchanged', async () => {
    const buffer = [1, 2, 3];
    const builtin = createBuiltinServices([]);
    builtin.google_tts.tts = async () => buffer;
    const data = await speakLikeComponent({
        list: LIST,
        active: 'google_tts',
        text: 't',
        languageKey: 'en',
        configMap: {},
        builtin,
    });
    assert.equal(data, buffer);
});

// Wiring guard: the real Source/Target components must go through the shared helper.
// (There is no DOM/Tauri test harness in this repo, so this checks the component source.)
for (const area of ['SourceArea', 'TargetArea']) {
    test(`${area}: Speak is wired to the active TTS service`, () => {
        const src = readFileSync(new URL(`../window/Translate/components/${area}/index.jsx`, import.meta.url), 'utf8');
        assert.doesNotMatch(src, /ttsServiceList\[0\]/, 'must not hardcode tts_service_list[0]');
        assert.match(src, /useConfig\('tts_active_service'/);
        assert.match(src, /resolveActiveTtsInstanceKey\(ttsServiceList, ttsActiveService\)/);
        assert.match(src, /synthesizeSpeech\(\{/);
        // plugin info is loaded for the resolved instance, not for list[0]
        assert.match(src, /plugins\/tts\/\$\{getServiceName\(ttsInstanceKey\)\}\/info\.json/);
        // UI rejection handling on the speak button is preserved
        assert.match(src, /handleSpeak\(\)\.catch\(/);
    });
}

test('TargetArea: memoized header buttons refresh when the TTS selection changes', () => {
    const src = readFileSync(new URL('../window/Translate/components/TargetArea/index.jsx', import.meta.url), 'utf8');
    const start = src.indexOf('const headerButtonsContent = useMemo');
    const depsStart = src.indexOf('\n    ), [', start);
    const deps = src.slice(depsStart, src.indexOf(']);', depsStart));
    assert.ok(start >= 0 && depsStart > start, 'headerButtonsContent dependency list not found');
    for (const dep of ['ttsInstanceKey', 'ttsPluginInfo', 'serviceInstanceConfigMap']) {
        assert.ok(deps.includes(dep), `${dep} missing from headerButtonsContent deps`);
    }
});
