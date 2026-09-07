import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ChatMessage, ConversationFileChange } from '@/shared/types';
import { createConversationChangeStats } from '@/modules/chat/utils/conversationChangeStats';
import { deriveConversationChanges } from '@/modules/chat/utils/conversationChanges';
import { calculateDiff } from '@/modules/chat/utils/messageTransforms';

const change = (extra: Partial<ConversationFileChange> = {}): ConversationFileChange => ({
  id: 'change-1', filePath: '/project/file.ts', operation: 'edit', sourceMessageKey: 'source-1', timestamp: '2026-09-07', ...extra,
});
const summarize = (changes: ConversationFileChange[]) => createConversationChangeStats(calculateDiff)(changes);

test('line totals accumulate sequential successful edits instead of claiming a net file diff', () => {
  assert.deepEqual(summarize([
    change({ oldContent: 'before\n', newContent: 'after\nextra\n' }),
    change({ id: 'change-2', oldContent: 'after\nextra\n', newContent: 'before\n' }),
  ]), { added: 3, removed: 3, known: 2, unknown: 0 });
});

test('successful SDK patches take precedence over fragments and include every replaced occurrence', () => {
  const patch = '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-before\n+after\n context\n-before\n+after';
  assert.deepEqual(summarize([change({ oldContent: 'before', newContent: 'after', patch, lineCountUnavailable: true })]), { added: 2, removed: 2, known: 1, unknown: 0 });
});

test('patch headers are not edits while literal plus and minus source lines inside a hunk are edits', () => {
  assert.deepEqual(summarize([change({ patch: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n---old\n+++new\n\\ No newline at end of file' })]), { added: 1, removed: 1, known: 1, unknown: 0 });
  assert.deepEqual(summarize([change({ patch: '@@ -1,2 +1,2 @@\n-old\n+new' })]), { added: 0, removed: 0, known: 0, unknown: 1 });
});

test('apply_patch additions and updates count recorded lines; deletions without original content remain unknown', () => {
  assert.deepEqual(summarize([
    change({ operation: 'write', patch: '*** Begin Patch\n*** Add File: new.ts\n+first\n+\n*** End Patch' }),
    change({ id: 'update', operation: 'patch', patch: '*** Begin Patch\n*** Update File: file.ts\n@@\n-old\n+new\n+extra\n*** End Patch' }),
    change({ id: 'delete', operation: 'delete', patch: '*** Begin Patch\n*** Delete File: unknown.ts\n*** End Patch' }),
  ]), { added: 4, removed: 1, known: 2, unknown: 1 });
});

test('an apply_patch move records both paths but counts its text edits only once', () => {
  const patch = '*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-old\n+new\n*** End Patch';
  assert.deepEqual(summarize([change({ operation: 'delete', patch }), change({ id: 'destination', filePath: 'new.ts', operation: 'patch', patch })]), { added: 1, removed: 1, known: 2, unknown: 0 });
});

test('unknown previous content and unknown replacement counts never invent added or deleted totals', () => {
  assert.deepEqual(summarize([
    change({ operation: 'write', newContent: 'possibly an overwrite\nmore\n' }),
    change({ id: 'all', oldContent: 'one match', newContent: 'replacement', lineCountUnavailable: true, patch: '@@ -1,2 +1,2 @@\n-old\n+new' }),
    change({ id: 'known', oldContent: 'old', newContent: 'new' }),
  ]), { added: 1, removed: 1, known: 1, unknown: 2 });
});

test('empty and large created/deleted files count line terminators without a quadratic diff', () => {
  const count = createConversationChangeStats(() => { throw new Error('Must not diff whole new or removed files'); });
  assert.deepEqual(count([
    change({ oldContent: '', newContent: 'line\n'.repeat(20_000) }),
    change({ id: 'deleted', oldContent: 'line\nlast', newContent: '' }),
    change({ id: 'empty', oldContent: '', newContent: '' }),
    change({ id: 'huge-edit', oldContent: 'before\n'.repeat(3_000), newContent: 'after\n'.repeat(3_000) }),
  ]), { added: 20_000, removed: 2, known: 3, unknown: 1 });
});

test('unchanged streamed records reuse totals even for selections larger than the per-record cache', () => {
  let calls = 0;
  const count = createConversationChangeStats((before, after) => { calls += 1; return calculateDiff(before, after); });
  const records = Array.from({ length: 1_100 }, (_, index) => change({ id: String(index), oldContent: 'before', newContent: 'after' }));
  const first = count(records);
  assert.equal(calls, 1_100);
  assert.equal(count(records.map(record => ({ ...record }))), first);
  assert.equal(calls, 1_100);
  const changed = [change({ oldContent: 'before', newContent: 'after' })];
  count(changed);
  assert.deepEqual(count([{ ...changed[0], newContent: 'after\nextra' }]), { added: 2, removed: 1, known: 1, unknown: 0 });
});

test('the summary pipeline excludes failed and pending tools, honors native file creation, and marks unknown replace-all counts', () => {
  const messages: ChatMessage[] = [{ id: 'user', type: 'user', content: 'Edit files', timestamp: '2026-09-07' }];
  const tool = (id: string, toolName: string, toolInput: unknown, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id, toolId: id, type: 'assistant', timestamp: '2026-09-07', isToolUse: true, toolName, toolInput,
    toolResult: { content: 'Success', isError: false }, ...extra,
  });
  const edit = { file_path: '/project/a', old_string: 'before', new_string: 'after' };
  messages.push(tool('good', 'Edit', edit), tool('bad', 'Edit', edit, { toolResult: { content: 'Denied', isError: true } }),
    tool('pending', 'Edit', edit, { toolResult: null }), tool('unknown-all', 'Edit', { ...edit, replace_all: true }),
    tool('created', 'Write', { file_path: '/project/new', content: 'first\nsecond\n' }, { toolResult: { content: 'Created', toolUseResult: { type: 'create', originalFile: null, content: 'first\nsecond\n' } } }));
  const records = deriveConversationChanges(messages).flatMap(turn => turn.changes);
  assert.equal(records.length, 3);
  assert.deepEqual(summarize(records), { added: 3, removed: 1, known: 2, unknown: 1 });
});
