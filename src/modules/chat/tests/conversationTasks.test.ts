import { describe, expect, test } from 'vitest';

import type { ChatMessage, NormalizedMessage, SessionActivity } from '@/shared/types';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { deriveConversationTasks } from '@/modules/chat/agents/conversationTasks';

const workflow = (toolId = 'tool-a'): ChatMessage => ({ type: 'assistant', isToolUse: true, toolName: 'Workflow', toolId, timestamp: '2026-01-01T00:00:00Z', toolInput: { scriptPath: '/project/run.js' }, toolResult: { content: 'Launched', toolUseResult: { status: 'async_launched', taskId: 'task-a' } } });
const activity: SessionActivity = { phase: 'background', executionId: 'run-a', startedAt: 0, statusText: null, canInterrupt: true, acceptsInput: true };
const progress = (patch: Partial<NormalizedMessage> = {}): NormalizedMessage => ({ id: 'progress', sessionId: 'session-a', provider: 'claude', timestamp: '2026-01-01T00:00:10Z', kind: 'status', workflow: true, taskId: 'task-a', toolUseId: 'tool-a', status: 'running', executionId: 'run-a', text: 'Checking builds', ...patch });

describe('task inspection by recorded identity', () => {
  test('does not mistake async launch for completion or confirmed current activity', () => {
    const task = deriveConversationTasks([workflow()], [], activity)[0];
    expect(task.status).toBe('unknown'); expect(task.result).toBe('Launched'); expect(task.taskId).toBe('task-a');
  });
  test('combines agents and workflows and joins progress by task/tool IDs', () => {
    const agent: ChatMessage = { type: 'assistant', timestamp: 0, toolId: 'agent-a', isSubagentContainer: true, subagent: { id: 'agent-a', name: 'Reader', status: 'completed' } };
    const tasks = deriveConversationTasks([agent, workflow()], [progress()], activity, 'session-a');
    expect(tasks.map(task => task.kind)).toEqual(['agent', 'workflow']);
    expect(tasks[1].status).toBe('running'); expect(tasks[1].progress).toBe('Checking builds');
  });
  test('does not revive terminal work from late progress or bind another session execution', () => {
    const done = progress({ kind: 'task_notification', status: 'completed', content: 'All done', timestamp: '2026-01-01T00:01:00Z' });
    expect(deriveConversationTasks([workflow()], [done, progress()], activity)[0]).toMatchObject({ status: 'completed', result: 'All done' });
    expect(deriveConversationTasks([workflow()], [progress({ sessionId: 'other' })], activity, 'session-a')[0].status).toBe('unknown');
    expect(deriveConversationTasks([workflow()], [progress({ executionId: 'old-run' })], activity)[0].status).toBe('unknown');
    expect(deriveConversationTasks([workflow()], [progress()], null)[0].status).toBe('unknown');
  });
  test('keeps final recorded task result after reconnect with no running process', () => {
    const notice = progress({ kind: 'task_notification', status: 'failed', content: 'Dependency unavailable' });
    expect(deriveConversationTasks([workflow()], [notice], null)[0]).toMatchObject({ status: 'failed', result: 'Dependency unavailable' });
  });
  test('new activity cannot revive an unfinished historical agent or unscoped workflow progress', () => {
    const agent: ChatMessage = { type: 'assistant', timestamp: 0, toolId: 'agent-old', isSubagentContainer: true };
    expect(deriveConversationTasks([agent], [], activity)[0].status).toBe('unknown');
    expect(deriveConversationTasks([workflow()], [progress({ executionId: undefined })], activity)[0].status).toBe('unknown');
    const launch = progress({ kind: 'tool_use', toolId: 'agent-old', executionId: 'old-run' });
    expect(deriveConversationTasks([agent], [launch], activity)[0].status).toBe('unknown');
    expect(deriveConversationTasks([agent], [{ ...launch, executionId: 'run-a' }], activity)[0].status).toBe('running');
  });
  test('deduplicates exact tool/task IDs without grouping similarly named runs', () => {
    const other = workflow('tool-b'); other.toolResult = { content: 'Launched', toolUseResult: { status: 'async_launched', taskId: 'task-b' } };
    expect(deriveConversationTasks([workflow(), workflow(), other], [], null)).toHaveLength(2);
  });
  test('retains chronological activity and the latest native phase snapshot across out-of-order replay', () => {
    const start = progress({ id: 'first', timestamp: '2026-01-01T00:00:01Z', text: 'Starting checks' });
    const phase = progress({ id: 'phase', timestamp: '2026-01-01T00:00:05Z', workflowProgress: [{ type: 'workflow_phase', index: 0, title: 'Verify' }, { type: 'workflow_agent', index: 0, phaseIndex: 0, label: 'Reviewer', state: 'done', resultPreview: 'Checks passed' }], workflowProgressTruncated: true });
    const done = progress({ id: 'done', kind: 'task_notification', status: 'completed', content: '**All checks passed**', timestamp: '2026-01-01T00:00:10Z' });
    const other = progress({ id: 'other', taskId: 'task-other', toolUseId: 'tool-other' });
    const [task] = deriveConversationTasks([workflow()], [done, start, phase, start, other], null);
    expect(task.activity.map(entry => entry.id)).toEqual(['first', 'phase', 'done']);
    expect(task.workflowProgress).toEqual(phase.workflowProgress);
    expect(task.workflowProgressTruncated).toBe(true);
    expect(task).toMatchObject({ status: 'completed', result: '**All checks passed**' });
  });
  test('uses native workflow name, script path, and text-block output from launch metadata', () => {
    const message = workflow();
    message.toolInput = { script: 'export async function run() {}' };
    message.toolResult = { content: JSON.stringify([{ type: 'text', text: '**Build ready**' }]), toolUseResult: { workflowName: 'Release checks', scriptPath: '/project/generated.js', status: 'completed' } };
    expect(deriveConversationTasks([message], [], null)[0]).toMatchObject({ title: 'Release checks', description: '/project/generated.js', result: '**Build ready**' });
  });
  test('late running snapshots cannot replace completed native agent details', () => {
    const completed = progress({ id: 'done', kind: 'task_notification', status: 'completed', timestamp: '2026-01-01T00:00:10Z', workflowProgress: [{ type: 'workflow_agent', index: 0, label: 'Reviewer', state: 'done', resultPreview: 'Verified' }] });
    const late = progress({ id: 'late', timestamp: '2026-01-01T00:00:20Z', workflowProgress: [{ type: 'workflow_agent', index: 0, label: 'Reviewer', state: 'start' }] });
    const [task] = deriveConversationTasks([workflow()], [completed, late], activity);
    expect(task.status).toBe('completed');
    expect(task.workflowProgress).toEqual(completed.workflowProgress);
  });
});


test('uses normalized JSON tool arguments and final receipt metadata in the actual chat projection', () => {
  const records: NormalizedMessage[] = [
    progress({ id: 'call', kind: 'tool_use', toolId: 'tool-a', toolName: 'Workflow', toolInput: { description: 'Verify experiment', scriptPath: '/project/run.js' } }),
    progress({ id: 'receipt', kind: 'tool_result', toolId: 'tool-a', content: 'Launched', toolUseResult: { status: 'async_launched', taskId: 'task-a' } }),
  ];
  const [task] = deriveConversationTasks(normalizedToChatMessages(records), records, activity);
  expect(task.title).toBe('Verify experiment'); expect(task.description).toBe('/project/run.js');
  expect(task.taskId).toBe('task-a');
});
