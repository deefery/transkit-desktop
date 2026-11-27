import { appCacheDir, appConfigDir, join } from "@tauri-apps/api/path";
import { readBinaryFile, readTextFile } from "@tauri-apps/api/fs";
import { invoke } from "@tauri-apps/api/tauri";
import Database from "tauri-plugin-sql-api";
import { http } from "@tauri-apps/api";
import CryptoJS from "crypto-js";
import { osType } from "./env";

export async function invoke_plugin(pluginType, pluginName) {
    let configDir = await appConfigDir();
    let cacheDir = await appCacheDir();
    let pluginDir = await join(configDir, "plugins", pluginType, pluginName);
    let entryFile = await join(pluginDir, "main.js");
    let script = await readTextFile(entryFile);
    async function run(cmdName, args) {
        return await invoke("run_binary", {
            pluginType,
            pluginName,
            cmdName,
            args
        });
    }
    const utils = {
        tauriFetch: http.fetch,
        http,
        readBinaryFile,
        readTextFile,
        Database,
        CryptoJS,
        run,
        cacheDir, // String
        pluginDir, // String
        osType,// "Windows_NT", "Darwin", "Linux"
    }
    // In release builds a plugin's bare `fetch` / `Body` resolve to Tauri's HTTP API, because the
    // bundle chunk holding this function imports them, so such plugins do not use the WebView
    // fetch. Pin that explicitly instead of relying on how the bundle is split. The plugin runs in
    // an inner function, so its own top-level `const fetch = ...` still works.
    const scoped = eval(`((fetch, Body) => (function () {
${script}
;return ${pluginType};
})())`);
    return [scoped(http.fetch, http.Body), utils];
}