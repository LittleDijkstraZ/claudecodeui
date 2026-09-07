import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

const { sessionMessages } = vi.hoisted(() => ({ sessionMessages: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages } } }));
const ID = '16dfd601-35b0-409f-aec3-f6cb10b48441';
const input = (delivery: 'queued' | 'failed' | 'delivered' = 'queued'): NormalizedMessage => ({
  id: `client_${ID}`, clientMessageId: ID, sessionId: 'session-a', provider: 'claude', kind: 'text', role: 'user',
  content: 'Question that must not disappear', delivery, timestamp: '2026-09-07T00:00:00Z', files: [{ path: 'fixture.txt' }],
});
const response = (messages: NormalizedMessage[]) => ({ ok: true, json: async () => ({ data: { messages, total: messages.length, hasMore: false } }) });
beforeEach(() => { localStorage.clear(); sessionMessages.mockReset(); window.__REMOTE_ID__ = 'remote-a'; });
afterEach(() => { vi.restoreAllMocks(); delete window.__REMOTE_ID__; });

test.each(['queued', 'failed', 'delivered'] as const)('%s user copies survive long Workflow output, a reload, and an older empty history snapshot', async delivery => {
  const first = renderHook(() => useSessionStore('user-a'));
  act(() => {
    first.result.current.appendRealtime('session-a', input(delivery));
    for (let index = 0; index < 520; index++) first.result.current.appendRealtime('session-a', {
      id: `tool-${index}`, sessionId: 'session-a', provider: 'claude', kind: 'tool_use', toolId: `tool-${index}`, toolName: 'Read', timestamp: '2026-09-07T00:00:01Z',
    });
  });
  expect(first.result.current.getMessages('session-a').filter(message => message.role === 'user')).toHaveLength(1);
  first.unmount();
  const restored = renderHook(() => useSessionStore('user-a'));
  expect(restored.result.current.getMessages('session-a')).toEqual([input(delivery)]);
  sessionMessages.mockResolvedValueOnce(response([]));
  await act(async () => { await restored.result.current.fetchFromServer('session-a'); });
  expect(restored.result.current.getMessages('session-a')).toEqual([input(delivery)]);
});

test('only the exact persisted native prompt retires its local copy and receipt replay cannot restore a duplicate', async () => {
  const view = renderHook(() => useSessionStore('user-a'));
  act(() => view.result.current.appendRealtime('session-a', input()));
  const persisted = { ...input('delivered'), id: `${ID}_text_0`, clientMessageId: undefined, delivery: undefined, transcriptAnchorId: ID };
  sessionMessages.mockResolvedValueOnce(response([persisted]));
  await act(async () => { await view.result.current.refreshLatestFromServer('session-a'); });
  expect(view.result.current.getMessages('session-a')).toEqual([persisted]);
  act(() => view.result.current.appendRealtime('session-a', input('queued')));
  expect(view.result.current.getMessages('session-a')).toEqual([persisted]);
  view.unmount();
  const restored = renderHook(() => useSessionStore('user-a'));
  expect(restored.result.current.getMessages('session-a')).toEqual([]);
});

test('pending messages are isolated by machine, login identity, and session even when the hook is retained', () => {
  const view = renderHook(({ userId }) => useSessionStore(userId), { initialProps: { userId: 'user-a' } });
  act(() => view.result.current.appendRealtime('session-a', input()));
  expect(view.result.current.getMessages('session-b')).toEqual([]);
  view.rerender({ userId: 'user-b' });
  expect(view.result.current.getMessages('session-a')).toEqual([]);
  window.__REMOTE_ID__ = 'remote-b'; view.rerender({ userId: 'user-a' });
  expect(view.result.current.getMessages('session-a')).toEqual([]);
  window.__REMOTE_ID__ = 'remote-a'; view.rerender({ userId: 'user-a' });
  expect(view.result.current.getMessages('session-a')).toEqual([input()]);
});

test('dismissing removes only the local copy and survives reconnect receipts and reloads', () => {
  const view = renderHook(() => useSessionStore('user-a'));
  act(() => view.result.current.appendRealtime('session-a', input('failed')));
  act(() => view.result.current.dismissPendingUserMessage('session-a', ID));
  act(() => view.result.current.appendRealtime('session-a', input('queued')));
  expect(view.result.current.getMessages('session-a')).toEqual([]);
  view.unmount();
  const restored = renderHook(() => useSessionStore('user-a'));
  expect(restored.result.current.getMessages('session-a')).toEqual([]);
  expect(sessionMessages).not.toHaveBeenCalled();
});

test('browser quota failure surfaces a warning without throwing away input or changing delivery', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
  const view = renderHook(() => useSessionStore('user-a'));
  act(() => view.result.current.appendRealtime('session-a', input()));
  expect(view.result.current.pendingMessageStorageFailed).toBe(true);
  expect(view.result.current.getMessages('session-a')).toEqual([input()]);
  act(() => view.result.current.updateMessageDelivery('session-a', ID, 'failed', 'Fixture offline'));
  expect(view.result.current.getMessages('session-a')[0].delivery).toBe('failed');
});

test('an older queued receipt cannot erase the failure explanation, including after reload', () => {
  const view = renderHook(() => useSessionStore('user-a'));
  act(() => view.result.current.appendRealtime('session-a', { ...input('failed'), deliveryError: 'Native startup failed' }));
  act(() => view.result.current.appendRealtime('session-a', { ...input('queued'), deliveryError: undefined }));
  expect(view.result.current.getMessages('session-a')[0]).toMatchObject({ delivery: 'failed', deliveryError: 'Native startup failed' });
  view.unmount();
  const restored = renderHook(() => useSessionStore('user-a'));
  expect(restored.result.current.getMessages('session-a')[0]).toMatchObject({ delivery: 'failed', deliveryError: 'Native startup failed' });
});


test('two windows can persist different queued inputs for the same session without replacing either copy', () => {
  const first = renderHook(() => useSessionStore('user-a'));
  const second = renderHook(() => useSessionStore('user-a'));
  const secondId = 'c51f11eb-3330-4af0-9426-d7d20bc089b1';
  act(() => first.result.current.appendRealtime('session-a', input()));
  act(() => second.result.current.appendRealtime('session-a', { ...input(), id: `client_${secondId}`, clientMessageId: secondId, content: 'Second window question' }));
  first.unmount(); second.unmount();
  const restored = renderHook(() => useSessionStore('user-a'));
  expect(restored.result.current.getMessages('session-a').map(message => message.clientMessageId).sort()).toEqual([ID, secondId].sort());
});
