// First-run guide (roadmap task O1): pure rules behind the Welcome page.

// Set by Rust on a true first run (empty config); cleared when the guide is finished or skipped.
export const ONBOARDING_CONFIG_KEY = 'onboarding_pending';
export const WELCOME_PATH = '/welcome';
// Rust reports how many characters the selection shortcut read (never the text).
export const SELECTION_READ_EVENT = 'selection_read';

// Interface languages, by their own names (same set as Settings -> General).
export const APP_LANGUAGES = Object.freeze({
    en: 'English',
    zh_cn: '简体中文',
    zh_tw: '繁體中文',
    ja: '日本語',
    ko: '한국어',
    vi: 'Tiếng Việt',
    fr: 'Français',
    es: 'Español',
    de: 'Deutsch',
    it: 'Italiano',
    ru: 'Русский',
    tr: 'Türkçe',
    pt_pt: 'Português',
    pt_br: 'Português (Brasil)',
    nb_no: 'Norsk Bokmål',
    nn_no: 'Norsk Nynorsk',
    fa: 'فارسی',
    uk: 'Українська',
    ar: 'العربية',
    he: 'עִבְרִית',
});

/** Should Settings open on the Welcome page now? */
export const shouldShowWelcome = (pending, pathname) => pending === true && pathname !== WELCOME_PATH;

/** The service to recommend as primary: the first, in the user's order, whose last check worked. */
export function recommendPrimary(keys, health) {
    return (keys ?? []).find((key) => health?.[key]?.ok === true) ?? null;
}

/** `list` with `key` moved to the front (unchanged when absent or already first). */
export function moveToFront(list, key) {
    const items = Array.isArray(list) ? list : [];
    if (!items.includes(key) || items[0] === key) return items;
    return [key, ...items.filter((item) => item !== key)];
}

/** What the last selection-shortcut report means for the user. */
export function selectionCheck(chars) {
    if (typeof chars !== 'number' || !Number.isFinite(chars)) return { state: 'waiting', chars: 0 };
    return chars > 0 ? { state: 'ok', chars } : { state: 'empty', chars: 0 };
}

/** Readable shortcut, e.g. "CommandOrControl+Alt+Q" -> "Ctrl + Alt + Q". */
export function formatShortcut(shortcut, isMac = false) {
    if (typeof shortcut !== 'string' || shortcut.trim() === '') return '';
    return shortcut
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => (/^(CommandOrControl|CmdOrCtrl)$/i.test(part) ? (isMac ? '⌘' : 'Ctrl') : part))
        .join(' + ');
}
