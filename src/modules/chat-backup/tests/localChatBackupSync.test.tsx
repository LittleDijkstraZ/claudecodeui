import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useLocalChatBackupSync } from '@/modules/chat-backup/hooks/useLocalChatBackupSync';
import type { ChatBackupBundle, ChatBackupSessionSnapshot, HubGroupState, HubRemote, HubRemoteState, LocalChatBackupStatus } from '@/shared/types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), settings: vi.fn(), token: vi.fn(), inventory: vi.fn(), export: vi.fn(), save: vi.fn(), observe: vi.fn() }));
vi.mock('@/shared/api', () => ({
  getLocalChatBackups: mocks.get, setLocalChatBackupSettings: mocks.settings, remoteToken: mocks.token,
  saveLocalChatBackup: mocks.save, saveLocalChatBackupObservations: mocks.observe,
  hubApi: { chatBackupInventory: mocks.inventory, exportChatBackup: mocks.export },
}));
const remotes: HubRemote[] = [{ id: 'alpha', name: 'Alpha', port: 3101 }, { id: 'beta', name: 'Beta', port: 3102 }];
const groups: HubGroupState = { revision: 1, imported: [], groups: [{ id: 'group', name: 'Work', isPinned: true,
  members: remotes.map(remote => ({ remoteId: remote.id, sessionId: 'one', title: 'One', projectId: 'project', projectPath: '/project', provider: 'claude' })) }] };
const states: Record<string, HubRemoteState> = { alpha: { status: 'online', conversations: [], projects: [], running: [], total: 0, attention: ['one'] } };
const bundle: ChatBackupBundle = {
  format: 'cloudcli-chat-backup', version: 1, createdAt: '2026-09-09T00:00:00Z',
  session: { id: 'one', provider: 'claude', providerSessionId: 'native-one', title: 'One', projectPath: '/project', model: null, effort: null },
  files: [{ path: 'main.jsonl', content: '{}\n' }],
};
const session = (overrides: Partial<ChatBackupSessionSnapshot> = {}): ChatBackupSessionSnapshot => ({
  sessionId: 'one', provider: 'claude', title: 'One', projectId: 'project', projectPath: '/project', model: 'model', effort: 'high',
  isArchived: false, updatedAt: '2026-09-09T00:00:00Z', history: 'native', contentVersion: 'content-1', runtimeStatus: 'idle', ...overrides,
});
const freshStatus = (): LocalChatBackupStatus => ({ enabled: false, scope: 'grouped', settingsRevision: 0, sourceId: 'source-hub', snapshots: [], directory: '/fixture/chat-backups', backups: [] });
let inventory: LocalChatBackupStatus;
beforeEach(() => {
  vi.clearAllMocks();
  inventory = freshStatus();
  mocks.get.mockImplementation(async () => structuredClone(inventory));
  mocks.settings.mockImplementation(async patch => {
    if (patch.settingsRevision !== inventory.settingsRevision) throw new Error('备份设置已被其他窗口修改');
    Object.assign(inventory, patch); inventory.settingsRevision += 1; return structuredClone(inventory);
  });
  mocks.token.mockReturnValue('fixture');
  mocks.inventory.mockResolvedValue({ sessions: [session()], nextCursor: null, missingSessionIds: [] });
  mocks.export.mockImplementation(async (_remoteId, sessionId) => ({ ...bundle, session: { ...bundle.session, id: sessionId } }));
  mocks.observe.mockImplementation(async () => structuredClone(inventory));
  mocks.save.mockImplementation(async payload => {
    const backup = { id: `${payload.remoteId}-${payload.bundle.session.id}`, remoteId: payload.remoteId, remoteName: payload.remoteName,
      sessionId: payload.bundle.session.id, title: 'One', provider: 'claude' as const, projectPath: '/project',
      savedAt: bundle.createdAt, sourceUpdatedAt: payload.sourceUpdatedAt, contentVersion: payload.contentVersion, bytes: 100 };
    inventory.backups = [...inventory.backups.filter(item => item.id !== backup.id), backup];
    return { backup };
  });
});
afterEach(() => vi.useRealTimers());

const renderSync = () => renderHook(() => useLocalChatBackupSync(remotes, groups, states));

test('default-off initialization and scope selection never read remote content or write observations', async () => {
  const { result } = renderSync();
  await waitFor(() => expect(result.current.status?.enabled).toBe(false));
  await act(async () => { await result.current.setScope('all'); await result.current.syncNow(); });
  expect(result.current.status?.scope).toBe('all');
  expect(mocks.inventory).not.toHaveBeenCalled();
  expect(mocks.export).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.observe).not.toHaveBeenCalled();
});

