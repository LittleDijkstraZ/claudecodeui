import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalChatBackupsDialog } from '@/modules/chat-backup/LocalChatBackupsDialog';
import type { useLocalChatBackupSync } from '@/modules/chat-backup/hooks/useLocalChatBackupSync';
import { deleteLocalChatBackup, hubApi, importLocalChatBackup, readLocalChatBackup } from '@/shared/api';
import type { ChatBackupBundle, HubProject, HubRemote, LocalChatBackupSummary, RestoredChatBackup } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  deleteLocalChatBackup: vi.fn(),
  importLocalChatBackup: vi.fn(),
  readLocalChatBackup: vi.fn(),
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

function createBackupSync(overrides: Partial<ReturnType<typeof useLocalChatBackupSync>> = {}): ReturnType<typeof useLocalChatBackupSync> {
  return {
    status: { enabled: false, directory: '/local/backups', backups: [backup] },
    error: null, syncing: false, progress: null,
    refresh: vi.fn(async () => {}), setEnabled: vi.fn(async () => {}), syncNow: vi.fn(async () => {}),
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
    vi.mocked(deleteLocalChatBackup).mockReset().mockResolvedValue(undefined);
    vi.mocked(importLocalChatBackup).mockReset().mockResolvedValue({ backup });
    vi.mocked(readLocalChatBackup).mockReset().mockResolvedValue(bundle);
    vi.mocked(hubApi.projects).mockReset().mockImplementation(async (remoteId: string) => remoteId === 'destination' ? destinationProjects : [{ projectId: 'old-project', fullPath: '/old/project', displayName: '旧项目' }]);
    vi.mocked(hubApi.restoreChatBackup).mockReset().mockResolvedValue(restored);
  });

  it('starts disabled and only changes the setting after an explicit toggle', async () => {
    const backupSync = createBackupSync();
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
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
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择备份文件'), { target: { files: [jsonFile(bundle)] } });
    await waitFor(() => expect(importLocalChatBackup).toHaveBeenCalledWith(bundle));
    expect(backupSync.refresh).toHaveBeenCalledOnce();
    expect(backupSync.setEnabled).not.toHaveBeenCalled();
    expect(screen.getByText('备份已导入，可选择目标机器恢复。')).toBeTruthy();
  });

  it('rejects oversized imports before reading their content', async () => {
    const file = jsonFile(bundle);
    Object.defineProperty(file, 'size', { value: 64 * 1024 * 1024 + 1 });
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('选择备份文件'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('64 MB'));
    expect(file.text).not.toHaveBeenCalled();
    expect(importLocalChatBackup).not.toHaveBeenCalled();
  });

  it('shows invalid JSON errors and lets the user import a corrected file', async () => {
    const file = new File(['bad JSON'], 'bad.json');
    Object.defineProperty(file, 'text', { value: async () => 'bad JSON' });
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
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
      render(<LocalChatBackupsDialog remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: '导出' }));
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      expect(readLocalChatBackup).toHaveBeenCalledWith('backup-1');
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
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复到机器' }));
    fireEvent.change(screen.getByLabelText('目标机器'), { target: { value: 'destination' } });
    await waitFor(() => expect(screen.getByRole('option', { name: '新项目 · /new/project' })).toBeTruthy());
    expect((screen.getByRole('button', { name: '恢复为新对话' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('项目文件夹'), { target: { value: '/new/project' } });
    fireEvent.click(screen.getByRole('button', { name: '恢复为新对话' }));
    await waitFor(() => expect(hubApi.restoreChatBackup).toHaveBeenCalledWith('destination', { bundle, projectPath: '/new/project' }));
    expect(onRestored).toHaveBeenCalledWith('destination', restored);
  });

  it('ignores folder responses from a previously selected machine', async () => {
    const oldRequest = deferred<HubProject[]>();
    vi.mocked(hubApi.projects).mockImplementation(async (remoteId: string) => remoteId === 'source' ? oldRequest.promise : destinationProjects);
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
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
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={createBackupSync()} onClose={vi.fn()} onRestored={vi.fn()} />);
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
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={createBackupSync()} onClose={onClose} onRestored={vi.fn()} />);
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
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '删除本地副本' }));
    await waitFor(() => expect(deleteLocalChatBackup).toHaveBeenCalledWith('backup-1'));
    expect(backupSync.refresh).toHaveBeenCalledOnce();
    expect(screen.getByText(/远端对话保留/)).toBeTruthy();
    expect(hubApi.restoreChatBackup).not.toHaveBeenCalled();
  });

  it('shows incomplete archive warnings instead of claiming no backups exist', () => {
    const backupSync = createBackupSync({ status: { enabled: false, directory: '/local/backups', backups: [], warnings: ['Archive damaged; file preserved.'] } });
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('本地备份读取不完整');
    expect(screen.getByText('Archive damaged; file preserved.')).toBeTruthy();
    expect(screen.queryByText(/还没有本地备份/)).toBeNull();
    expect(screen.getByText(/暂无可读取的备份/)).toBeTruthy();
  });

  it('retries a failed sync instead of only refreshing the local inventory', async () => {
    const backupSync = createBackupSync({ error: '源机器暂时离线' });
    render(<LocalChatBackupsDialog remotes={remotes} backupSync={backupSync} onClose={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(backupSync.syncNow).toHaveBeenCalledOnce());
    expect(backupSync.refresh).not.toHaveBeenCalled();
  });
});
