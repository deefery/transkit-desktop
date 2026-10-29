// Test-only stand-in for the Tauri JS API / plugin packages, which need the native webview.
// Only the native boundary is replaced; every production module under test is the real one.
// Tests may install `globalThis.__transkitTestInvoke(cmd, args)` to answer native commands.
export const invoke = async (cmd, args) => (await globalThis.__transkitTestInvoke?.(cmd, args)) ?? null;
export const listen = async () => () => {};
export const emit = async () => {};
export const convertFileSrc = (x) => x;
export const appWindow = { label: 'translate', hide: async () => {}, show: async () => {}, setFocus: async () => {} };
// External HTTP boundary: the real service modules call this fetch with their real request;
// tests install `globalThis.__transkitTestHttp(url, options)` to play the remote endpoint.
export const fetch = async (url, options) => {
    if (typeof globalThis.__transkitTestHttp !== 'function') throw new Error('network is not available in tests');
    return globalThis.__transkitTestHttp(url, options);
};
export const Body = { json: (payload) => ({ type: 'Json', payload }) };
export const writeText = async (text) => {
    globalThis.__transkitClipboard = text;
};
export const BaseDirectory = {};
export const readTextFile = async () => {
    throw new Error('fs is not available in tests');
};
export class Store {
    constructor() {
        this.data = new Map();
    }
    async get(key) {
        return this.data.has(key) ? this.data.get(key) : null;
    }
    async set(key, value) {
        this.data.set(key, value);
    }
    async save() {}
    async load() {}
    async has(key) {
        return this.data.has(key);
    }
    async delete(key) {
        this.data.delete(key);
    }
}
export const info = () => {};
export const debug = () => {};
export const error = () => {};
export const warn = () => {};
export default { load: async () => ({ execute: async () => {}, select: async () => [], close: async () => {} }) };
