// Runs in the browser: dynamically imports every window module (as App.jsx does) and reports the
// type of its default export, or the load error. Only the Tauri native API is replaced.
export async function run({ windows }) {
    document.getElementById('result').style.display = 'none';
    const out = {};
    for (const name of windows) {
        try {
            const mod = await import(`/src/window/${name}/index.jsx`);
            out[name] = typeof mod.default;
        } catch (error) {
            out[name] = `error: ${String(error?.message ?? error).slice(0, 200)}`;
        }
    }
    return out;
}
