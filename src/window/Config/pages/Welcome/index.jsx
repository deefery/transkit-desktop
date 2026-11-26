import { Button, Card, CardBody, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@nextui-org/react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/tauri';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { MdCheckCircleOutline, MdErrorOutline, MdKeyboard } from 'react-icons/md';
import React, { useEffect, useRef, useState } from 'react';

import { useConfig } from '../../../../hooks';
import { languageList } from '../../../../utils/language';
import { store } from '../../../../utils/store';
import { HEALTH_CONFIG_KEY } from '../../../../utils/service_health';
import { getServiceName, whetherPluginService } from '../../../../utils/service_instance';
import { osType } from '../../../../utils/env';
import * as builtinTranslateServices from '../../../../services/translate';
import ServiceHealth from '../Service/ServiceHealth';
import { ServiceKind, healthUpdates, testAndRecord } from '../Service/serviceTests';
import {
    APP_LANGUAGES,
    ONBOARDING_CONFIG_KEY,
    SELECTION_READ_EVENT,
    formatShortcut,
    moveToFront,
    recommendPrimary,
    selectionCheck,
} from './onboarding';

// After this long without a shortcut report, hint that the shortcut may be taken.
const SHORTCUT_HINT_MS = 30000;

function Step({ number, title, children, testId }) {
    return (
        <Card
            className='mb-[10px]'
            data-testid={testId}
        >
            <CardBody className='flex flex-col gap-3'>
                <div className='flex items-center gap-2'>
                    <span className='flex h-[24px] w-[24px] items-center justify-center rounded-full bg-primary text-[13px] font-semibold text-primary-foreground'>
                        {number}
                    </span>
                    <h3 className='text-[15px] font-semibold'>{title}</h3>
                </div>
                {children}
            </CardBody>
        </Card>
    );
}

/** First-run guide (roadmap task O1). Shown by Settings while `onboarding_pending` is set. */
export default function Welcome({ autoTest = true }) {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const [appLanguage, setAppLanguage] = useConfig('app_language', 'en');
    const [targetLanguage, setTargetLanguage] = useConfig('translate_target_language', 'zh_cn');
    const [serviceList, setServiceList] = useConfig('translate_service_list', []);
    const [shortcut] = useConfig('hotkey_selection_translate', 'Ctrl+Alt+Q');
    const [, setPending] = useConfig(ONBOARDING_CONFIG_KEY, false);
    const [health, setHealth] = useConfig(HEALTH_CONFIG_KEY, {}, { sync: false });
    const [check, setCheck] = useState(selectionCheck(undefined));
    const [showShortcutHint, setShowShortcutHint] = useState(false);
    const testedRef = useRef(false);

    // Built-in services only: plugins are configured by the user later, not on a first run.
    const services = (serviceList ?? []).filter((key) => !whetherPluginService(key) && builtinTranslateServices[getServiceName(key)]);
    const recommended = recommendPrimary(services, health);

    useEffect(() => {
        const refresh = () => store.get(HEALTH_CONFIG_KEY).then((value) => setHealth(value ?? {}));
        healthUpdates.addEventListener('change', refresh);
        return () => healthUpdates.removeEventListener('change', refresh);
    }, [setHealth]);

    // Check the configured services once, so the user sees which ones work on this network.
    useEffect(() => {
        if (!autoTest || testedRef.current || services.length === 0) return;
        testedRef.current = true;
        (async () => {
            for (const key of services) await testAndRecord({ kind: ServiceKind.TRANSLATE, instanceKey: key, pluginList: {} });
        })();
    }, [autoTest, services.join('\n')]);

    useEffect(() => {
        const unlisten = listen(SELECTION_READ_EVENT, (event) => {
            setCheck(selectionCheck(event.payload));
            setShowShortcutHint(false);
        });
        const timer = setTimeout(() => setShowShortcutHint(true), SHORTCUT_HINT_MS);
        return () => {
            unlisten.then((f) => f());
            clearTimeout(timer);
        };
    }, []);

    const chooseAppLanguage = (key) => {
        setAppLanguage(key);
        i18n.changeLanguage(key);
        invoke('update_tray', { language: key, copyMode: '' }).catch(() => {});
    };
    const finish = () => {
        setPending(false);
        navigate('/general');
    };
    const serviceName = (key) => t(`services.translate.${getServiceName(key)}.title`, { defaultValue: getServiceName(key) });
    const keys = formatShortcut(shortcut, osType === 'Darwin');

    return (
        <div data-testid='welcome'>
            <div className='mb-[16px] flex items-start justify-between gap-4'>
                <div>
                    <h2 className='text-[20px] font-semibold'>{t('config.welcome.heading')}</h2>
                    <p className='text-[13px] text-default-500'>{t('config.welcome.subtitle')}</p>
                </div>
                <Button
                    variant='light'
                    size='sm'
                    onPress={finish}
                    data-testid='welcome-skip'
                >
                    {t('config.welcome.skip')}
                </Button>
            </div>

            <Step
                number={1}
                title={t('config.welcome.language_title')}
                testId='welcome-step-language'
            >
                <div className='config-item'>
                    <span className='my-auto text-[14px]'>{t('config.general.app_language')}</span>
                    <Dropdown>
                        <DropdownTrigger>
                            <Button
                                variant='bordered'
                                data-testid='welcome-app-language'
                            >
                                {APP_LANGUAGES[appLanguage] ?? appLanguage}
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label={t('config.general.app_language')}
                            className='max-h-[40vh] overflow-y-auto'
                            onAction={(key) => chooseAppLanguage(String(key))}
                        >
                            {Object.entries(APP_LANGUAGES).map(([key, name]) => (
                                <DropdownItem key={key}>{name}</DropdownItem>
                            ))}
                        </DropdownMenu>
                    </Dropdown>
                </div>
                <div className='config-item'>
                    <span className='my-auto text-[14px]'>{t('config.welcome.translate_into')}</span>
                    <Dropdown>
                        <DropdownTrigger>
                            <Button
                                variant='bordered'
                                data-testid='welcome-target-language'
                            >
                                {targetLanguage ? t(`languages.${targetLanguage}`) : ''}
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label={t('config.welcome.translate_into')}
                            className='max-h-[40vh] overflow-y-auto'
                            onAction={(key) => setTargetLanguage(String(key))}
                        >
                            {languageList.map((key) => (
                                <DropdownItem key={key}>{t(`languages.${key}`)}</DropdownItem>
                            ))}
                        </DropdownMenu>
                    </Dropdown>
                </div>
            </Step>

            <Step
                number={2}
                title={t('config.welcome.service_title')}
                testId='welcome-step-service'
            >
                <p className='text-[13px] text-default-500'>{t('config.welcome.service_desc')}</p>
                {services.map((key, index) => (
                    <div
                        key={key}
                        className='flex items-center justify-between rounded-md bg-content2 px-3 py-2'
                        data-testid='welcome-service'
                        data-instance={key}
                    >
                        <div className='flex items-center gap-2'>
                            <img
                                src={builtinTranslateServices[getServiceName(key)].info.icon}
                                className='h-[20px] w-[20px]'
                                alt=''
                                draggable={false}
                            />
                            <span className='text-[14px]'>{serviceName(key)}</span>
                            {index === 0 && (
                                <span className='rounded bg-primary/15 px-1.5 text-[11px] text-primary'>
                                    {t('config.welcome.primary')}
                                </span>
                            )}
                            {key === recommended && index !== 0 && (
                                <span className='rounded bg-success/15 px-1.5 text-[11px] text-success-600'>
                                    {t('config.welcome.recommended')}
                                </span>
                            )}
                        </div>
                        <div className='flex items-center'>
                            <ServiceHealth
                                kind={ServiceKind.TRANSLATE}
                                instanceKey={key}
                                pluginList={{}}
                            />
                            {index !== 0 && (
                                <Button
                                    size='sm'
                                    variant={key === recommended ? 'solid' : 'flat'}
                                    color={key === recommended ? 'primary' : 'default'}
                                    className='h-[26px] min-w-0 px-2 text-[12px]'
                                    onPress={() => setServiceList(moveToFront(serviceList, key))}
                                    data-testid='welcome-use-primary'
                                >
                                    {t('config.welcome.use_as_primary')}
                                </Button>
                            )}
                        </div>
                    </div>
                ))}
            </Step>

            <Step
                number={3}
                title={t('config.welcome.shortcut_title')}
                testId='welcome-step-shortcut'
            >
                <p className='text-[13px] text-default-500'>
                    {keys ? t('config.welcome.shortcut_desc', { keys }) : t('config.welcome.shortcut_missing')}
                </p>
                <p
                    className='select-text rounded-md border border-dashed border-content3 px-3 py-2 text-[14px]'
                    data-testid='welcome-sample'
                >
                    {t('config.welcome.sample_sentence')}
                </p>
                <div
                    className='flex items-start gap-2 text-[13px]'
                    role='status'
                    aria-live='polite'
                    data-testid='welcome-shortcut-status'
                    data-state={check.state}
                >
                    {check.state === 'ok' && (
                        <span className='flex items-center gap-1 text-success-600'>
                            <MdCheckCircleOutline className='text-[16px]' />
                            {t('config.welcome.read_ok', { count: check.chars })}
                        </span>
                    )}
                    {check.state === 'empty' && (
                        <span className='flex items-start gap-1 text-warning-600'>
                            <MdErrorOutline className='mt-[2px] shrink-0 text-[16px]' />
                            {t('config.welcome.read_empty')}
                        </span>
                    )}
                    {check.state === 'waiting' && (
                        <span className='flex items-center gap-1 text-default-500'>
                            <MdKeyboard className='text-[16px]' />
                            {showShortcutHint ? t('config.welcome.waiting_hint') : t('config.welcome.waiting')}
                        </span>
                    )}
                </div>
                {(showShortcutHint || !keys) && check.state === 'waiting' && (
                    <Button
                        size='sm'
                        variant='flat'
                        className='self-start'
                        onPress={() => navigate('/hotkey')}
                    >
                        {t('config.welcome.open_hotkeys')}
                    </Button>
                )}
            </Step>

            <div className='flex justify-end'>
                <Button
                    color='primary'
                    onPress={finish}
                    data-testid='welcome-finish'
                >
                    {t('config.welcome.finish')}
                </Button>
            </div>
        </div>
    );
}
