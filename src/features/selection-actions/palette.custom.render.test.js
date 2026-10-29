// Run with: node --test src/features/selection-actions/palette.custom.render.test.js
// Server-side render of the real palette view / custom actions editor (real NextUI + react-i18next).
// Checks markup, state mapping and that user-supplied names / instructions / provider output stay
// escaped text. Typing, saving and pointer behaviour in a webview is covered by the browser harness;
// native Windows behaviour is NOT VERIFIED here.
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { after, before, describe, test } from 'node:test';
import { createScenario, loadProduction } from './testing/harness.js';

let p;
let View;
let Panel;
let Editor;
let custom;

before(async () => {
    p = await loadProduction();
    const mod = await p.loader.load('/src/features/selection-actions/SelectionActionPalette.jsx');
    View = mod.SelectionActionPaletteView;
    Panel = mod.AiResultPanel;
    Editor = (await p.loader.load('/src/features/selection-actions/CustomActionsEditor.jsx')).CustomActionsEditor;
    custom = await p.loader.load('/src/features/selection-actions/customActions.js');
    const i18n = (await p.loader.load('/src/i18n/index.jsx')).default;
    await i18n.changeLanguage('en');
});
after(() => p.loader.close());

const noop = () => {};
const render = (element) => {
    delete globalThis.window;
    return renderToStaticMarkup(element);
};
const A1 = 'openai_compat_ai@a1';
const GEMINI = 'gemini_ai@b2';
const instances = [
    { key: A1, label: 'Work GPT' },
    { key: GEMINI, label: 'Gemini Home' },
];
const entry = (id, name, extra = {}) => ({
    id,
    name,
    icon: 'idea',
    instanceKey: A1,
    instruction: 'Do it.',
    outputMode: 'popup',
    ...extra,
});
const stored = (...actions) => ({ version: 1, actions });

const ops = {
    create: async () => ({ ok: true }),
    update: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
    purgeUnreadable: async () => ({ ok: true }),
    reset: async () => ({ ok: true }),
};

function customProp(raw, ctx) {
    const read = custom.readCustomActions(raw);
    return {
        format: read.format,
        actions: ctx ? ctx.customActions : read.actions,
        unreadableCount: read.unreadable.length,
        ...ops,
    };
}

function viewHtml({ raw, env = {}, text = 'Hello world', mutate } = {}) {
    const s = createScenario(p, { customActions: raw, aiInstanceKey: A1, ...env });
    try {
        s.set('sourceText', text);
        mutate?.(s);
        const ctx = s.runtime.getContext();
        return render(
            createElement(View, {
                items: s.runtime.getItems(),
                ctx,
                activeSpeech: null,
                notice: null,
                run: noop,
                favoriteLanguages: ['zh_cn', 'en'],
                updateFavorites: noop,
                ai: { ...ctx.ai, instances, select: noop, retry: noop, dismiss: noop },
                custom: customProp(raw, ctx),
            })
        );
    } finally {
        s.cleanup();
    }
}
const button = (html, label) =>
    html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's'))?.[0] ??
    html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ??
    '';

