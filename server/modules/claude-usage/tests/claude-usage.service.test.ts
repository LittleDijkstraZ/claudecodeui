import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClaudeUsageService } from '@/modules/claude-usage/index.js';
import { claudeSessionActionsDb, claudeUsageDb, closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

const assistant = (id: string, cache = 100, extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { id, model: 'main-explicit', content: 'PRIVATE MUST NEVER PERSIST', usage: { input_tokens: 10, cache_read_input_tokens: cache, cache_creation_input_tokens: 5, output_tokens: 20 } }, ...extra });
const result = (uuid: string, cache = 100, cost = .2) => ({ type: 'result', uuid, modelUsage: { 'main-explicit': { inputTokens: 10, cacheReadInputTokens: cache, cacheCreationInputTokens: 5, outputTokens: 20, costUSD: cost, costBasis: 'list', contextWindow: 1_000_000 } }, total_cost_usd: cost });
async function fixture(run: (value: { make: () => ReturnType<typeof createClaudeUsageService>; history: Map<string, unknown[]>; tick: () => void; project: string }) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'usage-ledger-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'fixture.db');
  await writeFile(process.env.DATABASE_PATH, ''); await initializeDatabase();
  const project = path.join(directory, 'project');
  sessionsDb.createAppSession('app-one', 'claude', project);
  sessionsDb.assignProviderSessionId('app-one', 'native-one');
  const history = new Map<string, unknown[]>();
  let now = 1000;
  const make = () => createClaudeUsageService({ now: () => now, history: async session => {
    const events = history.get(session.provider_session_id ?? '') ?? [];
    return [{ id: `${session.provider_session_id}:main`, fingerprint: JSON.stringify(events), events: (async function* () { yield* events; })() }];
  } });
  try { await run({ make, history, project, tick: () => { now += 250; } }); } finally {
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('legacy baseline, runtime, refresh and resumed query count each request once and keep unknown historical price explicit', async () => fixture(async ({ make, history, tick }) => {
  history.set('native-one', [assistant('old'), assistant('old')]);
  const service = make();
  const initial = await service.getSnapshot('app-one');
  assert.equal(initial.session.tokens.cacheReadTokens, 100);
  assert.equal(initial.context.usedTokens, 135);
  assert.equal(initial.context.capacityTokens, null);
  assert.equal(initial.session.estimatedCostUsd, null);
  const first = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'exec-one' });
  assert.equal(first.observe(assistant('old')), null); // SDK replay of a historical prefix is not new work.
  first.observe(assistant('new', 200)); tick(); first.observe(assistant('new', 200));
  first.observe(result('result-one', 200, .4));
  first.observeContextSummary({ totalTokens: 240, model: 'main-explicit', rawMaxTokens: 200_000 });
  const ended = first.finish()!;
  history.set('native-one', [assistant('old'), assistant('new', 200)]);
  const refreshed = await service.getSnapshot('app-one');
  assert.deepEqual(refreshed.session, ended.session);
  assert.deepEqual(refreshed.context, ended.context);
  assert.equal(refreshed.session.tokens.cacheReadTokens, 300);
  assert.equal(refreshed.session.knownEstimatedCostUsd, .4);
  assert.equal(refreshed.context.capacityTokens, 1_000_000);
  assert.equal(refreshed.context.compactionWindowTokens, 200_000);
  const again = await service.getSnapshot('app-one');
  assert.deepEqual(again, refreshed);
  const resumed = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'exec-two' });
  resumed.observe(assistant('third', 300)); resumed.observe(result('result-two', 300, .6)); resumed.finish();
  assert.equal((await service.getSnapshot('app-one')).session.tokens.cacheReadTokens, 600);
  assert.equal((await service.getSnapshot('app-one')).session.knownEstimatedCostUsd, 1);
  closeConnection(); await initializeDatabase();
  assert.deepEqual((await make().getSnapshot('app-one')).session, (await service.getSnapshot('app-one')).session);
  const persisted = JSON.stringify(claudeUsageDb.executions('app-one')) + JSON.stringify(claudeUsageDb.requests('app-one'));
  assert.equal(persisted.includes('PRIVATE'), false);
}));

