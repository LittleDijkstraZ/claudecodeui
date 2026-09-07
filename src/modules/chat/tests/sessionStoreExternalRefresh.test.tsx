import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

const { sessionMessages } = vi.hoisted(() => ({ sessionMessages: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages } } }));

const row = (id: string, content: string, sessionId = 'main'): NormalizedMessage => ({
  id, content, sessionId, provider: 'claude', kind: 'text', role: 'assistant',
  timestamp: '2026-09-07T12:00:00Z',
});
const response = (messages: NormalizedMessage[]) => ({
  ok: true, json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
});

beforeEach(() => sessionMessages.mockReset());

for (const mode of ['initial', 'tail'] as const) {
  test(`${mode} history read cannot overwrite a same-ID live update arriving during REST`, async () => {
    const { result } = renderHook(() => useSessionStore());
    if (mode === 'tail') {
      sessionMessages.mockResolvedValueOnce(response([row('reply', 'old disk reply')]));
      await act(async () => { await result.current.fetchFromServer('main'); });
    }
    act(() => { result.current.appendRealtime('other', row('other-row', 'another session', 'other')); });
    let resolveRead!: (value: ReturnType<typeof response>) => void;
    sessionMessages.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = mode === 'initial'
        ? result.current.fetchFromServer('main')
        : result.current.refreshLatestFromServer('main');
      await Promise.resolve();
    });
    act(() => { result.current.appendRealtime('main', row('reply', 'new live reply')); });
    await act(async () => { resolveRead(response([row('reply', 'old disk reply')])); await pending; });
    expect(result.current.getMessages('main').map(message => message.content)).toEqual(['new live reply']);
    expect(result.current.getMessages('other').map(message => message.content)).toEqual(['another session']);

    // The next persisted snapshot owns the live row, so it deduplicates normally.
    sessionMessages.mockResolvedValueOnce(response([row('reply', 'new live reply')]));
    await act(async () => { await result.current.refreshLatestFromServer('main'); });
    expect(result.current.getMessages('main').map(message => message.content)).toEqual(['new live reply']);
    expect(result.current.getSessionSlot('main')!.realtimeMessages).toEqual([]);
  });
}

test('external Shell history appends without discarding a live Chat stream', async () => {
  const { result } = renderHook(() => useSessionStore());
  sessionMessages.mockResolvedValueOnce(response([row('earlier', 'already persisted')]));
  await act(async () => { await result.current.fetchFromServer('main'); });
  act(() => { result.current.updateStreaming('main', 'still generating', 'claude'); });
  sessionMessages.mockResolvedValueOnce(response([
    row('earlier', 'already persisted'), { ...row('shell-reply', 'new Shell reply'), timestamp: '2026-09-07T12:00:01Z' },
  ]));
  await act(async () => { await result.current.refreshLatestFromServer('main'); });
  expect(result.current.getMessages('main').map(message => message.content)).toEqual([
    'already persisted', 'new Shell reply', 'still generating',
  ]);
});
