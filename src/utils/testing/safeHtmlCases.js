// Runs in the browser (real DOMParser): renders each fragment through the production sanitizer and
// reports the markup plus whether any injected script or handler ran while parsing/rendering.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { safeHtmlToReact } from '/src/utils/safe_html.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// Fragments arrive URI-encoded: the runner inlines args into a <script>, which a literal
// "</script>" in a fragment would close.
export async function run({ encodedFragments }) {
    window.__xss = 0;
    const out = {};
    for (const fragment of encodedFragments.map(decodeURIComponent)) {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        root.render(React.createElement('span', null, ...safeHtmlToReact(fragment)));
        await tick(20);
        out[fragment] = host.innerHTML;
        root.unmount();
        host.remove();
    }
    // Give any image error handler or deferred script a chance to fire before reporting.
    await tick(300);
    const xss = window.__xss;

    // Control: the previous rendering (raw innerHTML) of one payload must trip the detector,
    // proving that a zero count above is meaningful.
    window.__xss = 0;
    const control = document.createElement('span');
    document.body.appendChild(control);
    control.innerHTML = '<img src="x" onerror="window.__xss++">';
    await tick(300);
    control.remove();
    return { rendered: out, xss, controlXss: window.__xss };
}
