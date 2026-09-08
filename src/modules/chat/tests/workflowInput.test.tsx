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

const { uploadFiles, createSession } = vi.hoisted(() => ({ uploadFiles: vi.fn(), createSession: vi.fn() }));
vi.mock('@/shared/api', () => {
  const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return { api: {
    assets: { uploadFiles },
    user: { drafts: () => ok({ drafts: [] }), saveDraft: () => ok({}), deleteDraft: () => ok({}), preferences: () => ok({ preferences: {} }), savePreferences: () => ok({}) },
    commands: { list: () => ok({ commands: [] }) }, files: { search: () => ok({ files: [] }) },
    getFiles: () => ok([]), providers: { createSession, skills: () => ok({ data: { skills: [] } }) },
  } };
});

const PROJECT: Project = { projectId: 'remote-project', displayName: 'Remote project', fullPath: '/remote/work' };
const BACKGROUND: SessionActivity = { startedAt: 100, statusText: null, canInterrupt: true, phase: 'background', acceptsInput: true, backgroundTasks: 2, executionId: 'execution-one' };
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => { localStorage.clear(); resetChatDrafts(); uploadFiles.mockReset(); createSession.mockReset(); });

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
  expect(String(frames[0].clientMessageId)).toMatch(/^[0-9a-f-]{36}$/);
  expect(view.processing).not.toHaveBeenCalled();
  expect(view.add.mock.calls.map(([message]) => message.delivery)).toEqual(['queued', 'queued']);
  expect(readQueuedMessage('session-a')).toBeNull();
});

test('a process without live input capability refuses a send without an automatic queue', async () => {
  const view = composer({ startedAt: 100, statusText: null, canInterrupt: true });
  await view.submit('wait for this run');
  expect(view.send).not.toHaveBeenCalled();
  expect(readQueuedMessage('session-a')).toBeNull();
  expect(view.result.current.input).toBe('wait for this run');
  expect(view.add.mock.calls.at(-1)?.[0].content).toContain('has not been queued');
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

test('repeated attempts to an unavailable stream remain unsent drafts', async () => {
  const view = composer({ startedAt: 100, statusText: null, canInterrupt: true });
  await view.submit('First waiting message');
  await view.submit('Second waiting message');
  expect(readQueuedMessage('session-a')).toBeNull();
  expect(view.result.current.input).toBe('Second waiting message');
  expect(view.send).not.toHaveBeenCalled();
  expect(view.add.mock.calls.at(-1)?.[0].content).toContain('has not been queued');
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


test('an unavailable stream does not upload attachments or create waiting copies', async () => {
  const view = composer({ startedAt: 100, statusText: null, canInterrupt: true });
  const file = new File(['fixture'], 'fixture.txt');
  await act(async () => { view.result.current.setInput('Unsent attachment'); view.result.current.setAttachedFiles([file]); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  expect(uploadFiles).not.toHaveBeenCalled();
  expect(view.result.current.input).toBe('Unsent attachment');
  expect(view.result.current.attachedFiles).toEqual([file]);
  expect(view.add.mock.calls.some(([message]) => message.delivery === 'queued')).toBe(false);
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
  await act(async () => { if (acceptsInput) release({ ok: true, json: async () => ({ attachments: [{ path: 'one.txt' }] }) }); await pending; });
  expect(view.result.current.input).toBe('Same wording');
  if (acceptsInput) expect(view.send.mock.calls[0][0]).toMatchObject({ sessionId: 'session-a' });
  else { expect(readQueuedMessage('session-a')).toBeNull(); expect(uploadFiles).not.toHaveBeenCalled(); }
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
  await act(async () => { if (acceptsInput) release({ ok: true, json: async () => ({ attachments: [{ path: 'one.txt' }] }) }); await pending; });
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
