import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import type { AnyRecord, AuthenticatedWebSocketRequest, LLMProvider } from '@/shared/index.js';
import { AppError, ProviderRunPreparationError } from '@/shared/index.js';

import { chatRunRegistry } from '../services/chat-run-registry.service.js';
import { handleChatConnection } from '../services/chat-websocket.service.js';
import { connectedClients } from '../services/websocket-state.service.js';

type RuntimeGateway = Parameters<typeof handleChatConnection>[2]['runtime'];
const CLIENT_ID = '28e64a1c-b906-4c11-bf85-21a0fcfbb729';

class FakeConnection {
  readyState = 1;
  frames: AnyRecord[] = [];
  private listeners = new Map<string, (data: string) => unknown>();
  send(data: string): void { this.frames.push(JSON.parse(data) as AnyRecord); }
  on(event: string, listener: (data: string) => unknown): this { this.listeners.set(event, listener); return this; }
  async receive(message: AnyRecord): Promise<void> { await this.listeners.get('message')?.(JSON.stringify(message)); }
}

async function withFixture(runTest: (fixture: {
  sessionId: string;
  connection: FakeConnection;
  run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>;
  enqueueCalls: Array<{ provider: LLMProvider; sessionId: string; command: string; options: AnyRecord }>;
}) => Promise<void>, options: { userId?: string; ownerId?: string; enqueue?: () => Promise<boolean>; run?: RuntimeGateway['run']; abort?: RuntimeGateway['abort']; interruptQueued?: RuntimeGateway['interruptQueued']; stopTask?: RuntimeGateway['stopTask']; provider?: LLMProvider } = {}): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chat-queued-send-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  // Precreate the empty fixture so initialization never copies a real install DB.
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try {
    const provider = options.provider ?? 'claude';
    const draft = sessionsService.createAppSession(provider, '/tmp/queue-fixture');
    sessionsDb.setSessionModel(draft.sessionId, 'existing-model');
    sessionsDb.setSessionEffort(draft.sessionId, 'high');
    const enqueueCalls: Array<{ provider: LLMProvider; sessionId: string; command: string; options: AnyRecord }> = [];
    const runtime: RuntimeGateway = {
      hasRuntime: () => true,
      run: options.run ?? (async () => assert.fail('A queued send must never start another runtime')),
      abort: options.abort ?? (async () => assert.fail('A queued send must never stop the current runtime')),
      interruptQueued: options.interruptQueued,
      stopTask: options.stopTask,
      resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [],
      enqueue: async (selectedProvider, sessionId, command, runtimeOptions) => {
        enqueueCalls.push({ provider: selectedProvider, sessionId, command, options: runtimeOptions });
        return options.enqueue ? await options.enqueue() : true;
      },
    };
    const connection = new FakeConnection();
    handleChatConnection(connection as unknown as WebSocket, {
      user: { id: options.userId ?? 'owner' },
    } as unknown as AuthenticatedWebSocketRequest, { runtime });
    const run = chatRunRegistry.startRun({
      appSessionId: draft.sessionId, provider, providerSessionId: 'fixture-native',
      connection: new FakeConnection(), userId: options.ownerId ?? 'owner',
    });
    assert.ok(run);
    await runTest({ sessionId: draft.sessionId, connection, run, enqueueCalls });
  } finally {
    connectedClients.clear(); chatRunRegistry.clearAll(); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('queued interrupt targets the existing UUID without resubmitting, completing or changing its delivery receipt', { concurrency: false }, async () => {
  const calls: unknown[][] = [];
  await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
    run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'foreground', acceptsInput: true, canInterruptQueuedMessages: true, canStopTask: true, backgroundTasks: 1 });
    run.writer.send({ kind: 'status', text: 'message_delivery', provider: 'claude', clientMessageId: CLIENT_ID, delivery: 'queued', deliveryMode: 'queue', content: 'Already submitted' });
    await connection.receive({ type: 'chat.interrupt', sessionId, clientMessageId: CLIENT_ID, requestId: 'interrupt-request' });
    assert.deepEqual(calls, [['claude', sessionId, CLIENT_ID]]);
    assert.equal(enqueueCalls.length, 0);
    assert.equal(run.status, 'running');
    assert.equal(run.messageReceipts.get(CLIENT_ID)?.delivery, 'queued');
    assert.equal(run.messageReceipts.get(CLIENT_ID)?.deliveryMode, 'queue');
    assert.deepEqual(connection.frames.at(-1), { kind: 'status', text: 'queued_input_interrupt', sessionId, clientMessageId: CLIENT_ID, requestId: 'interrupt-request', status: 'completed' });
    await connection.receive({ type: 'chat.subscribe', sessions: [{ sessionId }] });
    assert.equal(connection.frames.find(frame => frame.kind === 'chat_subscribed')?.canInterruptQueuedMessages, true);
    assert.equal(connection.frames.find(frame => frame.kind === 'chat_subscribed')?.canStopTask, true);
    assert.equal(chatRunRegistry.listRunningRuns()[0]?.canInterruptQueuedMessages, true);
  }, { interruptQueued: async (...args) => { calls.push(args); return true; } });
});

