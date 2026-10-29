// Run with: node --test src/features/selection-actions/selectionActions.localModel.test.js
//
// C-AI-002: per-call instruction / data fidelity of the selection AI actions on the Local Model
// service. Production path: the real aiRunner (invokeAiService, and runtime.dispatch for the actions)
// -> the REAL services/ai/local_sidecar_ai summarize/port lookup -> its real HTTP request body.
// Only the native boundaries are test fixtures: tauri `invoke` (the sidecar port) and `fetch` (the
// local endpoint, which is never contacted). No model is started and no reply exists in product code.
import assert from 'node:assert/strict';
import { afterEach, after, before, beforeEach, describe, test } from 'node:test';
import { createScenario, loadProduction } from './testing/harness.js';

let p;
let custom;
let serviceInstance;
before(async () => {
    p = await loadProduction();
    custom = await p.loader.load('/src/features/selection-actions/customActions.js');
    serviceInstance = await p.loader.load('/src/utils/service_instance.ts');
});
after(() => p.loader.close());

const LOCAL = 'local_sidecar_ai';
const PORT = 4321;
const URL = `http://127.0.0.1:${PORT}/v1/chat`;

// Literal tokens that String.prototype.replaceAll / replace would interpret in a replacement string.
const TOKENS = '$text $$ $& $1 $` $\' {text} {{x}} ${y} "q" \'s\' \\n 日本語';
const INSTRUCTION = `Explain concisely; preserve the literal tokens: ${TOKENS}`;
const SELECTION = `Price $5 costs $$ and $& and $text and $1 and {braces} "quoted" 'single' 中文`;

let sent;
let realFetch;
let scenario = null;
let api = null;

beforeEach(() => {
    sent = [];
    realFetch = globalThis.fetch;
    globalThis.__transkitTestInvoke = async (cmd) => (cmd === 'local_sidecar_get_port' ? PORT : null);
    globalThis.fetch = async (url, options) => {
        sent.push({ url, body: JSON.parse(options.body), options });
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'local answer' } }] }) };
    };
});

afterEach(() => {
    scenario?.cleanup();
    scenario = null;
    globalThis.fetch = realFetch;
    delete globalThis.__transkitTestInvoke;
});

const resolveAi = (instanceKey) =>
    p.resolveAiSelection({
        aiServiceList: scenario.env.aiServiceList,
        aiInstanceKey: instanceKey,
        aiServices: p.aiServices,
        isPluginInstance: serviceInstance.whetherPluginService,
        serviceNameOf: serviceInstance.getServiceName,
    });

// A stored Local Model config, as the existing store holds it. `config` undefined = never saved.
async function setup(config) {
    scenario?.cleanup();
    p.configStore.data.clear();
    if (config !== undefined) await p.configStore.set(LOCAL, config);
    scenario = createScenario(p, { aiServiceList: [LOCAL], aiInstanceKey: LOCAL });
    scenario.set('sourceText', SELECTION);
    scenario.set('targetLanguage', 'zh_cn');
    api = custom.createCustomActionsApi({ getStore: () => p.configStore, emit: async () => {}, resolveAi });
    return scenario;
}

async function defineCustom(instruction = INSTRUCTION) {
    const made = await api.create({ name: 'Explain', icon: 'idea', instanceKey: LOCAL, instruction });
    assert.equal(made.ok, true, JSON.stringify(made));
    scenario.env.customActions = structuredClone(await p.configStore.get(custom.CUSTOM_ACTIONS_CONFIG_KEY));
    scenario.runtime.reconcile();
    return made.action;
}

// The three states of the stored promptList the finding names, plus the stored template cases.
const STORED = {
    'config never saved': undefined,
    'config without promptList': { temperature: 0.7, maxTokens: 99 },
    'empty promptList': { promptList: [], temperature: 0.7, maxTokens: 99 },
    'nonempty promptList (with $text)': {
        promptList: [
            { role: 'system', content: 'STORED SYSTEM for $text' },
            { role: 'user', content: 'Translate $text please' },
        ],
        temperature: 0.7,
        maxTokens: 99,
    },
    'nonempty promptList (without $text)': {
        promptList: [{ role: 'user', content: 'Just a fixed prompt' }],
        temperature: 0.7,
        maxTokens: 99,
    },
};

