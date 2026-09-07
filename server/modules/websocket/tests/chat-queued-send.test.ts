import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import type { AnyRecord, AuthenticatedWebSocketRequest, LLMProvider } from '@/shared/types.js';

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
}) => Promise<void>, options: { userId?: string; ownerId?: string; enqueue?: () => Promise<boolean>; provider?: LLMProvider } = {}): Promise<void> {
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
      run: async () => assert.fail('A queued send must never start another runtime'),
      abort: async () => assert.fail('A queued send must never stop the current runtime'),
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
      assert.equal(connection.frames.filter(frame => frame.kind === 'complete').length, 0);
    }, { enqueue: async () => { if (rejection === 'throw') throw new Error('fixture input closed'); return false; } });
  });
}

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
