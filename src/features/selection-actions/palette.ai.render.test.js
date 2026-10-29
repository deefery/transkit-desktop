// Run with: node --test src/features/selection-actions/palette.ai.render.test.js
// Server-side render of the real palette view / AI result panel (real NextUI + react-markdown).
// Checks markup, state mapping, origin labelling and that provider output stays text / safe
// Markdown. Pointer behaviour in a webview is covered by the browser harness; native Windows
// behaviour is NOT VERIFIED here.
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createStore, Provider } from 'jotai';
import { after, before, describe, test } from 'node:test';
import { createScenario, loadProduction } from './testing/harness.js';

let p;
let View;
let Panel;

before(async () => {
    p = await loadProduction();
    const mod = await p.loader.load('/src/features/selection-actions/SelectionActionPalette.jsx');
    View = mod.SelectionActionPaletteView;
    Panel = mod.AiResultPanel;
    const i18n = (await p.loader.load('/src/i18n/index.jsx')).default;
    await i18n.changeLanguage('en');
});
after(() => p.loader.close());

const noop = () => {};

// createScenario installs a fake `window` for the audio boundary; react-aria/react-markdown take a
// defined `window` for a browser and then need `document`, so render the way the SSR tests do.
const render = (element) => {
    delete globalThis.window;
    return renderToStaticMarkup(element);
};
const aiHandlers = { select: noop, retry: noop, dismiss: noop };

function result(overrides = {}) {
    return {
        requestId: 1,
        actionId: 'improve_writing',
        preset: 'natural',
        labelKey: 'selection_actions.improve_presets.natural',
        defaultLabel: 'Natural',
        outputKind: 'text',
        instanceKey: 'openai_compat_ai@a1',
        serviceName: 'openai_compat_ai',
        instanceLabel: 'Work GPT',
        model: 'gpt-test-1',
        text: 'hello',
        targetLanguage: 'ja',
        status: 'success',
        output: 'Hello there.',
        errorCode: null,
        error: '',
        ...overrides,
    };
}

const panel = (r) => render(createElement(Panel, { result: r, ai: aiHandlers }));

// A real runtime over a real store gives the real item list / context the view is rendered from.
function viewHtml({ ai: aiOverrides = {}, env = {}, text = 'Hello world', mutate } = {}) {
    const s = createScenario(p, env);
    try {
        s.set('sourceText', text);
        mutate?.(s);
        const ctx = s.runtime.getContext();
        const ai = {
            ...ctx.ai,
            instances: ctx.ai.instances.map((key) => ({
                key,
                label: key === 'openai_compat_ai@a1' ? 'Work GPT' : 'Gemini Home',
            })),
            ...aiHandlers,
            ...aiOverrides,
        };
        return render(
            createElement(View, {
                items: s.runtime.getItems(),
                ctx,
                activeSpeech: null,
                notice: null,
                run: noop,
                favoriteLanguages: ['zh_cn', 'en'],
                updateFavorites: noop,
                ai,
            })
        );
    } finally {
        s.cleanup();
    }
}

const button = (html, label) =>
    html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's'))?.[0] ?? '';