test('grouped opt-in scopes identical IDs to their remotes and skips unchanged native content', async () => {
  const { result } = renderSync();
  await waitFor(() => expect(result.current.status).not.toBeNull());
  await act(async () => { await result.current.setEnabled(true); });
  await waitFor(() => expect(inventory.backups).toHaveLength(2));
  await waitFor(() => expect(result.current.syncing).toBe(false));
  expect(mocks.inventory.mock.calls.map(call => call.slice(0, 2))).toEqual([['alpha', { sessionIds: ['one'] }], ['beta', { sessionIds: ['one'] }]]);
  expect(mocks.export.mock.calls.map(call => call.slice(0, 2))).toEqual([['alpha', 'one'], ['beta', 'one']]);
  await act(async () => { await result.current.syncNow(); });
  expect(mocks.export).toHaveBeenCalledTimes(2);
  expect(mocks.observe).toHaveBeenCalledTimes(6);
});

test('a partial export failure preserves disk copies and retries on the next scan', async () => {
  inventory.enabled = true;
  mocks.export.mockRejectedValueOnce(new Error('Transcript is changing'));
  const { result } = renderSync();
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
  const { result } = renderSync();
  await waitFor(() => expect(mocks.export).toHaveBeenCalledTimes(1));
  await act(async () => { await result.current.setEnabled(false); resolve(bundle); });
  expect(result.current.status?.enabled).toBe(false);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.export).toHaveBeenCalledTimes(1);
});

test('enabling during a pending status check ignores an older disabled response and starts a fresh scan', async () => {
  const { result } = renderSync();
  await waitFor(() => expect(result.current.status?.enabled).toBe(false));
  let resolveStatus!: (value: LocalChatBackupStatus) => void;
  mocks.get.mockImplementationOnce(() => new Promise(done => { resolveStatus = done; }));
  let pendingScan!: Promise<void>;
  act(() => { pendingScan = result.current.syncNow(); });
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  await act(async () => { await result.current.setEnabled(true); });
  await act(async () => { resolveStatus(freshStatus()); await pendingScan; });
  await waitFor(() => expect(inventory.backups).toHaveLength(2));
  expect(result.current.status?.enabled).toBe(true);
});

test('turning sync back on while a cancelled export settles resumes immediately', async () => {
  inventory.enabled = true;
  let resolveExport!: (value: ChatBackupBundle) => void;
  mocks.export.mockImplementationOnce(() => new Promise(done => { resolveExport = done; }));
  const { result } = renderSync();
  await waitFor(() => expect(mocks.export).toHaveBeenCalledTimes(1));
  await act(async () => { await result.current.setEnabled(false); await result.current.setEnabled(true); resolveExport(bundle); });
  await waitFor(() => expect(inventory.backups).toHaveLength(2));
  expect(mocks.export).toHaveBeenCalledTimes(3);
  expect(mocks.save.mock.calls.every(call => call[0].settingsRevision === 2)).toBe(true);
});

test('all scope follows stable cursors and includes archived sessions independently of groups', async () => {
  inventory.enabled = true; inventory.scope = 'all';
  mocks.inventory.mockImplementation(async (_remote, payload) => !payload.cursor
    ? { sessions: [session({ sessionId: 'unsupported', provider: 'cursor', history: 'unsupported' })], nextCursor: 'stable-page-2', missingSessionIds: [] }
    : { sessions: [session({ sessionId: 'older', provider: 'codex', isArchived: true })], nextCursor: null, missingSessionIds: [] });
  const { result } = renderSync();
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.syncing).toBe(false));
  expect(mocks.inventory.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ['alpha', { cursor: undefined, limit: 100 }], ['alpha', { cursor: 'stable-page-2', limit: 100 }],
    ['beta', { cursor: undefined, limit: 100 }], ['beta', { cursor: 'stable-page-2', limit: 100 }],
  ]);
  expect(mocks.export.mock.calls.map(call => call[1])).toEqual(['older', 'older']);
  expect(mocks.observe.mock.calls.some(call => call[0].observations.some((row: ChatBackupSessionSnapshot) => row.isArchived))).toBe(true);
});

test('grouped inventories batch all members, including those never loaded in the sidebar', async () => {
  inventory.enabled = true;
  mocks.inventory.mockResolvedValue({ sessions: [], nextCursor: null, missingSessionIds: [] });
  const manyGroups = { ...groups, groups: [{ ...groups.groups[0], members: Array.from({ length: 501 }, (_, index) => ({ ...groups.groups[0].members[0], sessionId: `old-${index}` })) }] };
  const { result } = renderHook(() => useLocalChatBackupSync(remotes, manyGroups, {}));
  await waitFor(() => expect(mocks.inventory).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.syncing).toBe(false));
  expect(mocks.inventory.mock.calls.map(call => [call[0], call[1].sessionIds.length])).toEqual([['alpha', 500], ['alpha', 1]]);
});

test('empty conversations record metadata without exporting or reporting failure', async () => {
  inventory.enabled = true;
  mocks.inventory.mockResolvedValue({ sessions: [session({ history: 'empty', contentVersion: null, runtimeStatus: 'running' })], nextCursor: null, missingSessionIds: [] });
  const { result } = renderSync();
  await waitFor(() => expect(mocks.inventory).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.syncing).toBe(false));
  expect(mocks.export).not.toHaveBeenCalled();
  expect(result.current.error).toBeNull();
  expect(mocks.observe.mock.calls[1][0].observations[0]).toMatchObject({ history: 'empty', runtimeStatus: 'running', attention: true });
  expect(mocks.observe.mock.calls[2][0].observations[0].attention).toBeNull();
});