for (const outcome of ['false', 'throw'] as const) {
  test(`queued interrupt ${outcome} returns an action error without failing the queued message`, { concurrency: false }, async () => {
    await withFixture(async ({ sessionId, connection, run }) => {
      run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'foreground', acceptsInput: true, canInterruptQueuedMessages: true, backgroundTasks: 1 });
      run.writer.send({ kind: 'status', text: 'message_delivery', provider: 'claude', clientMessageId: CLIENT_ID, delivery: 'queued', content: 'Keep queued' });
      await connection.receive({ type: 'chat.interrupt', sessionId, clientMessageId: CLIENT_ID });
      assert.equal(connection.frames.at(-1)?.text, 'queued_input_interrupt');
      assert.equal(connection.frames.at(-1)?.status, 'failed');
      assert.equal(run.messageReceipts.get(CLIENT_ID)?.delivery, 'queued');
      assert.equal(run.status, 'running');
      assert.equal(connection.frames.some(frame => frame.kind === 'protocol_error' || frame.kind === 'complete'), false);
    }, { interruptQueued: async () => { if (outcome === 'throw') throw new Error('Native control rejected'); return false; } });
  });
}

for (const state of ['delivered', 'failed', 'missing', 'unsupported', 'closed', 'completed', 'other-owner'] as const) {
  test(`queued interrupt refuses ${state} state before any provider control`, { concurrency: false }, async () => {
    await withFixture(async ({ sessionId, connection, run }) => {
      run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'foreground', acceptsInput: state !== 'closed', canInterruptQueuedMessages: state !== 'unsupported', backgroundTasks: 1 });
      if (state !== 'missing') run.writer.send({ kind: 'status', text: 'message_delivery', provider: 'claude', clientMessageId: CLIENT_ID, delivery: state === 'delivered' || state === 'failed' ? state : 'queued', content: 'Original' });
      if (state === 'completed') run.writer.sendComplete({ exitCode: 0 });
      await connection.receive({ type: 'chat.interrupt', sessionId, clientMessageId: CLIENT_ID });
      assert.equal(connection.frames.at(-1)?.status, 'failed');
      assert.equal(connection.frames.at(-1)?.text, 'queued_input_interrupt');
    }, { ...(state === 'other-owner' ? { userId: 'other-user' } : {}), interruptQueued: async () => assert.fail('Unavailable queued messages must never interrupt a current reply') });
  });
}

test('task stop uses the owning runtime and reports acceptance separately from task completion', { concurrency: false }, async () => {
  const calls: unknown[][] = [];
  await withFixture(async ({ sessionId, connection, run }) => {
    run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'background', acceptsInput: true, canStopTask: true, backgroundTasks: 2 });
    await connection.receive({ type: 'chat.stop-task', sessionId, taskId: 'workflow-task', requestId: 'stop-request' });
    assert.deepEqual(calls, [['claude', sessionId, 'workflow-task']]);
    assert.deepEqual(connection.frames.at(-1), { kind: 'status', text: 'task_stop', sessionId, taskId: 'workflow-task', requestId: 'stop-request', status: 'completed' });
    assert.equal(run.status, 'running');
    assert.equal(run.runtimeState?.backgroundTasks, 2, 'Only a native notification settles the task');
  }, { stopTask: async (...args) => { calls.push(args); return true; } });
});

