// Run with: node --test src/features/selection-actions/dictionary/dictionary.unit.test.js
// Input classification, defensive source mappers, source capability checks and the safe
// rendering of the dictionary panel / palette (server-side render of the real components).
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createStore, Provider } from 'jotai';
import { after, before, describe, test } from 'node:test';
import { loadProduction } from '../testing/harness.js';

let p;
let m;
let i18n;
let Panel;
let Palette;

before(async () => {
    p = await loadProduction();
    const load = (path) => p.loader.load(`/src/features/selection-actions/dictionary/${path}`);
    const [input, result, sources, controller, panel] = await Promise.all([
        load('input.js'),
        load('result.js'),
        load('sources.js'),
        load('controller.js'),
        load('DictionaryPanel.jsx'),
    ]);
    m = { ...input, ...result, ...sources, ...controller };
    Panel = panel.DictionaryPanel;
    Palette = (await p.loader.load('/src/features/selection-actions/SelectionActionPalette.jsx')).default;
    i18n = (await p.loader.load('/src/i18n/index.jsx')).default;
    await i18n.changeLanguage('en');
});
after(() => p.loader.close());

describe('input classification', () => {
    const kind = (text) => m.classifyDictionaryInput(text).kind;
    const query = (text) => m.classifyDictionaryInput(text).query;

    test('words, phrases and what is stripped around them', () => {
        assert.equal(kind('resilience'), 'word');
        assert.equal(kind('  Résilience\n'), 'word');
        assert.equal(kind('well-known'), 'word');
        assert.equal(kind("don't"), 'word');
        assert.equal(kind('take off'), 'phrase');
        assert.equal(kind('break   the\nice'), 'phrase');
        assert.equal(query('“take off,”'), 'take off');
        assert.equal(query('(resilience)'), 'resilience');
        assert.equal(query('3D printing'), '3D printing');
        assert.equal(kind('一帆风顺'), 'word');
    });

    test('sentences and long text are too long, never a lookup', () => {
        assert.equal(kind('one two three four five'), 'too-long');
        assert.equal(kind('It works. Really'), 'too-long');
        assert.equal(kind('Wait; what'), 'too-long');
        assert.equal(kind('a'.repeat(61)), 'too-long');
        assert.equal(kind('这是一个很长的没有空格的中文句子'), 'too-long');
        assert.equal(kind('Hello world.'), 'phrase', 'a final period is stripped');
    });

    test('empty and non-lexical input', () => {
        assert.equal(kind(''), 'empty');
        assert.equal(kind('   \n'), 'empty');
        assert.equal(kind(undefined), 'empty');
        assert.equal(kind(42), 'empty');
        for (const text of ['12345', '...', '— –', 'https://a.example/x', 'user@host.example', '❤️']) {
            assert.equal(kind(text), 'invalid', text);
        }
    });
});

