import { Button } from '@nextui-org/react';
import { HiOutlineVolumeUp } from 'react-icons/hi';
import { MdClose } from 'react-icons/md';
import PulseLoader from 'react-spinners/PulseLoader';
import { useTranslation } from 'react-i18next';
import React from 'react';

import { getServiceName } from '../../../utils/service_instance';
import { DictionaryErrorCode } from './result';
import { DictionaryStatus } from './controller';

const REGION_LABEL = { uk: 'UK', us: 'US' };

// Compact, source-attributed dictionary result. Everything shown is a plain string from the
// normalized result (React text nodes only - no HTML from a provider is ever injected), and a
// field is rendered only when the source supplied it.
export function DictionaryPanel({ state, sources, selectSource, dismiss, pronounce, speaking, speakingPending }) {
    const { t } = useTranslation();
    if (!state || state.status === DictionaryStatus.IDLE) return null;

    const sourceName = (id) => t(`services.translate.${id}.title`, { defaultValue: id });
    const query = state.snapshot?.query ?? '';
    const result = state.result;
    const error = state.error;

    return (
        <section
            className='flex flex-col gap-1 rounded-md bg-content2 p-1.5 text-[12px]'
            data-testid='dictionary-panel'
            aria-label={t('selection_actions.dictionary')}
            aria-live='polite'
            aria-busy={state.status === DictionaryStatus.LOADING}
        >
            <div className='flex flex-wrap items-center gap-1'>
                <span className='font-medium'>{t('selection_actions.dictionary')}</span>
                <span
                    className='text-default-500'
                    data-testid='dictionary-source'
                >
                    {t('dictionary.source', { source: sourceName(state.sourceId) })}
                </span>
                <span className='flex-1' />
                {state.status === DictionaryStatus.SUCCESS && (
                    <Button
                        size='sm'
                        radius='sm'
                        variant={speaking ? 'solid' : 'flat'}
                        color={speaking ? 'secondary' : 'default'}
                        aria-pressed={speaking}
                        title={t('dictionary.pronounce_tts_hint')}
                        className='h-[22px] min-w-0 px-2 text-[12px]'
                        startContent={<HiOutlineVolumeUp className='text-[14px]' />}
                        onPress={pronounce}
                    >
                        {speaking && speakingPending ? (
                            <PulseLoader
                                size={3}
                                color='currentColor'
                                speedMultiplier={0.8}
                            />
                        ) : (
                            t('dictionary.pronounce_tts')
                        )}
                    </Button>
                )}
                <Button
                    isIconOnly
                    size='sm'
                    variant='light'
                    aria-label={t('dictionary.close')}
                    className='h-[22px] w-[22px] min-w-0'
                    onPress={dismiss}
                >
                    <MdClose />
                </Button>
            </div>

            {sources.length > 1 && (
                <div
                    className='flex flex-wrap items-center gap-1'
                    role='group'
                    aria-label={t('dictionary.choose_source')}
                >
                    {sources.map((source) => (
                        <Button
                            key={source.key}
                            size='sm'
                            radius='sm'
                            variant={source.key === state.sourceKey ? 'solid' : 'flat'}
                            color={source.key === state.sourceKey ? 'primary' : 'default'}
                            aria-pressed={source.key === state.sourceKey}
                            className='h-[20px] min-w-0 px-2 text-[11px]'
                            onPress={() => selectSource(source.key)}
                        >
                            {sourceName(getServiceName(source.key))}
                        </Button>
                    ))}
                </div>
            )}

            {state.status === DictionaryStatus.LOADING && (
                <span className='text-default-500'>{t('dictionary.looking_up', { query })}</span>
            )}

            {state.status === DictionaryStatus.ERROR && error && (
                <div
                    className='flex flex-col gap-0.5'
                    data-testid='dictionary-error'
                    data-code={error.code}
                >
                    <span className='text-danger'>
                        {t(`dictionary.messages.${error.code}`, {
                            defaultValue: error.code,
                            source: sourceName(state.sourceId),
                            query,
                        })}
                    </span>
                    {error.code === DictionaryErrorCode.TOO_LONG && (
                        <span className='text-default-500'>{t('dictionary.try_sentence_analysis')}</span>
                    )}
                    {error.detail !== '' &&
                        (error.code === DictionaryErrorCode.PROVIDER_FAILED ||
                            error.code === DictionaryErrorCode.UNSUPPORTED_RESPONSE) && (
                            <span
                                className='text-default-500 break-words line-clamp-2'
                                title={error.detail}
                            >
                                {error.detail}
                            </span>
                        )}
                    {(error.code === DictionaryErrorCode.PROVIDER_FAILED ||
                        error.code === DictionaryErrorCode.UNSUPPORTED_RESPONSE) && (
                        <div>
                            <Button
                                size='sm'
                                radius='sm'
                                variant='flat'
                                className='h-[20px] min-w-0 px-2 text-[11px]'
                                onPress={() => selectSource(state.sourceKey)}
                            >
                                {t('dictionary.retry')}
                            </Button>
                        </div>
                    )}
                </div>
            )}

            {state.status === DictionaryStatus.SUCCESS && result && (
                <div
                    className='flex max-h-[240px] flex-col gap-1.5 overflow-y-auto'
                    data-testid='dictionary-result'
                >
                    {result.headwordMatch === 'variant' && (
                        <span className='text-default-500'>
                            {t('dictionary.variant_entry', { headword: result.entries[0]?.headword ?? '' })}
                        </span>
                    )}
                    {result.entries.map((entry, entryIndex) => (
                        <div
                            key={entryIndex}
                            className='flex flex-col gap-0.5'
                        >
                            <div className='flex flex-wrap items-baseline gap-x-2'>
                                <span className='text-[13px] font-bold select-text'>{entry.headword ?? query}</span>
                                {(entry.kind || entry.partOfSpeech) && (
                                    <span className='italic text-primary'>
                                        {entry.partOfSpeech ?? entry.kind}
                                    </span>
                                )}
                                {entry.pronunciations.map((pronunciation, index) => (
                                    <span
                                        key={index}
                                        className='text-default-500 select-text'
                                    >
                                        {pronunciation.region
                                            ? `${REGION_LABEL[pronunciation.region.toLowerCase()] ?? pronunciation.region} `
                                            : ''}
                                        {pronunciation.ipa ?? ''}
                                    </span>
                                ))}
                            </div>
                            <ol className='flex flex-col gap-0.5 pl-4 list-decimal'>
                                {entry.senses.map((sense, senseIndex) => (
                                    <li key={senseIndex}>
                                        {sense.meanings.length > 0 && (
                                            <span className='font-medium select-text'>
                                                {sense.meanings.join('；')}
                                            </span>
                                        )}
                                        {sense.partOfSpeech && sense.partOfSpeech !== entry.partOfSpeech && (
                                            <span className='ml-1 italic text-default-500'>{sense.partOfSpeech}</span>
                                        )}
                                        {sense.definition && (
                                            <div className='text-default-500 select-text'>{sense.definition}</div>
                                        )}
                                        {sense.examples.map((example, exampleIndex) => (
                                            <div
                                                key={exampleIndex}
                                                className='italic select-text'
                                            >
                                                {example.text}
                                                {example.translation && (
                                                    <span className='not-italic text-default-500'>
                                                        {' '}
                                                        {example.translation}
                                                    </span>
                                                )}
                                            </div>
                                        ))}
                                    </li>
                                ))}
                            </ol>
                        </div>
                    ))}
                    {result.associations.length > 0 && (
                        <div className='text-default-500 select-text'>{result.associations.join(' · ')}</div>
                    )}
                    <span
                        className='text-[10px] text-default-400'
                        data-testid='dictionary-attribution'
                    >
                        {t('dictionary.attribution', { source: sourceName(result.sourceId) })}
                        {result.truncated ? ` ${t('dictionary.truncated')}` : ''}
                    </span>
                </div>
            )}
        </section>
    );
}
