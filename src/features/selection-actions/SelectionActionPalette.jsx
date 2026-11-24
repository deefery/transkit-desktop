import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Tooltip } from '@nextui-org/react';
import { writeText } from '@tauri-apps/api/clipboard';
import { HiOutlineVolumeUp } from 'react-icons/hi';
import { LuSettings2 } from 'react-icons/lu';
import {
    MdArrowDownward,
    MdArrowUpward,
    MdAutoAwesome,
    MdChevronRight,
    MdClose,
    MdContentCopy,
    MdEditNote,
    MdMenuBook,
    MdMoreHoriz,
    MdTouchApp,
} from 'react-icons/md';
import { invoke } from '@tauri-apps/api/tauri';
import PulseLoader from 'react-spinners/PulseLoader';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';
import React, { useEffect, useRef, useState } from 'react';

import {
    DEFAULT_FAVORITE_LANGUAGES,
    addFavoriteLanguage,
    availableFavoriteCandidates,
    moveFavoriteLanguage,
    removeFavoriteLanguage,
} from './favorites';
import { CustomActionIcon } from './CustomActionIcon';
import { CustomActionsEditor } from './CustomActionsEditor';
import { CUSTOM_AI_ACTION_ID } from './customActions';
import { OutputKind } from './aiActions';
import { AiStatus } from './aiRunner';
import { ActionCode, messageFor } from './registry';
import { expandedPanel, pickAiSlotItem } from './panelLayout';
import { PanelCommand, escapeTarget, isKeyHandlingTarget, keyCommandFor, withShortcut } from './panelKeys';
import { DictionaryPanel } from './dictionary/DictionaryPanel';
import { DictionaryStatus } from './dictionary/controller';
import { useSelectionActions } from './useSelectionActions';

// Arrow keys move between the buttons of a toolbar (roving focus on top of normal Tab order). Bound in
// the capture phase: a Tooltip-wrapped button (react-aria) stops keydown propagation, which would
// otherwise stall arrow navigation at that button.
const arrowKeyHandler = (ref) => (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const buttons = [...(ref.current?.querySelectorAll('button:not([disabled])') ?? [])];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'ArrowRight' ? index + 1 : index - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
};

// "Set up AI" opens the Settings window (the user adds an AI service under Service -> AI).
const openSettingsWindow = () => invoke('open_config_window');
// Esc with nothing left to close hides the window, like Esc in the Translate window's text box.
// Imported lazily: the window module reads Tauri metadata as soon as it is loaded.
const hideCurrentWindow = () => import('@tauri-apps/api/window').then(({ appWindow }) => appWindow.hide());

const NO_DICTIONARY = Object.freeze({
    state: { status: DictionaryStatus.IDLE },
    sources: [],
    selectSource: () => {},
    dismiss: () => {},
});