test('8M consumed tokens remain separate from the final main sampling window in every persisted source', async () => fixture(async ({ make }) => {
  const service = make(); const run = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'exec-one' });
  run.observe({ type: 'assistant', message: { id: 'loop', model: 'main-explicit', usage: { input_tokens: 0, cache_read_input_tokens: 8_000_000, output_tokens: 100, iterations: [
    { type: 'message', input_tokens: 0, cache_read_input_tokens: 70_000, output_tokens: 100 },
    { type: 'message', input_tokens: 0, cache_read_input_tokens: 80_000, output_tokens: 100 },
  ] } } });
  run.observe(result('huge-result', 8_000_000)); run.finish();
  const value = await service.getSnapshot('app-one');
  assert.equal(value.context.usedTokens, 80_100);
  assert.equal(value.session.tokens.cacheReadTokens, 8_000_000);
  assert.equal(value.turn?.models['main-explicit'].cacheReadTokens, 8_000_000);
}));

test('rewind preserves spent accounting and resets context to the new native prefix; forks inherit no bill', async () => fixture(async ({ make, history, project }) => {
  history.set('native-one', [assistant('old', 100), assistant('tail', 200)]);
  const service = make(); const before = await service.getSnapshot('app-one');
  const child = claudeSessionActionsDb.createBranch('app-one', 'native-child', path.join(project, 'child.jsonl'), 'Branch', 'boundary');
  history.set('native-child', [assistant('old', 100)]);
  await service.inheritContext('app-one', child);
  const forked = await service.getSnapshot(child);
  assert.equal(forked.context.usedTokens, 135);
  assert.equal(forked.session.tokens.cacheReadTokens, 0);
  assert.equal(forked.session.historicalCoverage, 'inherited-context');
  const backup = claudeSessionActionsDb.replaceContext('app-one', 'native-one', 'native-rewound', path.join(project, 'rewound.jsonl'), 'boundary');
  history.set('native-rewound', [assistant('old', 100)]);
  await service.inheritContext('app-one', backup);
  const rewound = await service.getSnapshot('app-one');
  assert.equal(rewound.nativeContextId, 'native-rewound');
  assert.equal(rewound.context.usedTokens, 135);
  assert.deepEqual(rewound.session.tokens, before.session.tokens);
  assert.ok(rewound.revision > before.revision);
}));

test('compaction/clear and errors never erase recorded spend; interrupted process is recovered after restart', async () => fixture(async ({ make, tick }) => {
  const service = make(); const run = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'exec-one' });
  run.observe(assistant('a')); run.observe(result('r1')); tick();
  run.observe({ type: 'system', subtype: 'compact_boundary', compact_metadata: { post_tokens: 70 } });
  assert.equal((await service.getSnapshot('app-one')).context.usedTokens, 70);
  run.observe({ type: 'conversation_reset' });
  assert.equal((await service.getSnapshot('app-one')).session.tokens.cacheReadTokens, 100);
  assert.equal((await service.getSnapshot('app-one')).context.usedTokens, null);
  tick(); run.observe(assistant('b', 200));
  const crashed = await make().getSnapshot('app-one');
  assert.equal(crashed.session.tokens.cacheReadTokens, 300);
  assert.equal(crashed.turn?.status, 'interrupted');
  assert.equal(crashed.session.estimatedCostUsd, null);
}));

test('late superseded execution can retain its cost but cannot replace a newer session context', async () => fixture(async ({ make, tick, project }) => {
  const service = make(); const old = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'exec-old' });
  old.observe(assistant('old', 100));
  const newer = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'exec-new' });
  tick(); newer.observe(assistant('new', 200)); newer.observe(result('new-result', 200));
  tick(); old.observe(assistant('old-tail', 999)); old.observe(result('old-result', 999)); old.finish();
  const value = await service.getSnapshot('app-one');
  assert.equal(value.context.usedTokens, 235);
  assert.equal(value.turn?.executionId, 'exec-new');
  sessionsDb.createAppSession('app-other', 'claude', project); sessionsDb.assignProviderSessionId('app-other', 'native-other');
  assert.equal((await service.getSnapshot('app-other')).session.tokens.cacheReadTokens, 0);
  newer.finish();
}));

