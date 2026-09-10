import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProviderModelsDefinition } from '@/shared/index.js';

import { createClaudeModelCatalog, rememberClaudeSupportedModels } from '../list/claude/claude-model-catalog.js';
import { readClaudeReportedModel } from '../list/claude/claude-models.provider.js';
import { resolveClaudeExecutionSettings } from '../services/claude-execution-settings.js';

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
  const contextVariant = result.OPTIONS.find((model) => model.value === 'claude-opus-exact-test[1m]');
  assert.equal(contextVariant?.contextMode, '1m');
  assert.equal(contextVariant?.maxInputTokens, 1000000);
  assert.deepEqual(contextVariant?.effort, exact?.effort);
  assert.equal(result.OPTIONS.some(model => model.value === 'claude-other-exact-test[1m]'), false);
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

test('explicit API and SDK effort refusals remain distinct from absent metadata', async () => {
  const readCatalog = createClaudeModelCatalog({ env: { ANTHROPIC_API_KEY: 'fixture-only' }, readSettings: async () => ({}), fetch: (async () => new Response(JSON.stringify({ data: [
    { id: 'api-unknown' },
    { id: 'api-no-effort', capabilities: { effort: { supported: false } } },
    { id: 'api-no-levels', capabilities: { effort: { high: { supported: false }, xhigh: { supported: false } } } },
    { id: 'sdk-denied', capabilities: { effort: { xhigh: { supported: true } } } },
  ] }))) as typeof fetch });
  rememberClaudeSupportedModels([
    { value: 'sdk-denied', displayName: 'Fixture', description: '', supportsEffort: false },
    { value: 'sdk-empty', displayName: 'Fixture', description: '', supportedEffortLevels: [] },
    { value: 'sdk-unknown', displayName: 'Fixture', description: '' },
  ]);
  try {
    const catalog = await readCatalog(aliases);
    for (const model of ['api-no-effort', 'api-no-levels', 'sdk-denied', 'sdk-empty']) {
      assert.deepEqual(catalog.OPTIONS.find(option => option.value === model)?.effort?.values, []);
      assert.throws(() => resolveClaudeExecutionSettings({ model, effort: 'ultracode' }, catalog), /not reported support/);
    }
    for (const model of ['api-unknown', 'sdk-unknown']) {
      assert.equal(catalog.OPTIONS.find(option => option.value === model)?.effort, undefined);
      assert.equal(resolveClaudeExecutionSettings({ model, effort: 'ultracode' }, catalog).ultracode, true);
    }
  } finally { rememberClaudeSupportedModels([]); }
});

test('cold API capacity evidence supplies the exact 1M variant and preserves confirmed Ultracode', async () => {
  const readCatalog = createClaudeModelCatalog({ env: { ANTHROPIC_API_KEY: 'fixture-only' }, readSettings: async () => ({}), fetch: (async () => new Response(JSON.stringify({ data: [
    { id: 'claude-fixture-exact', max_input_tokens: 1000000, capabilities: { effort: { high: { supported: true }, xhigh: { supported: true } } } },
    { id: 'claude-fixture-small', max_input_tokens: 200000 },
    { id: 'custom-deployment', max_input_tokens: 1000000 },
  ] }))) as typeof fetch });
  const catalog = await readCatalog(aliases);
  const selection = { model: 'claude-fixture-exact[1m]', effort: 'ultracode' };
  assert.deepEqual(catalog.OPTIONS.find(option => option.value === selection.model)?.effort?.values.map(option => option.value), ['high', 'xhigh', 'ultracode']);
  assert.equal(resolveClaudeExecutionSettings(selection, catalog).ultracode, true);
  assert.equal(catalog.OPTIONS.some(option => option.value === 'claude-fixture-small[1m]'), false);
  assert.equal(catalog.OPTIONS.some(option => option.value === 'custom-deployment[1m]'), false);
  rememberClaudeSupportedModels([{ value: selection.model, displayName: 'Fixture', description: '', supportsEffort: false }]);
  try {
    const sdkCatalog = await readCatalog(aliases);
    assert.throws(() => resolveClaudeExecutionSettings(selection, sdkCatalog), /not reported support/);
  } finally { rememberClaudeSupportedModels([]); }
});

