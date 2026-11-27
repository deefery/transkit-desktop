// Run with: node --test src/nativeRequests.test.js
// Guards roadmap S1.3: provider requests go through the native side (Tauri http or streamFetch),
// not the WebView's own fetch, so they keep working once the WebView enforces CORS.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (path) => readFileSync(join(root, path), 'utf8');
const translateDir = join(root, 'src/services/translate');
const translateFiles = readdirSync(translateDir).flatMap((name) =>
    ['index.jsx', 'Config.jsx'].map((file) => `src/services/translate/${name}/${file}`).filter((path) => {
        try {
            read(path);
            return true;
        } catch {
            return false;
        }
    })
);
const importsTauriFetch = (text) => /import\s*\{[^}]*\bfetch\b[^}]*\}\s*from\s*['"]@tauri-apps\/api\/http['"]/.test(text);
const callsFetch = (text) => /(^|[^.\w])fetch\(/m.test(text);

describe('provider requests use the native side', () => {
    test('no translate provider uses the WebView fetch', () => {
        const offenders = translateFiles.filter((path) => {
            const text = read(path);
            return /window\.fetch\(/.test(text) || (callsFetch(text) && !importsTauriFetch(text));
        });
        // The local sidecar listens on loopback and allows any origin; it is not affected.
        assert.deepEqual(offenders.filter((path) => !path.includes('/local_sidecar/')), []);
    });

    test('every Ollama client is given streamFetch', () => {
        for (const path of translateFiles.filter((p) => p.includes('/ollama/'))) {
            const text = read(path);
            const clients = text.match(/new Ollama\(\{[^}]*\}\)/g) ?? [];
            assert.ok(clients.length > 0 || !/new Ollama\(/.test(text), path);
            for (const client of clients) assert.match(client, /fetch: streamFetch/, path);
        }
    });

    test('async transcription requests go through Tauri http', () => {
        const text = read('src/services/transcription/async_factory.js');
        assert.ok(!callsFetch(text), 'async_factory.js calls the WebView fetch');
        assert.ok(!/window\.fetch\(/.test(text));
    });
});
