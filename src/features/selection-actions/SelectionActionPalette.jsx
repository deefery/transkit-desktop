import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Tooltip } from '@nextui-org/react';
import { writeText } from '@tauri-apps/api/clipboard';
import { HiOutlineVolumeUp } from 'react-icons/hi';
import { LuSettings2 } from 'react-icons/lu';
import { MdArrowDownward, MdArrowUpward, MdClose, MdContentCopy, MdEditNote, MdMenuBook } from 'react-icons/md';
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
import { messageFor } from './registry';
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
}) {
    const { t } = useTranslation();
    const toolbarRef = useRef(null);
    const aiToolbarRef = useRef(null);
    const customToolbarRef = useRef(null);
    const [editing, setEditing] = useState(false);
    const [managingCustom, setManagingCustom] = useState(false);

    const message = (code, fallback) =>
        t(`selection_actions.messages.${code}`, { defaultValue: fallback ?? messageFor(code) });
    const languageName = (language) => t(`languages.${language}`);

    const onKeyDown = arrowKeyHandler(toolbarRef);

    const translateItems = items.filter((x) => x.group === 'translate');
    const dictionaryItems = items.filter((x) => x.group === 'dictionary');
    const speakItems = items.filter((x) => x.group === 'speak');
    const analysisItem = items.find((x) => x.actionId === 'sentence_analysis');
    const improveItems = items.filter((x) => x.actionId === 'improve_writing');
    const customItems = items.filter((x) => x.actionId === CUSTOM_AI_ACTION_ID);
    const translation = ctx.translation;

    return (
        <div
            className='flex flex-col gap-1 pb-1'
            data-testid='selection-action-palette'
        >
            <div
                ref={toolbarRef}
                role='toolbar'
                aria-label={t('selection_actions.toolbar')}
                onKeyDownCapture={onKeyDown}
                className='flex flex-wrap items-center gap-1'
            >
                {translateItems.map((item) => (
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
                        onPress={() => run(item.actionId, item.params)}
                    >
                        {languageName(item.params.language)}
                    </Button>
                ))}
                <Tooltip content={t('selection_actions.edit_favorites')}>
                    <Button
                        isIconOnly
                        size='sm'
                        variant={editing ? 'solid' : 'light'}
                        aria-label={t('selection_actions.edit_favorites')}
                        aria-expanded={editing}
                        className='h-[24px] w-[24px] min-w-0'
                        onPress={() => setEditing((v) => !v)}
                    >
                        <LuSettings2 className='text-[14px]' />
                    </Button>
                </Tooltip>
                <span
                    className='mx-0.5 h-[14px] w-px bg-default-300'
                    aria-hidden='true'
                />
                {dictionaryItems.map((item) => {
                    const open = dictionary.state.status !== DictionaryStatus.IDLE;
                    return (
                        <Button
                            key={item.key}
                            size='sm'
                            radius='sm'
                            variant={open ? 'solid' : 'flat'}
                            color={open ? 'primary' : 'default'}
                            aria-pressed={open}
                            aria-expanded={open}
                            isDisabled={!item.enabled}
                            title={item.enabled ? undefined : message(item.code, item.reason)}
                            className='h-[24px] min-w-0 px-2 text-[12px]'
                            startContent={<MdMenuBook className='text-[14px]' />}
                            onPress={() => run(item.actionId, item.params)}
                        >
                            {t('selection_actions.dictionary')}
                        </Button>
                    );
                })}
                {speakItems.map((item) => {
                    const kind = item.actionId === 'speak_original' ? 'original' : 'translation';
                    const speaking = activeSpeech?.kind === kind;
                    const label = t(`selection_actions.${item.actionId}`);
                    return (
                        <Button
                            key={item.key}
                            size='sm'
                            radius='sm'
                            variant={speaking ? 'solid' : 'flat'}
                            color={speaking ? 'secondary' : 'default'}
                            aria-pressed={speaking}
                            isDisabled={!item.enabled}
                            title={
                                item.enabled
                                    ? speaking
                                        ? t('selection_actions.stop_speaking')
                                        : undefined
                                    : message(item.code, item.reason)
                            }
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
                                label
                            )}
                        </Button>
                    );
                })}
            </div>

            {ai && (analysisItem || improveItems.length > 0) && (
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
                            onPress={() => run(analysisItem.actionId, analysisItem.params)}
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
                            onPress={() => run(item.actionId, item.params)}
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
                            onPress={() => run(item.actionId, item.params)}
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

            {custom && managingCustom && (
                <CustomActionsEditor
                    custom={custom}
                    instances={ai?.instances ?? []}
                />
            )}

            {ai && ctx.hasText && ai.status !== 'ready' && (
                <span
                    className='text-[11px] text-warning-600 break-words'
                    role='status'
                >
                    {message(ai.code)}
                </span>
            )}

            {ai?.result && (
                <AiResultPanel
                    result={ai.result}
                    ai={ai}
                />
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

            <DictionaryPanel
                state={dictionary.state}
                sources={dictionary.sources}
                selectSource={dictionary.selectSource}
                dismiss={dictionary.dismiss}
                pronounce={() => run('speak_original')}
                speaking={activeSpeech?.kind === 'original'}
                speakingPending={activeSpeech?.kind === 'original' && activeSpeech.phase === 'pending'}
            />

            {editing && (
                <FavoriteLanguagesEditor
                    favoriteLanguages={favoriteLanguages}
                    updateFavorites={updateFavorites}
                    languageName={languageName}
                />
            )}
        </div>
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

export default function SelectionActionPalette({ serviceInstanceConfigMap }) {
    const actions = useSelectionActions({ serviceInstanceConfigMap });
    // Only the existing selection Translate window gets the palette; input/image windows are untouched.
    if (!actions.ctx.isSelectionWindow) return null;
    return <SelectionActionPaletteView {...actions} />;
}