test('metadata-only changes are observed while contentVersion controls native copies', async () => {
  inventory.enabled = true;
  const { result } = renderSync();
  await waitFor(() => expect(inventory.backups).toHaveLength(2));
  await waitFor(() => expect(result.current.syncing).toBe(false));
  mocks.inventory.mockResolvedValue({ sessions: [session({ title: 'Renamed', isArchived: true, model: 'new-model', effort: 'max', updatedAt: '2026-09-10T00:00:00Z' })], nextCursor: null, missingSessionIds: [] });
  await act(async () => { await result.current.syncNow(); });
  expect(mocks.export).toHaveBeenCalledTimes(2);
  expect(mocks.observe.mock.calls.at(-1)?.[0].observations[0]).toMatchObject({ title: 'Renamed', isArchived: true, model: 'new-model', effort: 'max' });
  mocks.inventory.mockResolvedValue({ sessions: [session({ contentVersion: 'content-2' })], nextCursor: null, missingSessionIds: [] });
  await act(async () => { await result.current.syncNow(); });
  expect(mocks.export).toHaveBeenCalledTimes(4);
});

test('a scope change fences an in-flight all-chat export before grouped synchronization resumes', async () => {
  inventory.enabled = true; inventory.scope = 'all';
  let resolve!: (value: ChatBackupBundle) => void;
  mocks.export.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { result } = renderSync();
  await waitFor(() => expect(mocks.export).toHaveBeenCalledOnce());
  await act(async () => { await result.current.setScope('grouped'); resolve(bundle); });
  await waitFor(() => expect(inventory.backups).toHaveLength(2));
  expect(mocks.save.mock.calls.every(call => call[0].settingsRevision === 1)).toBe(true);
  expect(mocks.inventory.mock.calls.slice(1).every(call => Array.isArray(call[1].sessionIds))).toBe(true);
});

test('unchanged polling objects do not rescan, while membership and attention changes are debounced', async () => {
  inventory.enabled = true;
  const { result, rerender } = renderHook(({ currentGroups, currentStates }) => useLocalChatBackupSync(remotes, currentGroups, currentStates), { initialProps: { currentGroups: groups, currentStates: states } });
  await waitFor(() => expect(inventory.backups).toHaveLength(2));
  await waitFor(() => expect(result.current.syncing).toBe(false));
  vi.useFakeTimers();
  rerender({ currentGroups: structuredClone(groups), currentStates: structuredClone(states) });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(mocks.inventory).toHaveBeenCalledTimes(2);
  rerender({ currentGroups: { ...groups, revision: 2, groups: [] }, currentStates: { ...states, alpha: { ...states.alpha, attention: [] } } });
  await act(async () => { await vi.advanceTimersByTimeAsync(750); });
  expect(mocks.observe.mock.calls.at(-1)?.[0].observations).toEqual([]);
  expect(mocks.observe).toHaveBeenCalledTimes(4);
  expect(mocks.inventory).toHaveBeenCalledTimes(2);
});

test('removing a member while another export is pending prevents reading the removed conversation', async () => {
  inventory.enabled = true;
  const initialGroups: HubGroupState = { ...groups, groups: [{ ...groups.groups[0], members: [groups.groups[0].members[0], { ...groups.groups[0].members[0], sessionId: 'removed' }] }] };
  mocks.inventory.mockResolvedValue({ sessions: [session(), session({ sessionId: 'removed' })], nextCursor: null, missingSessionIds: [] });
  let resolve!: (value: ChatBackupBundle) => void;
  mocks.export.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { result, rerender } = renderHook(({ currentGroups }) => useLocalChatBackupSync(remotes, currentGroups, states), { initialProps: { currentGroups: initialGroups } });
  await waitFor(() => expect(mocks.export).toHaveBeenCalledOnce());
  rerender({ currentGroups: { ...initialGroups, revision: 2, groups: [{ ...initialGroups.groups[0], members: [initialGroups.groups[0].members[0]] }] } });
  await act(async () => { resolve(bundle); });
  await waitFor(() => expect(result.current.syncing).toBe(false));
  expect(mocks.export.mock.calls.map(call => call[1])).toEqual(['one']);
  expect(mocks.save.mock.calls.map(call => call[0].bundle.session.id)).toEqual(['one']);
});

test('a stale enable rejected after another window changes settings refreshes without replaying the patch', async () => {
  const { result } = renderSync();
  await waitFor(() => expect(result.current.status?.settingsRevision).toBe(0));
  // A different Hub window has already saved its explicit off setting.
  inventory.settingsRevision = 1;
  await act(async () => { await expect(result.current.setEnabled(true)).rejects.toThrow('其他窗口修改'); });
  expect(mocks.settings).toHaveBeenCalledExactlyOnceWith({ enabled: true, settingsRevision: 0 });
  expect(result.current.status).toMatchObject({ enabled: false, settingsRevision: 1 });
  expect(mocks.inventory).not.toHaveBeenCalled();
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(mocks.export).not.toHaveBeenCalled();
});
