import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ChatMessage } from '@/shared/types';
import { deriveConversationChanges } from '@/modules/chat/utils/conversationChanges';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { createConversationChangeStats } from '@/modules/chat/utils/conversationChangeStats';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';

const timestamp = '2026-09-07T12:00:00.000Z';
let nextTool = 0;

function user(id: string, content = 'Update the application', extra: Partial<ChatMessage> = {}): ChatMessage {
  return { type: 'user', id, content, timestamp, ...extra };
}

function tool(name: string, input: unknown, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    type: 'assistant', timestamp, isToolUse: true, toolName: name, toolInput: input,
    toolId: `test-tool-${nextTool++}`, toolResult: { content: 'Success', isError: false }, ...extra,
  };
}

const editInput = { file_path: '/project/src/app.ts', old_string: 'before', new_string: 'after' };
const allChanges = (messages: ChatMessage[]) => deriveConversationChanges(messages).flatMap((turn) => turn.changes);

test('groups completed changes by real user turns and preserves the latest empty turn', () => {
  const messages = [user('first', 'Fix\n  rendering'), tool('Edit', JSON.stringify(editInput)), user('second', 'Explain it')];
  const turns = deriveConversationChanges(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].label, 'Fix rendering');
  assert.equal(turns[0].changes.length, 1);
  assert.equal(turns[1].changes.length, 0);
  assert.equal(turns[0].changes[0].sourceMessageKey, getIntrinsicMessageKey(messages[1]));
  assert.equal(turns[0].changes[0].sourceToolId, messages[1].toolId);
  assert.equal(turns[0].changes[0].oldContent, 'before');
  assert.equal(turns[0].changes[0].newContent, 'after');
});

test('local commands, summaries, and task notifications do not split a user turn', () => {
  const messages = [
    user('first'), tool('Edit', editInput),
    user('command', '/status', { isLocalCommand: true }),
    user('stdout', 'Output', { isLocalCommandStdout: true }),
    user('compact', 'Summary', { isCompactSummary: true }),
    user('task', '<task-notification>done</task-notification>'),
    user('task-attribute', '  <task-notification task-id="1">done</task-notification>'),
    user('task-flag', 'done', { isTaskNotification: true }),
    tool('Write', { file_path: '/project/notes.md', content: '' }),
  ];
  const turns = deriveConversationChanges(messages);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].changes.length, 2);
});

test('leading completed tools receive an earlier-history turn; empty earlier history is omitted', () => {
  const turns = deriveConversationChanges([tool('Edit', editInput), user('first')]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].label, 'Earlier history');
  assert.equal(turns[0].changes.length, 1);
  assert.deepEqual(deriveConversationChanges([tool('Edit', editInput, { toolResult: null })]), []);
});

test('attachment-only real prompts remain turns and displayed prompt labels take precedence', () => {
  const turns = deriveConversationChanges([user('attachment', ''), user('display', 'raw', { displayText: 'Visible prompt' })]);
  assert.equal(turns[0].label, 'Conversation turn');
  assert.equal(turns[1].label, 'Visible prompt');
});

test('pending, streaming, failed, denied, and cancelled modifications never appear', () => {
  const invalid: Partial<ChatMessage>[] = [
    { toolResult: null }, { toolResult: {} }, { isStreaming: true }, { status: 'in_progress' },
    { toolResult: { content: 'failed', isError: true } },
    { toolResult: { content: 'partial', status: 'running' } },
    { toolResult: { content: 'failed', success: false } },
    { toolResult: { content: 'failed', toolUseResult: { is_error: true } } },
    { toolResult: { content: 'cancelled', toolUseResult: { status: 'cancelled' } } },
    { toolResult: { content: 'User denied tool use', isError: false } },
    { toolResult: { content: 'Permission request timed out', isError: false } },
    { toolResult: { content: '<tool_use_error>failed</tool_use_error>', isError: false } },
  ];
  assert.deepEqual(allChanges(invalid.map((extra) => tool('Edit', editInput, extra))), []);
});

test('reads, shell commands, and unproven provider file metadata are not reported as edits', () => {
  const messages = [
    tool('Read', { file_path: '/project/a', content: 'read' }),
    tool('Bash', { command: 'echo x > /project/a' }),
    tool('mcp__remote__Write', { file_path: '/project/a', content: 'external' }),
    tool('FileChanges', [{ path: '/project/a', kind: 'update' }], { toolResult: null, status: 'completed' }),
    tool('Patch', { files: ['/project/a'] }, { toolResult: null }),
  ];
  assert.deepEqual(allChanges(messages), []);
});

