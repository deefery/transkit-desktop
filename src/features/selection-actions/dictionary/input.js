// What the Dictionary action accepts: one word or a short phrase. Anything longer is a sentence
// and is never sent to a dictionary (the user is pointed to Sentence Analysis instead).
export const MAX_PHRASE_WORDS = 4;
export const MAX_QUERY_LENGTH = 60;
const MAX_UNSPACED_CJK = 8;

export const InputKind = Object.freeze({
    WORD: 'word',
    PHRASE: 'phrase',
    TOO_LONG: 'too-long',
    INVALID: 'invalid',
    EMPTY: 'empty',
});

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const EDGE_NOISE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
// A terminator followed by more text means a second sentence/clause, not a phrase.
const SENTENCE_BREAK = /[.!?;:。！？；：](?=\s*\S)/u;

/**
 * Classify the selected text. `query` is the whitespace-collapsed text without surrounding
 * quotes/punctuation (what is looked up and compared against headwords).
 */
export function classifyDictionaryInput(text) {
    if (typeof text !== 'string' || text.trim() === '') return { kind: InputKind.EMPTY, query: '' };
    const collapsed = text.replace(/\s+/g, ' ').trim();
    const query = collapsed.replace(EDGE_NOISE, '');
    if (query === '' || !/\p{L}/u.test(query) || /:\/\/|@/.test(query)) {
        return { kind: InputKind.INVALID, query };
    }
    const tokens = query.split(' ');
    if (
        tokens.length > MAX_PHRASE_WORDS ||
        query.length > MAX_QUERY_LENGTH ||
        SENTENCE_BREAK.test(query) ||
        (tokens.length === 1 && CJK.test(query) && [...query].length > MAX_UNSPACED_CJK)
    ) {
        return { kind: InputKind.TOO_LONG, query };
    }
    return { kind: tokens.length === 1 ? InputKind.WORD : InputKind.PHRASE, query };
}
