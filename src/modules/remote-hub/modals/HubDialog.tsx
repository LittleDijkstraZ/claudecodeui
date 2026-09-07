import { useMemo, useState } from 'react';

import { hubApi } from '@/shared/api';
import type { HubRemote, HubRemoteState, HubConversation, HubGroup, HubGroupState, HubDialogState } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';
import { memberKey } from '@/modules/remote-hub/utils/hubClient';
import { RemoteFolderChooser } from '@/modules/remote-hub/RemoteFolderChooser';

const SELECT_CLASS = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

type FolderMemory = { remoteId?: string; projectId?: string; paths: Record<string, string> };
function readFolderMemory(): FolderMemory {
  try {
    const saved = JSON.parse(localStorage.getItem('cloudcli-hub-last-folder') ?? '{}');
    const paths = saved?.paths && typeof saved.paths === 'object' && !Array.isArray(saved.paths)
      ? Object.fromEntries(Object.entries(saved.paths).filter(([key, value]) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(key) && typeof value === 'string' && value.length <= 4096)) as Record<string, string> : {};
    return { remoteId: typeof saved?.remoteId === 'string' ? saved.remoteId : undefined,
      projectId: typeof saved?.projectId === 'string' ? saved.projectId : undefined, paths };
  } catch { return { paths: {} }; }
}

