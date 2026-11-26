// Runs in the browser: the real ServiceHealth rows and Test all button for two instances of the
// built-in Lingva translate service, with its real request code. The HTTP transport is answered by
// the test runner (fixtures) and the Tauri native API is the in-memory stub.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/style.css';
import '/src/i18n/index.jsx';
import { store } from '/src/utils/store.js';
import ServiceHealth, { TestAllButton } from '/src/window/Config/pages/Service/ServiceHealth.jsx';

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

const KEYS = ['lingva', 'lingva@second'];

export async function run() {
    const { default: i18n } = await import('/src/i18n/index.jsx');
    await i18n.changeLanguage('en');
    document.getElementById('result').style.display = 'none';
    // A failure seen while translating, two minutes ago.
    await store.set('service_health', { 'lingva@second': { ok: false, at: Date.now() - 120000, kind: 'service', source: 'use' } });

    createRoot(document.getElementById('root')).render(
        React.createElement(
            'div',
            null,
            ...KEYS.map((key) => React.createElement(ServiceHealth, { key, kind: 'translate', instanceKey: key, pluginList: {} })),
            React.createElement(TestAllButton, { kind: 'translate', instanceKeys: KEYS, pluginList: {} })
        )
    );
    const row = (key) => document.querySelector(`[data-testid="service-health"][data-instance="${key}"]`);
    const snap = () =>
        Object.fromEntries(
            KEYS.map((key) => [
                key,
                {
                    state: row(key)?.getAttribute('data-state'),
                    summary: row(key)?.querySelector('[data-testid="service-health-summary"]')?.textContent ?? null,
                },
            ])
        );
    await waitFor(() => row('lingva') && row('lingva@second'), 'rows');
    await sleep(300);
    const out = { initial: snap() };

    // Test one: the request succeeds.
    row('lingva').querySelector('[data-testid="service-health-test"]').click();
    await waitFor(() => row('lingva').getAttribute('data-state') === 'ok', 'lingva ok');
    out.afterTest = snap();

    // Test all: the first instance succeeds, the second is rate limited.
    document.querySelector('[data-testid="service-health-test-all"]').click();
    await waitFor(() => row('lingva@second').getAttribute('data-state') === 'failed' &&
        /429/.test(row('lingva@second').textContent), 'second rate limited');
    await sleep(200);
    out.afterTestAll = snap();
    out.stored = await store.get('service_health');
    return out;
}
