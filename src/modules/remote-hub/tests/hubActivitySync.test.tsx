import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { HubRemote } from '@/shared/types';
const mocks = vi.hoisted(() => ({ health: vi.fn(), running: vi.fn() }));
vi.mock('@/shared/api', () => ({
  remoteToken: () => 'fixture.token.value',
  hubApi: { health: mocks.health, running: mocks.running, projects: async () => [], recent: async () => ({ conversations: [], total: 0, hasMore: false }), socketUrl: (id: string) => `ws://fixture/${id}` },
}));
import { useHubConnections } from '@/modules/remote-hub/hooks/useHubConnections';
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen?: () => void; onclose?: () => void; onerror?: () => void; onmessage?: (event: { data: string }) => void;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.onclose?.(); }
  emit(status: string, seq = 1, isProcessing?: boolean) { this.onmessage?.({ data: JSON.stringify({ kind: 'session_activity', sessionId: 'same-session', status, eventId: `run:${status}:${seq}`, runId: 'run', seq, isProcessing }) }); }
}
const remotes: HubRemote[] = [{ id: 'alpha', name: 'Alpha', port: 43118 }, { id: 'beta', name: 'Beta', port: 43119 }];
beforeEach(() => { localStorage.clear(); FakeSocket.instances = []; mocks.health.mockReset().mockResolvedValue({}); mocks.running.mockReset().mockResolvedValue({ sessions: [] }); vi.stubGlobal('WebSocket', FakeSocket); });
afterEach(() => vi.unstubAllGlobals());

test('identical session IDs are isolated per machine and late polling cannot resurrect a completed run', async () => {
  const notify = vi.fn();
  const { result } = renderHook(() => useHubConnections(remotes, notify));
  await act(async () => {});
  const alpha = FakeSocket.instances.find(socket => socket.url.endsWith('/alpha'))!;
  act(() => alpha.emit('running'));
  expect(result.current.states.alpha.running).toEqual(['same-session']);
  expect(result.current.states.beta.running).toEqual([]);
  await act(async () => {});
  let resolve!: (value: unknown) => void;
  mocks.running.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  let refresh!: Promise<void>;
  await act(async () => { refresh = result.current.refresh('alpha'); });
  act(() => alpha.emit('complete'));
  expect(result.current.states.alpha.running).toEqual([]);
  expect(result.current.states.alpha.attention).toEqual(['same-session']);
  await act(async () => { resolve({ sessions: [{ sessionId: 'same-session' }] }); await refresh; });
  expect(result.current.states.alpha.running).toEqual([]);
  expect(result.current.states.beta.attention).toEqual([]);
  expect(notify).toHaveBeenCalledWith('alpha', 'same-session', '已完成');
  mocks.health.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await result.current.refresh('alpha'); });
  expect(result.current.states.alpha.status).toBe('offline');
  expect(result.current.states.beta.status).toBe('online');
});


test('starting another run does not clear an unread reply; only reading does', async () => {
  const { result } = renderHook(() => useHubConnections(remotes, vi.fn()));
  await act(async () => {});
  const alpha = FakeSocket.instances.find(socket => socket.url.endsWith('/alpha'))!;
  act(() => alpha.emit('complete'));
  act(() => alpha.emit('running'));
  expect(result.current.states.alpha.attention).toEqual(['same-session']);
  act(() => result.current.markRead('alpha', 'same-session'));
  expect(result.current.states.alpha.attention).toEqual([]);
  expect(result.current.states.alpha.running).toEqual(['same-session']);
});

test('foreground replies become unread while the Workflow keeps running, without duplicate notifications or replay unread', async () => {
  const notify = vi.fn();
  const { result } = renderHook(() => useHubConnections(remotes, notify));
  await act(async () => {});
  const alpha = FakeSocket.instances.find(socket => socket.url.endsWith('/alpha'))!;
  act(() => alpha.emit('running'));
  act(() => alpha.emit('response_complete', 3));
  expect(result.current.states.alpha.running).toEqual(['same-session']);
  expect(result.current.states.alpha.attention).toEqual(['same-session']);
  expect(result.current.states.beta.attention).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
  act(() => result.current.markRead('alpha', 'same-session'));
  act(() => alpha.emit('response_complete', 3));
  expect(result.current.states.alpha.attention).toEqual([]);
  act(() => alpha.emit('response_complete', 8));
  expect(result.current.states.alpha.attention).toEqual(['same-session']);
  act(() => result.current.markRead('alpha', 'same-session'));
  act(() => alpha.emit('response_complete', 3));
  expect(result.current.states.alpha.attention).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
});

test('a per-turn error marks attention without making a live Workflow idle', async () => {
  const notify = vi.fn();
  const { result } = renderHook(() => useHubConnections(remotes, notify));
  await act(async () => {});
  const alpha = FakeSocket.instances.find(socket => socket.url.endsWith('/alpha'))!;
  act(() => alpha.emit('running'));
  act(() => alpha.emit('error', 3, true));
  expect(result.current.states.alpha.running).toEqual(['same-session']);
  expect(result.current.states.alpha.attention).toEqual(['same-session']);
  expect(result.current.states.beta.running).toEqual([]);
  expect(result.current.states.beta.attention).toEqual([]);
  expect(notify).toHaveBeenCalledWith('alpha', 'same-session', '出现错误');
  act(() => alpha.emit('error', 4, false));
  expect(result.current.states.alpha.running).toEqual([]);
});
