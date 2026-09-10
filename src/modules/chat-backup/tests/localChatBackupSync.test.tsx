import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useLocalChatBackupSync } from '@/modules/chat-backup/hooks/useLocalChatBackupSync';
import type { ChatBackupBundle, HubRemote, LocalChatBackupStatus } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), toggle: vi.fn(), token: vi.fn(), recent: vi.fn(), export: vi.fn(), save: vi.fn(),
}));
vi.mock('@/shared/api', () => ({
  getLocalChatBackups: mocks.get,
  setLocalChatBackupEnabled: mocks.toggle,
  remoteToken: mocks.token,
  saveLocalChatBackup: mocks.save,
  hubApi: { recent: mocks.recent, exportChatBackup: mocks.export },
}));
const remotes: HubRemote[] = [{ id: 'alpha', name: 'Alpha', port: 3101 }, { id: 'beta', name: 'Beta', port: 3102 }];
const bundle: ChatBackupBundle = {
  format: 'cloudcli-chat-backup', version: 1, createdAt: '2026-09-09T00:00:00Z',
  session: { id: 'one', provider: 'claude', providerSessionId: 'native-one', title: 'One', projectPath: '/project', model: null, effort: null },
  files: [{ path: 'main.jsonl', content: '{}\n' }],
};
let inventory: LocalChatBackupStatus;
beforeEach(() => {
  vi.clearAllMocks();
  inventory = { enabled: false, directory: '/fixture/chat-backups', backups: [] };
  mocks.get.mockImplementation(async () => structuredClone(inventory));
  mocks.toggle.mockImplementation(async enabled => { inventory.enabled = enabled; return structuredClone(inventory); });
  mocks.token.mockReturnValue('fixture');
  mocks.recent.mockResolvedValue({ conversations: [{ sessionId: 'one', provider: 'claude', lastActivity: '2026-09-09T00:00:00Z' }], total: 1 });
  mocks.export.mockResolvedValue(bundle);
  mocks.save.mockImplementation(async payload => {
    const backup = { id: `${payload.remoteId}-one`, remoteId: payload.remoteId, remoteName: payload.remoteName,
      sessionId: 'one', title: 'One', provider: 'claude' as const, projectPath: '/project',
      savedAt: bundle.createdAt, sourceUpdatedAt: payload.sourceUpdatedAt, bytes: 100 };
    inventory.backups = [...inventory.backups.filter(item => item.id !== backup.id), backup];
    return { backup };
  });
});

test('default-off initialization never reads a remote chat or writes a local archive', async () => {
  const { result } = renderHook(() => useLocalChatBackupSync(remotes));
  await waitFor(() => expect(result.current.status?.enabled).toBe(false));
  await act(async () => { await result.current.syncNow(); });
  expect(mocks.recent).not.toHaveBeenCalled();
  expect(mocks.export).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

test('opt-in backs up identical session IDs independently and skips unchanged copies on the next scan', async () => {
  const { result } = renderHook(() => useLocalChatBackupSync(remotes));
  await waitFor(() => expect(result.current.status).not.toBeNull());
  await act(async () => { await result.current.setEnabled(true); });
  await waitFor(() => expect(inventory.backups).toHaveLength(2));
  await waitFor(() => expect(result.current.syncing).toBe(false));
  expect(mocks.export.mock.calls.map(call => call.slice(0, 2))).toEqual([['alpha', 'one'], ['beta', 'one']]);
  await act(async () => { await result.current.syncNow(); });
  expect(mocks.export).toHaveBeenCalledTimes(2);
});

test('a partial export failure preserves the previous disk snapshot and retries the next scan', async () => {
  inventory.enabled = true;
  mocks.export.mockRejectedValueOnce(new Error('Transcript is changing'));
  const { result } = renderHook(() => useLocalChatBackupSync(remotes));
  await waitFor(() => expect(result.current.error).toContain('Transcript is changing'));
  expect(inventory.backups.map(item => item.remoteId)).toEqual(['beta']);
  await act(async () => { await result.current.syncNow(); });
  expect(inventory.backups).toHaveLength(2);
  expect(result.current.error).toBeNull();
});

test('disabling while an export is pending prevents its contents from being saved', async () => {
  inventory.enabled = true;
  let resolve!: (value: ChatBackupBundle) => void;
  mocks.export.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { result } = renderHook(() => useLocalChatBackupSync(remotes));
  await waitFor(() => expect(mocks.export).toHaveBeenCalledTimes(1));
  await act(async () => { await result.current.setEnabled(false); });
  await act(async () => { resolve(bundle); });
  expect(result.current.status?.enabled).toBe(false);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.export).toHaveBeenCalledTimes(1);
});

test('enabling during a pending status check starts a fresh scan and ignores the old disabled status', async () => {
  const { result } = renderHook(() => useLocalChatBackupSync(remotes));
  await waitFor(() => expect(result.current.status?.enabled).toBe(false));
  let resolveStatus!: (value: LocalChatBackupStatus) => void;
  mocks.get.mockImplementationOnce(() => new Promise(done => { resolveStatus = done; }));
  let pendingScan!: Promise<void>;
  act(() => { pendingScan = result.current.syncNow(); });
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  await act(async () => { await result.current.setEnabled(true); });
  expect(result.current.status?.enabled).toBe(true);
  await act(async () => {
    resolveStatus({ enabled: false, directory: '/fixture/chat-backups', backups: [] });
    await pendingScan;
  });
  await waitFor(() => expect(inventory.backups).toHaveLength(2));
  expect(result.current.status?.enabled).toBe(true);
});

test('turning sync back on while a cancelled export settles immediately resumes the backup', async () => {
  inventory.enabled = true;
  let resolveExport!: (value: ChatBackupBundle) => void;
  mocks.export.mockImplementationOnce(() => new Promise(done => { resolveExport = done; }));
  const { result } = renderHook(() => useLocalChatBackupSync(remotes));
  await waitFor(() => expect(mocks.export).toHaveBeenCalledTimes(1));
  await act(async () => { await result.current.setEnabled(false); });
  await act(async () => { await result.current.setEnabled(true); });
  await act(async () => { resolveExport(bundle); });
  await waitFor(() => expect(inventory.backups).toHaveLength(2));
  expect(result.current.status?.enabled).toBe(true);
  expect(mocks.export).toHaveBeenCalledTimes(3);
});

test('initial backup scans older pages rather than stopping at the first hundred conversations', async () => {
  inventory.enabled = true;
  mocks.recent.mockImplementation(async (_remote, offset) => offset === 0
    ? { conversations: Array.from({ length: 100 }, (_, i) => ({ sessionId: `unsupported-${i}`, provider: 'cursor' })), total: 101 }
    : { conversations: [{ sessionId: 'older', provider: 'codex', lastActivity: null }], total: 101 });
  const { result } = renderHook(() => useLocalChatBackupSync(remotes));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.syncing).toBe(false));
  expect(mocks.recent.mock.calls.map(call => call.slice(0, 2))).toEqual([['alpha', 0], ['alpha', 100], ['beta', 0], ['beta', 100]]);
  expect(mocks.export.mock.calls.map(call => call[1])).toEqual(['older', 'older']);
});
