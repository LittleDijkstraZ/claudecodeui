import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { MessageDeliveryStatus } from '@/modules/chat/transcript/MessageDeliveryStatus';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import { readQueuedMessage, resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, Project, ServerEvent, SessionActivity } from '@/shared/types';

const { uploadFiles, createSession, readIdentity } = vi.hoisted(() => ({ uploadFiles: vi.fn(), createSession: vi.fn(), readIdentity: vi.fn() }));
vi.mock('@/shared/api', () => {
  const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return { claudeExecutionSettingsApi: { identity: readIdentity }, api: {
    assets: { uploadFiles },
    user: { drafts: () => ok({ drafts: [] }), saveDraft: () => ok({}), deleteDraft: () => ok({}), preferences: () => ok({ preferences: {} }), savePreferences: () => ok({}) },
    commands: { list: () => ok({ commands: [] }) }, files: { search: () => ok({ files: [] }) },
    getFiles: () => ok([]), providers: { createSession, skills: () => ok({ data: { skills: [] } }) },
  } };
});

const PROJECT: Project = { projectId: 'remote-project', displayName: 'Remote project', fullPath: '/remote/work' };
const BACKGROUND: SessionActivity = { startedAt: 100, statusText: null, canInterrupt: true, phase: 'background', acceptsInput: true, backgroundTasks: 2, executionId: 'execution-one' };
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => {
  localStorage.clear(); resetChatDrafts(); uploadFiles.mockReset(); createSession.mockReset();
  readIdentity.mockReset().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { sessionId: 'session-a', providerSessionId: 'native-a' } }) });
});

function composer(activity: SessionActivity, connected = true, sessionId: string | null = 'session-a') {
  const send = vi.fn<(message: unknown) => boolean>(() => connected);
  const add = vi.fn<(message: ChatMessage) => void>();
  const processing = vi.fn();
  const view = renderHook(({ sessionId }: { sessionId: string | null }) => useChatComposerState({
    selectedProject: PROJECT, selectedSession: sessionId ? { id: sessionId } : null, currentSessionId: sessionId, provider: 'claude',
    permissionMode: 'default', cyclePermissionMode: () => {}, resolvePermissionModeForProvider: () => 'default',
    currentProviderModel: 'remote-alias', currentProviderEffort: 'high',
    isLoading: activity.acceptsInput !== true, processingSessions: new Map([['session-a', activity]]),
    canAbortSession: true, tokenBudget: null, sendMessage: send, onSessionProcessing: processing,
    scrollToBottom: () => {}, addMessage: add, setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {},
  }), { initialProps: { sessionId } });
  const submit = async (content: string) => {
    await act(async () => view.result.current.setInput(content));
    await act(async () => view.result.current.handleSubmit({ preventDefault() {} } as never));
  };
  return { ...view, send, add, processing, submit };
}

test.each(['background', 'foreground'] as const)('a live %s query accepts multiple messages without aborting or starting another execution', async phase => {
  const view = composer({ ...BACKGROUND, phase });
  await view.submit('same question');
  await view.submit('same question');
  expect(view.send).toHaveBeenCalledTimes(2);
  const frames = view.send.mock.calls.map(call => call[0]) as unknown as Array<Record<string, unknown>>;
  expect(frames.map(frame => [frame.type, frame.sessionId])).toEqual([['chat.send', 'session-a'], ['chat.send', 'session-a']]);
  expect(frames[0].clientMessageId).not.toBe(frames[1].clientMessageId);
  expect(frames.map(frame => (frame.options as Record<string, unknown>).deliveryMode)).toEqual(['queue', 'queue']);
  expect(String(frames[0].clientMessageId)).toMatch(/^[0-9a-f-]{36}$/);
  expect(view.processing).not.toHaveBeenCalled();
  expect(view.add.mock.calls.map(([message]) => message.delivery)).toEqual(['queued', 'queued']);
  expect(readQueuedMessage('session-a')).toBeNull();
});

test.each([undefined])('missing input capability (%s) asks the remote to admit the explicit send', async acceptsInput => {
  const view = composer({ startedAt: 100, statusText: null, canInterrupt: true, acceptsInput });
  await view.submit('Check this input');
  expect(view.send).toHaveBeenCalledTimes(1);
  expect(view.send.mock.calls[0][0]).toMatchObject({ type: 'chat.send', sessionId: 'session-a', content: 'Check this input' });
  expect(readQueuedMessage('session-a')).toBeNull();
  expect(view.add.mock.calls.map(([message]) => message.delivery)).toEqual(['queued']);
  expect(view.processing).not.toHaveBeenCalled();
});

test('explicitly closed input keeps Queue in a durable context-bound draft without sending a websocket prompt', async () => {
  const view = composer({ ...BACKGROUND, acceptsInput: false });
  await view.submit('Wait for the current process');
  expect(view.send).not.toHaveBeenCalled();
  expect(view.add).not.toHaveBeenCalled();
  expect(readIdentity).toHaveBeenCalledWith('session-a');
  expect(readQueuedMessage('session-a')).toMatchObject({ content: 'Wait for the current process', providerSessionId: 'native-a' });
  expect(view.result.current.queuedDraft).toMatchObject({ content: 'Wait for the current process', providerSessionId: 'native-a' });
  expect(view.result.current.input).toBe('');
  expect(view.processing).not.toHaveBeenCalled();
});

test('a second Queue keeps the existing queued message and retains the new draft', async () => {
  const view = composer({ ...BACKGROUND, acceptsInput: false });
  await view.submit('First queued message');
  await view.submit('Second draft to keep');
  expect(readQueuedMessage('session-a')?.content).toBe('First queued message');
  expect(view.result.current.queuedDraft?.content).toBe('First queued message');
  expect(view.result.current.input).toBe('Second draft to keep');
  expect(view.send).not.toHaveBeenCalled();
  expect(readIdentity).toHaveBeenCalledTimes(1);
});

