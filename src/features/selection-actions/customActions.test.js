// Run with: node --test src/features/selection-actions/customActions.test.js
//
// The Custom AI Actions data model: validation, reading whatever is stored, create / edit / delete
// with stable ids and stale-revision protection, and persistence through the real commit path onto
// the config store. Nothing here calls a provider or the network. The Store is the test double of
// the Tauri store plugin (the native boundary); every function under test is the production one.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Store } from './testing/tauriStub.js';
import {
    CUSTOM_ACTIONS_CONFIG_KEY,
    CUSTOM_ICON_IDS,
    EntryProblem,
    MAX_CUSTOM_ACTIONS,
    MAX_INSTRUCTION_LENGTH,
    MAX_NAME_LENGTH,
    OpReason,
    StoredFormat,
    commitCustomActions,
    createCustomAction,
    createCustomActionsApi,
    deleteCustomAction,
    editConflict,
    purgeUnreadableActions,
    readCustomActions,
    resetCustomActions,
    updateCustomAction,
    validateCustomDraft,
} from './customActions.js';

const READY = new Set(['openai_compat_ai@a1', 'openai_compat_ai@a2', 'gemini_ai@b2']);
const resolveCalls = [];
const resolveAi = (key) => {
    resolveCalls.push(key);
    if (READY.has(key)) return { status: 'ready', instanceKey: key };
    if (key.startsWith('plugin')) return { status: 'unavailable', code: 'ai-unsupported-service' };
    return { status: 'unavailable', code: 'ai-instance-missing' };
};

const draft = (overrides = {}) => ({
    name: 'Explain',
    icon: 'idea',
    instanceKey: 'openai_compat_ai@a1',
    instruction: 'Explain the selected text in simple words.',
    outputMode: 'popup',
    ...overrides,
});

let ids;
const nextId = () => `ca_test_${(ids += 1)}`;
let realFetch;
beforeEach(() => {
    ids = 0;
    resolveCalls.length = 0;
    realFetch = globalThis.fetch;
    // Validation and editing must never reach a network.
    globalThis.fetch = () => {
        throw new Error('network used during editor validation');
    };
});
afterEach(() => {
    globalThis.fetch = realFetch;
});

const ops = { resolveAi, generateId: nextId };
const create = (raw, overrides) => createCustomAction(raw, draft(overrides), ops);

