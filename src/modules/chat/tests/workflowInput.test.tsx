import { act, render, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { MessageDeliveryStatus } from '@/modules/chat/transcript/MessageDeliveryStatus';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import { readQueuedMessage, resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, Project, ServerEvent, SessionActivity } from '@/shared/types';

vi.mock('@/shared/api', () => {
  const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return { api: {
    user: { drafts: () => ok({ drafts: [] }), saveDraft: () => ok({}), deleteDraft: () => ok({}), preferences: () => ok({ preferences: {} }), savePreferences: () => ok({}) },
    commands: { list: () => ok({ commands: [] }) }, files: { search: () => ok({ files: [] }) },
    getFiles: () => ok([]), providers: { skills: () => ok({ data: { skills: [] } }) },
  } };
});

const PROJECT: Project = { projectId: 'remote-project', displayName: 'Remote project', fullPath: '/remote/work' };
const BACKGROUND: SessionActivity = { startedAt: 100, statusText: null, canInterrupt: true, phase: 'background', acceptsInput: true, backgroundTasks: 2, executionId: 'execution-one' };
beforeEach(() => { localStorage.clear(); resetChatDrafts(); });

function composer(activity: SessionActivity, connected = true) {
  const send = vi.fn<(message: unknown) => boolean>(() => connected);
  const add = vi.fn<(message: ChatMessage) => void>();
  const processing = vi.fn();
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT, selectedSession: { id: 'session-a' }, currentSessionId: 'session-a', provider: 'claude',
    permissionMode: 'default', cyclePermissionMode: () => {}, resolvePermissionModeForProvider: () => 'default',
    currentProviderModel: 'remote-alias', currentProviderEffort: 'high',
    isLoading: activity.acceptsInput !== true, processingSessions: new Map([['session-a', activity]]),
    canAbortSession: true, tokenBudget: null, sendMessage: send, onSessionProcessing: processing,
    scrollToBottom: () => {}, addMessage: add, setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {},
  }));
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

test('an older server without live input capability retains its existing durable queue', async () => {
  const view = composer({ startedAt: 100, statusText: null, canInterrupt: true });
  await view.submit('wait for this run');
  expect(view.send).not.toHaveBeenCalled();
  expect(readQueuedMessage('session-a')?.content).toBe('wait for this run');
});

test('a disconnected send is explicitly not delivered and never stops the Workflow', async () => {
  const view = composer(BACKGROUND, false);
  await view.submit('question');
  expect(view.add.mock.calls.map(([message]) => message.delivery)).toEqual(['queued', 'failed']);
  expect(view.processing).not.toHaveBeenCalled();
  expect(view.send.mock.calls).toHaveLength(1);
});

function handlers() {
  let listener: (event: ServerEvent) => void = () => {};
  const subscribe = (next: typeof listener) => { listener = next; return () => {}; };
  const refresh = vi.fn(async () => {});
  const view = renderHook(() => {
    const store = useSessionStore();
    const protection = useSessionProtection();
    useChatRealtimeHandlers({
      isActive: true, subscribe, provider: 'claude', selectedSession: { id: 'session-a' }, currentSessionId: 'session-a',
      setTokenBudget: () => {}, pendingPermissionRequests: [], setPendingPermissionRequests: () => {},
      lastSeqRef: { current: new Map() }, statusCheckSentAtRef: { current: new Map() },
      onSessionProcessing: protection.markSessionProcessing, onSessionIdle: protection.markSessionIdle,
      requestLatestMessages: refresh, sessionStore: store,
    });
    return { store, protection };
  });
  return { ...view, refresh, emit: (event: ServerEvent) => act(() => listener(event)) };
}

const receipt = (delivery: string, sessionId = 'session-a'): ServerEvent => ({ kind: 'status', text: 'message_delivery', delivery, sessionId, clientMessageId: 'prompt-1', content: 'question', timestamp: '2026-09-07T00:00:00Z' });

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
  view.emit({ kind: 'protocol_error', sessionId: 'session-a', clientMessageId: 'prompt-1', error: 'Input stream closed', code: 'INPUT_CLOSED' });
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
