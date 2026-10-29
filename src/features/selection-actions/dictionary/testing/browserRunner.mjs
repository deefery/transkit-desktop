// Runs a production ES module inside headless Edge so code that needs a real DOM (the Cambridge
// parser's DOMParser, the React palette) executes for real. Node has no HTML parser in this
// repository and no dependency may be added. Returns null when no Edge/Chrome is installed so
// callers can skip honestly.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const srcDir = fileURLToPath(new URL('../../../../', import.meta.url));
const shim = fileURLToPath(new URL('./browserHttpShim.js', import.meta.url));
const tauriStub = fileURLToPath(new URL('../../testing/tauriStub.js', import.meta.url));

// Tauri native modules the app imports are replaced, in the browser only, by the in-memory test
// stub. ES modules need every imported name to exist, so a virtual module exports each name the
// source tree imports from the specifier: the stub's own export when it has one, else an async no-op.
const STUBBED = /^(@tauri-apps\/api(\/.*)?|tauri-plugin-[\w-]+)$/;
const VIRTUAL = '\0tauri-stub:';

function tauriStubPlugin() {
    const names = new Map();
    const importRe = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
    const scan = (dir) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) scan(path);
            else if (/\.(jsx?|tsx?|mjs)$/.test(entry)) {
                for (const [, clause, spec] of readFileSync(path, 'utf8').matchAll(importRe)) {
                    if (!STUBBED.test(spec)) continue;
                    const set = names.get(spec) ?? new Set();
                    names.set(spec, set);
                    const braces = /\{([^}]*)\}/.exec(clause);
                    for (const part of (braces?.[1] ?? '').split(',')) {
                        const name = part.trim().split(/\s+as\s+/)[0].trim();
                        if (name) set.add(name);
                    }
                    if (/^[\w$]+\s*(,|$)/.test(clause.trim())) set.add('default');
                }
            }
        }
    };
    scan(srcDir);
    return {
        name: 'tauri-stub',
        enforce: 'pre',
        resolveId(source) {
            return STUBBED.test(source) && source !== '@tauri-apps/api/http' ? VIRTUAL + source : null;
        },
        load(id) {
            if (!id.startsWith(VIRTUAL)) return null;
            const spec = id.slice(VIRTUAL.length);
            const lines = [`import * as base from ${JSON.stringify('/@fs/' + tauriStub.replaceAll('\\', '/'))};`];
            for (const name of names.get(spec) ?? []) {
                if (name === 'default') lines.push('export default base.default ?? {};');
                else lines.push(`export const ${name} = base.${name} ?? (async () => null);`);
            }
            return lines.join('\n');
        },
    };
}

const CANDIDATES = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

export const findBrowser = () => CANDIDATES.find((path) => existsSync(path)) ?? null;

// `node --test` runs test files in parallel processes; two Vite dev servers (shared dependency
// pre-bundle cache) plus two browsers at once make each other time out. Browser runs take
// turns through a directory lock, which also expires if a crashed run left it behind.
const LOCK = join(tmpdir(), 'transkit-dictionary-browser.lock');
const LOCK_STALE_MS = 10 * 60 * 1000;
async function acquireLock(timeoutMs) {
    const start = Date.now();
    for (;;) {
        try {
            mkdirSync(LOCK);
            return () => rmSync(LOCK, { recursive: true, force: true });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) rmSync(LOCK, { recursive: true, force: true });
            } catch (_) {}
            if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for another browser run');
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
}

const readBody = (req) =>
    new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const decodeEntities = (text) =>
    text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * @param module     root-relative module path exporting `run(args)` -> JSON-serializable
 * @param args       JSON arguments for run()
 * @param respond    (url, request) => { status, body } | null ; null falls through to `live`
 * @param live       perform real HTTP from Node for requests `respond` does not answer
 * @param stubTauri  also replace the rest of the Tauri native API (config store, events, fs) by the
 *                   in-memory test stub, so the real React components can mount
 * @param screenshot optional PNG path: the page is loaded once more and captured
 */
