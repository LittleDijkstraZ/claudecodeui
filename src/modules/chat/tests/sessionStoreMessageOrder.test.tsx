import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { deriveConversationChanges } from '@/modules/chat/utils/conversationChanges';
import type { NormalizedMessage } from '@/shared/types';

const { sessionMessages } = vi.hoisted(() => ({ sessionMessages: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages } } }));
const row = (id: string, role: 'user' | 'assistant', timestamp: string): NormalizedMessage => ({
  id, role, timestamp, content: id, kind: 'text', provider: 'claude', sessionId: 'session-a',
  ...(role === 'user' ? { transcriptAnchorId: id } : {}),
});
const page = (messages: NormalizedMessage[], total = messages.length, hasMore = false) => ({
  ok: true, json: async () => ({ data: { messages, total, hasMore } }),
});
const local = (id: string, timestamp: string): NormalizedMessage => ({
  ...row(`client_${id}`, 'user', timestamp), transcriptAnchorId: undefined,
  clientMessageId: id, delivery: 'delivered',
});
const ids = (messages: NormalizedMessage[]) => messages.filter(message => !message.isUnlocatedLocalCopy).map(message => message.id);

beforeEach(() => { sessionMessages.mockReset(); localStorage.clear(); window.__REMOTE_ID__ = 'remote-a'; });
afterEach(() => { vi.restoreAllMocks(); delete window.__REMOTE_ID__; });

test('reopening a partial tail preserves native order while old delivered copies stay outside transcript turns', async () => {
  const first = renderHook(() => useSessionStore('user'));
  act(() => {
    first.result.current.appendRealtime('session-a', local('old-1', '2026-09-07T17:04:00Z'));
    first.result.current.appendRealtime('session-a', local('old-2', '2026-09-08T00:19:00Z'));
    first.result.current.appendRealtime('session-a', local('old-3', '2026-09-08T01:23:00Z'));
  });
  first.unmount();
  const restored = renderHook(() => useSessionStore('user'));
  // Native timestamps can run backwards across a resumed process. File order
  // is still authoritative; the retained user clock must not sort this page.
  const tail = [row('current-prompt', 'user', '2026-09-08T11:00:00Z'), row('current-answer', 'assistant', '2026-09-08T10:12:00Z')];
  sessionMessages.mockResolvedValueOnce(page(tail, 22, true));
  await act(async () => { await restored.result.current.fetchFromServer('session-a', { limit: 2 }); });
  const messages = restored.result.current.getMessages('session-a');
  expect(ids(messages)).toEqual(['current-prompt', 'current-answer']);
  expect(messages.filter(message => message.isUnlocatedLocalCopy)).toHaveLength(3);
  expect(messages.filter(message => message.isUnlocatedLocalCopy).every(message => message.delivery === 'delivered')).toBe(true);
  expect(deriveConversationChanges(normalizedToChatMessages(messages)).map(turn => turn.label)).toEqual(['current-prompt']);
  expect(sessionMessages).toHaveBeenCalledTimes(1);
});

