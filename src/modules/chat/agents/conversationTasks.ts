import type { ChatMessage, NormalizedMessage, SessionActivity } from '@/shared/types';
import { getSubagentStatus } from '@/shared/utils';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';

type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
export type ConversationTask = {
  id: string; kind: 'agent' | 'workflow'; title: string; description: string;
  sourceKey: string; message: ChatMessage; toolId?: string; taskId?: string;
  status: TaskStatus; startedAt: number | null; endedAt: number | null;
  progress: string; result: string; usage?: unknown;
};
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
const statusOf = (value: unknown): TaskStatus => ['running', 'completed', 'failed', 'stopped'].includes(text(value)) ? value as TaskStatus : 'unknown';
const asText = (value: unknown) => typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value, null, 2);

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
        : text(input.description) || text(result.name) || text(input.scriptPath).split('/').pop() || 'Workflow',
      description: isAgent ? message.subagent?.description || '' : text(input.scriptPath),
      sourceKey: key, message, toolId, taskId: taskId || undefined, status,
      startedAt: time(message.timestamp), endedAt: terminal(status) ? time(message.toolResult?.timestamp) : null,
      progress: '', result: asText(message.toolResult?.content), usage: result.usage,
    };
    tasks.push(item); if (toolId) byTool.set(toolId, item); if (taskId) byTask.set(taskId, item);
  }
  for (const record of records) {
    if (sessionId && record.sessionId !== sessionId) continue;
    if (!(record.kind === 'task_notification' || (record.kind === 'status' && record.workflow))) continue;
    const item = (record.toolUseId && byTool.get(record.toolUseId)) || (record.taskId && byTask.get(record.taskId));
    if (!item) continue; // Never attach unidentifiable progress to whichever task happens to be selected.
    if (record.taskId) { item.taskId = record.taskId; byTask.set(record.taskId, item); }
    const status = statusOf(record.status);
    if (terminal(item.status) && !terminal(status)) continue;
    const at = time(record.timestamp);
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