test('actual SDK edit output takes precedence over the proposed replacement', () => {
  const [change] = allChanges([tool('Edit', editInput, {
    toolResult: {
      content: 'Updated', isError: false,
      toolUseResult: { filePath: '/project/actual.ts', oldString: 'actual before', newString: 'approved after', userModified: true },
    },
  })]);
  assert.equal(change.filePath, '/project/actual.ts');
  assert.equal(change.oldContent, 'actual before');
  assert.equal(change.newContent, 'approved after');
});

test('Write records content without pretending an unknown previous file was empty', () => {
  const [unknown, known, tooLarge] = allChanges([
    tool('Write', { file_path: '/project/a', content: 'new' }),
    tool('Write', { file_path: '/project/b', content: 'proposed' }, {
      toolResult: { content: 'Updated', toolUseResult: { type: 'update', content: 'approved', originalFile: 'old' } },
    }),
    tool('Write', { file_path: '/project/c', content: '' }, {
      toolResult: { content: 'Updated', toolUseResult: { type: 'update', originalFile: null } },
    }),
  ]);
  assert.equal(unknown.operation, 'write');
  assert.equal(unknown.newContent, 'new');
  assert.equal(unknown.oldContent, undefined);
  assert.equal(known.oldContent, 'old');
  assert.equal(known.newContent, 'approved');
  assert.equal(tooLarge.oldContent, undefined);
  assert.equal(tooLarge.newContent, '');
});

test('user-modified results without recorded replacement content do not display proposed content', () => {
  const changes = allChanges([
    tool('Edit', editInput, { toolResult: { content: 'Updated', toolUseResult: { userModified: true } } }),
    tool('Write', { file_path: '/project/b', content: 'proposed' }, { toolResult: { content: 'Updated', toolUseResult: { userModified: true } } }),
  ]);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].oldContent, undefined);
  assert.equal(changes[0].newContent, undefined);
  assert.equal(changes[1].newContent, undefined);
});

test('MultiEdit retains each applied replacement in order, including repeated text', () => {
  const changes = allChanges([tool('MultiEdit', {
    file_path: '/project/a', edits: [
      { old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c' }, { old_string: 'a', new_string: 'b' },
    ],
  })]);
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.map((change) => [change.oldContent, change.newContent]), [['a', 'b'], ['b', 'c'], ['a', 'b']]);
  assert.equal(new Set(changes.map((change) => change.id)).size, 3);
});

test('lowercase edit/write and camel-case parameters support preserved OpenCode tool records', () => {
  const changes = allChanges([
    tool('edit', { filePath: '/project/a', oldString: 'a', newString: 'b' }),
    tool('write', JSON.stringify({ filePath: '/project/b', content: 'written' })),
  ]);
  assert.deepEqual(changes.map((change) => [change.filePath, change.operation]), [['/project/a', 'edit'], ['/project/b', 'write']]);
});

test('ApplyPatch old/new configuration remains supported', () => {
  const [change] = allChanges([tool('ApplyPatch', editInput)]);
  assert.equal(change.operation, 'patch');
  assert.equal(change.oldContent, 'before');
  assert.equal(change.newContent, 'after');
});

const multiFilePatch = [
  '*** Begin Patch',
  '*** Update File: src/a.ts', '@@', '-old', '+new', ' unchanged', '@@ function later()', '-before', '+after',
  '*** Add File: tests/a.ts', '+test content', '+',
  '*** Delete File: legacy/a.ts',
  '*** End Patch',
].join('\n');

test('complete apply_patch envelopes preserve every file and all hunks without invented full contents', () => {
  const changes = allChanges([tool('apply_patch', multiFilePatch)]);
  assert.deepEqual(changes.map((change) => [change.filePath, change.operation]), [['src/a.ts', 'patch'], ['tests/a.ts', 'write'], ['legacy/a.ts', 'delete']]);
  assert.ok(changes[0].patch?.includes('@@ function later()'));
  assert.ok(!changes[0].patch?.includes('tests/a.ts'));
  assert.ok(changes[1].patch?.includes('+test content\n+'));
  assert.equal(changes[0].oldContent, undefined);
  assert.equal(changes[0].newContent, undefined);
  assert.equal(changes[2].oldContent, undefined);
});

test('OpenCode patchText wrappers and patch objects use the same complete envelope parser', () => {
  for (const input of [{ patchText: multiFilePatch }, JSON.stringify({ patch: multiFilePatch })]) {
    assert.equal(allChanges([tool('apply_patch', input)]).length, 3);
  }
});

test('a move records both affected paths and the recorded patch that connects them', () => {
  const patch = '*** Begin Patch\n*** Update File: old/a.ts\n*** Move to: new/a.ts\n@@\n-x\n+y\n*** End Patch';
  const changes = allChanges([tool('apply_patch', patch)]);
  assert.deepEqual(changes.map((change) => [change.filePath, change.operation]), [['old/a.ts', 'delete'], ['new/a.ts', 'patch']]);
  assert.equal(changes[0].contextLabel, 'Moved to new/a.ts');
  assert.equal(changes[1].contextLabel, 'Moved from old/a.ts');
  assert.ok(changes.every((change) => change.patch === patch));
});