test('loading an older exact identity retires only its retained copy and keeps the partial tail in place', async () => {
  const first = renderHook(() => useSessionStore('user'));
  act(() => {
    first.result.current.appendRealtime('session-a', local('old-send', '2026-09-07T00:00:00Z'));
    first.result.current.appendRealtime('session-a', { ...local('other-send', '2026-09-07T00:00:00Z'), content: 'same words' });
  });
  first.unmount();
  const restored = renderHook(() => useSessionStore('user'));
  const tail = [row('latest-user', 'user', '2026-09-08T00:00:00Z'), row('latest-answer', 'assistant', '2026-09-08T00:00:01Z')];
  sessionMessages.mockResolvedValueOnce(page(tail, 4, true));
  await act(async () => { await restored.result.current.fetchFromServer('session-a', { limit: 2 }); });
  expect(ids(restored.result.current.getMessages('session-a'))).toEqual(['latest-user', 'latest-answer']);
  const earlier = [
    { ...row('old-send_text_0', 'user', '2026-09-08T23:00:00Z'), transcriptAnchorId: 'old-send', content: 'same words' },
    row('older-answer', 'assistant', '2026-09-08T23:00:01Z'),
  ];
  sessionMessages.mockResolvedValueOnce(page(earlier, 4, false));
  await act(async () => { await restored.result.current.fetchMore('session-a', { limit: 2 }); });
  const merged = restored.result.current.getMessages('session-a');
  expect(ids(merged)).toEqual(['old-send_text_0', 'older-answer', 'latest-user', 'latest-answer']);
  expect(merged.filter(message => message.isUnlocatedLocalCopy).map(message => message.clientMessageId)).toEqual(['other-send']);
  expect(sessionMessages).toHaveBeenCalledTimes(2);
  expect(restored.result.current.getSessionSlot('session-a')?.realtimeMessages.map(message => message.clientMessageId)).toEqual(['other-send']);
  // Reopening in the same browser replaces the loaded pages with the tail;
  // the older matched copy must not survive invisibly in the live buffer.
  act(() => restored.result.current.setActiveSession('different-session'));
  sessionMessages.mockResolvedValueOnce(page(tail, 4, true));
  await act(async () => {
    restored.result.current.setActiveSession('session-a');
    await restored.result.current.fetchFromServer('session-a', { limit: 2 });
  });
  expect(ids(restored.result.current.getMessages('session-a'))).toEqual(['latest-user', 'latest-answer']);
  expect(restored.result.current.getMessages('session-a').filter(message => message.isUnlocatedLocalCopy).map(message => message.clientMessageId)).toEqual(['other-send']);
  restored.unmount();
  const again = renderHook(() => useSessionStore('user'));
  expect(again.result.current.getMessages('session-a').map(message => message.clientMessageId)).toEqual(['other-send']);
});

test('exact native overlap retains live user/output sequence across a stale refresh without using their clocks', async () => {
  const view = renderHook(() => useSessionStore('user'));
  const prior = row('prior', 'assistant', '2026-09-08T12:00:00Z');
  sessionMessages.mockResolvedValueOnce(page([prior]));
  await act(async () => { await view.result.current.fetchFromServer('session-a'); });
  const question = local('new-send', '2026-09-07T00:00:00Z');
  const reply = row('new-answer', 'assistant', '2026-09-08T10:00:00Z');
  act(() => {
    view.result.current.appendRealtime('session-a', question);
    view.result.current.appendRealtime('session-a', reply);
  });
  expect(ids(view.result.current.getMessages('session-a'))).toEqual(['prior', question.id, reply.id]);
  sessionMessages.mockResolvedValueOnce(page([prior, reply]));
  await act(async () => { await view.result.current.fetchFromServer('session-a'); });
  expect(ids(view.result.current.getMessages('session-a'))).toEqual(['prior', question.id, reply.id]);
  const native = { ...row('native-send_text_0', 'user', '2026-09-08T14:00:00Z'), clientMessageId: 'new-send', transcriptAnchorId: 'native-send' };
  sessionMessages.mockResolvedValueOnce(page([prior, native, reply]));
  await act(async () => { await view.result.current.fetchFromServer('session-a'); });
  expect(ids(view.result.current.getMessages('session-a'))).toEqual(['prior', native.id, reply.id]);
});

test('separate native assistant records with identical words survive pending-copy reconciliation', async () => {
  const view = renderHook(() => useSessionStore('user'));
  const rows = [row('user', 'user', '2026-09-08T12:00:00Z'),
    { ...row('answer-1', 'assistant', '2026-09-08T12:00:01Z'), content: 'Repeated, but independently recorded.' },
    { ...row('answer-2', 'assistant', '2026-09-08T11:00:00Z'), content: 'Repeated, but independently recorded.' }];
  sessionMessages.mockResolvedValueOnce(page(rows));
  await act(async () => { await view.result.current.fetchFromServer('session-a'); });
  act(() => view.result.current.appendRealtime('session-a', local('queued-copy', '2026-09-01T00:00:00Z')));
  expect(ids(view.result.current.getMessages('session-a'))).toEqual([...rows.map(message => message.id), 'client_queued-copy']);
});

