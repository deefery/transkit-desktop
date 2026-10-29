// Browser-run stand-in for `@tauri-apps/api/http`: the only boundary replaced when the real
// dictionary adapters run inside headless Edge. Requests go to the runner's /__proxy, which
// answers from fixtures or (live mode) performs the real HTTP request from Node.
export async function fetch(url, options = {}) {
    const response = await window.fetch(`/__proxy?url=${encodeURIComponent(url)}`, {
        method: 'POST',
        body: JSON.stringify({ method: options.method ?? 'GET', body: options.body ?? null }),
    });
    const answer = await response.json();
    if (answer.networkError) throw answer.networkError;
    return answer;
}
export const Body = { json: (value) => value };
export const ResponseType = { JSON: 1, Text: 2, Binary: 3 };