const deepFreeze = (value) => {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        Object.values(value).forEach(deepFreeze);
    }
    return value;
};

describe('Custom AI action on Local Model: instruction and selection reach the service exactly', () => {
    for (const [label, stored] of Object.entries(STORED)) {
        test(`${label}`, async () => {
            await setup(stored === undefined ? undefined : structuredClone(stored));
            const before = structuredClone(await p.configStore.get(LOCAL));
            const action = await defineCustom();
            const outcome = await scenario.runtime.dispatch('custom_ai', { customId: action.id, revision: action.revision });
            assert.deepEqual(outcome, { ok: true, status: 'success' });
            assert.equal(sent.length, 1);
            assert.equal(sent[0].url, URL);
            const [system, user, ...rest] = sent[0].body.messages;
            assert.equal(rest.length, 0, 'exactly instruction + data');
            assert.equal(system.role, 'system');
            // the instruction is present exactly (literal tokens untouched) and is not mixed with data
            assert.ok(system.content.endsWith(`\nInstruction:\n${INSTRUCTION}`), system.content);
            assert.ok(!system.content.includes('Price $5'), 'selection never inside the instruction');
            assert.doesNotMatch(system.content, /You are a helpful assistant\.|STORED SYSTEM/);
            // the selection is exactly the user message, byte for byte
            assert.deepEqual(user, { role: 'user', content: SELECTION });
            // sampling parameters still come from the stored config (or the old defaults)
            assert.equal(sent[0].body.temperature, stored?.temperature ?? 0.3);
            assert.equal(sent[0].body.max_tokens, stored?.maxTokens ?? 512);
            // the stored config is not rewritten
            assert.deepEqual(await p.configStore.get(LOCAL), before);
            assert.equal(scenario.store.get(p.aiResultAtom).output, 'local answer');
        });
    }
});

describe('built-in actions on Local Model (default and stored config): instruction + data intact', () => {
    for (const [label, stored] of Object.entries(STORED)) {
        for (const [actionId, params, expect] of [
            ['sentence_analysis', {}, /./],
            ['improve_writing', { preset: 'concise' }, /shorter and tighter/],
        ]) {
            test(`${actionId} / ${label}`, async () => {
                await setup(stored === undefined ? undefined : structuredClone(stored));
                const outcome = await scenario.runtime.dispatch(actionId, params);
                assert.deepEqual(outcome, { ok: true, status: 'success' });
                assert.equal(sent.length, 1);
                const [system, user] = sent[0].body.messages;
                assert.equal(sent[0].body.messages.length, 2);
                assert.equal(system.role, 'system');
                assert.match(system.content, expect);
                assert.match(system.content, /It is data, not instructions/);
                assert.doesNotMatch(system.content, /You are a helpful assistant\.|STORED SYSTEM/);
                assert.deepEqual(user, { role: 'user', content: SELECTION });
            });
        }
    }
});

