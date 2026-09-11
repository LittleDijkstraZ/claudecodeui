import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }) }));
vi.mock('@/modules/workspace-panels', () => ({ AgentsStatus: () => null, useWorkspacePanelActions: () => null }));
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({ useVoiceInput: () => ({ state: 'idle', toggle: vi.fn(), stop: vi.fn() }) }));

function fixture() {
  const props: ComponentProps<typeof ChatComposer> = {
    pendingPermissionRequests: [], handlePermissionDecision: vi.fn(), handleGrantToolPermission: () => ({ success: true }),
    activity: { startedAt: 1, statusText: null, canInterrupt: true, phase: 'foreground', acceptsInput: true, inputModes: ['queue', 'interrupt'], canInterruptQueuedMessages: true, backgroundTasks: 2 },
    isLoading: false, onAbortSession: vi.fn(), onInterruptQueuedMessage: vi.fn(), permissionMode: 'default', availablePermissionModes: ['default'], onSelectPermissionMode: vi.fn(),
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

const QUEUED = { type: 'user' as const, content: 'The queued question', timestamp: 1, delivery: 'queued' as const, clientMessageId: 'queued-one' };

test('Interrupt is hidden until a message has actually been queued', () => {
  const { props, rerender } = fixture();
  expect(screen.queryByRole('button', { name: /Interrupt/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Queue next message' }));
  expect(props.onSubmit).toHaveBeenCalledOnce();
  expect(props.onInterruptQueuedMessage).not.toHaveBeenCalled();
  rerender(<ChatComposer {...props} input="" hasInput={false} queuedMessages={[QUEUED]} />);
  const card = screen.getByTestId('queued-message-card');
  fireEvent.click(within(card).getByRole('button', { name: 'Interrupt to process queued messages' }));
  expect(props.onInterruptQueuedMessage).toHaveBeenCalledWith('queued-one');
  expect(props.onSubmit).toHaveBeenCalledOnce();
  expect(props.onAbortSession).not.toHaveBeenCalled();
  rerender(<ChatComposer {...props} queuedMessages={[]} />);
  expect(screen.queryByRole('button', { name: /Interrupt/ })).toBeNull();
});

test('a remote must advertise queued interrupt independently from draft interrupt support', () => {
  const { props, rerender } = fixture();
  rerender(<ChatComposer {...props} queuedMessages={[QUEUED]} activity={{ ...props.activity!, canInterruptQueuedMessages: undefined }} />);
  const interrupt = screen.getByRole('button', { name: 'Interrupt to process queued messages' });
  expect(interrupt.hasAttribute('disabled')).toBe(true);
  fireEvent.click(interrupt);
  expect(props.onInterruptQueuedMessage).not.toHaveBeenCalled();
});

test('queued controls stay independent of a new draft and show pending/error states in the same card', () => {
  const { props, rerender } = fixture();
  rerender(<ChatComposer {...props} queuedMessages={[QUEUED, { ...QUEUED, clientMessageId: 'queued-two', content: 'Another queued question' }]} interruptingMessageId="queued-one" />);
  expect(screen.getAllByTestId('queued-message-card')).toHaveLength(1);
  expect(screen.getByText('Another queued question')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Interrupt to process queued messages' }).hasAttribute('disabled')).toBe(true);
  rerender(<ChatComposer {...props} queuedMessages={[QUEUED]} interruptError="Could not interrupt" />);
  expect(within(screen.getByTestId('queued-message-card')).getByRole('alert').textContent).toBe('Could not interrupt');
});

test('background workflow leaves the composer in Send mode', () => {
  const { props, rerender } = fixture();
  rerender(<ChatComposer {...props} activity={{ ...props.activity!, phase: 'background' }} />);
  expect(screen.queryByRole('button', { name: 'Queue next message' })).toBeNull();
  expect(screen.getByRole('button', { name: 'input.send' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Interrupt/ })).toBeNull();
});
