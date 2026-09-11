import { useState } from 'react';
import { Activity, FileCode2, MessageSquareText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ConversationTask } from '@/shared/types';
import { MarkdownContent } from '@/modules/chat/tools/ContentRenderers/MarkdownContent';
import { WorkflowPhases } from '@/modules/chat/agents/WorkflowPhases';

const ACTIVITY_PAGE_SIZE = 30;

function recordedObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return recordedObject(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Used by chat's AgentsPanel to inspect the workflow data actually retained in this conversation. */
export function WorkflowDetails({ task }: { task: ConversationTask }) {
  const { t, i18n } = useTranslation('common');
  // Start with recent updates and expand older history on demand for long-running workflows.
  const [activityLimit, setActivityLimit] = useState(ACTIVITY_PAGE_SIZE);
  const visibleActivity = task.activity.slice(-activityLimit);
  const earlierActivityCount = task.activity.length - visibleActivity.length;
  const usage = recordedObject(task.usage);
  const result = recordedObject(task.message.toolResult?.toolUseResult);
  const prompt = typeof task.input.prompt === 'string' ? task.input.prompt : '';
  const scriptPath = typeof task.input.scriptPath === 'string' ? task.input.scriptPath
    : typeof result.scriptPath === 'string' ? result.scriptPath : '';
  const metrics = [
    { key: 'total_tokens', label: t('workspacePanel.totalTokens', { defaultValue: 'Tokens' }) },
    { key: 'tool_uses', label: t('workspacePanel.toolUses', { defaultValue: 'Tool calls' }) },
    { key: 'duration_ms', label: t('workspacePanel.reportedDuration', { defaultValue: 'Reported time' }) },
  ].flatMap(metric => {
    const value = usage[metric.key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? [{ ...metric, value: metric.key === 'duration_ms' ? `${(value / 1000).toLocaleString(i18n?.language, { maximumFractionDigits: 1 })}s` : value.toLocaleString(i18n?.language) }]
      : [];
  });

  return <div className="space-y-4" data-testid="workflow-details">
    {task.workflowProgress && task.workflowProgress.length > 0 && <WorkflowPhases progress={task.workflowProgress} truncated={task.workflowProgressTruncated} taskRunning={task.status === 'running'} />}
    {(scriptPath || prompt) && <section className="rounded-xl border border-border/70 bg-muted/20 p-3">
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><FileCode2 className="h-3.5 w-3.5 text-blue-500" />{t('workspacePanel.workflowInput', { defaultValue: 'Workflow input' })}</h4>
      {scriptPath && <p className="break-all font-mono text-[11px] leading-relaxed text-muted-foreground">{scriptPath}</p>}
      {prompt && <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed">{prompt}</p>}
    </section>}

    {metrics.length > 0 && <dl className="grid grid-cols-3 gap-2" aria-label={t('workspacePanel.reportedUsage', { defaultValue: 'Reported usage' })}>
      {metrics.map(metric => <div key={metric.key} className="min-w-0 rounded-lg border border-border/60 px-2.5 py-2">
        <dt className="truncate text-[10px] text-muted-foreground">{metric.label}</dt>
        <dd className="mt-1 break-words text-sm font-semibold tabular-nums">{metric.value}</dd>
      </div>)}
    </dl>}

    <section aria-label={t('workspacePanel.recordedActivity', { defaultValue: 'Recorded activity' })}>
      <h4 className="mb-3 flex items-center gap-1.5 text-xs font-semibold"><Activity className="h-3.5 w-3.5 text-blue-500" />{t('workspacePanel.recordedActivity', { defaultValue: 'Recorded activity' })}<span className="ml-auto text-[10px] font-normal tabular-nums text-muted-foreground">{task.activity.length}</span></h4>
      {earlierActivityCount > 0 && <button type="button" className="mb-3 min-h-8 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setActivityLimit(limit => limit + ACTIVITY_PAGE_SIZE)}>{t('workspacePanel.earlierWorkflowActivity', { count: Math.min(earlierActivityCount, ACTIVITY_PAGE_SIZE), defaultValue: 'Show {{count}} earlier updates' })}</button>}
      {task.activity.length > 0 ? <ol className="ml-1.5 space-y-3 border-l border-border pl-4">
        {visibleActivity.map((entry, index) => {
          const timestamp = Date.parse(entry.timestamp);
          const label = entry.summary || entry.text || entry.content;
          const status = ['running', 'completed', 'failed', 'stopped'].includes(entry.status || '') ? entry.status : 'unknown';
          return <li key={`${entry.id}-${index}`} className="relative">
            <span aria-hidden className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ring-4 ring-background ${status === 'failed' ? 'bg-red-500' : status === 'completed' ? 'bg-emerald-500' : 'bg-blue-400'}`} />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              <span>{t(`workspacePanel.${status}`, { defaultValue: status === 'unknown' ? 'Status unconfirmed' : status })}</span>
              {Number.isFinite(timestamp) && <time dateTime={entry.timestamp} title={new Date(timestamp).toLocaleString(i18n?.language)} className="tabular-nums">{new Date(timestamp).toLocaleTimeString(i18n?.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>}
            </div>
            {label && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed">{label}</p>}
          </li>;
        })}
      </ol> : <p className="rounded-lg bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">{t('workspacePanel.noWorkflowActivity', { defaultValue: 'No progress updates have been recorded for this workflow yet.' })}</p>}
    </section>

    {task.result && <section className="min-w-0 rounded-xl border border-border/70 bg-muted/20 p-3">
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" />{task.status === 'completed' ? t('workspacePanel.taskResult', { defaultValue: 'Result' }) : t('workspacePanel.recordedOutput', { defaultValue: 'Recorded output' })}</h4>
      <div className="min-w-0 overflow-x-auto text-xs"><MarkdownContent content={task.result} className="prose prose-sm max-w-none break-words dark:prose-invert" /></div>
    </section>}

    <details className="rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer py-1 font-medium text-foreground">{t('workspacePanel.launchDetails', { defaultValue: 'Launch details' })}</summary>
      <dl className="mt-2 space-y-2 text-[11px]">
        {task.taskId && <div><dt className="font-medium">{t('workspacePanel.taskId', { defaultValue: 'Task ID' })}</dt><dd className="mt-0.5 break-all font-mono">{task.taskId}</dd></div>}
        {typeof result.runId === 'string' && <div><dt className="font-medium">{t('workspacePanel.runId', { defaultValue: 'Run ID' })}</dt><dd className="mt-0.5 break-all font-mono">{result.runId}</dd></div>}
        {typeof result.transcriptDir === 'string' && <div><dt className="font-medium">{t('workspacePanel.transcriptDirectory', { defaultValue: 'Transcript directory' })}</dt><dd className="mt-0.5 break-all font-mono">{result.transcriptDir}</dd></div>}
      </dl>
      {Object.keys(task.input).length > 0 && <div className="mt-3"><h5 className="font-medium">{t('workspacePanel.launchParameters', { defaultValue: 'Launch parameters' })}</h5><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-[11px]">{JSON.stringify(task.input, null, 2)}</pre></div>}
      {task.usage !== undefined && <div className="mt-3"><h5 className="font-medium">{t('workspacePanel.reportedUsage', { defaultValue: 'Reported usage' })}</h5><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px]">{typeof task.usage === 'string' ? task.usage : JSON.stringify(task.usage, null, 2)}</pre></div>}
    </details>
  </div>;
}