test('a UUID-stamped send enters the existing Claude runtime without mutating its model, effort, or run identity', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Follow-up fixture',
      options: { model: 'stale-browser-model', effort: 'low', projectPath: '/untrusted-project' } });
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0].provider, 'claude');
    assert.equal(enqueueCalls[0].sessionId, sessionId);
    assert.equal(enqueueCalls[0].command, 'Follow-up fixture');
    assert.equal(enqueueCalls[0].options.clientMessageId, CLIENT_ID);
    assert.equal(enqueueCalls[0].options.projectPath, '/tmp/queue-fixture');
    assert.equal(chatRunRegistry.getRun(sessionId), run);
    assert.equal(run.status, 'running');
    assert.equal(sessionsDb.getSessionById(sessionId)?.model, 'existing-model');
    assert.equal(sessionsDb.getSessionById(sessionId)?.effort, 'high');
    assert.equal(connection.frames.filter(frame => frame.kind === 'complete').length, 0);
  });
});

for (const rejection of ['false', 'throw'] as const) {
  test(`an enqueue ${rejection} refuses only the new send and keeps the original run active`, { concurrency: false }, async () => {
    await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
      await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Not admitted' });
      assert.equal(enqueueCalls.length, 1);
      assert.equal(chatRunRegistry.getRun(sessionId), run);
      assert.equal(run.status, 'running');
      const error = connection.frames.find(frame => frame.code === 'INPUT_NOT_ACCEPTED');
      assert.ok(error);
      assert.equal(error.clientMessageId, CLIENT_ID);
      assert.equal(error.isProcessing, true);
      assert.equal(error.runId, run.runId);
      assert.equal(error.acceptsInput, false);
      assert.equal(error.definitelyNotSubmitted, rejection === 'false' ? true : undefined);
      assert.equal(connection.frames.filter(frame => frame.kind === 'complete').length, 0);
    }, { enqueue: async () => { if (rejection === 'throw') throw new Error('fixture input closed'); return false; } });
  });
}

test('a closed-input retry with an existing receipt never claims the original message was definitely unsent', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run }) => {
    run.writer.send({ kind: 'status', text: 'message_delivery', provider: 'claude', clientMessageId: CLIENT_ID,
      sessionId, delivery: 'queued', content: 'Previously admitted', images: [], files: [] });
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Previously admitted' });
    const error = connection.frames.find(frame => frame.code === 'INPUT_NOT_ACCEPTED');
    assert.ok(error);
    assert.equal(error.definitelyNotSubmitted, undefined);
    assert.equal(run.status, 'running');
  }, { enqueue: async () => false });
});

test('invalid client UUIDs never reach the live input queue', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
    for (const clientMessageId of ['not-a-uuid', '', 42]) {
      await connection.receive({ type: 'chat.send', sessionId, clientMessageId, content: 'Invalid fixture' });
    }
    assert.equal(enqueueCalls.length, 0);
    assert.equal(connection.frames.filter(frame => frame.code === 'INVALID_MESSAGE_ID').length, 3);
    assert.equal(chatRunRegistry.getRun(sessionId), run);
    assert.equal(run.status, 'running');
  });
});

for (const outcome of ['false', 'throw'] as const) {
  test(`abort ${outcome} retains registry ownership and a manual retry enters the original input stream`, { concurrency: false }, async () => {
    await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
      run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'background', acceptsInput: true, backgroundTasks: 1 });
      await connection.receive({ type: 'chat.abort', sessionId });
      const error = connection.frames.find(frame => frame.code === 'ABORT_FAILED');
      assert.equal(error?.isProcessing, true);
      assert.equal(error?.runId, run.runId);
      assert.equal(error?.acceptsInput, true);
      assert.equal(error?.backgroundTasks, 1);
      assert.equal(run.status, 'running');
      await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Manual retry' });
      assert.equal(enqueueCalls.length, 1);
      assert.equal(chatRunRegistry.getRun(sessionId), run);
      assert.equal(connection.frames.some(frame => frame.kind === 'complete'), false);
    }, { abort: async () => { if (outcome === 'throw') throw new Error('Fixture interrupt rejected'); return false; } });
  });
}

