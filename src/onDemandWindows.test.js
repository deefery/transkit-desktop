// Run with: node --test src/onDemandWindows.test.js
// P2 guards: Live Interpreter and the Voice Anywhere windows are created on first use, with the
// properties they had in tauri.conf.json, and only the hotkey starts Voice Anywhere recording.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const conf = JSON.parse(read('../src-tauri/tauri.conf.json'));
const onDemand = read('../src-tauri/src/on_demand.rs');
const windowRs = read('../src-tauri/src/window.rs');
const mainRs = read('../src-tauri/src/main.rs');
const voiceRs = read('../src-tauri/src/voice_anywhere.rs');
const hook = read('./window/VoiceAnywhere/useVoiceAnywhere.js');

describe('windows created on demand', () => {
    test('only the daemon window is created at startup', () => {
        assert.deepEqual(conf.tauri.windows.map((w) => w.label), ['daemon']);
    });

    test('on_demand.rs builds the three windows with their former properties', () => {
        for (const prop of ['.transparent(true)', '.decorations(false)', '.always_on_top(true)', '.skip_taskbar(true)', '.visible(false)', '.focused(false)']) {
            assert.ok(onDemand.includes(prop), prop);
        }
        assert.match(onDemand, /MONITOR => builder\s+\.title\("Live Interpreter"\)\s+\.inner_size\(720\.0, 400\.0\)\s+\.min_inner_size\(400\.0, 60\.0\)/);
        assert.match(onDemand, /VOICE_ANYWHERE => builder\s+\.title\("Voice Input"\)\s+\.inner_size\(144\.0, 144\.0\)\s+\.min_inner_size\(120\.0, 120\.0\)\s+\.resizable\(false\)/);
        assert.match(onDemand, /VOICE_ANYWHERE_CAPTION => builder\s+\.title\("Voice Input Caption"\)\s+\.inner_size\(380\.0, 92\.0\)\s+\.min_inner_size\(280\.0, 64\.0\)\s+\.resizable\(false\)/);
    });

    test('every place that needs one of these windows creates it on demand', () => {
        assert.match(windowRs, /on_demand::window\(crate::on_demand::MONITOR\)/);
        assert.match(windowRs, /on_demand::window\(crate::on_demand::VOICE_ANYWHERE\)/);
        assert.match(voiceRs, /on_demand::window\(crate::on_demand::VOICE_ANYWHERE_CAPTION\)/);
        assert.doesNotMatch(windowRs, /get_window\("monitor"\)/);
        // Hiding never creates: the only direct lookup left is in the hide command.
        assert.equal(windowRs.split('get_window("voice_anywhere")').length - 1, 1);
        const hide = windowRs.slice(windowRs.indexOf('pub fn hide_voice_anywhere_window()'));
        assert.ok(hide.indexOf('get_window("voice_anywhere")') > 0 && hide.indexOf('get_window("voice_anywhere")') < 200);
        assert.doesNotMatch(voiceRs, /\.get_window\("voice_anywhere_caption"\)\s*\n\s*\.ok_or_else/);
    });

    test('commands that may create a window are async (a sync command cannot load a new page on Windows)', () => {
        assert.match(windowRs, /#\[tauri::command\(async\)\]\npub fn show_voice_anywhere_window\(\)/);
        assert.match(voiceRs, /#\[tauri::command\(async\)\]\npub fn show_voice_anywhere_caption\(/);
    });

    test('only the hotkey sends the recording trigger; a new page gets it once it is ready', () => {
        assert.match(windowRs, /pub fn voice_anywhere_window\(\) \{\n\s+show_voice_anywhere\(true\);/);
        assert.match(windowRs, /pub fn voice_anywhere_window_show_only\(\) \{\n\s+show_voice_anywhere\(false\);/);
        assert.match(windowRs, /pub fn show_voice_anywhere_window\(\) \{\n\s+voice_anywhere_window_show_only\(\);/);
        assert.match(mainRs, /voice_anywhere_always_visible[\s\S]{0,200}window::voice_anywhere_window_show_only\(\);/);
        assert.match(windowRs, /window\.once\("voice_anywhere_ready"/);
        assert.match(hook, /emit\('voice_anywhere_ready'\)/);
        // The ready event is sent from the trigger listener, which embedded (no-trigger) mode skips.
        const effect = hook.slice(hook.indexOf("if (noTriggerRef.current) return;"));
        assert.ok(effect.indexOf("emit('voice_anywhere_ready')") > 0);
        assert.ok(effect.indexOf("emit('voice_anywhere_ready')") < effect.indexOf('return () => {'));
    });
});
