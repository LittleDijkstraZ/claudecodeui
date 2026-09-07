import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeSettingsFlags, resolveClaudeExecutionSettings } from '@/modules/providers/services/claude-execution-settings.js';
import { shellConfigurationObservation } from '@/modules/providers/services/claude-shell-observer.js';
import { claudeSessionConfiguration } from '@/modules/providers/services/claude-session-configuration.service.js';
import { claudeExecutionRecords } from '@/modules/providers/services/claude-execution-records.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createClaudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { Query, query } from '@anthropic-ai/claude-agent-sdk';
import type { AnyRecord, ProviderModelsDefinition, ProviderRuntimeContext } from '@/shared/types.js';

const catalog: ProviderModelsDefinition = { DEFAULT: 'default', OPTIONS: [
  { value: 'default', label: 'Default', effort: { values: [{ value: 'high' }] } },
  { value: 'fixture-exact', label: 'Fixture', effort: { values: ['high', 'xhigh', 'ultracode'].map((value) => ({ value })) } },
  { value: 'limited', label: 'Limited' },
] };

test('one canonical selection separates Ultracode from effort and refuses unsupported requests', () => {
  const selected = resolveClaudeExecutionSettings({ model: 'fixture-exact', effort: 'ultracode' }, catalog);
  assert.equal(selected.effort, 'xhigh');
  assert.equal(selected.ultracode, true);
  assert.deepEqual(claudeSettingsFlags(selected), { effort: 'xhigh', settings: { ultracode: true, enableWorkflows: true } });
  assert.throws(() => resolveClaudeExecutionSettings({ model: 'limited', effort: 'high' }, catalog), /not reported support/);
  assert.throws(() => resolveClaudeExecutionSettings({ model: 'fixture-exact; touch /tmp/no', effort: 'default' }, catalog), /Invalid/);
  assert.throws(() => resolveClaudeExecutionSettings({ effort: 'invented' }, catalog), /Invalid/);
});

test('Shell observations exclude sidechains, never infer Ultracode, and retain real downgrade evidence', () => {
  assert.equal(shellConfigurationObservation({ agent_id: 'child', model: 'other' }), null);
  assert.equal(shellConfigurationObservation({ hook_event_name: 'Stop', effort: { level: 'xhigh' } })?.ultracode, undefined);
  assert.equal(shellConfigurationObservation({ hook_event_name: 'Stop', effort: { level: 'high' } })?.effort, 'high');
  assert.equal(shellConfigurationObservation({ hook_event_name: 'PostModelSwitch', requested_model: 'opus', to_model: 'explicit-response' })?.model, 'explicit-response');
});