describe('validateCustomDraft', () => {
    test('accepts a complete draft and normalizes surrounding whitespace', () => {
        const result = validateCustomDraft(draft({ name: '  Explain  ', instruction: '\n  Explain it.  \n' }), {
            resolveAi,
        });
        assert.deepEqual(result, {
            ok: true,
            value: {
                name: 'Explain',
                icon: 'idea',
                instanceKey: 'openai_compat_ai@a1',
                instruction: 'Explain it.',
                outputMode: 'popup',
            },
        });
    });

    test('icon is optional; output mode defaults to popup', () => {
        const result = validateCustomDraft(
            { name: 'X', instanceKey: 'gemini_ai@b2', instruction: 'do' },
            { resolveAi }
        );
        assert.equal(result.ok, true);
        assert.equal(result.value.icon, null);
        assert.equal(result.value.outputMode, 'popup');
        for (const icon of [undefined, null, '']) {
            assert.equal(validateCustomDraft(draft({ icon }), { resolveAi }).value.icon, null);
        }
        for (const icon of CUSTOM_ICON_IDS) {
            assert.equal(validateCustomDraft(draft({ icon }), { resolveAi }).value.icon, icon);
        }
    });

    test('empty, blank and non-string names are rejected', () => {
        for (const name of ['', '   ', ' ', undefined, null, 42, {}, []]) {
            const result = validateCustomDraft(draft({ name }), { resolveAi });
            assert.equal(result.ok, false, JSON.stringify(name));
            assert.equal(result.errors.name, 'name-empty');
        }
    });

    test('name length counts characters, not UTF-16 units', () => {
        const ok = '\u{1F600}'.repeat(MAX_NAME_LENGTH);
        assert.equal(validateCustomDraft(draft({ name: ok }), { resolveAi }).ok, true);
        const tooLong = validateCustomDraft(draft({ name: ok + '\u{1F600}' }), { resolveAi });
        assert.equal(tooLong.errors.name, 'name-too-long');
    });

    test('control characters, line breaks, bidi overrides and lone surrogates are not allowed in a name', () => {
        for (const name of ['a\nb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a‮b', 'a⁦b', 'a b', 'a\ud800b']) {
            const result = validateCustomDraft(draft({ name }), { resolveAi });
            assert.equal(result.errors?.name, 'name-invalid-chars', JSON.stringify(name));
        }
    });

    test('multilingual, emoji and markup-looking names are plain data and accepted', () => {
        for (const name of [
            '翻译成英文',
            'Резюме',
            'שלום',
            '日本語に',
            '<b>x</b>',
            '{{name}}',
            '${x}',
            'O\'Neil "quote"',
        ]) {
            const result = validateCustomDraft(draft({ name }), { resolveAi });
            assert.equal(result.ok, true, name);
            assert.equal(result.value.name, name);
        }
    });

    test('instruction: empty / too long / control characters rejected, braces quotes and `$` kept verbatim', () => {
        for (const instruction of ['', '  \n ', undefined, 7]) {
            assert.equal(
                validateCustomDraft(draft({ instruction }), { resolveAi }).errors.instruction,
                'instruction-empty'
            );
        }
        assert.equal(
            validateCustomDraft(draft({ instruction: 'x'.repeat(MAX_INSTRUCTION_LENGTH + 1) }), { resolveAi }).errors
                .instruction,
            'instruction-too-long'
        );
        assert.equal(
            validateCustomDraft(draft({ instruction: 'x'.repeat(MAX_INSTRUCTION_LENGTH) }), { resolveAi }).ok,
            true
        );
        for (const instruction of ['a\u0000b', 'a\u0007b', 'a\ud800b']) {
            assert.equal(
                validateCustomDraft(draft({ instruction }), { resolveAi }).errors.instruction,
                'instruction-invalid-chars'
            );
        }
        const tricky =
            'Reply as JSON {"text": "{{selection}}", \'k\': ${x}} `code` $1 $& <script>alert(1)</script>\n\t翻訳 مرحبا';
        const result = validateCustomDraft(draft({ instruction: tricky }), { resolveAi });
        assert.equal(result.ok, true);
        assert.equal(result.value.instruction, tricky, 'no template processing, escaping or rewriting');
    });

    test('names must be unique ignoring case, width and composition; the edited action does not clash with itself', () => {
        const others = [{ id: 'a', name: 'Summary' }];
        for (const name of ['summary', 'SUMMARY', ' Summary ', 'Ｓummary']) {
            assert.equal(
                validateCustomDraft(draft({ name }), { resolveAi, others }).errors.name,
                'name-duplicate',
                name
            );
        }
        assert.equal(validateCustomDraft(draft({ name: 'Summary 2' }), { resolveAi, others }).ok, true);
        assert.equal(validateCustomDraft(draft({ name: 'Summary' }), { resolveAi, others: [] }).ok, true);
        const composed = [{ id: 'c', name: 'café' }];
        assert.equal(
            validateCustomDraft(draft({ name: 'café' }), { resolveAi, others: composed }).errors.name,
            'name-duplicate'
        );
    });

    test('unknown or hostile icons are rejected, never stored', () => {
        for (const icon of ['<img src=x onerror=alert(1)>', 'https://x.test/a.png', 'rocket', 7, {}, 'sparkles ']) {
            assert.equal(validateCustomDraft(draft({ icon }), { resolveAi }).errors.icon, 'icon-unknown', String(icon));
        }
    });

    test('the AI service instance must be chosen, configured and able to run actions', () => {
        assert.equal(
            validateCustomDraft(draft({ instanceKey: '' }), { resolveAi }).errors.instanceKey,
            'service-required'
        );
        assert.equal(
            validateCustomDraft(draft({ instanceKey: undefined }), { resolveAi }).errors.instanceKey,
            'service-required'
        );
        assert.equal(
            validateCustomDraft(draft({ instanceKey: 7 }), { resolveAi }).errors.instanceKey,
            'service-required'
        );
        assert.equal(
            validateCustomDraft(draft({ instanceKey: 'openai_ai@gone' }), { resolveAi }).errors.instanceKey,
            'service-missing'
        );
        assert.equal(
            validateCustomDraft(draft({ instanceKey: 'plugin_ai@x' }), { resolveAi }).errors.instanceKey,
            'service-unsupported'
        );
        // two instances of one provider are independently valid
        for (const instanceKey of ['openai_compat_ai@a1', 'openai_compat_ai@a2']) {
            assert.equal(validateCustomDraft(draft({ instanceKey }), { resolveAi }).ok, true);
        }
    });

    test('an output mode other than popup is rejected honestly', () => {
        for (const outputMode of ['replace', 'clipboard', 'Popup', '', null, 3, {}]) {
            assert.equal(
                validateCustomDraft(draft({ outputMode }), { resolveAi }).errors.outputMode,
                'output-mode-unsupported',
                String(outputMode)
            );
        }
    });

    test('several problems are all reported at once; a non-object draft is just invalid', () => {
        const result = validateCustomDraft(
            { name: '', instruction: '', icon: 'x', instanceKey: '', outputMode: 'x' },
            { resolveAi }
        );
        assert.deepEqual(Object.keys(result.errors).sort(), [
            'icon',
            'instanceKey',
            'instruction',
            'name',
            'outputMode',
        ]);
        for (const value of [null, undefined, 'text', 5, []]) {
            const r = validateCustomDraft(value, { resolveAi });
            assert.equal(r.ok, false);
            assert.equal(r.errors.name, 'name-empty');
        }
    });

    test('validation is local: no network, the service check is the only lookup', () => {
        validateCustomDraft(draft(), { resolveAi });
        assert.deepEqual(resolveCalls, ['openai_compat_ai@a1']);
    });
});

