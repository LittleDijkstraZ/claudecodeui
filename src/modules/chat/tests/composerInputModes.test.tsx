import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }) }));
vi.mock('@/modules/workspace-panels', () => ({ AgentsStatus: () => null, useWorkspacePanelActions: () => null }));
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({ useVoiceInput: () => ({ state: 'idle', toggle: vi.fn(), stop: vi.fn() }) }));

function fixture() {
  const props: ComponentProps<typeof ChatComposer> = {
    pendingPermissionRequests: [], handlePermissionDecision: vi.fn(), handleGrantToolPermission: () => ({ success: true }),
    activity: { startedAt: 1, statusText: null, canInterrupt: true, phase: 'foreground', acceptsInput: true, inputModes: ['queue', 'interrupt'], backgroundTasks: 2 },
    isLoading: false, onAbortSession: vi.fn(), onInterruptAndSend: vi.fn(), permissionMode: 'default', availablePermissionModes: ['default'], onSelectPermissionMode: vi.fn(),
    providerLabel: 'Claude', provider: 'claude', effort: 'high', availableEffortOptions: [{ value: 'high' }], onSelectEffort: vi.fn(),
    model: 'A-very-long-remote-model-name', availableModelOptions: [], onSelectModel: vi.fn(), modelsLoading: false, modelDetails: null,
    tokenBudget: null, onShowTokenUsage: vi.fn(), slashCommandsCount: 0, onToggleCommandMenu: vi.fn(), hasInput: true, onClearInput: vi.fn(), onSubmit: vi.fn(event => event.preventDefault()),
    isDragActive: false, queuedDraft: null, isEditingSentMessage: false, onCancelEditMessage: vi.fn(), scheduledMessages: [], onScheduleMessage: vi.fn(), onCancelScheduledMessage: vi.fn(),
    onEditQueuedDraft: vi.fn(), onDeleteQueuedDraft: vi.fn(), attachedFiles: [], onRemoveAttachment: vi.fn(), fileErrors: new Map(), showFileDropdown: false,
    filteredFiles: [], selectedFileIndex: 0, onSelectFile: vi.fn(), filteredCommands: [], selectedCommandIndex: 0, onCommandSelect: vi.fn(), onCloseCommandMenu: vi.fn(),
    isCommandMenuOpen: false, frequentCommands: [], getRootProps: () => ({}), getInputProps: () => ({}), openAttachmentPicker: vi.fn(),
    inputHighlightRef: createRef(), renderInputWithMentions: text => text, textareaRef: createRef(), input: 'A new direction',
    onInputChange: vi.fn(), onTextareaClick: vi.fn(), onTextareaKeyDown: vi.fn(), onTextareaPaste: vi.fn(), onTextareaScrollSync: vi.fn(), onTextareaInput: vi.fn(),
    placeholder: 'Message Claude', isTextareaExpanded: false,
  };
  return { props, ...render(<ChatComposer {...props} />) };
}

test('a writable running reply shows distinct Queue and Interrupt buttons; Interrupt never triggers form send or Stop', () => {
  const { props } = fixture();
  fireEvent.click(screen.getByRole('button', { name: 'Queue next message' }));
  expect(props.onSubmit).toHaveBeenCalledTimes(1);
  expect(props.onInterruptAndSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Interrupt and send' }));
  expect(props.onInterruptAndSend).toHaveBeenCalledTimes(1);
  expect(props.onSubmit).toHaveBeenCalledTimes(1);
  expect(props.onAbortSession).not.toHaveBeenCalled();
});

test('an older remote keeps Queue usable but disables unsupported Interrupt', () => {
  const { props, rerender } = fixture();
  rerender(<ChatComposer {...props} activity={{ ...props.activity!, inputModes: undefined }} />);
  const interrupt = screen.getByRole('button', { name: 'Interrupt and send' });
  expect(interrupt.hasAttribute("disabled")).toBe(true);
  fireEvent.click(interrupt);
  expect(props.onInterruptAndSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Queue next message' }));
  expect(props.onSubmit).toHaveBeenCalledOnce();
});

test('an empty draft or editing an earlier message never enables interrupt-and-send', () => {
  const { props, rerender } = fixture();
  rerender(<ChatComposer {...props} input="" hasInput={false} />);
  expect(screen.getByRole('button', { name: 'Interrupt and send' }).hasAttribute('disabled')).toBe(true);
  rerender(<ChatComposer {...props} isEditingSentMessage />);
  expect(screen.getByRole('button', { name: 'Interrupt and send' }).hasAttribute('disabled')).toBe(true);
});
