import type { ChatMessage, ConversationTask, NormalizedMessage, SessionActivity } from '@/shared/types';
import { getSubagentStatus } from '@/shared/utils';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const time = (value: unknown): number | null => {
  const number = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(text(value));
  return Number.isFinite(number) ? number : null;
};
const terminal = (status: string) => ['completed', 'failed', 'stopped'].includes(status);
const statusOf = (value: unknown): ConversationTask['status'] => ['running', 'completed', 'failed', 'stopped'].includes(text(value)) ? value as ConversationTask['status'] : 'unknown';
const asText = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(part => text(object(part).text)).filter(Boolean).join('\n\n') || JSON.stringify(value, null, 2);
  if (typeof value === 'string') {
    if (value.trim().startsWith('[')) { try { return asText(JSON.parse(value)); } catch { /* Keep ordinary output text intact. */ } }
    return value;
  }
  return value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
};

/** Projects exact tool/task identities; inspecting work never starts, resumes, or stops a task. */
export function deriveConversationTasks(messages: ChatMessage[], records: NormalizedMessage[], activity: SessionActivity | null, sessionId?: string | null): ConversationTask[] {
  const tasks: ConversationTask[] = [];
  const byTool = new Map<string, ConversationTask>();
  const byTask = new Map<string, ConversationTask>();
  const toolExecutions = new Map<string, string>();
  for (const record of records) {
    if ((!sessionId || record.sessionId === sessionId) && record.kind === 'tool_use' && record.toolId && record.executionId) {
      toolExecutions.set(record.toolId, record.executionId);
    }
  }
  for (const message of messages) {
    const isAgent = Boolean(message.isSubagentContainer);
    if (!isAgent && message.toolName !== 'Workflow') continue;
    const key = getIntrinsicMessageKey(message);
    if (!key) continue;
    const toolId = message.toolId || message.toolCallId;
    const input = object(message.toolInput);
    const result = object(message.toolResult?.toolUseResult);
    const taskId = text(result.taskId) || text(result.task_id);
    const existing = (toolId && byTool.get(toolId)) || (taskId && byTask.get(taskId));
    if (existing) { if (toolId) byTool.set(toolId, existing); continue; }
    let status = isAgent ? statusOf(getSubagentStatus(message)) : statusOf(result.status);
    if (message.toolResult?.isError) status = 'failed';
    // An async launch is a receipt, not a completion or proof the task is still alive now.
    if (!isAgent && ['async_launched', 'remote_launched'].includes(text(result.status))) status = 'unknown';
    const executionId = message.executionId || (toolId && toolExecutions.get(toolId));
    if (status === 'running' && (!executionId || executionId !== activity?.executionId)) status = 'unknown';
    const item: ConversationTask = {
      id: `${isAgent ? 'agent' : 'workflow'}:${taskId || toolId || key}`, kind: isAgent ? 'agent' : 'workflow',
      title: isAgent ? message.subagent?.name || message.subagent?.type || 'Agent'
        : text(result.workflowName) || text(input.description) || text(result.name) || text(input.scriptPath || result.scriptPath).split('/').pop() || 'Workflow',
      description: isAgent ? message.subagent?.description || '' : text(input.scriptPath || result.scriptPath),
      sourceKey: key, message, toolId, taskId: taskId || undefined, status,
      startedAt: time(message.timestamp), endedAt: terminal(status) ? time(message.toolResult?.timestamp) : null,
      input, activity: [], progress: '', result: asText(message.toolResult?.content) || asText(result.summary), usage: result.usage,
    };
    tasks.push(item); if (toolId) byTool.set(toolId, item); if (taskId) byTask.set(taskId, item);
  }
  // Earlier pages and replayed updates can arrive after completion. Project them
  // in recorded order, while preserving source order when timestamps are absent.
  const updates = records.filter(record => record.kind === 'task_notification' || (record.kind === 'status' && record.workflow))
    .sort((left, right) => {
      const leftTime = time(left.timestamp); const rightTime = time(right.timestamp);
      return leftTime !== null && rightTime !== null ? leftTime - rightTime : 0;
    });
  const seenUpdates = new Set<string>();
  for (const record of updates) {
    if (sessionId && record.sessionId !== sessionId) continue;
    if (!(record.kind === 'task_notification' || (record.kind === 'status' && record.workflow))) continue;
    const item = (record.toolUseId && byTool.get(record.toolUseId)) || (record.taskId && byTask.get(record.taskId));
    if (!item) continue; // Never attach unidentifiable progress to whichever task happens to be selected.
    // Native snapshots can be large; deduplicate on event identity, never their payload.
    const updateKey = `${record.sessionId}:${record.id}:${record.kind}:${record.timestamp}:${record.status}:${record.seq ?? ''}`;
    if (seenUpdates.has(updateKey)) continue;
    seenUpdates.add(updateKey);
    item.activity.push(record);
    const status = statusOf(record.status);
    const at = time(record.timestamp);
    // Keep historical phase details from before completion, but do not let a
    // late running update replace a task's terminal snapshot after reconnect.
    const snapshotPrecedesCompletion = at !== null && item.endedAt !== null && at <= item.endedAt;
    if (record.workflowProgress !== undefined && (!terminal(item.status) || terminal(status) || snapshotPrecedesCompletion)) {
      item.workflowProgress = record.workflowProgress;
      item.workflowProgressTruncated = record.workflowProgressTruncated;
    }
    if (record.taskId) { item.taskId = record.taskId; byTask.set(record.taskId, item); }
    if (terminal(item.status) && !terminal(status)) continue;
    if (terminal(status)) {
      if (item.endedAt !== null && at !== null && at < item.endedAt) continue;
      item.status = status; item.endedAt = at;
      item.result = record.content || record.summary || record.text || item.result;
    } else {
      const currentExecution = Boolean(record.executionId && activity?.executionId === record.executionId);
      item.status = status === 'running' && activity && currentExecution ? 'running' : 'unknown';
    }
    item.progress = record.text || record.summary || item.progress;
    item.usage = record.usage ?? item.usage;
  }
  return tasks;
}