describe('defensive mappers', () => {
    const rawEntry = (over = {}) => ({
        page: 'entry',
        match: 'exact',
        entries: [
            {
                headword: 'word',
                kind: 'word',
                partOfSpeech: 'noun',
                pronunciations: [{ region: 'uk', ipa: '/w/' }],
                senses: [{ partOfSpeech: 'noun', definition: 'd', meanings: ['m'], examples: [{ text: 'e', translation: 't' }] }],
            },
        ],
        ...over,
    });
    const map = (raw, query = 'word') => m.DICTIONARY_SOURCES.cambridge_dict.map(raw, query);
    const code = (fn) => {
        try {
            fn();
        } catch (e) {
            assert.ok(e instanceof m.DictionaryError, String(e));
            return e.code;
        }
        return 'no error';
    };

    test('Cambridge: a well-formed page maps field for field, with provenance', () => {
        const result = map(rawEntry());
        assert.equal(result.sourceId, 'cambridge_dict');
        assert.equal(result.query, 'word');
        assert.equal(result.headwordMatch, 'exact');
        assert.equal(result.truncated, false);
        assert.deepEqual(result.entries[0].senses[0].examples, [{ text: 'e', translation: 't' }]);
    });

    test('Cambridge: absent optional fields stay null/empty; values of the wrong type are dropped, not coerced', () => {
        const result = map({
            page: 'entry',
            match: 'exact',
            entries: [
                {
                    headword: 'word',
                    kind: 7,
                    partOfSpeech: ['noun'],
                    pronunciations: [{ region: 1, ipa: '' }, null, { ipa: '/i/' }, 'x'],
                    senses: [
                        { definition: 12, meanings: ['ok', 5, '', null, '  spaced  '], examples: [{ text: 9 }, { text: 'e' }, null] },
                        { definition: null, meanings: [] },
                        'nope',
                    ],
                },
            ],
        });
        const entry = result.entries[0];
        assert.equal(entry.kind, null);
        assert.equal(entry.partOfSpeech, null);
        assert.deepEqual(entry.pronunciations, [{ region: null, ipa: '/i/' }]);
        assert.equal(entry.senses.length, 1);
        assert.equal(entry.senses[0].definition, null);
        assert.deepEqual(entry.senses[0].meanings, ['ok', 'spaced']);
        assert.deepEqual(entry.senses[0].examples, [{ text: 'e', translation: null }]);
    });

    test('Cambridge: not-found, unrecognized and malformed shapes are distinct errors', () => {
        assert.equal(code(() => map({ page: 'not-found', match: 'none', entries: [] })), 'not-found');
        assert.equal(code(() => map({ page: 'entry', match: 'none', entries: [] })), 'not-found');
        assert.equal(code(() => map({ page: 'unrecognized', match: 'none', entries: [] })), 'unsupported-response');
        for (const bad of [null, undefined, 'x', 3, [], {}, { page: 'entry' }, { page: 'entry', match: 'exact', entries: 'x' }, { page: 'entry', match: 'maybe', entries: [] }, { page: 'weird' }]) {
            assert.equal(code(() => map(bad)), 'unsupported-response', JSON.stringify(bad));
        }
        assert.equal(code(() => map({ page: 'entry', match: 'exact', entries: [{ headword: 'x', senses: [] }] })), 'unsupported-response');
    });

    test('variant headword match is reported, and compact limits mark the result truncated', () => {
        const variant = map(rawEntry({ match: 'variant' }), 'words');
        assert.equal(variant.headwordMatch, 'variant');
        const sense = (n) => ({ definition: `d${n}`, meanings: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], examples: [{ text: '1' }, { text: '2' }] });
        const big = rawEntry({
            entries: Array.from({ length: 6 }, (_, i) => ({
                headword: 'word',
                senses: Array.from({ length: 8 }, (_, j) => sense(j + i)),
            })),
        });
        const result = map(big);
        assert.equal(result.entries.length, m.MAX_ENTRIES);
        assert.equal(result.entries[0].senses.length, m.MAX_SENSES_PER_ENTRY);
        assert.equal(result.entries[0].senses[0].meanings.length, m.MAX_MEANINGS_PER_SENSE);
        assert.equal(result.entries[0].senses[0].examples.length, m.MAX_EXAMPLES_PER_SENSE);
        assert.equal(result.truncated, true);
    });

    test('legacy (Bing/ECDICT) shape: mapped when known, not-found when empty, unsupported when unknown', () => {
        const bing = m.DICTIONARY_SOURCES.bing_dict.map;
        const ok = bing(
            {
                pronunciations: [{ region: 'US', symbol: '[x]', voice: '' }],
                explanations: [{ trait: 'n.', explains: ['a', { word: 'b', synonyms: ['s'] }, 3, ''] }],
                associations: ['pl.'],
            },
            'word'
        );
        assert.deepEqual(ok.entries[0].senses[0].meanings, ['a', 'b']);
        assert.equal(ok.entries[0].headword, null);
        assert.equal(ok.headwordMatch, 'unknown');
        assert.equal(code(() => bing({ pronunciations: [], explanations: [], associations: [] }, 'x')), 'not-found');
        assert.equal(code(() => bing({ pronunciations: [{ region: 'US', symbol: '[x]' }], explanations: [] }, 'x')), 'unsupported-response');
        for (const bad of [null, '', 'text', 5, {}, { value: [] }, []]) {
            assert.equal(code(() => bing(bad, 'x')), 'unsupported-response', JSON.stringify(bad));
        }
    });
});

