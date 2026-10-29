import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Input, Textarea } from '@nextui-org/react';
import { MdArrowDropDown } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import React, { useEffect, useRef, useState } from 'react';

import { CustomActionIcon } from './CustomActionIcon';
import {
    CUSTOM_ICON_IDS,
    CustomOutputMode,
    EntryProblem,
    MAX_CUSTOM_ACTIONS,
    MAX_INSTRUCTION_LENGTH,
    MAX_NAME_LENGTH,
    OpReason,
    StoredFormat,
    SUPPORTED_OUTPUT_MODES,
    editConflict,
} from './customActions';

const EMPTY_DRAFT = Object.freeze({
    name: '',
    icon: '',
    instanceKey: '',
    instruction: '',
    outputMode: CustomOutputMode.POPUP,
});

const draftOf = (action) => ({
    name: action.name,
    icon: action.icon ?? '',
    instanceKey: action.instanceKey,
    instruction: action.instruction,
    outputMode: action.outputMode,
});

/**
 * Create / edit / delete the stored Custom AI Actions. Every value shown is rendered as a text node
 * or a form value (no HTML). The editor holds a draft only; saving goes through `custom.create /
 * update / remove`, which validate and compare against the stored value at write time. An edit that
 * was started on an older stored version (changed or deleted since) is blocked here and refused
 * again by the store write.
 *
 *   custom: { format, actions, unreadableCount, create, update, remove, purgeUnreadable, reset }
 *   instances: [{ key, label }] - the user's configured AI service instances
 */
