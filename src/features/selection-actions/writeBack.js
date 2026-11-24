// Write back (roadmap task W1): paste an AI rewrite over the original selection in the app it was
// selected in. The native side (src-tauri/src/write_back.rs) only ever targets the window captured
// by the selection hotkey and refuses text that is not that selection; this module decides when to
// offer it and what to say afterwards.
import { OutputKind } from './aiActions.js';

export const WriteBackCode = Object.freeze({
    NO_SOURCE: 'no-source',
    SOURCE_CHANGED: 'source-changed',
    SOURCE_CLOSED: 'source-closed',
    FOCUS_FAILED: 'focus-failed',
    PASTE_FAILED: 'paste-failed',
    UNSUPPORTED: 'unsupported',
    CLIPBOARD_FAILED: 'clipboard-failed',
});

const KNOWN = new Set(Object.values(WriteBackCode));

/** Is `result` a finished plain-text rewrite (Improve presets, custom actions) of a selection? */
export function offersWriteBack(result) {
    return (
        Boolean(result) &&
        result.status === 'success' &&
        result.outputKind === OutputKind.TEXT &&
        typeof result.output === 'string' &&
        result.output.trim() !== '' &&
        typeof result.text === 'string' &&
        result.text.trim() !== ''
    );
}

/** The native commands, as { canReplace(original), replace(original, text) -> { ok, code? } }. */
export function createWriteBack({ invoke }) {
    return {
        canReplace: (original) =>
            Promise.resolve()
                .then(() => invoke('can_replace_selection', { original }))
                .then((value) => value === true)
                .catch(() => false),
        replace: (original, text) =>
            Promise.resolve()
                .then(() => invoke('replace_selection', { original, text }))
                .then(
                    () => ({ ok: true }),
                    (error) => ({
                        ok: false,
                        code: typeof error === 'string' && KNOWN.has(error) ? error : WriteBackCode.PASTE_FAILED,
                    })
                ),
    };
}

/** i18n key (under selection_actions.write_back) of the message for a replace outcome. */
export function writeBackMessage(outcome) {
    if (!outcome) return null;
    if (outcome.ok) return { key: 'done' };
    if (outcome.code === WriteBackCode.CLIPBOARD_FAILED) return { key: 'clipboard_failed' };
    return { key: 'copied_instead', reason: KNOWN.has(outcome.code) ? outcome.code : WriteBackCode.PASTE_FAILED };
}