test('a successful Claude interrupt does not release the registry before native completion', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run }) => {
    await connection.receive({ type: 'chat.abort', sessionId });
    assert.equal(run.status, 'running');
    assert.equal(connection.frames.some(frame => frame.kind === 'complete'), false);
    run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'background', acceptsInput: false, backgroundTasks: 0 });
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Retry before exit' });
    const error = connection.frames.find(frame => frame.code === 'INPUT_NOT_ACCEPTED');
    assert.equal(error?.isProcessing, true);
    assert.equal(error?.acceptsInput, false);
    assert.equal(error?.clientMessageId, CLIENT_ID);
    run.writer.sendComplete({ exitCode: 0, aborted: true });
    await connection.receive({ type: 'chat.subscribe', sessions: [{ sessionId }] });
    const ack = connection.frames.find(frame => frame.kind === 'chat_subscribed');
    assert.equal(ack?.isProcessing, false);
    assert.equal(ack?.acceptsInput, false);
  }, { abort: async () => true, enqueue: async () => false });
});

test('subscriptions expose starting, ready, closing and completed input capabilities', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run }) => {
    const subscribe = async () => {
      connection.frames = [];
      await connection.receive({ type: 'chat.subscribe', sessions: [{ sessionId, runId: run.runId, lastSeq: run.lastSeq }] });
      return connection.frames.find(frame => frame.kind === 'chat_subscribed');
    };
    assert.equal((await subscribe())?.acceptsInput, false);
    run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'background', acceptsInput: true, backgroundTasks: 1 });
    assert.equal((await subscribe())?.acceptsInput, true);
    run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'background', acceptsInput: false, backgroundTasks: 0 });
    assert.equal((await subscribe())?.acceptsInput, false);
    run.writer.sendComplete({ exitCode: 0 });
    const completed = await subscribe();
    assert.equal(completed?.isProcessing, false);
    assert.equal(completed?.acceptsInput, false);
  });
});

test('another authenticated user cannot enqueue or join the owner live stream', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Rejected other user' });
    assert.equal(enqueueCalls.length, 0);
    assert.ok(connection.frames.some(frame => frame.code === 'RUN_OWNER_MISMATCH'));
    assert.equal(run.writer.hasConnection(connection), false);
    assert.equal(chatRunRegistry.getRun(sessionId), run);
    assert.equal(run.status, 'running');
  }, { userId: 'other-user' });
});

test('queueing retains attachment validation and removes traversal, external paths, and duplicate files', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, enqueueCalls }) => {
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Fixture attachments', options: {
      images: [{ path: 'shot.png', mimeType: 'image/png' }, { path: '/etc/fixture-secret.png', mimeType: 'image/png' }],
      files: [{ path: 'brief.pdf', mimeType: 'application/pdf' }, { path: '../fixture-secret.pdf' }],
      attachments: [{ path: 'brief.pdf', mimeType: 'application/pdf' }, { path: 'nested/deep.txt' }],
    } });
    assert.equal(enqueueCalls.length, 1);
    const admitted = enqueueCalls[0].options;
    assert.deepEqual(admitted.attachments, [{ path: 'shot.png', mimeType: 'image/png' }, { path: 'brief.pdf', mimeType: 'application/pdf' }]);
    assert.deepEqual(admitted.images, [{ path: 'shot.png', mimeType: 'image/png' }]);
    assert.deepEqual(admitted.files, [{ path: 'brief.pdf', mimeType: 'application/pdf' }]);
  });
});

test('providers without a Claude input stream continue to reject competing sends', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Codex fixture' });
    assert.equal(enqueueCalls.length, 0);
    assert.ok(connection.frames.some(frame => frame.code === 'RUN_IN_PROGRESS'));
    assert.equal(chatRunRegistry.getRun(sessionId), run);
  }, { provider: 'codex' });
});

