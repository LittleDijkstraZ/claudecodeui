import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';

import type { ServerEvent } from '@/shared/types';
const transport = vi.hoisted(() => ({ listeners: new Set<(event: ServerEvent) => void>(), requests: [] as Array<(value: unknown) => void> }));
vi.mock('@/shared/api', () => ({ api: { runningSessions: () => new Promise(resolve => transport.requests.push(resolve)) } }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: (listener: (event: ServerEvent) => void) => { transport.listeners.add(listener); return () => transport.listeners.delete(listener); } }) }));
import { SessionProtectionProvider, useBusySessionIdSet, useProcessingSessions } from '@/shared/context/SessionProtectionContext';
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

test('foreground and background phases survive live events and polls without dropping run protection', async () => {
  const { result } = renderHook(useProcessingSessions, { wrapper });
  const emitState = (phase: string, acceptsInput: boolean) => act(() => {
    for (const listener of transport.listeners) listener({ kind: 'status', text: 'claude_runtime_state', sessionId: 'session-a', phase, acceptsInput, backgroundTasks: 2, executionId: 'run-one' });
  });
  emitState('foreground', true);
  emitState('background', true);
  expect(result.current.get('session-a')).toMatchObject({ phase: 'background', acceptsInput: true, backgroundTasks: 2 });
  await act(async () => { transport.requests.shift()!(snapshot([])); });
  expect(result.current.has('session-a')).toBe(true);
  act(() => vi.advanceTimersByTime(5000));
  await act(async () => { transport.requests.shift()!({ ok: true, json: async () => ({ data: { sessions: [{ sessionId: 'session-a', phase: 'background', acceptsInput: true, backgroundTasks: 1, executionId: 'run-one' }] } }) }); });
  expect(result.current.get('session-a')?.backgroundTasks).toBe(1);
  emitState('foreground', false);
  expect(result.current.get('session-a')).toMatchObject({ phase: 'foreground', acceptsInput: false });
  act(() => emit('session-a', 'complete'));
  expect(result.current.has('session-a')).toBe(false);
});

test('a per-turn error preserves the running Workflow until an actual terminal error', () => {
  const { result } = renderHook(useProcessingSessions, { wrapper });
  act(() => {
    for (const listener of transport.listeners) listener({ kind: 'status', text: 'claude_runtime_state', sessionId: 'session-a', phase: 'background', acceptsInput: true, backgroundTasks: 2 });
  });
  act(() => {
    for (const listener of transport.listeners) listener({ kind: 'session_activity', sessionId: 'session-a', status: 'error', isProcessing: true });
  });
  expect(result.current.get('session-a')).toMatchObject({ phase: 'background', acceptsInput: true, backgroundTasks: 2 });
  act(() => {
    for (const listener of transport.listeners) listener({ kind: 'session_activity', sessionId: 'session-a', status: 'error', isProcessing: false });
  });
  expect(result.current.has('session-a')).toBe(false);
  act(() => emit('session-b', 'running'));
  act(() => emit('session-b', 'error'));
  expect(result.current.has('session-b')).toBe(false);
});