describe('AI row of the palette', () => {
    test('shows Analyze sentence, the five Improve presets and the AI service choice', () => {
        const html = viewHtml({ env: { aiInstanceKey: 'openai_compat_ai@a1' } });
        assert.match(html, /role="toolbar"[^>]*aria-label="AI actions"|aria-label="AI actions"[^>]*role="toolbar"/);
        for (const label of ['Analyze sentence', 'Natural', 'Concise', 'Professional', 'Casual', 'Correct grammar']) {
            const markup = button(html, label);
            assert.ok(markup, label);
            assert.doesNotMatch(markup, /disabled/, label);
        }
        assert.match(html, /Improve/);
        assert.match(button(html, 'Work GPT'), /aria-label="AI service"/);
    });

    test('actions are disabled with a visible reason when no AI service is configured', () => {
        const html = viewHtml({ env: { aiServiceList: [] } });
        for (const label of ['Analyze sentence', 'Natural', 'Correct grammar']) {
            assert.match(button(html, label), /disabled/, label);
            assert.match(button(html, label), /title="No AI service is configured\."/, label);
        }
        assert.match(html, /role="status"[^>]*>No AI service is configured\./);
        assert.match(button(html, 'Choose AI service'), /disabled/);
    });

    test('a deleted chosen instance is reported, the selector offers the configured ones', () => {
        const html = viewHtml({ env: { aiInstanceKey: 'openai_ai@gone' } });
        assert.match(html, /The chosen AI service is no longer configured\. Choose another one\./);
        assert.match(button(html, 'Natural'), /disabled/);
        assert.match(button(html, 'Choose AI service'), /aria-label="AI service"/);
        assert.doesNotMatch(button(html, 'Choose AI service'), /disabled/);
    });

    test('blank selection disables the AI actions', () => {
        const html = viewHtml({ env: { aiInstanceKey: 'openai_compat_ai@a1' }, text: '   ' });
        assert.match(button(html, 'Analyze sentence'), /disabled/);
        assert.match(button(html, 'Natural'), /disabled/);
        assert.doesNotMatch(html, /No AI service/);
    });

    test('without the ai prop (foundation callers) no AI row is rendered', () => {
        const s = createScenario(p);
        try {
            const html = render(
                createElement(View, {
                    items: s.runtime.getItems(),
                    ctx: s.runtime.getContext(),
                    activeSpeech: null,
                    notice: null,
                    run: noop,
                    favoriteLanguages: ['en'],
                    updateFavorites: noop,
                })
            );
            assert.doesNotMatch(html, /Analyze sentence|AI actions/);
        } finally {
            s.cleanup();
        }
    });

    test('after a real dispatch the active entry is pressed and the panel shows the producing service', async () => {
        await p.configStore.set('openai_compat_ai@a1', {
            instanceName: 'Work GPT',
            requestPath: 'https://llm.example.test/v1/chat/completions',
            model: 'gpt-test-1',
        });
        let reply;
        globalThis.__transkitTestHttp = () => new Promise((resolve) => (reply = resolve));
        const s = createScenario(p, { aiInstanceKey: 'openai_compat_ai@a1' });
        try {
            const pending = s.runtime.dispatch('improve_writing', { preset: 'concise' });
            await new Promise((resolve) => setImmediate(resolve));
            reply({ ok: true, status: 200, data: { choices: [{ message: { content: 'Short.' } }] } });
            await pending;
            const ctx = s.runtime.getContext();
            const html = render(
                createElement(View, {
                    items: s.runtime.getItems(),
                    ctx,
                    activeSpeech: null,
                    notice: null,
                    run: noop,
                    favoriteLanguages: ['en'],
                    updateFavorites: noop,
                    ai: {
                        ...ctx.ai,
                        instances: [{ key: 'openai_compat_ai@a1', label: 'Work GPT' }],
                        ...aiHandlers,
                    },
                })
            );
            assert.match(button(html, 'Concise'), /aria-pressed="true"/);
            assert.match(button(html, 'Natural'), /aria-pressed="false"/);
            assert.match(html, /data-testid="ai-result"/);
            assert.match(html, /AI-generated/);
            assert.match(html, /Work GPT · gpt-test-1/);
            assert.match(html, /Short\./);
        } finally {
            s.cleanup();
            delete globalThis.__transkitTestHttp;
        }
    });
});

