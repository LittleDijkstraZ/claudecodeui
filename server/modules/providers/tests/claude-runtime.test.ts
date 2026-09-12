import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Options, Query, query, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

import { acquireClaudeSideQuestionQuery, createClaudeRuntime, mapCliOptionsToSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord, NormalizedMessage, ProviderModelsDefinition, ProviderRuntimeContext } from '@/shared/index.js';

const models: ProviderModelsDefinition = {
  DEFAULT: 'fixture',
  OPTIONS: [{
    value: 'fixture', label: 'Fixture',
    effort: { values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].map(value => ({ value })) },
  }],
};

test('SDK options enable partial messages and map ultracode to a session setting plus xhigh', () => {
  const options = mapCliOptionsToSDK({ model: 'fixture', effort: 'ultracode', effortModels: models });
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.forwardSubagentText, true);
  assert.equal(options.effort, 'xhigh');
  assert.deepEqual(options.settings, { ultracode: true, enableWorkflows: true });
  assert.deepEqual(options.settingSources, ['project', 'user', 'local']);
});

test('explicit ordinary/default effort disables saved ultracode only for this invocation', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'default']) {
    const options = mapCliOptionsToSDK({ model: 'fixture', effort, effortModels: models });
    assert.deepEqual(options.settings, { ultracode: false });
    assert.equal(options.effort, effort === 'default' ? undefined : effort);
  }
  for (const effort of [undefined]) {
    const options = mapCliOptionsToSDK({ model: 'fixture', effort, effortModels: models });
    assert.equal(options.settings, undefined);
    assert.equal(options.effort, undefined);
  }
});

test('ultracode is not passed through for a model without that supported choice', () => {
  assert.throws(() => mapCliOptionsToSDK({
    model: 'limited', effort: 'ultracode',
    effortModels: { DEFAULT: 'limited', OPTIONS: [{ value: 'limited', label: 'Limited', effort: { values: [{ value: 'high' }] } }] },
  }), /not reported support/);
});

