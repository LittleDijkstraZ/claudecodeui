import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeUsageAccumulator } from '@/modules/claude-usage/claude-usage-accumulator.js';

const usage = (input = 10, cache = 100, output = 20) => ({ input_tokens: input, cache_read_input_tokens: cache, cache_creation_input_tokens: 5, output_tokens: output });
const model = (input = 10, cache = 100, output = 20, cost = 0.2, extra = {}) => ({ inputTokens: input, cacheReadInputTokens: cache, cacheCreationInputTokens: 5, outputTokens: output, costUSD: cost, contextWindow: 1_000_000, costBasis: 'list', ...extra });
const assistant = (id = 'msg-one', inputUsage = usage(), extra = {}) => ({ type: 'assistant', message: { id, model: 'opus-explicit', usage: inputUsage }, ...extra });
const result = (id: string, models: Record<string, unknown> = { 'opus-explicit': model() }, cost = 0.2, extra = {}) => ({ type: 'result', uuid: id, modelUsage: models, total_cost_usd: cost, ...extra });
const now = () => '2026-09-09T10:00:00Z';

test('parallel blocks and repeated smaller usage count one request with final maxima', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  for (let block = 0; block < 4; block++) run.observe(assistant());
  run.observe(assistant('msg-one', usage(10, 100, 25)));
  run.observe(assistant());
  assert.deepEqual(run.snapshot().models['opus-explicit'], { inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 5, outputTokens: 25, estimatedCostUsd: null, costBasis: 'unknown' });
  assert.equal(run.snapshot().context.usedTokens, 140);
});

test('8M server-loop spend displays the final 80K sampling context, excluding advisor context', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  const loop = { ...usage(0, 8_000_000, 50), iterations: [
    { type: 'message', ...usage(0, 70_000, 100) },
    { type: 'advisor_message', model: 'advisor-explicit', ...usage(0, 250_000, 400) },
    { type: 'message', ...usage(0, 80_000, 100) },
  ] };
  run.observe(assistant('loop', loop));
  run.observe(assistant('loop', loop));
  run.observe(assistant('loop', usage(0, 8_000_000, 50)));
  assert.equal(run.snapshot().context.usedTokens, 80_105);
  assert.equal(run.snapshot().models['opus-explicit'].cacheReadTokens, 8_000_000);
  assert.equal(run.snapshot().models['advisor-explicit'].cacheReadTokens, 250_000);
});

test('subagents and task progress do not replace the main context', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  run.observe(assistant());
  run.observe(assistant('child', usage(1, 20_000, 300), { parent_tool_use_id: 'tool-parent' }));
  assert.equal(run.observe({ type: 'system', subtype: 'task_progress', usage: { total_tokens: 100000 } }), false);
  assert.equal(run.snapshot().context.usedTokens, 135);
});

test('result settlement replaces observed main and subagent counters, including every model once', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  run.observe(assistant());
  run.observe(assistant('child', usage(), { parent_tool_use_id: 'tool-parent' }));
  run.observe(result('result-one', { 'opus-explicit': model(200, 500, 30), 'haiku-explicit': model(40, 2000, 600, 0.05) }, 0.25));
  assert.equal(run.snapshot().models['opus-explicit'].inputTokens, 200);
  assert.equal(run.snapshot().models['haiku-explicit'].outputTokens, 600);
  assert.equal(run.snapshot().estimatedCostUsd, 0.25);
  assert.equal(run.snapshot().turn?.coverage, 'sdk-query-pipeline');
  assert.equal(run.snapshot().context.usedTokens, 135);
});

test('multiple streaming-input results are differenced, and duplicate results never charge twice', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  const first = result('result-one');
  run.observe(first); run.observe(first);
  run.observe(result('result-two', { 'opus-explicit': model(40, 250, 60, 0.5) }, 0.5));
  assert.equal(run.snapshot().models['opus-explicit'].inputTokens, 40);
  assert.equal(run.snapshot().turn?.models['opus-explicit'].inputTokens, 30);
  assert.equal(run.snapshot().turn?.models['opus-explicit'].cacheReadTokens, 150);
  assert.equal(run.snapshot().turn?.estimatedCostUsd, 0.3);
  assert.equal(run.snapshot().estimatedCostUsd, 0.5);
});

test('summary reports actual policy window separately from actual model capacity', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  run.observe(assistant()); run.observe(result('result-one'));
  run.observeContextSummary({ totalTokens: 1600, model: 'opus-explicit', rawMaxTokens: 200_000 });
  assert.equal(run.snapshot().context.capacityTokens, 1_000_000);
  assert.equal(run.snapshot().context.compactionWindowTokens, 200_000);
  assert.equal(run.snapshot().context.usedTokens, 1600);
  assert.equal(run.snapshot().context.measurement, 'sdk-local-estimate');
});

test('serialization and restart return identical snapshots and retain result deduplication', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  run.observe(assistant());run.observe(result('result-one'));
  const restored = new ClaudeUsageAccumulator('query-one', JSON.parse(JSON.stringify(run.serialize())), now);
  assert.deepEqual(restored.snapshot(), run.snapshot());
  assert.equal(restored.observe(result('result-one')), false);
  assert.deepEqual(restored.snapshot(), run.snapshot());
});

