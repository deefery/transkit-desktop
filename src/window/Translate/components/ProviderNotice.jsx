import { Button } from '@nextui-org/react';
import { invoke } from '@tauri-apps/api/tauri';
import { useTranslation } from 'react-i18next';
import { MdErrorOutline, MdSwapHoriz } from 'react-icons/md';
import React from 'react';

import { getServiceName, whetherPluginService } from '../../../utils/service_instance';
import { ErrorKind } from '../providerFallback';

const openSettings = () => invoke('open_config_window');

// Display name of a translate service instance: its own name, else the service title.
export function useProviderName({ configMap, pluginList }) {
    const { t } = useTranslation();
    return (key) => {
        if (!key) return '';
        const own = configMap?.[key]?.instanceName;
        if (typeof own === 'string' && own.trim() !== '') return own.trim();
        const name = getServiceName(key);
        if (whetherPluginService(key)) return pluginList?.translate?.[name]?.display ?? name;
        return t(`services.translate.${name}.title`, { defaultValue: name });
    };
}

/**
 * What the provider fallback did for this request (roadmap task F1): which provider failed and
 * why, which one is shown instead, or what to do when nothing else is left. Text nodes only.
 */
export default function ProviderNotice({ notice, configMap, pluginList, tryProvider, openConfig = openSettings }) {
    const { t } = useTranslation();
    const nameOf = useProviderName({ configMap, pluginList });
    if (!notice) return null;
    const reason = (kind) => t(`translate.fallback.reason.${kind}`, { defaultValue: kind });

    if (notice.type === 'switched' || notice.type === 'cooling') {
        return (
            <div
                className='flex items-center gap-1 px-1 pt-1 text-[11px] text-default-500'
                role='status'
                data-testid='provider-notice'
                data-type={notice.type}
            >
                <MdSwapHoriz className='shrink-0 text-[14px]' aria-hidden='true' />
                <span className='break-words'>
                    {notice.type === 'switched'
                        ? t('translate.fallback.switched', {
                              from: nameOf(notice.from),
                              to: nameOf(notice.to),
                              reason: reason(notice.kind),
                          })
                        : t('translate.fallback.cooling', { from: nameOf(notice.from), to: nameOf(notice.to) })}
                </span>
            </div>
        );
    }

    return (
        <div
            className='flex flex-col gap-1 px-1 pt-1 text-[11px]'
            role='status'
            data-testid='provider-notice'
            data-type='failed'
            data-kind={notice.kind}
        >
            <span className='flex items-start gap-1 text-warning-600'>
                <MdErrorOutline className='mt-[1px] shrink-0 text-[14px]' aria-hidden='true' />
                <span className='break-words'>
                    {t(`translate.fallback.hint.${notice.kind}`, {
                        defaultValue: t(`translate.fallback.hint.${ErrorKind.SERVICE}`),
                        name: nameOf(notice.provider),
                    })}
                </span>
            </span>
            {(notice.next || notice.kind === ErrorKind.AUTH) && (
                <span className='flex flex-wrap items-center gap-1'>
                    {notice.next && (
                        <Button
                            size='sm'
                            variant='flat'
                            className='h-[22px] min-w-0 px-2 text-[12px]'
                            onPress={() => tryProvider(notice.next)}
                            data-testid='provider-try-next'
                        >
                            {t('translate.fallback.try', { name: nameOf(notice.next) })}
                        </Button>
                    )}
                    {notice.kind === ErrorKind.AUTH && (
                        <Button
                            size='sm'
                            variant='flat'
                            className='h-[22px] min-w-0 px-2 text-[12px]'
                            onPress={() => openConfig()}
                        >
                            {t('translate.fallback.open_settings')}
                        </Button>
                    )}
                </span>
            )}
        </div>
    );
}
