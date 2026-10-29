// Run with: node --test src/features/selection-actions/dictionary/cambridge.adapter.test.js
// Executes the production Cambridge adapter and the production dictionary source path in
// headless Edge (a real DOMParser) against Cambridge-structured pages. Only the Tauri HTTP
// boundary is replaced. Skipped, never faked, when no Edge/Chrome is installed.
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { findBrowser, runInBrowser } from './testing/browserRunner.mjs';
import { cambridgeResponder } from './testing/cambridgeFixtures.js';

const MODULE = 'src/features/selection-actions/dictionary/testing/adapterCases.js';
const skip = findBrowser() ? false : 'no Edge/Chrome available for the real-DOM adapter run';

describe('Cambridge adapter + source path (real DOMParser)', { skip }, () => {
    let out;
    let requests;
    before(async () => {
        const queries = [
            { query: 'resilience' },
            { query: 'take off' },
            { query: 'take off', adapterOnly: true },
            { query: 'break the ice' },
            { query: 'the quick' },
            { query: 'went' },
            { query: 'sparse word' },
            { query: 'xqzvbnmkw' },
            { query: 'captcha' },
            { query: 'drift' },
            { query: 'failing', adapterOnly: true },
            { query: 'one two three four five' },
            { query: 'look up', to: 'zh_tw' },
            { query: 'bonjour', from: 'fr' },
            { query: 'resilience', to: 'ja' },
            { query: 'a&b c?d' },
        ];
        const run = await runInBrowser({
            module: MODULE,
            args: { queries },
            respond: cambridgeResponder({ statusFor: { failing: 503 } }),
        });
        out = run.value;
        requests = run.requests;
    });

    test('word: headword, part of speech, IPA by region, meanings, definition and example are all supplied by the page', () => {
        const { result } = out['resilience|en|zh_cn'];
        assert.equal(result.sourceId, 'cambridge_dict');
        assert.equal(result.headwordMatch, 'exact');
        assert.equal(result.entries.length, 1);
        const entry = result.entries[0];
        assert.equal(entry.headword, 'resilience');
        assert.equal(entry.partOfSpeech, 'noun');
        assert.deepEqual(entry.pronunciations, [
            { region: 'uk', ipa: '/rɪˈzɪl.jəns/' },
            { region: 'us', ipa: '/rɪˈzɪl.jəns/' },
        ]);
        assert.deepEqual(entry.senses[0].meanings, ['复原力', '恢复力']);
        assert.match(entry.senses[0].definition, /happy again/);
        assert.deepEqual(entry.senses[0].examples, [
            { text: 'The resilience of the human psyche.', translation: '人类心理的复原力。' },
        ]);
        // The second sense has no example: none is invented.
        assert.deepEqual(entry.senses[1].examples, []);
    });

    test('short phrase: the phrasal-verb entry that equals the query is returned, other phrases are not', () => {
        const { result } = out['take off|en|zh_cn'];
        assert.equal(result.headwordMatch, 'exact');
        const headwords = result.entries.map((e) => e.headword);
        assert.deepEqual(headwords, ['take off', 'take-off'], 'take something off is a different phrase');
        const phrasal = result.entries[0];
        assert.equal(phrasal.kind, 'phrasal-verb');
        assert.equal(phrasal.partOfSpeech, 'phrasal verb');
        assert.deepEqual(phrasal.senses[0].meanings, ['起飞', '飞起']);
        // The IPA printed on a phrasal-verb block is its base verb's: not attributed to the phrase.
        assert.deepEqual(phrasal.pronunciations, []);
        // The hyphenated noun is a real entry for the same words and keeps its own IPA.
        assert.equal(result.entries[1].kind, 'word');
        assert.equal(result.entries[1].pronunciations[0].ipa, '/ˈteɪk.ɒf/');
    });

    test('adapter lookup() returns the structured page; the request is URL-encoded', () => {
        const { raw } = out['take off|en|zh_cn|raw'];
        assert.equal(raw.page, 'entry');
        assert.equal(raw.match, 'exact');
        assert.deepEqual(
            raw.entries.map((e) => [e.kind, e.headword]),
            [
                ['phrasal-verb', 'take off'],
                ['word', 'take-off'],
            ]
        );
        assert.ok(requests.some((r) => r.url.endsWith('datasetsearch=english-chinese-simplified&q=take%20off')));
    });

    test('idiom: matched by its headword', () => {
        const { result } = out['break the ice|en|zh_cn'];
        assert.equal(result.entries.length, 1);
        assert.equal(result.entries[0].kind, 'idiom');
        assert.equal(result.entries[0].senses[0].meanings[0], '打破冷场');
        assert.deepEqual(result.entries[0].senses[0].examples, [
            { text: 'We played a game to break the ice.', translation: null },
        ]);
    });

    test("a phrase Cambridge answered with a different entry is not-found, not that entry's content", () => {
        assert.equal(out['the quick|en|zh_cn'].error.code, 'not-found');
    });

    test('an inflected single word shows the entry Cambridge redirected to, marked as a variant', () => {
        const { result } = out['went|en|zh_cn'];
        assert.equal(result.headwordMatch, 'variant');
        assert.equal(result.entries[0].headword, 'go');
    });

    test('missing fields stay absent: no part of speech, no IPA, no definition, no example', () => {
        const entry = out['sparse word|en|zh_cn'].result.entries[0];
        assert.equal(entry.partOfSpeech, null);
        assert.deepEqual(entry.pronunciations, []);
        assert.equal(entry.senses[0].definition, null);
        assert.deepEqual(entry.senses[0].meanings, ['稀疏']);
        assert.deepEqual(entry.senses[0].examples, []);
    });

    test("Cambridge's no-match page is not-found; an unknown or drifted page is an unsupported response", () => {
        assert.equal(out['xqzvbnmkw|en|zh_cn'].error.code, 'not-found');
        assert.equal(out['captcha|en|zh_cn'].error.code, 'unsupported-response');
        assert.equal(out['drift|en|zh_cn'].error.code, 'unsupported-response');
    });

    test('an HTTP failure is a provider failure carrying the status', () => {
        const error = out['failing|en|zh_cn|raw'].error;
        assert.equal(error.status, 503);
        assert.match(error.message, /503/);
    });

    test('unsupported requests are refused without any request', () => {
        assert.match(out['one two three four five|en|zh_cn'].error.message, /1-4 words/);
        assert.equal(out['bonjour|fr|zh_cn'].error.code, 'unsupported-language');
        assert.equal(out['resilience|en|ja'].error.code, 'unsupported-language');
        const urls = requests.map((r) => decodeURIComponent(r.url));
        assert.ok(!urls.some((u) => /bonjour|one two three|-ja/.test(u)));
    });

    test('traditional Chinese uses its own dataset; special characters are encoded', () => {
        assert.ok(out['look up|en|zh_tw'].result);
        const urls = requests.map((r) => r.url);
        assert.ok(urls.some((u) => u.includes('english-chinese-traditional&q=look%20up')));
        assert.ok(urls.some((u) => u.includes('q=a%26b%20c%3Fd')));
    });

    test('the existing translate() keeps refusing multi-word input without a request', () => {
        assert.equal(out.legacyPhrase.value, '');
        // Every request above came from a lookup(); translate("take off") added none.
        assert.equal(requests.filter((r) => r.url.endsWith('q=take%20off')).length, 2);
    });
});