test('a previously reported exact context variant survives loss of SDK metadata without inventing menu entries', async () => {
  const readCatalog = createClaudeModelCatalog({ env: {}, readSettings: async () => ({}) });
  const selection = { model: 'claude-fixture-exact[1m]', effort: 'ultracode' };
  rememberClaudeSupportedModels([{ value: 'opus[1m]', resolvedModel: 'claude-fixture-exact', displayName: 'Fixture', description: '', supportedEffortLevels: ['xhigh'] }]);
  try {
    const warm = resolveClaudeExecutionSettings(selection, await readCatalog(aliases));
    rememberClaudeSupportedModels([]);
    const coldCatalog = await readCatalog(aliases);
    assert.equal(coldCatalog.OPTIONS.some(option => option.value === selection.model), false);
    assert.deepEqual(resolveClaudeExecutionSettings(selection, coldCatalog), warm);
  } finally { rememberClaudeSupportedModels([]); }
});

test('SDK alias resolution without effort fields cannot widen exact API capabilities', async () => {
  const predefined: ProviderModelsDefinition = { DEFAULT: 'default', OPTIONS: [
    { value: 'opus', label: 'Opus', effort: { values: [{ value: 'high' }, { value: 'xhigh' }, { value: 'ultracode' }] } },
  ] };
  for (const effort of [{ supported: false }, { high: { supported: true } }]) {
    const readCatalog = createClaudeModelCatalog({ env: { ANTHROPIC_API_KEY: 'fixture-only' }, readSettings: async () => ({}), fetch: (async () => new Response(JSON.stringify({ data: [
      { id: 'claude-fixture-exact', capabilities: { effort } },
    ] }))) as typeof fetch });
    rememberClaudeSupportedModels([{ value: 'opus', resolvedModel: 'claude-fixture-exact', displayName: 'Fixture', description: '' }]);
    try {
      const catalog = await readCatalog(predefined);
      for (const model of ['opus', 'claude-fixture-exact', 'claude-fixture-exact[1m]']) {
        assert.throws(() => resolveClaudeExecutionSettings({ model, effort: 'ultracode' }, catalog), /not reported support/);
      }
    } finally { rememberClaudeSupportedModels([]); }
  }
});

test('capacity variants inherit final base capabilities unless the variant reports its own levels', async () => {
  const readCatalog = createClaudeModelCatalog({ env: { ANTHROPIC_API_KEY: 'fixture-only' }, readSettings: async () => ({}), fetch: (async () => new Response(JSON.stringify({ data: [
    { id: 'claude-fixture-exact', max_input_tokens: 1000000, capabilities: { effort: { xhigh: { supported: true } } } },
  ] }))) as typeof fetch });
  const selection = { model: 'claude-fixture-exact[1m]', effort: 'ultracode' };
  const base = { value: 'claude-fixture-exact', displayName: 'Fixture', description: '', supportsEffort: false };
  const variant = { value: selection.model, displayName: 'Fixture', description: '' };
  try {
    for (const reported of [[base], [base, variant], [variant, base]]) {
      rememberClaudeSupportedModels(reported);
      const catalog = await readCatalog(aliases);
      assert.deepEqual(catalog.OPTIONS.find(option => option.value === selection.model)?.effort?.values, []);
      assert.throws(() => resolveClaudeExecutionSettings(selection, catalog), /not reported support/);
    }
    rememberClaudeSupportedModels([base, { ...variant, supportedEffortLevels: ['xhigh'] }]);
    assert.equal(resolveClaudeExecutionSettings(selection, await readCatalog(aliases)).ultracode, true);
  } finally { rememberClaudeSupportedModels([]); }
});

test('a metadata-only alias context variant inherits its resolved exact model refusal', async () => {
  const predefined: ProviderModelsDefinition = { DEFAULT: 'default', OPTIONS: ['opus', 'opus[1m]'].map(value => ({
    value, label: 'Opus', effort: { values: [{ value: 'high' }, { value: 'xhigh' }, { value: 'ultracode' }] },
  })) };
  const readCatalog = createClaudeModelCatalog({ env: { ANTHROPIC_API_KEY: 'fixture-only' }, readSettings: async () => ({}), fetch: (async () => new Response(JSON.stringify({ data: [
    { id: 'claude-fixture-exact', max_input_tokens: 1000000, capabilities: { effort: { supported: false } } },
  ] }))) as typeof fetch });
  rememberClaudeSupportedModels([{ value: 'opus[1m]', resolvedModel: 'claude-fixture-exact', displayName: 'Fixture', description: '' }]);
  try {
    const catalog = await readCatalog(predefined);
    for (const model of ['opus[1m]', 'claude-fixture-exact', 'claude-fixture-exact[1m]']) {
      assert.throws(() => resolveClaudeExecutionSettings({ model, effort: 'ultracode' }, catalog), /not reported support/);
    }
  } finally { rememberClaudeSupportedModels([]); }
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