describe('custom action row of the palette', () => {
    test('one button per stored action with its name and icon, plus the manage button', () => {
        const html = viewHtml({ raw: stored(entry('a', 'Explain'), entry('b', '翻译', { icon: 'translate' })) });
        assert.match(html, /aria-label="Custom actions"/);
        for (const label of ['Explain', '翻译']) {
            const markup = button(html, label);
            assert.ok(markup, label);
            assert.doesNotMatch(markup, /disabled/, label);
            assert.match(markup, /<svg/, 'icon');
        }
        assert.match(button(html, 'Manage custom actions'), /aria-expanded="false"/);
    });

    test('with nothing stored only the manage button is offered (so the first action can be created)', () => {
        const html = viewHtml({ raw: null });
        assert.match(html, /data-testid="selection-custom-actions"/);
        assert.match(button(html, 'Manage custom actions'), /<button/);
        assert.doesNotMatch(html, /Explain/);
    });

    test('names are escaped text, never markup or interpolation', () => {
        const names = [
            '<img src=x onerror=alert(1)>',
            '<script>alert(1)</script>',
            '{{count}} $t(foo)',
            '"quoted" & more',
        ];
        const html = viewHtml({ raw: stored(...names.map((name, i) => entry(`x${i}`, name))) });
        assert.doesNotMatch(html, /<img |<script/i);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /\{\{count\}\} \$t\(foo\)/);
        assert.match(html, /&quot;quoted&quot; &amp; more/);
    });

    test('a missing, unsupported or unconfigured service disables the button with the reason as its title', () => {
        const missing = viewHtml({ raw: stored(entry('a', 'Gone', { instanceKey: 'openai_ai@gone' })) });
        assert.match(button(missing, 'Gone'), /disabled/);
        assert.match(
            button(missing, 'Gone'),
            /title="The chosen AI service is no longer configured\. Choose another one\."/
        );
        const none = viewHtml({ raw: stored(entry('a', 'Nobody')), env: { aiServiceList: [] } });
        assert.match(button(none, 'Nobody'), /title="No AI service is configured\."/);
        const mode = viewHtml({ raw: stored(entry('a', 'Future', { outputMode: 'replace' })) });
        assert.match(button(mode, 'Future'), /disabled/);
        assert.match(button(mode, 'Future'), /not supported/);
    });

    test('no selection disables the buttons; the other windows get no custom row at all', () => {
        const blank = viewHtml({ raw: stored(entry('a', 'Explain')), text: '  ' });
        assert.match(button(blank, 'Explain'), /disabled/);
        assert.match(blank, /No selected text\./);
    });

    test('corrupted stored values render a palette without custom buttons and without throwing', () => {
        for (const raw of ['garbage', 12, [], { version: 7, actions: [] }, { version: 1, actions: [null, 5] }]) {
            const html = viewHtml({ raw });
            assert.match(html, /data-testid="selection-palette"|data-testid="selection-action-palette"/);
            assert.match(html, /Analyze sentence/, 'built-in actions unaffected');
            assert.doesNotMatch(html, /aria-pressed="[a-z]+"[^>]*>[^<]*custom_ai/);
        }
    });

    test('without the custom prop (foundation callers) no custom row is rendered', () => {
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
            assert.doesNotMatch(html, /Custom actions|selection-custom-actions/);
        } finally {
            s.cleanup();
        }
    });
});

describe('custom action result panel', () => {
    const result = (overrides = {}) => ({
        requestId: 1,
        actionId: 'custom_ai',
        preset: null,
        customId: 'a',
        customRevision: 1,
        labelKey: null,
        defaultLabel: 'Explain',
        outputKind: 'text',
        instanceKey: A1,
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
    });
    const ai = { instances, select: noop, retry: noop, dismiss: noop };
    const panel = (r) => render(createElement(Panel, { result: r, ai }));

    test('labelled as AI-generated with the user-chosen action name and the producing service', () => {
        const html = panel(result());
        assert.match(html, /AI-generated/);
        assert.match(html, /Work GPT · gpt-test-1/);
        assert.match(html, /<span class="truncate">Explain<\/span>/);
        assert.match(html, /Hello there\./);
    });

    test('the action name is never run through i18n interpolation or markup', () => {
        const html = panel(result({ defaultLabel: '{{count}} <b>$t(languages.en)</b>' }));
        assert.match(html, /\{\{count\}\} &lt;b&gt;\$t\(languages\.en\)&lt;\/b&gt;/);
        assert.doesNotMatch(html, /<b>/);
    });

    test('hostile provider output is plain escaped text for a custom action', () => {
        const html = panel(
            result({
                output: '<script>alert(1)</script><img src=x onerror=alert(2)> [link](javascript:alert(3)) **bold**',
            })
        );
        assert.doesNotMatch(html, /<script|<img |<a /i);
        assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(html, /\*\*bold\*\*/, 'shown as typed, not interpreted');
    });

    test('loading, error with retry, and empty-result states', () => {
        assert.match(panel(result({ status: 'loading', output: '' })), /Working/);
        const failed = panel(
            result({ status: 'error', errorCode: 'ai-failed', error: 'HTTP 500 <b>x</b>', output: '' })
        );
        assert.match(failed, /The AI service returned an error\. HTTP 500 &lt;b&gt;x&lt;\/b&gt;/);
        assert.match(failed, /Retry/);
        const empty = panel(result({ status: 'error', errorCode: 'ai-empty-result', output: '' }));
        assert.match(empty, /The AI service returned an empty result\./);
    });

    test('in the palette the pressed button follows the shown custom result', async () => {
        const raw = stored(entry('a', 'Explain'), entry('b', 'Other'));
        const s = createScenario(p, { customActions: raw, aiInstanceKey: A1 });
        try {
            s.store.set(p.aiResultAtom, result({ text: 'Hello world', status: 'success' }));
            const ctx = s.runtime.getContext();
            assert.equal(ctx.ai.result.customId, 'a');
            const html = render(
                createElement(View, {
                    items: s.runtime.getItems(),
                    ctx,
                    activeSpeech: null,
                    notice: null,
                    run: noop,
                    favoriteLanguages: ['en'],
                    updateFavorites: noop,
                    ai: { ...ctx.ai, instances, select: noop, retry: noop, dismiss: noop },
                    custom: customProp(raw, ctx),
                })
            );
            assert.match(button(html, 'Explain'), /aria-pressed="true"/);
            assert.match(button(html, 'Other'), /aria-pressed="false"/);
            assert.match(html, /data-testid="ai-result"/);
        } finally {
            s.cleanup();
        }
    });
});

