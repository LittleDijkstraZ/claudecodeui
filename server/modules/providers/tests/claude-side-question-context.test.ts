import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeSideQuestionContext } from '@/modules/providers/list/claude/claude-side-question-context.js';
import { createNormalizedMessage } from '@/shared/index.js';

test('side context includes each visible delta immediately and final text replaces its exact streamed block', () => {
  const context = createClaudeSideQuestionContext(() => 'native');
  const block = { provider: 'claude' as const, sessionId: 'native', responseMessageId: 'response', contentBlockIndex: 0 };
  context.observe(createNormalizedMessage({ ...block, kind: 'stream_delta', content: 'Current visible ' }));
  const first = context.snapshot();
  assert.equal(JSON.parse(first)[0].content, 'Current visible ');
  assert.equal(JSON.parse(first)[0].streaming, true);
  context.observe(createNormalizedMessage({ ...block, kind: 'stream_delta', content: 'sentinel' }));
  context.observe(createNormalizedMessage({ ...block, kind: 'stream_end' }));
  context.observe(createNormalizedMessage({ ...block, id: 'saved-message', kind: 'text', role: 'assistant', content: 'Current visible sentinel' }));
  const rows = JSON.parse(context.snapshot());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'Current visible sentinel');
  assert.equal(rows[0].streaming, false);
  assert.equal(JSON.parse(first)[0].content, 'Current visible ', 'Earlier acquisitions remain fixed snapshots');
});

test('unsubmitted input, reasoning, nested agents and other native sessions cannot enter side context', () => {
  const context = createClaudeSideQuestionContext(() => 'native');
  for (const fields of [
    { kind: 'status', text: 'message_delivery', delivery: 'queued', clientMessageId: 'queued', content: 'Unsubmitted' },
    { kind: 'status', text: 'message_delivery', delivery: 'failed', clientMessageId: 'failed', content: 'Failed' },
    { kind: 'thinking', content: 'Private reasoning' },
    { kind: 'text', role: 'assistant', content: 'Child', parentToolUseId: 'agent-tool' },
    { kind: 'text', role: 'assistant', content: 'Other session', sessionId: 'other-native' },
    { kind: 'text', role: 'assistant', content: 'Sidechain', isSidechain: true },
  ] as const) context.observe(createNormalizedMessage({ sessionId: 'native', provider: 'claude', ...fields }));
  assert.equal(context.snapshot(), '');
  context.observe(createNormalizedMessage({ kind: 'status', text: 'message_delivery', delivery: 'delivered', clientMessageId: 'accepted', content: 'Delivered user question', sessionId: 'native', provider: 'claude' }));
  assert.equal(JSON.parse(context.snapshot())[0].content, 'Delivered user question');
});

test('tool completion replaces running activity and bounds large output while retaining recent visible text', () => {
  const context = createClaudeSideQuestionContext(() => 'native');
  context.observe(createNormalizedMessage({ kind: 'tool_use', provider: 'claude', sessionId: 'native', toolId: 'tool', toolName: 'Bash', toolInput: { command: 'run checks' } }));
  context.observe(createNormalizedMessage({ kind: 'tool_result', provider: 'claude', sessionId: 'native', toolId: 'tool', content: 'x'.repeat(100_000) + 'RESULT_END', isError: true }));
  context.observe(createNormalizedMessage({ kind: 'text', provider: 'claude', sessionId: 'native', id: 'fresh', role: 'assistant', content: 'Latest main response' }));
  const rows = JSON.parse(context.snapshot());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].toolName, 'Bash');
  assert.equal(rows[0].status, 'error');
  assert.ok(rows[0].input.includes('run checks'));
  assert.ok(rows[0].content.length <= 8000);
  assert.ok(rows[0].content.endsWith('RESULT_END'));
  assert.equal(rows[1].content, 'Latest main response');
});

test('the entire JSON snapshot stays bounded including escaped data and keeps the most recent activity', () => {
  const context = createClaudeSideQuestionContext(() => 'native');
  for (let index = 0; index < 100; index++) context.observe(createNormalizedMessage({ kind: 'text', provider: 'claude', sessionId: 'native', id: `row-${index}`, role: 'assistant', content: '\u0000'.repeat(50_000) + `LATEST-${index}` }));
  const snapshot = context.snapshot();
  assert.ok(snapshot.length <= 48_000);
  assert.ok(snapshot.includes('LATEST-99'));
  assert.ok(!snapshot.includes('LATEST-0'));
  assert.doesNotThrow(() => JSON.parse(snapshot));
});

test('a late tool result remains recent when older context is evicted', () => {
  const context = createClaudeSideQuestionContext(() => 'native');
  context.observe(createNormalizedMessage({ kind: 'tool_use', provider: 'claude', sessionId: 'native', toolId: 'slow-tool', toolName: 'Bash', toolInput: { command: 'long check' } }));
  for (let index = 0; index < 3; index++) context.observe(createNormalizedMessage({ kind: 'text', provider: 'claude', sessionId: 'native', id: `row-${index}`, role: 'assistant', content: 'x'.repeat(12_000) }));
  context.observe(createNormalizedMessage({ kind: 'tool_result', provider: 'claude', sessionId: 'native', toolId: 'slow-tool', content: 'Fresh tool completion' }));
  context.observe(createNormalizedMessage({ kind: 'text', provider: 'claude', sessionId: 'native', id: 'newest-row', role: 'assistant', content: 'y'.repeat(12_000) }));
  const rows = JSON.parse(context.snapshot());
  assert.equal(rows.at(-2).content, 'Fresh tool completion');
  assert.equal(rows.at(-2).toolName, 'Bash');
  assert.ok(context.snapshot().length <= 48_000);
});
