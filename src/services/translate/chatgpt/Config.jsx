import { Button, Input, Switch, Textarea } from '@nextui-org/react';
import { MdDeleteOutline } from 'react-icons/md';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import React, { useState } from 'react';

import ChatGPTAccount from '../../../components/ChatGPTAccount';
import { CompanionSwitch, useChatGPTCompanion } from '../../../components/ChatGPTAccount/companion';
import { COMPANIONS } from '../../../utils/chatgpt_shared';
import { useConfig } from '../../../hooks/useConfig';
import { useToastStyle } from '../../../hooks';
import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { translate } from './index';
import { Language } from './info';
import { defaultPromptList } from './prompt';

export function Config(props) {
    const { instanceKey, updateServiceList, onClose } = props;
    const { t } = useTranslation();
    const [config, setConfig] = useConfig(
        instanceKey,
        {
            [INSTANCE_NAME_CONFIG_KEY]: t('services.translate.chatgpt.title'),
            model: '',
            stream: true,
            promptList: defaultPromptList,
        },
        { sync: false }
    );
    const [isLoading, setIsLoading] = useState(false);
    const [signedIn, setSignedIn] = useState(false);
    const companion = useChatGPTCompanion('chatgpt');
    const toastStyle = useToastStyle();

    return (
        config !== null && (
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    setIsLoading(true);
                    translate('hello', Language.auto, Language.zh_cn, { config }).then(
                        async () => {
                            setConfig(config, true);
                            try {
                                await companion.addIfWanted(t(COMPANIONS.chatgpt.titleKey));
                            } catch (error) {
                                toast.error(t('chatgpt.also_add_failed') + (error?.message ?? String(error)), {
                                    style: toastStyle,
                                });
                            }
                            setIsLoading(false);
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
                <Toaster />
                <div className='config-item'>
                    <Input
                        label={t('services.instance_name')}
                        labelPlacement='outside'
                        value={config[INSTANCE_NAME_CONFIG_KEY]}
                        variant='bordered'
                        classNames={{ label: 'text-xs text-default-500 pb-1' }}
                        onValueChange={(value) => setConfig({ ...config, [INSTANCE_NAME_CONFIG_KEY]: value })}
                    />
                </div>
                <ChatGPTAccount
                    model={config.model}
                    onModelChange={(model) => setConfig({ ...config, model })}
                    onStatusChange={(session) => setSignedIn(session.status === 'connected' && session.sharing)}
                />
                <CompanionSwitch mainService='chatgpt' companion={companion} />
                <div className='config-item'>
                    <Switch
                        isSelected={config.stream}
                        onValueChange={(value) => setConfig({ ...config, stream: value })}
                        classNames={{ base: 'flex flex-row-reverse justify-between w-full max-w-full' }}
                    >
                        {t('services.translate.openai.stream')}
                    </Switch>
                </div>
                <h3 className='my-auto'>Prompt List</h3>
                <p className='text-[10px] text-default-700'>{t('services.translate.chatgpt.prompt_description')}</p>
                <div className='bg-content2 rounded-[10px] p-3'>
                    {(config.promptList ?? []).map((prompt, index) => (
                        <div className='config-item' key={index}>
                            <Textarea
                                label={prompt.role}
                                labelPlacement='outside'
                                variant='faded'
                                value={prompt.content}
                                placeholder={`Input Some ${prompt.role} Prompt`}
                                onValueChange={(value) =>
                                    setConfig({
                                        ...config,
                                        promptList: config.promptList.map((p, i) => (i === index ? { ...p, content: value } : p)),
                                    })
                                }
                            />
                            <Button
                                isIconOnly
                                color='danger'
                                className='my-auto mx-1'
                                variant='flat'
                                onPress={() =>
                                    setConfig({ ...config, promptList: config.promptList.filter((_, i) => i !== index) })
                                }
                            >
                                <MdDeleteOutline className='text-[18px]' />
                            </Button>
                        </div>
                    ))}
                    <Button
                        fullWidth
                        onPress={() =>
                            setConfig({
                                ...config,
                                promptList: [
                                    ...config.promptList,
                                    {
                                        role:
                                            config.promptList.length === 0
                                                ? 'system'
                                                : config.promptList.length % 2 === 0
                                                  ? 'assistant'
                                                  : 'user',
                                        content: '',
                                    },
                                ],
                            })
                        }
                    >
                        {t('services.translate.openai.add')}
                    </Button>
                </div>
                <br />
                <Button type='submit' isLoading={isLoading} isDisabled={!signedIn} fullWidth color='primary'>
                    {t('common.save')}
                </Button>
            </form>
        )
    );
}
