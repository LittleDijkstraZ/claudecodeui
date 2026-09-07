import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { NormalizedMessage, SubagentActivity } from '@/shared/types';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';

const timestamp = '2026-09-08T12:00:00.000Z';

function toolMessage(toolName: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'normalized-parent',
    sessionId: 'session-1',
    timestamp,
    provider: 'claude',
    kind: 'tool_use',
    toolName,
    toolId: 'parent-tool',
    toolInput: { description: 'Update the view', subagent_type: 'general-purpose' },
    ...extra,
  };
}

for (const toolName of ['Task', 'Agent']) {
  test(`${toolName} preserves child edit identities, inputs, successful results, and errors`, () => {
    const successfulEdit: SubagentActivity = {
      kind: 'tool',
      toolId: 'edit-success',
      toolName: 'Edit',
      toolInput: { file_path: '/project/view.ts', old_string: 'before', new_string: 'after' },
      toolResult: { content: 'Updated', isError: false, toolUseResult: { replacements: 1 } },
      timestamp,
    };
    const failedEdit: SubagentActivity = {
      kind: 'tool',
      toolId: 'edit-error',
      toolName: 'Write',
      toolInput: { file_path: '/project/locked.ts', content: 'attempted write' },
      toolResult: { content: '<tool_use_error>Permission denied</tool_use_error>', isError: true },
      timestamp,
    };
    const [message] = normalizedToChatMessages([toolMessage(toolName, {
      subagentTools: [successfulEdit, failedEdit],
      toolResult: { content: 'Finished with one denied edit', isError: false },
    })]);

    assert.equal(message.toolId, 'parent-tool');
    assert.equal(message.isSubagentContainer, true);
    assert.deepEqual(message.subagentActivity, [successfulEdit, failedEdit]);
  });
}

test('an Agent with an empty child array stays a pending container before any tools arrive', () => {
  const [message] = normalizedToChatMessages([toolMessage('Agent', { subagentTools: [] })]);

  assert.equal(message.isSubagentContainer, true);
  assert.deepEqual(message.subagentActivity, []);
  assert.equal(message.toolResult, null);
});

test('Agent and Task retain the upstream pending container behavior before child metadata arrives', () => {
  const [agent] = normalizedToChatMessages([toolMessage('Agent')]);
  assert.equal(agent.isSubagentContainer, true);
  assert.equal(agent.subagentActivity, undefined);

  const [task] = normalizedToChatMessages([toolMessage('Task')]);
  assert.equal(task.isSubagentContainer, true);
  assert.equal(task.subagentActivity, undefined);

  const [ordinaryTool] = normalizedToChatMessages([toolMessage('Edit', { subagentTools: [] })]);
  assert.equal(ordinaryTool.isSubagentContainer, false);
  assert.deepEqual(ordinaryTool.subagentActivity, []);
});

test('an Agent parent result attaches by tool ID and formats its error without changing the error flag or metadata', () => {
  const result: NormalizedMessage = {
    id: 'normalized-result',
    sessionId: 'session-1',
    timestamp,
    provider: 'claude',
    kind: 'tool_result',
    toolId: 'parent-tool',
    content: '<tool_use_error>Task could not finish</tool_use_error>',
    isError: true,
  };
  const messages = normalizedToChatMessages([toolMessage('Agent', { subagentTools: [] }), result]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].toolResult?.content, 'Task could not finish');
  assert.equal(messages[0].toolResult?.isError, true);
  assert.equal(messages[0].isSubagentContainer, true);
});