for (const delivery of ['processed', 'failed'] as const) {
  test(`a completed retry replays its ${delivery} receipt without starting another runtime or changing configuration`, { concurrency: false }, async () => {
    await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
      run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: CLIENT_ID, content: 'Original prompt', delivery });
      run.writer.sendComplete({ exitCode: delivery === 'failed' ? 1 : 0 });
      const receipt = run.messageReceipts.get(CLIENT_ID);
      assert.ok(receipt);
      connection.frames.length = 0;
      await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Original prompt', options: { model: 'stale-browser-model', effort: 'low' } });
      assert.deepEqual(connection.frames, [receipt]);
      assert.equal(enqueueCalls.length, 0);
      assert.equal(chatRunRegistry.getRun(sessionId), run);
      assert.equal(run.status, 'completed');
      assert.equal(run.writer.hasConnection(connection), false);
      assert.equal(sessionsDb.getSessionById(sessionId)?.model, 'existing-model');
      assert.equal(sessionsDb.getSessionById(sessionId)?.effort, 'high');
    });
  });
}

test('a completed retry cannot replace the content associated with an existing message UUID', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
    run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: CLIENT_ID, content: 'Private original prompt', delivery: 'processed' });
    run.writer.sendComplete({ exitCode: 0 });
    connection.frames.length = 0;
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Different prompt' });
    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0]?.code, 'MESSAGE_ID_CONFLICT');
    assert.equal(connection.frames[0]?.clientMessageId, CLIENT_ID);
    assert.equal(JSON.stringify(connection.frames).includes('Private original prompt'), false);
    assert.equal(enqueueCalls.length, 0);
    assert.equal(chatRunRegistry.getRun(sessionId), run);
    assert.equal(run.status, 'completed');
  });
});

test('another authenticated user cannot replay a completed receipt even with its UUID and prompt', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
    run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: CLIENT_ID, content: 'Private original prompt', delivery: 'processed' });
    run.writer.sendComplete({ exitCode: 0 });
    connection.frames.length = 0;
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Private original prompt' });
    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0]?.code, 'MESSAGE_ID_CONFLICT');
    assert.equal(JSON.stringify(connection.frames).includes('Private original prompt'), false);
    assert.equal(enqueueCalls.length, 0);
    assert.equal(run.writer.hasConnection(connection), false);
    assert.equal(chatRunRegistry.getRun(sessionId), run);
  }, { userId: 'other-user' });
});

test('a completed retry compares its server-validated attachments and accepts an equivalent normalized send', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
    const images = [{ path: 'shot.png', mimeType: 'image/png' }];
    const files = [{ path: 'brief.pdf', mimeType: 'application/pdf' }];
    run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: CLIENT_ID, content: 'With attachments', delivery: 'processed', images, files });
    run.writer.sendComplete({ exitCode: 0 });
    connection.frames.length = 0;
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'With attachments', options: {
      images: [...images, { path: '/etc/private.png', mimeType: 'image/png' }],
      files: [...files, { path: '../private.pdf' }],
      attachments: [...images, ...files],
    } });
    assert.deepEqual(connection.frames, [run.messageReceipts.get(CLIENT_ID)]);
    assert.equal(enqueueCalls.length, 0);
    assert.equal(chatRunRegistry.getRun(sessionId), run);
    assert.equal(run.status, 'completed');
  });
});

for (const changedAttachment of ['image', 'file', 'omitted'] as const) {
  test(`a completed retry refuses ${changedAttachment} attachment changes under the same message UUID`, { concurrency: false }, async () => {
    await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
      const images = [{ path: 'shot.png', mimeType: 'image/png' }];
      const files = [{ path: 'brief.pdf', mimeType: 'application/pdf' }];
      run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: CLIENT_ID, content: 'With attachments', delivery: 'processed', images, files });
      run.writer.sendComplete({ exitCode: 0 });
      connection.frames.length = 0;
      await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'With attachments', options: changedAttachment === 'omitted' ? {} : {
        images: changedAttachment === 'image' ? [{ path: 'different.png', mimeType: 'image/png' }] : images,
        files: changedAttachment === 'file' ? [{ path: 'different.pdf', mimeType: 'application/pdf' }] : files,
      } });
      assert.equal(connection.frames.length, 1);
      assert.equal(connection.frames[0]?.code, 'MESSAGE_ID_CONFLICT');
      assert.equal(enqueueCalls.length, 0);
      assert.equal(chatRunRegistry.getRun(sessionId), run);
      assert.equal(run.status, 'completed');
      assert.equal(run.writer.hasConnection(connection), false);
    });
  });
}