describe('custom actions editor', () => {
    const editor = (raw, extra = {}) => {
        const read = custom.readCustomActions(raw);
        return render(
            createElement(Editor, {
                custom: {
                    format: read.format,
                    actions: read.actions,
                    unreadableCount: read.unreadable.length,
                    ...ops,
                    ...extra,
                },
                instances,
            })
        );
    };

    test('lists actions with name, service name and Edit / Delete controls', () => {
        const html = editor(stored(entry('a', 'Explain'), entry('b', 'Gem', { instanceKey: GEMINI })));
        assert.match(html, /data-testid="custom-row-a"/);
        assert.match(html, /Work GPT/);
        assert.match(html, /Gemini Home/);
        assert.match(html, /aria-label="Edit: Explain"/);
        assert.match(html, /aria-label="Delete: Gem"/);
        assert.match(html, /Add/);
        assert.doesNotMatch(html, /data-testid="custom-form"/);
    });

    test('empty state explains what to do; add is available', () => {
        const html = editor(null);
        assert.match(html, /data-testid="custom-empty"/);
        assert.match(html, /No custom actions yet/);
        assert.match(button(html, 'Add'), /<button/);
    });

    test('an action whose service is gone shows the stored reference, and nothing is swapped in', () => {
        const html = editor(stored(entry('a', 'Orphan', { instanceKey: 'openai_ai@gone' })));
        assert.match(html, /openai_ai@gone/);
    });

    test('an unsupported output mode is flagged on the row', () => {
        const html = editor(stored(entry('a', 'Future', { outputMode: 'replace-selection' })));
        assert.match(html, /This output mode is not supported\. Choose Popup\. \(replace-selection\)/);
    });

    test('unreadable entries are announced with an explicit removal control', () => {
        const html = editor({ version: 1, actions: [entry('a', 'Ok'), null, { broken: 1 }] });
        assert.match(html, /data-testid="custom-unreadable"/);
        assert.match(html, /2 stored entries cannot be read/);
        const one = editor({ version: 1, actions: [entry('a', 'Ok'), null] });
        assert.match(one, /1 stored entry cannot be read and is not shown/);
        assert.match(button(html, 'Remove unreadable entries'), /<button/);
        assert.match(html, /Ok/);
    });

    test('an unsupported stored format is explained, nothing is offered for editing, reset is explicit', () => {
        for (const raw of ['garbage', { version: 3, actions: [] }]) {
            const html = editor(raw);
            assert.match(html, /data-testid="custom-format-unsupported"/);
            assert.match(html, /left untouched/);
            assert.match(button(html, 'Discard and start over'), /<button/);
            assert.doesNotMatch(html, />Add<|data-testid="custom-list"|data-testid="custom-empty"/);
        }
    });

    test('user-supplied names never become markup', () => {
        const html = editor(stored(entry('a', '<img src=x onerror=alert(1)>'), entry('b', '<script>x</script>')));
        assert.doesNotMatch(html, /<img |<script/i);
        assert.match(html, /aria-label="Edit: &lt;img src=x onerror=alert\(1\)&gt;"/);
    });

    test('Add is disabled at the limit', () => {
        const many = Array.from({ length: custom.MAX_CUSTOM_ACTIONS }, (_, i) => entry(`id${i}`, `Action ${i}`));
        assert.match(button(editor(stored(...many)), 'Add'), /disabled/);
    });
});
