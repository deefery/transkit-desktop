// Loads the real production modules (JSX/TS included) in Node through Vite's SSR transform.
// Only the Tauri native boundary is aliased to tauriStub.js; nothing in the feature is mocked.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const stub = fileURLToPath(new URL('./tauriStub.js', import.meta.url));
const spinnerStub = fileURLToPath(new URL('./spinnerStub.js', import.meta.url));

export async function createProductionLoader() {
    const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, watch: null },
        optimizeDeps: { noDiscovery: true, include: [] },
        esbuild: { jsx: 'automatic' },
        resolve: {
            alias: [
                { find: /^@tauri-apps\/api(\/.*)?$/, replacement: stub },
                { find: /^tauri-plugin-.*$/, replacement: stub },
                // CJS spinner whose default export Node's ESM interop hands over as a wrapper object
                { find: /^react-spinners\/.*$/, replacement: spinnerStub },
            ],
        },
    });
    return {
        load: (path) => server.ssrLoadModule(path),
        close: () => server.close(),
    };
}