test('a new session binds its native identity once and rejects a conflicting provider identity', async () => fixture(async ({ make, project }) => {
  sessionsDb.createAppSession('app-new', 'claude', project);
  const service = make(); const run = await service.beginRun({ sessionId: 'app-new', providerSessionId: null, executionId: 'exec-new' });
  sessionsDb.assignProviderSessionId('app-new', 'native-new'); run.bindProviderSessionId('native-new');
  run.bindProviderSessionId('native-new');
  assert.throws(() => run.bindProviderSessionId('native-other'), /conflicting/);
  run.observe(assistant('new')); run.observe(result('new-result')); run.finish();
  assert.equal((await service.getSnapshot('app-new')).nativeContextId, 'native-new');
  assert.deepEqual(getConnection().pragma('foreign_key_check'), []);
}));

test('SDK pipeline totals cover unforwarded subagent requests discovered only after completion', async () => fixture(async ({ make, history, tick }) => {
  const service = make(); const run = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'exec-one' });
  run.observe(assistant('main')); tick();
  const child = { ...assistant('hidden-child', 500, { parent_tool_use_id: 'agent-tool', timestamp: new Date(1250).toISOString() }), message: { id: 'hidden-child', model: 'child-explicit', usage: { input_tokens: 5, cache_read_input_tokens: 500, output_tokens: 50 } } };
  tick();
  const settled = result('settled');
  run.observe({ ...settled, modelUsage: { ...settled.modelUsage, 'child-explicit': { inputTokens: 5, cacheReadInputTokens: 500, outputTokens: 50, costUSD: .1 } }, total_cost_usd: .3 });
  run.observeContextSummary({ totalTokens: 240, model: 'main-explicit', rawMaxTokens: 200_000 });
  const ended = run.finish()!;
  history.set('native-one', [assistant('main'), child, child]);
  const refreshed = await service.getSnapshot('app-one');
  assert.deepEqual(refreshed.session.tokens, ended.session.tokens);
  assert.equal(refreshed.session.tokens.cacheReadTokens, 600);
  assert.equal(refreshed.session.models['child-explicit'].outputTokens, 50);
  assert.equal(refreshed.session.estimatedCostUsd, .3); // absent costBasis follows documented list pricing.
  assert.equal(claudeUsageDb.requests('app-one').find(row => row.request_id === 'hidden-child')?.kind, 'managed');
  assert.equal(refreshed.context.usedTokens, 240);
}));

test('missing-time history that may overlap a settled run is explicitly partial instead of charging twice', async () => fixture(async ({ make, history, tick }) => {
  const service = make(); const run = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'exec-one' });
  run.observe(assistant('main')); tick(); run.observe(result('settled', 600)); run.finish();
  history.set('native-one', [assistant('main'), assistant('unknown-child', 500, { parent_tool_use_id: 'child' })]);
  const value = await service.getSnapshot('app-one');
  assert.equal(value.session.tokens.cacheReadTokens, 600);
  assert.ok(value.session.warnings.includes('history-request-may-overlap-settled-query'));
  assert.equal(value.session.estimatedCostUsd, null);
  // A later timestamped external CLI call lies outside the settled query span and is added once.
  history.set('native-one', [assistant('main'), assistant('unknown-child', 500, { parent_tool_use_id: 'child' }), assistant('external-later', 700, { timestamp: new Date(3000).toISOString() })]);
  assert.equal((await service.getSnapshot('app-one')).session.tokens.cacheReadTokens, 1300);
}));

test('unavailable historical transcript preserves usable ledger values and does not claim known zero historical spend', async () => fixture(async () => {
  const service = createClaudeUsageService({ history: async () => { throw new Error('Fixture read denied'); } });
  const value = await service.getSnapshot('app-one');
  assert.equal(value.context.usedTokens, null);
  assert.equal(value.session.estimatedCostUsd, null);
  assert.equal(value.session.historicalCoverage, 'observed-requests');
  assert.ok(value.session.warnings.includes('historical-usage-unavailable'));
  assert.deepEqual(await service.getSnapshot('app-one'), value);
}));

