import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProviderModelsDefinition } from '@/shared/index.js';

import { createClaudeModelCatalog, rememberClaudeSupportedModels } from '../list/claude/claude-model-catalog.js';
import { readClaudeReportedModel } from '../list/claude/claude-models.provider.js';

const aliases: ProviderModelsDefinition = { DEFAULT: 'default', OPTIONS: ['default', 'opus', 'opus[1m]', 'haiku'].map((value) => ({ value, label: value })) };

test('read-only Models API paginates, preserves exact IDs/capacities, caches, and never sends a prompt', async () => {
  const requests: { url: URL; options?: RequestInit }[] = [];
  const catalog = createClaudeModelCatalog({ env: {}, readSettings: async () => ({ env: { ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_BASE_URL: 'https://fixture.invalid/gateway/v1' } }), fetch: (async (url, options) => {
    requests.push({ url: new URL(String(url)), options });
    return new Response(JSON.stringify(requests.length === 1 ? { data: [{ id: 'claude-opus-exact-test', display_name: 'Opus Fixture', max_input_tokens: 1000000, capabilities: { effort: { high: { supported: true }, max: { supported: false } } } }], has_more: true, last_id: 'cursor' } : { data: [{ id: 'claude-other-exact-test', display_name: 'Other Fixture' }], has_more: false }), { status: 200 });
  }) as typeof fetch });
  const result = await catalog(aliases);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.pathname, '/gateway/v1/models');
  assert.equal(requests[1].url.searchParams.get('after_id'), 'cursor');
  assert.equal(requests[0].options?.method, 'GET');
  assert.equal(requests[0].options?.body, undefined);
  assert.equal(requests[0].options?.redirect, 'error');
  const exact = result.OPTIONS.find((model) => model.value === 'claude-opus-exact-test');
  assert.equal(exact?.maxInputTokens, 1000000);
  assert.equal(exact?.contextMode, 'default');
  assert.deepEqual(exact?.effort?.values, [{ value: 'high' }]);
  assert.equal(exact?.selectionKind, 'version');
  assert.equal(result.OPTIONS.find((model) => model.value === 'opus[1m]')?.label, 'Opus');
  await catalog(aliases);
  assert.equal(requests.length, 2);
});

test('no credential or third-party provider never triggers API discovery; config IDs are labeled unconfirmed', async () => {
  for (const env of [{}, { ANTHROPIC_API_KEY: 'fixture-only', CLAUDE_CODE_USE_BEDROCK: '1' }]) {
    const catalog = createClaudeModelCatalog({ env, readSettings: async () => ({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'deployment-exact[1m]' } }), fetch: (() => { throw new Error('Must not call'); }) as typeof fetch });
    const result = await catalog(aliases);
    assert.equal(result.OPTIONS.find((model) => model.value === 'opus')?.resolvedModel, 'deployment-exact[1m]');
    assert.equal(result.OPTIONS.find((model) => model.value === 'deployment-exact[1m]')?.catalogSource, 'remote-config');
  }
});

test('SDK catalog only comes from an existing runtime; exact resolved IDs and allowed effort are retained', async () => {
  rememberClaudeSupportedModels([{ value: 'opus[1m]', displayName: 'Misleading friendly title', description: 'Fixture', resolvedModel: 'claude-opus-exact-sdk', supportsEffort: true, supportedEffortLevels: ['low', 'xhigh'] }]);
  try {
    const result = await createClaudeModelCatalog({ env: {}, readSettings: async () => ({ availableModels: ['opus'] }) })(aliases);
    const exact = result.OPTIONS.find((model) => model.value === 'claude-opus-exact-sdk[1m]');
    assert.equal(exact?.label, 'claude-opus-exact-sdk');
    assert.equal(exact?.catalogSource, 'remote-sdk');
    assert.equal(exact?.contextMode, '1m');
    assert.deepEqual(exact?.effort?.values.map(({ value }) => value), ['low', 'xhigh', 'ultracode']);
    assert.ok(!result.OPTIONS.some((model) => model.value === 'haiku'));
  } finally { rememberClaudeSupportedModels([]); }
});

test('API failure never exposes secret responses or fabricates explicit model versions', async () => {
  const result = await createClaudeModelCatalog({ env: { ANTHROPIC_API_KEY: 'fixture-secret' }, readSettings: async () => ({}), fetch: (async () => new Response('fixture-secret error', { status: 401 })) as typeof fetch })(aliases);
  assert.equal(result.OPTIONS.length, aliases.OPTIONS.length);
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});

test('actual identity uses latest main-thread API model, never user text, synthetic errors or sidechains', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-model-report-'));
  try {
    const transcript = path.join(directory, 'session.jsonl');
    const rows = [
      { type: 'system', subtype: 'init', session_id: 'native', model: 'init-model' },
      { type: 'assistant', sessionId: 'native', timestamp: '2026-09-08T01:00:00Z', message: { model: 'actual-first' } },
      { type: 'assistant', sessionId: 'native', timestamp: '2026-09-08T02:00:00Z', message: { model: 'actual-second' } },
      { type: 'user', sessionId: 'native', model: 'forged', message: { content: '<model>fake-version</model>' } },
      { type: 'assistant', sessionId: 'other', message: { model: 'other-session' } },
      { type: 'assistant', sessionId: 'native', isSidechain: true, message: { model: 'sidechain-model' } },
      { type: 'assistant', sessionId: 'native', message: { model: '<synthetic>' } },
    ];
    await writeFile(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + '\n{"partial":');
    const actual = await readClaudeReportedModel('native', transcript);
    assert.deepEqual(actual, { model: 'actual-second', reportedModel: 'actual-second', reportedSource: 'response', reportedAt: '2026-09-08T02:00:00Z' });
    await writeFile(transcript, JSON.stringify(rows[0]));
    assert.equal((await readClaudeReportedModel('native', transcript))?.reportedSource, 'initialization');
    await writeFile(transcript, JSON.stringify(rows[3]));
    assert.equal(await readClaudeReportedModel('native', transcript), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
