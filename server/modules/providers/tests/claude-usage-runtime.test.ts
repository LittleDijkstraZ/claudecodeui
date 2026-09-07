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

test('a slow context metadata reply cannot block live text or overwrite newer sampling inside the persistence throttle', { timeout: 5000 }, async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'usage-runtime-late-summary-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'fixture.db');
  await writeFile(process.env.DATABASE_PATH, ''); await initializeDatabase();
  sessionsDb.createAppSession('late-summary-app', 'claude', directory);
  sessionsDb.assignProviderSessionId('late-summary-app', 'late-summary-native');
  let releaseSummary!: (value: unknown) => void;
  const slowSummary = new Promise(resolve => { releaseSummary = resolve; });
  let releaseScript!: () => void;
  const scriptHeld = new Promise<void>(resolve => { releaseScript = resolve; });
  let sawFollowingText!: () => void;
  const followingText = new Promise<void>(resolve => { sawFollowingText = resolve; });
  let run: Promise<unknown> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // All observations happen at the same clock tick: the newer sampling stays
    // in memory until finalization and does not advance the durable revision.
    const usage = createClaudeUsageService({ now: () => 1000,
      history: async () => [{ id: 'late-summary-native:main', fingerprint: 'empty', events: (async function* () {})() }] });
    const frames: AnyRecord[] = [];
    let summaries = 0;
    const assistant = (id: string, input: number) => ({ type: 'assistant', session_id: 'late-summary-native',
      message: { id, model: 'fixture', usage: { input_tokens: input, output_tokens: 5 }, content: [] } });
    const result = (id: string) => ({ type: 'result', uuid: id, session_id: 'late-summary-native', is_error: false });
    const queryMock = (() => Object.assign((async function* () {
      yield assistant('sampling-before', 100);
      yield result('result-before');
      assert.equal(summaries, 1);
      yield assistant('sampling-after', 200);
      yield { type: 'stream_event', session_id: 'late-summary-native', event: { type: 'message_start', message: { id: 'live-text' } } };
      yield { type: 'stream_event', session_id: 'late-summary-native', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
      yield { type: 'stream_event', session_id: 'late-summary-native', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Already streaming' } } };
      sawFollowingText();
      await scriptHeld;
      yield result('result-after');
    })(), { interrupt: async () => {}, getContextUsage: () => ++summaries === 1 ? slowSummary : Promise.resolve(null) })) as unknown as typeof query;
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => 'late-summary-native', resolveResumeModel: async () => 'fixture',
      getProviderModels: async () => ({ DEFAULT: 'fixture', OPTIONS: [{ value: 'fixture', label: 'Fixture' }] }),
      normalizeMessage: (raw, sessionId) => {
        const value = raw as AnyRecord;
        return value.type === 'content_block_delta' ? [{ id: 'live-delta', kind: 'stream_delta', provider: 'claude', sessionId: sessionId!, timestamp: '2026-09-07T00:00:00Z', content: value.delta.text }] : [];
      }, isProviderInstalled: async () => true,
    };
    run = createClaudeRuntime({ query: queryMock, loadMcpConfig: async () => null, usage }).run('Fixture only',
      { sessionId: 'late-summary-app' }, { send: frame => frames.push(frame as AnyRecord) }, context);
    await Promise.race([followingText, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Optional metadata blocked the native text stream')), 500); })]);
    if (deadline) clearTimeout(deadline);
    assert.ok(frames.some(frame => frame.kind === 'stream_delta' && frame.content === 'Already streaming'));
    // Return the old estimate after a newer sampling event but before its DB flush.
    releaseSummary({ totalTokens: 777777, rawMaxTokens: 1_000_000, model: 'fixture' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(frames.some(frame => frame.tokenBudget?.context?.usedTokens === 777777), false);
    releaseScript(); await run;
    const persisted = await usage.getSnapshot('late-summary-app');
    assert.equal(persisted.context.usedTokens, 205);
    assert.equal(persisted.context.measurement, 'last-request');
  } finally {
    if (deadline) clearTimeout(deadline);
    releaseSummary(null); releaseScript(); await run?.catch(() => {});
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