describe('AI result panel: origin, states, safe output', () => {
    test('success is labelled AI-generated with the producing service and model', () => {
        const html = panel(result());
        assert.match(html, /data-testid="ai-origin"[^>]*>AI-generated</);
        assert.match(html, /Work GPT · gpt-test-1/);
        assert.match(html, />Natural</);
        assert.match(html, /Hello there\./);
        assert.match(html, />Copy</);
        assert.doesNotMatch(html, /dictionary/i);
    });

    test('loading, error (recoverable) and the service name when the model is unknown', () => {
        const loading = panel(result({ status: 'loading', output: '', model: '' }));
        assert.match(loading, /Working…/);
        assert.match(loading, /Work GPT</);
        assert.doesNotMatch(loading, /Work GPT ·/);
        assert.doesNotMatch(loading, />Copy</);

        const failed = panel(result({ status: 'error', output: '', errorCode: 'ai-failed', error: 'AI request failed: 401' }));
        assert.match(failed, /The AI service returned an error\. AI request failed: 401/);
        assert.match(failed, />Retry</);
        assert.doesNotMatch(failed, />Copy</);

        const empty = panel(result({ status: 'error', output: '', errorCode: 'ai-empty-result' }));
        assert.match(empty, /The AI service returned an empty result\./);
        assert.match(empty, />Retry</);
    });

    test('Improve output is plain text: markup-looking output is escaped, never HTML', () => {
        const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a> **bold** [l](https://evil.test)';
        const html = panel(result({ output: hostile }));
        assert.doesNotMatch(html, /<script/);
        assert.doesNotMatch(html, /<img/);
        assert.doesNotMatch(html, /<a /);
        assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(html, /\*\*bold\*\*/, 'plain text is not reinterpreted as Markdown');
    });

    test('Sentence Analysis output is safe Markdown: formatting kept, raw HTML as text, no images/links/scripts', () => {
        const output = [
            '**Chunks**',
            '- <script>alert(1)</script> chunk one - meaning',
            '- chunk two - `code`',
            '',
            '![tracking](https://evil.test/pixel.png) [click me](javascript:alert(1)) [site](https://evil.test)',
            '',
            '<iframe src="https://evil.test"></iframe><img src=x onerror=alert(1)>',
            '<style>body{display:none}</style>',
        ].join('\n');
        const html = panel(result({ outputKind: 'markdown', actionId: 'sentence_analysis', preset: null, output }));
        assert.match(html, /<strong>Chunks<\/strong>/);
        assert.match(html, /<li>/);
        assert.match(html, /<code[^>]*>code<\/code>/);
        for (const forbidden of [/<script/, /<img/, /<a[ >]/, /<iframe/, /<style/, /javascript:/i, /href=/, /src=/, /onerror=/]) {
            // `src=x onerror=...` may only appear as escaped text, never as an attribute
            const attributeLike = html.replace(/&lt;[^]*?&gt;/g, '');
            assert.doesNotMatch(attributeLike, forbidden, String(forbidden));
        }
        assert.match(html, /click me/, 'link text kept as text');
        assert.match(html, /&lt;script&gt;/, 'raw HTML shown as text');
    });

    test('hostile origin labels, models and errors are escaped text', () => {
        const html = panel(
            result({
                instanceLabel: '<img src=x onerror=alert(1)>',
                model: '"><script>alert(2)</script>',
                status: 'error',
                output: '',
                errorCode: 'ai-failed',
                error: '<b onmouseover=alert(3)>boom</b>',
            })
        );
        assert.doesNotMatch(html, /<img|<script|<b /);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    });

    test('unknown error codes fall back to their code text instead of crashing', () => {
        const html = panel(result({ status: 'error', output: '', errorCode: 'something-new', error: '' }));
        assert.match(html, /something-new/);
    });
});

describe('full palette (hook + real store) in the non-selection windows', () => {
    test('input and image windows still render nothing, AI row included', async () => {
        const mod = await p.loader.load('/src/features/selection-actions/SelectionActionPalette.jsx');
        for (const windowType of ['[INPUT_TRANSLATE]', '[IMAGE_TRANSLATE]']) {
            const store = createStore();
            store.set(p.atoms.windowType, windowType);
            store.set(p.atoms.sourceText, 'Hello world');
            const html = renderToStaticMarkup(
                createElement(Provider, { store }, createElement(mod.default, { serviceInstanceConfigMap: {} }))
            );
            assert.equal(html, '', windowType);
        }
    });
});