// Compact action palette for the selection Translate window. Everything it shows comes from the
// action registry; only text nodes are rendered (no HTML from providers or config).
export function SelectionActionPaletteView({
    items,
    ctx,
    dictionary = NO_DICTIONARY,
    activeSpeech,
    notice,
    run,
    favoriteLanguages,
    updateFavorites,
    ai = null,
    custom = null,
    aiSlot = null,
    defaultMoreOpen = false,
    openSettings = openSettingsWindow,
    autoPlan = null,
    autoDictionary = null,
    hideWindow = hideCurrentWindow,
    copyText = writeText,
}) {
    const { t } = useTranslation();
    const toolbarRef = useRef(null);
    const moreToolbarRef = useRef(null);
    const aiToolbarRef = useRef(null);
    const customToolbarRef = useRef(null);
    const [editing, setEditing] = useState(false);
    const [managingCustom, setManagingCustom] = useState(false);
    const [moreOpen, setMoreOpen] = useState(defaultMoreOpen);
    const slotRef = useRef(null);
    const [copiedTranslation, setCopiedTranslation] = useState(false);

    const message = (code, fallback) =>
        t(`selection_actions.messages.${code}`, { defaultValue: fallback ?? messageFor(code) });
    const languageName = (language) => t(`languages.${language}`);

    const dictionaryItem = items.find((x) => x.group === 'dictionary');
    const speakOriginalItem = items.find((x) => x.actionId === 'speak_original');
    const speakTranslationItem = items.find((x) => x.actionId === 'speak_translation');
    const analysisItem = items.find((x) => x.actionId === 'sentence_analysis');
    const improveItems = items.filter((x) => x.actionId === 'improve_writing');
    const customItems = items.filter((x) => x.actionId === CUSTOM_AI_ACTION_ID);
    const slotItem = ai ? pickAiSlotItem(items, aiSlot ?? undefined) : null;
    const aiUnconfigured = Boolean(ai) && (ai.instances?.length ?? 0) === 0;
    const translation = ctx.translation;

    // Every AI action that runs becomes the slot's "recent" action.
    const runAi = (item) => {
        aiSlot?.remember?.(item.key);
        return run(item.actionId, item.params);
    };
    const aiLabel = (item) => {
        if (item.actionId === 'sentence_analysis') return t('selection_actions.sentence_analysis');
        if (item.actionId === 'improve_writing') return t(`selection_actions.improve_presets.${item.params.preset}`);
        return item.label;
    };

    // When both result panels are open, the one opened last is expanded and the other collapses to a
    // single line (docs/fork/u0-selection-panel-design.md, section 3).
    const dictionaryOpen = dictionary.state.status !== DictionaryStatus.IDLE;
    const aiRequestId = ai?.result ? (ai.result.requestId ?? 'ai') : null;
    const openCounter = useRef(0);
    const [opened, setOpened] = useState({});
    const [chosenPanel, setChosenPanel] = useState(null);
    useEffect(() => {
        setOpened((prev) => {
            const { dictionary: _dictionary, ...rest } = prev;
            return dictionaryOpen ? { ...rest, dictionary: prev.dictionary ?? ++openCounter.current } : rest;
        });
        if (dictionaryOpen) setChosenPanel(null);
    }, [dictionaryOpen]);
    useEffect(() => {
        setOpened((prev) => {
            const { ai: _ai, ...rest } = prev;
            return aiRequestId !== null ? { ...rest, ai: ++openCounter.current } : rest;
        });
        if (aiRequestId !== null) setChosenPanel(null);
    }, [aiRequestId]);
    const bothOpen = dictionaryOpen && aiRequestId !== null;
    const expanded = bothOpen ? expandedPanel(opened, chosenPanel) : null;
    const aiCollapsed = bothOpen && expanded === 'dictionary';
    const dictionaryCollapsed = bothOpen && expanded === 'ai';

    // Dictionary opens or closes (button and D key).
    const toggleDictionary = () => {
        if (dictionaryOpen) return dictionary.dismiss();
        if (dictionaryItem) return run(dictionaryItem.actionId, dictionaryItem.params);
    };
    // The AI slot: its action, or "Set up AI" when no AI service is configured (button and A key).
    const pressAiSlot = () => {
        if (aiUnconfigured) return openSettings();
        if (slotItem?.enabled) return runAi(slotItem);
    };
    const copyTranslation = async () => {
        if (!translation.speakable || translation.speakText === '') return;
        try {
            await copyText(translation.speakText);
            setCopiedTranslation(true);
        } catch (_) {
            setCopiedTranslation(false);
        }
    };
    useEffect(() => {
        setCopiedTranslation(false);
    }, [ctx.text, translation.speakText]);
    useEffect(() => {
        if (!copiedTranslation) return;
        const timer = setTimeout(() => setCopiedTranslation(false), 1500);
        return () => clearTimeout(timer);
    }, [copiedTranslation]);

    // Esc closes one thing per press (editor, More, the expanded result panel, ...), else hides.
    const escape = () => {
        switch (
            escapeTarget({
                editingFavorites: editing,
                managingCustom,
                moreOpen,
                aiOpen: aiRequestId !== null,
                dictionaryOpen,
                expanded,
            })
        ) {
            case 'custom-editor':
                return setManagingCustom(false);
            case 'favorites-editor':
                return setEditing(false);
            case 'more':
                return setMoreOpen(false);
            case 'ai':
                return ai?.dismiss();
            case 'dictionary':
                return dictionary.dismiss();
            default:
                return hideWindow();
        }
    };

    // Window-wide keys (section 6 of the U0 design). Not while typing in a field or using an open
    // menu. Capture phase: buttons wrapped in react-aria components stop keydown propagation. A key
    // the panel handles goes no further: App.jsx closes the whole window on any Esc that reaches the
    // document, which would skip the one-thing-per-press order.
    const commandsRef = useRef(null);
    commandsRef.current = (command) => {
        switch (command.type) {
            case PanelCommand.SPEAK_ORIGINAL:
                return speakOriginalItem?.enabled && run(speakOriginalItem.actionId, speakOriginalItem.params);
            case PanelCommand.DICTIONARY:
                return dictionaryItem?.enabled && toggleDictionary();
            case PanelCommand.AI_SLOT:
                return ai && pressAiSlot();
            case PanelCommand.MORE:
                return setMoreOpen((v) => !v);
            case PanelCommand.COPY_TRANSLATION:
                return copyTranslation();
            case PanelCommand.FAVORITE_LANGUAGE: {
                const item = items.filter((x) => x.actionId === 'translate')[command.index];
                return item?.enabled && run(item.actionId, item.params);
            }
            case PanelCommand.ESCAPE:
                return escape();
        }
    };
    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.defaultPrevented) return;
            const command = keyCommandFor(event, { targetHandlesKeys: isKeyHandlingTarget(event.target) });
            if (!command) return;
            event.preventDefault();
            event.stopPropagation();
            commandsRef.current(command);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);

    // Opening More (button or M) moves the focus into it, where the arrow keys and Enter work.
    const moreOpenedRef = useRef(moreOpen);
    useEffect(() => {
        if (moreOpen && !moreOpenedRef.current) {
            moreToolbarRef.current?.querySelector('button:not([disabled])')?.focus();
        }
        moreOpenedRef.current = moreOpen;
    }, [moreOpen]);

    // A sentence puts the focus on the AI slot (smart defaults), unless the user is already
    // somewhere else in the window.
    const focusSlot = autoPlan?.focusAiSlot === true;
    useEffect(() => {
        if (!focusSlot) return;
        const active = document.activeElement;
        if (active && active !== document.body) return;
        slotRef.current?.focus();
    }, [focusSlot, ctx.text]);

    // Action-row labels: always the accessible name and tooltip; the visible text is hidden by a
    // container query when the row is narrower than 340px (style.css, .sa-action-row).
    const label = (text) => <span className='sa-label'>{text}</span>;

    const speakButton = (item, kind) => {
        const speaking = activeSpeech?.kind === kind;
        const text = t(`selection_actions.${item.actionId}`);
        let title;
        if (!item.enabled) title = message(item.code, item.reason);
        else if (speaking) title = t('selection_actions.stop_speaking');
        else title = text;
        const shortcut = kind === 'original' ? PanelCommand.SPEAK_ORIGINAL : null;
        if (shortcut && item.enabled) title = withShortcut(title, shortcut);
        return (
            <Button
                key={item.key}
                size='sm'
                radius='sm'
                variant={speaking ? 'solid' : 'flat'}
                color={speaking ? 'primary' : 'default'}
                aria-pressed={speaking}
                aria-label={text}
                aria-keyshortcuts={shortcut ? 'S' : undefined}
                isDisabled={!item.enabled}
                title={title}
                className='h-[24px] min-w-0 px-2 text-[12px]'
                startContent={<HiOutlineVolumeUp className='text-[14px]' />}
                onPress={() => run(item.actionId, item.params)}
            >
                {speaking && activeSpeech.phase === 'pending' ? (
                    <PulseLoader
                        size={3}
                        color='currentColor'
                        speedMultiplier={0.8}
                    />
                ) : (
                    label(text)
                )}
            </Button>
        );
    };

    const titleFor = (item, text) => (item.enabled ? text : message(item.code, item.reason));

    return (
        <div
            className='flex flex-col gap-1 pb-1'
            data-testid='selection-action-palette'
        >
            {/* Action row: speak original, dictionary, AI slot, more. Always a single row. */}
            <div
                ref={toolbarRef}
                role='toolbar'
                aria-label={t('selection_actions.toolbar')}
                onKeyDownCapture={arrowKeyHandler(toolbarRef)}
                className='sa-action-row flex flex-nowrap items-center gap-1 overflow-hidden'
                data-testid='selection-primary-actions'
            >
                {speakOriginalItem && speakButton(speakOriginalItem, 'original')}
                {dictionaryItem && (
                    <Button
                        key={dictionaryItem.key}
                        size='sm'
                        radius='sm'
                        variant={dictionaryOpen ? 'solid' : 'flat'}
                        color={dictionaryOpen ? 'primary' : 'default'}
                        aria-pressed={dictionaryOpen}
                        aria-expanded={dictionaryOpen}
                        aria-label={t('selection_actions.dictionary')}
                        aria-keyshortcuts='D'
                        isDisabled={!dictionaryItem.enabled}
                        title={titleFor(dictionaryItem, withShortcut(t('selection_actions.dictionary'), PanelCommand.DICTIONARY))}
                        className='h-[24px] min-w-0 px-2 text-[12px]'
                        startContent={<MdMenuBook className='text-[14px]' />}
                        onPress={toggleDictionary}
                    >
                        {label(t('selection_actions.dictionary'))}
                    </Button>
                )}
                {aiUnconfigured && (
                    <Button
                        size='sm'
                        radius='sm'
                        variant='flat'
                        aria-label={t('selection_actions.ai.set_up')}
                        aria-keyshortcuts='A'
                        title={withShortcut(message(ActionCode.AI_NOT_CONFIGURED), PanelCommand.AI_SLOT)}
                        className='h-[24px] min-w-0 px-2 text-[12px]'
                        startContent={<MdAutoAwesome className='text-[14px]' />}
                        ref={slotRef}
                        onPress={() => openSettings()}
                        data-testid='ai-set-up'
                    >
                        {label(t('selection_actions.ai.set_up'))}
                    </Button>
                )}
                {!aiUnconfigured && slotItem && (
                    <Button
                        key={slotItem.key}
                        size='sm'
                        radius='sm'
                        variant={slotItem.active ? 'solid' : 'flat'}
                        color={slotItem.active ? 'primary' : 'default'}
                        aria-pressed={slotItem.active}
                        aria-label={aiLabel(slotItem)}
                        aria-keyshortcuts='A'
                        isDisabled={!slotItem.enabled}
                        title={titleFor(slotItem, withShortcut(aiLabel(slotItem), PanelCommand.AI_SLOT))}
                        ref={slotRef}
                        className='h-[24px] min-w-0 max-w-[140px] px-2 text-[12px]'
                        startContent={<MdAutoAwesome className='text-[14px]' />}
                        onPress={() => runAi(slotItem)}
                        data-testid='ai-slot'
                    >
                        <span className='sa-label truncate'>{aiLabel(slotItem)}</span>
                    </Button>
                )}
                <Button
                    size='sm'
                    radius='sm'
                    variant={moreOpen ? 'solid' : 'flat'}
                    aria-expanded={moreOpen}
                    aria-controls='selection-more'
                    aria-label={t('selection_actions.more')}
                    aria-keyshortcuts='M'
                    title={withShortcut(t('selection_actions.more'), PanelCommand.MORE)}
                    className='h-[24px] min-w-0 px-2 text-[12px]'
                    startContent={<MdMoreHoriz className='text-[14px]' />}
                    onPress={() => setMoreOpen((v) => !v)}
                    data-testid='selection-more-toggle'
                >
                    {label(t('selection_actions.more'))}
                </Button>
            </div>

            {/* More: everything else, grouped. Inline rather than a popover so it fits a narrow window. */}
            {moreOpen && (
                <div
                    id='selection-more'
                    className='flex flex-col gap-1 rounded-md border border-content3 p-1'
                    data-testid='selection-more'
                >
                    <div
                        ref={moreToolbarRef}
                        role='toolbar'
                        aria-label={t('selection_actions.more')}
                        onKeyDownCapture={arrowKeyHandler(moreToolbarRef)}
                        className='flex flex-wrap items-center gap-1'
                    >
                        {speakTranslationItem && speakButton(speakTranslationItem, 'translation')}
                        <Button
                            size='sm'
                            radius='sm'
                            variant={editing ? 'solid' : 'flat'}
                            aria-expanded={editing}
                            className='h-[24px] min-w-0 px-2 text-[12px]'
                            startContent={<LuSettings2 className='text-[14px]' />}
                            onPress={() => setEditing((v) => !v)}
                        >
                            {t('selection_actions.edit_favorites')}
                        </Button>
                        {autoDictionary && (
                            <Button
                                size='sm'
                                radius='sm'
                                variant={autoDictionary.enabled ? 'solid' : 'flat'}
                                color={autoDictionary.enabled ? 'primary' : 'default'}
                                aria-pressed={autoDictionary.enabled}
                                title={t('selection_actions.auto_dictionary_hint')}
                                className='h-[24px] min-w-0 px-2 text-[12px]'
                                startContent={<MdTouchApp className='text-[14px]' />}
                                onPress={() => autoDictionary.set(!autoDictionary.enabled)}
                                data-testid='auto-dictionary-toggle'
                            >
                                {t('selection_actions.auto_dictionary')}
                            </Button>
                        )}
                    </div>

                    {/* Without an AI service the slot offers "Set up AI"; no row of disabled AI buttons. */}
                    {ai && !aiUnconfigured && (analysisItem || improveItems.length > 0) && (
                        <div
                            ref={aiToolbarRef}
                            role='toolbar'
                            aria-label={t('selection_actions.ai.toolbar')}
                            onKeyDownCapture={arrowKeyHandler(aiToolbarRef)}
                            className='flex flex-wrap items-center gap-1'
                            data-testid='selection-ai-actions'
                        >
                            {analysisItem && (
                                <Button
                                    size='sm'
                                    radius='sm'
                                    variant={analysisItem.active ? 'solid' : 'flat'}
                                    color={analysisItem.active ? 'primary' : 'default'}
                                    aria-pressed={analysisItem.active}
                                    isDisabled={!analysisItem.enabled}
                                    title={analysisItem.enabled ? undefined : message(analysisItem.code, analysisItem.reason)}
                                    className='h-[24px] min-w-0 px-2 text-[12px]'
                                    onPress={() => runAi(analysisItem)}
                                >
                                    {t('selection_actions.sentence_analysis')}
                                </Button>
                            )}
                            <span
                                className='mx-0.5 h-[14px] w-px bg-default-300'
                                aria-hidden='true'
                            />
                            <span className='text-[11px] text-default-500'>{t('selection_actions.improve')}</span>
                            {improveItems.map((item) => (
                                <Button
                                    key={item.key}
                                    size='sm'
                                    radius='sm'
                                    variant={item.active ? 'solid' : 'flat'}
                                    color={item.active ? 'primary' : 'default'}
                                    aria-pressed={item.active}
                                    isDisabled={!item.enabled}
                                    title={item.enabled ? undefined : message(item.code, item.reason)}
                                    className='h-[24px] min-w-0 px-2 text-[12px]'
                                    onPress={() => runAi(item)}
                                >
                                    {t(`selection_actions.improve_presets.${item.params.preset}`)}
                                </Button>
                            ))}
                            <span
                                className='mx-0.5 h-[14px] w-px bg-default-300'
                                aria-hidden='true'
                            />
                            <AiServiceSelect ai={ai} />
                        </div>
                    )}

                    {custom && (
                        <div
                            ref={customToolbarRef}
                            role='toolbar'
                            aria-label={t('selection_actions.custom.toolbar')}
                            onKeyDownCapture={arrowKeyHandler(customToolbarRef)}
                            className='flex flex-wrap items-center gap-1'
                            data-testid='selection-custom-actions'
                        >
                            {customItems.map((item) => (
                                <Button
                                    key={item.key}
                                    size='sm'
                                    radius='sm'
                                    variant={item.active ? 'solid' : 'flat'}
                                    color={item.active ? 'primary' : 'default'}
                                    aria-pressed={item.active}
                                    isDisabled={!item.enabled}
                                    title={item.enabled ? undefined : message(item.code, item.reason)}
                                    className='h-[24px] min-w-0 max-w-[160px] px-2 text-[12px]'
                                    startContent={
                                        <CustomActionIcon icon={custom.actions.find((x) => x.id === item.params.customId)?.icon} />
                                    }
                                    onPress={() => runAi(item)}
                                >
                                    <span className='truncate'>{item.label}</span>
                                </Button>
                            ))}
                            <Tooltip content={t('selection_actions.custom.manage')}>
                                <Button
                                    isIconOnly
                                    size='sm'
                                    variant={managingCustom ? 'solid' : 'light'}
                                    aria-label={t('selection_actions.custom.manage')}
                                    aria-expanded={managingCustom}
                                    className='h-[24px] w-[24px] min-w-0'
                                    onPress={() => setManagingCustom((v) => !v)}
                                >
                                    <MdEditNote className='text-[16px]' />
                                </Button>
                            </Tooltip>
                        </div>
                    )}
                </div>
            )}

            {editing && (
                <FavoriteLanguagesEditor
                    favoriteLanguages={favoriteLanguages}
                    updateFavorites={updateFavorites}
                    languageName={languageName}
                />
            )}

            {custom && managingCustom && (
                <CustomActionsEditor
                    custom={custom}
                    instances={ai?.instances ?? []}
                />
            )}

            {ai && ctx.hasText && ai.status !== 'ready' && !aiUnconfigured && (
                <span
                    className='text-[11px] text-warning-600 break-words'
                    role='status'
                >
                    {message(ai.code)}
                </span>
            )}

            {ai?.result && aiCollapsed && (
                <CollapsedPanel
                    testId='ai-result-collapsed'
                    title={t('selection_actions.ai.result')}
                    detail={
                        ai.result.labelKey
                            ? t(ai.result.labelKey, { defaultValue: ai.result.defaultLabel })
                            : ai.result.defaultLabel
                    }
                    onExpand={() => setChosenPanel('ai')}
                />
            )}
            {ai?.result && !aiCollapsed && (
                <AiResultPanel
                    result={ai.result}
                    ai={ai}
                />
            )}

            {dictionaryCollapsed && (
                <CollapsedPanel
                    testId='dictionary-panel-collapsed'
                    title={t('selection_actions.dictionary')}
                    detail={dictionary.state.snapshot?.query ?? ''}
                    onExpand={() => setChosenPanel('dictionary')}
                />
            )}
            {!dictionaryCollapsed && (
                <DictionaryPanel
                    state={dictionary.state}
                    sources={dictionary.sources}
                    selectSource={dictionary.selectSource}
                    dismiss={dictionary.dismiss}
                    pronounce={() => run('speak_original')}
                    speaking={activeSpeech?.kind === 'original'}
                    speakingPending={activeSpeech?.kind === 'original' && activeSpeech.phase === 'pending'}
                />
            )}

            {copiedTranslation && (
                <span
                    className='text-[11px] text-default-500'
                    role='status'
                    data-testid='translation-copied'
                >
                    {t('selection_actions.copied_translation')}
                </span>
            )}

            {(translation.status === 'loading' || translation.status === 'error' || notice) && (
                <div
                    className='flex flex-col gap-0.5 text-[11px]'
                    role='status'
                    aria-live='polite'
                >
                    {translation.status === 'loading' && (
                        <span className='text-default-500'>{t('selection_actions.translating')}</span>
                    )}
                    {translation.status === 'error' && translation.error !== '' && (
                        <span
                            className='text-danger break-words line-clamp-2'
                            title={translation.error}
                        >
                            {message('translation-failed')} {translation.error}
                        </span>
                    )}
                    {notice && (
                        <span
                            className='text-danger break-words line-clamp-2'
                            title={notice.message}
                        >
                            {message(notice.code, notice.message)}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

// A result panel opened earlier, folded to one line; pressing it expands it again.
function CollapsedPanel({ testId, title, detail, onExpand }) {
    return (
        <button
            type='button'
            aria-expanded='false'
            onClick={onExpand}
            className='flex w-full items-center gap-1 rounded-md bg-content2 px-1.5 py-1 text-left text-[11px] text-default-500 hover:bg-content3'
            data-testid={testId}
        >
            <MdChevronRight
                className='text-[14px] shrink-0'
                aria-hidden='true'
            />
            <span className='font-medium text-default-600 shrink-0'>{title}</span>
            <span className='truncate'>{detail}</span>
        </button>
    );
}

// Choice of the existing AI service instance the AI actions run on (persisted by the hook).
function AiServiceSelect({ ai }) {
    const { t } = useTranslation();
    const current = ai.instances.find((instance) => instance.key === ai.instanceKey);
    return (
        <Dropdown>
            <DropdownTrigger>
                <Button
                    size='sm'
                    variant='bordered'
                    radius='sm'
                    aria-label={t('selection_actions.ai.service')}
                    title={t('selection_actions.ai.service')}
                    isDisabled={ai.instances.length === 0}
                    className='h-[24px] min-w-0 max-w-[160px] px-2 text-[12px]'
                >
                    <span className='truncate'>
                        {current ? current.label : t('selection_actions.ai.choose_service')}
                    </span>
                </Button>
            </DropdownTrigger>
            <DropdownMenu
                aria-label={t('selection_actions.ai.service')}
                className='max-h-[40vh] overflow-y-auto'
                selectionMode='single'
                disallowEmptySelection
                selectedKeys={ai.instanceKey ? [ai.instanceKey] : []}
                onAction={(key) => ai.select(String(key))}
            >
                {ai.instances.map((instance) => (
                    <DropdownItem key={instance.key}>{instance.label}</DropdownItem>
                ))}
            </DropdownMenu>
        </Dropdown>
    );
}

// Provider output is untrusted text: Markdown only through react-markdown (no raw HTML, which is
// shown as text), and no images (a network request) or links (navigation); everything else is a
// plain text node.
const MARKDOWN_COMPONENTS = {
    p: ({ children }) => <p className='my-0.5'>{children}</p>,
    ul: ({ children }) => <ul className='my-0.5 list-disc pl-4'>{children}</ul>,
    ol: ({ children }) => <ol className='my-0.5 list-decimal pl-4'>{children}</ol>,
    code: ({ children }) => <code className='rounded bg-default-100 px-0.5'>{children}</code>,
};
const MARKDOWN_DISALLOWED = ['img', 'a', 'iframe', 'script', 'style'];

// The AI result of the current selection, always labelled as AI output of a named service.
export function AiResultPanel({ result, ai }) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        setCopied(false);
    }, [result.requestId, result.status]);
    // A custom action's label is the user's own name: shown as is, never passed through i18n
    // interpolation.
    const label = result.labelKey ? t(result.labelKey, { defaultValue: result.defaultLabel }) : result.defaultLabel;
    // The result's own label comes from the instance config read at request time; until then
    // (loading) the label the palette already shows for that instance is used.
    const liveLabel = ai.instances?.find((instance) => instance.key === result.instanceKey)?.label;
    const name = result.instanceLabel !== result.serviceName ? result.instanceLabel : (liveLabel ?? result.instanceLabel);
    const origin = [name, result.model].filter((part) => part && part !== '').join(' · ');

    const copy = async () => {
        try {
            await writeText(result.output);
            setCopied(true);
        } catch (_) {
            setCopied(false);
        }
    };

    return (
        <section
            className='flex flex-col gap-1 rounded-md bg-content2 p-1.5 text-[12px]'
            aria-label={t('selection_actions.ai.result')}
            data-testid='ai-result'
        >
            <div className='flex items-center gap-1 text-[11px] text-default-500'>
                <span
                    className='rounded bg-default-200 px-1'
                    data-testid='ai-origin'
                >
                    {t('selection_actions.ai.generated_by')}
                </span>
                <span
                    className='flex-1 truncate'
                    title={origin}
                >
                    {origin}
                </span>
                <span className='truncate'>{label}</span>
                <Button
                    isIconOnly
                    size='sm'
                    variant='light'
                    className='h-[20px] w-[20px] min-w-0'
                    aria-label={t('selection_actions.ai.dismiss')}
                    onPress={() => ai.dismiss()}
                >
                    <MdClose />
                </Button>
            </div>
            <div
                role='status'
                aria-live='polite'
                className='select-text break-words'
            >
                {result.status === AiStatus.LOADING && (
                    <span className='flex items-center gap-1 text-default-500'>
                        {t('selection_actions.ai.running')}
                        <PulseLoader
                            size={3}
                            color='currentColor'
                            speedMultiplier={0.8}
                        />
                    </span>
                )}
                {result.status === AiStatus.ERROR && (
                    <div className='flex flex-col gap-1 text-danger'>
                        <span>
                            {t(`selection_actions.messages.${result.errorCode}`, {
                                defaultValue: messageFor(result.errorCode),
                            })}
                            {result.error !== '' && ` ${result.error}`}
                        </span>
                        <Button
                            size='sm'
                            variant='flat'
                            className='h-[22px] min-w-0 self-start px-2 text-[12px]'
                            onPress={() => ai.retry()}
                        >
                            {t('selection_actions.ai.retry')}
                        </Button>
                    </div>
                )}
                {result.status === AiStatus.SUCCESS &&
                    (result.outputKind === OutputKind.MARKDOWN ? (
                        <div
                            className='max-h-[220px] overflow-y-auto'
                            data-testid='ai-output'
                        >
                            <ReactMarkdown
                                components={MARKDOWN_COMPONENTS}
                                disallowedElements={MARKDOWN_DISALLOWED}
                                unwrapDisallowed
                            >
                                {result.output}
                            </ReactMarkdown>
                        </div>
                    ) : (
                        <div
                            className='max-h-[220px] overflow-y-auto whitespace-pre-wrap'
                            data-testid='ai-output'
                        >
                            {result.output}
                        </div>
                    ))}
            </div>
            {result.status === AiStatus.SUCCESS && (
                <Button
                    size='sm'
                    variant='flat'
                    className='h-[22px] min-w-0 self-start px-2 text-[12px]'
                    startContent={<MdContentCopy className='text-[12px]' />}
                    onPress={copy}
                >
                    {copied ? t('selection_actions.ai.copied') : t('selection_actions.ai.copy')}
                </Button>
            )}
        </section>
    );
}

function FavoriteLanguagesEditor({ favoriteLanguages, updateFavorites, languageName }) {
    const { t } = useTranslation();
    const candidates = availableFavoriteCandidates(favoriteLanguages);
    return (
        <div
            className='flex flex-col gap-1 rounded-md bg-content2 p-1.5'
            aria-label={t('selection_actions.edit_favorites')}
        >
            <ul className='flex flex-col gap-0.5'>
                {favoriteLanguages.map((language, index) => (
                    <li
                        key={language}
                        className='flex items-center gap-1'
                    >
                        <span className='flex-1 truncate text-[12px]'>{languageName(language)}</span>
                        <Button
                            isIconOnly
                            size='sm'
                            variant='light'
                            className='h-[22px] w-[22px] min-w-0'
                            aria-label={t('selection_actions.move_up')}
                            isDisabled={index === 0}
                            onPress={() => updateFavorites(moveFavoriteLanguage(favoriteLanguages, language, -1))}
                        >
                            <MdArrowUpward />
                        </Button>
                        <Button
                            isIconOnly
                            size='sm'
                            variant='light'
                            className='h-[22px] w-[22px] min-w-0'
                            aria-label={t('selection_actions.move_down')}
                            isDisabled={index === favoriteLanguages.length - 1}
                            onPress={() => updateFavorites(moveFavoriteLanguage(favoriteLanguages, language, 1))}
                        >
                            <MdArrowDownward />
                        </Button>
                        <Button
                            isIconOnly
                            size='sm'
                            variant='light'
                            className='h-[22px] w-[22px] min-w-0'
                            aria-label={t('selection_actions.remove')}
                            isDisabled={favoriteLanguages.length <= 1}
                            onPress={() => updateFavorites(removeFavoriteLanguage(favoriteLanguages, language))}
                        >
                            <MdClose />
                        </Button>
                    </li>
                ))}
            </ul>
            <div className='flex items-center gap-1'>
                <Dropdown>
                    <DropdownTrigger>
                        <Button
                            size='sm'
                            variant='flat'
                            className='h-[22px] min-w-0 px-2 text-[12px]'
                            isDisabled={candidates.length === 0}
                        >
                            {t('selection_actions.add_language')}
                        </Button>
                    </DropdownTrigger>
                    <DropdownMenu
                        aria-label={t('selection_actions.add_language')}
                        className='max-h-[40vh] overflow-y-auto'
                        onAction={(key) => updateFavorites(addFavoriteLanguage(favoriteLanguages, key))}
                    >
                        {candidates.map((language) => (
                            <DropdownItem key={language}>{languageName(language)}</DropdownItem>
                        ))}
                    </DropdownMenu>
                </Dropdown>
                <Button
                    size='sm'
                    variant='light'
                    className='h-[22px] min-w-0 px-2 text-[12px]'
                    onPress={() => updateFavorites([...DEFAULT_FAVORITE_LANGUAGES])}
                >
                    {t('selection_actions.reset')}
                </Button>
            </div>
        </div>
    );
}

// `defaultMoreOpen` starts with the More section expanded (used by tests that inspect its actions).
export default function SelectionActionPalette({ serviceInstanceConfigMap, defaultMoreOpen = false }) {
    const actions = useSelectionActions({ serviceInstanceConfigMap });
    // Only the existing selection Translate window gets the palette; input/image windows are untouched.
    if (!actions.ctx.isSelectionWindow) return null;
    return (
        <SelectionActionPaletteView
            {...actions}
            defaultMoreOpen={defaultMoreOpen}
        />
    );
}