test('a closed-input queue preserves uploaded attachments and its original context across remount', async () => {
  uploadFiles.mockResolvedValueOnce({ ok: true, json: async () => ({ attachments: [{ path: '/uploads/queued.txt' }] }) });
  const view = composer({ ...BACKGROUND, acceptsInput: false });
  const file = new File(['saved'], 'queued.txt');
  await act(async () => { view.result.current.setInput('Saved with attachment'); view.result.current.setAttachedFiles([file]); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  expect(readQueuedMessage('session-a')).toMatchObject({ providerSessionId: 'native-a', attachments: [{ path: '/uploads/queued.txt' }] });
  expect(view.send).not.toHaveBeenCalled();
  view.unmount();
  const restored = composer({ ...BACKGROUND, acceptsInput: false });
  expect(restored.result.current.queuedDraft).toMatchObject({ providerSessionId: 'native-a', uploadedAttachments: [{ path: '/uploads/queued.txt' }] });
  await act(async () => restored.result.current.editQueuedDraft());
  expect(restored.result.current.input).toBe('Saved with attachment');
  expect(readQueuedMessage('session-a')).toMatchObject({ providerSessionId: 'native-a', rewindPaused: true, attachments: [{ path: '/uploads/queued.txt' }] });
  expect(uploadFiles).toHaveBeenCalledOnce();
});

test('an unavailable native context keeps the unsent draft instead of creating an unbound deferred send', async () => {
  readIdentity.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { sessionId: 'session-a', providerSessionId: null } }) });
  const view = composer({ ...BACKGROUND, acceptsInput: false });
  await view.submit('Keep while starting');
  expect(view.result.current.input).toBe('Keep while starting');
  expect(readQueuedMessage('session-a')).toBeNull();
  expect(view.send).not.toHaveBeenCalled();
});

test('rewind during closed-input queue preparation preserves the draft and never queues into the replacement context', async () => {
  let release!: (value: unknown) => void;
  readIdentity.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = composer({ ...BACKGROUND, acceptsInput: false });
  await act(async () => view.result.current.setInput('Original context question'));
  let pending!: Promise<void>;
  await act(async () => { pending = view.result.current.handleSubmit({ preventDefault() {} } as never); await Promise.resolve(); });
  act(() => window.dispatchEvent(new CustomEvent('cloudcli:session-mutation', { detail: { sessionId: 'session-a', requestId: 'rewind-during-queue', phase: 'started' } })));
  await act(async () => { release({ ok: true, json: async () => ({ success: true, data: { sessionId: 'session-a', providerSessionId: 'native-a' } }) }); await pending; });
  expect(readQueuedMessage('session-a')).toBeNull();
  expect(view.result.current.input).toBe('Original context question');
  expect(view.send).not.toHaveBeenCalled();
});

test('a disconnected send is explicitly not delivered and never stops the Workflow', async () => {
  const view = composer(BACKGROUND, false);
  await view.submit('question');
  expect(view.add.mock.calls.map(([message]) => message.delivery)).toEqual(['queued', 'failed']);
  expect(view.processing).not.toHaveBeenCalled();
  expect(view.send.mock.calls).toHaveLength(1);
});

function handlers(checkedAt?: number) {
  const lastSeqRef = { current: new Map<string, number>() };
  const lastRunRef = { current: new Map<string, { runId: string; startedAt?: number }>() };
  let listener: (event: ServerEvent) => void = () => {};
  const subscribe = (next: typeof listener) => { listener = next; return () => {}; };
  const refresh = vi.fn(async () => {});
  const view = renderHook(() => {
    const store = useSessionStore();
    const protection = useSessionProtection();
    useChatRealtimeHandlers({
      isActive: true, subscribe, provider: 'claude', selectedSession: { id: 'session-a' }, currentSessionId: 'session-a',
      setTokenBudget: () => {}, pendingPermissionRequests: [], setPendingPermissionRequests: () => {},
      lastSeqRef, lastRunRef, statusCheckSentAtRef: { current: checkedAt === undefined ? new Map() : new Map([['session-a', checkedAt]]) },
      onSessionProcessing: protection.markSessionProcessing, onSessionIdle: protection.markSessionIdle,
      requestLatestMessages: refresh, sessionStore: store,
    });
    return { store, protection };
  });
  return { ...view, refresh, lastSeqRef, lastRunRef, emit: (event: ServerEvent) => act(() => listener(event)) };
}

const receipt = (delivery: string, sessionId = 'session-a'): ServerEvent => ({ kind: 'status', text: 'message_delivery', delivery, sessionId, clientMessageId: '16dfd601-35b0-409f-aec3-f6cb10b48441', content: 'question', timestamp: '2026-09-07T00:00:00Z' });

test('replayed pending input becomes delivered only on its own acknowledgement, while the Workflow remains active', () => {
  const view = handlers();
  view.emit({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: true, ...BACKGROUND });
  view.emit(receipt('queued'));
  expect(view.result.current.store.getMessages('session-a')[0].delivery).toBe('queued');
  expect(view.result.current.protection.processingSessions.get('session-a')?.phase).toBe('background');
  view.emit(receipt('delivered', 'session-b'));
  expect(view.result.current.store.getMessages('session-a')[0].delivery).toBe('queued');
  view.emit(receipt('delivered'));
  view.emit(receipt('queued'));
  const messages = view.result.current.store.getMessages('session-a');
  expect(messages).toHaveLength(1);
  expect(messages[0].delivery).toBe('delivered');
  expect(view.result.current.protection.processingSessions.has('session-a')).toBe(true);
});

