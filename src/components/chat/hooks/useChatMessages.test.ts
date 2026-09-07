import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

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
    const successfulEdit = {
      toolId: 'edit-success',
      toolName: 'Edit',
      toolInput: { file_path: '/project/view.ts', old_string: 'before', new_string: 'after' },
      toolResult: { content: 'Updated', isError: false, toolUseResult: { replacements: 1 } },
      timestamp,
    };
    const failedEdit = {
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
    assert.deepEqual(message.subagentState, {
      childTools: [successfulEdit, failedEdit].map((child) => ({ ...child, timestamp: new Date(timestamp) })),
      currentToolIndex: 1,
      isComplete: true,
    });
  });
}

test('an Agent with an empty child array stays a pending container before any tools arrive', () => {
  const [message] = normalizedToChatMessages([toolMessage('Agent', { subagentTools: [] })]);

  assert.equal(message.isSubagentContainer, true);
  assert.deepEqual(message.subagentState, { childTools: [], currentToolIndex: -1, isComplete: false });
  assert.equal(message.toolResult, null);
});

test('Agent without child metadata remains an ordinary tool and Task keeps its existing container behavior', () => {
  const [agent] = normalizedToChatMessages([toolMessage('Agent')]);
  assert.equal(agent.isSubagentContainer, false);
  assert.equal(agent.subagentState, undefined);

  const [task] = normalizedToChatMessages([toolMessage('Task')]);
  assert.equal(task.isSubagentContainer, true);
  assert.deepEqual(task.subagentState, { childTools: [], currentToolIndex: -1, isComplete: false });

  const [ordinaryTool] = normalizedToChatMessages([toolMessage('Edit', { subagentTools: [] })]);
  assert.equal(ordinaryTool.isSubagentContainer, false);
  assert.equal(ordinaryTool.subagentState, undefined);
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
  assert.equal(messages[0].subagentState?.isComplete, true);
});

test('text history keeps saved provider message IDs for validated rewind and side-chat actions', () => {
  const uuid = 'ce472bb2-e2d5-4410-ac49-69d1e0881ff5';
  const messages = normalizedToChatMessages([
    { id: `${uuid}_text_0`, sessionId: 'session-1', timestamp, provider: 'claude', kind: 'text', role: 'user', content: 'Saved user turn' },
  ]);
  assert.equal(messages[0].id, `${uuid}_text_0`);
});

test('one task notification expanded into two visible messages has unique saved-derived identities', () => {
  const messages = normalizedToChatMessages([
    { id: 'saved-notification', sessionId: 'session-1', timestamp, provider: 'claude', kind: 'text', role: 'user', content: '<task-notification><status>completed</status><summary>Done</summary><result>Result text</result></task-notification>' },
  ]);
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].id, messages[1].id);
  assert.ok(String(messages[0].id).startsWith('saved-notification'));
  assert.ok(String(messages[1].id).startsWith('saved-notification'));
});
