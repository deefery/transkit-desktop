import React from 'react';
import {
    MdAutoAwesome,
    MdCode,
    MdEdit,
    MdFormatListBulleted,
    MdLightbulbOutline,
    MdMenuBook,
    MdMood,
    MdQuestionAnswer,
    MdSpellcheck,
    MdStarOutline,
    MdSummarize,
    MdTranslate,
} from 'react-icons/md';

// The bundled icons a custom action can choose from, by the identifiers in CUSTOM_ICON_IDS. A stored
// icon is only ever looked up here; anything unknown renders nothing.
export const CUSTOM_ICON_COMPONENTS = Object.freeze({
    sparkles: MdAutoAwesome,
    edit: MdEdit,
    translate: MdTranslate,
    summary: MdSummarize,
    idea: MdLightbulbOutline,
    spellcheck: MdSpellcheck,
    code: MdCode,
    question: MdQuestionAnswer,
    book: MdMenuBook,
    mood: MdMood,
    list: MdFormatListBulleted,
    star: MdStarOutline,
});

export function CustomActionIcon({ icon, className = 'text-[14px]' }) {
    const Icon =
        typeof icon === 'string' && Object.hasOwn(CUSTOM_ICON_COMPONENTS, icon) ? CUSTOM_ICON_COMPONENTS[icon] : null;
    return Icon ? (
        <Icon
            className={className}
            aria-hidden='true'
        />
    ) : null;
}
