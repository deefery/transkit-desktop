import { Button, Input, Textarea } from '@nextui-org/react';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import React, { useState } from 'react';

import ChatGPTAccount from '../../../components/ChatGPTAccount';
import { useConfig } from '../../../hooks/useConfig';
import { useToastStyle } from '../../../hooks';
import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { DEFAULT_SYSTEM_PROMPT, summarize } from './index';

export function Config(props) {
    const { instanceKey, updateServiceList, onClose } = props;
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(false);
    const [signedIn, setSignedIn] = useState(false);
    const toastStyle = useToastStyle();

    const [config, setConfig] = useConfig(
        instanceKey,
        {
            [INSTANCE_NAME_CONFIG_KEY]: t('services.ai.chatgpt_ai.title'),
            model: '',
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
        },
        { sync: false }
    );

    return (
        config !== null && (
            <>
                <Toaster />
                <div className='config-item'>
                    <Input
                        label={t('services.instance_name')}
                        labelPlacement='outside'
                        value={config[INSTANCE_NAME_CONFIG_KEY]}
                        variant='bordered'
                        classNames={{ label: 'text-xs text-default-500 pb-1' }}
                        onValueChange={(v) => setConfig({ ...config, [INSTANCE_NAME_CONFIG_KEY]: v })}
                    />
                </div>
                <ChatGPTAccount
                    model={config.model}
                    onModelChange={(model) => setConfig({ ...config, model })}
                    onStatusChange={(session) => setSignedIn(session.status === 'connected' && session.sharing)}
                />
                <div className='config-item flex-col gap-1'>
                    <p className='text-sm'>{t('services.ai.openai_compat_ai.system_prompt')}</p>
                    <Textarea
                        variant='bordered'
                        minRows={4}
                        value={config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT}
                        onValueChange={(v) => setConfig({ ...config, systemPrompt: v })}
                    />
                    <p className='text-xs text-default-400'>{t('services.ai.openai_compat_ai.system_prompt_hint')}</p>
                </div>
                <div>
                    <Button
                        isLoading={isLoading}
                        isDisabled={!signedIn}
                        fullWidth
                        color='primary'
                        onPress={() => {
                            setIsLoading(true);
                            summarize('Hello world', { config }).then(
                                () => {
                                    setIsLoading(false);
                                    setConfig(config, true);
                                    updateServiceList(instanceKey);
                                    onClose();
                                },
                                (error) => {
                                    setIsLoading(false);
                                    toast.error(t('config.service.test_failed') + (error?.message ?? String(error)), {
                                        style: toastStyle,
                                    });
                                }
                            );
                        }}
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </>
        )
    );
}
