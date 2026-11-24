// Run with: node --test src/features/selection-actions/palette.render.test.js
// Server-side render of the real palette (real hook + real atoms + real NextUI components).
// This checks markup, state mapping, accessibility attributes and safe text rendering; pointer /
// focus behaviour in a real webview is covered by the browser harness and native checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createStore, Provider } from 'jotai';
import { after, before, describe, test } from 'node:test';
import { loadProduction } from './testing/harness.js';

let p;
let Palette;
let View;
let i18n;

before(async () => {
    p = await loadProduction();
    const mod = await p.loader.load('/src/features/selection-actions/SelectionActionPalette.jsx');
    Palette = mod.default;
    View = mod.SelectionActionPaletteView;
    i18n = (await p.loader.load('/src/i18n/index.jsx')).default;
    await i18n.changeLanguage('en');
});
after(() => p.loader.close());

function render(store) {
    return renderToStaticMarkup(
        createElement(Provider, { store }, createElement(Palette, { serviceInstanceConfigMap: {}, defaultMoreOpen: true }))
    );
}

function selectionStore({ text = 'Hello world', target = 'ja', windowType = '[SELECTION_TRANSLATE]' } = {}) {
    const store = createStore();
    store.set(p.atoms.windowType, windowType);
    store.set(p.atoms.sourceText, text);
    store.set(p.atoms.sourceLanguage, 'auto');
    store.set(p.atoms.targetLanguage, target);
    store.set(p.atoms.detectLanguage, 'en');
    return store;
}

const button = (html, label) => {
    const re = new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's');
    return html.match(re)?.[0] ?? '';
};

describe('palette markup from the live context', () => {
    test('selection window: one action row (speak original, dictionary, AI slot, more); the rest is under More', () => {
        const html = render(selectionStore({ target: 'ja' }));
        const row = html.match(/<div role="toolbar" aria-label="Selection actions"[^>]*data-testid="selection-primary-actions">(.*?)<\/div><div id="selection-more"/s)?.[1] ?? '';
        assert.ok(row, 'action row');
        const labels = [...row.matchAll(/<button[^>]*>(?:<svg.*?<\/svg>)?(.*?)<\/button>/gs)].map((m) => m[1].replace(/<[^>]+>/g, ''));
        assert.deepEqual(labels.slice(0, 2), ['Speak original', 'Dictionary']);
        assert.equal(labels.at(-1), 'More');
        assert.equal(labels.length, 4, `action row buttons: ${labels.join(', ')}`);
        // Speak translation (also in the title bar) and the favorites editor moved under More.
        assert.doesNotMatch(row, /Speak translation|Edit favorite languages/);
        const more = html.match(/data-testid="selection-more">(.*)$/s)?.[1] ?? '';
        assert.ok(button(more, 'Speak translation'));
        assert.ok(button(more, 'Edit favorite languages'));
        // Favorite languages are no longer chips in the palette (they head the target language list).
        for (const name of ['Simplified Chinese', 'Japanese', 'Spanish']) {
            assert.equal(button(html, name), '', `${name} chip`);
        }
        assert.doesNotMatch(button(html, 'Speak original'), /disabled/);
    });

    test('More is collapsed by default', () => {
        const html = renderToStaticMarkup(
            createElement(Provider, { store: selectionStore() }, createElement(Palette, { serviceInstanceConfigMap: {} }))
        );
        assert.match(html, /data-testid="selection-more-toggle"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*data-testid="selection-more-toggle"/);
        assert.doesNotMatch(html, /data-testid="selection-more"/);
    });

    test('Speak translation is disabled (with a reason) until a current translation exists', () => {
        const html = render(selectionStore());
        const speakTranslation = button(html, 'Speak translation');
        assert.match(speakTranslation, /disabled/);
        assert.match(speakTranslation, /title="No translation yet\."/);
    });

    test('blank selection disables every action', () => {
        const html = render(selectionStore({ text: '   ' }));
        for (const label of ['Speak original', 'Dictionary', 'Speak translation']) {
            assert.match(button(html, label), /disabled/, label);
        }
    });

    test('the Translate window places the selection palette after the translation result', () => {
        const source = readFileSync(new URL('../../window/Translate/index.jsx', import.meta.url), 'utf8');
        const results = source.indexOf('Translation Results Section');
        const palette = source.indexOf('<SelectionActionPalette');
        assert.ok(results > 0 && palette > 0, 'markers present');
        assert.ok(palette > results, 'palette is rendered below the results section');
        assert.equal(source.split('<SelectionActionPalette').length - 1, 1, 'rendered once');
    });

    test('input and image windows render no palette at all', () => {
        for (const windowType of ['[INPUT_TRANSLATE]', '[IMAGE_TRANSLATE]']) {
            assert.equal(render(selectionStore({ windowType })), '', windowType);
        }
    });

    test('selection text is never rendered by the palette (no injection surface from the selection)', () => {
        const html = render(selectionStore({ text: '<script>alert(1)</script><img src=x onerror=alert(1)>' }));
        assert.doesNotMatch(html, /<script|onerror|alert\(1\)/);
    });
});

