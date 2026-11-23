import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Input } from '@nextui-org/react';
import { open } from '@tauri-apps/api/shell';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { useToastStyle } from '../../hooks';
import { useConfig } from '../../hooks/useConfig';
import {
    CHATGPT_USAGE_URL,
    cancelChatGPTSignIn,
    describeChatGPTError,
    getChatGPTStatus,
    listChatGPTModels,
    signInChatGPT,
    signOutChatGPT,
} from '../../utils/chatgpt';
import { SHARED_SETTINGS_KEY } from '../../utils/chatgpt_shared';

function ModelField({ label, value, onChange, placeholder, models, chooseLabel }) {
    return (
        <div className='config-item'>
            <Input
                label={label}
                labelPlacement='outside'
                placeholder={placeholder}
                value={value ?? ''}
                variant='bordered'
                classNames={{ label: 'text-xs text-default-500 pb-1' }}
                onValueChange={onChange}
                endContent={
                    models.length > 0 && (
                        <Dropdown>
                            <DropdownTrigger>
                                <Button size='sm' variant='flat' className='h-6 min-w-0 px-2'>
                                    {chooseLabel}
                                </Button>
                            </DropdownTrigger>
                            <DropdownMenu
                                aria-label='models'
                                className='max-h-[40vh] overflow-y-auto'
                                onAction={(key) => onChange(String(key))}
                            >
                                {models.map((m) => (
                                    <DropdownItem key={m.slug} description={m.slug !== m.display_name ? m.slug : undefined}>
                                        {m.display_name}
                                    </DropdownItem>
                                ))}
                            </DropdownMenu>
                        </Dropdown>
                    )
                }
            />
        </div>
    );
}

/**
 * Account + model section shared by the ChatGPT-plan service configs.
 *
 * Two model fields: the *default model* is one setting shared by the translate and AI services
 * (stored under `chatgpt_settings`); `model` / `onModelChange` is this service's own optional
 * override (empty = follow the default).
 *
 * `onStatusChange(status)` reports `connected` / `disconnected` / `reauth_required` so the parent
 * can enable its Save button only when requests can succeed.
 */
export default function ChatGPTAccount({ model, onModelChange, onStatusChange }) {
    const { t } = useTranslation();
    const toastStyle = useToastStyle();
    const [session, setSession] = useState(null);
    const [busy, setBusy] = useState(false);
    const [models, setModels] = useState([]);
    const [shared, setShared] = useConfig(SHARED_SETTINGS_KEY, { model: '' });
    const onStatusChangeRef = useRef(onStatusChange);
    onStatusChangeRef.current = onStatusChange;

    const applySession = useCallback((next) => {
        setSession(next);
        onStatusChangeRef.current?.(next);
    }, []);

    const showError = useCallback(
        (error) => toast.error(describeChatGPTError(error), { style: toastStyle }),
        [toastStyle]
    );

    useEffect(() => {
        getChatGPTStatus().then(applySession, (error) => {
            applySession({ status: 'disconnected', sharing: false });
            showError(error);
        });
    }, []);

    const connected = session?.status === 'connected' && session.sharing;

    useEffect(() => {
        if (!connected) {
            setModels([]);
            return;
        }
        let cancelled = false;
        listChatGPTModels().then(
            (list) => !cancelled && setModels(list),
            () => !cancelled && setModels([])
        );
        return () => {
            cancelled = true;
        };
    }, [connected]);

    const signIn = async (reconsent) => {
        setBusy(true);
        try {
            applySession(await signInChatGPT({ reconsent }));
        } catch (error) {
            if (error.code !== 'cancelled') showError(error);
        } finally {
            setBusy(false);
        }
    };

    const signOut = async () => {
        setBusy(true);
        try {
            const { revoked } = await signOutChatGPT();
            applySession({ status: 'disconnected', sharing: false });
            if (!revoked) toast(t('chatgpt.revoke_unconfirmed'), { style: toastStyle });
        } catch (error) {
            showError(error);
        } finally {
            setBusy(false);
        }
    };

    if (session === null || shared === null) return null;

    const signedIn = session.status === 'connected';
    const label = signedIn ? session.email || session.name || t('chatgpt.signed_in') : null;
    const defaultModel = (shared.model ?? '').trim();

    return (
        <>
            <div className='config-item flex-col items-stretch gap-2'>
                <div className='flex items-center justify-between gap-2'>
                    <div className='min-w-0'>
                        <p className='text-sm'>{t('chatgpt.account')}</p>
                        <p className='text-xs text-default-500 truncate'>
                            {session.status === 'reauth_required'
                                ? t('chatgpt.reauth_required')
                                : signedIn
                                  ? t('chatgpt.connected_as', { account: label })
                                  : t('chatgpt.not_signed_in')}
                        </p>
                    </div>
                    <div className='flex gap-2 shrink-0'>
                        {busy && !signedIn ? (
                            <Button size='sm' variant='flat' onPress={() => cancelChatGPTSignIn()}>
                                {t('chatgpt.cancel')}
                            </Button>
                        ) : signedIn ? (
                            <Button size='sm' variant='flat' color='danger' isDisabled={busy} onPress={signOut}>
                                {t('chatgpt.sign_out')}
                            </Button>
                        ) : (
                            <Button size='sm' color='primary' isDisabled={busy} onPress={() => signIn(false)}>
                                {session.status === 'reauth_required' ? t('chatgpt.reconnect') : t('chatgpt.sign_in')}
                            </Button>
                        )}
                    </div>
                </div>
                {busy && !signedIn && <p className='text-xs text-default-500'>{t('chatgpt.waiting_for_browser')}</p>}
                {signedIn && !session.sharing && (
                    <div className='flex items-center justify-between gap-2'>
                        <p className='text-xs text-warning'>{t('chatgpt.sharing_off')}</p>
                        {busy ? (
                            <Button size='sm' variant='flat' onPress={() => cancelChatGPTSignIn()}>
                                {t('chatgpt.cancel')}
                            </Button>
                        ) : (
                            <Button size='sm' color='warning' variant='flat' onPress={() => signIn(true)}>
                                {t('chatgpt.enable_sharing')}
                            </Button>
                        )}
                    </div>
                )}
                <div className='flex items-center justify-between gap-2'>
                    <p className='text-xs text-default-400'>{t('chatgpt.quota_note')}</p>
                    <Button size='sm' variant='light' onPress={() => open(CHATGPT_USAGE_URL)}>
                        {t('chatgpt.manage_usage')}
                    </Button>
                </div>
            </div>
            <ModelField
                label={t('chatgpt.default_model')}
                value={shared.model}
                onChange={(value) => setShared({ ...shared, model: value })}
                placeholder={t('chatgpt.model_auto')}
                models={models}
                chooseLabel={t('chatgpt.choose_model')}
            />
            <ModelField
                label={t('chatgpt.service_model')}
                value={model}
                onChange={onModelChange}
                placeholder={
                    defaultModel
                        ? t('chatgpt.follow_default', { model: defaultModel })
                        : t('chatgpt.follow_default_auto')
                }
                models={models}
                chooseLabel={t('chatgpt.choose_model')}
            />
        </>
    );
}
