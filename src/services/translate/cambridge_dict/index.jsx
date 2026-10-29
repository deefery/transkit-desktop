import { fetch } from '@tauri-apps/api/http';
import { Language } from './info';

class Pronunciation {
    constructor(region, symbol, voice) {
        this.region = region;
        this.symbol = symbol;
        this.voice = voice;
    }
}

class Explanation {
    constructor(trait, explains) {
        this.trait = trait;
        this.explains = explains;
    }
}

class WordTranslateResult {
    constructor(pronunciations, explanations) {
        this.pronunciations = pronunciations;
        this.explanations = explanations;
    }
}

function tryDetectLanguage(text) {
    if (/^[A-Za-z]/.test(text)) {
        return Language.en;
    }
    return null;
}

// 翻译服务商：https://dictionary.cambridge.org/
export async function translate(text, from, to) {
    if (Language.auto === from) {
        from = tryDetectLanguage(text) ?? from;
    }
    // only supports English word translation
    if (from !== Language.en || to === undefined || to === from || text.split(' ').length > 1) {
        return '';
    }

    const url = `https://dictionary.cambridge.org/search/direct/?datasetsearch=${from}-${to}&q=${text}`;
    let res = await fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'text/html;charset=UTF-8',
        },
        responseType: 2,
    });

    if (!res.ok) {
        throw new Error(`Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`);
    }
    const doc = new DOMParser().parseFromString(res.data, 'text/html');
    const entryNodes = doc.querySelectorAll('.pr.entry-body__el');
    if (entryNodes.length === 0) {
        throw new Error(`Words not yet included: ${text}`);
    }

    const resultMap = [...entryNodes].reduce((dict, entryNode) => {
        const wordTranslateResult = dict['result'] || new WordTranslateResult([], []);

        if (wordTranslateResult.pronunciations.length === 0) {
            const pronunciationNodes = entryNode.querySelectorAll('.dpron-i');
            const pronunciations = [...pronunciationNodes].map((pronunciationNode) => {
                const region = pronunciationNode.querySelector('.region').innerText;
                const symbol = pronunciationNode.querySelector('.pron').innerText;
                let voice = pronunciationNode.querySelector('.daud source').src;
                voice = voice.replace(/^https?:\/\/[^/]+/, 'https://dictionary.cambridge.org');
                voice = voice.replace(/^tauri:\/\/[^/]+/, 'https://dictionary.cambridge.org');
                return new Pronunciation(region, symbol, voice);
            });
            wordTranslateResult.pronunciations.push(...pronunciations);
        }

        const wordPos = entryNode.querySelector('.posgram')?.innerText;
        const defBlockNodes = entryNode.querySelectorAll('.sense-body.dsense_b .def-block.ddef_block');
        const explanations = [...defBlockNodes].map((defBlockNode) => {
            const trait =
                wordPos ?? defBlockNode.querySelector('.ddef_h .def.ddef_d.db').innerText.replace(/\s+/g, ' ').trim();
            const explains = defBlockNode.querySelector('.def-body.ddef_b .trans.dtrans.dtrans-se.break-cj').innerText;
            return new Explanation(trait, explains.split(';'));
        });
        wordTranslateResult.explanations.push(...explanations);

        dict['result'] = wordTranslateResult;
        return dict;
    }, {});
    for (let i of resultMap.result.pronunciations) {
        const res = await fetch(i.voice, { responseType: 3 });
        if (res.ok) {
            i.voice = res.data;
        }
    }
    return resultMap.result;
}

// ---------------------------------------------------------------------------------------------
// Structured dictionary lookup for the selection Dictionary action. Additive: translate() above
// is unchanged. A page is only trusted for the queried text when an entry headword matches it,
// because Cambridge answers unknown phrases with a *different* entry (e.g. "the quick" is
// redirected to "cut (someone) to the quick").
// ---------------------------------------------------------------------------------------------

export const MAX_LOOKUP_WORDS = 4;

const textOf = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const orNull = (value) => (value === '' ? null : value);

// "Take-off", "take off" and "take  off" are the same headword.
export const normalizeHeadword = (value) =>
    String(value ?? '')
        .toLowerCase()
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[-\u2010-\u2015\s]+/g, ' ')
        .trim();

