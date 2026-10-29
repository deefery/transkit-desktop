// Runs in the browser: the real SelectionActionPalette React tree (real hook, atoms, registry,
// dictionary controller, Cambridge adapter, mapper, panel) mounted in headless Edge. Replaced
// boundaries: the Tauri native API (in-memory stub) and the HTTP transport (fixtures or live).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import '/src/style.css';
import '/src/i18n/index.jsx';
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

const panel = () => document.querySelector('[data-testid="dictionary-panel"]');
const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const textOf = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : null);

export async function run({ steps, language = 'en', keepOpen = false }) {
    const { default: i18n } = await import('/src/i18n/index.jsx');
    await i18n.changeLanguage(language);
    // Same look as the app: Tailwind/NextUI light theme, the narrow selection-translate popup width.
    document.documentElement.classList.add('light');
    document.body.style.cssText = 'margin:0;padding:8px;width:420px;background:#fff;color:#11181c';
    document.getElementById('result').style.display = 'none';
    const store = createStore();
    store.set(windowTypeAtom, '[SELECTION_TRANSLATE]');
    store.set(sourceLanguageAtom, 'auto');
    store.set(targetLanguageAtom, 'zh_cn');
    store.set(detectLanguageAtom, 'en');
    store.set(sourceTextAtom, steps[0].text);
    createRoot(document.getElementById('root')).render(
        React.createElement(Provider, { store }, React.createElement(SelectionActionPalette, { serviceInstanceConfigMap: {} }))
    );
    await waitFor(() => button('Dictionary') || button('词典'), 'palette');
    const label = language === 'en' ? 'Dictionary' : '词典';
    const log = [];
    for (const step of steps) {
        if (step.text !== undefined) store.set(sourceTextAtom, step.text);
        if (step.target) store.set(targetLanguageAtom, step.target);
        await sleep(100);
        const entry = { text: step.text, panelBefore: Boolean(panel()) };
        if (step.click !== false) {
            button(label).click();
            await waitFor(
                () => panel() && !panel().querySelector('[aria-busy="true"]') && panel(),
                `dictionary result for ${step.text}`
            );
        }
        const p = panel();
        entry.panel = p ? textOf(p) : null;
        entry.errorCode = p?.querySelector('[data-testid="dictionary-error"]')?.getAttribute('data-code') ?? null;
        entry.source = textOf(p?.querySelector('[data-testid="dictionary-source"]'));
        entry.hasResult = Boolean(p?.querySelector('[data-testid="dictionary-result"]'));
        entry.hasPronounce = Boolean([...(p?.querySelectorAll('button') ?? [])].find((b) => /Pronounce|发音/.test(b.textContent)));
        entry.scriptElementsInPanel = p ? p.querySelectorAll('script, img, iframe').length : 0;
        entry.toolbar = [...document.querySelectorAll('[role="toolbar"] button')].map((b) => ({
            text: b.textContent.trim(),
            pressed: b.getAttribute('aria-pressed'),
            disabled: b.disabled,
        }));
        log.push(entry);
    }
    if (keepOpen) return { log, panelAfterClose: Boolean(panel()) };
    // Close button dismisses the panel.
    document.querySelector('[aria-label="Close dictionary"]')?.click();
    await sleep(100);
    return { log, panelAfterClose: Boolean(panel()) };
}
