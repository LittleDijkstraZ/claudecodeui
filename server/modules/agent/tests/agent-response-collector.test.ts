import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentResponseCollector } from '../agent-response-collector.service.js';

test('collector assembles delta-only replies and preserves assistant tools and thinking', () => {
  const collector = new AgentResponseCollector();
  collector.send({ kind: 'text', role: 'user', content: 'Do not return this echo' });
  collector.send({ kind: 'stream_delta', provider: 'cursor', sessionId: 'session', content: 'Hello ' });
  collector.send({ kind: 'stream_delta', provider: 'cursor', sessionId: 'session', content: 'world' });
  collector.send({ kind: 'stream_end' });
  collector.send({ kind: 'thinking', content: 'Consider the result' });
  collector.send({ kind: 'tool_use', toolName: 'Read', toolId: 'tool' });
  collector.send({ kind: 'tool_result', isError: true, content: 'A recoverable tool error' });
  collector.send({ kind: 'complete', exitCode: 0 });
  assert.deepEqual(collector.getAssistantMessages().map(message => message.kind), ['text', 'thinking', 'tool_use']);
  assert.equal(collector.getAssistantMessages()[0].content, 'Hello world');
  assert.equal(collector.getSessionId(), 'session');
  assert.equal(collector.getError(), null);
});

test('collector replaces a streamed block with its durable row without collapsing a different reply', () => {
  const collector = new AgentResponseCollector();
  for (const responseMessageId of ['response-a', 'response-b']) {
    collector.send({ kind: 'stream_delta', responseMessageId, contentBlockIndex: 0, content: 'Same answer' });
    collector.send({ kind: 'stream_end', responseMessageId, contentBlockIndex: 0 });
    collector.send({ kind: 'text', role: 'assistant', id: `native-${responseMessageId}`,
      responseMessageId, contentBlockIndex: 0, content: 'Same answer' });
  }
  assert.deepEqual(collector.getAssistantMessages().map(message => message.id), ['native-response-a', 'native-response-b']);
  collector.send({ kind: 'text', role: 'assistant', id: 'native-response-a',
    responseMessageId: 'response-a', contentBlockIndex: 0, content: 'Revised first answer' });
  assert.deepEqual(collector.getAssistantMessages().map(message => message.content), ['Revised first answer', 'Same answer']);
});

test('collector updates Codex progress rows in their original positions', () => {
  const collector = new AgentResponseCollector();
  const tool = { id: 'item-1', provider: 'codex', sessionId: 'session', kind: 'tool_use',
    toolId: 'item-1', toolName: 'Bash', toolInput: { command: 'fixture command' } };
  collector.send({ ...tool, status: 'in_progress' }); // item.started
  collector.send({ id: 'answer', provider: 'codex', sessionId: 'session', kind: 'text', role: 'assistant', content: 'Working' });
  collector.send({ ...tool, status: 'in_progress' }); // item.updated
  collector.send({ id: 'item-1_result', provider: 'codex', sessionId: 'session', kind: 'tool_result', toolId: 'item-1', content: 'Partial output' });
  collector.send({ ...tool, status: 'completed' }); // item.completed
  collector.send({ id: 'item-1_result', provider: 'codex', sessionId: 'session', kind: 'tool_result', toolId: 'item-1', content: 'Final output' });
  collector.send({ id: 'answer', provider: 'codex', sessionId: 'session', kind: 'text', role: 'assistant', content: 'Done' });
  assert.deepEqual(collector.getAssistantMessages().map(message => message.id), ['item-1', 'answer']);
  assert.equal(collector.getAssistantMessages()[0].status, 'completed');
  assert.equal(collector.getAssistantMessages()[1].content, 'Done');
});

