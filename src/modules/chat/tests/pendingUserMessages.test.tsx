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
  expect(restored.result.current.getMessages('session-a')).toEqual([{ ...input(delivery), isUnlocatedLocalCopy: true }]);
  sessionMessages.mockResolvedValueOnce(response([]));
  await act(async () => { await restored.result.current.fetchFromServer('session-a'); });
  expect(restored.result.current.getMessages('session-a')).toEqual([{ ...input(delivery), isUnlocatedLocalCopy: true }]);
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
  expect(view.result.current.getMessages('session-a')).toEqual([{ ...input(), isUnlocatedLocalCopy: true }]);
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

test('a source retry relationship survives late receipts and reloads without merging the distinct new UUID', () => {
  const newId = '33333333-3333-4333-8333-333333333333';
  const view = renderHook(() => useSessionStore('user-a'));
  act(() => {
    view.result.current.appendRealtime('session-a', { ...input('failed'), retriedAsClientMessageId: newId });
    view.result.current.appendRealtime('session-a', { ...input(), id: `client_${newId}`, clientMessageId: newId });
    view.result.current.appendRealtime('session-a', { ...input('queued'), retriedAsClientMessageId: undefined });
  });
  expect(view.result.current.getMessages('session-a')).toHaveLength(2);
  expect(view.result.current.getMessages('session-a').find(message => message.clientMessageId === ID)).toMatchObject({ delivery: 'failed', retriedAsClientMessageId: newId });
  view.unmount();
  const restored = renderHook(() => useSessionStore('user-a'));
  expect(restored.result.current.getMessages('session-a')).toHaveLength(2);
  expect(restored.result.current.getMessages('session-a').find(message => message.clientMessageId === ID)?.retriedAsClientMessageId).toBe(newId);
  act(() => restored.result.current.updateMessageDelivery('session-a', newId, 'failed', 'Synthetic error'));
  expect(restored.result.current.getMessages('session-a').find(message => message.clientMessageId === newId)).toMatchObject({ delivery: 'failed' });
  expect(restored.result.current.getMessages('session-a').find(message => message.clientMessageId === newId)?.retriedAsClientMessageId).toBeUndefined();
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


test('explicit native identity merges live echo, survives receipt replay, and confirms outbox without text matching', async () => {
  const view = renderHook(() => useSessionStore('user-a'));
  const nativeId = 'native-rewritten-id';
  act(() => view.result.current.appendRealtime('session-a', { ...input('delivered'), transcriptAnchorId: nativeId }));
  // An older gateway admission has no native binding and must not erase it.
  act(() => view.result.current.appendRealtime('session-a', input('queued')));
  const native = { ...input(), id: `${nativeId}_text_0`, clientMessageId: undefined, delivery: undefined, transcriptAnchorId: nativeId };
  act(() => view.result.current.appendRealtime('session-a', native));
  expect(view.result.current.getMessages('session-a')).toHaveLength(1);
  expect(view.result.current.getMessages('session-a')[0].delivery).toBeUndefined();
  act(() => view.result.current.appendRealtime('session-a', input('queued')));
  expect(view.result.current.getMessages('session-a')).toHaveLength(1);
  view.unmount();
  const restored = renderHook(() => useSessionStore('user-a'));
  expect(restored.result.current.getMessages('session-a')).toEqual([]);
});

test('idle authority uses local observation time despite remote clock skew and survives reload', () => {
  const localClock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-07T00:00:00Z'));
  const view = renderHook(() => useSessionStore('user-a'));
  const newerId = '43d5dd07-95d3-4ea2-b9e9-a386dbfb5c75';
  act(() => {
    view.result.current.appendRealtime('session-a', { ...input(), timestamp: '2026-09-07T00:00:30Z' });
    localClock.mockReturnValue(Date.parse('2026-09-07T00:00:02Z'));
    view.result.current.appendRealtime('session-a', { ...input(), id: `client_${newerId}`, clientMessageId: newerId, timestamp: '2026-09-06T23:59:32Z' });
    view.result.current.appendRealtime('session-b', { ...input(), sessionId: 'session-b' });
    view.result.current.settleUnconfirmedMessages('session-a', Date.parse('2026-09-07T00:00:01Z'), 'Process no longer exists');
  });
  expect(view.result.current.getMessages('session-a').map(message => message.delivery)).toEqual(['failed', 'queued']);
  expect(view.result.current.getMessages('session-b')[0].delivery).toBe('queued');
  view.unmount();
  const restored = renderHook(() => useSessionStore('user-a'));
  expect(restored.result.current.getMessages('session-a').find(message => message.clientMessageId === ID)).toMatchObject({ delivery: 'failed', deliveryError: 'Process no longer exists' });
});

test('deleting a local copy never hides its later native record or a new manual send of identical text', () => {
  const view = renderHook(() => useSessionStore('user-a'));
  const newId = '81f9b698-e606-46e1-bd45-2f70b25d37ee';
  act(() => {
    view.result.current.appendRealtime('session-a', input('failed'));
    view.result.current.dismissPendingUserMessage('session-a', ID);
    view.result.current.appendRealtime('session-a', { ...input(), id: `${ID}_text_0`, delivery: undefined, transcriptAnchorId: ID });
    view.result.current.appendRealtime('session-a', { ...input(), id: `client_${newId}`, clientMessageId: newId });
  });
  expect(view.result.current.getMessages('session-a')).toHaveLength(2);
  expect(view.result.current.getMessages('session-a').map(message => message.delivery)).toEqual([undefined, 'queued']);
});


test('rewind keeps old pending copies with the recovery branch and prevents late receipts entering restored context', () => {
  const view = renderHook(() => useSessionStore('user-a'));
  act(() => {
    view.result.current.appendRealtime('session-a', input());
    view.result.current.quarantineContextInputs('session-a', 'recovery-branch');
    view.result.current.appendRealtime('session-a', input('queued'));
  });
  expect(view.result.current.getMessages('session-a')).toEqual([]);
  expect(view.result.current.getMessages('recovery-branch')).toHaveLength(1);
  expect(view.result.current.getMessages('recovery-branch')[0]).toMatchObject({ clientMessageId: ID, delivery: 'failed' });
  view.unmount();
  const restored = renderHook(() => useSessionStore('user-a'));
  expect(restored.result.current.getMessages('session-a')).toEqual([]);
  expect(restored.result.current.getMessages('recovery-branch')[0].clientMessageId).toBe(ID);
});

test('a persisted consumption response ID binds rewritten native user UUID after reload without matching its repeated text', async () => {
  const first = renderHook(() => useSessionStore('user-a'));
  act(() => first.result.current.appendRealtime('session-a', { ...input('delivered'), responseMessageId: 'api-response-exact' }));
  first.unmount();
  const restored = renderHook(() => useSessionStore('user-a'));
  const earlier = { ...input(), id: 'old-user', clientMessageId: undefined, delivery: undefined, responseMessageIds: ['api-response-older'] };
  const actual = { ...earlier, id: 'rewritten-native-user_text_0', transcriptAnchorId: 'rewritten-native-user', responseMessageIds: ['api-response-exact'] };
  sessionMessages.mockResolvedValueOnce(response([earlier]));
  await act(async () => { await restored.result.current.fetchFromServer('session-a'); });
  expect(restored.result.current.getMessages('session-a')).toHaveLength(2);
  sessionMessages.mockResolvedValueOnce(response([earlier, actual]));
  await act(async () => { await restored.result.current.fetchFromServer('session-a'); });
  expect(restored.result.current.getMessages('session-a')).toEqual([earlier, actual]);
  act(() => restored.result.current.appendRealtime('session-a', input('queued')));
  expect(restored.result.current.getMessages('session-a')).toEqual([earlier, actual]);
});


test('HTTP and websocket notifications for the same rewind cannot quarantine a newer send twice', () => {
  const view = renderHook(() => useSessionStore('user-a'));
  const newId = '115d8689-37b5-43aa-bbdf-c4d7f6a33916';
  act(() => {
    view.result.current.appendRealtime('session-a', input());
    view.result.current.quarantineContextInputs('session-a', 'backup', 'context-revision');
    view.result.current.appendRealtime('session-a', { ...input(), id: `client_${newId}`, clientMessageId: newId });
    view.result.current.quarantineContextInputs('session-a', 'backup', 'context-revision');
  });
  expect(view.result.current.getMessages('session-a').map(message => message.clientMessageId)).toEqual([newId]);
  expect(view.result.current.getMessages('backup').map(message => message.clientMessageId)).toEqual([ID]);
});


test('first local observation survives a reload and replayed future remote timestamps', () => {
  const localClock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const first = renderHook(() => useSessionStore('user-a'));
  act(() => first.result.current.appendRealtime('session-a', { ...input(), timestamp: '2099-01-01T00:00:00Z' }));
  first.unmount();
  localClock.mockReturnValue(3000);
  const restored = renderHook(() => useSessionStore('user-a'));
  act(() => {
    restored.result.current.appendRealtime('session-a', { ...input(), timestamp: '2099-01-01T00:00:30Z' });
    restored.result.current.settleUnconfirmedMessages('session-a', 2000, 'Process no longer exists');
  });
  expect(restored.result.current.getMessages('session-a')[0]).toMatchObject({ delivery: 'failed' });
});