test('clear starts a new cumulative epoch while compact only changes context', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  run.observe(assistant());run.observe(result('result-one'));
  run.observe({ type: 'system', subtype: 'compact_boundary', compact_metadata: { post_tokens: 42 } });
  assert.equal(run.snapshot().context.usedTokens, 42);
  assert.equal(run.snapshot().estimatedCostUsd, 0.2);
  run.observe({ type: 'conversation_reset' });
  run.observe(result('result-after-clear', { 'opus-explicit': model(3, 50, 10, 0.1) }, 0.1));
  assert.equal(run.snapshot().models['opus-explicit'].inputTokens, 13);
  assert.ok(Math.abs(run.snapshot().estimatedCostUsd! - 0.3) < 1e-10);
  assert.equal(run.snapshot().context.usedTokens, null);
});

test('error results settle usage; zeroed crash totals cannot delete previous spend', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  run.observe(result('result-one', { 'opus-explicit': model() }, 0.2, { is_error: true }));
  run.observe(result('result-zero', { 'opus-explicit': model(0, 0, 0, 0, { cacheCreationInputTokens: 0 }) }, 0, { is_error: true }));
  assert.equal(run.snapshot().models['opus-explicit'].inputTokens, 10);
  assert.equal(run.snapshot().knownEstimatedCostUsd, 0.2);
  assert.equal(run.snapshot().turn?.status, 'error');
  assert.ok(run.snapshot().warnings.includes('query-counter-regressed'));
});

test('unknown pricing remains unknown while known model subtotal is retained', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  run.observe(result('result-one', { 'opus-explicit': model(), 'unknown-price': model(20, 20, 20, 900, { costBasis: 'unknown' }) }, 900.2));
  assert.equal(run.snapshot().estimatedCostUsd, null);
  assert.equal(run.snapshot().knownEstimatedCostUsd, 0.2);
  assert.equal(run.snapshot().models['unknown-price'].estimatedCostUsd, null);
});

test('partial streaming output is cumulative within a request and thinking is already in output', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  run.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'stream', model: 'opus-explicit', usage: usage(10, 50, 1) } } });
  run.observe({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20, output_tokens_details: { thinking_tokens: 15 } } } });
  const counters = run.snapshot().models['opus-explicit'];
  assert.equal(counters.inputTokens + counters.cacheReadTokens + counters.cacheWriteTokens + counters.outputTokens, 85);
  assert.equal(counters.thinkingTokens, 15);
  run.finish();
  assert.equal(run.snapshot().turn?.status, 'interrupted');
  assert.equal(run.snapshot().models['opus-explicit'].outputTokens, 20);
});

test('main-only fallback reports consumed tokens without pretending to know context', () => {
  const run = new ClaudeUsageAccumulator('query-one', undefined, now);
  run.observe({ type: 'result', uuid: 'old-result', usage: usage(100, 8_000_000, 200) });
  assert.equal(run.snapshot().context.usedTokens, null);
  assert.equal(run.snapshot().models['<unattributed-main>'].cacheReadTokens, 8_000_000);
  assert.equal(run.snapshot().turn?.coverage, 'observed-requests');
});

test('retained input UUIDs are counted once without changing consumed tokens or pricing', () => {
  const run = new ClaudeUsageAccumulator('shared-query', undefined, now);
  assert.equal(run.noteUserMessage('first-input'), true);
  run.observe(assistant()); run.observe(result('result-one'));
  const before = run.snapshot(); const persisted = run.serialize();
  assert.equal(run.noteUserMessage('first-input'), false);
  assert.deepEqual(run.serialize(), persisted);
  assert.equal(run.snapshot().userMessageCount, 1);
  assert.equal(run.snapshot().warnings.includes('multiple-messages-share-execution-usage'), false);
  assert.equal(run.noteUserMessage('second-input'), true);
  assert.equal(run.noteUserMessage('second-input'), false);
  assert.equal(run.noteUserMessage('third-input'), true);
  const after = run.snapshot();
  assert.equal(after.userMessageCount, 3);
  assert.equal(after.warnings.filter(item => item === 'multiple-messages-share-execution-usage').length, 1);
  assert.deepEqual(after.models, before.models); assert.equal(after.estimatedCostUsd, before.estimatedCostUsd);
});

test('multiple input warning and count persist across restart while cumulative results remain one shared bill', () => {
  const run = new ClaudeUsageAccumulator('shared-query', undefined, now);
  run.noteUserMessage('first-input'); run.observe(result('result-one'));
  run.noteUserMessage('second-input'); run.observe(result('result-two', { 'opus-explicit': model(40, 250, 60, .5) }, .5));
  run.finish();
  const restored = new ClaudeUsageAccumulator('shared-query', JSON.parse(JSON.stringify(run.serialize())), now);
  assert.deepEqual(restored.snapshot(), run.snapshot());
  assert.equal(restored.noteUserMessage('second-input'), false);
  assert.equal(restored.snapshot().userMessageCount, 2);
  assert.deepEqual(restored.snapshot().warnings, ['multiple-messages-share-execution-usage']);
  assert.equal(restored.snapshot().models['opus-explicit'].inputTokens, 40);
  assert.equal(restored.snapshot().models['opus-explicit'].cacheReadTokens, 250);
  assert.equal(restored.snapshot().estimatedCostUsd, .5);
});

test('older persisted accounting without input IDs retains single-input compatibility', () => {
  const run = new ClaudeUsageAccumulator('legacy-query', undefined, now);
  run.observe(result('legacy-result'));
  const saved = JSON.parse(JSON.stringify(run.serialize())); delete saved.userMessageIds;
  const restored = new ClaudeUsageAccumulator('legacy-query', saved, now);
  assert.equal(restored.snapshot().userMessageCount, 1);
  assert.equal(restored.snapshot().warnings.includes('multiple-messages-share-execution-usage'), false);
  assert.equal(restored.snapshot().estimatedCostUsd, .2);
});
