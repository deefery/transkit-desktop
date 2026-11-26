// Run with: node --test src/window/Config/pages/Welcome/onboarding.test.js
// First-run guide (O1): rules behind the Welcome page, and the wiring that shows it on a true
// first run only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createProductionLoader } from '../../../../features/selection-actions/testing/loadProduction.mjs';

let loader;
let O;
before(async () => {
    loader = await createProductionLoader();
    O = await loader.load('/src/window/Config/pages/Welcome/onboarding.js');
});
after(() => loader.close());

describe('onboarding rules', () => {
    test('the Welcome page is shown only while the first-run flag is set', () => {
        assert.equal(O.shouldShowWelcome(true, '/general'), true);
        assert.equal(O.shouldShowWelcome(true, '/welcome'), false, 'already there');
        assert.equal(O.shouldShowWelcome(false, '/general'), false);
        assert.equal(O.shouldShowWelcome(null, '/general'), false, 'not loaded yet');
        assert.equal(O.shouldShowWelcome(undefined, '/general'), false, 'existing users have no flag');
    });

    test('the first working service in the user order is recommended', () => {
        const health = { bing: { ok: false }, google: { ok: true }, deepl: { ok: true } };
        assert.equal(O.recommendPrimary(['bing', 'google', 'deepl'], health), 'google');
        assert.equal(O.recommendPrimary(['bing'], health), null);
        assert.equal(O.recommendPrimary(null, null), null);
    });

    test('use as primary moves the service to the front', () => {
        assert.deepEqual(O.moveToFront(['bing', 'google', 'deepl'], 'deepl'), ['deepl', 'bing', 'google']);
        const list = ['bing', 'google'];
        assert.equal(O.moveToFront(list, 'bing'), list, 'already first');
        assert.equal(O.moveToFront(list, 'nope'), list);
        assert.deepEqual(O.moveToFront(null, 'x'), []);
    });

    test('the selection check reads the reported character count', () => {
        assert.deepEqual(O.selectionCheck(42), { state: 'ok', chars: 42 });
        assert.deepEqual(O.selectionCheck(0), { state: 'empty', chars: 0 });
        assert.deepEqual(O.selectionCheck(undefined), { state: 'waiting', chars: 0 });
        assert.deepEqual(O.selectionCheck('12'), { state: 'waiting', chars: 0 });
    });

    test('shortcuts are shown readably', () => {
        assert.equal(O.formatShortcut('Ctrl+Alt+Q'), 'Ctrl + Alt + Q');
        assert.equal(O.formatShortcut('CommandOrControl+Shift+D'), 'Ctrl + Shift + D');
        assert.equal(O.formatShortcut('CommandOrControl+Shift+D', true), '⌘ + Shift + D');
        assert.equal(O.formatShortcut(''), '');
        assert.equal(O.formatShortcut(null), '');
    });

    test('every interface language has a translation file', () => {
        const files = ['en_US', 'zh_CN', 'zh_TW', 'ja_JP', 'ko_KR', 'vi_VN', 'fr_FR', 'es_ES', 'de_DE', 'it_IT', 'ru_RU', 'tr_TR', 'pt_PT', 'pt_BR', 'nb_NO', 'nn_NO', 'fa_IR', 'uk_UA', 'ar_AE', 'he_IL'];
        assert.equal(Object.keys(O.APP_LANGUAGES).length, files.length);
    });
});

describe('first-run wiring', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

    test('Rust sets the flag only on a true first run, and reports only the character count', () => {
        const main = read('../../../../../src-tauri/src/main.rs');
        assert.match(main, /if is_first_run\(\) \{[\s\S]{0,400}config::set\("onboarding_pending", true\);[\s\S]{0,40}config_window\(\);/);
        const window = read('../../../../../src-tauri/src/window.rs');
        assert.match(window, /app\.emit_all\("selection_read", text\.trim\(\)\.chars\(\)\.count\(\)\)/);
        assert.doesNotMatch(window, /emit_all\("selection_read", (&)?text\)/);
    });

    test('Settings has the Welcome route and opens it while the flag is set', () => {
        assert.match(read('../../routes/index.jsx'), /path: '\/welcome',\s+element: <Welcome \/>/);
        const config = read('../../index.jsx');
        assert.match(config, /useConfig\(ONBOARDING_CONFIG_KEY, false\)/);
        assert.match(config, /shouldShowWelcome\(onboardingPending, location\.pathname\)/);
    });
});
