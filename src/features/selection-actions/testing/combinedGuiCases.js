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
import { translationRecordsAtom } from '/src/features/selection-actions/translationRecords.js';
import { appWindow } from '@tauri-apps/api/window';

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

// A window-wide key press while nothing in particular has the focus.
const press = async (code, init = {}) => {
    const key = init.key ?? (code.startsWith('Key') ? code.slice(3).toLowerCase() : code);
    (init.target ?? document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init })
    );
    await sleep(80);
};

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
    // The translation the Translate window produced for this selection (what C copies).
    store.set(translationRecordsAtom, {
        google: {
            requestId: 1,
            instanceKey: 'google',
            text: 'resilience',
            sourceLanguage: 'auto',
            targetLanguage: 'zh_cn',
            effectiveTargetLanguage: 'zh_cn',
            detectLanguage: 'en',
            status: 'success',
            speakText: '韧性',
            error: '',
        },
    });
    let hides = 0;
    appWindow.hide = async () => {
        hides += 1;
    };
    // Stand-in for App.jsx, which closes the whole window on any Esc that reaches the document.
    let documentEscapes = 0;
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') documentEscapes += 1;
    });
    createRoot(document.getElementById('root')).render(
        React.createElement(Provider, { store }, React.createElement(SelectionActionPalette, { serviceInstanceConfigMap: {} }))
    );
    await waitFor(() => button('Dictionary') && button('Analyze sentence'), 'palette');
    await waitFor(() => !button('Analyze sentence').disabled, 'AI service available');

    // The action row is a single row at this width (420px body).
    const row = document.querySelector('[data-testid="selection-primary-actions"]');
    const rowButtons = [...row.querySelectorAll('button')];
    const rowTops = new Set(rowButtons.map((b) => Math.round(b.getBoundingClientRect().top)));
    const actionRow = {
        labels: rowButtons.map(labelOf),
        rows: rowTops.size,
        overflowsRow: rowButtons.some((b) => b.getBoundingClientRect().right > row.getBoundingClientRect().right + 1),
    };

    // Keyboard: ArrowRight walks the action row and wraps around.
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

    const q = (id) => document.querySelector(`[data-testid="${id}"]`);
    const box = (el) => ({
        overflowY: getComputedStyle(el).overflowY,
        maxHeight: getComputedStyle(el).maxHeight,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
    });

    // A selected word opens the dictionary by itself (smart defaults); then an AI action: the newer
    // AI result is expanded, the dictionary folds.
    await waitFor(() => q('dictionary-result'), 'automatic dictionary result');
    const autoDictionary = Boolean(q('dictionary-result'));
    const dictionarySource = textOf(q('dictionary-source'));
    button('Analyze sentence').click();
    await waitFor(() => q('ai-output'), 'AI output');
    await sleep(100);
    const afterBoth = {
        aiExpanded: Boolean(q('ai-result')),
        dictionaryCollapsed: Boolean(q('dictionary-panel-collapsed')) && !q('dictionary-panel'),
        collapsedText: textOf(q('dictionary-panel-collapsed')),
    };
    const aiOutputBox = box(q('ai-output'));
    const aiText = textOf(q('ai-output'));

    // Expanding the folded dictionary folds the AI result instead.
    q('dictionary-panel-collapsed').click();
    await waitFor(() => q('dictionary-result'), 'dictionary expanded again');
    await sleep(50);
    const afterExpand = {
        dictionaryExpanded: Boolean(q('dictionary-panel')),
        aiCollapsed: Boolean(q('ai-result-collapsed')) && !q('ai-result'),
    };

    // Slot: having run Analyze sentence, it stays in the slot (it is the recent AI action).
    const slotLabel = labelOf(q('ai-slot'));

    // Narrow window (320px): the row turns icon-only and still fits one row.
    const dictionaryBox = box(q('dictionary-result'));
    document.body.style.width = '320px';
    await sleep(300);
    const narrowButtons = [...row.querySelectorAll('button')];
    const narrowRow = {
        width: Math.round(row.getBoundingClientRect().width),
        labels: narrowButtons.map(labelOf),
        visibleText: narrowButtons.map((b) => b.innerText.trim()),
        rows: new Set(narrowButtons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
        overflowsRow: narrowButtons.some((b) => b.getBoundingClientRect().right > row.getBoundingClientRect().right + 1),
    };

    // Keys (nothing focused): Esc closes the expanded panel, then the other one, then hides the window.
    document.body.style.width = '420px';
    document.activeElement?.blur();
    const shown = () => ({
        dictionary: Boolean(q('dictionary-panel')),
        dictionaryCollapsed: Boolean(q('dictionary-panel-collapsed')),
        ai: Boolean(q('ai-result')),
        aiCollapsed: Boolean(q('ai-result-collapsed')),
    });
    const keys = {};
    await press('Escape');
    keys.escape1 = shown();
    await press('KeyD');
    await waitFor(() => q('dictionary-result'), 'dictionary opened with D');
    keys.afterD = shown();
    await press('Escape');
    keys.escape2 = shown();
    await press('Escape');
    keys.escape3 = shown();
    keys.hidesBefore = hides;
    await press('Escape');
    keys.hidesAfter = hides;
    keys.documentEscapes = documentEscapes;
    await press('KeyA');
    await waitFor(() => q('ai-output'), 'AI slot run with A');
    keys.afterA = shown();
    await press('Escape');

    // M opens More and moves the focus into it; Esc closes it again.
    await press('KeyM');
    keys.moreOpen = Boolean(q('selection-more'));
    keys.focusInMore = Boolean(q('selection-more')?.contains(document.activeElement));
    await press('Escape');
    keys.moreAfterEscape = Boolean(q('selection-more'));
    document.activeElement?.blur();

    // C copies the translation; Ctrl+C is left to the system.
    globalThis.__transkitClipboard = undefined;
    await press('KeyC', { ctrlKey: true });
    keys.clipboardAfterCtrlC = globalThis.__transkitClipboard ?? null;
    await press('KeyC');
    keys.clipboard = globalThis.__transkitClipboard ?? null;
    keys.copiedNotice = textOf(q('translation-copied'));

    // Typing in a text field never triggers a shortcut.
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    await press('KeyD', { target: field });
    await press('Escape', { target: field });
    keys.inFieldDictionary = Boolean(q('dictionary-panel'));
    keys.inFieldHides = hides;
    field.remove();

    // Tooltips name the keys.
    keys.titles = [...row.querySelectorAll('button')].map((b) => b.getAttribute('title'));

    // Alt+2 switches to the second favorite language.
    document.activeElement?.blur();
    await press('Digit2', { altKey: true, key: '2' });
    keys.targetAfterAlt2 = store.get(targetLanguageAtom);

    // A sentence focuses the AI slot and opens no dictionary.
    document.activeElement?.blur();
    store.set(sourceTextAtom, 'Resilience is the capacity to recover quickly from difficulties.');
    store.set(targetLanguageAtom, 'zh_cn');
    await sleep(400);
    keys.sentenceFocus = document.activeElement?.getAttribute('data-testid') ?? null;
    keys.sentenceDictionary = Boolean(q('dictionary-panel'));

    return {
        autoDictionary,
        keys,
        actionRow,
        walk,
        afterLeft,
        afterBoth,
        afterExpand,
        slotLabel,
        narrowRow,
        aiOutputBox,
        dictionaryBox,
        aiText,
        dictionarySource,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
}