describe('readCustomActions: whatever is stored degrades safely', () => {
    test('nothing stored = empty', () => {
        for (const raw of [null, undefined]) {
            assert.deepEqual(readCustomActions(raw), { format: StoredFormat.EMPTY, actions: [], unreadable: [] });
        }
    });

    test('a value this version cannot interpret is UNSUPPORTED (nothing offered, nothing thrown)', () => {
        const values = [
            'garbage',
            42,
            true,
            [],
            [{ id: 'a' }],
            {},
            { actions: [] },
            { version: 2, actions: [] },
            { version: '1', actions: [] },
            { version: 1 },
            { version: 1, actions: {} },
            { version: 1, actions: 'x' },
        ];
        for (const raw of values) {
            const read = readCustomActions(raw);
            assert.equal(read.format, StoredFormat.UNSUPPORTED, JSON.stringify(raw));
            assert.deepEqual(read.actions, []);
        }
    });

    test('a valid entry is read as stored; the revision defaults, an unknown icon degrades', () => {
        const { actions, format } = readCustomActions({
            version: 1,
            actions: [
                {
                    id: 'ca_1',
                    name: ' Name ',
                    icon: 'nope',
                    instanceKey: 'gemini_ai@b2',
                    instruction: ' go ',
                    outputMode: 'popup',
                    future: { x: 1 },
                },
            ],
        });
        assert.equal(format, StoredFormat.OK);
        assert.deepEqual(actions, [
            {
                id: 'ca_1',
                name: 'Name',
                icon: null,
                instanceKey: 'gemini_ai@b2',
                instruction: 'go',
                outputMode: 'popup',
                revision: 1,
                problem: null,
            },
        ]);
    });

    test('unusable entries are counted, never thrown on, never shown', () => {
        const good = {
            id: 'ok',
            name: 'Ok',
            instanceKey: 'gemini_ai@b2',
            instruction: 'x',
            outputMode: 'popup',
            revision: 3,
        };
        const entries = [
            good,
            null,
            'string',
            [],
            7,
            { ...good, id: 'bad id!' },
            { ...good, id: '' },
            { ...good, id: 'x'.repeat(65) },
            { ...good, id: 'n1', name: '' },
            { ...good, id: 'n2', name: 'a\nb' },
            { ...good, id: 'n3', name: 'x'.repeat(MAX_NAME_LENGTH + 1) },
            { ...good, id: 'n4', name: 5 },
            { ...good, id: 'i1', instruction: '' },
            { ...good, id: 'i2', instruction: null },
            { ...good, id: 'k1', instanceKey: '' },
            { ...good, id: 'k2', instanceKey: 7 },
            { ...good, id: 'm1', outputMode: undefined },
            { ...good, id: 'm2', outputMode: '' },
            { ...good }, // duplicate id of the first
        ];
        const read = readCustomActions({ version: 1, actions: entries });
        assert.deepEqual(
            read.actions.map((a) => a.id),
            ['ok']
        );
        assert.equal(read.actions[0].revision, 3);
        assert.equal(read.unreadable.length, entries.length - 1);
    });

    test('an unknown output mode keeps the action visible but marked unsupported', () => {
        const { actions } = readCustomActions({
            version: 1,
            actions: [
                { id: 'f', name: 'Future', instanceKey: 'gemini_ai@b2', instruction: 'x', outputMode: 'replace' },
            ],
        });
        assert.equal(actions.length, 1);
        assert.equal(actions[0].problem, EntryProblem.UNSUPPORTED_OUTPUT_MODE);
        assert.equal(actions[0].outputMode, 'replace');
    });

    test('reading never mutates its input', () => {
        const raw = Object.freeze({
            version: 1,
            actions: Object.freeze([
                Object.freeze({ id: 'a', name: 'A', instanceKey: 'k', instruction: 'x', outputMode: 'popup' }),
                null,
            ]),
        });
        const before = JSON.stringify(raw);
        readCustomActions(raw);
        assert.equal(JSON.stringify(raw), before);
    });
});