test('a replayed receipt keeps an unlocated copy separate until an exact native echo replaces it', () => {
  const view = renderHook(() => useSessionStore('user'));
  act(() => view.result.current.appendRealtime('session-a', { ...local('replayed', '2026-09-01T00:00:00Z'), isUnlocatedLocalCopy: true }));
  expect(ids(view.result.current.getMessages('session-a'))).toEqual([]);
  act(() => view.result.current.appendRealtime('session-a', { ...row('replayed_text_0', 'user', '2026-09-08T00:00:00Z'), transcriptAnchorId: 'replayed' }));
  expect(ids(view.result.current.getMessages('session-a'))).toEqual(['replayed_text_0']);
  expect(view.result.current.getMessages('session-a')).toHaveLength(1);
});

test('a stale history refresh cannot retire a different native reply just because the current turn repeats its text', async () => {
  const view = renderHook(() => useSessionStore('user'));
  const prompt = row('prompt', 'user', '2026-09-08T11:00:00Z');
  const recorded = { ...row('recorded-response', 'assistant', '2026-09-08T10:00:00Z'), content: 'Same words' };
  sessionMessages.mockResolvedValueOnce(page([prompt, recorded]));
  await act(async () => { await view.result.current.fetchFromServer('session-a'); });
  act(() => {
    view.result.current.appendRealtime('session-a', prompt);
    view.result.current.appendRealtime('session-a', { ...row('independent-native-response', 'assistant', '2026-09-08T09:00:00Z'), content: 'Same words' });
  });
  sessionMessages.mockResolvedValueOnce(page([prompt, recorded]));
  await act(async () => { await view.result.current.fetchFromServer('session-a'); });
  expect(ids(view.result.current.getMessages('session-a'))).toEqual(['prompt', 'recorded-response', 'independent-native-response']);
});

test('a synthetic reply uses exact user identity rather than clock order to avoid matching an earlier answer', async () => {
  const view = renderHook(() => useSessionStore('user'));
  const earlier = row('earlier-prompt', 'user', '2026-09-08T12:00:00Z');
  const answer = { ...row('earlier-answer', 'assistant', '2026-09-08T12:00:01Z'), content: 'Same words' };
  const current = row('current-send', 'user', '2026-09-08T10:00:00Z');
  sessionMessages.mockResolvedValueOnce(page([earlier, answer, current]));
  await act(async () => { await view.result.current.fetchFromServer('session-a'); });
  act(() => {
    view.result.current.appendRealtime('session-a', local('current-send', '2026-09-08T09:00:00Z'));
    view.result.current.appendRealtime('session-a', { ...row('text_synthetic_reply', 'assistant', '2026-09-08T09:00:01Z'), content: 'Same words' });
  });
  sessionMessages.mockResolvedValueOnce(page([earlier, answer, current]));
  await act(async () => { await view.result.current.fetchFromServer('session-a'); });
  expect(ids(view.result.current.getMessages('session-a'))).toEqual(['earlier-prompt', 'earlier-answer', 'current-send', 'text_synthetic_reply']);
});


test('a receipt replay during an older snapshot cannot resurrect a confirmed copy after reopening only the tail', async () => {
  const view = renderHook(() => useSessionStore('user'));
  act(() => view.result.current.appendRealtime('session-a', local('confirmed-send', '2026-09-07T00:00:00Z')));
  let resolvePage!: (value: ReturnType<typeof page>) => void;
  sessionMessages.mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
  let request!: Promise<unknown>;
  await act(async () => {
    request = view.result.current.fetchFromServer('session-a');
    await Promise.resolve();
  });
  act(() => view.result.current.appendRealtime('session-a', { ...local('confirmed-send', '2026-09-08T11:00:00Z'), isUnlocatedLocalCopy: true }));
  const saved = { ...row('confirmed-send_text_0', 'user', '2026-09-08T00:00:00Z'), transcriptAnchorId: 'confirmed-send' };
  await act(async () => { resolvePage(page([saved])); await request; });
  expect(view.result.current.getSessionSlot('session-a')?.realtimeMessages).toEqual([]);
  const tail = row('later-answer', 'assistant', '2026-09-08T01:00:00Z');
  sessionMessages.mockResolvedValueOnce(page([tail], 2, true));
  await act(async () => { await view.result.current.fetchFromServer('session-a', { limit: 1 }); });
  expect(view.result.current.getMessages('session-a')).toEqual([tail]);
});
