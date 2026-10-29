// Source-neutral dictionary result and the defensive mappers that produce it.
//
//   DictionaryResult {
//     sourceId, query,
//     headwordMatch: 'exact' | 'variant' | 'unknown',   // does the entry headword equal the query?
//     truncated,                                         // entries/senses/examples were cut for the compact view
//     entries: [{ headword|null, kind|null, partOfSpeech|null,
//                 pronunciations: [{ region|null, ipa|null }],
//                 senses: [{ partOfSpeech|null, definition|null, meanings: string[],
//                            examples: [{ text, translation|null }] }] }],
//     associations: string[]
//   }
//
// A mapper reads only what the source actually supplied: absent IPA / example / part of speech
// stay absent, and a shape it cannot recognise is an `unsupported-response` error, never a
// guessed record. Values are plain strings; nothing here is HTML.
export const DictionaryErrorCode = Object.freeze({
    UNSUPPORTED_LANGUAGE: 'unsupported-language',
    UNSUPPORTED_INPUT: 'unsupported-input',
    TOO_LONG: 'too-long',
    EMPTY_SELECTION: 'empty-selection',
    NOT_FOUND: 'not-found',
    UNSUPPORTED_RESPONSE: 'unsupported-response',
    PROVIDER_FAILED: 'provider-failed',
    NO_SOURCE: 'no-source',
});

export class DictionaryError extends Error {
    constructor(code, detail = '') {
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'DictionaryError';
        this.code = code;
        this.detail = detail;
    }
}

export const MAX_ENTRIES = 4;
export const MAX_SENSES_PER_ENTRY = 5;
export const MAX_MEANINGS_PER_SENSE = 6;
export const MAX_EXAMPLES_PER_SENSE = 1;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const textList = (value) => (Array.isArray(value) ? value.map(text).filter((x) => x !== null) : []);
const unsupported = (detail) => new DictionaryError(DictionaryErrorCode.UNSUPPORTED_RESPONSE, detail);

// Cap a list and remember whether anything was dropped.
function cap(list, max, flags) {
    if (list.length > max) flags.truncated = true;
    return list.slice(0, max);
}

function mapSense(raw, flags) {
    if (!isObject(raw)) return null;
    const definition = text(raw.definition);
    const meanings = cap(textList(raw.meanings), MAX_MEANINGS_PER_SENSE, flags);
    if (definition === null && meanings.length === 0) return null;
    const examples = [];
    for (const example of Array.isArray(raw.examples) ? raw.examples : []) {
        if (isObject(example) && text(example.text)) {
            examples.push({ text: text(example.text), translation: text(example.translation) });
        }
    }
    return {
        partOfSpeech: text(raw.partOfSpeech),
        definition,
        meanings,
        examples: cap(examples, MAX_EXAMPLES_PER_SENSE, flags),
    };
}

function mapPronunciation(raw) {
    if (!isObject(raw)) return null;
    const pronunciation = { region: text(raw.region), ipa: text(raw.ipa) };
    return pronunciation.region || pronunciation.ipa ? pronunciation : null;
}

function mapEntry(raw, flags) {
    if (!isObject(raw) || !Array.isArray(raw.senses)) return null;
    const senses = cap(
        raw.senses.map((sense) => mapSense(sense, flags)).filter(Boolean),
        MAX_SENSES_PER_ENTRY,
        flags
    );
    if (senses.length === 0) return null;
    return {
        headword: text(raw.headword),
        kind: text(raw.kind),
        partOfSpeech: text(raw.partOfSpeech),
        pronunciations: (Array.isArray(raw.pronunciations) ? raw.pronunciations : [])
            .map(mapPronunciation)
            .filter(Boolean),
        senses,
    };
}

const normalizeWord = (value) =>
    String(value ?? '')
        .toLowerCase()
        .replace(/[-\s]+/g, ' ')
        .trim();

function finish(sourceId, query, rawEntries, associations, flags) {
    const mapped = rawEntries.map((entry) => mapEntry(entry, flags)).filter(Boolean);
    if (mapped.length === 0) throw unsupported('no usable entry');
    const entries = cap(mapped, MAX_ENTRIES, flags);
    const headwords = entries.map((entry) => entry.headword).filter(Boolean);
    const headwordMatch =
        headwords.length === 0
            ? 'unknown'
            : headwords.every((word) => normalizeWord(word) === normalizeWord(query))
              ? 'exact'
              : 'variant';
    return {
        sourceId,
        query,
        headwordMatch,
        truncated: flags.truncated,
        entries,
        associations: associations.slice(0, 6),
    };
}

// Cambridge: output of cambridge_dict `lookup()` (see parseCambridgeDocument).
export function mapCambridgeResult(raw, query) {
    if (!isObject(raw)) throw unsupported('not an object');
    switch (raw.page) {
        case 'not-found':
            throw new DictionaryError(DictionaryErrorCode.NOT_FOUND);
        case 'unrecognized':
            throw unsupported('unrecognized page');
        case 'entry':
            break;
        default:
            throw unsupported('unknown page state');
    }
    if (!Array.isArray(raw.entries)) throw unsupported('entries missing');
    if (raw.match === 'none') throw new DictionaryError(DictionaryErrorCode.NOT_FOUND);
    if (raw.match !== 'exact' && raw.match !== 'variant') throw unsupported('unknown match state');
    return finish('cambridge_dict', query, raw.entries, [], { truncated: false });
}

// bing_dict / ecdict: the adapters answer with { pronunciations: [{region, symbol}],
// explanations: [{trait, explains}], associations: [] }. Sentence examples are not mapped
// (their HTML-bearing shape is unverified); `voice` audio is ignored (TTS is the pronunciation).
export function mapLegacyDictionaryResult(sourceId) {
    return (raw, query) => {
        if (!isObject(raw)) throw unsupported('not an object');
        const hasShape =
            Array.isArray(raw.pronunciations) || Array.isArray(raw.explanations) || Array.isArray(raw.associations);
        if (!hasShape) throw unsupported('unknown shape');
        const senses = (Array.isArray(raw.explanations) ? raw.explanations : [])
            .map((explanation) => {
                if (!isObject(explanation)) return null;
                const list = Array.isArray(explanation.explains) ? explanation.explains : [];
                const meanings = list
                    .map((item) => (typeof item === 'string' ? text(item) : isObject(item) ? text(item.word) : null))
                    .filter(Boolean);
                return meanings.length > 0 ? { partOfSpeech: text(explanation.trait), meanings } : null;
            })
            .filter(Boolean);
        if (senses.length === 0) {
            const hasAnything = (raw.pronunciations?.length ?? 0) > 0 || (raw.associations?.length ?? 0) > 0;
            throw hasAnything ? unsupported('no meanings') : new DictionaryError(DictionaryErrorCode.NOT_FOUND);
        }
        const pronunciations = (Array.isArray(raw.pronunciations) ? raw.pronunciations : []).map((p) =>
            isObject(p) ? { region: p.region, ipa: p.symbol } : null
        );
        return finish(
            sourceId,
            query,
            [{ headword: null, pronunciations, senses }],
            textList(raw.associations),
            { truncated: false }
        );
    };
}
