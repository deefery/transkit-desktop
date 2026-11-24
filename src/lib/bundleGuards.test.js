// Run with: node --test src/lib/bundleGuards.test.js
// P1 guards: code that the Translate window does not need stays out of its bundle.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

describe('bundle guards', () => {
    test('the Supabase client is created behind a condition the bundler can fold (cloud-off builds drop it)', () => {
        const cloud = read('./transkit-cloud.ts');
        assert.match(
            cloud,
            /const BUILD_HAS_CLOUD = import\.meta\.env\.VITE_DISABLE_CLOUD !== 'true' && !!_url && !!_key/
        );
        assert.match(cloud, /export const supabase: SupabaseClient \| null = BUILD_HAS_CLOUD\n\s+\? createClient\(/);
        // Same condition as the shared flag, so both always agree.
        assert.match(
            read('./cloud_flag.js'),
            /env\.VITE_DISABLE_CLOUD !== 'true' && !!env\.VITE_SUPABASE_URL && !!env\.VITE_SUPABASE_ANON_KEY/
        );
    });

    test('the Translate window loads the OCR services only for image translation', () => {
        const source = read('../window/Translate/components/SourceArea/index.jsx');
        assert.doesNotMatch(source, /^import .*services\/recognize/m);
        assert.match(source, /await import\('\.\.\/\.\.\/\.\.\/\.\.\/services\/recognize'\)/);
    });
});
