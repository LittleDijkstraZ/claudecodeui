import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import type { Options, Query, query } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeCommandCatalog, claudeCommandCatalog } from '@/modules/providers/list/claude/claude-command-catalog.js';
import { createClaudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/index.js';

test('metadata discovery is scoped to the exact app/native/project tuple, with documented defaults until reported', () => {
  const catalog = createClaudeCommandCatalog();
  const initial = catalog.list('/remote/a', 'app-a', 'native-a');
  assert.deepEqual(initial.native.map(item => item.name), ['/compact', '/context', '/usage']);
  assert.equal(initial.source, 'documentation');
  catalog.remember('app-a', 'native-a', '/remote/a', ['compact', 'theme', { name: 'review', description: 'Remote review', aliases: ['check'] }]);
  assert.deepEqual(catalog.list('/remote/a', 'app-a', 'native-a').native.map(item => item.name), ['/compact', '/review', '/check']);
  for (const [folder, app, native] of [['/remote/b', 'app-a', 'native-a'], ['/remote/a', 'app-b', 'native-a'], ['/remote/a', 'app-a', 'new-native']]) {
    assert.equal(catalog.list(folder, app, native).source, 'documentation');
  }
  catalog.remember('app-a', 'native-a', '/remote/a', ['context']);
  assert.deepEqual(catalog.list('/remote/a', 'app-a', 'native-a').native.map(item => item.name), ['/context']);
  assert.ok(initial.unavailable.find(item => item.name === '/clear')?.reason.includes('New Conversation'));
});

test('session-changing/terminal commands fail explicitly while native model/effort and skills retain existing dispatch', () => {
  const catalog = createClaudeCommandCatalog();
  for (const command of ['/clear', '/resume other', '/fork', '/rewind', '/logout', '/theme']) assert.throws(() => catalog.assertAllowed(command, 'native'));
  assert.throws(() => catalog.assertAllowed('/compact preserve methods', null), /prior messages/);
  for (const command of ['/compact keep methods', '/context', '/usage', '/model opus', '/effort high', '/my-skill']) catalog.assertAllowed(command, 'native');
});

let sequence = 0;
function fixture(script: (state: { inputs: AnyRecord[]; inputDone: Promise<void>; events: AnyRecord[] }) => AsyncGenerator<AnyRecord>, native: string | null = 'native-command') {
  const app = `native-command-app-${++sequence}`;
  const events: AnyRecord[] = []; const inputs: AnyRecord[] = [];
  let queries = 0; let metadataReads = 0; let interrupts = 0; let options: Options | undefined;
  const mockQuery = ((input: Parameters<typeof query>[0]) => {
    queries++; options = input.options;
    const inputDone = (async () => { for await (const entry of input.prompt as AsyncIterable<AnyRecord>) inputs.push(entry); })();
    return Object.assign(script({ inputs, inputDone, events }), {
      supportedCommands: async () => { metadataReads++; return [{ name: 'compact', description: 'Native compact', argumentHint: '[focus]' }]; },
      interrupt: async () => { interrupts++; },
    }) as unknown as Query;
  }) as typeof query;
  const provider = new ClaudeSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => native, resolveResumeModel: async () => 'fixture',
    getProviderModels: async () => ({ DEFAULT: 'fixture', OPTIONS: [{ value: 'fixture', label: 'Fixture' }] }),
    normalizeMessage: (raw, sid) => provider.normalizeMessage(raw, sid), isProviderInstalled: async () => true,
  };
  const runtime = createClaudeRuntime({ query: mockQuery, loadMcpConfig: async () => null, waitCeilingMs: 10 });
  return { events, inputs, app, run: (command = '/compact retain experiment methods') => runtime.run(command, { sessionId: app, cwd: '/remote/project', clientMessageId: 'input-initial' }, { send: value => events.push(value as AnyRecord) }, context),
    enqueue: (command: string, clientMessageId: string) => runtime.enqueue!(app, command, { clientMessageId }),
    queries: () => queries, metadataReads: () => metadataReads, interrupts: () => interrupts, options: () => options };
}
const native = 'native-command';
const result = (uuid: string, text = '', extra: AnyRecord = {}) => ({ type: 'result', uuid, session_id: native, subtype: 'success', is_error: false, result: text, ...extra });

