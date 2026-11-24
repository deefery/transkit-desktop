// Performance baseline of a TransKit Desktop build on Windows (roadmap task V0).
//
// Measures, per run (fresh start of the app each time):
//   - startup: process start -> local HTTP server answers; -> daemon page loaded (WebView2 ready)
//   - idle memory 20 s after start: working set and private bytes, summed over the app process and
//     every child process (all WebView2 processes), plus the process count
//   - first pop-up: POST of a sentence to the local server -> the Translate window shows that text
//     (the window is created on first use; Rust shows it before the page has loaded, so "visible"
//     alone would not measure anything the user sees)
//   - repeat pop-up: Esc hides the window (the panel's own Esc path), then the next POST -> text shown
//   - memory again after the pop-ups (Translate window kept, hidden)
//
// Usage (Node 22, PowerShell available):
//   node scripts/fork/perf-baseline.mjs --exe <path to transkit.exe> --identifier <bundle identifier>
//        [--runs 5] [--port 60831] [--cdp 9339] [--idle 20] [--out result.json]
//
// Use a build with its own bundle identifier (a separate profile under %APPDATA%), so the installed
// app and its settings are never touched. The script seeds that profile's config on first use:
// its own server port, no update check, no clipboard monitor, translate window not closed on blur.
// The page is inspected through WebView2 remote debugging on --cdp (local only).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const args = Object.fromEntries(
    process.argv
        .slice(2)
        .reduce((pairs, value, i, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), [])
);
const EXE = args.exe;
const IDENTIFIER = args.identifier;
const RUNS = Number(args.runs ?? 5);
const PORT = Number(args.port ?? 60831);
const CDP = Number(args.cdp ?? 9339);
const IDLE_S = Number(args.idle ?? 20);
const REPEATS = 3;
if (!EXE || !existsSync(EXE) || !IDENTIFIER) {
    console.error('usage: node scripts/fork/perf-baseline.mjs --exe <transkit.exe> --identifier <bundle id> [--runs 5]');
    process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();

function seedProfile() {
    const dir = join(process.env.APPDATA, IDENTIFIER);
    const file = join(dir, 'config.json');
    const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    Object.assign(config, {
        server_port: PORT,
        check_update: false,
        clipboard_monitor: false,
        translate_close_on_blur: false,
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(config, null, 2));
}

const portOpen = () =>
    new Promise((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port: PORT });
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });

async function waitFor(check, timeoutMs, stepMs = 10) {
    const start = now();
    for (;;) {
        const value = await check().catch(() => null);
        if (value) return value;
        if (now() - start > timeoutMs) return null;
        await sleep(stepMs);
    }
}

// --- DevTools protocol (one short connection per evaluation keeps it simple and robust) ---
const targets = async () => (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).filter((t) => t.type === 'page');
async function evaluate(target, expression) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    const reply = await new Promise((resolve) => {
        ws.onmessage = (m) => resolve(JSON.parse(m.data));
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.close();
    return reply.result?.result?.value;
}
async function pressEscape(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    let id = 0;
    const send = (method, params) =>
        new Promise((resolve) => {
            id += 1;
            const mine = id;
            ws.onmessage = (m) => {
                const msg = JSON.parse(m.data);
                if (msg.id === mine) resolve(msg);
            };
            ws.send(JSON.stringify({ id: mine, method, params }));
        });
    const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    ws.close();
}
const LABEL = 'window.__TAURI_METADATA__?.__currentWindow?.label';
async function pageWithLabel(label) {
    for (const t of await targets()) {
        if ((await evaluate(t, LABEL).catch(() => null)) === label) return t;
    }
    return null;
}

// --- memory of the app's process tree ---
function treeMemory(rootPid) {
    const json = execFileSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    const all = JSON.parse(json);
    const children = new Map();
    for (const p of all) children.set(p.ParentProcessId, [...(children.get(p.ParentProcessId) ?? []), p]);
    const tree = [];
    const walk = (pid) => {
        for (const p of children.get(pid) ?? []) {
            tree.push(p);
            walk(p.ProcessId);
        }
    };
    const root = all.find((p) => p.ProcessId === rootPid);
    if (root) tree.push(root);
    walk(rootPid);
    const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
    return {
        processes: tree.length,
        webview2Processes: tree.filter((p) => /msedgewebview2/i.test(p.Name)).length,
        workingSetMB: mb(tree.reduce((sum, p) => sum + Number(p.WorkingSetSize ?? 0), 0)),
        privateMB: mb(tree.reduce((sum, p) => sum + Number(p.PrivatePageCount ?? 0), 0)),
    };
}

async function post(text) {
    await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: text });
}