test('partial or malformed patch metadata cannot fabricate successful file records', () => {
  const malformed = [
    multiFilePatch.replace('*** End Patch', ''),
    multiFilePatch.replace('*** Add File: tests/a.ts', 'unrecognized patch directive'),
    '*** Begin Patch\n*** Add File: x\nnot an added line\n*** End Patch',
    '*** Begin Patch\n*** Delete File: x\n-unknown content\n*** End Patch',
    '*** Begin Patch\n*** Update File: x\n@@\n unchanged\n*** End Patch',
    'Here is a suggested patch:\n' + multiFilePatch,
  ];
  assert.deepEqual(allChanges(malformed.map((patch) => tool('apply_patch', patch))), []);
});

test('SDK structured patches retain hunk coordinates without mixing full files with replacement snippets', () => {
  const [change] = allChanges([tool('Edit', editInput, { toolResult: {
    content: 'Updated', toolUseResult: {
      originalFile: 'full original file', oldString: 'before', newString: 'after',
      structuredPatch: [{ oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, lines: ['-before', '+after'] }],
    },
  } })]);
  assert.equal(change.oldContent, 'before');
  assert.equal(change.patch, '@@ -20,1 +20,1 @@\n-before\n+after');
});

test('same tool replay is deduplicated, while separate tools making identical edits remain separate', () => {
  const original = tool('Edit', editInput);
  const changes = allChanges([original, { ...original }, tool('Edit', editInput)]);
  assert.equal(changes.length, 2);
  assert.notEqual(changes[0].id, changes[1].id);
});

test('unidentified tools sharing a timestamp and identical content are not falsely deduplicated', () => {
  const first = tool('Edit', editInput, { toolId: undefined });
  const changes = allChanges([first, { ...first }]);
  assert.equal(changes.length, 2);
  assert.notEqual(changes[0].id, changes[1].id);
  assert.equal(changes[0].sourceMessageKey, getIntrinsicMessageKey(first));
});

test('late completion belongs to its original user turn and pending replay cannot erase it', () => {
  const pending = tool('Edit', {}, { toolResult: null });
  const complete = { ...pending, toolInput: editInput, toolResult: { content: 'Success', isError: false } };
  const pendingReplay = { ...pending, toolResult: { content: 'Partial', status: 'running' } };
  const turns = deriveConversationChanges([user('first'), pending, user('second'), complete, pendingReplay, { ...pending, toolResult: {} }]);
  assert.equal(turns[0].changes.length, 1);
  assert.equal(turns[1].changes.length, 0);
  assert.equal(turns[0].changes[0].newContent, 'after');
});

test('richer final SDK metadata replaces an earlier completed snapshot without duplicate changes', () => {
  const earlier = tool('Edit', editInput);
  const final = { ...earlier, toolResult: { content: 'Updated', toolUseResult: { oldString: 'before', newString: 'actual', userModified: true } } };
  const changes = allChanges([earlier, final]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].newContent, 'actual');
});

test('subagent successful edits use the parent anchor and child tool identity even if the parent fails', () => {
  const parent = tool('Task', JSON.stringify({ description: 'Implement the parser' }), {
    isSubagentContainer: true, toolResult: { content: 'Subagent stopped', isError: true },
    subagentActivity: [
      { kind: 'text', content: 'I will edit the parser.', timestamp },
      { kind: 'tool', toolId: 'child-1', toolName: 'Edit', toolInput: editInput, timestamp, toolResult: { content: 'Updated', isError: false } },
      { kind: 'tool', toolId: 'child-2', toolName: 'Write', toolInput: { file_path: '/project/b', content: 'x' }, timestamp, toolResult: null },
      { kind: 'thinking', content: 'Check the final state.', timestamp },
      { kind: 'tool', toolId: 'child-3', toolName: 'Edit', toolInput: editInput, timestamp, toolResult: { content: 'Denied', isError: true } },
    ],
  });
  const changes = allChanges([user('first'), parent, { ...parent }]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].sourceMessageKey, getIntrinsicMessageKey(parent));
  assert.equal(changes[0].sourceToolId, 'child-1');
  assert.equal(changes[0].contextLabel, 'Implement the parser');
});

test('unified tool status prevents pending rows and child metadata preserves user-adjusted edits', () => {
  const parent = tool('Agent', {}, {
    subagent: { id: 'agent-one', status: 'failed', description: 'Adjust final content' },
    subagentActivity: [
      { kind: 'tool', toolId: 'child-final', toolName: 'Edit', toolInput: editInput, toolResult: {
        content: 'Updated', isError: false, toolUseResult: { userModified: true, oldString: 'before', newString: 'user-adjusted' },
      } },
    ],
  });
  const changes = allChanges([tool('Edit', editInput, { toolStatus: 'running' }), parent]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].newContent, 'user-adjusted');
  assert.equal(changes[0].timestamp, timestamp);
  assert.equal(changes[0].contextLabel, 'Adjust final content');
  assert.equal(changes[0].sourceToolId, 'child-final');
});