/** Used by RemoteHubApp for group actions and remote-bound conversation creation. */
export function HubDialog({
  modal,
  groups,
  remotes,
  states,
  close,
  onAssign,
  onUpdate,
  onCreated
}: {
  modal: HubDialogState;
  groups: HubGroup[];
  remotes: HubRemote[];
  states: Record<string, HubRemoteState>;
  close: () => void;
  onAssign: (member: HubConversation, groupId: string | null) => Promise<void>;
  onUpdate: (change: (state: HubGroupState) => HubGroupState) => Promise<void>;
  onCreated: (member: HubConversation) => void;
}) {
  const remembered = useMemo(() => readFolderMemory(), []);
  // Holds the unsaved group name while its dialog is open.
  const [name, setName] = useState(modal.kind === 'group' ? modal.group?.name ?? '' : '');
  // Holds the target membership chosen for a new or existing conversation.
  const [groupId, setGroupId] = useState(modal.kind === 'assign' ? groups.find(g => g.members.some(m => memberKey(m) === memberKey(modal.member)))?.id ?? '' : modal.kind === 'new' ? modal.groupId ?? '' : '');
  // Tracks the machine chosen before selecting its project folder.
  const [remoteId, setRemoteId] = useState(modal.kind === 'new' ? modal.remoteId ?? (remotes.some(remote => remote.id === remembered.remoteId) ? remembered.remoteId : undefined) ?? remotes.find(remote => states[remote.id]?.status === 'online')?.id ?? remotes[0]?.id ?? '' : '');
  const projects = states[remoteId]?.projects ?? [];
  // Keep each machine's unsaved path independently; identical project IDs on another machine cannot retarget it.
  const [folderPaths, setFolderPaths] = useState<Record<string, string>>(() => {
    const paths = { ...remembered.paths };
    if (remembered.remoteId && !paths[remembered.remoteId]) {
      const legacyProject = states[remembered.remoteId]?.projects.find(project => project.projectId === remembered.projectId);
      if (legacyProject) paths[remembered.remoteId] = legacyProject.fullPath;
    }
    if (modal.kind === 'new' && modal.remoteId && modal.projectId) {
      const initialProject = states[modal.remoteId]?.projects.find(project => project.projectId === modal.projectId);
      if (initialProject) paths[modal.remoteId] = initialProject.fullPath;
    }
    return paths;
  });
  const folderPath = folderPaths[remoteId] ?? '';
  const remoteName = remotes.find(remote => remote.id === remoteId)?.name ?? '所选远端';
  // Selects the remote coding provider for the conversation draft.
  const [provider, setProvider] = useState('claude');
  // Prevents duplicate session or group creation while a request is in flight.
  const [busy, setBusy] = useState(false);
  // A visible failure is retained until the user retries or dismisses it.
  const [error, setError] = useState('');
  // Retains a successfully created draft so retrying group assignment cannot duplicate it.
  const [created, setCreated] = useState<HubConversation | null>(null);
  const title = modal.kind === 'group' ? modal.group ? '重命名分组' : '新建分组' : modal.kind === 'remove' ? '删除分组' : modal.kind === 'assign' ? '移到分组' : '新建对话';
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (modal.kind === 'group') {
        const id = modal.group?.id ?? crypto.randomUUID();
        await onUpdate(state => {
          const existing = state.groups.find(g => g.id === id);
          if (existing) existing.name = name.trim();else state.groups.push({
            id,
            name: name.trim(),
            isPinned: false,
            members: []
          });
          return state;
        });
      } else if (modal.kind === 'remove') await onUpdate(state => ({
        ...state,
        groups: state.groups.filter(g => g.id !== modal.group.id)
      }));else if (modal.kind === 'assign') await onAssign(modal.member, groupId || null);else {
        let member = created;
        if (!member) {
          if (!folderPath.trim() || states[remoteId]?.status !== 'online') throw new Error('请选择一台在线机器，并输入或浏览其文件夹');
          // Browsing is also the remote's existence, access and canonical-path validation.
          // Even a manually typed path is validated before project/session creation.
          const directory = await hubApi.browseDirectories(remoteId, folderPath.trim());
          const canonicalPath = directory.path;
          let project = projects.find(item => item.fullPath === canonicalPath);
          if (!project) {
            const latest = await hubApi.projects(remoteId);
            project = latest.find((item: { fullPath: string }) => item.fullPath === canonicalPath);
          }
          if (!project) {
            try {
              const registration = await hubApi.registerProject(remoteId, canonicalPath);
              project = registration.project;
            } catch (failure) {
              // Another window may register the same folder while this dialog is open.
              const latest = await hubApi.projects(remoteId).catch(() => []);
              project = latest.find((item: { fullPath: string }) => item.fullPath === canonicalPath);
              if (!project) throw failure;
            }
          }
          if (!project?.projectId || project.fullPath !== canonicalPath) throw new Error('远端未返回匹配的项目文件夹，请重试');
          const result = await hubApi.createSession(remoteId, { provider, projectPath: project.fullPath });
          member = {
            remoteId,
            sessionId: result.sessionId,
            title: result.sessionName ?? '新对话',
            projectId: project.projectId,
            projectPath: project.fullPath,
            provider
          };
          setCreated(member);
        }
        // If group persistence fails, retry assigns the already-created draft;
        // it must not allocate a second remote conversation.
        if (groupId) await onAssign(member, groupId);
        const latestMemory = readFolderMemory();
        localStorage.setItem('cloudcli-hub-last-folder', JSON.stringify({ remoteId: member.remoteId, paths: { ...latestMemory.paths, [member.remoteId]: member.projectPath } }));
        onCreated(member);
      }
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open onOpenChange={open => {
    if (!open && !busy) close();
  }}><DialogContent className="max-h-[90dvh] w-[calc(100%_-_1rem)] max-w-md overflow-y-auto p-5" aria-describedby="hub-dialog-description"><form onSubmit={event => {
        event.preventDefault();
        void submit();
      }} className="space-y-4"><DialogTitle className="not-sr-only text-lg font-semibold">{title}</DialogTitle><p id="hub-dialog-description" className="text-sm text-muted-foreground">{modal.kind === 'remove' ? `删除“${modal.group.name}”只移除分组，不会删除任何机器上的会话。` : modal.kind === 'new' ? '选择机器，再选择工作文件夹。Claude 将在该远端执行。' : '分组保存在本机，可以包含多台机器上的会话。'}</p>
    {modal.kind === 'group' && <label className="block text-sm">分组名称<Input aria-label="分组名称" value={name} onChange={e => setName(e.target.value)} required maxLength={80} autoFocus className="mt-1" disabled={busy} /></label>}
    {modal.kind === 'new' && <><label className="block text-sm">机器<select aria-label="机器" className={`${SELECT_CLASS} mt-1`} value={remoteId} disabled={busy || Boolean(created)} onChange={e => {
              setRemoteId(e.target.value);
              setError('');
            }} required><option value="" disabled>选择机器</option>{remotes.map(r => <option key={r.id} value={r.id} disabled={states[r.id]?.status !== 'online'}>{r.name}{states[r.id]?.status !== 'online' ? ' · 未连接' : ''}</option>)}</select></label><RemoteFolderChooser key={remoteId} remoteId={remoteId} remoteName={remoteName} projects={projects} path={folderPath} onChange={path => setFolderPaths(current => ({ ...current, [remoteId]: path }))} disabled={busy || Boolean(created)} online={states[remoteId]?.status === 'online'} /><label className="block text-sm">执行工具<select aria-label="执行工具" className={`${SELECT_CLASS} mt-1`} value={provider} disabled={busy || Boolean(created)} onChange={e => setProvider(e.target.value)}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="opencode">OpenCode</option></select></label></>}
    {(modal.kind === 'new' || modal.kind === 'assign') && <label className="block text-sm">分组<select aria-label="分组" className={`${SELECT_CLASS} mt-1`} value={groupId} onChange={e => setGroupId(e.target.value)} disabled={busy}><option value="">不分组</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>}
    {error && <p role="alert" className="text-sm text-destructive">{error}{created && ' 会话已经创建，重试只会保存分组归属。'}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={close}>取消</Button><Button type="submit" variant={modal.kind === 'remove' ? 'destructive' : 'default'} disabled={busy || modal.kind === 'group' && !name.trim() || modal.kind === 'new' && !created && (!folderPath.trim() || states[remoteId]?.status !== 'online')}>{busy ? '保存中…' : modal.kind === 'remove' ? '删除分组' : modal.kind === 'new' ? '创建对话' : '保存'}</Button></div>
  </form></DialogContent></Dialog>;
}