test('an unclassified runtime failure returns an uncertain failed receipt for the admitted prompt before completion', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run }) => {
    run.writer.sendComplete({ exitCode: 0 });
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Keep this user prompt' });
    const receipts = connection.frames.filter(frame => frame.text === 'message_delivery' && frame.clientMessageId === CLIENT_ID);
    assert.deepEqual(receipts.map(frame => frame.delivery), ['queued', 'failed']);
    assert.ok(receipts.every(frame => frame.content === 'Keep this user prompt'));
    assert.match(String(receipts[1].error), /Fixture launch preparation failed/);
    assert.equal(receipts[1].definitelyNotSubmitted, undefined);
    assert.ok(Number(receipts[1].seq) < Number(connection.frames.find(frame => frame.kind === 'complete')?.seq));
    assert.equal(chatRunRegistry.isProcessing(sessionId), false);
  }, { run: async () => { throw new Error('Fixture launch preparation failed'); } });
});

test('a settings rejection before native dispatch produces a definitely unsent receipt, preserved across reconnect and UUID retry', { concurrency: false }, async () => {
  let runtimeCalls = 0;
  await withFixture(async ({ sessionId, connection, run }) => {
    run.writer.sendComplete({ exitCode: 0 });
    const send = { type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Preserve this rejected prompt' };
    await connection.receive(send);
    const receipts = connection.frames.filter(frame => frame.text === 'message_delivery' && frame.clientMessageId === CLIENT_ID);
    assert.deepEqual(receipts.map(frame => frame.delivery), ['queued', 'failed']);
    assert.equal(receipts[1].definitelyNotSubmitted, true);
    assert.equal(receipts[1].code, 'UNSUPPORTED_EXECUTION_SETTINGS');
    assert.equal(receipts[1].content, send.content);
    assert.equal(chatRunRegistry.isProcessing(sessionId), false);

    connection.frames = [];
    await connection.receive({ type: 'chat.subscribe', sessions: [{ sessionId }] });
    const finalReceipt = connection.frames.find(frame => frame.kind === 'chat_subscribed')?.messageReceipts[0];
    assert.equal(finalReceipt?.delivery, 'failed');
    assert.equal(finalReceipt?.definitelyNotSubmitted, true);
    connection.frames = [];
    await connection.receive(send);
    assert.equal(runtimeCalls, 1, 'a UUID retry replays its original result without resubmitting');
    assert.equal(connection.frames[0]?.definitelyNotSubmitted, true);
  }, { run: async () => {
    runtimeCalls++;
    throw new ProviderRunPreparationError(new AppError('Synthetic settings rejection', { code: 'UNSUPPORTED_EXECUTION_SETTINGS', statusCode: 409 }));
  } });
});

test('gateway preparation failures are definitely unsent without invoking a provider runtime', { concurrency: false }, async context => {
  context.mock.method(sessionsService, 'initializeAppSessionName', () => { throw new Error('Synthetic metadata preparation failed'); });
  let runtimeCalls = 0;
  await withFixture(async ({ sessionId, connection, run }) => {
    run.writer.sendComplete({ exitCode: 0 });
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Retain synthetic input' });
    const failed = connection.frames.find(frame => frame.text === 'message_delivery' && frame.delivery === 'failed');
    assert.equal(failed?.definitelyNotSubmitted, true);
    assert.equal(runtimeCalls, 0);
  }, { run: async () => { runtimeCalls++; } });
});

test('a runtime error after native delivery cannot relabel the acknowledged prompt as unsent', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run }) => {
    run.writer.sendComplete({ exitCode: 0 });
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Native acknowledged input' });
    const receipts = connection.frames.filter(frame => frame.text === 'message_delivery');
    assert.deepEqual(receipts.map(frame => frame.delivery), ['queued', 'delivered']);
    assert.ok(receipts.every(frame => !frame.definitelyNotSubmitted));
    assert.equal(chatRunRegistry.getRun(sessionId)?.messageReceipts.get(CLIENT_ID)?.delivery, 'delivered');
  }, { run: async (_provider, content, options, writer) => {
    writer.send({ kind: 'status', text: 'message_delivery', provider: 'claude', sessionId: options.sessionId,
      clientMessageId: CLIENT_ID, content, delivery: 'delivered' });
    throw new Error('Synthetic failure after acknowledgement');
  } });
});

