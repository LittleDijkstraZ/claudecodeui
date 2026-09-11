import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Bot, ChevronRight, Clock3, Workflow, Loader2, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MessageRevealTarget } from '@/shared/types';
import { Button } from '@/shared/ui';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { revealConversationChange } from '@/modules/chat/utils/revealConversationChange';
import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';
import { deriveConversationTasks } from '@/modules/chat/agents/conversationTasks';
import { WorkflowDetails } from '@/modules/chat/agents/WorkflowDetails';

/** Used by project-workspace to inspect recorded agents/workflows and stop a supported live task. */
export function AgentsPanel() {
  const { t } = useTranslation('common');
  const panel = useWorkspacePanels();
  const actions = useWorkspacePanelActions();
  const snapshot = panel?.agents;
  const tasks = useMemo(() => deriveConversationTasks(snapshot?.messages ?? [], snapshot?.records ?? [], snapshot?.activity ?? null, snapshot?.sessionId), [snapshot?.messages, snapshot?.records, snapshot?.activity, snapshot?.sessionId]);
  const task = tasks.find(item => item.sourceKey === panel?.agentReveal?.messageKey)
    ?? tasks.find(item => item.status === 'running') ?? tasks.at(-1);
  const visible = Boolean(panel?.open && panel.tab === 'agents');
  // A runtime count is independent of paginated history; it cannot identify
  // task cards whose originating tool calls have not been loaded.
  const reportedBackgroundTasks = snapshot?.activity?.backgroundTasks ?? 0;
  const hasUnloadedTaskDetails = tasks.length === 0 && reportedBackgroundTasks > 0;
  const detailRef = useRef<HTMLDivElement>(null);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  // Refresh elapsed time only while the visible panel contains confirmed running work.
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
  const runningCount = tasks.filter(item => item.status === 'running').length;
  const workflowCount = tasks.filter(item => item.kind === 'workflow').length;
  const canStopTask = Boolean(task?.taskId && task.status === 'running' && snapshot?.activity?.canStopTask && snapshot.stopTask);
  const statusLabel = (status: string) => t(`workspacePanel.${status}`, { defaultValue: status === 'unknown' ? 'Status unconfirmed' : status });

  return <div className="flex h-full min-h-0 flex-col bg-background" data-testid="workspace-agents">
    <div className="shrink-0 border-b border-border/70 bg-muted/10 px-4 py-3">
      {tasks.length > 0 && <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-medium">{t('workspacePanel.taskCount', { count: tasks.length, defaultValue: '{{count}} tasks' })}</span>
        {workflowCount > 0 && <span className="text-muted-foreground">{t('workspacePanel.workflowCount', { count: workflowCount, defaultValue: '{{count}} workflows' })}</span>}
        {runningCount > 0 && <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />{t('workspacePanel.tasksRunning', { count: runningCount, defaultValue: '{{count}} running' })}</span>}
      </div>}
      <p className="truncate text-[10px] text-muted-foreground">{window.__REMOTE_NAME__ || window.__REMOTE_ID__ || t('workspacePanel.currentRemote', { defaultValue: 'Current remote' })} · {snapshot?.project?.displayName || ''}</p>
      {snapshot?.hasEarlierMessages && !hasUnloadedTaskDetails && <Button variant="ghost" size="sm" className="mt-1 h-7 px-0 text-[11px]" disabled={snapshot.isLoadingEarlierMessages} onClick={snapshot.loadEarlierMessages}>{t('workspacePanel.loadEarlierAgents', { defaultValue: 'Load earlier conversation activity' })}</Button>}
    </div>
    {snapshot?.historyError && <p role="alert" className="shrink-0 px-3 py-2 text-xs text-red-600">{snapshot.historyError}</p>}
    {tasks.length > 0 && <nav className="max-h-[34%] shrink-0 space-y-1.5 overflow-y-auto border-b border-border/70 bg-muted/10 p-3" aria-label={t('workspacePanel.agentsAndWorkflows', { defaultValue: 'Agents and Workflows' })}>
      {tasks.map(item => <button key={item.id} type="button" aria-pressed={item.id === task?.id} onClick={() => actions?.openAgent(item.sourceKey)} className={`group flex min-h-16 w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${item.id === task?.id ? 'border-primary/30 bg-primary/5 shadow-sm' : 'border-transparent hover:border-border/60 hover:bg-muted/50'}`}>
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${item.kind === 'workflow' ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-violet-500/10 text-violet-600 dark:text-violet-400'}`}>
          {item.kind === 'workflow' ? <Workflow className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2"><span className="truncate font-semibold leading-5">{item.title}</span><ChevronRight className={`ml-auto h-3.5 w-3.5 shrink-0 ${item.id === task?.id ? 'text-foreground' : 'text-muted-foreground/50'}`} /></span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{item.kind === 'workflow' ? 'Workflow' : 'Agent'}</span><span aria-hidden>·</span><span className={item.status === 'failed' ? 'text-red-600 dark:text-red-400' : item.status === 'completed' ? 'text-emerald-700 dark:text-emerald-400' : ''}>{statusLabel(item.status)}</span>
            {item.status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-blue-500" />}
          </span>
          {(item.progress || item.description) && <span className="mt-1 block truncate text-[11px] leading-4 text-muted-foreground">{item.progress || item.description}</span>}
        </span>
      </button>)}
    </nav>}
    <div ref={detailRef} className="min-h-0 flex-1 overflow-y-auto p-4">
      {task ? <div data-message-key={task.sourceKey} tabIndex={-1}>
        <div className="mb-3 flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1"><h3 className="break-words text-base font-semibold leading-snug">{task.title}</h3>{task.kind === 'agent' && task.description && <p className="mt-1 break-words text-xs text-muted-foreground">{task.description}</p>}</div>
          <span className={`shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] ${task.status === 'failed' ? 'text-red-600' : 'text-muted-foreground'}`}>{statusLabel(task.status)}</span>
        </div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{duration}</span>
          <button type="button" onClick={() => snapshot?.revealOrigin(task.sourceKey)} className="inline-flex min-h-8 items-center gap-1 hover:text-foreground"><ArrowUpRight className="h-3 w-3" />{t('workspacePanel.agentOrigin', { defaultValue: 'Go to originating message' })}</button>
        </div>
        {canStopTask && <div className="mb-3 flex justify-end">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled={Boolean(snapshot?.stoppingTaskId)} onClick={() => task.taskId && snapshot?.stopTask?.(task.taskId)}>
            {snapshot?.stoppingTaskId === task.taskId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
            {snapshot?.stoppingTaskId === task.taskId ? t('workspacePanel.stoppingTask', { defaultValue: 'Stopping…' }) : t('workspacePanel.stopTask', { defaultValue: 'Stop this task' })}
          </Button>
        </div>}
        {snapshot?.taskStopError && <p role="alert" className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">{snapshot.taskStopError}</p>}
        {task.status === 'unknown' && <p className="mb-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{t('workspacePanel.taskStatusUnknown', { defaultValue: 'No current running confirmation or final result is recorded. Opening this panel does not resume or stop the task.' })}</p>}
        {task.kind === 'agent' && task.progress && <p className="mb-3 whitespace-pre-wrap break-words text-xs" aria-label="Task progress">{task.progress}</p>}
        {task.kind === 'agent' ? <SubagentPanel key={task.id} displayMode="panel" toolInput={task.message.toolInput} toolResult={task.message.toolResult} subagent={task.message.subagent} activity={task.message.subagentActivity} revealTarget={reveal} createDiff={createDiff} onFileOpen={snapshot?.onFileOpen} selectedProject={snapshot?.project} />
          : <WorkflowDetails key={task.id} task={task} />}
      </div> : hasUnloadedTaskDetails ? <div className="px-3 py-8 text-center text-sm" data-testid="unloaded-task-details">
        <Bot className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p role="status" className="font-medium">{t('workspacePanel.backgroundTasksReported', { count: reportedBackgroundTasks, defaultValue: 'The remote reports {{count}} background tasks.' })}</p>
        <p className="mt-2 text-muted-foreground">{snapshot?.hasEarlierMessages
          ? t('workspacePanel.taskDetailsNotLoaded', { defaultValue: 'Task details have not been loaded yet. Load earlier conversation activity to look for their originating messages.' })
          : t('workspacePanel.taskDetailsNotRecorded', { defaultValue: 'The available conversation records do not provide task details.' })}</p>
        {snapshot?.hasEarlierMessages && <>
          <Button size="sm" className="mt-4" disabled={snapshot.isLoadingEarlierMessages} onClick={snapshot.loadEarlierMessages}>
            {snapshot.isLoadingEarlierMessages
              ? t('workspacePanel.loadingEarlierAgents', { defaultValue: 'Loading earlier activity…' })
              : t('workspacePanel.loadEarlierAgents', { defaultValue: 'Load earlier conversation activity' })}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">{t('workspacePanel.loadEarlierAgentsReadOnly', { defaultValue: 'Loads one earlier page of saved records. It does not resume or stop tasks.' })}</p>
        </>}
      </div> : <div className="px-3 py-8 text-center text-sm text-muted-foreground"><Bot className="mx-auto mb-3 h-6 w-6 opacity-50" />{t('workspacePanel.noRecordedTasks', { defaultValue: 'Agents and Workflows from this conversation appear here with their recorded progress and results.' })}</div>}
    </div>
  </div>;
}
