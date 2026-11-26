// Runs in the browser: the real Welcome page (O1) in a memory router, with the config store stub
// seeded like a first run after the services were checked. No requests (autoTest off).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '/src/style.css';
import '/src/i18n/index.jsx';
import { store } from '/src/utils/store.js';
import Welcome from '/src/window/Config/pages/Welcome/index.jsx';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, what, ms = 15000) {
    const start = Date.now();
    for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
}

export async function run() {
    const { default: i18n } = await import('/src/i18n/index.jsx');
    await i18n.changeLanguage('en');
    document.getElementById('result').style.display = 'none';
    await store.set('onboarding_pending', true);
    await store.set('translate_service_list', ['bing', 'google']);
    await store.set('hotkey_selection_translate', 'Ctrl+Alt+Q');
    await store.set('service_health', {
        bing: { ok: false, at: Date.now() - 5000, kind: 'service', source: 'test' },
        google: { ok: true, at: Date.now() - 5000, ms: 640, source: 'test' },
    });

    createRoot(document.getElementById('root')).render(
        React.createElement(
            MemoryRouter,
            { initialEntries: ['/welcome'] },
            React.createElement(
                Routes,
                null,
                React.createElement(Route, { path: '/welcome', element: React.createElement(Welcome, { autoTest: false }) }),
                React.createElement(Route, { path: '/general', element: React.createElement('div', { 'data-testid': 'general' }, 'General') })
            )
        )
    );
    const q = (sel) => document.querySelector(sel);
    const services = () =>
        [...document.querySelectorAll('[data-testid="welcome-service"]')].map((row) => ({
            key: row.getAttribute('data-instance'),
            text: row.innerText.replace(/\s+/g, ' ').trim(),
        }));
    await waitFor(() => services().length === 2 && /OK/.test(services()[1].text), 'services with health');
    const out = {
        steps: [...document.querySelectorAll('[data-testid^="welcome-step-"]')].map((el) => el.getAttribute('data-testid')),
        heading: q('[data-testid="welcome"] h2')?.textContent,
        before: services(),
        shortcut: q('[data-testid="welcome-step-shortcut"]')?.innerText.replace(/\s+/g, ' ').trim(),
        shortcutState: q('[data-testid="welcome-shortcut-status"]')?.getAttribute('data-state'),
        appLanguage: q('[data-testid="welcome-app-language"]')?.textContent,
        targetLanguage: q('[data-testid="welcome-target-language"]')?.textContent,
    };

    // Use the recommended (working) service as primary.
    q('[data-testid="welcome-use-primary"]').click();
    await waitFor(() => services()[0]?.key === 'google', 'google first');
    await sleep(900); // useConfig writes to the store after a 500 ms debounce
    out.after = services();
    out.storedList = await store.get('translate_service_list');

    // Finish: the flag is cleared and Settings moves on to General.
    q('[data-testid="welcome-finish"]').click();
    await waitFor(() => q('[data-testid="general"]'), 'general page');
    await sleep(900);
    out.pendingAfterFinish = await store.get('onboarding_pending');
    return out;
}
