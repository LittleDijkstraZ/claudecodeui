import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useClaudeTaskControls } from '@/modules/chat/hooks/useClaudeTaskControls';
import type { ChatMessage, ServerEvent, SessionActivity } from '@/shared/types';

const ACTIVITY: SessionActivity = { startedAt: 1, statusText: null, canInterrupt: true, phase: 'foreground', acceptsInput: true, canInterruptQueuedMessages: true, canStopTask: true };
const MESSAGE: ChatMessage = { type: 'user', content: 'Queued question', timestamp: 1, delivery: 'queued', clientMessageId: 'queued-one' };
afterEach(() => vi.useRealTimers());

function fixture(connected = true) {
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const send = vi.fn<(message: unknown) => boolean>(() => connected);
  const view = renderHook(({ sessionId, messages }) => useClaudeTaskControls({ sessionId, activity: ACTIVITY, messages, sendMessage: send, subscribe }), {
    initialProps: { sessionId: 'session-a', messages: [MESSAGE] },
  });
  const emit = (event: ServerEvent) => act(() => { for (const listener of listeners) listener(event); });
  return { ...view, send, emit };
}

test('queued interrupt sends only a scoped control request, deduplicates clicks, and waits for matching acknowledgement', () => {
  const view = fixture();
  act(() => { view.result.current.interruptQueuedMessage('queued-one'); view.result.current.interruptQueuedMessage('queued-one'); });
  expect(view.send).toHaveBeenCalledOnce();
  const frame = view.send.mock.calls[0][0] as Record<string, unknown>;
  expect(frame).toMatchObject({ type: 'chat.interrupt', sessionId: 'session-a', clientMessageId: 'queued-one' });
  expect(frame).not.toHaveProperty('content');
  expect(view.result.current.interruptingMessageId).toBe('queued-one');
  const response = { ...frame, kind: 'status', text: 'queued_input_interrupt', status: 'completed' };
  view.emit({ ...response, sessionId: 'session-b' });
  view.emit({ ...response, requestId: 'unrelated' });
  expect(view.result.current.interruptingMessageId).toBe('queued-one');
  view.emit(response);
  expect(view.result.current.interruptingMessageId).toBeNull();
  expect(MESSAGE.delivery).toBe('queued');
});

test('interrupt failure keeps the queued message and allows explicit retry', () => {
  const view = fixture();
  act(() => view.result.current.interruptQueuedMessage('queued-one'));
  view.emit({ ...(view.send.mock.calls[0][0] as Record<string, unknown>), kind: 'status', text: 'queued_input_interrupt', status: 'failed', error: 'Busy permission prompt' });
  expect(view.result.current.interruptError).toBe('Busy permission prompt');
  expect(view.result.current.interruptingMessageId).toBeNull();
  expect(MESSAGE.delivery).toBe('queued');
  act(() => view.result.current.interruptQueuedMessage('queued-one'));
  expect(view.send).toHaveBeenCalledTimes(2);
});

test('disconnected control never changes delivery and missing acknowledgements time out', () => {
  const offline = fixture(false);
  act(() => offline.result.current.interruptQueuedMessage('queued-one'));
  expect(offline.result.current.interruptingMessageId).toBeNull();
  expect(offline.result.current.interruptError).toBeTruthy();
  offline.unmount();
  vi.useFakeTimers();
  const view = fixture();
  act(() => view.result.current.interruptQueuedMessage('queued-one'));
  act(() => vi.advanceTimersByTime(15_000));
  expect(view.result.current.interruptingMessageId).toBeNull();
  expect(view.result.current.interruptError).toBeTruthy();
});

test('a delivered or stale-session queue control cannot dispatch', () => {
  const view = fixture();
  const oldAction = view.result.current.interruptQueuedMessage;
  view.rerender({ sessionId: 'session-b', messages: [] });
  act(() => oldAction('queued-one'));
  act(() => view.result.current.interruptQueuedMessage('queued-one'));
  expect(view.send).not.toHaveBeenCalled();
  view.rerender({ sessionId: 'session-a', messages: [{ ...MESSAGE, delivery: 'delivered' }] });
  act(() => view.result.current.interruptQueuedMessage('queued-one'));
  expect(view.send).not.toHaveBeenCalled();
});

test('individual task stopping uses a separate acknowledgement from queued interrupt', () => {
  const view = fixture();
  act(() => view.result.current.stopTask('workflow-one'));
  expect(view.send.mock.calls[0][0]).toMatchObject({ type: 'chat.stop-task', sessionId: 'session-a', taskId: 'workflow-one' });
  expect(view.result.current.stoppingTaskId).toBe('workflow-one');
  view.emit({ ...(view.send.mock.calls[0][0] as Record<string, unknown>), kind: 'status', text: 'task_stop', status: 'completed' });
  expect(view.result.current.stoppingTaskId).toBeNull();
});
