import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeBackgroundWorkTracker } from '@/modules/providers/list/claude/claude-background-work.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { normalizeClaudeWorkflowProgress } from '@/shared/index.js';

const nativeSnapshot = [
  { type: 'workflow_phase', index: 0, title: 'Verify', kind: 'parallel' },
  {
    type: 'workflow_agent', index: 1, phaseIndex: 0, phaseTitle: 'Verify', label: 'Check routes',
    agentId: 'fixture-agent', model: 'fixture-model', state: 'done',
    promptPreview: 'Review the public routes.', resultPreview: 'Routes passed.', lastToolName: 'Read',
    tokens: 100, toolCalls: 2, durationMs: 1200, startedAt: 1000, lastProgressAt: 2200,
  },
];

test('native Workflow snapshots retain typed phase/agent details without mutable native objects', () => {
  const projected = normalizeClaudeWorkflowProgress(nativeSnapshot);
  assert.deepEqual(projected, { workflowProgress: nativeSnapshot, workflowProgressTruncated: false });
  assert.notEqual(projected.workflowProgress, nativeSnapshot);
  assert.notEqual(projected.workflowProgress?.[1], nativeSnapshot[1]);
  assert.deepEqual(normalizeClaudeWorkflowProgress(undefined), {});
  assert.deepEqual(normalizeClaudeWorkflowProgress({}), {});
  assert.deepEqual(normalizeClaudeWorkflowProgress([null, { type: 'future_progress', index: 1 }]), {});
  assert.deepEqual(normalizeClaudeWorkflowProgress([]), { workflowProgress: [], workflowProgressTruncated: false });
});

test('Workflow projection strips unknown fields and bounds malformed numeric/text data', () => {
  const payload = Array.from({ length: 1500 }, (_, index) => ({
    type: 'workflow_agent', index, state: 'progress', label: 'Agent',
    promptPreview: 'p'.repeat(20_000), resultPreview: 'r'.repeat(20_000),
    tokens: Infinity, durationMs: -1, toolCalls: '2', blocked: 'yes', arbitrary: { rawTranscript: 'not exposed' },
  }));
  const projected = normalizeClaudeWorkflowProgress(payload);
  assert.equal(projected.workflowProgressTruncated, true);
  assert.equal(projected.workflowProgress?.length, 1200);
  assert.ok(JSON.stringify(projected).length < 512_000);
  const first = projected.workflowProgress![0];
  assert.equal('arbitrary' in first, false);
  assert.equal('tokens' in first, false);
  assert.equal('durationMs' in first, false);
  assert.equal('toolCalls' in first, false);
  assert.equal('blocked' in first, false);
  assert.equal(first.type === 'workflow_agent' && first.resultPreview?.endsWith('…'), true);
});

test('live Workflow progress emits the snapshot and a throttled tick does not overwrite it', () => {
  const tracker = createClaudeBackgroundWorkTracker();
  tracker.observe({ type: 'system', subtype: 'task_started', task_id: 'task-one', tool_use_id: 'call-one', task_type: 'local_workflow' });
  const progress = tracker.observe({ type: 'system', subtype: 'task_progress', task_id: 'task-one', workflow_progress: nativeSnapshot });
  assert.deepEqual(progress?.workflowProgress, nativeSnapshot);
  const tick = tracker.observe({ type: 'system', subtype: 'task_progress', task_id: 'task-one', description: 'Still working' });
  assert.equal(Object.hasOwn(tick!, 'workflowProgress'), false);
  assert.equal(tracker.hasPendingWorkflow(), true);
  const completed = tracker.observe({ type: 'system', subtype: 'task_notification', task_id: 'task-one', status: 'completed', workflow_progress: nativeSnapshot });
  assert.deepEqual(completed?.workflowProgress, nativeSnapshot);
  assert.equal(tracker.hasPendingWorkflow(), false);
});

test('saved Workflow progress preserves native task identity without claiming current execution', () => {
  const provider = new ClaudeSessionsProvider();
  const raw = { type: 'system', subtype: 'task_progress', uuid: 'saved-progress', task_id: 'task-one',
    tool_use_id: 'call-one', timestamp: '2026-09-11T12:00:00Z', workflow_progress: nativeSnapshot };
  const [record] = provider.normalizeMessage(raw, 'app-session');
  assert.equal(record.kind, 'status');
  assert.equal(record.workflow, true);
  assert.equal(record.taskId, 'task-one');
  assert.equal(record.toolUseId, 'call-one');
  assert.equal(record.id, 'saved-progress');
  assert.equal(record.timestamp, raw.timestamp);
  assert.equal(record.sessionId, 'app-session');
  assert.equal(record.executionId, undefined);
  assert.deepEqual(record.workflowProgress, nativeSnapshot);
  assert.deepEqual(provider.normalizeMessage({ ...raw, workflow_progress: null }, 'app-session'), []);
});