function parseBlock(root, kind) {
    const headword = textOf(root.querySelector('.di-title .headword') ?? root.querySelector('.headword'));
    const isPhrasal = kind === 'word' && Boolean(root.querySelector('.pv-block'));
    const blockKind = isPhrasal ? 'phrasal-verb' : kind;
    const partOfSpeech = orNull(textOf(root.querySelector('.pos.dpos')));

    // The IPA printed next to a phrasal verb belongs to its base verb, not to the phrase.
    const pronunciations = [];
    if (blockKind === 'word') {
        for (const node of root.querySelectorAll('.dpron-i')) {
            const pronunciation = {
                region: orNull(textOf(node.querySelector('.region'))),
                ipa: orNull(textOf(node.querySelector('.pron'))),
            };
            if (
                (pronunciation.region || pronunciation.ipa) &&
                !pronunciations.some((x) => x.region === pronunciation.region && x.ipa === pronunciation.ipa)
            ) {
                pronunciations.push(pronunciation);
            }
        }
    }

    const senses = [];
    for (const def of root.querySelectorAll('.def-block.ddef_block')) {
        // Idioms listed inside a word entry are separate blocks.
        const owner = def.closest('.idiom-block');
        if (kind !== 'idiom' && owner && root.contains(owner)) continue;
        const definition = orNull(textOf(def.querySelector('.ddef_d')));
        const translation = def.querySelector('.def-body > .trans');
        let meanings = translation ? [...translation.querySelectorAll('.dtrans')].map(textOf).filter(Boolean) : [];
        if (meanings.length === 0 && translation) {
            meanings = textOf(translation)
                .split(/[;\uFF1B]/)
                .map((x) => x.trim())
                .filter(Boolean);
        }
        const examples = [];
        for (const example of def.querySelectorAll('.examp')) {
            const text = textOf(example.querySelector('.eg'));
            if (text) examples.push({ text, translation: orNull(textOf(example.querySelector('.trans'))) });
        }
        if (definition === null && meanings.length === 0) continue;
        senses.push({
            partOfSpeech: orNull(textOf(def.closest('.dsense')?.querySelector('.dsense_pos'))) ?? partOfSpeech,
            definition,
            meanings,
            examples,
        });
    }
    return { headword, kind: blockKind, partOfSpeech, pronunciations, senses };
}

// Entries of a parsed Cambridge page that answer `query`:
//   exact   - headword equals the query (case/hyphen/space-insensitive);
//   variant - single word only: Cambridge's own redirect for an inflected form ("went" -> "go");
//   none    - anything else, never guessed.
export function selectCambridgeEntries(blocks, query) {
    const wanted = normalizeHeadword(query);
    const exact = blocks.filter((b) => b.senses.length > 0 && normalizeHeadword(b.headword) === wanted);
    if (exact.length > 0) return { match: 'exact', entries: exact };
    if (!/\s/.test(wanted)) {
        const words = blocks.filter((b) => b.kind === 'word' && b.senses.length > 0);
        if (words.length > 0) {
            return { match: 'variant', entries: words.filter((b) => b.headword === words[0].headword) };
        }
    }
    return { match: 'none', entries: [] };
}

// page: 'entry' (recognised entry page), 'not-found' (Cambridge's no-match page) or
// 'unrecognized' (anything else, e.g. a changed or blocked page - never read as "not found").
export function parseCambridgeDocument(doc, query) {
    if (!doc.querySelector('.superentry, .di-body')) {
        const marker = `${textOf(doc.querySelector('h1'))} ${textOf(doc.querySelector('title'))}`;
        const notFound = /did not match any entries|did you spell it correctly/i.test(marker);
        return { page: notFound ? 'not-found' : 'unrecognized', match: 'none', entries: [] };
    }
    const blocks = [...doc.querySelectorAll('.entry-body__el')].map((node) => parseBlock(node, 'word'));
    for (const title of doc.querySelectorAll('.idiom-block > .di-title')) {
        blocks.push(parseBlock(title.parentElement, 'idiom'));
    }
    if (blocks.every((b) => b.senses.length === 0)) {
        return { page: 'unrecognized', match: 'none', entries: [] };
    }
    return { page: 'entry', ...selectCambridgeEntries(blocks, query) };
}

export const parseCambridgeHtml = (html, query) =>
    parseCambridgeDocument(new DOMParser().parseFromString(html, 'text/html'), query);

// English -> Chinese lookup of a word or short phrase. `from`/`to` are this module's Language values.
export async function lookup(text, from, to) {
    const query = String(text ?? '').trim();
    if (from !== Language.en || (to !== Language.zh_cn && to !== Language.zh_tw)) {
        throw new Error('Cambridge dictionary lookup supports English to Chinese only');
    }
    if (query === '' || query.split(/\s+/).length > MAX_LOOKUP_WORDS) {
        throw new Error(`Cambridge dictionary lookup supports 1-${MAX_LOOKUP_WORDS} words`);
    }
    const url = `https://dictionary.cambridge.org/search/direct/?datasetsearch=${from}-${to}&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        responseType: 2,
    });
    if (!res.ok) {
        const error = new Error(`Http Request Error\nHttp Status: ${res.status}`);
        error.status = res.status;
        throw error;
    }
    return parseCambridgeHtml(typeof res.data === 'string' ? res.data : '', query);
}

export * from './Config';
export * from './info';
