import { v4 as uuidv4 } from 'uuid';

// Custom AI Actions: user-defined named instructions that run over the selected text with one of the
// user's existing AI service instances. This module is the data model only - reading whatever is
// stored, validating a draft, and the pure create / edit / delete operations. Execution lives in the
// shared AI runner (aiRunner.js) and the registry definition in aiActions.js; nothing here talks to
// a provider, and no API key is ever part of a definition (an action only references an instance key).

// Persisted through the existing config store / useConfig mechanism as one value:
//   { version: 1, actions: [ { id, name, icon, instanceKey, instruction, outputMode, revision } ] }
export const CUSTOM_ACTIONS_CONFIG_KEY = 'selection_action_custom_actions';
export const CUSTOM_ACTIONS_VERSION = 1;
export const EMPTY_CUSTOM_ACTIONS = Object.freeze({ version: CUSTOM_ACTIONS_VERSION, actions: Object.freeze([]) });

export const CUSTOM_AI_ACTION_ID = 'custom_ai';

// Where the result is shown. Only the popup (the AI result panel of the selection window) exists;
// anything else stored is reported as unsupported and never run.
export const CustomOutputMode = Object.freeze({ POPUP: 'popup' });
export const SUPPORTED_OUTPUT_MODES = Object.freeze([CustomOutputMode.POPUP]);

export const MAX_CUSTOM_ACTIONS = 20;
export const MAX_NAME_LENGTH = 40;
export const MAX_INSTRUCTION_LENGTH = 4000;

// Icons are chosen from a fixed list of identifiers; the palette maps them to its own bundled icon
// components. An icon is never a URL, markup or user-supplied glyph.
export const CUSTOM_ICON_IDS = Object.freeze([
    'sparkles',
    'edit',
    'translate',
    'summary',
    'idea',
    'spellcheck',
    'code',
    'question',
    'book',
    'mood',
    'list',
    'star',
]);

// A stored entry that has a problem but can be shown (and fixed by editing it).
export const EntryProblem = Object.freeze({ UNSUPPORTED_OUTPUT_MODE: 'unsupported-output-mode' });

// Result of a read of the stored value.
export const StoredFormat = Object.freeze({
    EMPTY: 'empty', // nothing stored yet
    OK: 'ok',
    UNSUPPORTED: 'unsupported', // something is stored that this version cannot interpret
});

// Failure reasons of an operation (`{ ok: false, reason }`).
export const OpReason = Object.freeze({
    INVALID: 'invalid', // `errors` has one code per field
    FORMAT_UNSUPPORTED: 'format-unsupported',
    NOT_FOUND: 'not-found', // the action was deleted meanwhile
    STALE: 'stale', // the action was changed meanwhile
    STORAGE: 'storage-error',
});

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// C0/C1 controls, line/paragraph separators and bidi embedding/override/isolate controls.
const NAME_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
// Control characters other than tab / line breaks.
const TEXT_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const codePoints = (text) => [...text].length;
const nameKey = (name) => name.normalize('NFKC').toLocaleLowerCase();

/**
 * Validate the fields of a draft (the editor form). Pure: no storage, no network.
 *   draft: { name, icon, instanceKey, instruction, outputMode }
 *   others: the other stored, readable actions (duplicate-name check; the edited one excluded)
 *   resolveAi(instanceKey): { status: 'ready' } or { status: 'unavailable', code } from the live
 *     ai_service_list (see resolveAiSelection)
 * Returns { ok: true, value } with normalized fields, or { ok: false, errors } with one error code
 * per bad field (i18n key `selection_actions.custom.errors.<code>`).
 */