describe('create / edit / delete', () => {
    test('create: stable generated id, revision 1, only referenced fields, input untouched', () => {
        const raw = Object.freeze({ version: 1, actions: Object.freeze([]) });
        const made = create(raw);
        assert.equal(made.ok, true);
        assert.deepEqual(made.action, {
            id: 'ca_test_1',
            name: 'Explain',
            icon: 'idea',
            instanceKey: 'openai_compat_ai@a1',
            instruction: 'Explain the selected text in simple words.',
            outputMode: 'popup',
            revision: 1,
        });
        assert.deepEqual(made.next, { version: 1, actions: [made.action] });
        assert.deepEqual(raw, { version: 1, actions: [] });
        assert.ok(!JSON.stringify(made.next).match(/apiKey|api_key|secret|Authorization/i));
    });

    test('create from nothing stored builds the versioned object', () => {
        for (const raw of [null, undefined]) {
            const made = create(raw);
            assert.equal(made.ok, true);
            assert.equal(made.next.version, 1);
            assert.equal(made.next.actions.length, 1);
        }
    });

    test('default ids are unique, URL-safe and not derived from the name', () => {
        const a = createCustomAction(null, draft(), { resolveAi });
        const b = createCustomAction(null, draft(), { resolveAi });
        assert.match(a.action.id, /^[A-Za-z0-9_-]{1,64}$/);
        assert.notEqual(a.action.id, b.action.id);
        assert.ok(!a.action.id.includes('Explain'));
    });

    test('a colliding or malformed generated id is retried, then refused (bounded)', () => {
        const raw = { version: 1, actions: [{ id: 'dup', name: 'Other' }] };
        const sequence = ['dup', 'bad id', 'fresh'];
        const made = createCustomAction(raw, draft(), { resolveAi, generateId: () => sequence.shift() });
        assert.equal(made.action.id, 'fresh');
        const stuck = createCustomAction(raw, draft(), { resolveAi, generateId: () => 'dup' });
        assert.equal(stuck.ok, false);
        assert.equal(stuck.errors.form, 'id-unavailable');
    });

    test('create: invalid drafts and duplicate names do not change anything', () => {
        const first = create(null).next;
        const dup = create(first, { name: 'explain' });
        assert.equal(dup.ok, false);
        assert.equal(dup.reason, OpReason.INVALID);
        assert.equal(dup.errors.name, 'name-duplicate');
        const bad = create(first, { name: 'Other', instanceKey: 'openai_ai@gone' });
        assert.equal(bad.errors.instanceKey, 'service-missing');
    });

    test('create: the number of actions is capped', () => {
        let raw = null;
        for (let i = 0; i < MAX_CUSTOM_ACTIONS; i += 1) raw = create(raw, { name: `A${i}` }).next;
        const over = create(raw, { name: 'one more' });
        assert.equal(over.ok, false);
        assert.equal(over.errors.form, 'too-many');
        assert.equal(raw.actions.length, MAX_CUSTOM_ACTIONS);
    });

    test('edit keeps the id, bumps the revision and rewrites only that action', () => {
        let raw = create(null, { name: 'One' }).next;
        raw = create(raw, { name: 'Two' }).next;
        const [one, two] = raw.actions;
        const edited = updateCustomAction(
            raw,
            one.id,
            1,
            draft({ name: 'One v2', instruction: 'new instruction {x}', instanceKey: 'gemini_ai@b2', icon: '' }),
            { resolveAi }
        );
        assert.equal(edited.ok, true);
        assert.equal(edited.action.id, one.id);
        assert.equal(edited.action.revision, 2);
        assert.deepEqual(edited.next.actions[1], two, 'the other action is untouched');
        assert.equal(edited.next.actions[0].name, 'One v2');
        assert.equal(edited.next.actions[0].icon, null);
        assert.equal(edited.next.actions[0].instanceKey, 'gemini_ai@b2');
        assert.equal(raw.actions[0].name, 'One', 'input not mutated');
    });

    test('edit: a stale revision is refused and reports the current stored action', () => {
        const raw = create(null).next;
        const id = raw.actions[0].id;
        const once = updateCustomAction(raw, id, 1, draft({ name: 'B' }), { resolveAi });
        const stale = updateCustomAction(once.next, id, 1, draft({ name: 'C' }), { resolveAi });
        assert.equal(stale.ok, false);
        assert.equal(stale.reason, OpReason.STALE);
        assert.equal(stale.current.name, 'B');
        assert.equal(stale.current.revision, 2);
    });

    test('edit / delete of a deleted action is NOT_FOUND, never a silent re-create', () => {
        const raw = create(null).next;
        const id = raw.actions[0].id;
        const gone = deleteCustomAction(raw, id, 1);
        assert.equal(gone.ok, true);
        assert.deepEqual(gone.next.actions, []);
        assert.equal(updateCustomAction(gone.next, id, 1, draft(), { resolveAi }).reason, OpReason.NOT_FOUND);
        assert.equal(deleteCustomAction(gone.next, id, 1).reason, OpReason.NOT_FOUND);
        assert.equal(updateCustomAction(raw, 'nope', 1, draft(), { resolveAi }).reason, OpReason.NOT_FOUND);
    });

    test('delete: a stale revision is refused; the matching revision deletes only that action', () => {
        let raw = create(null, { name: 'One' }).next;
        raw = create(raw, { name: 'Two' }).next;
        const [one, two] = raw.actions;
        const bumped = updateCustomAction(raw, one.id, 1, draft({ name: 'One b' }), { resolveAi }).next;
        assert.equal(deleteCustomAction(bumped, one.id, 1).reason, OpReason.STALE);
        const deleted = deleteCustomAction(bumped, one.id, 2);
        assert.equal(deleted.ok, true);
        assert.deepEqual(deleted.next.actions, [two]);
    });

    test('an edit can repair an action stored with an unsupported output mode', () => {
        const raw = {
            version: 1,
            actions: [
                {
                    id: 'f',
                    name: 'Future',
                    instanceKey: 'gemini_ai@b2',
                    instruction: 'x',
                    outputMode: 'replace',
                    revision: 4,
                },
            ],
        };
        const rejected = updateCustomAction(raw, 'f', 4, draft({ name: 'Future', outputMode: 'replace' }), {
            resolveAi,
        });
        assert.equal(rejected.errors.outputMode, 'output-mode-unsupported');
        const fixed = updateCustomAction(
            raw,
            'f',
            4,
            draft({ name: 'Future', instanceKey: 'gemini_ai@b2', outputMode: 'popup' }),
            { resolveAi }
        );
        assert.equal(fixed.ok, true);
        assert.equal(fixed.action.outputMode, 'popup');
        assert.equal(fixed.action.revision, 5);
    });

    test('unknown fields, unreadable entries and other top-level keys survive every operation', () => {
        const odd = { weird: true, id: 5 };
        const raw = {
            version: 1,
            futureTopLevel: { keep: 'me' },
            actions: [
                odd,
                {
                    id: 'a',
                    name: 'A',
                    instanceKey: 'gemini_ai@b2',
                    instruction: 'x',
                    outputMode: 'popup',
                    revision: 1,
                    futureField: [1, 2],
                },
                'junk',
            ],
        };
        const created = create(raw, { name: 'New' });
        assert.equal(created.next.futureTopLevel.keep, 'me');
        assert.deepEqual(created.next.actions.slice(0, 3), raw.actions);
        const edited = updateCustomAction(raw, 'a', 1, draft({ name: 'A2', instanceKey: 'gemini_ai@b2' }), {
            resolveAi,
        });
        assert.deepEqual(edited.next.actions[0], odd);
        assert.deepEqual(edited.next.actions[2], 'junk');
        assert.deepEqual(edited.next.actions[1].futureField, [1, 2]);
        assert.equal(edited.next.futureTopLevel.keep, 'me');
        const deleted = deleteCustomAction(raw, 'a', 1);
        assert.deepEqual(deleted.next.actions, [odd, 'junk']);
    });

    test('purge removes exactly the unreadable entries and nothing else', () => {
        const good = {
            id: 'a',
            name: 'A',
            instanceKey: 'gemini_ai@b2',
            instruction: 'x',
            outputMode: 'popup',
            revision: 1,
        };
        const raw = { version: 1, extra: 1, actions: [null, good, { id: 'b' }, { ...good }] };
        const purged = purgeUnreadableActions(raw);
        assert.equal(purged.removed, 3);
        assert.deepEqual(purged.next, { version: 1, extra: 1, actions: [good] });
        const clean = { version: 1, actions: [good] };
        assert.equal(purgeUnreadableActions(clean).next, clean);
    });

    test('an unsupported stored format is never modified by create / edit / delete / purge; reset is explicit', () => {
        for (const raw of ['garbage', { version: 2, actions: [] }, [{ id: 'x' }], 7]) {
            assert.equal(create(raw).reason, OpReason.FORMAT_UNSUPPORTED);
            assert.equal(updateCustomAction(raw, 'x', 1, draft(), { resolveAi }).reason, OpReason.FORMAT_UNSUPPORTED);
            assert.equal(deleteCustomAction(raw, 'x', 1).reason, OpReason.FORMAT_UNSUPPORTED);
            assert.equal(purgeUnreadableActions(raw).reason, OpReason.FORMAT_UNSUPPORTED);
        }
        assert.deepEqual(resetCustomActions(), { ok: true, next: { version: 1, actions: [] } });
    });

    test('editConflict: deleted / changed / unchanged', () => {
        const actions = [{ id: 'a', revision: 2 }];
        assert.equal(editConflict(actions, 'a', 2), null);
        assert.equal(editConflict(actions, 'a', 1), 'changed');
        assert.equal(editConflict(actions, 'gone', 1), 'deleted');
        assert.equal(editConflict([], 'a', 1), 'deleted');
    });
});