test('collector scopes normalized replacements by provider, session, kind and row id', () => {
  const collector = new AgentResponseCollector();
  const thinking = { id: 'same-id', provider: 'codex', sessionId: 'session-a', kind: 'thinking', content: 'Initial' };
  collector.send(thinking);
  collector.send({ ...thinking, provider: 'claude' });
  collector.send({ ...thinking, sessionId: 'session-b' });
  collector.send({ ...thinking, kind: 'text', role: 'assistant' });
  collector.send({ ...thinking, content: 'Revised' });
  assert.equal(collector.getAssistantMessages().length, 4);
  assert.deepEqual(collector.getAssistantMessages().map(message => message.content), ['Revised', 'Initial', 'Initial', 'Initial']);
  collector.send({ kind: 'stream_delta', id: 'reused-chunk-id', content: 'Repeated ' });
  collector.send({ kind: 'stream_delta', id: 'reused-chunk-id', content: 'chunks' });
  assert.equal(collector.getAssistantMessages().at(-1)?.content, 'Repeated chunks');
});

test('collector keeps partial output when a run fails and handles cancellation and recovery', () => {
  const collector = new AgentResponseCollector();
  collector.send({ kind: 'error', content: 'Temporary failure' });
  collector.send({ kind: 'complete', exitCode: 0, success: true });
  assert.equal(collector.getError(), null);
  collector.send({ kind: 'stream_delta', content: 'Partial answer' });
  collector.send({ kind: 'error', content: 'Final failure' });
  collector.send({ kind: 'complete', exitCode: 1, success: false });
  collector.send({ kind: 'complete', exitCode: 0, success: true });
  assert.equal(collector.getError(), 'Final failure');
  assert.equal(collector.getAssistantMessages()[0].content, 'Partial answer');
  const cancelled = new AgentResponseCollector();
  cancelled.send({ kind: 'complete', exitCode: 0, aborted: true });
  assert.equal(cancelled.getError(), 'The agent run was cancelled.');
});

test('collector retains both legacy string and object assistant payloads and token fields', () => {
  const collector = new AgentResponseCollector();
  const native = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Legacy answer' }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } };
  collector.send(JSON.stringify({ type: 'claude-response', sessionId: 'legacy', data: native }));
  collector.send({ type: 'claude-response', data: { type: 'assistant', message: { content: 'Another answer' } } });
  collector.send({ type: 'claude-response', data: { type: 'result', subtype: 'success' } });
  collector.send('not json');
  assert.deepEqual(collector.getAssistantMessages()[0], native);
  assert.equal(collector.getAssistantMessages().length, 2);
  assert.equal(collector.getSessionId(), 'legacy');
  assert.deepEqual(collector.getTotalTokens(), { inputTokens: 15, outputTokens: 5,
    cacheReadTokens: 3, cacheCreationTokens: 2, totalTokens: 20 });
  assert.equal(collector.getError(), null);
  collector.send(JSON.stringify({ type: 'claude-response', data: { type: 'result', subtype: 'error_during_execution',
    is_error: true, result: 'Legacy failed' } }));
  assert.equal(collector.getError(), 'Legacy failed');
});

test('collector treats normalized usage as snapshots and excludes older Claude session consumption', () => {
  const collector = new AgentResponseCollector();
  const snapshot = { schemaVersion: 2, provider: 'claude',
    turn: { models: { model: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 } } },
    session: { tokens: { inputTokens: 9999 } } };
  collector.send({ kind: 'status', text: 'token_budget', tokenBudget: snapshot });
  collector.send({ kind: 'status', text: 'token_budget', tokenBudget: snapshot });
  assert.deepEqual(collector.getTotalTokens(), { inputTokens: 15, outputTokens: 5,
    cacheReadTokens: 3, cacheCreationTokens: 2, totalTokens: 20 });
  const codex = new AgentResponseCollector();
  codex.send({ kind: 'status', text: 'token_budget', tokenBudget: { inputTokens: 30, outputTokens: 7 } });
  codex.send({ kind: 'status', text: 'token_budget', tokenBudget: { inputTokens: 40, outputTokens: 8 } });
  assert.equal(codex.getTotalTokens().totalTokens, 48);
});

test('SSE observation retains outcome and session identity without buffering reply contents', () => {
  const collector = new AgentResponseCollector(1, false);
  collector.send({ kind: 'session_created', newSessionId: 'created' });
  collector.send({ kind: 'stream_delta', content: 'Already sent through SSE' });
  collector.send({ kind: 'complete', exitCode: 1 });
  assert.equal(collector.getSessionId(), 'created');
  assert.equal(collector.getError(), 'The agent run failed.');
  assert.deepEqual(collector.getAssistantMessages(), []);
});
