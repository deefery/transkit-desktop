// Runs in the browser: the real useProviderFallback hook and ProviderNotice (real atoms, config
// store stub, i18n) in a small harness that shows one provider at a time like the Translate window.
// Translation outcomes are published into the real translation records atom, the way TargetArea
// publishes them. Only the Tauri native API is replaced.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import '/src/style.css';
import '/src/i18n/index.jsx';
import { sourceTextAtom } from '/src/window/Translate/components/SourceArea/index.jsx';
import { sourceLanguageAtom, targetLanguageAtom } from '/src/window/Translate/components/LanguageArea/index.jsx';
import { translationRecordsAtom } from '/src/features/selection-actions/translationRecords.js';
import { useProviderFallback } from '/src/window/Translate/useProviderFallback.js';
import ProviderNotice from '/src/window/Translate/components/ProviderNotice.jsx';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LIST = ['bing', 'google', 'deepl'];

export async function run() {
    const { default: i18n } = await import('/src/i18n/index.jsx');
    await i18n.changeLanguage('en');
    document.getElementById('result').style.display = 'none';

    const store = createStore();
    store.set(sourceLanguageAtom, 'auto');
    store.set(targetLanguageAtom, 'zh_cn');
    store.set(sourceTextAtom, 'hello');
    let api = null;
    let settingsOpened = 0;

    function Harness() {
        const [index, setIndex] = useState(0);
        api = useProviderFallback({ list: LIST, configMap: {}, selectedIndex: index, setSelectedIndex: setIndex });
        return React.createElement(
            'div',
            null,
            React.createElement('span', { 'data-testid': 'active' }, LIST[index]),
            React.createElement(ProviderNotice, {
                notice: api.notice,
                configMap: {},
                pluginList: {},
                tryProvider: api.tryProvider,
                openConfig: () => {
                    settingsOpened += 1;
                },
            })
        );
    }
    createRoot(document.getElementById('root')).render(
        React.createElement(Provider, { store }, React.createElement(Harness))
    );

    let requestId = 0;
    const publish = async (key, status, error = '') => {
        requestId += 1;
        store.set(translationRecordsAtom, (records) => ({
            ...records,
            [key]: {
                requestId,
                instanceKey: key,
                text: store.get(sourceTextAtom).trim(),
                sourceLanguage: store.get(sourceLanguageAtom),
                targetLanguage: store.get(targetLanguageAtom),
                effectiveTargetLanguage: store.get(targetLanguageAtom),
                detectLanguage: 'en',
                status,
                speakText: status === 'success' ? '你好' : '',
                error,
            },
        }));
        await sleep(150);
    };
    const q = (id) => document.querySelector(`[data-testid="${id}"]`);
    const snap = () => {
        const notice = q('provider-notice');
        return {
            active: q('active').textContent,
            type: notice?.getAttribute('data-type') ?? null,
            kind: notice?.getAttribute('data-kind') ?? null,
            text: notice ? notice.innerText.replace(/\s+/g, ' ').trim() : null,
        };
    };
    await sleep(300);
    const out = { start: snap() };

    // Bing fails: Google is shown, with the reason.
    await publish('bing', 'error', 'Get Token Failed');
    out.afterBing = snap();
    // Google is rate limited: DeepL next.
    await publish('google', 'error', 'Http Request Error\nHttp Status: 429');
    out.afterGoogle = snap();
    // DeepL fails too: nothing left, guidance without a Try button.
    await publish('deepl', 'error', 'error sending request: dns error');
    out.allFailed = { ...snap(), tryButton: Boolean(q('provider-try-next')) };

    // New selection: DeepL (shown) is cooling down, so are the others: it stays.
    store.set(sourceTextAtom, 'world');
    await sleep(200);
    out.newRequestAllCooling = snap();

    // Picked by hand: a failure is not switched away from; "Try Bing" is offered instead.
    api.chooseProvider(LIST.indexOf('google'));
    await sleep(100);
    out.manualPick = snap();
    await publish('google', 'error', 'Invalid API key');
    out.manualFailure = {
        ...snap(),
        tryText: q('provider-try-next')?.innerText.trim() ?? null,
        settingsButton: [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Open Settings'),
    };
    [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Open Settings')?.click();
    await sleep(50);
    out.settingsOpened = settingsOpened;
    q('provider-try-next')?.click();
    await sleep(150);
    out.afterTry = snap();
    await publish('bing', 'success');
    out.afterTrySuccess = snap();

    // Next selection while DeepL (still cooling down) is the chosen one: Bing (it just worked) is
    // shown instead, and the notice says why.
    api.chooseProvider(LIST.indexOf('deepl'));
    await sleep(100);
    store.set(sourceTextAtom, 'again');
    await sleep(200);
    out.cooling = snap();

    return out;
}