export function CustomActionsEditor({ custom, instances }) {
    const { t } = useTranslation();
    // null = list only; { kind: 'create' } or { kind: 'edit', id, baseRevision } = form open
    const [form, setForm] = useState(null);
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    const [errors, setErrors] = useState({});
    const [confirm, setConfirm] = useState(null); // { kind: 'delete', id, revision } | { kind: 'reset' }
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState(null); // { tone, text }
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const tx = (key, options) => t(`selection_actions.custom.${key}`, options);
    const instanceLabel = (key) => instances.find((instance) => instance.key === key)?.label;
    const readable = custom.format !== StoredFormat.UNSUPPORTED;

    // What the open edit form was started from, compared with what is stored now.
    const stored = form?.kind === 'edit' ? custom.actions.find((action) => action.id === form.id) : null;
    const conflict = form?.kind === 'edit' ? editConflict(custom.actions, form.id, form.baseRevision) : null;

    const open = (next, nextDraft) => {
        setForm(next);
        setDraft(nextDraft);
        setErrors({});
        setConfirm(null);
        setStatus(null);
    };
    const close = () => {
        setForm(null);
        setErrors({});
    };
    const field = (name) => (value) => {
        setDraft((current) => ({ ...current, [name]: value }));
        setErrors((current) => ({ ...current, [name]: undefined }));
    };

    const report = (result, successText) => {
        if (!mounted.current) return;
        if (result.ok) {
            setStatus({ tone: 'success', text: successText });
            return;
        }
        switch (result.reason) {
            case OpReason.INVALID:
                setErrors(result.errors ?? {});
                setStatus(null);
                break;
            case OpReason.NOT_FOUND:
                setStatus({ tone: 'danger', text: tx('conflict.deleted') });
                break;
            case OpReason.STALE:
                setStatus({ tone: 'danger', text: tx('conflict.changed') });
                break;
            case OpReason.FORMAT_UNSUPPORTED:
                setStatus({ tone: 'danger', text: tx('format_unsupported') });
                break;
            default:
                setStatus({ tone: 'danger', text: `${tx('save_failed')} ${result.detail ?? ''}`.trim() });
        }
    };

    const save = async () => {
        if (busy || conflict) return;
        setBusy(true);
        try {
            const result =
                form.kind === 'create'
                    ? await custom.create(draft)
                    : await custom.update(form.id, form.baseRevision, draft);
            report(result, tx('saved'));
            if (result.ok && mounted.current) close();
        } finally {
            if (mounted.current) setBusy(false);
        }
    };

    const runConfirmed = async () => {
        if (busy || !confirm) return;
        setBusy(true);
        try {
            let result;
            if (confirm.kind === 'delete') result = await custom.remove(confirm.id, confirm.revision);
            else if (confirm.kind === 'reset') result = await custom.reset();
            else result = await custom.purgeUnreadable();
            report(result, tx(confirm.kind === 'delete' ? 'deleted' : 'cleaned'));
            if (mounted.current) {
                setConfirm(null);
                if (result.ok && confirm.kind === 'delete' && form?.id === confirm.id) close();
            }
        } finally {
            if (mounted.current) setBusy(false);
        }
    };

    const reloadLatest = () => {
        if (!stored) return;
        setDraft(draftOf(stored));
        setForm({ kind: 'edit', id: stored.id, baseRevision: stored.revision });
        setErrors({});
        setStatus(null);
    };
    const saveAsNew = () => {
        setForm({ kind: 'create' });
        setStatus(null);
    };

    const errorText = (code) => tx(`errors.${code}`, { max: MAX_NAME_LENGTH });
    const unsupportedStoredMode =
        draft.outputMode !== '' && !SUPPORTED_OUTPUT_MODES.includes(draft.outputMode) ? draft.outputMode : null;
    const knownInstance = instances.some((instance) => instance.key === draft.instanceKey);

    return (
        <div
            className='flex flex-col gap-1 rounded-md bg-content2 p-1.5 text-[12px]'
            data-testid='custom-actions-editor'
            aria-label={tx('title')}
            role='group'
        >
            <div className='flex items-center gap-1'>
                <span className='flex-1 font-medium'>{tx('title')}</span>
                {readable && !form && (
                    <Button
                        size='sm'
                        variant='flat'
                        className='h-[22px] min-w-0 px-2 text-[12px]'
                        isDisabled={custom.actions.length >= MAX_CUSTOM_ACTIONS}
                        onPress={() =>
                            open({ kind: 'create' }, { ...EMPTY_DRAFT, instanceKey: instances[0]?.key ?? '' })
                        }
                    >
                        {tx('add')}
                    </Button>
                )}
            </div>

            {!readable && (
                <div
                    className='flex flex-col gap-1 text-warning-600'
                    role='alert'
                    data-testid='custom-format-unsupported'
                >
                    <span>{tx('format_unsupported')}</span>
                    {confirm?.kind === 'reset' ? (
                        <ConfirmRow
                            label={tx('reset_confirm')}
                            busy={busy}
                            onConfirm={runConfirmed}
                            onCancel={() => setConfirm(null)}
                            tx={tx}
                        />
                    ) : (
                        <Button
                            size='sm'
                            variant='flat'
                            color='warning'
                            className='h-[22px] min-w-0 self-start px-2 text-[12px]'
                            onPress={() => setConfirm({ kind: 'reset' })}
                        >
                            {tx('reset')}
                        </Button>
                    )}
                </div>
            )}

            {readable && custom.unreadableCount > 0 && (
                <div
                    className='flex flex-col gap-1 text-warning-600'
                    role='status'
                    data-testid='custom-unreadable'
                >
                    <span>{tx('unreadable', { count: custom.unreadableCount })}</span>
                    {confirm?.kind === 'purge' ? (
                        <ConfirmRow
                            label={tx('purge_confirm')}
                            busy={busy}
                            onConfirm={runConfirmed}
                            onCancel={() => setConfirm(null)}
                            tx={tx}
                        />
                    ) : (
                        <Button
                            size='sm'
                            variant='flat'
                            className='h-[22px] min-w-0 self-start px-2 text-[12px]'
                            onPress={() => setConfirm({ kind: 'purge' })}
                        >
                            {tx('purge')}
                        </Button>
                    )}
                </div>
            )}

            {readable && custom.actions.length === 0 && !form && (
                <span
                    className='text-default-500'
                    data-testid='custom-empty'
                >
                    {tx('empty')}
                </span>
            )}

            {readable && (
                <ul
                    className='flex flex-col gap-0.5'
                    data-testid='custom-list'
                >
                    {custom.actions.map((action) => (
                        <li
                            key={action.id}
                            className='flex flex-col gap-0.5'
                            data-testid={`custom-row-${action.id}`}
                        >
                            <div className='flex items-center gap-1'>
                                <CustomActionIcon icon={action.icon} />
                                <span className='flex-1 truncate'>{action.name}</span>
                                <span className='max-w-[40%] truncate text-[11px] text-default-500'>
                                    {instanceLabel(action.instanceKey) ?? action.instanceKey}
                                </span>
                                <Button
                                    size='sm'
                                    variant='light'
                                    className='h-[22px] min-w-0 px-1.5 text-[12px]'
                                    aria-label={`${tx('edit')}: ${action.name}`}
                                    onPress={() =>
                                        open(
                                            { kind: 'edit', id: action.id, baseRevision: action.revision },
                                            draftOf(action)
                                        )
                                    }
                                >
                                    {tx('edit')}
                                </Button>
                                <Button
                                    size='sm'
                                    variant='light'
                                    color='danger'
                                    className='h-[22px] min-w-0 px-1.5 text-[12px]'
                                    aria-label={`${tx('delete')}: ${action.name}`}
                                    onPress={() =>
                                        setConfirm({ kind: 'delete', id: action.id, revision: action.revision })
                                    }
                                >
                                    {tx('delete')}
                                </Button>
                            </div>
                            {action.problem === EntryProblem.UNSUPPORTED_OUTPUT_MODE && (
                                <span className='text-[11px] text-warning-600'>
                                    {tx('errors.output-mode-unsupported')} ({action.outputMode})
                                </span>
                            )}
                            {confirm?.kind === 'delete' && confirm.id === action.id && (
                                <ConfirmRow
                                    label={tx('delete_confirm')}
                                    busy={busy}
                                    onConfirm={runConfirmed}
                                    onCancel={() => setConfirm(null)}
                                    tx={tx}
                                />
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {status && (
                <span
                    className={status.tone === 'success' ? 'text-success-600' : 'text-danger'}
                    role='status'
                    aria-live='polite'
                    data-testid='custom-status'
                >
                    {status.text}
                </span>
            )}

            {readable && form && (
                <form
                    className='flex flex-col gap-1 border-t border-default-200 pt-1'
                    data-testid='custom-form'
                    onSubmit={(event) => {
                        event.preventDefault();
                        save();
                    }}
                >
                    <span className='font-medium'>{form.kind === 'create' ? tx('new') : tx('editing')}</span>

                    {conflict && (
                        <div
                            className='flex flex-col gap-1 text-danger'
                            role='alert'
                            data-testid='custom-conflict'
                        >
                            <span>{tx(`conflict.${conflict}`)}</span>
                            {conflict === 'changed' ? (
                                <Button
                                    size='sm'
                                    variant='flat'
                                    className='h-[22px] min-w-0 self-start px-2 text-[12px]'
                                    onPress={reloadLatest}
                                >
                                    {tx('reload')}
                                </Button>
                            ) : (
                                <Button
                                    size='sm'
                                    variant='flat'
                                    className='h-[22px] min-w-0 self-start px-2 text-[12px]'
                                    onPress={saveAsNew}
                                >
                                    {tx('save_as_new')}
                                </Button>
                            )}
                        </div>
                    )}

                    <Input
                        size='sm'
                        radius='sm'
                        label={tx('name')}
                        value={draft.name}
                        maxLength={MAX_NAME_LENGTH * 2}
                        isInvalid={Boolean(errors.name)}
                        errorMessage={errors.name ? errorText(errors.name) : undefined}
                        onValueChange={field('name')}
                        data-testid='custom-name'
                    />
                    <ChoiceSelect
                        label={tx('service')}
                        placeholder={tx('choose_service')}
                        value={draft.instanceKey}
                        options={[
                            // A stored reference to a service that is gone stays visible, never swapped.
                            ...(!knownInstance && draft.instanceKey !== ''
                                ? [
                                      {
                                          value: draft.instanceKey,
                                          label: `${draft.instanceKey} (${tx('not_configured')})`,
                                      },
                                  ]
                                : []),
                            ...instances.map((instance) => ({ value: instance.key, label: instance.label })),
                        ]}
                        onChange={field('instanceKey')}
                        error={errors.instanceKey ? errorText(errors.instanceKey) : null}
                        testId='custom-service'
                    />
                    <Textarea
                        size='sm'
                        radius='sm'
                        minRows={3}
                        maxRows={8}
                        label={tx('instruction')}
                        placeholder={tx('instruction_placeholder')}
                        value={draft.instruction}
                        isInvalid={Boolean(errors.instruction)}
                        errorMessage={errors.instruction ? errorText(errors.instruction) : undefined}
                        description={`${[...draft.instruction].length} / ${MAX_INSTRUCTION_LENGTH}`}
                        onValueChange={field('instruction')}
                        data-testid='custom-instruction'
                    />
                    <div className='flex gap-1'>
                        <div className='flex-1'>
                            <ChoiceSelect
                                label={tx('icon')}
                                value={draft.icon}
                                options={[
                                    { value: '', label: tx('no_icon') },
                                    ...CUSTOM_ICON_IDS.map((id) => ({
                                        value: id,
                                        label: tx(`icons.${id}`),
                                        icon: <CustomActionIcon icon={id} />,
                                    })),
                                ]}
                                onChange={field('icon')}
                                error={errors.icon ? errorText(errors.icon) : null}
                                testId='custom-icon'
                            />
                        </div>
                        <div className='flex-1'>
                            <ChoiceSelect
                                label={tx('output_mode')}
                                value={draft.outputMode}
                                options={[
                                    ...(unsupportedStoredMode !== null
                                        ? [
                                              {
                                                  value: unsupportedStoredMode,
                                                  label: `${unsupportedStoredMode} (${tx('unsupported')})`,
                                                  disabled: true,
                                              },
                                          ]
                                        : []),
                                    { value: CustomOutputMode.POPUP, label: tx('output_popup') },
                                ]}
                                onChange={field('outputMode')}
                                error={errors.outputMode ? errorText(errors.outputMode) : null}
                                testId='custom-output-mode'
                            />
                        </div>
                    </div>
                    {errors.form && (
                        <span
                            className='text-danger'
                            role='alert'
                        >
                            {errorText(errors.form)}
                        </span>
                    )}
                    <div className='flex items-center gap-1'>
                        <Button
                            type='submit'
                            size='sm'
                            color='primary'
                            className='h-[22px] min-w-0 px-2 text-[12px]'
                            isDisabled={busy || Boolean(conflict)}
                            data-testid='custom-save'
                        >
                            {tx('save')}
                        </Button>
                        <Button
                            size='sm'
                            variant='light'
                            className='h-[22px] min-w-0 px-2 text-[12px]'
                            onPress={close}
                        >
                            {tx('cancel')}
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
}

function ConfirmRow({ label, busy, onConfirm, onCancel, tx }) {
    return (
        <div
            className='flex items-center gap-1'
            role='alertdialog'
            aria-label={label}
        >
            <span className='flex-1 break-words text-danger'>{label}</span>
            <Button
                size='sm'
                color='danger'
                className='h-[22px] min-w-0 px-2 text-[12px]'
                isDisabled={busy}
                onPress={onConfirm}
                data-testid='custom-confirm'
            >
                {tx('confirm')}
            </Button>
            <Button
                size='sm'
                variant='light'
                className='h-[22px] min-w-0 px-2 text-[12px]'
                onPress={onCancel}
            >
                {tx('cancel')}
            </Button>
        </div>
    );
}

// A choice among a few options as an in-window dropdown, like the other palette menus. A native
// <select> opens an OS-level popup, and the Translate window hides itself when it loses focus.
function ChoiceSelect({ label, placeholder = '', value, options, onChange, error, testId }) {
    const keyOf = (option) => (option.value === '' ? '__none__' : option.value);
    const current = options.find((option) => option.value === value);
    return (
        <div className='flex flex-col gap-0.5'>
            <span className='text-[11px] text-default-500'>{label}</span>
            <Dropdown>
                <DropdownTrigger>
                    <Button
                        size='sm'
                        variant='bordered'
                        radius='sm'
                        aria-label={label}
                        aria-invalid={Boolean(error)}
                        className='h-[28px] w-full min-w-0 justify-between px-2 text-[12px]'
                        endContent={<MdArrowDropDown className='text-[16px]' />}
                        data-testid={testId}
                    >
                        <span className='flex min-w-0 items-center gap-1'>
                            {current?.icon}
                            <span className='truncate'>{current ? current.label : placeholder}</span>
                        </span>
                    </Button>
                </DropdownTrigger>
                <DropdownMenu
                    aria-label={label}
                    className='max-h-[40vh] overflow-y-auto'
                    selectionMode='single'
                    disallowEmptySelection
                    selectedKeys={current ? [keyOf(current)] : []}
                    onAction={(key) => {
                        const option = options.find((candidate) => keyOf(candidate) === String(key));
                        if (option) onChange(option.value);
                    }}
                >
                    {options.map((option) => (
                        <DropdownItem
                            key={keyOf(option)}
                            isDisabled={option.disabled}
                            startContent={option.icon}
                        >
                            {option.label}
                        </DropdownItem>
                    ))}
                </DropdownMenu>
            </Dropdown>
            {error && <span className='text-danger'>{error}</span>}
        </div>
    );
}
