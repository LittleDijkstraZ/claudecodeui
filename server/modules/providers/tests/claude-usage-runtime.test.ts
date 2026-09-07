import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Query, query } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { createClaudeUsageService } from '@/modules/claude-usage/index.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import type { AnyRecord, ClaudeUsageSnapshot, ProviderRuntimeContext } from '@/shared/index.js';

test('runtime uses only its existing query summary and publishes the exact durable REST snapshot for the same execution', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'usage-runtime-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'fixture.db');
  await writeFile(process.env.DATABASE_PATH, ''); await initializeDatabase();
  sessionsDb.createAppSession('usage-app', 'claude', directory);
  sessionsDb.assignProviderSessionId('usage-app', 'usage-native');
  try {
    const usage = createClaudeUsageService({ history: async () => [{ id: 'usage-native:main', fingerprint: 'empty', events: (async function* () {})() }] });
    let queries = 0; let summaries = 0;
    const frames: AnyRecord[] = [];
    const queryMock = (() => {
      queries++;
      return Object.assign((async function* () {
        yield { type: 'assistant', session_id: 'usage-native', message: { id: 'api-request', model: 'actual-explicit', usage: { input_tokens: 10, cache_read_input_tokens: 8_000_000, output_tokens: 100,
          iterations: [{ type: 'message', input_tokens: 10, cache_read_input_tokens: 80_000, output_tokens: 100 }] }, content: [] } };
        yield { type: 'result', uuid: 'usage-result', session_id: 'usage-native', is_error: false, modelUsage: { 'actual-explicit': { inputTokens: 10, cacheReadInputTokens: 8_000_000, outputTokens: 100, costUSD: 2, contextWindow: 1_000_000 } }, total_cost_usd: 2 };
      })(), {
        interrupt: async () => {},
        getContextUsage: async (options: unknown) => { summaries++; assert.deepEqual(options, { detail: 'summary' }); return { totalTokens: 81_000, rawMaxTokens: 200_000, model: 'actual-explicit' }; },
        getUsage: () => assert.fail('Account-wide usage must never be queried'),
      }) as unknown as Query;
    }) as typeof query;
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => 'usage-native', resolveResumeModel: async () => 'fixture',
      getProviderModels: async () => ({ DEFAULT: 'fixture', OPTIONS: [{ value: 'fixture', label: 'Fixture' }] }),
      normalizeMessage: () => [], isProviderInstalled: async () => true,
    };
    await createClaudeRuntime({ query: queryMock, loadMcpConfig: async () => null, usage }).run('Fixture only', { sessionId: 'usage-app', executionId: 'shared-execution' }, { send: frame => frames.push(frame as AnyRecord) }, context);
    assert.equal(queries, 1); assert.equal(summaries, 1);
    const emitted = frames.filter(frame => frame.kind === 'status' && frame.text === 'token_budget').map(frame => frame.tokenBudget as ClaudeUsageSnapshot);
    assert.ok(emitted.length >= 3);
    const persisted = await usage.getSnapshot('usage-app');
    assert.deepEqual(emitted.at(-1), persisted);
    assert.equal(persisted.context.usedTokens, 81_000);
    assert.equal(persisted.context.capacityTokens, 1_000_000);
    assert.equal(persisted.context.compactionWindowTokens, 200_000);
    assert.equal(persisted.session.tokens.cacheReadTokens, 8_000_000);
    assert.equal(persisted.turn?.executionId, 'shared-execution');
    assert.equal(persisted.turn?.status, 'complete');
    for (const frame of emitted) assert.equal(frame.sessionId, 'usage-app');
  } finally {
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
