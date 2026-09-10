import { useEffect, useRef, useState } from 'react';
import { Download, HardDrive, RefreshCw, Upload, X } from 'lucide-react';

import type { useLocalChatBackupSync } from '@/modules/chat-backup/hooks/useLocalChatBackupSync';
import { deleteLocalChatBackup, exportLocalChatBackup, exportLocalChatBackupSnapshot, hubApi, importLocalChatBackup, readLocalChatBackup, recordLocalChatBackupRestore, restoreLocalChatBackupGroups } from '@/shared/api';
import type { ChatBackupObservation, HubGroupState, HubProject, HubRemote, RestoredChatBackup } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

const MAX_IMPORT_BYTES = 80 * 1024 * 1024;
const SELECT_CLASS = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50';
const PENDING_RESTORE_PREFIX = 'cloudcli-local-chat-restore-pending:';

type LocalChatBackupsDialogProps = {
  remotes: HubRemote[];
  backupSync: ReturnType<typeof useLocalChatBackupSync>;
  onClose: () => void;
  onRestored: (remoteId: string, result: RestoredChatBackup) => void;
  onGroupsRestored: (groups: HubGroupState) => void;
};

type PendingRestore = { backupId: string; remoteId: string; result: RestoredChatBackup };

function pendingRestoreKey(pending: Pick<PendingRestore, 'backupId' | 'remoteId'>) {
  return `${PENDING_RESTORE_PREFIX}${encodeURIComponent(pending.backupId)}:${encodeURIComponent(pending.remoteId)}`;
}

function readPendingRestore(): PendingRestore | null {
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(PENDING_RESTORE_PREFIX)) continue;
      const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      if (typeof value?.backupId === 'string' && typeof value?.remoteId === 'string'
        && typeof value?.result?.sessionId === 'string' && ['claude', 'codex'].includes(value.result.provider)
        && typeof value.result.projectPath === 'string' && typeof value.result.sessionName === 'string'
        && key === pendingRestoreKey(value)) return value;
    }
  } catch { /* The current dialog still retains a new restore if tab storage is unavailable. */ }
  return null;
}

function observationState(row: ChatBackupObservation): string {
  return [row.isArchived ? '已归档' : null, row.attention === true ? '未读' : row.attention === false ? '已读' : null,
    row.runtimeStatus === 'running' ? '记录时运行中' : '记录时空闲',
    row.history === 'empty' ? '尚无聊天内容' : row.history === 'unsupported' ? '仅保存信息' : row.history === 'unavailable' ? '聊天内容暂不可读取' : '有聊天内容'].filter(Boolean).join(' · ');
}

function savedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/** Used by remote-hub to manage local conversation backups and restore them on another machine. */
export function LocalChatBackupsDialog({ remotes, backupSync, onClose, onRestored, onGroupsRestored }: LocalChatBackupsDialogProps) {
  const { status, error: syncError, syncing, progress, refresh, setEnabled, setScope, syncNow } = backupSync;
  const importInput = useRef<HTMLInputElement>(null);
  const operationActive = useRef(false);
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
  // Keep an already-created remote session available while its group mapping is retried, including after reopening this dialog.
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(readPendingRestore);
  // Bound the rendered observation list while letting the user inspect additional recorded states.
  const [visibleObservations, setVisibleObservations] = useState<Record<string, number>>({});

  const busy = operation !== null;
  const locked = busy || syncing;
  const restoreLocked = locked || pendingRestore !== null;
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
    if (operationActive.current) return;
    operationActive.current = true;
    setOperation(name);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败，请重试');
    } finally {
      operationActive.current = false;
      setOperation(null);
    }
  };

  const importFile = (file: File) => run('import', async () => {
    // Check before reading into memory; the server also validates the archive size and content.
    if (file.size > MAX_IMPORT_BYTES) throw new Error('备份文件不能超过 80 MB（单段聊天内容最多 64 MB）');
    let bundle: unknown;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      throw new Error('无法读取备份，请选择有效的 JSON 备份文件');
    }
    const imported = await importLocalChatBackup(bundle);
    await refresh();
    setNotice(imported.backup ? '备份已导入，可选择目标机器恢复。' : '分组信息已导入，可恢复分组结构，成员会随对话恢复归位。');
  });

  const download = (value: unknown, filename: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    try {
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(url);
    }
  };

  const exportBackup = (id: string) => run('export', async () => {
    const portable = await exportLocalChatBackup(id);
    download(portable, `cloudcli-chat-${portable.bundle.session.provider}-${id}.json`);
    setNotice('备份已导出，可在另一台运行 Hub 的电脑上导入。');
  });

  const finishRestore = async (pending: PendingRestore) => {
    const restoredGroups = await recordLocalChatBackupRestore(pending);
    onGroupsRestored(restoredGroups);
    try { sessionStorage.removeItem(pendingRestoreKey(pending)); } catch { /* The successful mapping is idempotent if retried later. */ }
    setPendingRestore(null);
    onRestored(pending.remoteId, pending.result);
  };

  const restore = () => run('restore', async () => {
    if (!restoreBackup || !selectedRemote || !availableProjects.some(project => project.fullPath === projectPath)) {
      throw new Error('请选择目标机器及其项目文件夹');
    }
    const bundle = await readLocalChatBackup(restoreBackup.id);
    const result = await hubApi.restoreChatBackup(remoteId, { bundle, projectPath });
    const pending = { backupId: restoreBackup.id, remoteId, result };
    setPendingRestore(pending);
    // Tab storage is origin-scoped; the key additionally binds this result to
    // its archive and destination so a retry cannot restore into another target.
    try { sessionStorage.setItem(pendingRestoreKey(pending), JSON.stringify(pending)); } catch { /* Retain the result in this dialog even if browser storage fails. */ }
    await finishRestore(pending);
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
                <span className="mt-1 block text-xs text-muted-foreground">默认关闭。开启后，Hub 页面打开期间会跟踪分组、成员、内容和状态的变化，并每分钟复核一次。</span>
              </span>
              <input type="checkbox" role="switch" aria-label="自动同步到本地" className="h-4 w-4 shrink-0 accent-primary" checked={status?.enabled ?? false} disabled={!status || busy} onChange={event => { void run('settings', () => setEnabled(event.target.checked)); }} />
            </label>
            <fieldset className="mt-4 space-y-2" disabled={!status || busy}>
              <legend className="text-sm font-medium">备份范围</legend>
              <div className="flex flex-wrap gap-4 text-sm">{([['grouped', '仅分组内对话'], ['all', '全部对话']] as const).map(([value, label]) => <label key={value} className="flex items-center gap-2">
                <input type="radio" name="local-chat-backup-scope" value={value} checked={(status?.scope ?? 'grouped') === value} onChange={() => { void run('settings', () => setScope(value)); }} />{label}
              </label>)}</div>
              <p className="text-xs text-muted-foreground">仅分组会保存所有分组及其成员；全部对话也包含未分组和已归档的对话。两种范围都会保留分组信息。</p>
            </fieldset>
            {status && <p className="mt-3 break-all text-xs text-muted-foreground">保存位置：{status.directory}</p>}
            <p className="mt-2 text-xs text-muted-foreground">关闭同步或缩小范围会保留已有备份；更换这台电脑时，可导出并导入备份文件。</p>
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

          {pendingRestore && <section aria-label="待恢复分组归属" className="space-y-2 rounded-lg border border-amber-500/40 p-4">
            <h3 className="text-sm font-semibold">对话已恢复，分组归属待保存</h3>
            <p className="break-words text-xs text-muted-foreground">「{pendingRestore.result.sessionName}」已在 {remotes.find(remote => remote.id === pendingRestore.remoteId)?.name ?? pendingRestore.remoteId} 创建。重试只会补充分组归属，不会再创建对话。</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={locked} onClick={() => { void run('restore-membership', () => finishRestore(pendingRestore)); }}>重试恢复归属</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onRestored(pendingRestore.remoteId, pendingRestore.result)}>打开已恢复对话</Button>
            </div>
          </section>}

          {Boolean(status?.snapshots.length) && <section aria-label="分组与状态备份" className="space-y-3">
            <h3 className="text-sm font-semibold">分组与状态备份</h3>
            <p className="text-xs text-muted-foreground">恢复分组信息会重建结构和已恢复对话的归属；其余成员会在逐段恢复对话后自动归位。记录的运行状态仅供查看。</p>
            {status?.snapshots.map(snapshot => <article key={snapshot.sourceId} className="space-y-2 rounded-lg border p-3">
              <h4 className="text-sm font-medium">{snapshot.sourceId === status.sourceId ? '这台电脑的分组' : '导入的分组'} · {snapshot.groups.length} 个分组 · {snapshot.observations.length} 段已记录对话</h4>
              <p className="text-xs text-muted-foreground">记录于 {savedTime(snapshot.capturedAt)}</p>
              <details className="space-y-2 text-xs"><summary className="cursor-pointer text-muted-foreground">查看分组与成员状态</summary>
                <ul className="space-y-1">{snapshot.groups.map(group => <li key={group.id}>{group.name}{group.isPinned ? ' · 已置顶' : ''} · {group.members.length} 个成员</li>)}</ul>
                {snapshot.observations.slice(0, visibleObservations[snapshot.sourceId] ?? 50).map(row => <p key={`${row.remoteId}:${row.sessionId}`} className="break-words border-t pt-2"><span className="font-medium">{row.title}</span> · {row.remoteName}<span className="mt-1 block text-muted-foreground">{observationState(row)}</span></p>)}
                {snapshot.observations.length > (visibleObservations[snapshot.sourceId] ?? 50) && <Button type="button" size="sm" variant="ghost" onClick={() => setVisibleObservations(current => ({ ...current, [snapshot.sourceId]: (current[snapshot.sourceId] ?? 50) + 50 }))}>显示更多记录</Button>}
              </details>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { void run('restore-groups', async () => { onGroupsRestored(await restoreLocalChatBackupGroups(snapshot.sourceId)); await refresh(); setNotice('分组结构已恢复，成员会随对话恢复归位。'); }); }}>恢复分组信息</Button>
                <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { void run('export-groups', async () => { download(await exportLocalChatBackupSnapshot(snapshot.sourceId), `cloudcli-groups-${snapshot.sourceId}.json`); setNotice('分组信息已导出，可在其他 Hub 导入。'); }); }}><Download />导出分组信息</Button>
              </div>
            </article>)}
          </section>}

          {restoreBackup && <section className="space-y-3 rounded-lg border border-primary/40 bg-muted/20 p-4" aria-label="恢复备份">
            <div>
              <h3 className="break-words text-sm font-semibold">恢复「{restoreBackup.title}」</h3>
              <p className="mt-1 text-xs text-muted-foreground">会创建独立对话，恢复聊天内容、上下文及已导入的分组归属。项目文件与登录凭据不会迁移，请先在目标机器准备好项目。</p>
            </div>
            <label className="block space-y-1 text-sm"><span>目标机器</span><select className={SELECT_CLASS} value={remoteId} disabled={restoreLocked} onChange={event => { setRemoteId(event.target.value); setProjectPath(''); resetProjects(event.target.value); }}><option value="">请选择机器</option>{remotes.map(remote => <option key={remote.id} value={remote.id}>{remote.name}</option>)}</select></label>
            <label className="block space-y-1 text-sm"><span>项目文件夹</span><select className={SELECT_CLASS} value={projectPath} disabled={restoreLocked || !remoteId || loadingProjects || Boolean(projectResult.error)} onChange={event => setProjectPath(event.target.value)}><option value="">{remoteId && loadingProjects ? '正在读取项目…' : '请选择项目文件夹'}</option>{availableProjects.map(project => <option key={project.projectId} value={project.fullPath}>{project.displayName} · {project.fullPath}</option>)}</select></label>
            {projectResult.remoteId === remoteId && projectResult.error && <div role="alert" className="text-sm text-destructive">{projectResult.error}<Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { resetProjects(remoteId); setProjectRetry(value => value + 1); }}>重新读取项目</Button></div>}
            {remoteId && !loadingProjects && !projectResult.error && availableProjects.length === 0 && <p className="text-xs text-muted-foreground">这台机器尚无项目，请先添加目标项目文件夹。</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => setRestoreId(null)}>取消恢复</Button>
              <Button type="button" size="sm" disabled={restoreLocked || !selectedRemote || loadingProjects || !availableProjects.some(project => project.fullPath === projectPath)} onClick={() => { void restore(); }}>{operation === 'restore' ? '正在恢复…' : '恢复为新对话'}</Button>
            </div>
          </section>}

          <section aria-label="已有备份" className="space-y-3">
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">已有备份{status ? ` (${backups.length})` : ''}</h3><Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { void run('refresh', refresh); }}>刷新列表</Button></div>
            {!status && !syncError && <p className="py-5 text-center text-sm text-muted-foreground">正在读取本地备份…</p>}
            {status && backups.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{status.warnings?.length ? '暂无可读取的备份，请检查上方提示后刷新列表。' : status.snapshots.some(snapshot => snapshot.observations.length > 0) ? '已记录分组和状态，尚无可恢复的聊天内容。' : '还没有本地备份。开启自动同步，或导入以前导出的备份文件。'}</p>}
            {backups.map(backup => <article key={backup.id} className="space-y-2 rounded-lg border p-3">
              <div className="min-w-0"><h4 className="break-words text-sm font-medium">{backup.title}</h4><p className="mt-1 break-all text-xs text-muted-foreground">{backup.remoteName} · {backup.provider === 'claude' ? 'Claude' : 'Codex'} · {backup.projectPath}</p></div>
              <p className="text-xs text-muted-foreground">保存于 {savedTime(backup.savedAt)} · {fileSize(backup.bytes)}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" disabled={restoreLocked || remotes.length === 0} onClick={() => { setRestoreId(backup.id); setProjectPath(''); resetProjects(remoteId); setProjectRetry(value => value + 1); setError(null); setNotice(null); }}>恢复到机器</Button>
                <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { void exportBackup(backup.id); }}><Download />导出</Button>
                <Button type="button" size="sm" variant="ghost" disabled={locked || pendingRestore?.backupId === backup.id} onClick={() => { void run('delete', async () => { await deleteLocalChatBackup(backup.id); if (restoreId === backup.id) setRestoreId(null); await refresh(); setNotice('本地副本已删除，远端对话保留。开启同步后仍可能再次备份。'); }); }}>删除本地副本</Button>
              </div>
            </article>)}
            {backups.length > 0 && remotes.length === 0 && <p className="text-xs text-muted-foreground">添加并连接目标机器后，即可恢复备份。</p>}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