test('compact resumes the exact native session, reports only its real boundary, and reads metadata on that one query', async () => {
  const h = fixture(async function* ({ inputDone, inputs }) {
    await setImmediate();
    assert.equal(inputs[0].message.content, '/compact retain experiment methods');
    yield { type: 'system', subtype: 'init', session_id: native, slash_commands: ['compact', 'context'] };
    yield { type: 'system', subtype: 'compact_boundary', uuid: 'wrong-boundary', session_id: 'other-native' };
    yield { type: 'system', subtype: 'compact_boundary', uuid: 'actual-boundary', session_id: native, compact_metadata: { trigger: 'manual', pre_tokens: 80000 } };
    yield result('compact-result', 'Compacted', { user_message_uuid: 'input-initial' });
    await inputDone;
  });
  await h.run();
  assert.equal(h.queries(), 1); assert.equal(h.metadataReads(), 1); assert.equal(h.interrupts(), 0);
  assert.equal(h.options()?.resume, native);
  const boundaries = h.events.filter(event => event.compactMetadata);
  assert.deepEqual(boundaries.map(event => event.id), ['actual-boundary']);
  assert.ok(boundaries.every(event => event.sessionId === native));
  assert.equal(claudeCommandCatalog.list('/remote/project', h.app, native).source, 'session');
});

test('a no-op successful result displays the native reason without claiming compaction', async () => {
  const h = fixture(async function* ({ inputDone }) {
    yield result('no-op', 'Not enough messages to compact.', { user_message_uuid: 'input-initial' });
    await inputDone;
  });
  await h.run();
  assert.ok(h.events.some(event => String(event.summary).includes('Not enough messages to compact.')));
  assert.equal(h.events.some(event => String(event.summary).includes('compacted this conversation')), false);
});

test('a queued compact stays on the running Workflow query and an unrelated result is never attributed to it', async () => {
  const h = fixture(async function* ({ inputDone }) {
    yield { type: 'assistant', session_id: native, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'wf-tool', name: 'Workflow', input: {} }] } };
    yield { type: 'system', subtype: 'task_started', session_id: native, task_id: 'wf-task', tool_use_id: 'wf-tool', task_type: 'local_workflow' };
    yield result('initial', '', { user_message_uuid: 'input-initial' });
    await assert.rejects(h.enqueue('/clear', 'blocked-clear'), /New Conversation/);
    assert.equal(h.events.some(event => event.kind === 'complete'), false);
    assert.equal(await h.enqueue('/compact preserve evidence', 'input-compact'), true);
    await setImmediate();
    yield result('unrelated', 'Unrelated Workflow report');
    assert.equal(h.events.some(event => String(event.summary).includes('Unrelated Workflow report')), false);
    assert.equal(h.events.some(event => event.kind === 'complete'), false);
    yield { type: 'system', subtype: 'compact_boundary', uuid: 'workflow-compact-boundary', session_id: native, compact_metadata: { trigger: 'manual', pre_tokens: 90000 } };
    yield result('compact', 'Compacted', { user_message_uuid: 'input-compact' });
    assert.equal(h.events.some(event => event.kind === 'complete'), false);
    yield { type: 'system', subtype: 'task_notification', session_id: native, task_id: 'wf-task', status: 'completed', summary: 'Workflow done' };
    yield result('workflow-final');
    await inputDone;
  });
  await h.run('Start Workflow');
  assert.equal(h.queries(), 1); assert.equal(h.interrupts(), 0);
  assert.deepEqual(h.inputs.map(input => input.message.content), ['Start Workflow', '/compact preserve evidence']);
});

test('compact without history and unsafe native session switches never open an SDK query', async () => {
  for (const [command, nativeId] of [['/compact', null], ['/clear', native], ['/resume other', native]]) {
    const h = fixture(async function* () {}, nativeId);
    await h.run(command!);
    assert.equal(h.queries(), 0);
    assert.ok(h.events.some(event => event.kind === 'error'));
  }
});
