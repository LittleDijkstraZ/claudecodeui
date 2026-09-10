import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import RemoteHubApp from '@/modules/remote-hub/RemoteHubApp';
import { getHubUnread } from '@/modules/remote-hub/utils/hubUnread';

const fixture = vi.hoisted(() => ({
  member: {
    remoteId: 'alpha', sessionId: 'session-a', title: 'Active conversation',
    projectId: 'project-a', projectPath: '/workspace/example', provider: 'claude',
  },
  running: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  remoteToken: () => 'fixture.token.value',
  loadHubGroups: async () => ({
    revision: 1, imported: ['alpha:fixture-user'],
    groups: [{ id: 'work', name: 'Work', isPinned: false, members: [fixture.member] }],
  }),
  changeHubGroups: vi.fn(),
  hubApi: {
    config: async () => ({ remotes: [{ id: 'alpha', name: 'Alpha', port: 43118 }] }),
    health: async () => ({}),
    projects: async () => [],
    recent: async () => ({ conversations: [fixture.member], total: 1, hasMore: false }),
    running: fixture.running,
    user: async () => ({ id: 'fixture-user' }),
    socketUrl: (id: string) => `ws://fixture/${id}`,
  },
}));

// Keep the real row, connection state and indicators; unrelated feature entry points stay inert.
vi.mock('@/modules/chat-backup', () => ({
  LocalChatBackupsDialog: () => null,
  useLocalChatBackupSync: () => ({}),
}));
vi.mock('@/modules/sidebar', () => ({
  useConversationGroupDrag: () => ({
    dragState: null, dropTarget: null, isMoving: false,
    rowProps: () => ({}), dragHandleProps: () => ({}),
  }),
}));

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;

  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.onclose?.(); }
  emit(status: string, seq: number) {
    this.onmessage?.({ data: JSON.stringify({
      kind: 'session_activity', sessionId: 'session-a', status,
      eventId: `run:${status}:${seq}`, runId: 'run', seq,
    }) });
  }
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  FakeSocket.instances = [];
  fixture.running.mockReset().mockResolvedValue({ sessions: [{ sessionId: 'session-a' }] });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('BroadcastChannel', class { postMessage() {} close() {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

test('a Hub row shows running before unread, restores the dot when idle, and clears it when read', async () => {
  render(<RemoteHubApp />);
  await screen.findByText('已连接');
  fireEvent.click(screen.getByRole('button', { name: 'Work 1' }));
  const row = screen.getByTestId('hub-conversation-row');
  const indicators = () => within(row).queryAllByRole('status').map(node => node.getAttribute('data-session-status'));
  const socket = FakeSocket.instances.find(candidate => candidate.url.endsWith('/alpha'))!;
  expect(indicators()).toEqual(['running']);

  // A reply can be unread while the same Workflow continues its next step.
  await act(async () => socket.emit('response_complete', 1));
  expect(getHubUnread('alpha')).toEqual(['session-a']);
  expect(indicators()).toEqual(['running']);

  fixture.running.mockResolvedValue({ sessions: [] });
  await act(async () => socket.emit('complete', 2));
  expect(getHubUnread('alpha')).toEqual(['session-a']);
  expect(indicators()).toEqual(['attention']);

  fireEvent.click(within(row).getByRole('link', { name: /Active conversation/ }));
  expect(getHubUnread('alpha')).toEqual([]);
  expect(indicators()).toEqual([]);
});

test('reading a running conversation keeps its spinner and does not restore unread when the visible run ends', async () => {
  render(<RemoteHubApp />);
  await screen.findByText('已连接');
  fireEvent.click(screen.getByRole('button', { name: 'Work 1' }));
  const row = screen.getByTestId('hub-conversation-row');
  const indicators = () => within(row).queryAllByRole('status').map(node => node.getAttribute('data-session-status'));
  const socket = FakeSocket.instances.find(candidate => candidate.url.endsWith('/alpha'))!;
  await act(async () => socket.emit('response_complete', 1));
  expect(getHubUnread('alpha')).toEqual(['session-a']);

  fireEvent.click(within(row).getByRole('link', { name: /Active conversation/ }));
  expect(getHubUnread('alpha')).toEqual([]);
  expect(indicators()).toEqual(['running']);

  // Reading follows the actual remote pane's navigation acknowledgement.
  const frame = screen.getByTitle('Alpha 对话') as HTMLIFrameElement;
  act(() => window.dispatchEvent(new MessageEvent('message', {
    origin: location.origin, source: frame.contentWindow,
    data: { kind: 'cloudcli:selection', ...fixture.member },
  })));
  fixture.running.mockResolvedValue({ sessions: [] });
  await act(async () => socket.emit('complete', 2));
  expect(getHubUnread('alpha')).toEqual([]);
  expect(indicators()).toEqual([]);
});