async function runUnlocked({
    module,
    args = {},
    respond = () => null,
    live = false,
    timeoutMs = 90000,
    stubTauri = false,
    screenshot = null,
    windowSize = '460,640',
}) {
    const browser = findBrowser();
    if (!browser) return null;
    const vite = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        appType: 'custom',
        plugins: stubTauri ? [tauriStubPlugin()] : [],
        server: { middlewareMode: true, hmr: false, watch: null, fs: { strict: false } },
        // The adapter's Config.jsx pulls CJS UI dependencies; let Vite pre-bundle them for the browser.
        optimizeDeps: { entries: [module] },
        esbuild: { jsx: 'automatic' },
        resolve: { alias: [{ find: /^@tauri-apps\/api\/http$/, replacement: shim }] },
    });
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/__run') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><meta charset="utf-8"><div id="root"></div><pre id="result">pending</pre>
<script type="module">
const out = document.getElementById('result');
try {
  const m = await import(${JSON.stringify('/' + module)});
  out.textContent = JSON.stringify({ ok: true, value: await m.run(${JSON.stringify(args)}) });
} catch (e) {
  out.textContent = JSON.stringify({ ok: false, error: String((e && e.stack) || e) });
}
</script>`);
            return;
        }
        if (url.pathname === '/__proxy') {
            const target = url.searchParams.get('url');
            const request = JSON.parse((await readBody(req)) || '{}');
            requests.push({ url: target, method: request.method });
            let answer = respond(target, request);
            if (!answer && live) {
                try {
                    const response = await fetch(target, {
                        method: request.method,
                        headers: { 'user-agent': USER_AGENT, 'content-type': 'application/json' },
                        body: request.body ? JSON.stringify(request.body) : undefined,
                        redirect: 'follow',
                    });
                    answer = { status: response.status, body: await response.text(), finalUrl: response.url };
                } catch (e) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ networkError: String(e) }));
                    return;
                }
            }
            if (!answer) answer = { status: 404, body: 'no fixture' };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    ok: answer.status >= 200 && answer.status < 300,
                    status: answer.status,
                    data: answer.body,
                    url: answer.finalUrl,
                })
            );
            return;
        }
        vite.middlewares(req, res, () => {
            res.writeHead(404);
            res.end();
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const profile = mkdtempSync(join(tmpdir(), 'dict-edge-'));
    const launch = (flags) =>
        new Promise((resolve, reject) => {
            const child = spawn(
                browser,
                [
                    '--headless=new',
                    '--disable-gpu',
                    '--no-first-run',
                    `--user-data-dir=${profile}`,
                    '--virtual-time-budget=60000',
                    ...flags,
                    `http://127.0.0.1:${port}/__run`,
                ],
                { stdio: ['ignore', 'pipe', 'ignore'] }
            );
            let out = '';
            child.stdout.on('data', (c) => (out += c));
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error('browser run timed out'));
            }, timeoutMs);
            child.on('close', () => {
                clearTimeout(timer);
                resolve(out);
            });
        });
    try {
        const dom = await launch(['--dump-dom']);
        if (screenshot) await launch([`--window-size=${windowSize}`, `--screenshot=${screenshot}`]);
        const match = /<pre id="result"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
        if (!match) throw new Error(`no result in browser DOM: ${dom.slice(0, 400)}`);
        const result = JSON.parse(decodeEntities(match[1]));
        if (!result.ok) throw new Error(`browser run failed: ${result.error}`);
        return { value: result.value, requests };
    } finally {
        server.close();
        await vite.close();
        try {
            rmSync(profile, { recursive: true, force: true });
        } catch (_) {}
    }
}

export async function runInBrowser(options) {
    if (!findBrowser()) return null;
    const release = await acquireLock(10 * 60 * 1000);
    try {
        return await runUnlocked(options);
    } finally {
        release();
    }
}
