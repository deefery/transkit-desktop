// Run with: node --test src/tauriPermissions.test.js
// Guards the Tauri allowlist (roadmap S1): web pages get only the API surface the app uses.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const allowlist = config.tauri.allowlist;
const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
const tauriFeatures = JSON.parse(cargo.match(/^tauri = \{[^}]*features = (\[[^\]]*\])/m)[1]);

function sourceFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === 'testing' ? [] : sourceFiles(path);
        return /\.(jsx?|tsx?)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
}

describe('Tauri allowlist', () => {
    test('no API group is fully enabled except the harmless ones', () => {
        const harmless = new Set(['path', 'os', 'notification', 'globalShortcut']);
        assert.equal(allowlist.all, false);
        for (const [group, value] of Object.entries(allowlist)) {
            if (typeof value === 'object' && value.all) assert.ok(harmless.has(group), `${group} has "all": true`);
        }
        for (const feature of tauriFeatures) {
            if (!feature.endsWith('-all')) continue;
            const group = feature.replace(/-all$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            assert.ok(harmless.has(group), `Cargo feature ${feature}`);
        }
    });

    test('shell can only open web and mail links', () => {
        assert.deepEqual(Object.keys(allowlist.shell), ['open']);
        const open = new RegExp(allowlist.shell.open);
        for (const ok of ['https://transkit.app/docs', 'http://localhost:1234/x?y=1', 'mailto:someone@example.com'])
            assert.ok(open.test(ok), ok);
        for (const bad of [
            'C:\\Windows\\System32',
            '\\\\server\\share\\file',
            'file:///C:/Windows',
            'calc.exe',
            'ms-settings:',
            'https://example.com/a b',
            ' https://example.com',
        ])
            assert.ok(!open.test(bad), bad);
    });

    test('clipboard is write-only, windows cannot be created', () => {
        assert.deepEqual(allowlist.clipboard, { writeText: true });
        assert.equal(allowlist.window.create, undefined);
        assert.ok(!tauriFeatures.includes('window-create'));
    });

    test('file and asset access stay inside the app folders and Documents/TransKit', () => {
        const allowed = /^\$(APPCONFIG\/plugins|APPCACHE|DOCUMENT\/TransKit)(\/\*\*)?$/;
        for (const scope of [...allowlist.fs.scope, ...allowlist.protocol.assetScope]) assert.match(scope, allowed);
        for (const op of ['removeFile', 'renameFile', 'copyFile']) assert.equal(allowlist.fs[op], undefined, op);
    });

    test('no window turns off WebView web security', () => {
        // Every WebView sharing a profile must use the same browser arguments, so this is all or none.
        for (const window of config.tauri.windows) assert.equal(window.additionalBrowserArgs, undefined, window.label);
        const rustDir = join(root, 'src-tauri/src');
        const rustFiles = (function walk(dir) {
            return readdirSync(dir).flatMap((name) => {
                const path = join(dir, name);
                return statSync(path).isDirectory() ? walk(path) : name.endsWith('.rs') ? [path] : [];
            });
        })(rustDir);
        for (const file of rustFiles) {
            const text = readFileSync(file, 'utf8');
            assert.ok(!/disable-web-security|additional_browser_args/.test(text), file);
        }
    });

    test('the front end opens local folders and files through the native commands', () => {
        // Local paths would be rejected by the shell regex; they go through open_app_folder / open_saved_file.
        const offenders = [];
        for (const file of sourceFiles(join(root, 'src'))) {
            const text = readFileSync(file, 'utf8');
            if (!/@tauri-apps\/api\/shell/.test(text)) continue;
            if (/\b(appLogDir|appConfigDir|appCacheDir|documentDir)\b/.test(text) && /\bopen(Path|Shell|Url)?\(\s*(dir|path|docsDir)/.test(text))
                offenders.push(file);
        }
        assert.deepEqual(offenders, []);
    });
});
