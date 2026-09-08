import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Bot, Clock3, Workflow, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MessageRevealTarget } from '@/shared/types';
import { Button } from '@/shared/ui';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { revealConversationChange } from '@/modules/chat/utils/revealConversationChange';
import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';
import { deriveConversationTasks } from '@/modules/chat/agents/conversationTasks';

/** Shows recorded agents and workflows together without issuing task-resume or model requests. */
export function AgentsPanel() {
  const { t } = useTranslation('common');
  const panel = useWorkspacePanels();
  const actions = useWorkspacePanelActions();
  const snapshot = panel?.agents;
  const tasks = useMemo(() => deriveConversationTasks(snapshot?.messages ?? [], snapshot?.records ?? [], snapshot?.activity ?? null, snapshot?.sessionId), [snapshot?.messages, snapshot?.records, snapshot?.activity, snapshot?.sessionId]);
  const task = tasks.find(item => item.sourceKey === panel?.agentReveal?.messageKey)
    ?? tasks.find(item => item.status === 'running') ?? tasks.at(-1);
  const visible = Boolean(panel?.open && panel.tab === 'agents');
  const detailRef = useRef<HTMLDivElement>(null);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible || !tasks.some(item => item.status === 'running')) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, tasks]);
  const requestedReveal = panel?.agentReveal;
  const reveal: MessageRevealTarget | undefined = requestedReveal && requestedReveal.messageKey === task?.sourceKey ? requestedReveal : undefined;
  useEffect(() => {
    if (!visible || !reveal || !detailRef.current) return;
    return revealConversationChange(detailRef.current, reveal, () => {});
  }, [visible, reveal]);
  const elapsed = task?.startedAt !== null && task?.startedAt !== undefined && (task.status === 'running' || task.endedAt !== null)
    ? Math.max(0, Math.floor(((task.status === 'running' ? now : task.endedAt!) - task.startedAt) / 1000)) : null;
  const duration = elapsed === null ? t('workspacePanel.durationUnknown', { defaultValue: 'Duration not recorded' })
    : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const statusLabel = (status: string) => t(`workspacePanel.${status}`, { defaultValue: status === 'unknown' ? 'Status unconfirmed' : status });

  return <div className="flex h-full min-h-0 flex-col" data-testid="workspace-agents">
    <div className="shrink-0 border-b border-border px-3 py-2">
      <p className="truncate text-[10px] text-muted-foreground">{window.__REMOTE_NAME__ || window.__REMOTE_ID__ || t('workspacePanel.currentRemote', { defaultValue: 'Current remote' })} · {snapshot?.project?.displayName || ''}</p>
      {snapshot?.hasEarlierMessages && <Button variant="ghost" size="sm" className="mt-1 h-7 px-0 text-[11px]" disabled={snapshot.isLoadingEarlierMessages} onClick={snapshot.loadEarlierMessages}>{t('workspacePanel.loadEarlierAgents', { defaultValue: 'Load earlier conversation activity' })}</Button>}
    </div>
    {snapshot?.historyError && <p role="alert" className="shrink-0 px-3 py-2 text-xs text-red-600">{snapshot.historyError}</p>}
    {tasks.length > 0 && <div className="max-h-[32%] shrink-0 overflow-y-auto border-b border-border p-2" aria-label="Agents and Workflows">
      {tasks.map(item => <button key={item.id} type="button" aria-pressed={item.id === task?.id} onClick={() => actions?.openAgent(item.sourceKey)} className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs ${item.id === task?.id ? 'bg-accent' : 'hover:bg-accent/60'}`}>
        {item.kind === 'workflow' ? <Workflow className="h-4 w-4 shrink-0 text-blue-500" /> : <Bot className="h-4 w-4 shrink-0 text-violet-500" />}
        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{item.title}</span><span className="block truncate text-[10px] text-muted-foreground">{item.kind === 'workflow' ? 'Workflow' : 'Agent'} · {statusLabel(item.status)}</span></span>
        {item.status === 'running' && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />}
      </button>)}
    </div>}
    <div ref={detailRef} className="min-h-0 flex-1 overflow-y-auto p-3">
      {task ? <div data-message-key={task.sourceKey} tabIndex={-1}>
        <div className="mb-3 flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium">{task.title}</h3><p className="mt-1 break-words text-xs text-muted-foreground">{task.description}</p></div>
          <span className={`shrink-0 text-[10px] ${task.status === 'failed' ? 'text-red-600' : 'text-muted-foreground'}`}>{statusLabel(task.status)}</span>
        </div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{duration}</span>
          <button type="button" onClick={() => snapshot?.revealOrigin(task.sourceKey)} className="inline-flex min-h-8 items-center gap-1 hover:text-foreground"><ArrowUpRight className="h-3 w-3" />{t('workspacePanel.agentOrigin', { defaultValue: 'Go to originating message' })}</button>
        </div>
        {task.status === 'unknown' && <p className="mb-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{t('workspacePanel.taskStatusUnknown', { defaultValue: 'No current running confirmation or final result is recorded. Opening this panel does not resume or stop the task.' })}</p>}
        {task.progress && <p className="mb-3 whitespace-pre-wrap break-words text-xs" aria-label="Task progress">{task.progress}</p>}
        {task.kind === 'agent' ? <SubagentPanel key={task.id} displayMode="panel" toolInput={task.message.toolInput} toolResult={task.message.toolResult} subagent={task.message.subagent} activity={task.message.subagentActivity} revealTarget={reveal} createDiff={createDiff} onFileOpen={snapshot?.onFileOpen} selectedProject={snapshot?.project} />
          : <div className="space-y-3">
            <dl className="text-[11px] text-muted-foreground"><dt>Task ID</dt><dd className="break-all font-mono">{task.taskId || 'Not reported'}</dd></dl>
            {task.result && <div><h4 className="mb-1 text-xs font-medium">{task.status === 'completed' ? 'Result' : 'Recorded output'}</h4><pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-[11px]">{task.result}</pre></div>}
            {task.usage !== undefined && <details className="text-xs"><summary className="cursor-pointer">Reported progress and usage</summary><pre className="mt-2 whitespace-pre-wrap break-words text-[11px]">{typeof task.usage === 'string' ? task.usage : JSON.stringify(task.usage, null, 2)}</pre></details>}
          </div>}
      </div> : <div className="px-3 py-8 text-center text-sm text-muted-foreground"><Bot className="mx-auto mb-3 h-6 w-6 opacity-50" />{t('workspacePanel.noRecordedTasks', { defaultValue: 'Agents and Workflows from this conversation appear here with their recorded progress and results.' })}</div>}
    </div>
  </div>;
}