describe('view states (loading / error / speaking) and safe text', () => {
    const baseCtx = (translation = {}) => ({
        translation: { status: 'none', error: '', ...translation },
    });
    const items = [
        {
            key: 'translate:ja',
            actionId: 'translate',
            group: 'translate',
            params: { language: 'ja' },
            enabled: true,
            active: true,
        },
        { key: 'speak_original', actionId: 'speak_original', group: 'speak', params: {}, enabled: true, active: false },
        {
            key: 'speak_translation',
            actionId: 'speak_translation',
            group: 'speak',
            params: {},
            enabled: true,
            active: false,
        },
    ];
    const view = (props) =>
        renderToStaticMarkup(
            createElement(View, {
                defaultMoreOpen: true,
                items,
                ctx: baseCtx(),
                activeSpeech: null,
                notice: null,
                run: () => {},
                favoriteLanguages: ['ja'],
                updateFavorites: () => {},
                ...props,
            })
        );

    test('translation loading is visible and announced politely', () => {
        const html = view({ ctx: baseCtx({ status: 'loading' }) });
        assert.match(html, /role="status"/);
        assert.match(html, /aria-live="polite"/);
        assert.match(html, /Translating…/);
    });

    test('notices render as escaped text, never as HTML; a translation error is not repeated here', () => {
        const evil = '<img src=x onerror=alert(1)>';
        const html = view({
            ctx: baseCtx({ status: 'error', error: evil }),
            notice: { code: 'synth-failed', message: `Speech synthesis failed. ${evil}` },
        });
        assert.doesNotMatch(html, /<img/);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        // The result card and the provider notice (F1) already show the translation error.
        assert.doesNotMatch(html, /Translation failed\./);
        assert.equal(html.split('onerror=alert').length - 1, 1, 'only the notice carries the text');
    });

    test('notice codes are shown through i18n, falling back to the English message', () => {
        assert.match(view({ notice: { code: 'tts-unconfigured', message: 'x' } }), /No TTS service configured\./);
        assert.match(
            view({ notice: { code: 'not-a-known-code', message: 'Custom fallback text' } }),
            /Custom fallback text/
        );
    });

    test('active speech shows a pressed, stoppable speak button', () => {
        const html = view({ activeSpeech: { kind: 'original', phase: 'playing' } });
        assert.match(button(html, 'Speak original'), /aria-pressed="true"/);
        assert.match(button(html, 'Speak original'), /title="Stop speaking \(S\)"/);
        assert.match(button(html, 'Speak translation'), /aria-pressed="false"/);
    });

    test('a pending synthesis shows a progress indicator instead of the label', () => {
        const html = view({ activeSpeech: { kind: 'translation', phase: 'pending' } });
        assert.match(button(html, 'data-testid="spinner"'), /aria-pressed="true"/);
        assert.doesNotMatch(button(html, 'aria-pressed="true"'), /Speak translation/);
    });
});