// The Translate window has taken `text` in and rendered for it: the (hidden, in the selection
// window) source box holds the text and the selection panel is on screen. The translation itself
// depends on the provider's network round trip, so it is not part of this number.
const RENDERED = (text) =>
    `[...document.querySelectorAll('textarea')].some((t) => t.value.includes(${JSON.stringify(text)})) && ` +
    `Boolean(document.querySelector('[data-testid="selection-primary-actions"]'))`;
async function popUp(text, known) {
    const start = now();
    await post(text);
    let target = known;
    const shown = await waitFor(async () => {
        if (!target) target = await pageWithLabel('translate');
        if (!target) return null;
        return await evaluate(target, RENDERED(text));
    }, 30000, 15);
    return { ms: shown ? Math.round(now() - start) : null, target };
}

function killTree(pid) {
    try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_) {}
}

async function oneRun(run) {
    if (await portOpen()) throw new Error(`port ${PORT} is already in use: another instance is running`);
    const t0 = now();
    const child = spawn(EXE, [], {
        env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--disable-web-security --remote-debugging-port=${CDP}` },
        stdio: 'ignore',
        detached: false,
    });
    try {
        const server = await waitFor(portOpen, 30000);
        const serverMs = server ? Math.round(now() - t0) : null;
        const daemon = await waitFor(async () => {
            const page = (await targets()).find((t) => t.url.includes('daemon.html'));
            return page && (await evaluate(page, 'document.readyState')) === 'complete' ? page : null;
        }, 30000, 25);
        const daemonMs = daemon ? Math.round(now() - t0) : null;
        await sleep(Math.max(0, IDLE_S * 1000 - (now() - t0)));
        const idle = treeMemory(child.pid);

        const first = await popUp(`V0 baseline run ${run} first pop-up measures how fast the window shows this text.`, null);
        const repeats = [];
        let target = first.target;
        for (let i = 1; i <= REPEATS; i += 1) {
            await sleep(1500);
            if (target) await pressEscape(target);
            await sleep(1500);
            const next = await popUp(`V0 baseline run ${run} repeat ${i} shows a different sentence in the hidden window.`, target);
            target = next.target ?? target;
            repeats.push(next.ms);
        }
        await sleep(3000);
        const afterPopups = treeMemory(child.pid);
        return { run, serverMs, daemonMs, idle, firstPopupMs: first.ms, repeatPopupMs: repeats, afterPopups };
    } finally {
        killTree(child.pid);
        await waitFor(async () => !(await portOpen()), 10000, 100);
        await sleep(2000);
    }
}

const median = (values) => {
    const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
    if (v.length === 0) return null;
    return v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
};
const range = (values) => {
    const v = values.filter((x) => typeof x === 'number');
    return v.length ? `${Math.min(...v)}–${Math.max(...v)}` : 'n/a';
};

seedProfile();
const results = [];
for (let run = 1; run <= RUNS; run += 1) {
    const r = await oneRun(run);
    results.push(r);
    console.error(`run ${run}: ${JSON.stringify(r)}`);
}
const pick = (fn) => results.map(fn);
const summary = {
    runs: RUNS,
    serverReadyMs: { median: median(pick((r) => r.serverMs)), range: range(pick((r) => r.serverMs)) },
    daemonLoadedMs: { median: median(pick((r) => r.daemonMs)), range: range(pick((r) => r.daemonMs)) },
    idleWorkingSetMB: { median: median(pick((r) => r.idle.workingSetMB)), range: range(pick((r) => r.idle.workingSetMB)) },
    idlePrivateMB: { median: median(pick((r) => r.idle.privateMB)), range: range(pick((r) => r.idle.privateMB)) },
    idleProcesses: { median: median(pick((r) => r.idle.processes)), webview2: median(pick((r) => r.idle.webview2Processes)) },
    firstPopupMs: { median: median(pick((r) => r.firstPopupMs)), range: range(pick((r) => r.firstPopupMs)) },
    repeatPopupMs: { median: median(results.flatMap((r) => r.repeatPopupMs)), range: range(results.flatMap((r) => r.repeatPopupMs)) },
    afterPopupsWorkingSetMB: { median: median(pick((r) => r.afterPopups.workingSetMB)) },
    afterPopupsPrivateMB: { median: median(pick((r) => r.afterPopups.privateMB)) },
};
const output = { measuredAt: new Date().toISOString(), summary, results };
if (args.out) writeFileSync(args.out, JSON.stringify(output, null, 2));
console.log(JSON.stringify(summary, null, 2));
