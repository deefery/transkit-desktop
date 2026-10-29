// Runs in the browser (real DOMParser): the production Cambridge adapter AND the production
// source path (runDictionaryLookup -> adapter -> mapper) for word / phrase queries.
import * as cambridge from '/src/services/translate/cambridge_dict/index.jsx';
import { DICTIONARY_SOURCES, runDictionaryLookup } from '/src/features/selection-actions/dictionary/sources.js';

const services = { cambridge_dict: cambridge };

export async function run({ queries }) {
    const out = {};
    for (const { query, from = 'en', to = 'zh_cn', adapterOnly = false } of queries) {
        const entry = {};
        try {
            if (adapterOnly) {
                entry.raw = await cambridge.lookup(query, cambridge.Language[from], cambridge.Language[to]);
            } else {
                entry.result = await runDictionaryLookup({
                    source: DICTIONARY_SOURCES.cambridge_dict,
                    services,
                    query,
                    from,
                    to,
                    config: {},
                });
            }
        } catch (e) {
            entry.error = { name: e && e.name, code: e && e.code, message: String(e && e.message), status: e && e.status };
        }
        out[`${query}|${from}|${to}${adapterOnly ? '|raw' : ''}`] = entry;
    }
    // The pre-existing translate() path must be unchanged: it still refuses multi-word input
    // without any request.
    out.legacyPhrase = { value: await cambridge.translate('take off', cambridge.Language.en, cambridge.Language.zh_cn) };
    return out;
}
