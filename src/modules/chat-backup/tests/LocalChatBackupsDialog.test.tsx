import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalChatBackupsDialog } from '@/modules/chat-backup/LocalChatBackupsDialog';
import type { useLocalChatBackupSync } from '@/modules/chat-backup/hooks/useLocalChatBackupSync';
import { deleteLocalChatBackup, exportLocalChatBackup, exportLocalChatBackupSnapshot, hubApi, importLocalChatBackup, readLocalChatBackup, recordLocalChatBackupRestore, restoreLocalChatBackupGroups } from '@/shared/api';
import type { ChatBackupBundle, ChatBackupGroupSnapshot, HubProject, HubRemote, LocalChatBackupSummary, RestoredChatBackup } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  deleteLocalChatBackup: vi.fn(),
  importLocalChatBackup: vi.fn(),
  readLocalChatBackup: vi.fn(),
  exportLocalChatBackup: vi.fn(),
  exportLocalChatBackupSnapshot: vi.fn(),
  recordLocalChatBackupRestore: vi.fn(),
  restoreLocalChatBackupGroups: vi.fn(),
  hubApi: { projects: vi.fn(), restoreChatBackup: vi.fn() },
}));

const remotes: HubRemote[] = [{ id: 'source', name: '原机器', port: 3100 }, { id: 'destination', name: '新机器', port: 3200 }];
const backup: LocalChatBackupSummary = {
  id: 'backup-1', remoteId: 'source', remoteName: '原机器', sessionId: 'original-session', title: '本地同步方案',
  provider: 'claude', projectPath: '/old/project', savedAt: '2026-09-09T12:00:00.000Z', sourceUpdatedAt: null, bytes: 3000,
};
const bundle: ChatBackupBundle = {
  format: 'cloudcli-chat-backup', version: 1, createdAt: '2026-09-09T12:00:00.000Z',
  session: { id: 'original-session', provider: 'claude', title: '本地同步方案', projectPath: '/old/project', providerSessionId: 'native-original', model: null, effort: null },
  files: [{ path: 'native-original.jsonl', content: '{"message":"hello"}' }],
};
const restored: RestoredChatBackup = { sessionId: 'restored-session', provider: 'claude', projectPath: '/new/project', sessionName: '本地同步方案' };
const destinationProjects: HubProject[] = [{ projectId: 'new-project', fullPath: '/new/project', displayName: '新项目' }];
const snapshot: ChatBackupGroupSnapshot = {
  format: 'cloudcli-chat-groups', version: 1, sourceId: 'imported-hub', revision: 3, capturedAt: '2026-09-10T00:00:00Z',
  groups: [{ id: 'empty', name: '空分组', isPinned: true, members: [] }, { id: 'work', name: '迁移工作', isPinned: false, members: [{ remoteId: 'source', sessionId: 'original-session' }] }],
  observations: [{ remoteId: 'source', remoteName: '原机器', sessionId: 'original-session', provider: 'claude', title: '尚未开始的对话',
    projectId: 'old-project', projectPath: '/old/project', model: 'model', effort: 'high', isArchived: true, updatedAt: null,
    history: 'empty', contentVersion: null, runtimeStatus: 'idle', observedAt: '2026-09-10T00:00:00Z', attention: true }],
};

function createBackupSync(overrides: Partial<ReturnType<typeof useLocalChatBackupSync>> = {}): ReturnType<typeof useLocalChatBackupSync> {
  return {
    status: { enabled: false, scope: 'grouped', settingsRevision: 0, sourceId: 'source-hub', snapshots: [], directory: '/local/backups', backups: [backup] },
    error: null, syncing: false, progress: null,
    refresh: vi.fn(async () => {}), setEnabled: vi.fn(async () => {}), setScope: vi.fn(async () => {}), syncNow: vi.fn(async () => {}),
    ...overrides,
  };
}

