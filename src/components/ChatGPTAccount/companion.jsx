import { Switch } from '@nextui-org/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { addCompanion, companionMissing } from '../../utils/chatgpt_settings';
import { COMPANIONS } from '../../utils/chatgpt_shared';

/**
 * "Also add the other ChatGPT-plan service" state for a Config page. `mainService` is the service
 * being configured (`chatgpt` or `chatgpt_ai`); its sibling lives in the other service list.
 * `available` is false when the sibling is already set up, in which case nothing is offered.
 */
export function useChatGPTCompanion(mainService) {
    const [available, setAvailable] = useState(false);
    const [enabled, setEnabled] = useState(true);

    useEffect(() => {
        let cancelled = false;
        companionMissing(mainService).then(
            (missing) => !cancelled && setAvailable(missing),
            () => !cancelled && setAvailable(false)
        );
        return () => {
            cancelled = true;
        };
    }, [mainService]);

    // Call after the main service was saved. Resolves to the new instance key, or null if nothing was added.
    const addIfWanted = (title) => (available && enabled ? addCompanion(mainService, title) : Promise.resolve(null));

    return { available, enabled, setEnabled, addIfWanted };
}

export function CompanionSwitch({ mainService, companion }) {
    const { t } = useTranslation();
    if (!companion.available) return null;
    return (
        <div className='config-item'>
            <Switch
                isSelected={companion.enabled}
                onValueChange={companion.setEnabled}
                classNames={{ base: 'flex flex-row-reverse justify-between w-full max-w-full' }}
            >
                {t(COMPANIONS[mainService].labelKey)}
            </Switch>
        </div>
    );
}