export function validateCustomDraft(draft, { others = [], resolveAi }) {
    const input = isRecord(draft) ? draft : {};
    const errors = {};

    const name = typeof input.name === 'string' ? input.name.normalize('NFC').trim() : '';
    if (name === '') errors.name = 'name-empty';
    else if (NAME_FORBIDDEN.test(name) || LONE_SURROGATE.test(name)) errors.name = 'name-invalid-chars';
    else if (codePoints(name) > MAX_NAME_LENGTH) errors.name = 'name-too-long';
    else if (others.some((other) => nameKey(other.name) === nameKey(name))) errors.name = 'name-duplicate';

    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
    if (instruction === '') errors.instruction = 'instruction-empty';
    else if (TEXT_FORBIDDEN.test(instruction) || LONE_SURROGATE.test(instruction)) {
        errors.instruction = 'instruction-invalid-chars';
    } else if (codePoints(instruction) > MAX_INSTRUCTION_LENGTH) errors.instruction = 'instruction-too-long';

    let icon = null;
    if (input.icon !== undefined && input.icon !== null && input.icon !== '') {
        if (typeof input.icon === 'string' && CUSTOM_ICON_IDS.includes(input.icon)) icon = input.icon;
        else errors.icon = 'icon-unknown';
    }

    const instanceKey = typeof input.instanceKey === 'string' ? input.instanceKey : '';
    if (instanceKey === '') errors.instanceKey = 'service-required';
    else {
        const ai = resolveAi(instanceKey);
        if (ai.status !== 'ready') {
            errors.instanceKey = ai.code === 'ai-unsupported-service' ? 'service-unsupported' : 'service-missing';
        }
    }

    const outputMode = input.outputMode === undefined ? CustomOutputMode.POPUP : input.outputMode;
    if (typeof outputMode !== 'string' || !SUPPORTED_OUTPUT_MODES.includes(outputMode)) {
        errors.outputMode = 'output-mode-unsupported';
    }

    return Object.keys(errors).length > 0
        ? { ok: false, errors }
        : { ok: true, value: { name, icon, instanceKey, instruction, outputMode } };
}

// One stored entry -> a usable definition, or null when it cannot be used at all.
function readEntry(item) {
    if (!isRecord(item)) return null;
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) return null;
    if (typeof item.name !== 'string') return null;
    const name = item.name.normalize('NFC').trim();
    if (name === '' || NAME_FORBIDDEN.test(name) || LONE_SURROGATE.test(name) || codePoints(name) > MAX_NAME_LENGTH) {
        return null;
    }
    if (typeof item.instruction !== 'string') return null;
    const instruction = item.instruction.trim();
    if (
        instruction === '' ||
        TEXT_FORBIDDEN.test(instruction) ||
        LONE_SURROGATE.test(instruction) ||
        codePoints(instruction) > MAX_INSTRUCTION_LENGTH
    ) {
        return null;
    }
    if (typeof item.instanceKey !== 'string' || item.instanceKey === '') return null;
    if (typeof item.outputMode !== 'string' || item.outputMode === '') return null;
    return {
        id: item.id,
        name,
        // An unknown icon degrades to "no icon"; it does not make the action unusable.
        icon: typeof item.icon === 'string' && CUSTOM_ICON_IDS.includes(item.icon) ? item.icon : null,
        instanceKey: item.instanceKey,
        instruction,
        outputMode: item.outputMode,
        revision: Number.isSafeInteger(item.revision) && item.revision >= 1 ? item.revision : 1,
        problem: SUPPORTED_OUTPUT_MODES.includes(item.outputMode) ? null : EntryProblem.UNSUPPORTED_OUTPUT_MODE,
    };
}

/**
 * Interpret the stored value. Never throws and never writes. Returns
 *   { format, actions, unreadable }
 * - `actions`: readable definitions in stored order. An action with an unknown output mode is
 *   included with `problem` set (it is shown but never run).
 * - `unreadable`: entries that cannot be used (malformed or duplicate id); they are kept untouched in
 *   storage by every operation except the explicit purge.
 * - `format`: EMPTY (nothing stored), OK, or UNSUPPORTED (another version / shape). In an unsupported
 *   format nothing is offered for use and every edit is refused, so it cannot be overwritten by
 *   accident.
 */
