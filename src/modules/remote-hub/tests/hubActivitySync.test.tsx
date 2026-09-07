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
  emit(status: string) { this.onmessage?.({ data: JSON.stringify({ kind: 'session_activity', sessionId: 'same-session', status, eventId: `run:${status}`, runId: 'run', seq: 1 }) }); }
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
