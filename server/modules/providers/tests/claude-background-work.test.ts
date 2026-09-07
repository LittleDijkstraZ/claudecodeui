import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeBackgroundWorkTracker } from '@/modules/providers/list/claude/claude-background-work.js';

const tool = (name: string, id = 'call-1', input = {}) => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] },
});
const task = (subtype: string, taskId = 'task-1', extra = {}) => ({
  type: 'system', subtype, task_id: taskId, ...extra,
});

test('Workflow launch and progress keep UI and stdin active until the final follow-up result', () => {
  const tracker = createClaudeBackgroundWorkTracker();
  tracker.observe(tool('Workflow'));
  tracker.observe(task('task_started', 'task-1', { task_type: 'local_workflow', tool_use_id: 'call-1' }));
  assert.deepEqual(tracker.finishTurn(), { completeTurn: false, holdInput: true });
  assert.equal(tracker.observe(task('task_progress', 'task-1', { summary: 'Verifying', usage: { tool_uses: 4 } }))?.text, 'Verifying');
  assert.deepEqual(tracker.finishTurn(), { completeTurn: false, holdInput: true });
  tracker.observe(task('task_notification', 'task-1', { status: 'completed' }));
  assert.equal(tracker.hasPendingWorkflow(), false);
  assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: false });
});

test('independent workflows must all finish and unrelated task notifications do not release them', () => {
  const tracker = createClaudeBackgroundWorkTracker();
  for (const id of ['one', 'two']) {
    tracker.observe(tool('Workflow', id));
    tracker.observe(task('task_started', id, { tool_use_id: id, task_type: 'local_workflow' }));
  }
  tracker.observe(task('task_notification', 'unrelated', { status: 'completed' }));
  tracker.observe(task('task_notification', 'one', { status: 'completed' }));
  assert.deepEqual(tracker.finishTurn(), { completeTurn: false, holdInput: true });
  tracker.observe(task('task_notification', 'two', { status: 'failed' }));
  assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: false });
});

test('denied or invalid Workflow tool results release a pending launch without waiting for a task', () => {
  const tracker = createClaudeBackgroundWorkTracker();
  tracker.observe(tool('Workflow'));
  tracker.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true }] } });
  assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: false });
});

test('notification can correlate by tool-use ID without a prior task_started event', () => {
  const tracker = createClaudeBackgroundWorkTracker();
  tracker.observe(tool('Workflow'));
  assert.deepEqual(tracker.finishTurn(), { completeTurn: false, holdInput: true });
  tracker.observe(task('task_notification', 'task-1', { tool_use_id: 'call-1', status: 'stopped' }));
  assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: false });
});

test('structured WorkflowOutput joins tasks whose lifecycle events omit tool_use_id', () => {
  const tracker = createClaudeBackgroundWorkTracker();
  tracker.observe(tool('Workflow'));
  tracker.observe(task('task_started', 'task-1', { task_type: 'local_workflow' }));
  tracker.observe({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] },
    tool_use_result: { status: 'async_launched', taskId: 'task-1', taskType: 'local_workflow' },
  });
  assert.deepEqual(tracker.finishTurn(), { completeTurn: false, holdInput: true });
  tracker.observe(task('task_notification', 'task-1', { status: 'completed' }));
  assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: false });
});

test('structured Workflow script error releases its launch even without is_error on the tool result', () => {
  const tracker = createClaudeBackgroundWorkTracker();
  tracker.observe(tool('Workflow'));
  tracker.observe({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] },
    tool_use_result: { error: 'Script syntax check failed' },
  });
  assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: false });
});

test('task_started before authoritative assistant and duplicate progress cannot revive a completed workflow', () => {
  const tracker = createClaudeBackgroundWorkTracker();
  tracker.observe(task('task_started', 'task-1', { task_type: 'local_workflow', tool_use_id: 'call-1' }));
  tracker.observe(task('task_notification', 'task-1', { status: 'completed' }));
  tracker.observe(tool('Workflow'));
  tracker.observe(task('task_progress', 'task-1', { tool_use_id: 'call-1' }));
  assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: false });
});

test('ordinary turns and foreground Bash close immediately; legacy background tools retain their old completion behavior', () => {
  for (const message of [tool('Read'), tool('Bash')]) {
    const tracker = createClaudeBackgroundWorkTracker();
    tracker.observe(message);
    assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: false });
  }
  for (const message of [tool('Monitor'), tool('ScheduleWakeup'), tool('CronCreate'), tool('TaskCreate'), tool('Bash', 'call-1', { run_in_background: true })]) {
    const tracker = createClaudeBackgroundWorkTracker();
    tracker.observe(message);
    assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: true });
    assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: false });
  }
});

test('Workflow plus legacy Monitor holds stdin after Workflow finishes but allows UI completion', () => {
  const tracker = createClaudeBackgroundWorkTracker();
  tracker.observe(tool('Workflow'));
  tracker.finishTurn();
  tracker.observe(tool('Monitor', 'monitor-1'));
  tracker.observe(task('task_notification', 'task-1', { tool_use_id: 'call-1', status: 'completed' }));
  assert.deepEqual(tracker.finishTurn(), { completeTurn: true, holdInput: true });
});

test('terminal SDK failure releases the input even when a workflow has not reported completion', () => {
  const tracker = createClaudeBackgroundWorkTracker();
  tracker.observe(tool('Workflow'));
  assert.deepEqual(tracker.finishTurn(true), { completeTurn: true, holdInput: false });
});
