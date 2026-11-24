// Run with: node --test src/utils/config_defaults.test.js
// Canonical first-run defaults: whichever window reads a key first, a new user gets the same value;
// existing settings are never overwritten; and a source scan fails when a key read by several
// components gets conflicting literal defaults without a canonical entry.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { Store } from '../features/selection-actions/testing/tauriStub.js';
import {
    CONFIG_DEFAULTS,
    SERVICE_LIST_DEFAULTS,
    hasConfigDefault,
    resolveConfigDefault,
    seedConfigDefaults,
} from './config_defaults.js';

const srcDir = fileURLToPath(new URL('../', import.meta.url));

describe('canonical defaults (roadmap D0 decisions)', () => {
    test('languages and history', () => {
        assert.equal(CONFIG_DEFAULTS.translate_source_language, 'auto');
        assert.equal(CONFIG_DEFAULTS.translate_target_language, 'zh_cn');
        assert.equal(CONFIG_DEFAULTS.translate_second_language, 'en');
        assert.equal(CONFIG_DEFAULTS.history_disable, false);
    });

    test('Bing is the primary translator with Google as backup; Edge TTS leads', () => {
        assert.deepEqual(CONFIG_DEFAULTS.translate_service_list.slice(0, 2), ['bing', 'google']);
        assert.equal(CONFIG_DEFAULTS.tts_service_list[0], 'edge_tts');
        assert.equal(CONFIG_DEFAULTS.tts_active_service, 'edge_tts');
    });

    test('every service list default is part of CONFIG_DEFAULTS', () => {
        for (const [key, value] of Object.entries(SERVICE_LIST_DEFAULTS)) {
            assert.deepEqual(CONFIG_DEFAULTS[key], value);
        }
    });
});

describe('resolveConfigDefault', () => {
    test('the caller default no longer decides a listed key', () => {
        // The two call sites that used to disagree, in either order.
        assert.equal(resolveConfigDefault('translate_target_language', 'vi'), 'zh_cn');
        assert.equal(resolveConfigDefault('translate_target_language', 'zh_cn'), 'zh_cn');
        assert.equal(resolveConfigDefault('translate_source_language', 'en'), 'auto');
        assert.equal(resolveConfigDefault('history_disable', true), false);
        assert.equal(resolveConfigDefault('transcription_active_service', 'transkit_cloud_stt'), '');
    });

    test('unlisted keys keep the caller default', () => {
        assert.equal(hasConfigDefault('app_font_size'), false);
        assert.equal(resolveConfigDefault('app_font_size', 16), 16);
    });

    test('returns a copy, so callers cannot mutate the canonical lists', () => {
        const list = resolveConfigDefault('translate_service_list', []);
        list.push('mutated');
        assert.ok(!CONFIG_DEFAULTS.translate_service_list.includes('mutated'));
    });
});

describe('seedConfigDefaults', () => {
    test('a fresh store gets every canonical default', async () => {
        const store = new Store();
        assert.equal(await seedConfigDefaults(store), true);
        for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
            assert.deepEqual(await store.get(key), value, key);
        }
    });

    test('existing values are never changed, including falsy ones', async () => {
        const store = new Store();
        await store.set('translate_target_language', 'vi');
        await store.set('history_disable', true);
        await store.set('translate_service_list', []);
        await store.set('transcription_active_service', 'deepgram_stt');
        await seedConfigDefaults(store);
        assert.equal(await store.get('translate_target_language'), 'vi');
        assert.equal(await store.get('history_disable'), true);
        assert.deepEqual(await store.get('translate_service_list'), []);
        assert.equal(await store.get('transcription_active_service'), 'deepgram_stt');
    });

    test('reports no change when nothing is missing', async () => {
        const store = new Store();
        await seedConfigDefaults(store);
        assert.equal(await seedConfigDefaults(store), false);
    });
});

describe('source guard', () => {
    // Keys whose differing literals are known to be the same value.
    const EQUIVALENT = new Set(['voice_anywhere_idle_button_color']); // '#3f3f46' and DEFAULT_IDLE_BUTTON_COLOR

    const files = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (/\.(jsx?|tsx?)$/.test(entry) && !/\.test\.js$/.test(entry)) files.push(path);
        }
    };
    walk(srcDir);

    test('no key is read with conflicting literal defaults unless it has a canonical default', () => {
        const defaults = new Map();
        const call = /useConfig\(\s*'([A-Za-z0-9_]+)'\s*,\s*([^,)]+)/g;
        for (const file of files) {
            for (const [, key, literal] of readFileSync(file, 'utf8').matchAll(call)) {
                const set = defaults.get(key) ?? new Set();
                set.add(literal.trim().replace(/\s+/g, ' '));
                defaults.set(key, set);
            }
        }
        assert.ok(defaults.size > 50, `scan found only ${defaults.size} keys; is the pattern still right?`);
        const unresolved = [...defaults]
            .filter(([key, literals]) => literals.size > 1 && !hasConfigDefault(key) && !EQUIVALENT.has(key))
            .map(([key, literals]) => `${key}: ${[...literals].join(' | ')}`);
        assert.deepEqual(unresolved, []);
    });
});