const nativeSession = 'fixture-native-session';
const result = (isError = false) => ({ type: 'result', session_id: nativeSession, is_error: isError });
const workflow = (id = 'workflow-call') => ({
  type: 'assistant', session_id: nativeSession,
  message: { id: `message-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Workflow', input: {} }] },
});
const started = (id = 'workflow-call') => ({
  type: 'system', subtype: 'task_started', session_id: nativeSession,
  task_id: `task-${id}`, tool_use_id: id, task_type: 'local_workflow', description: 'Fixture workflow',
});
const notification = (id = 'workflow-call') => ({
  type: 'system', subtype: 'task_notification', session_id: nativeSession,
  task_id: `task-${id}`, status: 'completed', summary: 'Fixture workflow finished',
});
let harnessSequence = 0;

function runtimeHarness(steps: (state: {
  events: NormalizedMessage[];
  inputClosed: () => boolean;
  inputDone: Promise<void>;
}) => AsyncGenerator<AnyRecord>, waitCeilingMs = 1000, fixture: {
  interrupt?: () => Promise<void>;
  stopTask?: (taskId: string) => Promise<void>;
  resolveModel?: () => Promise<string>;
  onEvent?: (event: NormalizedMessage) => void;
  spawn?: (options: SpawnOptions) => ChildProcessWithoutNullStreams;
  spawnOptions?: SpawnOptions;
} = {}) {
  const events: NormalizedMessage[] = [];
  let sdkOptions: Options | undefined;
  let inputClosed = false;
  const inputs: AnyRecord[] = [];
  let queryCount = 0; let interrupts = 0;
  const queryMock = ((input: Parameters<typeof query>[0]) => {
    queryCount++; sdkOptions = input.options;
    if (fixture.spawn) {
      input.options!.spawnClaudeCodeProcess!(fixture.spawnOptions ?? {
        command: '/fixture/claude', args: ['--fixture'], cwd: '/fixture/project', env: { FIXTURE: 'true' }, signal: new AbortController().signal,
      });
    }
    assert.notEqual(typeof input.prompt, 'string');
    const inputDone = (async () => {
      for await (const message of input.prompt) { assert.equal(typeof message, 'object'); inputs.push(message as AnyRecord); }
      inputClosed = true;
    })();
    const iterator = steps({ events, inputClosed: () => inputClosed, inputDone });
    return Object.assign(iterator, { interrupt: async () => { interrupts++; await fixture.interrupt?.(); }, stopTask: async (taskId: string) => { await fixture.stopTask?.(taskId); } }) as unknown as Query;
  }) as typeof query;
  const runtime = createClaudeRuntime({ query: queryMock, loadMcpConfig: async () => null, waitCeilingMs,
    ...(fixture.spawn ? { spawn: fixture.spawn } : {}) });
  const appSessionId = `fixture-app-${++harnessSequence}`;
  const provider = new ClaudeSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => nativeSession,
    resolveResumeModel: fixture.resolveModel ?? (async () => 'fixture'),
    getProviderModels: async () => models,
    normalizeMessage: (raw, sid) => provider.normalizeMessage(raw, sid),
    isProviderInstalled: async () => true,
  };
  return {
    acquireBtw: () => acquireClaudeSideQuestionQuery(appSessionId),
    events, inputs, queries: () => queryCount, interrupts: () => interrupts,
    enqueue: (command: string, clientMessageId: string, deliveryMode: 'queue' | 'interrupt' = 'queue') => runtime.enqueue!(appSessionId, command, { clientMessageId, deliveryMode }),
    options: () => sdkOptions,
    abort: () => runtime.abort(appSessionId),
    interruptQueued: (clientMessageId: string) => runtime.interruptQueued!(appSessionId, clientMessageId),
    stopTask: (taskId: string) => runtime.stopTask!(appSessionId, taskId),
    run: () => runtime.run('Fixture only; no model call is made.', { sessionId: appSessionId }, {
      send: message => { events.push(message as NormalizedMessage); fixture.onEvent?.(message as NormalizedMessage); },
    }, context),
  };
}

test('interrupting an existing queued input preserves the native query, other messages and Workflow', async () => {
  const h = runtimeHarness(async function* ({ inputClosed, inputDone }) {
    yield workflow(); yield started(); yield result();
    await h.enqueue('First follow-up', 'first-follow-up');
    yield { type: 'assistant', session_id: nativeSession, user_message_uuid: 'first-follow-up', message: { id: 'reply-one', role: 'assistant', content: [{ type: 'text', text: 'Working' }] } };
    await h.enqueue('Queued direction', 'queued-direction');
    await h.enqueue('Keep this too', 'queued-other');
    assert.equal(await h.interruptQueued('queued-direction'), true);
    assert.equal(h.interrupts(), 1);
    assert.equal(h.queries(), 1);
    assert.equal(inputClosed(), false);
    assert.equal(h.events.some(event => event.kind === 'complete'), false);
    assert.equal(h.events.filter(event => event.text === 'message_delivery' && event.clientMessageId === 'queued-direction').at(-1)?.delivery, 'queued');
    yield { ...result(true), terminal_reason: 'aborted_streaming', user_message_uuid: 'first-follow-up' };
    assert.equal(h.events.filter(event => event.text === 'claude_runtime_state').at(-1)?.backgroundTasks, 1);
    for (const id of ['queued-direction', 'queued-other']) {
      yield { type: 'user', session_id: nativeSession, uuid: id };
      yield { ...result(), user_message_uuid: id };
    }
    yield notification(); yield result(); await inputDone;
  });
  await h.run();
  assert.equal(h.options()?.perTaskStopAffordance, true);
  assert.equal(h.inputs.filter(input => input.uuid === 'queued-direction').length, 1);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, true);
});

test('a failed queued interrupt leaves delivery and live input intact; settled IDs never interrupt newer replies', async () => {
  const h = runtimeHarness(async function* ({ inputClosed, inputDone }) {
    yield workflow(); yield started();
    await h.enqueue('Pending', 'pending');
    await assert.rejects(h.interruptQueued('pending'), /Native interrupt rejected/);
    assert.equal(inputClosed(), false);
    assert.equal(h.events.filter(event => event.text === 'message_delivery' && event.clientMessageId === 'pending').at(-1)?.delivery, 'queued');
    yield { type: 'user', session_id: nativeSession, uuid: 'pending' };
    assert.equal(await h.interruptQueued('pending'), false);
    assert.equal(await h.interruptQueued('unknown'), false);
    assert.equal(h.interrupts(), 1);
    yield { ...result(), user_message_uuid: 'pending' }; yield notification(); yield result(); await inputDone;
  }, 1000, { interrupt: async () => { throw new Error('Native interrupt rejected'); } });
  await h.run();
  assert.equal(h.events.at(-1)?.success, true);
});

test('concurrent queued interrupt clicks share one native control request', async () => {
  let releaseInterrupt!: () => void;
  const interruptResponse = new Promise<void>(resolve => { releaseInterrupt = resolve; });
  const h = runtimeHarness(async function* ({ inputDone }) {
    yield workflow(); yield started();
    await h.enqueue('Queued', 'queued');
    const first = h.interruptQueued('queued');
    const second = h.interruptQueued('queued');
    assert.equal(h.interrupts(), 1);
    releaseInterrupt();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    yield { ...result(), user_message_uuid: 'queued' };
    yield notification(); yield result(); await inputDone;
  }, 1000, { interrupt: () => interruptResponse });
  await h.run();
  assert.equal(h.events.at(-1)?.success, true);
});

test('queued input can run while Workflow is in the background without any interrupt', async () => {
  const h = runtimeHarness(async function* ({ inputClosed, inputDone }) {
    yield workflow(); yield started(); yield result();
    assert.equal(await h.enqueue('Continue the conversation', 'background-input'), true);
    await delay(0);
    assert.equal(h.inputs.filter(input => input.uuid === 'background-input').length, 1);
    assert.equal(h.inputs.find(input => input.uuid === 'background-input')?.message.content, 'Continue the conversation');
    assert.equal(await h.interruptQueued('background-input'), true);
    assert.equal(h.interrupts(), 0);
    assert.equal(inputClosed(), false);
    yield { type: 'assistant', session_id: nativeSession, user_message_uuid: 'background-input', message: { id: 'bg-reply', role: 'assistant', content: [{ type: 'text', text: 'Main reply while Workflow runs' }] } };
    yield { ...result(), user_message_uuid: 'background-input' };
    assert.equal(h.events.filter(event => event.text === 'claude_runtime_state').at(-1)?.backgroundTasks, 1);
    yield notification(); yield result(); await inputDone;
  });
  await h.run();
  assert.equal(h.queries(), 1);
  assert.equal(h.events.some(event => event.kind === 'text' && event.content === 'Main reply while Workflow runs'), true);
  assert.equal(h.events.at(-1)?.success, true);
});

test('native BTW acquisitions capture new main-turn partial text while preserving query and queue ownership', async () => {
  const h = runtimeHarness(async function* ({ inputClosed, inputDone }) {
    yield workflow(); yield started(); yield result();
    await h.enqueue('New main question', 'new-main-input');
    const beforeDelivery = h.acquireBtw()!;
    assert.ok(!beforeDelivery.context.includes('New main question'));
    beforeDelivery.release();
    yield { type: 'user', uuid: 'new-main-input', session_id: nativeSession, message: { role: 'user', content: 'New main question' } };
    const partial = (event: AnyRecord) => ({ type: 'stream_event', session_id: nativeSession, event });
    yield partial({ type: 'message_start', message: { id: 'main-latest' } });
    yield partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LATEST_VISIBLE_SENTINEL' } });
    const first = h.acquireBtw()!;
    assert.ok(first.context.includes('LATEST_VISIBLE_SENTINEL'));
    assert.ok(first.context.includes('New main question'));
    first.release(); first.release();
    yield partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' and newer update' } });
    yield partial({ type: 'content_block_stop', index: 0 });
    yield { type: 'assistant', uuid: 'native-latest-row', session_id: nativeSession, message: { id: 'main-latest', role: 'assistant', content: [{ type: 'text', text: 'LATEST_VISIBLE_SENTINEL and newer update' }] } };
    yield { type: 'assistant', session_id: 'other-native', message: { role: 'assistant', content: [{ type: 'text', text: 'FOREIGN_SESSION' }] } };
    yield { type: 'assistant', session_id: nativeSession, parent_tool_use_id: 'child', message: { role: 'assistant', content: [{ type: 'text', text: 'CHILD_RESPONSE' }] } };
    yield { type: 'assistant', session_id: nativeSession, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }] } };
    const second = h.acquireBtw()!;
    assert.equal((second.context.match(/LATEST_VISIBLE_SENTINEL/g) ?? []).length, 1);
    assert.ok(second.context.includes('and newer update'));
    assert.ok(!first.context.includes('and newer update'));
    for (const excluded of ['FOREIGN_SESSION', 'CHILD_RESPONSE', 'PRIVATE_THINKING']) assert.ok(!second.context.includes(excluded));
    second.release();
    assert.equal(h.queries(), 1); assert.equal(h.interrupts(), 0); assert.equal(inputClosed(), false);
    yield { ...result(), user_message_uuid: 'new-main-input' }; yield notification(); yield result(); await inputDone;
  });
  await h.run();
  assert.equal(h.events.at(-1)?.success, true);
});

test('task stop uses the native task ID and retains other tasks and main input', async () => {
  const stopped: string[] = [];
  const h = runtimeHarness(async function* ({ inputClosed, inputDone }) {
    yield workflow(); yield started(); yield result();
    yield { type: 'system', subtype: 'task_progress', session_id: nativeSession, task_id: 'agent-task', task_type: 'local_agent' };
    assert.equal(await h.stopTask('unknown-task'), false);
    assert.equal(await h.stopTask('agent-task'), true);
    assert.deepEqual(stopped, ['agent-task']);
    assert.equal(inputClosed(), false);
    assert.equal(h.interrupts(), 0);
    yield { type: 'system', subtype: 'task_notification', session_id: nativeSession, task_id: 'agent-task', status: 'stopped' };
    yield { type: 'system', subtype: 'task_progress', session_id: nativeSession, task_id: 'agent-task' };
    assert.equal(await h.stopTask('agent-task'), false);
    assert.equal(await h.stopTask('task-workflow-call'), true);
    assert.deepEqual(stopped, ['agent-task', 'task-workflow-call']);
    yield { ...notification(), status: 'stopped' }; yield result(); await inputDone;
  }, 1000, { stopTask: async (taskId) => { stopped.push(taskId); } });
  await h.run();
  assert.equal(h.events.at(-1)?.success, true);
});

test('mock SDK Workflow launch does not complete UI or close input; final follow-up completes exactly once', async () => {
  const h = runtimeHarness(async function* ({ events, inputClosed, inputDone }) {
    yield workflow();
    yield started();
    yield result();
    assert.equal(events.some(event => event.kind === 'complete'), false);
    assert.equal(inputClosed(), false);
    yield { type: 'system', subtype: 'task_progress', session_id: nativeSession, task_id: 'task-workflow-call', summary: 'Verifying fixture', usage: { tool_uses: 3 },
      workflow_progress: [{ type: 'workflow_phase', index: 0, title: 'Verify' }, { type: 'workflow_agent', index: 1, label: 'Check', state: 'done', phaseIndex: 0, promptPreview: 'Check', resultPreview: 'Done' }] };
    const progress = events.filter(event => event.kind === 'status' && event.text === 'Verifying fixture');
    assert.equal(progress.length, 1);
    assert.equal(progress[0].workflowProgress?.[0]?.type, 'workflow_phase');
    yield notification();
    assert.equal(events.some(event => event.kind === 'complete'), false);
    yield { type: 'assistant', session_id: nativeSession, message: { role: 'assistant', content: [{ type: 'text', text: 'Final fixture answer' }] } };
    yield result();
    await inputDone;
  });
  await h.run();
  assert.equal(h.options()?.includePartialMessages, true);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, true);
  assert.equal(h.events.some(event => event.content === 'Final fixture answer'), true);
  const foregroundTurns = new Set(h.events.filter(event => event.text === 'claude_runtime_state' && event.phase === 'foreground').map(event => event.foregroundTurnId));
  assert.equal(foregroundTurns.size, 2, 'A background follow-up owns a new foreground timer within the same execution');
  assert.equal(foregroundTurns.has(undefined), false);
  assert.equal(h.events.filter(event => event.text === 'claude_runtime_state' && event.phase === 'background').every(event => event.foregroundStartedAt === undefined), true);
});

test('successor Workflow after a completed Workflow keeps the original UI run active', async () => {
  const h = runtimeHarness(async function* ({ events, inputDone }) {
    yield workflow(); yield started(); yield result(); yield notification();
    yield workflow('second'); yield started('second'); yield result();
    assert.equal(events.some(event => event.kind === 'complete'), false);
    yield notification('second'); yield result(); await inputDone;
  });
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, true);
});

test('legacy background Bash permits further input and completes the runtime only after its follow-up', async () => {
  const h = runtimeHarness(async function* ({ events, inputClosed, inputDone }) {
    yield { type: 'assistant', session_id: nativeSession, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bash-call', name: 'Bash', input: { run_in_background: true } }] } };
    yield result();
    assert.equal(events.filter(event => event.kind === 'complete').length, 0);
    assert.ok(events.some(event => event.text === 'claude_runtime_state' && event.phase === 'background' && event.acceptsInput));
    assert.equal(inputClosed(), false);
    yield result(); await inputDone;
  });
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
});

test('Workflow denied at launch completes normally without a background hold', async () => {
  const h = runtimeHarness(async function* ({ inputDone }) {
    yield workflow();
    yield { type: 'user', session_id: nativeSession, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'workflow-call', is_error: true, content: 'Denied by fixture' }] } };
    yield result(); await inputDone;
  });
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
});

test('a silent Workflow remains alive beyond the legacy idle ceiling', async () => {
  const h = runtimeHarness(async function* ({ inputDone, inputClosed, events }) {
    yield workflow(); yield started(); yield result();
    await delay(20);
    assert.equal(inputClosed(), false);
    assert.equal(events.some(event => event.kind === 'complete'), false);
    yield notification(); yield result(); await inputDone;
  }, 5);
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, true);
});

test('native exit after an SDK error produces a failed completion while a Workflow is running', async () => {
  const h = runtimeHarness(async function* () {
    yield workflow(); yield started(); yield result(true);
  });
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, false);
  assert.equal(h.events.some(event => event.kind === 'error'), true);
});

test('aborting a held Workflow closes input and completes once after the native query exits', async () => {
  let launched!: () => void;
  const launch = new Promise<void>(resolve => { launched = resolve; });
  const h = runtimeHarness(async function* ({ inputDone }) {
    yield workflow(); yield started(); yield result();
    launched();
    await inputDone;
    throw new Error('Fixture interrupt');
  });
  const running = h.run();
  await launch;
  assert.equal(await h.abort(), true);
  await running;
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.find(event => event.kind === 'complete')?.aborted, true);
  assert.equal(h.events.some(event => event.kind === 'error'), false);
});

test('runtime forwards partial text before the full assistant and suppresses the duplicate final block', async () => {
  const h = runtimeHarness(async function* ({ events, inputDone }) {
    const partial = (event: AnyRecord) => ({ type: 'stream_event', session_id: nativeSession, event });
    yield partial({ type: 'message_start', message: { id: 'stream-fixture' } });
    yield partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Live fixture' } });
    assert.equal(events.some(event => event.kind === 'stream_delta' && event.content === 'Live fixture'), true);
    yield { type: 'assistant', session_id: nativeSession, message: { id: 'stream-fixture', role: 'assistant', content: [{ type: 'text', text: 'Live fixture' }] } };
    yield partial({ type: 'content_block_stop', index: 0 });
    yield partial({ type: 'message_stop' });
    yield result(); await inputDone;
  });
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'stream_end').length, 1);
  assert.equal(h.events.filter(event => event.kind === 'text').length, 0);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
});

test('runtime flushes partial text before surfacing an SDK error and sends one failed completion', async () => {
  const h = runtimeHarness(async function* () {
    const partial = (event: AnyRecord) => ({ type: 'stream_event', session_id: nativeSession, event });
    yield partial({ type: 'message_start', message: { id: 'error-fixture' } });
    yield partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial fixture' } });
    throw new Error('Fixture model transport failure');
  });
  await h.run();
  const kinds = h.events.map(event => event.kind);
  assert.deepEqual(kinds.slice(-3), ['stream_end', 'error', 'complete']);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, false);
});

test('default selection inherits remote configuration without overriding an exact selected model', () => {
  assert.equal(mapCliOptionsToSDK({ model: 'default' }).model, undefined);
  assert.equal(mapCliOptionsToSDK({}).model, undefined);
  assert.equal(mapCliOptionsToSDK({ model: 'opus' }).model, 'opus');
  assert.equal(mapCliOptionsToSDK({ model: 'claude-exact-fixture[1m]' }).model, 'claude-exact-fixture[1m]');
});


test('ordinary user runs enable native file checkpoints and replay their message UUIDs', () => {
  const options = mapCliOptionsToSDK({ model: 'default' });
  assert.equal(options.enableFileCheckpointing, true);
  assert.deepEqual(options.extraArgs, { 'replay-user-messages': null });
});

test('Workflow accepts multiple messages through the same native query and never interrupts it', async () => {
  const second = '01234567-1234-4234-9234-123456789abc';
  const third = '01234567-1234-4234-9234-123456789abd';
  const h = runtimeHarness(async function* ({ inputDone, inputClosed, events }) {
    yield workflow(); yield started(); yield result();
    assert.equal(await h.enqueue('Second user question', second), true);
    assert.equal(await h.enqueue('Third user question', third), true);
    await delay(0);
    assert.equal(h.queries(), 1); assert.equal(h.interrupts(), 0);
    assert.equal(h.inputs.length, 3);
    assert.equal(h.inputs[1].uuid, second); assert.equal(h.inputs[2].uuid, third);
    assert.equal(h.inputs[1].priority, 'later');
    assert.deepEqual(events.filter(event => event.clientMessageId === second).map(event => event.delivery), ['queued']);
    yield { type: 'user', uuid: second, session_id: nativeSession, message: { role: 'user', content: 'Second user question' } };
    assert.deepEqual(events.filter(event => event.clientMessageId === second && event.text === 'message_delivery').map(event => event.delivery), ['queued', 'delivered']);
    yield { ...result(), user_message_uuid: second };
    yield notification(); yield result(); // Background follow-up cannot consume the third user question.
    assert.equal(inputClosed(), false);
    assert.equal(events.some(event => event.kind === 'complete'), false);
    yield { type: 'user', uuid: third, session_id: nativeSession, message: { role: 'user', content: 'Third user question' } };
    yield { ...result(), user_message_uuids: [third] };
    await inputDone;
  });
  await h.run();
  assert.equal(h.queries(), 1); assert.equal(h.interrupts(), 0);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, true);
});

test('a second run request cannot replace a live Workflow or start another native process', async () => {
  const h = runtimeHarness(async function* ({ inputDone }) {
    yield workflow(); yield started(); yield result();
    await assert.rejects(h.run(), /already owns this session/);
    assert.equal(h.queries(), 1); assert.equal(h.interrupts(), 0);
    yield notification(); yield result(); await inputDone;
  });
  await h.run();
  assert.equal(h.queries(), 1); assert.equal(h.interrupts(), 0);
});

test('owned native user replays emit one delivery transition without duplicating prompt rows; tool results and external users remain visible', async () => {
  const clientMessageId = '679293f2-15f7-4f75-b1dc-8aefb2c629a3';
  const h = runtimeHarness(async function* ({ inputDone, events }) {
    yield workflow(); yield started(); yield result();
    assert.equal(await h.enqueue('Replay fixture prompt', clientMessageId), true);
    await delay(0);
    // Native producers may use a string or a text-block array for the same replay.
    yield { type: 'user', uuid: clientMessageId, isReplay: true, session_id: nativeSession, message: { role: 'user', content: 'Replay fixture prompt' } };
    yield { type: 'user', uuid: clientMessageId, isReplay: true, session_id: nativeSession, message: { role: 'user', content: [{ type: 'text', text: 'Replay fixture prompt' }] } };
    assert.deepEqual(events.filter(event => event.clientMessageId === clientMessageId && event.text === 'message_delivery').map(event => event.delivery), ['queued', 'delivered']);
    assert.equal(events.some(event => event.kind === 'text' && event.role === 'user' && event.content === 'Replay fixture prompt'), false);
    yield { type: 'user', uuid: clientMessageId, session_id: nativeSession, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture-tool', content: 'Tool result fixture' }] } };
    assert.ok(events.some(event => event.kind === 'tool_result' && event.toolId === 'fixture-tool'));
    yield { type: 'user', uuid: 'external-user-row', session_id: nativeSession, message: { role: 'user', content: 'External user fixture' } };
    assert.ok(events.some(event => event.kind === 'text' && event.role === 'user' && event.content === 'External user fixture'));
    yield { ...result(), user_message_uuids: [clientMessageId] };
    yield notification(); yield result(); await inputDone;
  });
  await h.run();
  assert.equal(h.queries(), 1);
  assert.equal(h.interrupts(), 0);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
});

test('a foreground API error does not close or stop an existing Workflow', async () => {
  const followup = '01234567-1234-4234-9234-123456789abe';
  const h = runtimeHarness(async function* ({ inputDone, inputClosed, events }) {
    yield workflow(); yield started(); yield result();
    assert.equal(await h.enqueue('Follow-up that encounters an API error', followup), true);
    yield { ...result(true), subtype: 'success', result: 'Fixture temporary API error', user_message_uuid: followup };
    await delay(0);
    assert.equal(inputClosed(), false);
    assert.equal(h.interrupts(), 0);
    assert.equal(events.some(event => event.kind === 'complete'), false);
    assert.ok(events.some(event => event.kind === 'error' && event.content === 'Fixture temporary API error'));
    yield notification(); yield result(); await inputDone;
  });
  await h.run();
  assert.equal(h.queries(), 1);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
});

test('a failed interrupt leaves the original Workflow input writable for a fresh retry UUID', async () => {
  const retryId = 'b2034b8d-0b2d-4e3a-a757-b9249a6e7729';
  const h = runtimeHarness(async function* ({ inputDone, inputClosed, events }) {
    yield workflow(); yield started(); yield result();
    assert.equal(await h.abort(), false);
    assert.equal(inputClosed(), false);
    assert.equal(events.some(event => event.kind === 'complete'), false);
    assert.equal(await h.enqueue('Explicit manual retry', retryId), true);
    assert.equal(await h.enqueue('Explicit manual retry', retryId), true);
    await delay(0);
    assert.equal(h.inputs.filter(input => input.uuid === retryId).length, 1);
    assert.equal(h.queries(), 1);
    yield { type: 'user', uuid: retryId, session_id: nativeSession, message: { role: 'user', content: 'Explicit manual retry' } };
    yield { ...result(), user_message_uuid: retryId };
    yield notification(); yield result(); await inputDone;
  }, 1000, { interrupt: async () => { throw new Error('Fixture interrupt was rejected'); } });
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, true);
});

test('a successful stop keeps ownership while the native query is still closing', async () => {
  let ready!: () => void; let finish!: () => void;
  const startedQuery = new Promise<void>(resolve => { ready = resolve; });
  const exitQuery = new Promise<void>(resolve => { finish = resolve; });
  const h = runtimeHarness(async function* ({ inputDone }) {
    yield workflow(); yield started(); yield result(); ready();
    await inputDone; await exitQuery;
  });
  const running = h.run();
  await startedQuery;
  assert.equal(await h.abort(), true);
  assert.equal(h.events.some(event => event.kind === 'complete'), false);
  assert.equal(h.events.filter(event => event.text === 'claude_runtime_state').at(-1)?.acceptsInput, false);
  assert.equal(await h.enqueue('Too early', '5c3692b0-937c-4dc5-9113-5c9fd7a08918'), false);
  await assert.rejects(h.run(), /already owns this session/);
  assert.equal(h.queries(), 1);
  finish(); await running;
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.aborted, true);
});

test('starting admission is explicitly unwritable and does not spawn a replacement query', async () => {
  let finishPreparation!: () => void;
  const prepared = new Promise<void>(resolve => { finishPreparation = resolve; });
  const h = runtimeHarness(async function* ({ inputDone }) { yield result(); await inputDone; }, 1000, {
    resolveModel: async () => { await prepared; return 'fixture'; },
  });
  const running = h.run();
  assert.equal(h.events.find(event => event.text === 'claude_runtime_state')?.acceptsInput, false);
  assert.equal(h.queries(), 0);
  assert.equal(await h.enqueue('Not admitted while starting', 'd80a8d4f-f59c-49a2-b983-1fc7d99bd10e'), false);
  await assert.rejects(h.run(), /already owns this session/);
  finishPreparation(); await running;
  assert.equal(h.queries(), 1);
});

test('an immediate send after terminal completion can start once without old cleanup releasing its reservation', async () => {
  let secondRun: Promise<unknown> | undefined;
  let unblockSecond!: () => void;
  const prepared = new Promise<void>(resolve => { unblockSecond = resolve; });
  let modelResolutions = 0;
  const h = runtimeHarness(async function* ({ inputDone }) { yield result(); await inputDone; }, 1000, {
    resolveModel: async () => { if (++modelResolutions === 2) await prepared; return 'fixture'; },
    onEvent: event => { if (event.kind === 'complete' && !secondRun) secondRun = h.run(); },
  });
  await h.run();
  assert.ok(secondRun);
  assert.equal(h.queries(), 1);
  await assert.rejects(h.run(), /already owns this session/);
  unblockSecond(); await secondRun;
  assert.equal(h.queries(), 2);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 2);
  assert.equal(h.events.some(event => event.kind === 'error'), false);
});

test('native iterator exit waits for a pending interrupt verdict without prematurely reporting aborted completion', async () => {
  let ready!: () => void; let endIterator!: () => void; let rejectInterrupt!: (error: Error) => void;
  const active = new Promise<void>(resolve => { ready = resolve; });
  const end = new Promise<void>(resolve => { endIterator = resolve; });
  const interrupt = new Promise<void>((_resolve, reject) => { rejectInterrupt = reject; });
  const h = runtimeHarness(async function* () { yield workflow(); yield started(); yield result(); ready(); await end; }, 1000, { interrupt: () => interrupt });
  const running = h.run(); await active;
  const stopping = h.abort();
  endIterator(); await delay(0);
  assert.equal(h.events.some(event => event.kind === 'complete'), false);
  await assert.rejects(h.run(), /already owns this session/);
  // The SDK's iterator cleanup rejects still-pending control responses on exit.
  rejectInterrupt(new Error('Fixture query closed before interrupt response'));
  assert.equal(await stopping, false);
  await running;
  assert.equal(h.queries(), 1);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.aborted, false);
});

function syntheticChild(pid: number | null = 12345) {
  const child = Object.assign(new EventEmitter(), {
    pid: pid ?? undefined, killed: false, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => assert.fail('The runtime must never add an automatic kill'),
  });
  return {
    child: child as unknown as ChildProcessWithoutNullStreams,
    stderr: child.stderr,
    exit(code = 0) { child.exitCode = code; child.emit('exit', code, null); },
    error(error: Error) { child.emit('error', error); },
  };
}

test('native exit does not complete a still-running SDK iterator and spawn options remain identical', async () => {
  const process = syntheticChild();
  const controller = new AbortController();
  const spawnOptions: SpawnOptions = { command: '/fixture/exact-cli', args: ['--permission-mode', 'auto', '--resume=fixture'],
    cwd: '/fixture/exact-project', env: { FIXTURE_SETTING: 'unchanged' }, signal: controller.signal };
  const h = runtimeHarness(async function* ({ events, inputDone }) {
    process.exit();
    assert.equal(events.some(event => event.kind === 'complete'), false);
    yield result(); await inputDone;
  }, 1000, { spawnOptions, spawn: received => {
    assert.equal(received, spawnOptions);
    assert.equal(received.signal, controller.signal);
    return process.child;
  } });
  await h.run();
  assert.equal(h.queries(), 1);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
});

test('SDK iterator failure cannot release ownership while its observed native child remains alive', async () => {
  const process = syntheticChild();
  let failed!: () => void;
  const failure = new Promise<void>(resolve => { failed = resolve; });
  const h = runtimeHarness(async function* () {
    yield workflow(); yield started(); yield result();
    process.stderr.write('Fixture detailed terminal ownership diagnostic');
    failed(); throw new Error('Fixture SDK cleanup ended before child exit');
  }, 1000, { spawn: () => process.child });
  const running = h.run(); await failure; await delay(0);
  process.error(Object.assign(new Error('Fixture abort signal while PID remains alive'), { code: 'ABORT_ERR' }));
  assert.equal(h.events.some(event => event.kind === 'complete'), false);
  await assert.rejects(h.run(), /already owns this session/);
  assert.equal(await h.enqueue('Too early', '5c3692b0-937c-4dc5-9113-5c9fd7a08918'), false);
  assert.equal(h.queries(), 1);
  process.exit(1); await running;
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.ok(h.events.some(event => event.kind === 'error' && event.content?.includes('Fixture detailed terminal ownership diagnostic')));
  assert.equal(h.events.at(-1)?.success, false);
});

test('an absent-PID spawn error releases ownership without waiting for an exit that cannot occur', async () => {
  const process = syntheticChild(null);
  const h = runtimeHarness(async function* () {
    yield* []; // A failed spawn has no SDK messages before the transport error.
    const error = Object.assign(new Error('Fixture executable missing'), { code: 'ENOENT', syscall: 'spawn /fixture/missing' });
    process.error(error); throw error;
  }, 1000, { spawn: () => process.child });
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, false);
  await h.run();
  assert.equal(h.queries(), 2);
});

test('a synchronous spawn failure reports completion and does not leave a startup reservation', async () => {
  const h = runtimeHarness(async function* () { yield* []; assert.fail('An unspawned query cannot stream'); }, 1000, {
    spawn: () => { throw new Error('Fixture spawn threw synchronously'); },
  });
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, false);
  await h.run();
  assert.equal(h.queries(), 2);
});


test('queue and explicit interrupt share one native Query and preserve the Workflow and queued UUIDs', async () => {
  const queued = '043f1128-5a4f-42b9-967a-7e6bd635d1e4';
  const interrupt = '043f1128-5a4f-42b9-967a-7e6bd635d1e5';
  const h = runtimeHarness(async function* ({ events, inputClosed, inputDone }) {
    yield workflow(); yield started(); yield result();
    assert.equal(await h.enqueue('After the current turn', queued), true);
    assert.equal(await h.enqueue('Interrupt and send now', interrupt, 'interrupt'), true);
    await delay(0);
    assert.deepEqual(h.inputs.map(input => input.priority), ['next', 'later', 'now']);
    assert.equal(h.queries(), 1); assert.equal(h.interrupts(), 0);
    assert.ok(events.filter(event => event.text === 'claude_runtime_state').every(event => JSON.stringify(event.inputModes) === JSON.stringify(['queue', 'interrupt'])));
    yield { ...result(true), terminal_reason: 'aborted_streaming' };
    yield { ...result(true), terminal_reason: 'aborted_streaming' };
    assert.equal(inputClosed(), false);
    assert.equal(events.some(event => event.kind === 'complete' || event.kind === 'error'), false);
    const notes = events.filter(event => event.kind === 'task_notification' && event.reason === 'aborted_streaming');
    assert.equal(notes.length, 1); assert.ok(notes[0].executionId); assert.ok(notes[0].foregroundTurnId);
    assert.ok(events.some(event => event.text === 'foreground_complete' && event.interrupted === true));
    assert.equal(events.filter(event => event.clientMessageId === queued).at(-1)?.delivery, 'queued');
    yield { type: 'user', uuid: interrupt, session_id: nativeSession, message: { role: 'user', content: 'Interrupt and send now' } };
    yield { ...result(), user_message_uuid: interrupt };
    assert.equal(inputClosed(), false);
    assert.equal(events.filter(event => event.clientMessageId === queued).at(-1)?.delivery, 'queued');
    yield notification();
    yield { type: 'user', uuid: queued, session_id: nativeSession, message: { role: 'user', content: 'After the current turn' } };
    yield { ...result(), user_message_uuid: queued }; await inputDone;
  });
  await h.run();
  assert.equal(h.queries(), 1); assert.equal(h.interrupts(), 0);
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
});

test('a true API failure is not relabeled as an intentional interrupt', async () => {
  const h = runtimeHarness(async function* ({ events, inputDone }) {
    yield workflow(); yield started(); yield result();
    yield { ...result(true), terminal_reason: 'api_error', api_error_status: 529, result: 'Fixture overloaded' };
    assert.ok(events.some(event => event.kind === 'error' && event.content === 'Fixture overloaded'));
    assert.equal(events.some(event => event.interrupted === true), false);
    yield { ...result(true), terminal_reason: 'aborted_tools', errors: ['Fixture tool failure was also reported'] };
    assert.ok(events.some(event => event.kind === 'error' && event.content === 'Fixture tool failure was also reported'));
    yield notification(); yield result(); await inputDone;
  });
  await h.run();
});


test('native BTW holds the live query across foreground completion and releases only after the last side answer', async () => {
  const h = runtimeHarness(async function* ({ inputClosed, inputDone }) {
    yield { type: 'system', subtype: 'init', session_id: nativeSession };
    const first = h.acquireBtw(); const second = h.acquireBtw();
    assert.ok(first); assert.ok(second); assert.equal(first.query, second.query);
    yield result();
    await delay(0); assert.equal(inputClosed(), false);
    first.release(); first.release();
    await delay(0); assert.equal(inputClosed(), false);
    second.release(); await inputDone;
    assert.equal(inputClosed(), true);
    assert.equal(h.acquireBtw(), null);
  });
  await h.run();
  assert.equal(h.queries(), 1); assert.equal(h.interrupts(), 0);
});
