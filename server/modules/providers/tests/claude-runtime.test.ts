import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Options, Query, query } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeRuntime, mapCliOptionsToSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
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
  assert.equal(options.effort, 'xhigh');
  assert.deepEqual(options.settings, { ultracode: true });
  assert.deepEqual(options.settingSources, ['project', 'user', 'local']);
});

test('explicit ordinary/default effort disables saved ultracode only for this invocation', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'default']) {
    const options = mapCliOptionsToSDK({ model: 'fixture', effort, effortModels: models });
    assert.deepEqual(options.settings, { ultracode: false });
    assert.equal(options.effort, effort === 'default' ? undefined : effort);
  }
  for (const effort of [undefined, 'invalid']) {
    const options = mapCliOptionsToSDK({ model: 'fixture', effort, effortModels: models });
    assert.equal(options.settings, undefined);
    assert.equal(options.effort, undefined);
  }
});

test('ultracode is not passed through for a model without that supported choice', () => {
  const options = mapCliOptionsToSDK({
    model: 'limited', effort: 'ultracode',
    effortModels: { DEFAULT: 'limited', OPTIONS: [{ value: 'limited', label: 'Limited', effort: { values: [{ value: 'high' }] } }] },
  });
  assert.equal(options.effort, undefined);
  assert.equal(options.settings, undefined);
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
}) => AsyncGenerator<AnyRecord>, waitCeilingMs = 1000) {
  const events: NormalizedMessage[] = [];
  let sdkOptions: Options | undefined;
  let inputClosed = false;
  const queryMock = ((input: Parameters<typeof query>[0]) => {
    sdkOptions = input.options;
    assert.notEqual(typeof input.prompt, 'string');
    const inputDone = (async () => {
      for await (const message of input.prompt) assert.equal(typeof message, 'object');
      inputClosed = true;
    })();
    const iterator = steps({ events, inputClosed: () => inputClosed, inputDone });
    return Object.assign(iterator, { interrupt: async () => undefined }) as unknown as Query;
  }) as typeof query;
  const runtime = createClaudeRuntime({ query: queryMock, loadMcpConfig: async () => null, waitCeilingMs });
  const appSessionId = `fixture-app-${++harnessSequence}`;
  const provider = new ClaudeSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => nativeSession,
    resolveResumeModel: async () => 'fixture',
    getProviderModels: async () => models,
    normalizeMessage: (raw, sid) => provider.normalizeMessage(raw, sid),
    isProviderInstalled: async () => true,
  };
  return {
    events,
    options: () => sdkOptions,
    abort: () => runtime.abort(appSessionId),
    run: () => runtime.run('Fixture only; no model call is made.', { sessionId: appSessionId }, {
      send: message => events.push(message as NormalizedMessage),
    }, context),
  };
}

test('mock SDK Workflow launch does not complete UI or close input; final follow-up completes exactly once', async () => {
  const h = runtimeHarness(async function* ({ events, inputClosed, inputDone }) {
    yield workflow();
    yield started();
    yield result();
    assert.equal(events.some(event => event.kind === 'complete'), false);
    assert.equal(inputClosed(), false);
    yield { type: 'system', subtype: 'task_progress', session_id: nativeSession, task_id: 'task-workflow-call', summary: 'Verifying fixture', usage: { tool_uses: 3 } };
    assert.equal(events.some(event => event.kind === 'status' && event.text === 'Verifying fixture'), true);
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

test('legacy background Bash still completes the UI at launch and holds input until its follow-up', async () => {
  const h = runtimeHarness(async function* ({ events, inputClosed, inputDone }) {
    yield { type: 'assistant', session_id: nativeSession, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bash-call', name: 'Bash', input: { run_in_background: true } }] } };
    yield result();
    assert.equal(events.filter(event => event.kind === 'complete').length, 1);
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

test('Workflow wait ceiling reports incomplete work as failure instead of a successful completion', async () => {
  const h = runtimeHarness(async function* ({ inputDone }) {
    yield workflow(); yield started(); yield result();
    await delay(20); // Keep the test event loop active while the runtime's unref timer expires.
    await inputDone;
  }, 5);
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, false);
  assert.equal(h.events.some(event => event.kind === 'error' && event.content?.includes('wait limit')), true);
});

test('terminal SDK result errors produce a failed completion while a Workflow is running', async () => {
  const h = runtimeHarness(async function* ({ inputDone }) {
    yield workflow(); yield started(); yield result(true); await inputDone;
  });
  await h.run();
  assert.equal(h.events.filter(event => event.kind === 'complete').length, 1);
  assert.equal(h.events.at(-1)?.success, false);
  assert.equal(h.events.some(event => event.kind === 'error'), true);
});

test('aborting a held Workflow closes input and leaves exactly-one-complete ownership with the gateway', async () => {
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
  assert.equal(h.events.some(event => event.kind === 'complete'), false);
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
