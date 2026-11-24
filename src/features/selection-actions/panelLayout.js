// Layout rules of the result-first selection panel (docs/fork/u0-selection-panel-design.md).
// Pure functions only, so the rules are unit-tested without rendering.
import { AiActionId } from './aiActions.js';
import { CUSTOM_AI_ACTION_ID } from './customActions.js';

// 'recent' (default) or the key of one AI action item to pin in the slot.
export const AI_SLOT_CONFIG_KEY = 'selection_panel_ai_slot';
// Key of the AI action item run most recently (written whenever an AI action runs).
export const AI_RECENT_CONFIG_KEY = 'selection_panel_ai_recent';
export const AI_SLOT_RECENT = 'recent';

const AI_ACTION_IDS = new Set([AiActionId.SENTENCE_ANALYSIS, AiActionId.IMPROVE_WRITING, CUSTOM_AI_ACTION_ID]);

export const isAiItem = (item) => Boolean(item) && AI_ACTION_IDS.has(item.actionId);

/**
 * The AI action shown in the action row's slot: the pinned one when set, else the most recently
 * run one, else Sentence Analysis, else the first AI action. A stored key that no longer matches an
 * item (e.g. a deleted custom action) falls through to the defaults. Null when there are none.
 */
export function pickAiSlotItem(items, { setting = AI_SLOT_RECENT, recentKey = '' } = {}) {
    const aiItems = (items ?? []).filter(isAiItem);
    const wanted = setting && setting !== AI_SLOT_RECENT ? setting : recentKey;
    return (
        aiItems.find((item) => item.key === wanted) ??
        aiItems.find((item) => item.actionId === AiActionId.SENTENCE_ANALYSIS) ??
        aiItems[0] ??
        null
    );
}

/**
 * Which result panel is expanded when both are open: the one opened most recently. `opened` maps
 * each open panel ('ai' | 'dictionary') to the order it was opened in (higher = newer); closed panels
 * are absent. An explicit choice (the user expanding a collapsed panel) wins.
 */
export function expandedPanel(opened, chosen = null) {
    const open = Object.entries(opened ?? {}).filter(([, order]) => typeof order === 'number');
    if (open.length === 0) return null;
    if (chosen && open.some(([name]) => name === chosen)) return chosen;
    return open.reduce((newest, entry) => (entry[1] > newest[1] ? entry : newest))[0];
}