export function readCustomActions(raw) {
    if (raw === null || raw === undefined) return { format: StoredFormat.EMPTY, actions: [], unreadable: [] };
    if (!isRecord(raw) || raw.version !== CUSTOM_ACTIONS_VERSION || !Array.isArray(raw.actions)) {
        return { format: StoredFormat.UNSUPPORTED, actions: [], unreadable: [] };
    }
    const actions = [];
    const unreadable = [];
    const seen = new Set();
    raw.actions.forEach((item, index) => {
        const entry = readEntry(item);
        if (!entry || seen.has(entry.id)) unreadable.push(index);
        else {
            seen.add(entry.id);
            actions.push(entry);
        }
    });
    return { format: StoredFormat.OK, actions, unreadable };
}

// Raw items that are usable definitions, with the index they have in `raw.actions`.
function rawActionsOf(raw) {
    if (raw === null || raw === undefined) return [];
    return raw.actions;
}

function indexOfAction(raw, id) {
    const seen = new Set();
    const items = rawActionsOf(raw);
    for (let index = 0; index < items.length; index += 1) {
        const entry = readEntry(items[index]);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        if (entry.id === id) return index;
    }
    return -1;
}

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// A stored value an operation may build on: nothing yet, or the supported shape.
function writable(raw) {
    const read = readCustomActions(raw);
    return read.format === StoredFormat.UNSUPPORTED ? null : read;
}

// The base of the next stored value: the current object (unknown top-level fields kept), or fresh.
const baseOf = (raw) => (isRecord(raw) ? raw : {});

/**
 * Add a new action. `generateId` is injectable for tests; ids are never reused for an existing one.
 * Returns { ok: true, next, action } or { ok: false, reason, errors? }.
 */
export function createCustomAction(raw, draft, { resolveAi, generateId = () => `ca_${uuidv4()}` }) {
    const read = writable(raw);
    if (!read) return fail(OpReason.FORMAT_UNSUPPORTED);
    const items = rawActionsOf(raw);
    if (items.length >= MAX_CUSTOM_ACTIONS) return fail(OpReason.INVALID, { errors: { form: 'too-many' } });
    const checked = validateCustomDraft(draft, { others: read.actions, resolveAi });
    if (!checked.ok) return fail(OpReason.INVALID, { errors: checked.errors });
    let id = generateId();
    for (
        let attempt = 0;
        !ID_PATTERN.test(id) || items.some((item) => isRecord(item) && item.id === id);
        attempt += 1
    ) {
        if (attempt >= 10) return fail(OpReason.INVALID, { errors: { form: 'id-unavailable' } });
        id = generateId();
    }
    const entry = { id, ...checked.value, revision: 1 };
    return {
        ok: true,
        action: entry,
        next: { ...baseOf(raw), version: CUSTOM_ACTIONS_VERSION, actions: [...items, entry] },
    };
}

/**
 * Edit an action. `expectedRevision` is the revision the editor opened; if the stored action has
 * moved on (or was deleted) the edit is refused instead of overwriting the newer one. The id never
 * changes, the revision increases by one, fields this version does not know are kept.
 */
export function updateCustomAction(raw, id, expectedRevision, draft, { resolveAi }) {
    const read = writable(raw);
    if (!read) return fail(OpReason.FORMAT_UNSUPPORTED);
    const index = indexOfAction(raw, id);
    if (index < 0) return fail(OpReason.NOT_FOUND);
    const current = readEntry(raw.actions[index]);
    if (current.revision !== expectedRevision) return fail(OpReason.STALE, { current });
    const others = read.actions.filter((action) => action.id !== id);
    const checked = validateCustomDraft(draft, { others, resolveAi });
    if (!checked.ok) return fail(OpReason.INVALID, { errors: checked.errors });
    const entry = { ...raw.actions[index], id, ...checked.value, revision: current.revision + 1 };
    const actions = [...raw.actions];
    actions[index] = entry;
    return { ok: true, action: entry, next: { ...raw, version: CUSTOM_ACTIONS_VERSION, actions } };
}

