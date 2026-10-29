// Opt-in live validation (network, public unauthenticated dictionary endpoints, public sample
// words/phrases only): node src/features/selection-actions/dictionary/testing/liveValidation.mjs <out.json>
// Runs the production Cambridge adapter + production source path (runDictionaryLookup -> mapper)
// in headless Edge against the real site, and probes the other existing sources' endpoints for
// their HTTP status. Not part of the default test run.
import { writeFileSync } from 'node:fs';
import { runInBrowser } from './browserRunner.mjs';

const out = process.argv[2];
const MODULE = 'src/features/selection-actions/dictionary/testing/adapterCases.js';
const queries = [
    { query: 'resilience' },
    { query: 'ubiquitous' },
    { query: 'went' },
    { query: 'take off' },
    { query: 'break the ice' },
    { query: 'look up', to: 'zh_tw' },
    { query: 'the quick' },
    { query: 'xqzvbnmkw' },
];

const run = await runInBrowser({ module: MODULE, args: { queries }, live: true, timeoutMs: 180000 });

const summarize = (entry) => {
    if (entry.error) return { outcome: 'error', code: entry.error.code ?? null, message: entry.error.message };
    const r = entry.result;
    return {
        outcome: 'success',
        sourceId: r.sourceId,
        headwordMatch: r.headwordMatch,
        truncated: r.truncated,
        entries: r.entries.map((e) => ({
            headword: e.headword,
            kind: e.kind,
            partOfSpeech: e.partOfSpeech,
            pronunciations: e.pronunciations,
            senseCount: e.senses.length,
            firstSenseMeanings: e.senses[0].meanings,
            sensesWithDefinition: e.senses.filter((s) => s.definition).length,
            sensesWithExample: e.senses.filter((s) => s.examples.length).length,
        })),
    };
};

const probe = async (name, url, init) => {
    try {
        const response = await fetch(url, init);
        return { source: name, status: response.status };
    } catch (e) {
        return { source: name, error: String(e) };
    }
};

const result = {
    date: new Date().toISOString(),
    method:
        'production cambridge_dict lookup() + production runDictionaryLookup() mapper, executed in headless Edge (real DOMParser) with real HTTP to dictionary.cambridge.org via the shimmed Tauri fetch; public sample words only; no credentials',
    cambridge: Object.fromEntries(
        Object.entries(run.value)
            .filter(([key]) => key !== 'legacyPhrase')
            .map(([key, value]) => [key, summarize(value)])
    ),
    requests: run.requests.map((r) => r.url),
    otherSources: [
        await probe('ecdict POST https://transkit.app/api/dict', 'https://transkit.app/api/dict', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'resilience' }),
        }),
        await probe(
            'bing_dict GET (existing adapter URL)',
            'https://www.bing.com/api/v6/dictionarywords/search?q=resilience&appid=371E7B2AF0F9B84EC491D731DF90A55719C7D209&mkt=zh-cn&pname=bingdict'
        ),
    ],
};
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
