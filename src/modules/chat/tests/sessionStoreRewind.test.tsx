import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

const { sessionMessages } = vi.hoisted(() => ({ sessionMessages: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { providers: { sessionMessages } },
}));

const row = (id: string, sessionId = 'main'): NormalizedMessage => ({
  id, sessionId, provider: 'claude', kind: 'text', role: 'assistant', content: id,
  timestamp: '2026-09-07T12:00:00Z',
});
const response = (messages: NormalizedMessage[], total = messages.length, hasMore = false) => ({
  ok: true,
  json: async () => ({ data: { messages, total, hasMore, tokenUsage: { used: 123 } } }),
});

beforeEach(() => sessionMessages.mockReset());

test('rewind reset serializes behind old pages and replaces remapped transcript IDs without clearing another session', async () => {
  sessionMessages.mockResolvedValueOnce(response([row('old-tail')], 2, true));
  const { result } = renderHook(() => useSessionStore());
  await act(async () => { await result.current.fetchFromServer('main'); });
  act(() => {
    result.current.appendRealtime('main', row('old-live'));
    result.current.appendRealtime('other', row('other-live', 'other'));
  });

  let resolveOldPage!: (page: ReturnType<typeof response>) => void;
  sessionMessages.mockImplementationOnce(() => new Promise(resolve => { resolveOldPage = resolve; }));
  let oldRead!: ReturnType<typeof result.current.fetchMore>;
  await act(async () => {
    oldRead = result.current.fetchMore('main');
    await Promise.resolve();
  });
  const originalQueue = result.current.getSessionSlot('main')!._historyMutationQueue;
  let reset!: Promise<void>;
  act(() => { reset = result.current.resetHistory('main'); });
  expect(result.current.getSessionSlot('main')!._historyMutationQueue).not.toBe(originalQueue);
  expect(result.current.getMessages('main').some(message => message.id === 'old-live')).toBe(true);

  await act(async () => {
    resolveOldPage(response([row('old-head')], 2));
    await oldRead;
    await reset;
  });
  const slot = result.current.getSessionSlot('main')!;
  expect(slot.merged).toEqual([]);
  expect(slot.tokenUsage).toBeUndefined();
  expect(slot.offset).toBe(0);
  expect(slot.total).toBe(0);
  expect(result.current.getMessages('other').map(message => message.id)).toEqual(['other-live']);

  sessionMessages.mockResolvedValueOnce(response([row('new-native-uuid')]));
  await act(async () => { await result.current.fetchFromServer('main'); });
  expect(result.current.getMessages('main').map(message => message.id)).toEqual(['new-native-uuid']);
});
