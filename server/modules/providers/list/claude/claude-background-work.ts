import type { AnyRecord } from '@/shared/index.js';

const LEGACY_DEFERRED_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate']);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'stopped']);

/** Used by the Claude runtime and provider tests to retain Workflow runs through their final follow-up turn. */
export function createClaudeBackgroundWorkTracker() {
  const workflowCalls = new Set<string>();
  const workflowTasks = new Map<string, string | null>();
  const finishedCalls = new Set<string>();
  const finishedTasks = new Set<string>();
  let legacyWorkStarted = false;

  function settleCall(toolUseId: string) {
    workflowCalls.delete(toolUseId);
    finishedCalls.add(toolUseId);
    for (const [taskId, callId] of workflowTasks) {
      if (callId === toolUseId) {
        workflowTasks.delete(taskId);
        finishedTasks.add(taskId);
      }
    }
  }

  function observe(raw: unknown) {
    if (!raw || typeof raw !== 'object') return null;
    const message = raw as AnyRecord;
    const blocks: AnyRecord[] = Array.isArray(message.message?.content) ? message.message.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        if (block.name === 'Workflow' && typeof block.id === 'string' && !finishedCalls.has(block.id)) {
          workflowCalls.add(block.id);
        } else if (LEGACY_DEFERRED_TOOLS.has(block.name)
          || (block.name === 'Bash' && block.input?.run_in_background === true)) {
          legacyWorkStarted = true;
        }
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string'
        && workflowCalls.has(block.tool_use_id)) {
        const result = message.tool_use_result;
        if (block.is_error === true || (result && typeof result === 'object'
          && typeof result.error === 'string' && result.error.length > 0)) {
          // A rejected permission or invalid workflow script did not launch a task.
          settleCall(block.tool_use_id);
        } else if (result && typeof result === 'object'
          && (result.status === 'async_launched' || result.status === 'remote_launched')
          && typeof result.taskId === 'string' && result.taskId.length > 0) {
          // WorkflowOutput is SDK-owned structured data. It supplies the join
          // even when task_started/task_notification omit tool_use_id.
          if (finishedTasks.has(result.taskId)) settleCall(block.tool_use_id);
          else workflowTasks.set(result.taskId, block.tool_use_id);
        }
      }
    }

    if (message.type !== 'system' || typeof message.task_id !== 'string') return null;
    const taskId = message.task_id;
    const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : null;
    const knownCall = toolUseId !== null && workflowCalls.has(toolUseId);
    const knownTask = workflowTasks.has(taskId);
    const startsWorkflow = message.subtype === 'task_started' && message.task_type === 'local_workflow';
    if (!knownCall && !knownTask && !startsWorkflow) return null;

    if (message.subtype === 'task_notification' && TERMINAL_TASK_STATUSES.has(message.status)) {
      const callId = toolUseId || workflowTasks.get(taskId);
      if (callId) settleCall(callId);
      workflowTasks.delete(taskId);
      finishedTasks.add(taskId);
      return {
        status: message.status as 'completed' | 'failed' | 'stopped',
        taskId,
        toolUseId: callId || null,
        text: typeof message.summary === 'string' ? message.summary : `Workflow ${message.status}`,
        usage: message.usage,
      };
    }

    if (message.subtype !== 'task_started' && message.subtype !== 'task_progress') return null;
    // Replayed/delayed progress cannot resurrect a task after its notification.
    if (finishedTasks.has(taskId) || (toolUseId && finishedCalls.has(toolUseId))) return null;
    workflowTasks.set(taskId, toolUseId || workflowTasks.get(taskId) || null);
    if (toolUseId) workflowCalls.add(toolUseId);
    return {
      status: 'running' as const,
      taskId,
      toolUseId,
      text: typeof message.summary === 'string' ? message.summary
        : typeof message.description === 'string' ? message.description : 'Workflow running',
      usage: message.usage,
    };
  }

  function hasPendingWorkflow() {
    return workflowCalls.size > 0 || workflowTasks.size > 0;
  }

  function finishTurn(failed = false) {
    // An SDK terminal error (budget/turn limit, etc.) cannot keep a successful
    // background hold alive. Tool-result failures above only settle their call.
    const workflowPending = !failed && hasPendingWorkflow();
    const holdInput = !failed && (workflowPending || legacyWorkStarted);
    legacyWorkStarted = false;
    return { completeTurn: !workflowPending, holdInput };
  }

  return { observe, hasPendingWorkflow, finishTurn };
}
