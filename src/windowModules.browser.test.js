// Run with: node --test src/windowModules.browser.test.js
// P1: every window loads only its own code. Guards that App.jsx keeps each window behind a lazy
// import, and checks in a headless browser that every window module loads and exports a component.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { findBrowser, runInBrowser } from './features/selection-actions/dictionary/testing/browserRunner.mjs';

const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const windowDirs = readdirSync(new URL('./window/', import.meta.url)).filter((name) =>
    existsSync(new URL(`./window/${name}/index.jsx`, import.meta.url))
);

describe('App.jsx window loading', () => {
    test('no window module is imported statically', () => {
        assert.doesNotMatch(app, /^import\s+\w+\s+from\s+'\.\/window\//m);
    });

    test('every window directory is reachable through a lazy import, rendered inside Suspense', () => {
        for (const dir of windowDirs) {
            assert.match(app, new RegExp(`lazy\\(\\(\\) => import\\('\\./window/${dir}'\\)\\)`), dir);
        }
        assert.match(app, /<Suspense fallback=\{null\}>/);
    });
});

const skip = findBrowser() ? false : 'no Edge/Chrome available for the rendered check';

describe('window modules load (headless browser)', { skip }, () => {
    let out;
    before(async () => {
        const run = await runInBrowser({
            module: 'src/testing/windowModulesCase.js',
            args: { windows: windowDirs },
            stubTauri: true,
            timeoutMs: 180000,
        });
        out = run.value;
    });

    test('each window module loads and exports a component', () => {
        assert.deepEqual(
            Object.keys(out).sort(),
            [...windowDirs].sort(),
            'every window was tried'
        );
        for (const [name, result] of Object.entries(out)) {
            assert.equal(result, 'function', `${name}: ${result}`);
        }
    });
});
