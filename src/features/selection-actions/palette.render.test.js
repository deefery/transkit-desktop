// Run with: node --test src/features/selection-actions/palette.render.test.js
// Server-side render of the real palette (real hook + real atoms + real NextUI components).
// This checks markup, state mapping, accessibility attributes and safe text rendering; pointer /
// focus behaviour in a real webview is covered by the browser harness and native checks.
import assert from 'node:assert/strict';
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
        createElement(Provider, { store }, createElement(Palette, { serviceInstanceConfigMap: {} }))
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
    test('selection window: toolbar with default favorites, active one pressed, speak actions present', () => {
        const html = render(selectionStore({ target: 'ja' }));
        assert.match(html, /role="toolbar"/);
        assert.match(html, /aria-label="Selection actions"/);
        for (const name of ['Simplified Chinese', 'English', 'Japanese', 'Spanish']) {
            assert.ok(button(html, name), `${name} chip`);
        }
        assert.match(button(html, 'Japanese'), /aria-pressed="true"/);
        assert.match(button(html, 'English'), /aria-pressed="false"/);
        assert.ok(button(html, 'Speak original'));
        assert.ok(button(html, 'Speak translation'));
        assert.doesNotMatch(button(html, 'English'), /disabled/);
        assert.doesNotMatch(button(html, 'Speak original'), /disabled/);
    });

    test('Speak translation is disabled (with a reason) until a current translation exists', () => {
        const html = render(selectionStore());
        const speakTranslation = button(html, 'Speak translation');
        assert.match(speakTranslation, /disabled/);
        assert.match(speakTranslation, /title="No translation yet\."/);
    });

    test('blank selection disables every action', () => {
        const html = render(selectionStore({ text: '   ' }));
        for (const label of ['English', 'Japanese', 'Speak original', 'Speak translation']) {
            assert.match(button(html, label), /disabled/, label);
        }
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

    test('provider errors and notices render as escaped text, never as HTML', () => {
        const evil = '<img src=x onerror=alert(1)>';
        const html = view({
            ctx: baseCtx({ status: 'error', error: evil }),
            notice: { code: 'synth-failed', message: `Speech synthesis failed. ${evil}` },
        });
        assert.doesNotMatch(html, /<img/);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /Translation failed\./);
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
        assert.match(button(html, 'Speak original'), /title="Stop speaking"/);
        assert.match(button(html, 'Speak translation'), /aria-pressed="false"/);
    });

    test('a pending synthesis shows a progress indicator instead of the label', () => {
        const html = view({ activeSpeech: { kind: 'translation', phase: 'pending' } });
        assert.match(button(html, 'data-testid="spinner"'), /aria-pressed="true"/);
        assert.doesNotMatch(button(html, 'aria-pressed="true"'), /Speak translation/);
    });
});