test('full file paths remain distinct, repeated modifications stay ordered, and no-op edits are skipped', () => {
  const changes = allChanges([
    tool('Edit', { file_path: '/a/index.ts', old_string: 'x', new_string: 'y' }),
    tool('Edit', { file_path: '/b/index.ts', old_string: 'x', new_string: 'y' }),
    tool('Edit', { file_path: '/a/index.ts', old_string: 'y', new_string: 'z' }),
    tool('Edit', { file_path: '/a/index.ts', old_string: 'z', new_string: 'z' }),
    tool('Write', { file_path: '/b/index.ts', content: 'y' }, { toolResult: { content: 'Success', toolUseResult: { originalFile: 'y' } } }),
  ]);
  assert.deepEqual(changes.map((change) => change.filePath), ['/a/index.ts', '/b/index.ts', '/a/index.ts']);
});

test('malformed inputs and missing anchors are skipped without mutating the input history', () => {
  const messages = [
    tool('Edit', '{bad json'), tool('Write', { file_path: 'unknown', content: 'x' }),
    tool('Edit', { ...editInput, file_path: '\u0000' }),
    tool('Edit', editInput, { toolId: undefined, timestamp: 'not a timestamp' }),
    user('first'), tool('Edit', editInput),
  ];
  const before = structuredClone(messages);
  assert.equal(allChanges(messages).length, 1);
  assert.deepEqual(messages, before);
});

test('pending and failed local copies cannot hide a successful 318-line Write behind an empty latest turn', () => {
  const content = Array.from({ length: 318 }, (_, index) => `# synthetic line ${index + 1}\n`).join('');
  const turns = deriveConversationChanges([
    user('native-prompt_text_0', 'Create a check', { transcriptAnchorId: 'native-prompt' }),
    tool('Write', { file_path: '/project/sandcheck.py', content }, { toolResult: { content: 'Created', toolUseResult: { type: 'create', content } } }),
    user('client_native-prompt', 'Create a check', { clientMessageId: 'native-prompt', delivery: 'queued' }),
    user('client_unconsumed', 'Follow-up not consumed', { clientMessageId: 'unconsumed', delivery: 'failed' }),
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].changes[0].filePath, '/project/sandcheck.py');
  assert.deepEqual(createConversationChangeStats(createCachedDiffCalculator())(turns[0].changes), { added: 318, removed: 0, known: 1, unknown: 0 });
});

test('exact saved and delivered prompt copies do not become new turns or move late tools to an older turn', () => {
  const turns = deriveConversationChanges([
    user('first_text_0', 'Continue', { transcriptAnchorId: 'first' }),
    tool('Edit', editInput),
    user('second', 'Continue'),
    user('client_first', 'Continue', { clientMessageId: 'first', delivery: 'delivered' }),
    tool('Write', { file_path: '/project/later.txt', content: 'Later work' }),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].changes.length, 1);
  assert.equal(turns[1].changes[0].filePath, '/project/later.txt');
});

test('sparse repeated tool snapshots preserve successful input and creation metadata', () => {
  const write = tool('Write', { file_path: '/project/new.py', content: 'one\ntwo\n' }, {
    toolResult: { content: 'Created', toolUseResult: { type: 'create', content: 'one\ntwo\n' } },
  });
  const changes = allChanges([write, { ...write, toolInput: undefined, toolResult: { content: 'Success' } }]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].newContent, 'one\ntwo\n');
  assert.equal(changes[0].oldContent, '');
});

test('successful known paths stay in Review even when replacement content and line counts are unavailable', () => {
  const changes = allChanges([
    tool('Write', { file_path: '/project/new.py' }),
    tool('Edit', { file_path: '/project/edited.py' }),
    tool('MultiEdit', { file_path: '/project/multiple.py' }),
    tool('MultiEdit', { file_path: '/project/partial.py', edits: [{ old_string: 'before' }] }),
    tool('MultiEdit', { file_path: '/project/modified.py', edits: [{ old_string: 'before', new_string: 'proposed' }] }, { toolResult: { content: 'Success', toolUseResult: { userModified: true } } }),
  ]);
  assert.deepEqual(changes.map(change => change.filePath), ['/project/new.py', '/project/edited.py', '/project/multiple.py', '/project/partial.py', '/project/modified.py']);
  assert.deepEqual(createConversationChangeStats(createCachedDiffCalculator())(changes), { added: 0, removed: 0, known: 0, unknown: 5 });
});