test('a rejected queued prompt cannot clear the running execution or fail a different prompt', () => {
  const view = handlers();
  view.emit({ kind: 'status', text: 'claude_runtime_state', sessionId: 'session-a', ...BACKGROUND });
  view.emit(receipt('queued'));
  view.emit({ kind: 'protocol_error', sessionId: 'session-a', clientMessageId: '16dfd601-35b0-409f-aec3-f6cb10b48441', error: 'Input stream closed', code: 'INPUT_CLOSED' });
  expect(view.result.current.store.getMessages('session-a').find(message => message.role === 'user')?.delivery).toBe('failed');
  view.emit(receipt('queued'));
  expect(view.result.current.store.getMessages('session-a').find(message => message.role === 'user')?.delivery).toBe('failed');
  expect(view.result.current.protection.processingSessions.get('session-a')?.executionId).toBe('execution-one');
});

test('message and activity UI distinguish waiting, delivery and background work', () => {
  const message = { type: 'user', timestamp: 1, delivery: 'queued' as const };
  const view = render(<><MessageDeliveryStatus message={message} /><ActivityIndicator activity={BACKGROUND} /></>);
  expect(view.getByRole('status').textContent).toMatch(/Waiting|等待/);
  expect(view.container.textContent).toMatch(/background|后台|背景/);
  expect(view.container.textContent).not.toContain('Thinking');
  view.rerender(<MessageDeliveryStatus message={{ ...message, delivery: 'delivered' }} />);
  expect(view.getByRole('status').textContent).toMatch(/Delivered|已送/);
  view.rerender(<MessageDeliveryStatus message={{ ...message, delivery: 'failed', deliveryError: 'Process ended before acknowledgement' }} />);
  expect(view.getByRole('status').textContent).toMatch(/Delivery unconfirmed|未确认送达|未確認送達/);
  expect(view.getByRole('status').getAttribute('title')).toBe('Process ended before acknowledgement');
});

test('a foreground response refreshes the transcript once while keeping background execution protected', () => {
  const view = handlers();
  view.emit({ kind: 'status', text: 'claude_runtime_state', sessionId: 'session-a', ...BACKGROUND });
  const event = { kind: 'status', text: 'foreground_complete', sessionId: 'session-a', runId: 'run-one', seq: 12 };
  view.emit(event);
  view.emit(event);
  expect(view.refresh).toHaveBeenCalledTimes(1);
  expect(view.refresh).toHaveBeenCalledWith('session-a', true);
  expect(view.result.current.protection.processingSessions.get('session-a')?.phase).toBe('background');
  view.emit({ ...event, seq: 24 });
  expect(view.refresh).toHaveBeenCalledTimes(2);
});

test('task control acknowledgements never change queued delivery or foreground state', () => {
  const view = handlers();
  view.emit({ kind: 'status', text: 'claude_runtime_state', sessionId: 'session-a', ...BACKGROUND, canInterruptQueuedMessages: true, canStopTask: true });
  view.emit(receipt('queued'));
  for (const text of ['queued_input_interrupt', 'task_stop']) {
    view.emit({ kind: 'status', text, sessionId: 'session-a', status: 'failed', clientMessageId: '16dfd601-35b0-409f-aec3-f6cb10b48441', error: 'Could not control task' });
  }
  expect(view.result.current.protection.processingSessions.get('session-a')).toMatchObject({ phase: 'background', statusText: null, canInterruptQueuedMessages: true, canStopTask: true });
  expect(view.result.current.store.getMessages('session-a').find(message => message.clientMessageId)?.delivery).toBe('queued');
  view.emit({ kind: 'status', text: 'claude_runtime_state', sessionId: 'session-a', ...BACKGROUND, executionId: 'replacement-execution' });
  expect(view.result.current.protection.processingSessions.get('session-a')?.canInterruptQueuedMessages).toBeUndefined();
  expect(view.result.current.protection.processingSessions.get('session-a')?.canStopTask).toBeUndefined();
});

test('explicit sends with stale activity remain separate UUID requests without a deferred draft queue', async () => {
  const view = composer({ startedAt: 100, statusText: null, canInterrupt: true });
  await view.submit('First message');
  await view.submit('Second message');
  expect(readQueuedMessage('session-a')).toBeNull();
  expect(view.send).toHaveBeenCalledTimes(2);
  const frames = view.send.mock.calls.map(([frame]) => frame as Record<string, unknown>);
  expect(frames[0].clientMessageId).not.toBe(frames[1].clientMessageId);
  expect(frames.map(frame => frame.type)).toEqual(['chat.send', 'chat.send']);
});

test('a completed run subscription restores only matching valid delivery receipts without replaying arbitrary content', () => {
  const view = handlers();
  view.emit(receipt('queued'));
  view.emit({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: false, messageReceipts: [
    receipt('failed'),
    { ...receipt('delivered'), sessionId: 'session-b' },
    { ...receipt('queued'), clientMessageId: 'malformed', content: 'Invalid receipt' },
    { kind: 'text', role: 'assistant', sessionId: 'session-a', content: 'Must not replay' },
  ] });
  const messages = view.result.current.store.getMessages('session-a');
  expect(messages).toHaveLength(1);
  expect(messages[0].delivery).toBe('failed');
  expect(view.result.current.store.getMessages('session-b')).toEqual([]);
  expect(view.refresh).not.toHaveBeenCalled();
});