describe('source capabilities', () => {
    const cambridge = () => m.DICTIONARY_SOURCES.cambridge_dict;
    test('Cambridge: English to Chinese, word or phrase', () => {
        assert.equal(m.checkSourceSupport(cambridge(), { inputKind: 'word', from: 'en', to: 'zh_cn' }), null);
        assert.equal(m.checkSourceSupport(cambridge(), { inputKind: 'phrase', from: 'en', to: 'zh_tw' }), null);
        assert.equal(m.checkSourceSupport(cambridge(), { inputKind: 'word', from: 'zh_cn', to: 'en' }).code, 'unsupported-language');
        assert.equal(m.checkSourceSupport(cambridge(), { inputKind: 'word', from: null, to: 'zh_cn' }).code, 'unsupported-language');
        assert.equal(m.checkSourceSupport(cambridge(), { inputKind: 'word', from: 'en', to: 'es' }).code, 'unsupported-language');
    });
    test('Bing and ECDICT: single words only until phrase support has real source evidence', () => {
        for (const id of ['bing_dict', 'ecdict']) {
            const source = m.DICTIONARY_SOURCES[id];
            assert.equal(source.verified, false);
            assert.equal(m.checkSourceSupport(source, { inputKind: 'phrase', from: 'en', to: 'zh_cn' }).code, 'unsupported-input');
            assert.equal(m.checkSourceSupport(source, { inputKind: 'word', from: 'en', to: 'zh_cn' }), null);
        }
        assert.equal(m.DICTIONARY_SOURCES.cambridge_dict.verified, true);
    });
    test('only built-in dictionary services are sources', () => {
        assert.equal(m.dictionarySourceFor('cambridge_dict@x').id, 'cambridge_dict');
        assert.equal(m.dictionarySourceFor('plugin.cambridge_dict@x'), null);
        assert.equal(m.dictionarySourceFor('google'), null);
        assert.equal(m.dictionarySourceFor(undefined), null);
        const { candidates } = m.resolveDictionarySources({ translateServiceInstanceList: 'not a list' });
        assert.deepEqual(candidates.map((c) => c.key), ['cambridge_dict']);
    });
});

