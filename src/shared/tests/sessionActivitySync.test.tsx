import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';

import type { ServerEvent } from '@/shared/types';
const transport = vi.hoisted(() => ({ listeners: new Set<(event: ServerEvent) => void>(), requests: [] as Array<(value: unknown) => void> }));
vi.mock('@/shared/api', () => ({ api: { runningSessions: () => new Promise(resolve => transport.requests.push(resolve)) } }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: (listener: (event: ServerEvent) => void) => { transport.listeners.add(listener); return () => transport.listeners.delete(listener); } }) }));
import { SessionProtectionProvider, useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
const wrapper = ({ children }: { children: ReactNode }) => <SessionProtectionProvider>{children}</SessionProtectionProvider>;
const emit = (sessionId: string, status: string) => { for (const listener of transport.listeners) listener({ kind: 'session_activity', sessionId, status }); };
const snapshot = (sessions: string[]) => ({ ok: true, json: async () => ({ data: { sessions: sessions.map(sessionId => ({ sessionId })) } }) });
beforeEach(() => { transport.requests.length = 0; transport.listeners.clear(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

test('live state reaches every sidebar consumer before polling and an old empty snapshot cannot erase it', async () => {
  const { result } = renderHook(useBusySessionIdSet, { wrapper });
  act(() => emit('session-a', 'running'));
  expect(result.current.has('session-a')).toBe(true);
  await act(async () => { transport.requests.shift()!(snapshot([])); });
  expect(result.current.has('session-a')).toBe(true);
  act(() => emit('session-b', 'permission'));
  expect([...result.current].sort()).toEqual(['session-a', 'session-b']);
});
test('a delayed running snapshot cannot resurrect a completed session or affect another session', async () => {
  const { result } = renderHook(useBusySessionIdSet, { wrapper });
  await act(async () => { transport.requests.shift()!(snapshot(['session-a', 'session-b'])); });
  act(() => vi.advanceTimersByTime(5000));
  act(() => emit('session-a', 'complete'));
  await act(async () => { transport.requests.shift()!(snapshot(['session-a', 'session-b'])); });
  expect([...result.current]).toEqual(['session-b']);
});
