import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useConfig } from '../../hooks';
import { translationRecordsAtom } from '../../features/selection-actions/translationRecords';
import { sourceTextAtom } from './components/SourceArea';
import { sourceLanguageAtom, targetLanguageAtom } from './components/LanguageArea';
import { AUTO_FALLBACK_CONFIG_KEY, createFallbackController, enabledProviders } from './providerFallback';
import { emit } from '@tauri-apps/api/event';
import { store as configStore } from '../../utils/store';
import { HealthSource, recordServiceOutcome } from '../../utils/service_health';

// Real-use outcome of a provider for the service health in Settings (H1); best effort.
const recordUse = (instanceKey, ok, error) =>
    recordServiceOutcome({ store: configStore, emit, instanceKey, outcome: { ok, error, source: HealthSource.USE } }).catch(
        () => {}
    );

/**
 * Provider fallback for the Translate window (roadmap task F1). The window shows one provider at a
 * time; when it fails, the next enabled provider is shown instead (once each per request), and a
 * provider that failed is skipped for a while when the next request starts. A provider the user
 * picked by hand is never switched away from.
 *
 * Returns `notice` (what happened, for ProviderNotice), `chooseProvider(index)` for the provider
 * tabs and `tryProvider(key)` for the notice's "Try …" button.
 */
export function useProviderFallback({ list, configMap, selectedIndex, setSelectedIndex }) {
    const [autoFallback] = useConfig(AUTO_FALLBACK_CONFIG_KEY, true);
    const sourceText = useAtomValue(sourceTextAtom);
    const sourceLanguage = useAtomValue(sourceLanguageAtom);
    const targetLanguage = useAtomValue(targetLanguageAtom);
    const records = useAtomValue(translationRecordsAtom);
    const controllerRef = useRef(null);
    if (!controllerRef.current) controllerRef.current = createFallbackController();
    const controller = controllerRef.current;

    const [notice, setNotice] = useState(null);
    const manualRef = useRef(null);
    const handledRef = useRef(new Set());

    const text = typeof sourceText === 'string' ? sourceText.trim() : '';
    const requestKey = text !== '' ? JSON.stringify([text, sourceLanguage, targetLanguage]) : null;
    const enabled = configMap ? enabledProviders(list, configMap) : [];
    const enabledSignature = enabled.join('\n');
    const selected = Array.isArray(list) ? list[selectedIndex] : undefined;

    const select = useCallback(
        (key) => {
            const index = Array.isArray(list) ? list.indexOf(key) : -1;
            if (index >= 0) setSelectedIndex(index);
        },
        [list, setSelectedIndex]
    );

    // A service config change (a key fixed, a service added) gives every provider a new chance.
    // Keyed on the contents, not the object identity (kept in memory only, never logged).
    const configSignature = configMap ? JSON.stringify(configMap) : '';
    useEffect(() => {
        controller.reset();
    }, [configSignature]);

    // New request: start on a provider that is not cooling down.
    useEffect(() => {
        if (requestKey === null || enabled.length === 0) return;
        setNotice(null);
        handledRef.current = new Set();
        const start = controller.onRequest(requestKey, selected, enabled);
        if (start && start !== selected) {
            select(start);
            setNotice({ type: 'cooling', from: selected, to: start });
        }
    }, [requestKey, enabledSignature]);

    // Outcome of the shown provider for the current request.
    const record = selected ? records?.[selected] : null;
    useEffect(() => {
        if (!record || requestKey === null) return;
        if (JSON.stringify([record.text, record.sourceLanguage, record.targetLanguage]) !== requestKey) return;
        if (record.status === 'success') {
            controller.onSuccess(record.instanceKey);
            recordUse(record.instanceKey, true);
            return;
        }
        if (record.status !== 'error') return;
        const id = `${record.instanceKey}#${record.requestId}`;
        if (handledRef.current.has(id)) return;
        handledRef.current.add(id);
        recordUse(record.instanceKey, false, record.error);
        const { kind, next } = controller.onFailure({
            requestKey,
            provider: record.instanceKey,
            error: record.error,
            enabled,
            manual: manualRef.current === requestKey,
            autoFallback: autoFallback !== false,
        });
        if (next) {
            select(next);
            setNotice({ type: 'switched', from: record.instanceKey, to: next, kind });
        } else {
            setNotice({
                type: 'failed',
                provider: record.instanceKey,
                kind,
                next: controller.nextUntried(requestKey, enabled),
            });
        }
    }, [record?.status, record?.requestId, record?.instanceKey, requestKey]);

    // The user picked a provider: keep it for this request, whatever happens.
    const chooseProvider = useCallback(
        (index) => {
            const key = Array.isArray(list) ? list[index] : undefined;
            if (requestKey !== null && key) {
                manualRef.current = requestKey;
                controller.onManualChoice(requestKey, key);
            }
            setNotice(null);
            setSelectedIndex(index);
        },
        [list, requestKey, setSelectedIndex]
    );
    const tryProvider = useCallback(
        (key) => {
            const index = Array.isArray(list) ? list.indexOf(key) : -1;
            if (index >= 0) chooseProvider(index);
        },
        [list, chooseProvider]
    );

    return { notice, chooseProvider, tryProvider };
}