describe('safe rendering', () => {
    const XSS = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const success = (over = {}) => ({
        status: 'success',
        requestId: 1,
        sourceKey: 'cambridge_dict',
        sourceId: 'cambridge_dict',
        snapshot: { text: 'resilience', query: 'resilience', sourceLanguage: 'auto', targetLanguage: 'zh_cn', from: 'en', to: 'zh_cn', sourceKey: 'cambridge_dict' },
        result: {
            sourceId: 'cambridge_dict',
            query: 'resilience',
            headwordMatch: 'exact',
            truncated: false,
            associations: [],
            entries: [
                {
                    headword: 'resilience',
                    kind: 'word',
                    partOfSpeech: 'noun',
                    pronunciations: [{ region: 'uk', ipa: '/rɪˈzɪl.jəns/' }],
                    senses: [
                        { partOfSpeech: 'noun', definition: 'the ability to recover', meanings: ['复原力', '弹性'], examples: [{ text: 'An example.', translation: '例句。' }] },
                    ],
                },
            ],
            ...over,
        },
    });
    const render = (state, extra = {}) =>
        renderToStaticMarkup(
            createElement(Panel, {
                state,
                sources: [{ key: 'cambridge_dict' }],
                selectSource: () => {},
                dismiss: () => {},
                pronounce: () => {},
                speaking: false,
                speakingPending: false,
                ...extra,
            })
        );

    test('success: source attribution, headword, part of speech, IPA, meanings, definition and example are visible', () => {
        const html = render(success());
        assert.match(html, /data-testid="dictionary-panel"/);
        assert.match(html, /Source: Cambridge Dictionary/);
        for (const text of ['resilience', 'noun', 'UK', '/rɪˈzɪl.jəns/', '复原力；弹性', 'the ability to recover', 'An example.', '例句。']) {
            assert.ok(html.includes(text), text);
        }
        assert.match(html, /Pronounce \(TTS\)/);
        assert.match(html, /title="Spoken by your configured text-to-speech voice, not recorded by the dictionary\."/);
    });

    test('only supplied fields are rendered: no IPA, example, part of speech or definition placeholders', () => {
        const sparse = success();
        sparse.result.entries = [{ headword: null, kind: null, partOfSpeech: null, pronunciations: [], senses: [{ partOfSpeech: null, definition: null, meanings: ['稀疏'], examples: [] }] }];
        const html = render(sparse);
        assert.ok(html.includes('稀疏'));
        assert.doesNotMatch(html, /italic text-primary/);
        const body = html.slice(html.indexOf('data-testid="dictionary-result"')).replace(/^[^>]*>/, '');
        const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        // headword falls back to the query; nothing else (no IPA, region, example, placeholder) appears
        assert.equal(text, 'resilience 稀疏 Source: Cambridge Dictionary');
    });

    test('provider text is escaped, never injected as HTML', () => {
        const hostile = success();
        const e = hostile.result.entries[0];
        e.headword = XSS;
        e.partOfSpeech = XSS;
        e.pronunciations = [{ region: XSS, ipa: XSS }];
        e.senses = [{ partOfSpeech: XSS, definition: XSS, meanings: [XSS], examples: [{ text: XSS, translation: XSS }] }];
        hostile.result.associations = [XSS];
        hostile.snapshot.query = XSS;
        const html = render(hostile);
        assert.doesNotMatch(html, /<img|<script/);
        assert.match(html, /&lt;img src=x onerror=/);
        const failed = { ...hostile, status: 'error', result: undefined, error: { code: 'provider-failed', detail: XSS } };
        assert.doesNotMatch(render(failed), /<img|<script/);
        assert.doesNotMatch(render({ ...failed, error: { code: 'not-found', detail: '' } }), /<img|<script/);
    });

    test('every error code has its own message; only readable-response failures offer Retry; too-long points to Sentence Analysis', () => {
        const messages = new Map();
        for (const code of Object.values(m.DictionaryErrorCode)) {
            const html = render({
                ...success(),
                status: 'error',
                result: undefined,
                error: { code, detail: code === 'provider-failed' ? 'Http Status: 503' : '', suggestSentenceAnalysis: code === 'too-long' },
            });
            const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            messages.set(code, text);
            assert.match(html, new RegExp(`data-code="${code}"`));
            assert.doesNotMatch(text, /dictionary\.messages/, `${code} has a translation`);
            assert.equal(/Retry/.test(html), code === 'provider-failed' || code === 'unsupported-response', code);
        }
        assert.match(messages.get('too-long'), /Sentence Analysis/);
        assert.match(messages.get('provider-failed'), /Cambridge Dictionary lookup failed\./);
        assert.match(messages.get('provider-failed'), /Http Status: 503/);
        assert.match(messages.get('not-found'), /No entry for “resilience” in Cambridge Dictionary\./);
        assert.equal(new Set(messages.values()).size, messages.size, 'messages are distinct');
    });

    test('loading, variant entry, truncation note and source switcher', () => {
        assert.match(render({ ...success(), status: 'loading', result: undefined }), /Looking up “resilience”…/);
        assert.match(render({ ...success(), status: 'loading', result: undefined }), /aria-busy="true"/);
        const variant = success({ headwordMatch: 'variant' });
        variant.result.entries[0].headword = 'go';
        assert.match(render(variant), /No exact entry; showing the entry for “go”\./);
        assert.match(render(success({ truncated: true })), /Showing the first results only\./);
        assert.doesNotMatch(render(success()), /Dictionary source/);
        const html = render(success(), { sources: [{ key: 'cambridge_dict' }, { key: 'bing_dict@b1' }] });
        assert.match(html, /aria-label="Dictionary source"/);
        assert.match(html, /Bing Dictionary/);
        assert.match(html, /aria-pressed="true"[^>]*>[^<]*Cambridge Dictionary/);
    });

    test('speaking state of Pronounce', () => {
        assert.match(render(success(), { speaking: true }), /aria-pressed="true"/);
        assert.equal(render({ status: 'idle' }), '');
    });
});

