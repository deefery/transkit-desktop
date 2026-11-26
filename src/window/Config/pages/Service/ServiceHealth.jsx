import { Button } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { MdCheckCircleOutline, MdErrorOutline } from 'react-icons/md';
import React, { useEffect, useState } from 'react';

import { useConfig } from '../../../../hooks';
import { store } from '../../../../utils/store';
import { HEALTH_CONFIG_KEY } from '../../../../utils/service_health';
import { healthUpdates, testAndRecord } from './serviceTests';

// "2 minutes ago" in the app language (i18n keys look like zh_cn; Intl wants zh-CN).
function useRelativeTime(at) {
    const { i18n } = useTranslation();
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
    }, []);
    if (!Number.isFinite(at)) return '';
    const locale = String(i18n.language ?? 'en').replace('_', '-');
    let format;
    try {
        format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    } catch (_) {
        format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    }
    const seconds = Math.round((at - now) / 1000);
    if (Math.abs(seconds) < 60) return format.format(Math.min(0, seconds), 'second');
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return format.format(hours, 'hour');
    return format.format(Math.round(hours / 24), 'day');
}

/**
 * Health of one service instance (H1): its last known outcome, from a test or from real use, and
 * a button to test it now. Shows the kind of failure and its HTTP status, never error text.
 */
export default function ServiceHealth({ kind, instanceKey, pluginList }) {
    const { t } = useTranslation();
    // Read-only here (sync: false): records are written by recordServiceOutcome only.
    const [health, setHealth] = useConfig(HEALTH_CONFIG_KEY, {}, { sync: false });
    const [running, setRunning] = useState(false);
    useEffect(() => {
        const refresh = () => store.get(HEALTH_CONFIG_KEY).then((value) => setHealth(value ?? {}));
        healthUpdates.addEventListener('change', refresh);
        return () => healthUpdates.removeEventListener('change', refresh);
    }, [setHealth]);
    const record = health?.[instanceKey] ?? null;
    const when = useRelativeTime(record?.at);

    const test = async () => {
        setRunning(true);
        try {
            await testAndRecord({ kind, instanceKey, pluginList });
        } finally {
            setRunning(false);
        }
    };

    let summary = t('config.service.health.untested');
    if (record?.ok) {
        summary = [t('config.service.health.ok'), Number.isFinite(record.ms) ? `${record.ms} ms` : null, when]
            .filter(Boolean)
            .join(' · ');
    } else if (record) {
        const reason = t(`translate.fallback.reason.${record.kind}`, { defaultValue: record.kind });
        summary = [
            `${t('config.service.health.failed')}: ${reason}${record.status ? ` (HTTP ${record.status})` : ''}`,
            when,
        ]
            .filter(Boolean)
            .join(' · ');
    }
    const source = record ? t(`config.service.health.source.${record.source === 'test' ? 'test' : 'use'}`) : '';

    return (
        <div
            className='flex items-center gap-2 mr-2'
            data-testid='service-health'
            data-instance={instanceKey}
            data-state={record ? (record.ok ? 'ok' : 'failed') : 'untested'}
        >
            <span
                className={`flex items-center gap-1 text-[12px] ${record ? (record.ok ? 'text-success-600' : 'text-danger') : 'text-default-400'}`}
                title={source}
            >
                {record &&
                    (record.ok ? (
                        <MdCheckCircleOutline className='text-[14px] shrink-0' aria-hidden='true' />
                    ) : (
                        <MdErrorOutline className='text-[14px] shrink-0' aria-hidden='true' />
                    ))}
                <span data-testid='service-health-summary'>{summary}</span>
            </span>
            <Button
                size='sm'
                variant='flat'
                className='h-[26px] min-w-0 px-2 text-[12px]'
                isLoading={running}
                onPress={test}
                data-testid='service-health-test'
            >
                {t('config.service.health.test')}
            </Button>
        </div>
    );
}

/** "Test all" for one service list: tests the enabled instances one after another. */
export function TestAllButton({ kind, instanceKeys, pluginList }) {
    const { t } = useTranslation();
    const [progress, setProgress] = useState(null);
    const run = async () => {
        const keys = (instanceKeys ?? []).filter(Boolean);
        for (let i = 0; i < keys.length; i += 1) {
            setProgress(`${i + 1}/${keys.length}`);
            await testAndRecord({ kind, instanceKey: keys[i], pluginList });
        }
        setProgress(null);
    };
    return (
        <Button
            fullWidth
            variant='flat'
            isLoading={progress !== null}
            isDisabled={(instanceKeys ?? []).length === 0}
            onPress={run}
            data-testid='service-health-test-all'
        >
            {progress ? `${t('config.service.health.test_all')} ${progress}` : t('config.service.health.test_all')}
        </Button>
    );
}
