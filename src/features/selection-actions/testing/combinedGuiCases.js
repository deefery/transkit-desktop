// Runs in the browser: the real combined SelectionActionPalette (real hook, atoms, registry,
// dictionary controller + Cambridge adapter/parser, shared AI runner, real services/ai request code)
// mounted in headless Edge. Replaced boundaries: the Tauri native API (in-memory stub, seeded with an
// AI service instance) and the HTTP transport (fixtures answered by the test runner).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import '/src/style.css';
import '/src/i18n/index.jsx';
import { store as configStore } from '/src/utils/store.js';
import SelectionActionPalette from '/src/features/selection-actions/SelectionActionPalette.jsx';
import { sourceTextAtom, detectLanguageAtom, windowTypeAtom } from '/src/window/Translate/components/SourceArea/index.jsx';
import { sourceLanguageAtom, targetLanguageAtom } from '/src/window/Translate/components/LanguageArea/index.jsx';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, what, ms = 20000) {
    const start = Date.now();
    for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
}

const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const textOf = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : null);
const labelOf = (el) => el?.getAttribute('aria-label') || el?.textContent.trim() || null;

const AI_KEY = 'openai_compat_ai@a1';

export async function run() {
    const { default: i18n } = await import('/src/i18n/index.jsx');
    await i18n.changeLanguage('en');
    document.documentElement.classList.add('light');
    document.body.style.cssText = 'margin:0;padding:8px;width:420px;background:#fff;color:#11181c';
    document.getElementById('result').style.display = 'none';

    // Existing config keys only: one AI service instance, the default keyless dictionary source.
    await configStore.set('translate_service_list', ['google']);
    await configStore.set('ai_service_list', [AI_KEY]);
    await configStore.set(AI_KEY, {
        instanceName: 'Work GPT',
        requestPath: 'https://llm.one.test/v1/chat/completions',
        apiKey: 'sk-test-SECRET-111111',
        model: 'gpt-one',
    });

    const store = createStore();
    store.set(windowTypeAtom, '[SELECTION_TRANSLATE]');
    store.set(sourceLanguageAtom, 'auto');
    store.set(targetLanguageAtom, 'zh_cn');
    store.set(detectLanguageAtom, 'en');
    store.set(sourceTextAtom, 'resilience');
    createRoot(document.getElementById('root')).render(
        React.createElement(Provider, { store }, React.createElement(SelectionActionPalette, { serviceInstanceConfigMap: {} }))
    );
    await waitFor(() => button('Dictionary') && button('Analyze sentence'), 'palette');
    await waitFor(() => !button('Analyze sentence').disabled, 'AI service available');

    // Keyboard: ArrowRight walks the first toolbar, including past the Tooltip-wrapped favorites editor.
    const toolbar = document.querySelector('[data-testid="selection-action-palette"] [role="toolbar"]');
    toolbar.querySelector('button').focus();
    const walk = [labelOf(document.activeElement)];
    for (let i = 0; i < 8; i += 1) {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        await sleep(30);
        walk.push(labelOf(document.activeElement));
    }
    // ... and back.
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    await sleep(30);
    const afterLeft = labelOf(document.activeElement);

    // Dictionary + AI result next to each other.
    button('Dictionary').click();
    await waitFor(() => document.querySelector('[data-testid="dictionary-result"]'), 'dictionary result');
    button('Analyze sentence').click();
    await waitFor(() => document.querySelector('[data-testid="ai-output"]'), 'AI output');
    await sleep(100);
    const aiOutput = document.querySelector('[data-testid="ai-output"]');
    const dictResult = document.querySelector('[data-testid="dictionary-result"]');
    const box = (el) => ({
        overflowY: getComputedStyle(el).overflowY,
        maxHeight: getComputedStyle(el).maxHeight,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
    });
    return {
        walk,
        afterLeft,
        bothPanels: Boolean(document.querySelector('[data-testid="dictionary-panel"]') && document.querySelector('[data-testid="ai-result"]')),
        aiOutputBox: box(aiOutput),
        dictionaryBox: box(dictResult),
        aiText: textOf(aiOutput),
        dictionarySource: textOf(document.querySelector('[data-testid="dictionary-source"]')),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
}
