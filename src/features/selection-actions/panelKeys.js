// Keyboard and smart-default rules of the selection panel (docs/fork/u0-selection-panel-design.md,
// sections 5 and 6). Pure functions only, so the rules are unit-tested without rendering.
import { classifyDictionaryInput, InputKind } from './dictionary/input.js';

// Whether a selected word or short phrase opens the dictionary by itself (default on).
export const AUTO_DICTIONARY_CONFIG_KEY = 'selection_panel_auto_dictionary';

/**
 * What the panel does by itself for a new selection, besides translating it:
 * a word or short phrase opens the dictionary (when enabled), a sentence puts the focus on the AI
 * slot. Nothing is spoken and no AI request is made automatically.
 */
export function planAutoActions({ text, autoDictionary = true } = {}) {
    const { kind } = classifyDictionaryInput(text);
    return {
        kind,
        dictionary: autoDictionary !== false && (kind === InputKind.WORD || kind === InputKind.PHRASE),
        focusAiSlot: kind === InputKind.TOO_LONG,
    };
}

export const PanelCommand = Object.freeze({
    SPEAK_ORIGINAL: 'speak-original',
    DICTIONARY: 'dictionary',
    AI_SLOT: 'ai-slot',
    MORE: 'more',
    COPY_TRANSLATION: 'copy-translation',
    FAVORITE_LANGUAGE: 'favorite-language',
    ESCAPE: 'escape',
});

// Single-letter keys, matched on the physical key so they work with any keyboard layout.
const LETTER_COMMANDS = Object.freeze({
    KeyS: PanelCommand.SPEAK_ORIGINAL,
    KeyD: PanelCommand.DICTIONARY,
    KeyA: PanelCommand.AI_SLOT,
    KeyM: PanelCommand.MORE,
    KeyC: PanelCommand.COPY_TRANSLATION,
});

// Shown in tooltips next to each action.
export const SHORTCUT_HINTS = Object.freeze({
    [PanelCommand.SPEAK_ORIGINAL]: 'S',
    [PanelCommand.DICTIONARY]: 'D',
    [PanelCommand.AI_SLOT]: 'A',
    [PanelCommand.MORE]: 'M',
    [PanelCommand.COPY_TRANSLATION]: 'C',
});

export const MAX_FAVORITE_SHORTCUTS = 4;

/**
 * The panel command for a keydown, or null to leave the key alone.
 * `event` needs { key, code, altKey, ctrlKey, metaKey, shiftKey, repeat, isComposing };
 * `targetHandlesKeys` is true when the focus is in a text field or an open menu/dialog, which keep
 * every key (typing, typeahead, their own Esc).
 */
export function keyCommandFor(event, { targetHandlesKeys = false } = {}) {
    if (!event || targetHandlesKeys) return null;
    // An input method is composing (e.g. Chinese/Japanese IME): the key belongs to it.
    if (event.isComposing || event.key === 'Process') return null;
    if (event.ctrlKey || event.metaKey) return null;
    if (event.altKey) {
        if (event.shiftKey) return null;
        const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code ?? '');
        const index = match ? Number(match[1]) - 1 : -1;
        return index >= 0 && index < MAX_FAVORITE_SHORTCUTS ? { type: PanelCommand.FAVORITE_LANGUAGE, index } : null;
    }
    if (event.key === 'Escape') return event.shiftKey ? null : { type: PanelCommand.ESCAPE };
    if (event.shiftKey || event.repeat) return null;
    const type = LETTER_COMMANDS[event.code];
    return type ? { type } : null;
}

const EDITABLE_SELECTOR =
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="menu"], [role="listbox"], [role="dialog"]';

/** Does the focused element take keys itself (text entry, open menu or dialog)? */
export function isKeyHandlingTarget(element) {
    if (!element || typeof element.closest !== 'function') return false;
    if (element.isContentEditable) return true;
    return element.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * What Esc closes, one thing per press: an open editor, then the More section, then the expanded
 * result panel (the newer one when both are open), then the other one; with nothing open it hides
 * the window. `expanded` is 'ai' | 'dictionary' | null.
 */
export function escapeTarget({
    editingFavorites = false,
    managingCustom = false,
    moreOpen = false,
    aiOpen = false,
    dictionaryOpen = false,
    expanded = null,
} = {}) {
    if (managingCustom) return 'custom-editor';
    if (editingFavorites) return 'favorites-editor';
    if (moreOpen) return 'more';
    if (aiOpen && dictionaryOpen) return expanded === 'dictionary' ? 'dictionary' : 'ai';
    if (aiOpen) return 'ai';
    if (dictionaryOpen) return 'dictionary';
    return 'window';
}

/** Tooltip text with the shortcut, e.g. "Dictionary (D)". */
export const withShortcut = (text, command) => (SHORTCUT_HINTS[command] ? `${text} (${SHORTCUT_HINTS[command]})` : text);