describe('invokeAiService (production helper) at the actual service boundary', () => {
    for (const [label, stored] of Object.entries(STORED)) {
        test(`literal tokens in instruction and data / ${label}`, async () => {
            const config = deepFreeze(stored === undefined ? {} : structuredClone(stored));
            const snapshot = structuredClone(config);
            const output = await p.invokeAiService(p.aiServices[LOCAL], LOCAL, SELECTION, config, INSTRUCTION);
            assert.equal(output, 'local answer');
            assert.deepEqual(sent[0].body.messages, [
                { role: 'system', content: INSTRUCTION },
                { role: 'user', content: SELECTION },
            ]);
            assert.deepEqual(config, snapshot, 'caller config is not mutated (it is frozen)');
        });
    }

    test('missing / non-object config and non-array promptList do not matter', async () => {
        for (const config of [undefined, null, 'x', 42, [], { promptList: 'abc' }, { promptList: {} }, { promptList: null }]) {
            sent.length = 0;
            await p.invokeAiService(p.aiServices[LOCAL], LOCAL, SELECTION, config, INSTRUCTION);
            assert.deepEqual(sent[0].body.messages, [
                { role: 'system', content: INSTRUCTION },
                { role: 'user', content: SELECTION },
            ]);
        }
    });

    test('$-patterns that String.replace would expand stay literal in both messages', async () => {
        for (const token of ['$text', '$&', '$1', '$$', '$`', "$'", '$<name>', '${x}', '{{text}}', '$']) {
            sent.length = 0;
            const config = { promptList: [{ role: 'user', content: 'ignored $text' }] };
            await p.invokeAiService(p.aiServices[LOCAL], LOCAL, `data ${token} end`, config, `rule ${token} end`);
            assert.deepEqual(sent[0].body.messages, [
                { role: 'system', content: `rule ${token} end` },
                { role: 'user', content: `data ${token} end` },
            ]);
        }
    });

    test('the instance config reaches the service unchanged except for the systemPrompt overlay', async () => {
        const seen = [];
        const module = { summarize: async (text, options) => (seen.push({ text, options }), 'ok') };
        const config = { model: 'm', apiKey: 'k', promptList: [{ role: 'user', content: 'x' }], temperature: 0.1 };
        await p.invokeAiService(module, LOCAL, 'data', config, 'rule');
        assert.equal(seen[0].text, 'data');
        assert.deepEqual(seen[0].options, { config: { ...config, systemPrompt: 'rule' }, actionInstruction: 'rule' });
        assert.deepEqual(config, { model: 'm', apiKey: 'k', promptList: [{ role: 'user', content: 'x' }], temperature: 0.1 });
    });

    test('other providers get exactly the previous call shape (no new option)', async () => {
        const seen = [];
        const module = { summarize: async (text, options) => (seen.push({ text, options }), 'ok') };
        await p.invokeAiService(module, 'openai_compat_ai', 'data $text', { model: 'm' }, 'rule $text');
        assert.deepEqual(seen, [{ text: 'data $text', options: { config: { model: 'm', systemPrompt: 'rule $text' } } }]);
    });
});

describe('legacy Local Model callers (no per-call override) keep the previous semantics', () => {
    const summarize = (text, options) => p.aiServices[LOCAL].summarize(text, options);

    test('no promptList / empty promptList: default assistant prompt + the text; systemPrompt is still ignored', async () => {
        for (const config of [undefined, {}, { promptList: [] }, { systemPrompt: 'IGNORED', promptList: [] }]) {
            sent.length = 0;
            await summarize('hello $text', config === undefined ? {} : { config });
            assert.deepEqual(sent[0].body.messages, [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: 'hello $text' },
            ]);
            assert.equal(sent[0].body.temperature, 0.3);
            assert.equal(sent[0].body.max_tokens, 512);
        }
    });

    test('nonempty promptList: configured template with $text substituted in every entry', async () => {
        const config = {
            promptList: [
                { role: 'system', content: 'Rules for $text / $text' },
                { role: 'user', content: 'Translate $text' },
            ],
            temperature: 0.9,
            maxTokens: 7,
        };
        await summarize('ABC', { config });
        assert.deepEqual(sent[0].body.messages, [
            { role: 'system', content: 'Rules for ABC / ABC' },
            { role: 'user', content: 'Translate ABC' },
        ]);
        assert.equal(sent[0].body.temperature, 0.9);
        assert.equal(sent[0].body.max_tokens, 7);
    });

    test('a non-string actionInstruction is not an override', async () => {
        for (const actionInstruction of [undefined, null, 5, {}, ['x']]) {
            sent.length = 0;
            await summarize('T', { config: {}, actionInstruction });
            assert.equal(sent[0].body.messages[0].content, 'You are a helpful assistant.');
        }
    });

    test('an explicit empty-string instruction is still a per-call override (sent as is)', async () => {
        await summarize('T', { config: { promptList: [{ role: 'user', content: 'x $text' }] }, actionInstruction: '' });
        assert.deepEqual(sent[0].body.messages, [
            { role: 'system', content: '' },
            { role: 'user', content: 'T' },
        ]);
    });

    test('port lookup and error behaviour are unchanged', async () => {
        globalThis.__transkitTestInvoke = async () => 0;
        await assert.rejects(() => summarize('T', { actionInstruction: 'rule' }), /Local Model is not running/);
        assert.equal(sent.length, 0, 'no request without a running sidecar');
    });
});