test('stale capability does not lose an attachment; remote admission receives its durable reference', async () => {
  uploadFiles.mockResolvedValueOnce({ ok: true, json: async () => ({ attachments: [{ path: '/uploads/fixture.txt' }] }) });
  const view = composer({ startedAt: 100, statusText: null, canInterrupt: true });
  const file = new File(['fixture'], 'fixture.txt');
  await act(async () => { view.result.current.setInput('Attachment'); view.result.current.setAttachedFiles([file]); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  expect(uploadFiles).toHaveBeenCalledTimes(1);
  expect(view.send).toHaveBeenCalledTimes(1);
  expect(view.send.mock.calls[0][0]).toMatchObject({ options: { attachments: [{ path: '/uploads/fixture.txt' }] } });
  expect(view.add.mock.calls[0][0].files).toEqual([{ path: '/uploads/fixture.txt' }]);
});

test('edit sends have a stable input UUID so disconnected edits retain a failed user copy', async () => {
  const view = composer(BACKGROUND, false);
  await act(async () => { view.result.current.beginEditMessage({ type: 'user', content: 'Old wording', timestamp: 1, transcriptAnchorId: 'old-anchor' }); });
  await view.submit('Edited wording');
  const frame = view.send.mock.calls[0][0] as Record<string, unknown>;
  expect(frame.type).toBe('chat.edit-send');
  expect(frame.anchorId).toBe('old-anchor');
  expect(String(frame.clientMessageId)).toMatch(/^[0-9a-f-]{36}$/);
  expect(view.add.mock.calls.map(([message]) => message.delivery)).toEqual(['queued', 'failed']);
  expect(view.add.mock.calls[0][0].clientMessageId).toBe(view.add.mock.calls[1][0].clientMessageId);
});


test('double Enter during a normal upload sends the unchanged draft only once', async () => {
  let release!: (value: unknown) => void;
  uploadFiles.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = composer(BACKGROUND);
  await act(async () => { view.result.current.setInput('One message'); view.result.current.setAttachedFiles([new File(['one'], 'one.txt')]); });
  let pending!: Promise<void>;
  await act(async () => { pending = view.result.current.handleSubmit({ preventDefault() {} } as never); await Promise.resolve(); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  expect(uploadFiles).toHaveBeenCalledTimes(1);
  await act(async () => { release({ ok: true, json: async () => ({ attachments: [{ path: 'one.txt' }] }) }); await pending; });
  expect(view.send).toHaveBeenCalledTimes(1);
  expect(view.result.current.input).toBe('');
});

test('double Enter while allocating a conversation creates one session and sends once', async () => {
  let release!: (value: unknown) => void;
  createSession.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = composer(BACKGROUND, true, null);
  await act(async () => { view.result.current.setInput('First message'); });
  let pending!: Promise<void>;
  await act(async () => { pending = view.result.current.handleSubmit({ preventDefault() {} } as never); await Promise.resolve(); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  expect(createSession).toHaveBeenCalledTimes(1);
  await act(async () => { release({ ok: true, json: async () => ({ data: { sessionId: 'allocated-session' } }) }); await pending; });
  expect(view.send).toHaveBeenCalledTimes(1);
  expect(view.send.mock.calls[0][0]).toMatchObject({ sessionId: 'allocated-session', content: 'First message' });
});

test.each([true, false])('upload completion preserves a same-text draft in another session (acceptsInput=%s)', async acceptsInput => {
  let release!: (value: unknown) => void;
  uploadFiles.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = composer({ ...BACKGROUND, acceptsInput });
  await act(async () => { view.result.current.setInput('Same wording'); view.result.current.setAttachedFiles([new File(['one'], 'one.txt')]); });
  let pending!: Promise<void>;
  await act(async () => { pending = view.result.current.handleSubmit({ preventDefault() {} } as never); await Promise.resolve(); });
  view.rerender({ sessionId: 'session-b' });
  await act(async () => { view.result.current.setInput('Same wording'); });
  await act(async () => { release({ ok: true, json: async () => ({ attachments: [{ path: 'one.txt' }] }) }); await pending; });
  expect(view.result.current.input).toBe('Same wording');
  if (acceptsInput) {
    expect(view.send.mock.calls[0][0]).toMatchObject({ sessionId: 'session-a' });
    expect(readQueuedMessage('session-a')).toBeNull();
  } else {
    expect(view.send).not.toHaveBeenCalled();
    expect(readQueuedMessage('session-a')).toMatchObject({ content: 'Same wording', providerSessionId: 'native-a', attachments: [{ path: 'one.txt' }] });
  }
});

test.each([true, false])('upload completion preserves attachments added without changing the text (acceptsInput=%s)', async acceptsInput => {
  let release!: (value: unknown) => void;
  uploadFiles.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = new File(['one'], 'one.txt');
  const second = new File(['two'], 'two.txt');
  const view = composer({ ...BACKGROUND, acceptsInput });
  await act(async () => { view.result.current.setInput('Same wording'); view.result.current.setAttachedFiles([first]); });
  let pending!: Promise<void>;
  await act(async () => { pending = view.result.current.handleSubmit({ preventDefault() {} } as never); await Promise.resolve(); });
  await act(async () => { view.result.current.setAttachedFiles([first, second]); });
  await act(async () => { release({ ok: true, json: async () => ({ attachments: [{ path: 'one.txt' }] }) }); await pending; });
  expect(view.result.current.input).toBe('Same wording');
  expect(view.result.current.attachedFiles).toEqual([first, second]);
});

test('an editing anchor cannot carry into another conversation', async () => {
  const view = composer(BACKGROUND);
  await act(async () => { view.result.current.beginEditMessage({ type: 'user', content: 'Edit A', timestamp: 1, transcriptAnchorId: 'anchor-a' }); });
  expect(view.result.current.editingAnchorId).toBe('anchor-a');
  view.rerender({ sessionId: 'session-b' });
  expect(view.result.current.editingAnchorId).toBeNull();
  await view.submit('New message B');
  expect(view.send.mock.calls[0][0]).toMatchObject({ type: 'chat.send', sessionId: 'session-b' });
  expect(view.send.mock.calls[0][0]).not.toHaveProperty('anchorId');
});


test('reconnect idle after a process restart settles old waiting copies and keeps newer sends untouched', () => {
  const localClock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-07T00:00:00Z'));
  const view = handlers(Date.parse('2026-09-07T00:00:01Z'));
  view.emit({ ...receipt('queued'), timestamp: '2026-09-07T00:00:30Z' });
  localClock.mockReturnValue(Date.parse('2026-09-07T00:00:02Z'));
  view.emit({ ...receipt('queued'), clientMessageId: '33333333-3333-4333-8333-333333333333', timestamp: '2026-09-06T23:59:32Z' });
  view.emit({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: false, messageReceipts: [] });
  expect(view.result.current.store.getMessages('session-a').map(message => message.delivery)).toEqual(['failed', 'queued']);
});

test('background progress is retained for the activity panel without overwriting foreground state', () => {
  const view = handlers();
  view.emit({ kind: 'status', text: 'claude_runtime_state', sessionId: 'session-a', phase: 'foreground', acceptsInput: true, executionId: 'exec', foregroundTurnId: 'turn1', foregroundStartedAt: '2026-09-07T00:00:00Z' });
  view.emit({ kind: 'status', workflow: true, taskId: 'task-one', text: 'Background verification', status: 'running', sessionId: 'session-a' });
  expect(view.result.current.store.getMessages('session-a').at(-1)?.text).toBe('Background verification');
  expect(view.result.current.protection.processingSessions.get('session-a')).toMatchObject({ statusText: null, foregroundTurnId: 'turn1' });
  view.emit({ kind: 'status', text: 'claude_runtime_state', sessionId: 'session-a', phase: 'background', acceptsInput: true, executionId: 'exec' });
  expect(view.result.current.protection.processingSessions.get('session-a')?.foregroundStartedAt).toBeUndefined();
});

test('manual retry creates a fresh send without reusing an edit anchor or overwriting another draft', async () => {
  const view = composer(BACKGROUND);
  await act(async () => { view.result.current.beginEditMessage({ type: 'user', timestamp: 1, content: 'Draft to keep', transcriptAnchorId: 'old-anchor' }); });
  await act(async () => view.result.current.retryUnconfirmedMessage({ type: 'user', timestamp: 1, content: 'Retry question', clientMessageId: '22222222-2222-4222-8222-222222222222', delivery: 'failed', files: [{ path: '/fixture/file.txt' }] }));
  expect(view.send).toHaveBeenCalledTimes(1);
  expect(view.send.mock.calls[0][0]).toMatchObject({ type: 'chat.send', content: 'Retry question' });
  expect((view.send.mock.calls[0][0] as Record<string, unknown>).clientMessageId).not.toBe('22222222-2222-4222-8222-222222222222');
  expect(view.result.current.input).toBe('Draft to keep');
});

test('rewind begun during an upload invalidates that preparation even if its HTTP outcome arrives first', async () => {
  let release!: (value: unknown) => void;
  uploadFiles.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = composer(BACKGROUND);
  await act(async () => { view.result.current.setInput('Draft before rewind'); view.result.current.setAttachedFiles([new File(['x'], 'x.txt')]); });
  let pending!: Promise<void>;
  await act(async () => { pending = view.result.current.handleSubmit({ preventDefault() {} } as never); await Promise.resolve(); });
  act(() => {
    window.dispatchEvent(new CustomEvent('cloudcli:session-mutation', { detail: { sessionId: 'session-a', requestId: 'fixture', phase: 'started' } }));
    window.dispatchEvent(new CustomEvent('cloudcli:session-mutation', { detail: { sessionId: 'session-a', requestId: 'fixture', phase: 'committed', result: { contextChanged: true } } }));
  });
  await act(async () => { release({ ok: true, json: async () => ({ attachments: [{ path: '/fixture/x.txt' }] }) }); await pending; });
  expect(view.send).not.toHaveBeenCalled();
  expect(view.result.current.input).toBe('Draft before rewind');
});


test('new run identity resets an old sequence cursor; late old receipts and completion cannot affect the newer run', () => {
  const view = handlers();
  view.emit({ ...receipt('queued'), runId: 'old-run', runStartedAt: 100, seq: 900 });
  expect(view.lastSeqRef.current.get('session-a')).toBe(900);
  view.emit({ kind: 'chat_subscribed', sessionId: 'session-a', runId: 'new-run', runStartedAt: 200, lastSeq: 3, isProcessing: true, ...BACKGROUND });
  expect(view.lastSeqRef.current.get('session-a'), 'A subscribe watermark is not an acknowledgement of received frames').toBe(0);
  const newId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  view.emit({ ...receipt('queued'), clientMessageId: newId, runId: 'new-run', runStartedAt: 200, seq: 1 });
  view.emit({ ...receipt('delivered'), runId: 'old-run', runStartedAt: 100, seq: 999 });
  view.emit({ kind: 'complete', sessionId: 'session-a', runId: 'old-run', runStartedAt: 100, seq: 1000 });
  expect(view.lastSeqRef.current.get('session-a')).toBe(1);
  expect(view.result.current.store.getMessages('session-a').map(message => message.delivery)).toEqual(['failed', 'queued']);
  expect(view.result.current.protection.processingSessions.has('session-a')).toBe(true);
  view.emit({ ...receipt('delivered'), clientMessageId: newId, runId: 'new-run', runStartedAt: 200, seq: 2 });
  expect(view.result.current.store.getMessages('session-a').at(-1)?.delivery).toBe('delivered');
});

test('replayed text frames cannot append or finalize an answer twice, while a new run can restart its sequence', () => {
  const view = handlers();
  const delta: ServerEvent = { kind: 'stream_delta', sessionId: 'session-a', runId: 'run-a', runStartedAt: 100,
    seq: 1, content: 'One answer', responseMessageId: 'api-a', contentBlockIndex: 0 };
  const end: ServerEvent = { ...delta, kind: 'stream_end', seq: 2, content: undefined };
  view.emit(delta);
  view.emit(delta);
  view.emit(end);
  view.emit(delta);
  view.emit(end);
  expect(view.result.current.store.getMessages('session-a').map(message => message.content)).toEqual(['One answer']);
  view.emit({ ...delta, runId: 'run-b', runStartedAt: 200, responseMessageId: 'api-b', content: 'Another answer' });
  view.emit({ ...end, runId: 'run-b', runStartedAt: 200, responseMessageId: 'api-b' });
  expect(view.result.current.store.getMessages('session-a').map(message => message.content)).toEqual(['One answer', 'Another answer']);
});

test('status watermark snapshots do not consume text sequence frames or suppress delivery receipts', () => {
  const view = handlers();
  const base = { sessionId: 'session-a', runId: 'run-a', runStartedAt: 100 };
  view.emit({ ...base, kind: 'status', seq: 10, text: 'snapshot' });
  view.emit({ ...base, kind: 'stream_delta', seq: 1, content: 'Answer', responseMessageId: 'api-a', contentBlockIndex: 0 });
  view.emit({ ...base, kind: 'stream_end', seq: 2 });
  view.emit({ ...receipt('queued'), ...base, seq: 2 });
  view.emit({ ...receipt('delivered'), ...base, seq: 2 });
  const rows = view.result.current.store.getMessages('session-a');
  expect(rows.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['Answer']);
  expect(rows.find(message => message.clientMessageId)?.delivery).toBe('delivered');
});


test.each([undefined])('retry reaches remote admission with a new UUID despite unknown capability %s, preserving another edit draft', async acceptsInput => {
  const view = composer({ startedAt: 100, statusText: null, canInterrupt: true, acceptsInput });
  const failed: ChatMessage = { type: 'user', sessionId: 'session-a', timestamp: 1, content: 'Retained question', delivery: 'failed', clientMessageId: '22222222-2222-4222-8222-222222222222', files: [{ path: '/uploads/retry.txt' }] };
  await act(async () => { view.result.current.beginEditMessage({ type: 'user', content: 'Different edit draft', transcriptAnchorId: 'different-anchor', timestamp: 1 }); });
  await act(async () => { await view.result.current.retryUnconfirmedMessage(failed); });
  expect(view.send).toHaveBeenCalledTimes(1);
  const frame = view.send.mock.calls[0][0] as Record<string, unknown>;
  expect(frame).toMatchObject({ type: 'chat.send', sessionId: 'session-a', content: 'Retained question', options: { attachments: [{ path: '/uploads/retry.txt' }] } });
  expect(frame.clientMessageId).not.toBe(failed.clientMessageId);
  expect(frame).not.toHaveProperty('anchorId');
  expect(view.result.current.input).toBe('Different edit draft');
  expect(view.result.current.editingAnchorId).toBe('different-anchor');
  expect(failed.delivery).toBe('failed');
  expect(uploadFiles).not.toHaveBeenCalled();
  expect(readQueuedMessage('session-a')).toBeNull();
});

test('a saved retry waits for explicit closed input without duplicating the queue or clearing a newer draft', async () => {
  const view = composer({ ...BACKGROUND, acceptsInput: false });
  const saved: ChatMessage = { type: 'user', sessionId: 'session-a', timestamp: 1, content: 'Saved unsent', delivery: 'failed', definitelyNotSubmitted: true, clientMessageId: '22222222-2222-4222-8222-222222222222', files: [{ path: '/uploads/saved.txt' }] };
  await act(async () => view.result.current.setInput('Newer draft'));
  await act(async () => view.result.current.retryUnconfirmedMessage(saved));
  expect(view.send).not.toHaveBeenCalled();
  expect(readQueuedMessage('session-a')).toBeNull();
  expect(view.result.current.input).toBe('Newer draft');
  expect(saved.files).toEqual([{ path: '/uploads/saved.txt' }]);
});

test.each([true, undefined])('only explicit pre-admission rejection marks a saved copy definitely unsent (%s)', definitelyNotSubmitted => {
  const view = handlers();
  view.emit({ ...receipt('queued'), files: [{ path: '/uploads/recover.txt' }] });
  view.emit({ kind: 'protocol_error', code: 'INPUT_NOT_ACCEPTED', sessionId: 'session-a', clientMessageId: '16dfd601-35b0-409f-aec3-f6cb10b48441', error: 'Input unavailable', isProcessing: true, ...BACKGROUND, acceptsInput: false, definitelyNotSubmitted });
  const saved = view.result.current.store.getMessages('session-a').find(message => message.clientMessageId)!;
  expect(saved.delivery).toBe('failed');
  expect(saved.definitelyNotSubmitted).toBe(definitelyNotSubmitted);
  expect(saved.files).toEqual([{ path: '/uploads/recover.txt' }]);
  expect(view.result.current.protection.processingSessions.has('session-a')).toBe(true);
  view.emit(receipt('queued'));
  expect(view.result.current.store.getMessages('session-a').find(message => message.clientMessageId)?.definitelyNotSubmitted).toBe(definitelyNotSubmitted);
  expect(readQueuedMessage('session-a')).toBeNull();
});

test('definitely unsent copies display a deliberate send action, distinct from ambiguous delivery', () => {
  const retry = vi.fn();
  const view = render(<MessageDeliveryStatus message={{ type: 'user', timestamp: 1, delivery: 'failed', definitelyNotSubmitted: true }} onRetry={retry} />);
  expect(view.getByRole('status').textContent).toMatch(/Not submitted|尚未提交/);
  expect(view.getByRole('button').textContent).toMatch(/Send saved|发送已保存|傳送已儲存/);
  expect(retry).not.toHaveBeenCalled();
});

test('definite pre-admission rejection survives reload and only native delivery clears its classification', () => {
  const view = handlers();
  view.emit({ ...receipt('queued'), files: [{ path: '/uploads/retained.txt' }] });
  view.emit({ kind: 'protocol_error', code: 'INPUT_NOT_ACCEPTED', sessionId: 'session-a', clientMessageId: '16dfd601-35b0-409f-aec3-f6cb10b48441', definitelyNotSubmitted: true, error: 'Not admitted', isProcessing: true, ...BACKGROUND });
  view.unmount();
  const restored = handlers();
  expect(restored.result.current.store.getMessages('session-a').find(message => message.clientMessageId)).toMatchObject({
    delivery: 'failed', definitelyNotSubmitted: true, files: [{ path: '/uploads/retained.txt' }],
  });
  restored.emit(receipt('delivered'));
  expect(restored.result.current.store.getMessages('session-a').find(message => message.clientMessageId)).toMatchObject({ delivery: 'delivered' });
  expect(restored.result.current.store.getMessages('session-a').find(message => message.clientMessageId)?.definitelyNotSubmitted).toBeUndefined();
  expect(readQueuedMessage('session-a')).toBeNull();
});

test.each(['live', 'reconnect'] as const)('a %s preparation-failure receipt remains definitely unsent through reload until actual delivery', source => {
  const view = handlers();
  const failed = { ...receipt('failed'), definitelyNotSubmitted: true,
    code: 'UNSUPPORTED_EXECUTION_SETTINGS', error: 'Synthetic execution settings rejected before model launch',
    files: [{ path: '/uploads/retained.txt' }] };
  if (source === 'live') {
    view.emit(receipt('queued'));
    view.emit(failed);
  } else {
    view.emit({ kind: 'chat_subscribed', sessionId: 'session-a', isProcessing: false, messageReceipts: [failed] });
  }
  expect(view.result.current.store.getMessages('session-a').find(message => message.clientMessageId)).toMatchObject({
    delivery: 'failed', definitelyNotSubmitted: true, deliveryError: failed.error, files: failed.files,
  });
  view.emit(receipt('queued'));
  view.emit({ kind: 'complete', sessionId: 'session-a' });
  view.unmount();
  const restored = handlers();
  expect(restored.result.current.store.getMessages('session-a').find(message => message.clientMessageId)).toMatchObject({
    delivery: 'failed', definitelyNotSubmitted: true, deliveryError: failed.error,
  });
  expect(readQueuedMessage('session-a')).toBeNull();
  restored.emit(receipt('delivered'));
  restored.emit(failed);
  const delivered = restored.result.current.store.getMessages('session-a').find(message => message.clientMessageId);
  expect(delivered?.delivery).toBe('delivered');
  expect(delivered?.definitelyNotSubmitted).toBeUndefined();
});

test('a stale retry callback cannot submit another conversation’s retained copy', async () => {
  const view = composer(BACKGROUND);
  await act(async () => { await view.result.current.retryUnconfirmedMessage({ type: 'user', sessionId: 'session-b', content: 'Other session', timestamp: 1, delivery: 'failed', clientMessageId: '22222222-2222-4222-8222-222222222222' }); });
  expect(view.send).not.toHaveBeenCalled();
});

test('failed abort preserves running state and an input rejection restores the authoritative capability', () => {
  const view = handlers();
  view.emit({ kind: 'status', text: 'claude_runtime_state', sessionId: 'session-a', ...BACKGROUND, acceptsInput: false });
  view.emit(receipt('queued'));
  view.emit({ kind: 'protocol_error', code: 'ABORT_FAILED', error: 'Could not stop', sessionId: 'session-a', isProcessing: true, ...BACKGROUND });
  expect(view.result.current.protection.processingSessions.get('session-a')).toMatchObject({ phase: 'background', acceptsInput: true });
  expect(view.result.current.store.getMessages('session-a').find(message => message.clientMessageId)?.delivery).toBe('queued');
  view.emit({ kind: 'protocol_error', code: 'INPUT_NOT_ACCEPTED', error: 'Input closed', sessionId: 'session-a', clientMessageId: '16dfd601-35b0-409f-aec3-f6cb10b48441', isProcessing: true, ...BACKGROUND, acceptsInput: false });
  expect(view.result.current.protection.processingSessions.get('session-a')?.acceptsInput).toBe(false);
  expect(view.result.current.store.getMessages('session-a').find(message => message.clientMessageId)?.delivery).toBe('failed');
  view.emit({ kind: 'protocol_error', code: 'INVALID_MESSAGE', error: 'Malformed unrelated request', sessionId: 'session-a' });
  expect(view.result.current.protection.processingSessions.has('session-a')).toBe(true);
});

test('double-clicking one failed copy sends once; a further manual retry belongs to the new failed UUID', async () => {
  const view = composer(BACKGROUND);
  const failed: ChatMessage = { type: 'user', sessionId: 'session-a', content: 'Retained question', timestamp: 1, delivery: 'failed', clientMessageId: '22222222-2222-4222-8222-222222222222' };
  await act(async () => { await Promise.all([view.result.current.retryUnconfirmedMessage(failed), view.result.current.retryUnconfirmedMessage(failed)]); });
  expect(view.send).toHaveBeenCalledTimes(1);
  const newId = (view.send.mock.calls[0][0] as Record<string, unknown>).clientMessageId as string;
  expect(view.add.mock.calls.some(([message]) => message.clientMessageId === failed.clientMessageId && message.retriedAsClientMessageId === newId)).toBe(true);
  await act(async () => { await view.result.current.retryUnconfirmedMessage(failed); });
  expect(view.send).toHaveBeenCalledTimes(1);
  await act(async () => { await view.result.current.retryUnconfirmedMessage({ ...failed, clientMessageId: newId }); });
  expect(view.send).toHaveBeenCalledTimes(2);
  expect((view.send.mock.calls[1][0] as Record<string, unknown>).clientMessageId).not.toBe(newId);
});

test('a persisted retry relationship prevents sending the old source after remount', async () => {
  const view = composer(BACKGROUND);
  await act(async () => { await view.result.current.retryUnconfirmedMessage({ type: 'user', sessionId: 'session-a', content: 'Retained question', timestamp: 1, delivery: 'failed', clientMessageId: '22222222-2222-4222-8222-222222222222', retriedAsClientMessageId: '33333333-3333-4333-8333-333333333333' }); });
  expect(view.send).not.toHaveBeenCalled();
});

test('a retry refused before creating a new input copy can be retried after preparation is possible', async () => {
  const view = composer(BACKGROUND);
  const failed: ChatMessage = { type: 'user', sessionId: 'session-a', content: 'Retained question', timestamp: 1, delivery: 'failed', clientMessageId: '22222222-2222-4222-8222-222222222222' };
  act(() => window.dispatchEvent(new CustomEvent('cloudcli:session-mutation', { detail: { sessionId: 'session-a', requestId: 'mutation', phase: 'started' } })));
  await act(async () => { await view.result.current.retryUnconfirmedMessage(failed); });
  expect(view.send).not.toHaveBeenCalled();
  expect(view.add.mock.calls.some(([message]) => message.retriedAsClientMessageId)).toBe(false);
  act(() => window.dispatchEvent(new CustomEvent('cloudcli:session-mutation', { detail: { sessionId: 'session-a', requestId: 'mutation', phase: 'failed' } })));
  await act(async () => { await view.result.current.retryUnconfirmedMessage(failed); });
  expect(view.send).toHaveBeenCalledTimes(1);
});

test('an already retried source retains its delivery warning without another retry button', () => {
  const retry = vi.fn();
  const view = render(<MessageDeliveryStatus message={{ type: 'user', timestamp: 1, delivery: 'failed', retriedAsClientMessageId: '33333333-3333-4333-8333-333333333333' }} onRetry={retry} />);
  expect(view.getByRole('status').textContent).toMatch(/unconfirmed|未确认|未確認/);
  expect(view.queryByRole('button')).toBeNull();
  expect(view.container.textContent).toContain('Retried as a new message');
});

test('interrupt-and-send is one explicit message to the same remote, while subsequent ordinary sends remain queued', async () => {
  const view = composer({ ...BACKGROUND, phase: 'foreground', inputModes: ['queue', 'interrupt'] });
  act(() => view.result.current.setInput('Change direction now'));
  await act(async () => { await view.result.current.handleInterruptAndSend({ preventDefault() {} } as never); });
  expect(view.send).toHaveBeenCalledTimes(1);
  expect(view.send.mock.calls[0][0]).toMatchObject({ type: 'chat.send', sessionId: 'session-a', content: 'Change direction now', options: { deliveryMode: 'interrupt' } });
  expect(view.result.current.input).toBe('');
  await view.submit('Then do this');
  expect(view.send.mock.calls[1][0]).toMatchObject({ type: 'chat.send', options: { deliveryMode: 'queue' } });
  expect(view.send.mock.calls.some(([frame]) => (frame as { type: string }).type === 'chat.abort')).toBe(false);
});

test.each([undefined, ['queue']] as const)('unconfirmed interrupt support %s keeps the draft and does not silently fall back to queue', async inputModes => {
  const view = composer({ ...BACKGROUND, inputModes: inputModes ? [...inputModes] : undefined });
  act(() => view.result.current.setInput('Keep this draft'));
  await act(async () => { await view.result.current.handleInterruptAndSend({ preventDefault() {} } as never); });
  expect(view.send).not.toHaveBeenCalled();
  expect(view.result.current.input).toBe('Keep this draft');
  expect(view.add.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'error' });
  expect(view.add.mock.calls.some(([message]) => message.type === 'user')).toBe(false);
});

test('interrupt refuses a closed input stream without creating a waiting message', async () => {
  const view = composer({ ...BACKGROUND, inputModes: ['queue', 'interrupt'], acceptsInput: false });
  act(() => view.result.current.setInput('Keep this too'));
  await act(async () => { await view.result.current.handleInterruptAndSend({ preventDefault() {} } as never); });
  expect(view.send).not.toHaveBeenCalled();
  expect(view.result.current.input).toBe('Keep this too');
  expect(view.add.mock.calls.some(([message]) => message.type === 'user')).toBe(false);
});

test('interrupt-and-send cannot turn an edit into a rewind or discard its draft', async () => {
  const view = composer({ ...BACKGROUND, inputModes: ['queue', 'interrupt'] });
  act(() => view.result.current.beginEditMessage({ type: 'user', content: 'Old text', timestamp: 1, transcriptAnchorId: 'old-anchor' }));
  act(() => view.result.current.setInput('Editing earlier text'));
  await act(async () => { await view.result.current.handleInterruptAndSend({ preventDefault() {} } as never); });
  expect(view.send).not.toHaveBeenCalled();
  expect(view.result.current.input).toBe('Editing earlier text');
  expect(view.result.current.editingAnchorId).toBe('old-anchor');
});
