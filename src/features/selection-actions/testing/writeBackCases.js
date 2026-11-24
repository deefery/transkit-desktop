// Runs in the browser: the real AiResultPanel with a fake write-back (the native commands are
// replaced). Checks when "Replace original" is offered, what it sends, and what it says afterwards.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/style.css';
import '/src/i18n/index.jsx';
import { AiResultPanel } from '/src/features/selection-actions/SelectionActionPalette.jsx';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const AI = { instances: [], dismiss: () => {}, retry: () => {} };
const base = {
    requestId: 1,
    status: 'success',
    outputKind: 'text',
    output: 'A clearer sentence.',
    text: 'a sentence that is unclear',
    labelKey: 'selection_actions.improve_presets.natural',
    defaultLabel: 'Natural',
    instanceKey: 'openai_compat_ai@a1',
    serviceName: 'openai_compat_ai',
    instanceLabel: 'Work GPT',
    model: 'gpt-one',
};

async function mount(result, writeBack) {
    const host = document.createElement('div');
    document.getElementById('root').appendChild(host);
    const root = createRoot(host);
    root.render(React.createElement(AiResultPanel, { result, ai: AI, writeBack }));
    await sleep(200);
    const q = (id) => host.querySelector(`[data-testid="${id}"]`);
    return { host, root, q };
}

function fakeWriteBack({ can = true, outcome = { ok: true } } = {}) {
    const calls = [];
    return {
        calls,
        canReplace: async (original) => {
            calls.push(['can', original]);
            return can;
        },
        replace: async (original, text) => {
            calls.push(['replace', original, text]);
            return outcome;
        },
    };
}

export async function run() {
    const { default: i18n } = await import('/src/i18n/index.jsx');
    await i18n.changeLanguage('en');
    document.getElementById('result').style.display = 'none';
    const out = {};

    // Offered and used: the original selection and the rewrite go to the native side.
    let wb = fakeWriteBack();
    let m = await mount(base, wb);
    out.offered = { button: m.q('ai-replace-original')?.innerText.trim() ?? null, title: m.q('ai-replace-original')?.title ?? null };
    m.q('ai-replace-original').click();
    await sleep(200);
    out.done = {
        calls: wb.calls,
        status: m.q('ai-replace-status')?.innerText.trim() ?? null,
        key: m.q('ai-replace-status')?.getAttribute('data-key') ?? null,
        buttonAfter: Boolean(m.q('ai-replace-original')),
    };
    m.root.unmount();

    // The native side refuses (window closed): the text is on the clipboard and the user is told.
    wb = fakeWriteBack({ outcome: { ok: false, code: 'source-closed' } });
    m = await mount(base, wb);
    m.q('ai-replace-original').click();
    await sleep(200);
    out.failed = { status: m.q('ai-replace-status')?.innerText.trim() ?? null, key: m.q('ai-replace-status')?.getAttribute('data-key') ?? null };
    m.root.unmount();

    // Not offered: no source window, Markdown analysis, a result still loading, no write-back.
    wb = fakeWriteBack({ can: false });
    m = await mount(base, wb);
    out.noSource = { button: Boolean(m.q('ai-replace-original')), calls: wb.calls.length };
    m.root.unmount();
    wb = fakeWriteBack();
    m = await mount({ ...base, outputKind: 'markdown' }, wb);
    out.markdown = { button: Boolean(m.q('ai-replace-original')), calls: wb.calls.length };
    m.root.unmount();
    wb = fakeWriteBack();
    m = await mount({ ...base, status: 'loading', output: '' }, wb);
    out.loading = { button: Boolean(m.q('ai-replace-original')), calls: wb.calls.length };
    m.root.unmount();
    m = await mount(base, null);
    out.withoutWriteBack = { button: Boolean(m.q('ai-replace-original')) };
    m.root.unmount();

    return out;
}