describe('persistence through the config store (commit path)', () => {
    let store;
    let emitted;
    const emit = async (event, payload) => emitted.push({ event, payload });
    beforeEach(() => {
        store = new Store();
        emitted = [];
    });
    // The real store serializes to JSON on disk; a reload sees a deep copy, not the live objects.
    const reload = async () => {
        const stored = await store.get(CUSTOM_ACTIONS_CONFIG_KEY);
        return stored === null ? null : JSON.parse(JSON.stringify(stored));
    };
    const api = (overrides = {}) =>
        createCustomActionsApi({
            getStore: () => store,
            emit,
            resolveAi,
            onCommitted: (next) => (api.last = next),
            ...overrides,
        });

    test('create -> persist -> reload keeps the intended data and the same stable id', async () => {
        const actions = api();
        const made = await actions.create(
            draft({ name: '翻译 {x}', instruction: 'Translate to "English" {{keep}} $1' })
        );
        assert.equal(made.ok, true);
        const reloaded = readCustomActions(await reload());
        assert.equal(reloaded.format, StoredFormat.OK);
        assert.equal(reloaded.actions.length, 1);
        const [saved] = reloaded.actions;
        assert.equal(saved.id, made.action.id);
        assert.equal(saved.name, '翻译 {x}');
        assert.equal(saved.instruction, 'Translate to "English" {{keep}} $1');
        assert.equal(saved.instanceKey, 'openai_compat_ai@a1');
        assert.equal(saved.revision, 1);
        // edit -> reload: the id is stable, the revision moved
        const edited = await actions.update(saved.id, 1, draft({ name: 'Renamed' }));
        assert.equal(edited.ok, true);
        const again = readCustomActions(await reload()).actions[0];
        assert.equal(again.id, saved.id);
        assert.equal(again.name, 'Renamed');
        assert.equal(again.revision, 2);
        // delete -> reload: gone
        assert.equal((await actions.remove(saved.id, 2)).ok, true);
        assert.deepEqual(readCustomActions(await reload()).actions, []);
    });

    test('only the custom actions key is written; every other config entry is left exactly as it was', async () => {
        await store.set('ai_service_list', ['openai_compat_ai@a1']);
        await store.set('openai_compat_ai@a1', {
            apiKey: 'sk-SECRET-1234567',
            requestPath: 'https://x.test',
            model: 'm',
        });
        await store.set('selection_action_favorite_languages', ['en']);
        const before = JSON.stringify([...store.data.entries()]);
        const actions = api();
        await actions.create(draft());
        const after = [...store.data.entries()].filter(([key]) => key !== CUSTOM_ACTIONS_CONFIG_KEY);
        assert.equal(JSON.stringify(after), before);
        assert.deepEqual(
            [...store.data.keys()].sort(),
            [
                'ai_service_list',
                'openai_compat_ai@a1',
                CUSTOM_ACTIONS_CONFIG_KEY,
                'selection_action_favorite_languages',
            ].sort()
        );
        // the persisted definitions reference the instance by key and never carry its secret
        assert.ok(!JSON.stringify(store.data.get(CUSTOM_ACTIONS_CONFIG_KEY)).includes('SECRET'));
        assert.ok(!JSON.stringify(store.data.get(CUSTOM_ACTIONS_CONFIG_KEY)).includes('x.test'));
    });

    test('a change is announced on the same event useConfig listens to, with the persisted value', async () => {
        const committed = [];
        const actions = api({ onCommitted: (next) => committed.push(next) });
        const made = await actions.create(draft());
        assert.equal(emitted.length, 1);
        assert.equal(emitted[0].event, 'selection_action_custom_actions_changed');
        assert.deepEqual(emitted[0].payload, made.next);
        assert.deepEqual(committed, [made.next]);
        // a refused operation neither writes nor announces
        const refused = await actions.create(draft({ name: '' }));
        assert.equal(refused.ok, false);
        assert.equal(emitted.length, 1);
        assert.equal(committed.length, 1);
    });

    test('concurrent saves are serialized: neither one is lost', async () => {
        let delay = 0;
        const slow = {
            get: async (key) => {
                await new Promise((resolve) => setTimeout(resolve, (delay += 5) % 20));
                return store.get(key);
            },
            set: (key, value) => store.set(key, value),
            save: () => store.save(),
        };
        const actions = api({ getStore: () => slow });
        const results = await Promise.all(
            ['One', 'Two', 'Three', 'Four'].map((name) => actions.create(draft({ name })))
        );
        assert.ok(results.every((r) => r.ok));
        const read = readCustomActions(await reload());
        assert.deepEqual(read.actions.map((a) => a.name).sort(), ['Four', 'One', 'Three', 'Two']);
        assert.equal(new Set(read.actions.map((a) => a.id)).size, 4);
    });

    test('two editors of one action: the second save is refused as stale and the first save survives', async () => {
        const actions = api();
        const { action } = await actions.create(draft({ name: 'Shared' }));
        const first = await actions.update(action.id, 1, draft({ name: 'First edit' }));
        const second = await actions.update(action.id, 1, draft({ name: 'Second edit' }));
        assert.equal(first.ok, true);
        assert.equal(second.ok, false);
        assert.equal(second.reason, OpReason.STALE);
        assert.equal(readCustomActions(await reload()).actions[0].name, 'First edit');
        // deleting from the old revision is refused too; deleting what was deleted is NOT_FOUND
        assert.equal((await actions.remove(action.id, 1)).reason, OpReason.STALE);
        assert.equal((await actions.remove(action.id, 2)).ok, true);
        assert.equal((await actions.update(action.id, 2, draft())).reason, OpReason.NOT_FOUND);
        assert.deepEqual(readCustomActions(await reload()).actions, []);
    });

    test('a corrupted stored value is not overwritten by an edit; only the explicit reset replaces it', async () => {
        await store.set(CUSTOM_ACTIONS_CONFIG_KEY, { version: 9, actions: 'from the future' });
        const actions = api();
        const refused = await actions.create(draft());
        assert.equal(refused.reason, OpReason.FORMAT_UNSUPPORTED);
        assert.deepEqual(await reload(), { version: 9, actions: 'from the future' });
        assert.equal(emitted.length, 0);
        assert.equal((await actions.reset()).ok, true);
        assert.deepEqual(await reload(), { version: 1, actions: [] });
        assert.equal((await actions.create(draft())).ok, true);
    });

    test('unreadable entries stay in storage through ordinary edits and leave only on the explicit purge', async () => {
        const good = {
            id: 'ok',
            name: 'Ok',
            instanceKey: 'gemini_ai@b2',
            instruction: 'x',
            outputMode: 'popup',
            revision: 1,
        };
        await store.set(CUSTOM_ACTIONS_CONFIG_KEY, { version: 1, actions: [good, { broken: true }, 'junk'] });
        const actions = api();
        await actions.create(draft({ name: 'New' }));
        const stored = await reload();
        assert.deepEqual(stored.actions.slice(0, 3), [good, { broken: true }, 'junk']);
        assert.equal(readCustomActions(stored).unreadable.length, 2);
        const purged = await actions.purgeUnreadable();
        assert.equal(purged.removed, 2);
        const after = readCustomActions(await reload());
        assert.equal(after.unreadable.length, 0);
        assert.deepEqual(
            after.actions.map((a) => a.name),
            ['Ok', 'New']
        );
    });

    test('storage failures are reported, not thrown, and later saves still work', async () => {
        let failGet = true;
        const flaky = {
            get: async (key) => {
                if (failGet) throw new Error('disk offline');
                return store.get(key);
            },
            set: (key, value) => store.set(key, value),
            save: () => store.save(),
        };
        const actions = api({ getStore: () => flaky });
        const failed = await actions.create(draft());
        assert.equal(failed.ok, false);
        assert.equal(failed.reason, OpReason.STORAGE);
        assert.match(failed.detail, /disk offline/);
        failGet = false;
        assert.equal((await actions.create(draft())).ok, true);

        const noSave = {
            get: (k) => store.get(k),
            set: (k, v) => store.set(k, v),
            save: async () => {
                throw new Error('read-only');
            },
        };
        const failedSave = await api({ getStore: () => noSave }).create(draft({ name: 'Other' }));
        assert.equal(failedSave.reason, OpReason.STORAGE);
    });

    test('a failing change notification does not fail an already persisted save', async () => {
        const actions = api({
            emit: async () => {
                throw new Error('no event bus');
            },
        });
        const made = await actions.create(draft());
        assert.equal(made.ok, true);
        assert.equal(readCustomActions(await reload()).actions.length, 1);
    });

    test('the commit reads the stored value again at write time, not a copy taken earlier', async () => {
        const seen = [];
        const result = await commitCustomActions({ store, emit }, (raw) => {
            seen.push(raw);
            return createCustomAction(raw, draft(), { resolveAi });
        });
        assert.equal(result.ok, true);
        await store.set(CUSTOM_ACTIONS_CONFIG_KEY, {
            version: 1,
            actions: [{ ...result.action, name: 'Changed elsewhere', revision: 2 }],
        });
        const stale = await createCustomActionsApi({ getStore: () => store, emit, resolveAi }).update(
            result.action.id,
            1,
            draft({ name: 'Mine' })
        );
        assert.equal(stale.reason, OpReason.STALE);
        assert.equal(seen[0], null);
    });
});
