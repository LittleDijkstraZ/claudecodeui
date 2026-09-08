import assert from 'node:assert/strict';
import test from 'node:test';
import { readClaudeTaskNotification } from '@/modules/providers/list/claude/claude-task-notifications.js';

test('native historical task notice preserves exact task, tool, status and output', () => {
  const raw = { message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>workflow-1</task-id><tool-use-id>call-1</tool-use-id><status>completed</status><summary>Built</summary><result>Full result</result><usage>3 calls</usage>\n</task-notification>' }] }, isMeta: true };
  assert.deepEqual(readClaudeTaskNotification(raw), { taskId: 'workflow-1', toolUseId: 'call-1', status: 'completed', summary: 'Built', content: 'Full result', usage: '3 calls' });
  assert.equal(readClaudeTaskNotification({ ...raw, origin: { kind: 'human' } }), null);
});
test('unknown lifecycle stays unknown, and unidentifiable prose is not a task', () => {
  assert.equal(readClaudeTaskNotification({ message: { role: 'user', content: '<task-notification><summary>Hello</summary></task-notification>' } }), null);
  assert.equal(readClaudeTaskNotification({ message: { role: 'user', content: '<task-notification><task-id>one</task-id></task-notification>' } })?.status, 'unknown');
});
