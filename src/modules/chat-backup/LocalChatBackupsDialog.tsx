import { useEffect, useRef, useState } from 'react';
import { Download, HardDrive, RefreshCw, Upload, X } from 'lucide-react';

import type { useLocalChatBackupSync } from '@/modules/chat-backup/hooks/useLocalChatBackupSync';
import { deleteLocalChatBackup, hubApi, importLocalChatBackup, readLocalChatBackup } from '@/shared/api';
import type { HubProject, HubRemote, RestoredChatBackup } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const SELECT_CLASS = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50';

type LocalChatBackupsDialogProps = {
  remotes: HubRemote[];
  backupSync: ReturnType<typeof useLocalChatBackupSync>;
  onClose: () => void;
  onRestored: (remoteId: string, result: RestoredChatBackup) => void;
};

function savedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/** Used by remote-hub to manage local conversation backups and restore them on another machine. */
export function LocalChatBackupsDialog({ remotes, backupSync, onClose, onRestored }: LocalChatBackupsDialogProps) {
  const { status, error: syncError, syncing, progress, refresh, setEnabled, syncNow } = backupSync;
  const importInput = useRef<HTMLInputElement>(null);
  // Serializes user actions so repeated clicks cannot import or restore the same backup twice.
  const [operation, setOperation] = useState<string | null>(null);
  // Retains an actionable failure until the next user action succeeds or retries.
  const [error, setError] = useState<string | null>(null);
  // Confirms imports and exports that otherwise have no visible effect on the current dialog.
  const [notice, setNotice] = useState<string | null>(null);
  // Identifies the archive entry whose destination is currently being chosen.
  const [restoreId, setRestoreId] = useState<string | null>(null);
  // Binds the restore destination to one machine before its available projects are fetched.
  const [remoteId, setRemoteId] = useState(remotes[0]?.id ?? '');
  // Keeps the user's destination folder choice until the machine or archive entry changes.
  const [projectPath, setProjectPath] = useState('');
  // Tags folder results with their machine to prevent late responses from retargeting a restore.
  const [projectResult, setProjectResult] = useState<{ remoteId: string; projects: HubProject[]; loading: boolean; error: string | null }>({ remoteId: '', projects: [], loading: false, error: null });
  // A retry token reloads a failed destination folder request without losing the selected backup.
  const [projectRetry, setProjectRetry] = useState(0);

  const busy = operation !== null;
  const locked = busy || syncing;
  const backups = status?.backups ?? [];
  const restoreBackup = backups.find(backup => backup.id === restoreId);
  const availableProjects = projectResult.remoteId === remoteId ? projectResult.projects : [];
  const loadingProjects = projectResult.remoteId !== remoteId || projectResult.loading;
  const selectedRemote = remotes.find(remote => remote.id === remoteId);

  useEffect(() => {
    if (!restoreId || !remoteId) return;
    let cancelled = false;
    void hubApi.projects(remoteId).then((projects: HubProject[]) => {
      if (!cancelled) setProjectResult({ remoteId, projects, loading: false, error: null });
    }).catch((failure: unknown) => {
      if (!cancelled) setProjectResult({ remoteId, projects: [], loading: false, error: failure instanceof Error ? failure.message : '无法读取目标机器的项目文件夹' });
    });
    return () => { cancelled = true; };
  }, [restoreId, remoteId, projectRetry]);

  const resetProjects = (targetRemoteId: string) => {
    setProjectResult({ remoteId: targetRemoteId, projects: [], loading: true, error: null });
  };

  const run = async (name: string, action: () => Promise<void>) => {
    if (busy) return;
    setOperation(name);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败，请重试');
    } finally {
      setOperation(null);
    }
  };

  const importFile = (file: File) => run('import', async () => {
    // Check before reading into memory; the server also validates the archive size and content.
    if (file.size > MAX_IMPORT_BYTES) throw new Error('备份文件不能超过 64 MB');
    let bundle: unknown;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      throw new Error('无法读取备份，请选择有效的 JSON 备份文件');
    }
    await importLocalChatBackup(bundle);
    await refresh();
    setNotice('备份已导入，可选择目标机器恢复。');
  });

  const exportBackup = (id: string) => run('export', async () => {
    const bundle = await readLocalChatBackup(id);
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    try {
      anchor.href = url;
      anchor.download = `cloudcli-chat-${bundle.session.provider}-${id}.json`;
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(url);
    }
    setNotice('备份已导出，可在另一台运行 Hub 的电脑上导入。');
  });

  const restore = () => run('restore', async () => {
    if (!restoreBackup || !selectedRemote || !availableProjects.some(project => project.fullPath === projectPath)) {
      throw new Error('请选择目标机器及其项目文件夹');
    }
    const bundle = await readLocalChatBackup(restoreBackup.id);
    const result = await hubApi.restoreChatBackup(remoteId, { bundle, projectPath });
    onRestored(remoteId, result);
  });

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden" aria-labelledby="local-chat-backups-title" aria-describedby="local-chat-backups-description">
        <header className="flex items-start justify-between gap-4 border-b p-5">
          <div>
            <DialogTitle id="local-chat-backups-title" className="not-sr-only flex items-center gap-2 text-lg font-semibold"><HardDrive className="h-5 w-5" />本地对话备份</DialogTitle>
            <p id="local-chat-backups-description" className="mt-1 text-sm text-muted-foreground">将 Claude / Codex 对话保存到运行 Hub 的这台电脑，之后可在其他机器恢复。</p>
          </div>
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="关闭本地备份" disabled={busy} onClick={onClose}><X /></Button>
        </header>
        <div className="space-y-5 overflow-y-auto p-5">
          <section className="rounded-lg border p-4">
            <label className="flex cursor-pointer items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">自动同步到本地</span>
                <span className="mt-1 block text-xs text-muted-foreground">默认关闭。开启后，Hub 页面打开期间每分钟同步已连接机器；已归档的项目和对话不参与自动备份。</span>
              </span>
              <input type="checkbox" role="switch" aria-label="自动同步到本地" className="h-4 w-4 shrink-0 accent-primary" checked={status?.enabled ?? false} disabled={!status || busy} onChange={event => { void run('settings', () => setEnabled(event.target.checked)); }} />
            </label>
            {status && <p className="mt-3 break-all text-xs text-muted-foreground">保存位置：{status.directory}</p>}
            <p className="mt-2 text-xs text-muted-foreground">关闭同步会保留已有备份；更换这台电脑时，可导出并导入备份文件。</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" disabled={!status?.enabled || locked} onClick={() => { void run('sync', syncNow); }}><RefreshCw className={syncing ? 'animate-spin' : ''} />{syncing ? '正在同步' : '立即同步'}</Button>
              <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => importInput.current?.click()}><Upload />导入备份</Button>
              <input ref={importInput} type="file" accept="application/json,.json" aria-label="选择备份文件" className="sr-only" disabled={locked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
              {syncing && <span className="text-xs text-muted-foreground" role="status">{progress ? `已处理 ${progress.completed} / ${progress.total}` : '正在读取对话…'}</span>}
            </div>
          </section>

          {(error || syncError) && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error || syncError}{!error && <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { void run('sync', syncNow); }}>重试</Button>}</div>}
          {Boolean(status?.warnings?.length) && <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <p>本地备份读取不完整，已有文件已保留。</p>
            <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">查看读取问题</summary><ul className="mt-2 list-disc space-y-1 break-all pl-4">{status?.warnings?.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>
          </div>}
          {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}

          {restoreBackup && <section className="space-y-3 rounded-lg border border-primary/40 bg-muted/20 p-4" aria-label="恢复备份">
            <div>
              <h3 className="break-words text-sm font-semibold">恢复「{restoreBackup.title}」</h3>
              <p className="mt-1 text-xs text-muted-foreground">会创建独立对话，恢复聊天内容和上下文。项目文件与登录凭据不会迁移，请先在目标机器准备好项目。</p>
            </div>
            <label className="block space-y-1 text-sm"><span>目标机器</span><select className={SELECT_CLASS} value={remoteId} disabled={locked} onChange={event => { setRemoteId(event.target.value); setProjectPath(''); resetProjects(event.target.value); }}><option value="">请选择机器</option>{remotes.map(remote => <option key={remote.id} value={remote.id}>{remote.name}</option>)}</select></label>
            <label className="block space-y-1 text-sm"><span>项目文件夹</span><select className={SELECT_CLASS} value={projectPath} disabled={locked || !remoteId || loadingProjects || Boolean(projectResult.error)} onChange={event => setProjectPath(event.target.value)}><option value="">{remoteId && loadingProjects ? '正在读取项目…' : '请选择项目文件夹'}</option>{availableProjects.map(project => <option key={project.projectId} value={project.fullPath}>{project.displayName} · {project.fullPath}</option>)}</select></label>
            {projectResult.remoteId === remoteId && projectResult.error && <div role="alert" className="text-sm text-destructive">{projectResult.error}<Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { resetProjects(remoteId); setProjectRetry(value => value + 1); }}>重新读取项目</Button></div>}
            {remoteId && !loadingProjects && !projectResult.error && availableProjects.length === 0 && <p className="text-xs text-muted-foreground">这台机器尚无项目，请先添加目标项目文件夹。</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => setRestoreId(null)}>取消恢复</Button>
              <Button type="button" size="sm" disabled={locked || !selectedRemote || loadingProjects || !availableProjects.some(project => project.fullPath === projectPath)} onClick={() => { void restore(); }}>{operation === 'restore' ? '正在恢复…' : '恢复为新对话'}</Button>
            </div>
          </section>}

          <section aria-label="已有备份" className="space-y-3">
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">已有备份{status ? ` (${backups.length})` : ''}</h3><Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { void run('refresh', refresh); }}>刷新列表</Button></div>
            {!status && !syncError && <p className="py-5 text-center text-sm text-muted-foreground">正在读取本地备份…</p>}
            {status && backups.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{status.warnings?.length ? '暂无可读取的备份，请检查上方提示后刷新列表。' : '还没有本地备份。开启自动同步，或导入以前导出的备份文件。'}</p>}
            {backups.map(backup => <article key={backup.id} className="space-y-2 rounded-lg border p-3">
              <div className="min-w-0"><h4 className="break-words text-sm font-medium">{backup.title}</h4><p className="mt-1 break-all text-xs text-muted-foreground">{backup.remoteName} · {backup.provider === 'claude' ? 'Claude' : 'Codex'} · {backup.projectPath}</p></div>
              <p className="text-xs text-muted-foreground">保存于 {savedTime(backup.savedAt)} · {fileSize(backup.bytes)}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" disabled={locked || remotes.length === 0} onClick={() => { setRestoreId(backup.id); setProjectPath(''); resetProjects(remoteId); setProjectRetry(value => value + 1); setError(null); setNotice(null); }}>恢复到机器</Button>
                <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { void exportBackup(backup.id); }}><Download />导出</Button>
                <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { void run('delete', async () => { await deleteLocalChatBackup(backup.id); if (restoreId === backup.id) setRestoreId(null); await refresh(); setNotice('本地副本已删除，远端对话保留。开启同步后仍可能再次备份。'); }); }}>删除本地副本</Button>
              </div>
            </article>)}
            {backups.length > 0 && remotes.length === 0 && <p className="text-xs text-muted-foreground">添加并连接目标机器后，即可恢复备份。</p>}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
