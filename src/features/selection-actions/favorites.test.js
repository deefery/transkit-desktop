// Run with: node --test src/features/selection-actions/favorites.test.js
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createProductionLoader } from './testing/loadProduction.mjs';

let loader;
let f;
let languageList;

before(async () => {
    loader = await createProductionLoader();
    f = await loader.load('/src/features/selection-actions/favorites.js');
    ({ languageList } = await loader.load('/src/utils/language.ts'));
});
after(() => loader.close());

describe('normalizeFavoriteLanguages', () => {
    test('defaults are zh_cn/en/ja/es and every default exists in the full language list', () => {
        assert.deepEqual(f.DEFAULT_FAVORITE_LANGUAGES, ['zh_cn', 'en', 'ja', 'es']);
        assert.ok(f.DEFAULT_FAVORITE_LANGUAGES.every((x) => languageList.includes(x)));
        assert.deepEqual(f.normalizeFavoriteLanguages(undefined), ['zh_cn', 'en', 'ja', 'es']);
    });

    test('missing / non-array / unusable persisted values fall back to the defaults', () => {
        for (const bad of [
            undefined,
            null,
            '',
            'ja',
            7,
            {},
            true,
            [],
            [null],
            [1, 2],
            ['xx'],
            ['auto'],
            [undefined, {}],
        ]) {
            assert.deepEqual(f.normalizeFavoriteLanguages(bad), f.DEFAULT_FAVORITE_LANGUAGES, JSON.stringify(bad));
        }
    });

    test('valid entries keep their order; unknown, non-string and duplicate entries are dropped', () => {
        assert.deepEqual(f.normalizeFavoriteLanguages(['fr', 'xx', 3, 'fr', null, 'de', 'auto']), ['fr', 'de']);
    });

    test('result is capped and the input is never mutated', () => {
        const input = [...languageList];
        const snapshot = [...input];
        const out = f.normalizeFavoriteLanguages(input);
        assert.equal(out.length, f.MAX_FAVORITE_LANGUAGES);
        assert.deepEqual(input, snapshot);
        assert.notEqual(out, input);
    });

    test('normalizing never returns the shared default array itself', () => {
        const a = f.normalizeFavoriteLanguages(null);
        a.push('fr');
        assert.deepEqual(f.normalizeFavoriteLanguages(null), ['zh_cn', 'en', 'ja', 'es']);
    });
});

describe('editing helpers (add / remove / reorder)', () => {
    const base = ['zh_cn', 'en', 'ja', 'es'];

    test('add appends valid, new languages only, up to the cap', () => {
        assert.deepEqual(f.addFavoriteLanguage(base, 'fr'), [...base, 'fr']);
        assert.deepEqual(f.addFavoriteLanguage(base, 'en'), base);
        assert.deepEqual(f.addFavoriteLanguage(base, 'auto'), base);
        assert.deepEqual(f.addFavoriteLanguage(base, 42), base);
        let list = base;
        for (const lang of languageList) list = f.addFavoriteLanguage(list, lang);
        assert.equal(list.length, f.MAX_FAVORITE_LANGUAGES);
    });

    test('remove deletes one language but never empties the list', () => {
        assert.deepEqual(f.removeFavoriteLanguage(base, 'ja'), ['zh_cn', 'en', 'es']);
        assert.deepEqual(f.removeFavoriteLanguage(base, 'fr'), base);
        assert.deepEqual(f.removeFavoriteLanguage(['ja'], 'ja'), ['ja']);
    });

    test('move reorders by one step and ignores out-of-range / invalid moves', () => {
        assert.deepEqual(f.moveFavoriteLanguage(base, 'ja', -1), ['zh_cn', 'ja', 'en', 'es']);
        assert.deepEqual(f.moveFavoriteLanguage(base, 'en', 1), ['zh_cn', 'ja', 'en', 'es']);
        assert.deepEqual(f.moveFavoriteLanguage(base, 'zh_cn', -1), base);
        assert.deepEqual(f.moveFavoriteLanguage(base, 'es', 1), base);
        assert.deepEqual(f.moveFavoriteLanguage(base, 'fr', 1), base);
        assert.deepEqual(f.moveFavoriteLanguage(base, 'en', 0.5), base);
    });

    test('editing malformed persisted values starts from the normalized list, not from garbage', () => {
        assert.deepEqual(f.addFavoriteLanguage('garbage', 'fr'), [...f.DEFAULT_FAVORITE_LANGUAGES, 'fr']);
        assert.deepEqual(f.removeFavoriteLanguage([null, 'ja', 'ja', 'en'], 'ja'), ['en']);
    });

    test('candidates for "add" are the remaining languages of the full list', () => {
        const rest = f.availableFavoriteCandidates(base);
        assert.equal(rest.length, languageList.length - base.length);
        assert.ok(rest.every((x) => !base.includes(x)));
    });

    test('the persisted value is a plain array under one config key (existing useConfig store)', () => {
        assert.equal(f.FAVORITE_LANGUAGES_CONFIG_KEY, 'selection_action_favorite_languages');
        const stored = f.moveFavoriteLanguage(f.DEFAULT_FAVORITE_LANGUAGES, 'es', -3);
        assert.equal(JSON.stringify(stored), '["es","zh_cn","en","ja"]');
    });
});
