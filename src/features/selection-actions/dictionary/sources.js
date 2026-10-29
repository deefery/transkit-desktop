import { getServiceName, getServiceSouceType, ServiceSourceType } from '../../../utils/service_instance';
import { InputKind } from './input';
import { DictionaryError, DictionaryErrorCode, mapCambridgeResult, mapLegacyDictionaryResult } from './result';

// Dictionary-capable services among the existing translate services. The source IS the
// configured service instance: no second provider stack or config store. Each source declares
// what it can answer; unsupported requests are refused here, before any network call.
//
//   call:   'lookup'    - structured lookup exported by the adapter (Cambridge)
//           'translate' - the adapter's translate(), whose result is a dictionary-shaped object
//   from/to: selection-action language codes the source can serve
//   inputs: InputKind values the source is known to handle
//   verified: a word AND phrase lookup was demonstrated against the real source
//             (.ai/handoffs/T-SA-002-result.md); false = never exercised against the live service.
const ENGLISH_CHINESE = ['en', 'zh_cn', 'zh_tw'];

export const DICTIONARY_SOURCES = Object.freeze({
    cambridge_dict: {
        id: 'cambridge_dict',
        call: 'lookup',
        from: ['en'],
        to: ['zh_cn', 'zh_tw'],
        inputs: [InputKind.WORD, InputKind.PHRASE],
        verified: true,
        map: mapCambridgeResult,
    },
    bing_dict: {
        id: 'bing_dict',
        call: 'translate',
        from: ENGLISH_CHINESE,
        to: ENGLISH_CHINESE,
        // Phrase support is not established for Bing/ECDICT: its endpoint answered 403 / 405
        // from the validation environment, so only single words are attempted.
        inputs: [InputKind.WORD],
        verified: false,
        map: mapLegacyDictionaryResult('bing_dict'),
    },
    ecdict: {
        id: 'ecdict',
        call: 'translate',
        from: ENGLISH_CHINESE,
        to: ENGLISH_CHINESE,
        inputs: [InputKind.WORD],
        verified: false,
        map: mapLegacyDictionaryResult('ecdict'),
    },
});

// Keyless built-in used when no dictionary service instance is configured.
export const DEFAULT_DICTIONARY_SOURCE_ID = 'cambridge_dict';
export const DICTIONARY_SOURCE_CONFIG_KEY = 'selection_dictionary_source';

export const dictionarySourceFor = (instanceKey) => {
    if (typeof instanceKey !== 'string' || instanceKey === '') return null;
    if (getServiceSouceType(instanceKey) !== ServiceSourceType.BUILDIN) return null;
    return DICTIONARY_SOURCES[getServiceName(instanceKey)] ?? null;
};

/**
 * Candidate sources: the dictionary service instances already configured for Translate (in the
 * user's order), plus the keyless Cambridge built-in when none of that kind is configured.
 * `preference` (config selection_dictionary_source, or an explicit request) picks one; anything
 * invalid or no longer configured falls back to the first candidate.
 */
export function resolveDictionarySources({ translateServiceInstanceList, preference } = {}) {
    const configured = (Array.isArray(translateServiceInstanceList) ? translateServiceInstanceList : []).filter(
        (key) => dictionarySourceFor(key)
    );
    const keys = [...new Set(configured)];
    if (!keys.some((key) => getServiceName(key) === DEFAULT_DICTIONARY_SOURCE_ID)) {
        keys.push(DEFAULT_DICTIONARY_SOURCE_ID);
    }
    const candidates = keys.map((key) => ({
        key,
        id: getServiceName(key),
        configured: configured.includes(key),
    }));
    const selected = candidates.find((candidate) => candidate.key === preference) ?? candidates[0];
    return { candidates, selected };
}

/**
 * Can `source` answer this request? Returns null when yes, else the DictionaryError to show.
 * `from`/`to` are selection-action language codes; `from` may be null while still unknown.
 */
export function checkSourceSupport(source, { inputKind, from, to }) {
    if (!source.inputs.includes(inputKind)) {
        return new DictionaryError(DictionaryErrorCode.UNSUPPORTED_INPUT, inputKind);
    }
    if (!from || !source.from.includes(from) || !to || !source.to.includes(to) || from === to) {
        return new DictionaryError(DictionaryErrorCode.UNSUPPORTED_LANGUAGE, `${from ?? '?'} -> ${to ?? '?'}`);
    }
    return null;
}

const NOT_FOUND_TEXT = /not yet included|not found|no (such )?(word|entry)/i;

const detailOf = (error) => {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
};

/**
 * Run one lookup through the existing adapter of `source` and map it to a DictionaryResult.
 * Every failure is a DictionaryError: unsupported language (service enum), not found,
 * unrecognised response, or provider/network failure.
 */
export async function runDictionaryLookup({ source, services, query, from, to, config }) {
    const module = services?.[source.id];
    const kind = source.call;
    if (!module || typeof module[kind] !== 'function' || !module.Language) {
        throw new DictionaryError(DictionaryErrorCode.NO_SOURCE, source.id);
    }
    const fromValue = module.Language[from];
    const toValue = module.Language[to];
    if (fromValue === undefined || toValue === undefined) {
        throw new DictionaryError(DictionaryErrorCode.UNSUPPORTED_LANGUAGE, `${from} -> ${to}`);
    }
    let raw;
    try {
        raw = await module[kind](query, fromValue, toValue, { config, detect: from });
    } catch (error) {
        if (error instanceof DictionaryError) throw error;
        const detail = detailOf(error);
        if (NOT_FOUND_TEXT.test(detail)) throw new DictionaryError(DictionaryErrorCode.NOT_FOUND, detail);
        throw new DictionaryError(DictionaryErrorCode.PROVIDER_FAILED, detail);
    }
    return source.map(raw, query);
}