test('delivery confirmation outranks later failures and clears any stale definitely-unsent classification', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, run }) => {
    const receipt = { kind: 'status', text: 'message_delivery', provider: 'claude', sessionId, clientMessageId: CLIENT_ID, content: 'Synthetic delivery transitions' };
    run.writer.send({ ...receipt, delivery: 'failed', definitelyNotSubmitted: true });
    run.writer.send({ ...receipt, delivery: 'queued' });
    assert.equal(run.messageReceipts.get(CLIENT_ID)?.definitelyNotSubmitted, true);
    run.writer.send({ ...receipt, delivery: 'delivered' });
    assert.equal(run.messageReceipts.get(CLIENT_ID)?.definitelyNotSubmitted, undefined);
    run.writer.send({ ...receipt, delivery: 'failed', definitelyNotSubmitted: true });
    assert.equal(run.messageReceipts.get(CLIENT_ID)?.delivery, 'delivered');
    assert.equal(run.messageReceipts.get(CLIENT_ID)?.definitelyNotSubmitted, undefined);
  });
});

test('a completed run returns final delivery receipts on subscribe without replaying old assistant content', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run }) => {
    run.writer.send({ kind: 'status', text: 'message_delivery', provider: 'claude', clientMessageId: CLIENT_ID, content: 'Retain me after reconnect', delivery: 'queued' });
    run.writer.send({ kind: 'text', role: 'assistant', provider: 'claude', content: 'Already saved assistant response' });
    run.writer.sendComplete({ exitCode: 1 });
    await connection.receive({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
    const ack = connection.frames.find(frame => frame.kind === 'chat_subscribed');
    assert.equal(ack?.isProcessing, false);
    assert.equal(ack?.messageReceipts.length, 1);
    assert.equal(ack?.messageReceipts[0].clientMessageId, CLIENT_ID);
    assert.equal(ack?.messageReceipts[0].delivery, 'failed');
    assert.equal(connection.frames.some(frame => frame.role === 'assistant'), false);
  });
});


test('subscribe replays the new run from zero when a client carries an older run sequence cursor', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run }) => {
    run.writer.send({ kind: 'text', provider: 'claude', role: 'assistant', content: 'First new run frame' });
    run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: CLIENT_ID, delivery: 'queued', content: 'Fixture' });
    await connection.receive({ type: 'chat.subscribe', sessions: [{ sessionId, runId: 'previous-run', lastSeq: 900 }] });
    const ack = connection.frames.find(frame => frame.kind === 'chat_subscribed')!;
    assert.equal(ack.runId, run.runId);
    assert.equal(ack.runStartedAt, run.startedAt);
    assert.equal(connection.frames.some(frame => frame.content === 'First new run frame' && frame.runId === run.runId), true);
    connection.frames = [];
    await connection.receive({ type: 'chat.subscribe', sessions: [{ sessionId, runId: run.runId, lastSeq: 1 }] });
    assert.equal(connection.frames.some(frame => frame.content === 'First new run frame'), false);
    assert.equal(connection.frames.some(frame => frame.text === 'message_delivery' && frame.seq === 2), true);
  });
});