test('one user turn includes every Workflow result in the same execution; the next send starts a fresh turn', async () => fixture(async ({ make, tick }) => {
  const service = make(); const run = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'workflow-execution' });
  run.observe(assistant('first', 100)); run.observe(result('first-result', 100)); tick();
  run.observe(assistant('followup', 200)); run.observe(result('second-result', 300, .6));
  const inProgress = await service.getSnapshot('app-one');
  assert.equal(inProgress.turn?.models['main-explicit'].cacheReadTokens, 300);
  assert.equal(inProgress.turn?.status, 'running');
  assert.equal(inProgress.turn?.estimatedCostUsd, .6);
  run.finish();
  assert.equal((await service.getSnapshot('app-one')).turn?.status, 'complete');
  const next = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'next-send' });
  next.observe(assistant('next', 50)); next.observe(result('third-result', 50, .1)); next.finish();
  const ended = await service.getSnapshot('app-one');
  assert.equal(ended.turn?.models['main-explicit'].cacheReadTokens, 50);
  assert.equal(ended.session.tokens.cacheReadTokens, 350);
}));

test('actual temporary JSONL scans recover an old rewind tail and duplicate child logs without changing current context', async () => fixture(async ({ project }) => {
  await mkdir(project, { recursive: true });
  const originalPath = path.join(project, 'native-one.jsonl');
  const currentPath = path.join(project, 'native-rewound.jsonl');
  const childDirectory = path.join(project, 'native-one', 'subagents');
  await mkdir(childDirectory, { recursive: true });
  const child = assistant('child', 300, { isSidechain: true });
  const rows = [assistant('head', 100), assistant('tail', 200), child];
  await writeFile(originalPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(currentPath, JSON.stringify(assistant('head', 100)) + '\n');
  await writeFile(path.join(childDirectory, 'agent-child.jsonl'), JSON.stringify(child) + '\n');
  const nested = path.join(childDirectory, 'workflow', 'nested');
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, 'agent-child.jsonl'), JSON.stringify(assistant('nested-child', 400)) + '\n');
  getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run(originalPath, 'app-one');
  claudeSessionActionsDb.replaceContext('app-one', 'native-one', 'native-rewound', currentPath, 'boundary');
  const service = createClaudeUsageService();
  const value = await service.getSnapshot('app-one');
  assert.equal(value.context.usedTokens, 135);
  assert.equal(value.session.tokens.cacheReadTokens, 1000);
  assert.equal(claudeUsageDb.requests('app-one').length, 4);
  assert.deepEqual(await service.getSnapshot('app-one'), value);
}));

test('forking an active saved prefix flushes throttled request ownership before inheritance', async () => fixture(async ({ make, history, project }) => {
  const service = make();
  const run = await service.beginRun({ sessionId: 'app-one', providerSessionId: 'native-one', executionId: 'active-parent' });
  run.observe(assistant('already-persisted', 100));
  // Same clock: this request is observed but still inside the 200ms disk throttle.
  assert.equal(run.observe(assistant('throttled-prefix', 200)), null);
  assert.equal(claudeUsageDb.requests('app-one').length, 1);
  const child = claudeSessionActionsDb.createBranch('app-one', 'forked-native', path.join(project, 'fork.jsonl'), 'Side chat', 'boundary');
  history.set('forked-native', [assistant('already-persisted', 100), assistant('throttled-prefix', 200)]);
  await service.inheritContext('app-one', child);
  assert.equal(claudeUsageDb.requests('app-one').length, 2);
  const value = await service.getSnapshot(child);
  assert.equal(value.context.usedTokens, 235);
  assert.equal(value.session.tokens.cacheReadTokens, 0);
  assert.equal(claudeUsageDb.requests(child).every(row => row.kind === 'inherited'), true);
  assert.equal((await service.getSnapshot('app-one')).session.tokens.cacheReadTokens, 300);
  run.finish();
}));