test('Chat/Shell share selected settings while execution evidence stays frozen and bound to native identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-settings-fixture-'));
  const previousPath = process.env.DATABASE_PATH;
  const previousCli = process.env.CLAUDE_CLI_PATH;
  const previousCatalog = providerModelsService.getProviderModels;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'fixture.db');
  process.env.CLAUDE_CLI_PATH = '/fixture/remote-claude';
  await writeFile(process.env.DATABASE_PATH, '');
  providerModelsService.getProviderModels = async () => catalog;
  const project = path.join(directory, 'project');
  try {
    await initializeDatabase();
    sessionsDb.createSession('native-fixture', 'claude', project);
    getConnection().prepare('UPDATE sessions SET session_id = ? WHERE session_id = ?').run('app-fixture', 'native-fixture');
    sessionsDb.setSessionModel('app-fixture', 'fixture-exact');
    sessionsDb.setSessionEffort('app-fixture', 'ultracode');
    const launch = await claudeSessionConfiguration.prepareShell('app-fixture', 'claude', project);
    assert.equal(launch.executable, '/fixture/remote-claude');
    assert.deepEqual(launch.args.slice(0, 6), ['--resume', 'native-fixture', '--model', 'fixture-exact', '--effort', 'xhigh']);
    assert.equal(launch.args.includes('||'), false);
    const inlineSettings = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]);
    assert.equal(inlineSettings.enableWorkflows, true);
    assert.equal(inlineSettings.ultracode, true);
    claudeExecutionRecords.begin(launch.record);
    claudeExecutionRecords.observe(launch.record.executionId, { model: 'actual-fixture', effort: 'high', source: 'chat-hook' });
    assert.throws(() => claudeExecutionRecords.bind(launch.record.executionId, 'another-native'), /different session/);
    const initial = await claudeSessionConfiguration.read('app-fixture');
    const updated = await claudeSessionConfiguration.update('app-fixture', { ...initial.next, effort: 'high', ultracode: false });
    assert.equal(updated.next.effort, 'high');
    assert.equal(updated.execution?.requested.effort, 'xhigh');
    assert.equal(updated.execution?.observed.model, 'actual-fixture');
    assert.equal(updated.execution?.observed.ultracode, undefined);
    await assert.rejects(claudeSessionConfiguration.update('app-fixture', initial.next), /selection changed/);
    await assert.rejects(claudeSessionConfiguration.prepareShell('app-fixture', 'codex', project), /provider mismatch/);
    await assert.rejects(claudeSessionConfiguration.prepareShell('app-fixture', 'claude', `${project}-other`), /folder/);
    sessionsDb.createAppSession('draft-fixture', 'claude', project);
    await assert.rejects(claudeSessionConfiguration.prepareShell('draft-fixture', 'claude', project), /first message/);
    const concurrentBase = (await claudeSessionConfiguration.read('app-fixture')).next;
    const mutations = await Promise.allSettled([
      claudeSessionConfiguration.update('app-fixture', { ...concurrentBase, effort: 'xhigh', ultracode: false }),
      claudeSessionConfiguration.update('app-fixture', { ...concurrentBase, effort: 'high', ultracode: false }),
    ]);
    assert.equal(mutations.filter((entry) => entry.status === 'fulfilled').length, 1);
    providerModelsService.getProviderModels = async () => {
      sessionsDb.setSessionModel('app-fixture', 'default');
      return catalog;
    };
    await assert.rejects(claudeSessionConfiguration.prepareShell('app-fixture', 'claude', project), /changed while preparing/);
    sessionsDb.setSessionModel('app-fixture', 'fixture-exact');
    providerModelsService.getProviderModels = async () => {
      sessionsDb.assignProviderSessionId('app-fixture', 'native-changed');
      return catalog;
    };
    await assert.rejects(claudeSessionConfiguration.prepareShell('app-fixture', 'claude', project), /changed while preparing/);
    claudeExecutionRecords.finish(launch.record.executionId);
    providerModelsService.getProviderModels = async () => catalog;
    const selected = (await claudeSessionConfiguration.read('app-fixture')).next;
    await claudeSessionConfiguration.update('app-fixture', { ...selected, effort: 'xhigh', ultracode: true });
    const preparedChat = await claudeSessionConfiguration.prepare('app-fixture');
    const events: AnyRecord[] = [];
    let queryCount = 0;
    const queryMock = ((input: Parameters<typeof query>[0]) => {
      queryCount++;
      assert.equal(input.options?.model, 'fixture-exact');
      assert.equal(input.options?.effort, 'xhigh');
      assert.deepEqual(input.options?.settings, { ultracode: true, enableWorkflows: true });
      const iterator = (async function* () {
        const stopHook = input.options?.hooks?.Stop?.[0]?.hooks?.[0];
        await stopHook?.({ hook_event_name: 'Stop', session_id: 'native-changed', cwd: project, effort: { level: 'high' }, tool_input: { private: 'never-store' } } as never, undefined, { signal: new AbortController().signal });
        yield { type: 'system', subtype: 'init', session_id: 'native-changed', model: 'fixture-init' };
        yield { type: 'assistant', session_id: 'native-changed', message: { id: 'actual-fixture-message', role: 'assistant', model: 'fixture-actual', content: [{ type: 'text', text: 'Fixture' }] } };
        yield { type: 'result', session_id: 'native-changed', is_error: false };
      })();
      return Object.assign(iterator, { interrupt: async () => {}, getSettings: async () => ({ applied: { effort: 'high', ultracode: false, env: { PRIVATE_FIXTURE: 'never-store' } } }) }) as unknown as Query;
    }) as typeof query;
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => 'native-changed', resolveResumeModel: async () => 'stale-ignored',
      getProviderModels: async () => catalog, normalizeMessage: () => [], isProviderInstalled: async () => true,
    };
    await createClaudeRuntime({ query: queryMock, loadMcpConfig: async () => null }).run('Fixture; no model is called', {
      sessionId: 'app-fixture', executionId: 'chat-fixture-run', cwd: project, model: preparedChat.settings.model,
      effort: 'ultracode', executionSettings: preparedChat.settings, expectedProviderSessionId: 'native-changed',
    }, { send: (event) => events.push(event as AnyRecord) }, context);
    assert.equal(queryCount, 1);
    const actual = claudeExecutionRecords.get('chat-fixture-run');
    assert.equal(actual?.requested.ultracode, true);
    assert.equal(actual?.observed.ultracode, false);
    assert.equal(actual?.observed.effort, 'high');
    assert.equal(actual?.observed.model, 'fixture-actual');
    assert.equal(actual?.providerSessionId, 'native-changed');
    assert.equal(actual?.status, 'completed');
    assert.equal(JSON.stringify(actual).includes('never-store'), false);
    assert.equal(JSON.stringify(actual).includes('tool_input'), false);
    assert.equal(events.some((event) => event.kind === 'error'), false);
    // A native Shell hook lives in another process. It may have read the record
    // before the parent finishes; its later observation must merge into the
    // finished record, never overwrite it with that stale running snapshot.
    const childRecord = { ...launch.record, executionId: 'late-hook-fixture', providerSessionId: null };
    claudeExecutionRecords.begin(childRecord);
    const hookScript = `import { claudeExecutionRecords as records } from ${JSON.stringify(new URL('../services/claude-execution-records.ts', import.meta.url).href)};
      const earlier = records.get('late-hook-fixture');
      if (earlier.status !== 'running') process.exit(2);
      process.stdout.write('fixture-ready\\n');
      process.stdin.once('data', () => { records.observe('late-hook-fixture', { effort: 'medium', source: 'shell-hook' }); process.exit(0); });`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', hookScript], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const childFinished = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Fixture hook exit ${code}`)));
    });
    const childTimeout = setTimeout(() => child.kill(), 5000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', (code) => { if (code !== 0) reject(new Error('Fixture hook exited before ready')); });
      });
      claudeExecutionRecords.bind('late-hook-fixture', 'late-native');
      claudeExecutionRecords.observe('late-hook-fixture', { model: 'parent-model', source: 'response' });
      claudeExecutionRecords.finish('late-hook-fixture');
      const endedAt = claudeExecutionRecords.get('late-hook-fixture')?.endedAt;
      child.stdin.end('observe');
      await childFinished;
      const merged = claudeExecutionRecords.get('late-hook-fixture');
      assert.equal(merged?.status, 'completed');
      assert.equal(merged?.endedAt, endedAt);
      assert.equal(merged?.providerSessionId, 'late-native');
      assert.equal(merged?.observed.model, 'parent-model');
      assert.equal(merged?.observed.effort, 'medium');
    } finally { clearTimeout(childTimeout); if (child.exitCode === null) child.kill(); }


  } finally {
    providerModelsService.getProviderModels = previousCatalog;
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
    if (previousCli === undefined) delete process.env.CLAUDE_CLI_PATH; else process.env.CLAUDE_CLI_PATH = previousCli;
    await rm(directory, { recursive: true, force: true });
  }
});