function jsonFile(content: unknown) {
  const file = new File([JSON.stringify(content)], 'chat.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: vi.fn(async () => JSON.stringify(content)) });
  return file;
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('local chat backup dialog', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(deleteLocalChatBackup).mockReset().mockResolvedValue(undefined);
    vi.mocked(importLocalChatBackup).mockReset().mockResolvedValue({ backup });
    vi.mocked(readLocalChatBackup).mockReset().mockResolvedValue(bundle);
    vi.mocked(exportLocalChatBackup).mockReset().mockResolvedValue({ format: 'cloudcli-local-chat-backup', version: 1, sourceRemoteId: 'source', bundle, groups: null });
    vi.mocked(exportLocalChatBackupSnapshot).mockReset();
    vi.mocked(recordLocalChatBackupRestore).mockReset().mockResolvedValue({ revision: 1, groups: [], imported: [] });
    vi.mocked(restoreLocalChatBackupGroups).mockReset().mockResolvedValue({ revision: 1, groups: [], imported: [] });
    vi.mocked(hubApi.projects).mockReset().mockImplementation(async (remoteId: string) => remoteId === 'destination' ? destinationProjects : [{ projectId: 'old-project', fullPath: '/old/project', displayName: '旧项目' }]);
    vi.mocked(hubApi.restoreChatBackup).mockReset().mockResolvedValue(restored);
  });

  it('starts disabled and only changes the setting after an explicit toggle', async () => {
    const backupSync = createBackupSync();
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    expect((screen.getByRole('switch', { name: '自动同步到本地' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/默认关闭/)).toBeTruthy();
    expect(screen.getByText(/保存位置：\/local\/backups/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '立即同步' }) as HTMLButtonElement).disabled).toBe(true);
    expect(backupSync.setEnabled).not.toHaveBeenCalled();
    expect(backupSync.syncNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: '自动同步到本地' }));
    await waitFor(() => expect(backupSync.setEnabled).toHaveBeenCalledWith(true));
  });

  it('allows archive import while automatic sync is disabled', async () => {
    const backupSync = createBackupSync();
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择备份文件'), { target: { files: [jsonFile(bundle)] } });
    await waitFor(() => expect(importLocalChatBackup).toHaveBeenCalledWith(bundle));
    expect(backupSync.refresh).toHaveBeenCalledOnce();
    expect(backupSync.setEnabled).not.toHaveBeenCalled();
    expect(screen.getByText('备份已导入，可选择目标机器恢复。')).toBeTruthy();
  });

  it('rejects oversized imports before reading their content', async () => {
    const file = jsonFile(bundle);
    Object.defineProperty(file, 'size', { value: 80 * 1024 * 1024 + 1 });
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择备份文件'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('80 MB'));
    expect(file.text).not.toHaveBeenCalled();
    expect(importLocalChatBackup).not.toHaveBeenCalled();
  });

  it('shows invalid JSON errors and lets the user import a corrected file', async () => {
    const file = new File(['bad JSON'], 'bad.json');
    Object.defineProperty(file, 'text', { value: async () => 'bad JSON' });
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择备份文件'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('有效的 JSON'));
    fireEvent.change(screen.getByLabelText('选择备份文件'), { target: { files: [jsonFile(bundle)] } });
    await waitFor(() => expect(importLocalChatBackup).toHaveBeenCalledWith(bundle));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('exports the complete archive as a downloadable JSON file', async () => {
    const createObjectURL = vi.fn(() => 'blob:backup-download');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: '导出' }));
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      expect(exportLocalChatBackup).toHaveBeenCalledWith('backup-1');
      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
      const anchor = click.mock.contexts[0] as HTMLAnchorElement;
      expect(anchor.download).toBe('cloudcli-chat-claude-backup-1.json');
      expect(anchor.href).toBe('blob:backup-download');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:backup-download');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('restores the selected archive into an explicitly chosen destination project', async () => {
    const onRestored = vi.fn();
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复到机器' }));
    fireEvent.change(screen.getByLabelText('目标机器'), { target: { value: 'destination' } });
    await waitFor(() => expect(screen.getByRole('option', { name: '新项目 · /new/project' })).toBeTruthy());
    expect((screen.getByRole('button', { name: '恢复为新对话' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('项目文件夹'), { target: { value: '/new/project' } });
    fireEvent.click(screen.getByRole('button', { name: '恢复为新对话' }));
    await waitFor(() => expect(hubApi.restoreChatBackup).toHaveBeenCalledWith('destination', { bundle, projectPath: '/new/project' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith('destination', restored));
    expect(recordLocalChatBackupRestore).toHaveBeenCalledWith({ backupId: backup.id, remoteId: 'destination', result: restored });
  });

  it('ignores folder responses from a previously selected machine', async () => {
    const oldRequest = deferred<HubProject[]>();
    vi.mocked(hubApi.projects).mockImplementation(async (remoteId: string) => remoteId === 'source' ? oldRequest.promise : destinationProjects);
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复到机器' }));
    fireEvent.change(screen.getByLabelText('目标机器'), { target: { value: 'destination' } });
    await waitFor(() => expect(screen.getByRole('option', { name: '新项目 · /new/project' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('项目文件夹'), { target: { value: '/new/project' } });
    await act(async () => { oldRequest.resolve([{ projectId: 'stale', fullPath: '/stale/project', displayName: '过期项目' }]); await oldRequest.promise; });
    expect(screen.queryByText('过期项目 · /stale/project')).toBeNull();
    expect((screen.getByLabelText('项目文件夹') as HTMLSelectElement).value).toBe('/new/project');
    fireEvent.click(screen.getByRole('button', { name: '恢复为新对话' }));
    await waitFor(() => expect(hubApi.restoreChatBackup).toHaveBeenCalledWith('destination', { bundle, projectPath: '/new/project' }));
  });

  it('allows retrying a failed destination folder request', async () => {
    vi.mocked(hubApi.projects).mockRejectedValueOnce(new Error('目标机器暂时离线')).mockResolvedValueOnce(destinationProjects);
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复到机器' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目标机器暂时离线'));
    fireEvent.click(screen.getByRole('button', { name: '重新读取项目' }));
    await waitFor(() => expect(screen.getByRole('option', { name: '新项目 · /new/project' })).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('prevents duplicate restores and dismissal while restoring', async () => {
    const pending = deferred<RestoredChatBackup>();
    vi.mocked(hubApi.restoreChatBackup).mockReturnValue(pending.promise);
    const onClose = vi.fn();
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={createBackupSync()} onClose={onClose} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复到机器' }));
    await waitFor(() => expect(screen.getByRole('option', { name: '旧项目 · /old/project' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('项目文件夹'), { target: { value: '/old/project' } });
    fireEvent.click(screen.getByRole('button', { name: '恢复为新对话' }));
    await waitFor(() => expect(hubApi.restoreChatBackup).toHaveBeenCalledOnce());
    expect((screen.getByRole('button', { name: '正在恢复…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('目标机器') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(restored); await pending.promise; });
  });

  it('deletes only the local copy and refreshes the archive list', async () => {
    const backupSync = createBackupSync();
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '删除本地副本' }));
    await waitFor(() => expect(deleteLocalChatBackup).toHaveBeenCalledWith('backup-1'));
    expect(backupSync.refresh).toHaveBeenCalledOnce();
    expect(screen.getByText(/远端对话保留/)).toBeTruthy();
    expect(hubApi.restoreChatBackup).not.toHaveBeenCalled();
  });

  it('shows incomplete archive warnings instead of claiming no backups exist', () => {
    const backupSync = createBackupSync({ status: { enabled: false, scope: 'grouped', settingsRevision: 0, sourceId: 'source-hub', snapshots: [], directory: '/local/backups', backups: [], warnings: ['Archive damaged; file preserved.'] } });
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('本地备份读取不完整');
    expect(screen.getByText('Archive damaged; file preserved.')).toBeTruthy();
    expect(screen.queryByText(/还没有本地备份/)).toBeNull();
    expect(screen.getByText(/暂无可读取的备份/)).toBeTruthy();
  });

  it('retries a failed sync instead of only refreshing the local inventory', async () => {
    const backupSync = createBackupSync({ error: '源机器暂时离线' });
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(backupSync.syncNow).toHaveBeenCalledOnce());
    expect(backupSync.refresh).not.toHaveBeenCalled();
  });

  it('lets the user choose a scope while synchronization stays disabled', async () => {
    const backupSync = createBackupSync();
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    expect((screen.getByRole('radio', { name: '仅分组内对话' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '全部对话' }));
    await waitFor(() => expect(backupSync.setScope).toHaveBeenCalledWith('all'));
    expect(backupSync.setEnabled).not.toHaveBeenCalled();
    expect(hubApi.restoreChatBackup).not.toHaveBeenCalled();
  });

  it('shows group membership, empty chats and observed state without labeling idle as completed', () => {
    const backupSync = createBackupSync();
    backupSync.status!.snapshots = [snapshot];
    backupSync.status!.backups = [];
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    expect(screen.getByText(/2 个分组 · 1 段已记录对话/)).toBeTruthy();
    fireEvent.click(screen.getByText('查看分组与成员状态'));
    expect(screen.getByText('空分组 · 已置顶 · 0 个成员')).toBeTruthy();
    expect(screen.getByText('迁移工作 · 1 个成员')).toBeTruthy();
    expect(screen.getByText(/已归档 · 未读 · 记录时空闲 · 尚无聊天内容/)).toBeTruthy();
    expect(screen.queryByText(/已完成/)).toBeNull();
    expect(screen.getByText('已记录分组和状态，尚无可恢复的聊天内容。')).toBeTruthy();
  });

  it('imports group metadata without enabling sync or creating remote conversations', async () => {
    vi.mocked(importLocalChatBackup).mockResolvedValue({ snapshot });
    const backupSync = createBackupSync();
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择备份文件'), { target: { files: [jsonFile(snapshot)] } });
    await waitFor(() => expect(importLocalChatBackup).toHaveBeenCalledWith(snapshot));
    expect(screen.getByText('分组信息已导入，可恢复分组结构，成员会随对话恢复归位。')).toBeTruthy();
    expect(backupSync.setEnabled).not.toHaveBeenCalled();
    expect(hubApi.restoreChatBackup).not.toHaveBeenCalled();
  });

  it('restores standalone group structure including empty groups without a native restore', async () => {
    const backupSync = createBackupSync();
    backupSync.status!.snapshots = [snapshot];
    const onGroupsRestored = vi.fn();
    render(<LocalChatBackupsDialog onGroupsRestored={onGroupsRestored} remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复分组信息' }));
    await waitFor(() => expect(restoreLocalChatBackupGroups).toHaveBeenCalledWith('imported-hub'));
    expect(onGroupsRestored).toHaveBeenCalledWith({ revision: 1, groups: [], imported: [] });
    expect(hubApi.restoreChatBackup).not.toHaveBeenCalled();
    expect(screen.getByText('分组结构已恢复，成员会随对话恢复归位。')).toBeTruthy();
  });

  it('accepts portable wrapper overhead above the native 64 MB cap within the 80 MB import cap', async () => {
    const portable = { format: 'cloudcli-local-chat-backup', version: 1, sourceRemoteId: 'source', bundle, groups: snapshot };
    const file = jsonFile(portable);
    Object.defineProperty(file, 'size', { value: 65 * 1024 * 1024 });
    render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择备份文件'), { target: { files: [file] } });
    await waitFor(() => expect(importLocalChatBackup).toHaveBeenCalledWith(portable));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains a created session across reopening and retries only its failed group mapping', async () => {
    vi.mocked(recordLocalChatBackupRestore).mockRejectedValueOnce(new Error('分组保存暂时失败'));
    const onRestored = vi.fn();
    const onGroupsRestored = vi.fn();
    const view = render(<LocalChatBackupsDialog onGroupsRestored={onGroupsRestored} remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复到机器' }));
    fireEvent.change(screen.getByLabelText('目标机器'), { target: { value: 'destination' } });
    await screen.findByRole('option', { name: '新项目 · /new/project' });
    fireEvent.change(screen.getByLabelText('项目文件夹'), { target: { value: '/new/project' } });
    fireEvent.click(screen.getByRole('button', { name: '恢复为新对话' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('分组保存暂时失败'));
    expect(within(screen.getByRole('region', { name: '待恢复分组归属' })).getByRole('button', { name: '打开已恢复对话' })).toBeTruthy();
    expect(sessionStorage.getItem('cloudcli-local-chat-restore-pending:backup-1:destination')).toContain('restored-session');
    expect(onRestored).not.toHaveBeenCalled();
    view.unmount();
    render(<LocalChatBackupsDialog onGroupsRestored={onGroupsRestored} remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole('button', { name: '重试恢复归属' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith('destination', restored));
    expect(hubApi.restoreChatBackup).toHaveBeenCalledOnce();
    expect(recordLocalChatBackupRestore).toHaveBeenCalledTimes(2);
    expect(recordLocalChatBackupRestore).toHaveBeenLastCalledWith({ backupId: backup.id, remoteId: 'destination', result: restored });
    expect(onGroupsRestored).toHaveBeenCalledOnce();
    expect(sessionStorage.length).toBe(0);
  });

  it('exports standalone group metadata without reading native conversation content', async () => {
    const createObjectURL = vi.fn(() => 'blob:group-download');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.mocked(exportLocalChatBackupSnapshot).mockResolvedValue(snapshot);
    const backupSync = createBackupSync(); backupSync.status!.snapshots = [snapshot];
    try {
      render(<LocalChatBackupsDialog onGroupsRestored={vi.fn()} remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: '导出分组信息' }));
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      expect(exportLocalChatBackupSnapshot).toHaveBeenCalledWith('imported-hub');
      expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('cloudcli-groups-imported-hub.json');
      expect(readLocalChatBackup).not.toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:group-download');
    } finally { vi.unstubAllGlobals(); }
  });
});
