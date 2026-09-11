import { Bot, Check, ChevronRight, CircleAlert, Layers3, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { WorkflowAgentProgress, WorkflowProgressEntry } from '@contracts/claude-workflow.js';

function WorkflowAgentDetail({ agent, taskRunning }: { agent: WorkflowAgentProgress; taskRunning: boolean }) {
  const { t } = useTranslation('common');
  // The snapshot's "progress" state describes when it was recorded, so only
  // show an active spinner while the parent task is also confirmed running.
  const active = taskRunning && (agent.state === 'start' || agent.state === 'progress');
  const status = agent.state === 'done' ? 'completed' : agent.state === 'error' ? 'failed' : active ? 'running' : 'unknown';
  return <details className="group rounded-lg border border-border/60 bg-background">
    <summary className="flex cursor-pointer list-none items-center gap-2 p-2.5 [&::-webkit-details-marker]:hidden">
      <Bot className="h-3.5 w-3.5 shrink-0 text-violet-500" />
      <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{agent.label}</span>{agent.lastToolName && <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{agent.lastToolName}{agent.lastToolSummary ? ` · ${agent.lastToolSummary}` : ''}</span>}</span>
      <span className={`inline-flex shrink-0 items-center gap-1 text-[10px] ${status === 'failed' ? 'text-red-600 dark:text-red-400' : status === 'completed' ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}`}>
        {active ? <Loader2 className="h-3 w-3 animate-spin" /> : status === 'completed' ? <Check className="h-3 w-3" /> : status === 'failed' ? <CircleAlert className="h-3 w-3" /> : null}
        {t(`workspacePanel.${status}`, { defaultValue: status === 'unknown' ? 'Status unconfirmed' : status })}
      </span>
      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
    </summary>
    <div className="space-y-3 border-t border-border/50 p-3 text-xs">
      {(agent.model || agent.agentType) && <p className="text-[11px] text-muted-foreground">{[agent.agentType, agent.model].filter(Boolean).join(' · ')}</p>}
      {(agent.tokens !== undefined || agent.toolCalls !== undefined || agent.durationMs !== undefined) && <dl className="flex flex-wrap gap-x-5 gap-y-2 text-[11px]">
        {agent.tokens !== undefined && <div><dt className="text-muted-foreground">{t('workspacePanel.totalTokens', { defaultValue: 'Tokens' })}</dt><dd className="mt-0.5 font-medium tabular-nums">{agent.tokens.toLocaleString()}</dd></div>}
        {agent.toolCalls !== undefined && <div><dt className="text-muted-foreground">{t('workspacePanel.toolUses', { defaultValue: 'Tool calls' })}</dt><dd className="mt-0.5 font-medium tabular-nums">{agent.toolCalls}</dd></div>}
        {agent.durationMs !== undefined && <div><dt className="text-muted-foreground">{t('workspacePanel.reportedDuration', { defaultValue: 'Reported time' })}</dt><dd className="mt-0.5 font-medium tabular-nums">{(agent.durationMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}s</dd></div>}
      </dl>}
      {agent.promptPreview && <div><h6 className="mb-1 font-medium">{t('workspacePanel.agentPromptPreview', { defaultValue: 'Prompt preview' })}</h6><p className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">{agent.promptPreview}</p></div>}
      {(agent.lastToolName || agent.lastToolSummary) && <div><h6 className="mb-1 font-medium">{t('workspacePanel.latestTool', { defaultValue: 'Latest tool' })}</h6><p className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">{[agent.lastToolName, agent.lastToolSummary].filter(Boolean).join('\n')}</p></div>}
      {agent.resultPreview && <div><h6 className="mb-1 font-medium">{t('workspacePanel.agentResultPreview', { defaultValue: 'Result preview' })}</h6><p className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">{agent.resultPreview}</p></div>}
      {agent.error && <p className="whitespace-pre-wrap break-words rounded-md bg-red-500/10 p-2 text-red-700 dark:text-red-400">{agent.error}</p>}
      {agent.attempt !== undefined && agent.attempt > 1 && <p className="text-[11px] text-muted-foreground">{t('workspacePanel.agentAttempt', { count: agent.attempt, defaultValue: 'Attempt {{count}}' })}{agent.lastAttemptReason ? ` · ${agent.lastAttemptReason}` : ''}</p>}
      {!agent.promptPreview && !agent.resultPreview && !agent.lastToolName && !agent.lastToolSummary && !agent.error && <p className="text-muted-foreground">{t('workspacePanel.noAgentPreview', { defaultValue: 'No prompt, tool, or result preview has been reported yet.' })}</p>}
    </div>
  </details>;
}

/** Used by chat's workflow inspector to drill into native phase and agent progress snapshots. */
export function WorkflowPhases({ progress, truncated, taskRunning }: { progress: WorkflowProgressEntry[]; truncated?: boolean; taskRunning: boolean }) {
  const { t } = useTranslation('common');
  const phases = progress.filter(entry => entry.type === 'workflow_phase');
  const agents = progress.filter(entry => entry.type === 'workflow_agent');
  const ungroupedAgents = agents.filter(agent => !phases.some(phase => phase.index === agent.phaseIndex));
  return <section aria-label={t('workspacePanel.workflowPhases', { defaultValue: 'Phases and agents' })}>
    <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><Layers3 className="h-3.5 w-3.5 text-blue-500" />{t('workspacePanel.workflowPhases', { defaultValue: 'Phases and agents' })}</h4>
    <div className="space-y-3">
      {phases.map(phase => {
        const phaseAgents = agents.filter(agent => agent.phaseIndex === phase.index);
        return <section key={phase.index} className="rounded-xl border border-border/60 bg-muted/20 p-2.5">
          <h5 className="mb-2 flex items-start gap-2 text-xs font-medium"><span className="flex h-5 min-w-5 items-center justify-center rounded bg-blue-500/10 px-1 text-[10px] tabular-nums text-blue-600 dark:text-blue-400">{phase.index + 1}</span><span className="min-w-0 flex-1 break-words leading-5">{phase.title}</span><span className="shrink-0 text-[10px] font-normal tabular-nums text-muted-foreground">{phaseAgents.filter(agent => agent.state === 'done').length}/{phaseAgents.length}</span></h5>
          <div className="space-y-1.5">{phaseAgents.map(agent => <WorkflowAgentDetail key={agent.index} agent={agent} taskRunning={taskRunning} />)}</div>
          {phaseAgents.length === 0 && <p className="text-[11px] text-muted-foreground">{t('workspacePanel.noPhaseAgents', { defaultValue: 'No agents recorded in this phase yet.' })}</p>}
        </section>;
      })}
      {ungroupedAgents.map(agent => <WorkflowAgentDetail key={agent.index} agent={agent} taskRunning={taskRunning} />)}
    </div>
    {truncated && <p className="mt-2 text-[11px] text-muted-foreground">{t('workspacePanel.workflowProgressTruncated', { defaultValue: 'Some workflow details were shortened for display.' })}</p>}
  </section>;
}