test('an explicitly supported interrupt-and-send forwards the mode through the same active runtime', { concurrency: false }, async () => {
  await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
    run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'foreground', acceptsInput: true, inputModes: ['queue', 'interrupt'], backgroundTasks: 1 });
    await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Interrupt and send', options: { deliveryMode: 'interrupt' } });
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0].options.deliveryMode, 'interrupt');
    assert.equal(chatRunRegistry.getRun(sessionId), run);
    assert.equal(run.status, 'running');
    assert.equal(connection.frames.some(frame => frame.kind === 'complete'), false);
    await connection.receive({ type: 'chat.subscribe', sessions: [{ sessionId }] });
    assert.deepEqual(connection.frames.find(frame => frame.kind === 'chat_subscribed')?.inputModes, ['queue', 'interrupt']);
    assert.deepEqual(chatRunRegistry.listRunningRuns()[0].inputModes, ['queue', 'interrupt']);
  });
});

for (const invalid of ['later', 'now', '', null, 1, {}]) {
  test(`invalid delivery mode ${JSON.stringify(invalid)} never reaches a runtime`, { concurrency: false }, async () => {
    await withFixture(async ({ sessionId, connection, enqueueCalls }) => {
      await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Invalid mode', options: { deliveryMode: invalid } });
      assert.equal(enqueueCalls.length, 0);
      assert.equal(connection.frames.at(-1)?.code, 'INVALID_DELIVERY_MODE');
    });
  });
}

for (const unavailable of ['unadvertised', 'completed', 'closed'] as const) {
  test(`interrupt-and-send cannot replace an ${unavailable} process`, { concurrency: false }, async () => {
    await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
      if (unavailable !== 'unadvertised') run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'background', acceptsInput: false, inputModes: ['queue', 'interrupt'], backgroundTasks: 1 });
      if (unavailable === 'completed') run.writer.sendComplete({ exitCode: 0 });
      await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Not accepted', options: { deliveryMode: 'interrupt' } });
      assert.equal(enqueueCalls.length, unavailable === 'closed' ? 1 : 0);
      const error = connection.frames.find(frame => frame.code === 'INPUT_NOT_ACCEPTED');
      assert.equal(error?.clientMessageId, CLIENT_ID);
      assert.equal(error?.acceptsInput, false);
      assert.equal(chatRunRegistry.getRun(sessionId), run);
    }, { enqueue: async () => false });
  });
}

for (const kind of ['missing-uuid', 'empty', 'edit', 'other-provider'] as const) {
  test(`interrupt-and-send rejects ${kind} without abort or new runtime`, { concurrency: false }, async () => {
    await withFixture(async ({ sessionId, connection, enqueueCalls }) => {
      await connection.receive({ type: kind === 'edit' ? 'chat.edit-send' : 'chat.send', sessionId, anchorId: 'unused',
        ...(kind === 'missing-uuid' ? {} : { clientMessageId: CLIENT_ID }), content: kind === 'empty' ? ' ' : 'Fixture', options: { deliveryMode: 'interrupt' } });
      assert.equal(enqueueCalls.length, 0);
      assert.equal(connection.frames.at(-1)?.code, 'INTERRUPT_NOT_SUPPORTED');
    }, { provider: kind === 'other-provider' ? 'codex' : 'claude' });
  });
}

for (const completed of [false, true]) {
  test(`a ${completed ? 'completed' : 'running'} UUID cannot upgrade its delivery mode`, { concurrency: false }, async () => {
    await withFixture(async ({ sessionId, connection, run, enqueueCalls }) => {
      run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'foreground', acceptsInput: true, inputModes: ['queue', 'interrupt'], backgroundTasks: 1 });
      run.writer.send({ kind: 'status', text: 'message_delivery', provider: 'claude', clientMessageId: CLIENT_ID, delivery: 'queued', deliveryMode: 'queue', content: 'Same original prompt' });
      if (completed) run.writer.sendComplete({ exitCode: 0 });
      await connection.receive({ type: 'chat.send', sessionId, clientMessageId: CLIENT_ID, content: 'Same original prompt', options: { deliveryMode: 'interrupt' } });
      assert.equal(enqueueCalls.length, 0);
      assert.equal(connection.frames.at(-1)?.code, 'MESSAGE_ID_CONFLICT');
    });
  });
}