// Delete an action, with the same stale-revision protection as an edit.
export function deleteCustomAction(raw, id, expectedRevision) {
    const read = writable(raw);
    if (!read) return fail(OpReason.FORMAT_UNSUPPORTED);
    const index = indexOfAction(raw, id);
    if (index < 0) return fail(OpReason.NOT_FOUND);
    const current = readEntry(raw.actions[index]);
    if (current.revision !== expectedRevision) return fail(OpReason.STALE, { current });
    const actions = raw.actions.filter((_, position) => position !== index);
    return { ok: true, action: current, next: { ...raw, version: CUSTOM_ACTIONS_VERSION, actions } };
}

// Explicitly remove the entries that cannot be read (the only way they ever leave storage).
export function purgeUnreadableActions(raw) {
    const read = writable(raw);
    if (!read) return fail(OpReason.FORMAT_UNSUPPORTED);
    if (read.unreadable.length === 0) return { ok: true, next: raw, removed: 0 };
    const drop = new Set(read.unreadable);
    const actions = raw.actions.filter((_, position) => !drop.has(position));
    return { ok: true, next: { ...raw, version: CUSTOM_ACTIONS_VERSION, actions }, removed: drop.size };
}

// Explicit user decision to discard a stored value this version cannot read and start fresh.
export const resetCustomActions = () => ({
    ok: true,
    next: { version: CUSTOM_ACTIONS_VERSION, actions: [] },
});

let commitQueue = Promise.resolve();

/**
 * Apply `operation(freshStoredValue)` to the value currently in the config store and persist the
 * result. The value is read again right before the write (never taken from component state), and
 * commits are serialized, so two quick saves or a second window cannot overwrite each other's edit
 * unnoticed. Only this one config key is written. `emit` announces the change (the same
 * `<key>_changed` event useConfig listens to).
 */
export function commitCustomActions({ store, emit }, operation) {
    const run = async () => {
        try {
            const raw = await store.get(CUSTOM_ACTIONS_CONFIG_KEY);
            const result = operation(raw);
            if (!result.ok) return result;
            await store.set(CUSTOM_ACTIONS_CONFIG_KEY, result.next);
            await store.save();
            try {
                await emit?.(`${CUSTOM_ACTIONS_CONFIG_KEY}_changed`, result.next);
            } catch (_) {
                // The write succeeded; a failed notification only delays other windows' refresh.
            }
            return result;
        } catch (error) {
            return fail(OpReason.STORAGE, { detail: error instanceof Error ? error.message : String(error) });
        }
    };
    const pending = commitQueue.then(run, run);
    commitQueue = pending.catch(() => {});
    return pending;
}

// Has the action an edit form was opened on moved since? null = no, else 'deleted' / 'changed'.
export function editConflict(actions, id, baseRevision) {
    const current = actions.find((action) => action.id === id);
    if (!current) return 'deleted';
    return current.revision !== baseRevision ? 'changed' : null;
}

/**
 * The operations the editor calls, bound to the config store. `getStore()` is read at call time (the
 * store object is replaced once at startup), `resolveAi(instanceKey)` checks an instance against the
 * live ai_service_list, `onCommitted(next)` hands the persisted value to the UI state.
 */
export function createCustomActionsApi({ getStore, emit, resolveAi, onCommitted }) {
    const commit = async (operation) => {
        const result = await commitCustomActions({ store: getStore(), emit }, operation);
        if (result.ok) onCommitted?.(result.next);
        return result;
    };
    return {
        resolveAi,
        create: (draft) => commit((raw) => createCustomAction(raw, draft, { resolveAi })),
        update: (id, revision, draft) => commit((raw) => updateCustomAction(raw, id, revision, draft, { resolveAi })),
        remove: (id, revision) => commit((raw) => deleteCustomAction(raw, id, revision)),
        purgeUnreadable: () => commit((raw) => purgeUnreadableActions(raw)),
        reset: () => commit(() => resetCustomActions()),
    };
}
