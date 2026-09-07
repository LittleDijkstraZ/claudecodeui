import { useState } from 'react';

import { hubApi } from '@/shared/api';
import type { HubConversation } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';

export type HubConversationAction = { kind: 'fork' | 'delete' | 'rename'; member: HubConversation; groupId?: string };

/** Conversation mutations always target the selected row's machine, regardless of the open pane. */
export function HubConversationDialog({ action, machine, busySession, onDone, close }: {
  action: HubConversationAction; machine: string; busySession: boolean;
  onDone: (action: HubConversationAction, result: HubConversation | null) => Promise<void>; close: () => void;
}) {
  // Retains the rename draft without changing the live title until the server accepts it.
  const [name, setName] = useState(action.member.title);
  // Archiving is reversible; deleting the saved transcript requires an explicit choice.
  const [permanent, setPermanent] = useState(false);
  // Keeps the completed remote result on local metadata failure so retry never creates a second fork.
  const [completed, setCompleted] = useState<{ result: HubConversation | null } | null>(null);
  // Serializes mutation and group persistence and retains any actionable failure.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = action.kind === 'fork' ? 'Fork 对话' : action.kind === 'delete' ? '删除对话' : '重命名对话';
  const submit = async () => {
    if (busy || (busySession && action.kind !== 'rename' && !completed)) return;
    setBusy(true); setError('');
    try {
      let result = completed?.result ?? null;
      if (!completed) {
        const { remoteId, sessionId, provider } = action.member;
        if (action.kind === 'fork') {
          const fork = await hubApi.forkSession(remoteId, sessionId, provider);
          if (typeof fork.sessionId !== 'string' || !fork.sessionId) throw new Error('远端没有返回新对话，无法打开分支');
          result = { ...action.member, sessionId: fork.sessionId, title: fork.sessionName ?? `${action.member.title} (fork)`, lastActivity: new Date().toISOString(), isArchived: false };
        } else if (action.kind === 'rename') {
          await hubApi.renameSession(remoteId, sessionId, name.trim());
          result = { ...action.member, title: name.trim() };
        } else await hubApi.deleteSession(remoteId, sessionId, permanent);
        setCompleted({ result });
      }
      await onDone(action, result); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="max-w-md p-5" aria-describedby="hub-conversation-description"><form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <DialogTitle className="not-sr-only text-lg font-semibold">{title}</DialogTitle>
    <p id="hub-conversation-description" className="break-words text-sm text-muted-foreground">{machine} · {action.member.title}<br />{action.kind === 'fork' ? '复制当前已保存的对话上下文，继续讨论会使用独立会话；项目文件仍共享。' : action.kind === 'delete' ? permanent ? '永久删除此远端的会话记录和保存的对话文件，项目文件保留。' : '归档后从列表和分组移除，可以在该机器的归档列表恢复。项目文件保留。' : '新名称会同步到此机器和分组中的同一对话。'}</p>
    {action.kind === 'rename' && <Input aria-label="对话名称" value={name} onChange={event => setName(event.target.value)} required maxLength={500} disabled={busy || Boolean(completed)} autoFocus />}
    {action.kind === 'delete' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={permanent} onChange={event => setPermanent(event.target.checked)} disabled={busy || Boolean(completed)} />永久删除保存的对话记录</label>}
    {busySession && action.kind !== 'rename' && !completed && <p role="status" className="text-sm text-amber-600">此对话仍在运行，请等本轮结束后操作。</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}{completed && ' 远端操作已完成，重试只同步列表和分组。'}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={close}>取消</Button><Button type="submit" variant={action.kind === 'delete' ? 'destructive' : 'default'} disabled={busy || (!completed && busySession && action.kind !== 'rename') || (action.kind === 'rename' && !name.trim())}>{busy ? '处理中…' : completed ? '重试同步' : action.kind === 'delete' ? permanent ? '永久删除' : '归档对话' : action.kind === 'fork' ? '创建 Fork' : '保存'}</Button></div>
  </form></DialogContent></Dialog>;
}
