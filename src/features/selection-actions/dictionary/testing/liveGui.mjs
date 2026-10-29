// Opt-in: the rendered palette in headless Edge against the LIVE Cambridge site, with a PNG capture.
//   node src/features/selection-actions/dictionary/testing/liveGui.mjs <out.json> <out.png>
// Browser evidence only (React tree + real parser + real network); not a native Tauri window.
import { writeFileSync } from 'node:fs';
import { runInBrowser } from './browserRunner.mjs';

const [out, png] = process.argv.slice(2);
const run = await runInBrowser({
    module: 'src/features/selection-actions/dictionary/testing/guiCases.js',
    stubTauri: true,
    live: true,
    screenshot: png,
    windowSize: '460,720',
    timeoutMs: 240000,
    args: { steps: [{ text: 'resilience' }, { text: 'break the ice' }, { text: 'take off' }], keepOpen: true },
});
const summary = {
    date: new Date().toISOString(),
    method: 'real SelectionActionPalette React tree in headless Edge; Tauri native API stubbed; live HTTP to dictionary.cambridge.org; public sample text',
    requests: run.requests.map((r) => r.url),
    steps: run.value.log.map(({ text, panel, source, hasResult, errorCode, hasPronounce, scriptElementsInPanel }) => ({
        text,
        source,
        hasResult,
        errorCode,
        hasPronounce,
        scriptElementsInPanel,
        panel,
    })),
    screenshot: png ? 'final state of the third step (take off)' : null,
};
if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2).slice(0, 3000));