describe('palette integration (real hook, atoms and components)', () => {
    function setup(over = {}) {
        const store = createStore();
        store.set(p.atoms.windowType, over.windowType ?? '[SELECTION_TRANSLATE]');
        store.set(p.atoms.sourceText, over.text ?? 'resilience');
        store.set(p.atoms.sourceLanguage, 'auto');
        store.set(p.atoms.targetLanguage, 'zh_cn');
        store.set(p.atoms.detectLanguage, 'en');
        return store;
    }
    const html = (store) =>
        renderToStaticMarkup(createElement(Provider, { store }, createElement(Palette, { serviceInstanceConfigMap: {} })));
    const currentState = () => ({
        status: 'success',
        requestId: 1,
        sourceKey: 'cambridge_dict',
        sourceId: 'cambridge_dict',
        snapshot: { text: 'resilience', query: 'resilience', sourceLanguage: 'auto', targetLanguage: 'zh_cn', from: 'en', to: 'zh_cn', sourceKey: 'cambridge_dict' },
        result: {
            sourceId: 'cambridge_dict',
            query: 'resilience',
            headwordMatch: 'exact',
            truncated: false,
            associations: [],
            entries: [{ headword: 'resilience', kind: 'word', partOfSpeech: 'noun', pronunciations: [], senses: [{ partOfSpeech: null, definition: null, meanings: ['复原力'], examples: [] }] }],
        },
    });

    test('a Dictionary button is in the toolbar; no panel until a lookup exists', () => {
        const out = html(setup());
        assert.match(out, /<button[^>]*aria-pressed="false"[^>]*>(?:(?!<\/button>).)*Dictionary/s);
        assert.doesNotMatch(out, /dictionary-panel/);
    });

    test('blank selection disables the Dictionary button; input window renders nothing', () => {
        assert.match(html(setup({ text: '  ' })), /<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Dictionary/s);
        assert.equal(html(setup({ windowType: '[INPUT_TRANSLATE]' })), '');
    });

    test('the published result shows while it matches the live selection and disappears when it does not', () => {
        const store = setup();
        store.set(m.dictionaryStateAtom, currentState());
        const shown = html(store);
        assert.match(shown, /data-testid="dictionary-panel"/);
        assert.match(shown, /复原力/);
        assert.match(shown, /Source: Cambridge Dictionary/);
        store.set(p.atoms.sourceText, 'persistence');
        assert.doesNotMatch(html(store), /dictionary-panel|复原力/, 'stale result for another selection is not shown');
        store.set(p.atoms.sourceText, 'resilience');
        store.set(p.atoms.targetLanguage, 'zh_tw');
        assert.doesNotMatch(html(store), /dictionary-panel/, 'result for another target language is not shown');
    });
});

describe('translations', () => {
    test('English and Simplified Chinese carry the same dictionary keys, and every error code has a message', async () => {
        const { readFile } = await import('node:fs/promises');
        const load = async (name) =>
            JSON.parse(await readFile(new URL(`../../../i18n/locales/${name}.json`, import.meta.url), 'utf8')).translation;
        const [en, zh] = await Promise.all([load('en_US'), load('zh_CN')]);
        const keys = (o) => Object.keys(o).sort();
        assert.deepEqual(keys(en.dictionary), keys(zh.dictionary));
        assert.deepEqual(keys(en.dictionary.messages), keys(zh.dictionary.messages));
        assert.deepEqual(keys(en.dictionary.messages), Object.values(m.DictionaryErrorCode).sort());
        assert.equal(typeof en.selection_actions.dictionary, 'string');
        assert.equal(typeof zh.selection_actions.dictionary, 'string');
    });
});
