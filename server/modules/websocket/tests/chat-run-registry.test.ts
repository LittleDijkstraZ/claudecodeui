import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * gateway writer forwards so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-registry-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  // A fresh fixture must not trigger migration from an existing install database.
  await writeFile(process.env.DATABASE_PATH!, '');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('live events are remapped to the app session id and sequenced', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'provider-id-9', content: 'hello' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'provider-id-9', content: 'hello world' });

    assert.equal(connection.frames.length, 2);
    assert.equal(connection.frames[0]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[1]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[1]?.seq, 2);
  });
});

test('session_created is swallowed and persisted as the provider-id mapping', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-run-2', 'cursor', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-2',
      provider: 'cursor',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'cursor',
      sessionId: 'cursor-native-7',
      newSessionId: 'cursor-native-7',
    });

    // The upsert is broadcast without blocking the run: resolving the owning
    // project's display name is async, so let that settle before asserting.
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The provider-native event itself is never forwarded...
    const sessionUpserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.equal(sessionUpserts.length, 1);
    assert.equal(sessionUpserts[0]?.sessionId, 'app-run-2');
    assert.equal(sessionUpserts[0]?.providerSessionId, 'cursor-native-7');
    // ...but the canonical mapping is recorded and persisted in the database.
    assert.equal(run.providerSessionId, 'cursor-native-7');
    assert.equal(sessionsDb.getSessionById('app-run-2')?.provider_session_id, 'cursor-native-7');
  });
});

test('complete marks the run finished and duplicate completes are dropped', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-3', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-3',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 0 });
    // Late duplicate from a killed runtime's exit handler.
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 1 });

    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.actualSessionId, 'app-run-3');
    assert.equal(chatRunRegistry.isProcessing('app-run-3'), false);

    // completeRun is also a no-op once the run already completed.
    chatRunRegistry.completeRun('app-run-3', { exitCode: 1 });
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

test('a finished run\'s safety net cannot complete the session\'s next run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-9', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-9', exitCode: 0 });

    // A queued message starts the next run before the first run's runtime
    // promise settles (the chat handler's `finally` hasn't executed yet).
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);

    // First run's safety net fires late: it must not touch the new run.
    chatRunRegistry.completeRunIfCurrent(firstRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);

    // The second run's own safety net still works while it is current.
    chatRunRegistry.completeRunIfCurrent(secondRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), false);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('listRunningRuns returns only currently running app sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-run-8', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const completedRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(completedRun);

    const runningRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-8',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(runningRun);

    chatRunRegistry.completeRun('app-run-7', { exitCode: 0 });

    const runningSessions = chatRunRegistry.listRunningRuns();
    assert.deepEqual(runningSessions.map((session) => session.sessionId), ['app-run-8']);
    assert.equal(runningSessions[0]?.provider, 'codex');
  });
});

test('replayEvents returns only events after the requested seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-4',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'c' });

    const replayed = chatRunRegistry.replayEvents('app-run-4', 1);
    assert.deepEqual(replayed.map((event) => event.content), ['b', 'c']);
    assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
  });
});

test('Workflow replay keeps one full snapshot per task while preserving every progress event', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('workflow-snapshot-replay', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({ appSessionId: 'workflow-snapshot-replay', provider: 'claude', providerSessionId: null, connection, userId: null });
    assert.ok(run);
    const send = (taskId: string, text: string, title?: string) => run.writer.send({
      kind: 'status', provider: 'claude', workflow: true, taskId, text,
      ...(title ? { workflowProgress: [{ type: 'workflow_phase', index: 0, title }], workflowProgressTruncated: false } : {}),
    });
    send('task-a', 'Started A', 'A before');
    send('task-b', 'Started B', 'B current');
    send('task-a', 'A latest', 'A current');
    send('task-a', 'A heartbeat');
    const events = chatRunRegistry.replayEvents('workflow-snapshot-replay', 0);
    assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4]);
    assert.deepEqual(events.map(event => event.text), ['Started A', 'Started B', 'A latest', 'A heartbeat']);
    assert.equal(events[0].workflowProgress, undefined);
    assert.equal(events[0].workflowProgressTruncated, undefined);
    assert.deepEqual(events[1].workflowProgress, [{ type: 'workflow_phase', index: 0, title: 'B current' }]);
    assert.deepEqual(events[2].workflowProgress, [{ type: 'workflow_phase', index: 0, title: 'A current' }]);
    assert.equal(events[3].workflowProgress, undefined);
    assert.deepEqual(connection.frames[0].workflowProgress, [{ type: 'workflow_phase', index: 0, title: 'A before' }], 'Already emitted frames are unchanged.');
    assert.deepEqual(chatRunRegistry.replayEvents('workflow-snapshot-replay', 2).map(event => event.seq), [3, 4]);
  });
});

test('attachConnection adds a socket without cutting off the ones already watching', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'opencode', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5',
      provider: 'opencode',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'before' });

    // A second tab on the same session subscribes mid-run.
    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5', secondConnection), true);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });

    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before', 'after']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after']);
  });
});

test('a refreshed tab stops receiving once its old socket is closed', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5b', 'opencode', '/workspace/demo');
    const staleConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5b',
      provider: 'opencode',
      providerSessionId: null,
      connection: staleConnection,
      userId: null,
    });
    assert.ok(run);

    // The page reloads: the original socket closes and the fresh one subscribes.
    staleConnection.readyState = 3;
    const reloadedConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5b', reloadedConnection), true);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'later' });

    assert.deepEqual(staleConnection.frames, []);
    assert.deepEqual(reloadedConnection.frames.map((frame) => frame.content), ['after', 'later']);
  });
});

test('startRun rejects a second concurrent run for the same session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(first);

    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.equal(second, null);

    // After the run finishes a new one is allowed again.
    chatRunRegistry.completeRun('app-run-6', { exitCode: 0 });
    const third = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(third);
  });
});

test('same-user activity observers receive metadata without replacing the active writer or reading its stream', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('activity-main', 'claude', '/workspace/demo');
    const active = new FakeConnection();
    const observer = new FakeConnection();
    const otherUser = new FakeConnection();
    const unknownUser = new FakeConnection();
    for (const connection of [active, observer, otherUser, unknownUser]) connectedClients.add(connection as never);
    chatRunRegistry.registerActivityObserver(active, 7);
    chatRunRegistry.registerActivityObserver(observer, '7');
    chatRunRegistry.registerActivityObserver(otherUser, 8);
    const run = chatRunRegistry.startRun({ appSessionId: 'activity-main', provider: 'claude', providerSessionId: null, connection: active, userId: 7 });
    assert.ok(run);
    assert.equal(observer.frames[0]?.status, 'running');
    assert.equal(observer.frames[0]?.seq, 0);
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'native', content: 'Private prompt and response' });
    run.writer.send({ kind: 'permission_request', provider: 'claude', sessionId: 'native', toolName: 'Bash', input: { command: 'private command' }, requestId: 'approval-secret' });
    assert.equal(run.writer.hasConnection(active), true);
    assert.equal(run.writer.hasConnection(observer), false);
    assert.equal(active.frames.length, 2);
    assert.equal(observer.frames.length, 2);
    // An explicitly subscribed second view receives the same stream while the
    // hub's metadata observer remains outside the run's audience.
    const secondView = new FakeConnection();
    connectedClients.add(secondView as never);
    chatRunRegistry.registerActivityObserver(secondView, 7);
    assert.equal(chatRunRegistry.attachConnection('activity-main', secondView), true);
    run.writer.sendComplete({ exitCode: 0 });
    run.writer.sendComplete({ exitCode: 1 });
    assert.deepEqual(observer.frames.map(frame => frame.status), ['running', 'permission', 'complete']);
    assert.deepEqual(observer.frames.map(frame => frame.isProcessing), [true, true, false]);
    assert.deepEqual(observer.frames.map(frame => frame.seq), [0, 2, 3]);
    assert.equal(new Set(observer.frames.map(frame => frame.runId)).size, 1);
    assert.equal(new Set(observer.frames.map(frame => frame.eventId)).size, 3);
    for (const frame of observer.frames) {
      assert.deepEqual(Object.keys(frame).sort(), ['eventId', 'isProcessing', 'kind', 'provider', 'runId', 'seq', 'sessionId', 'status']);
      assert.equal(frame.kind, 'session_activity'); assert.equal(frame.sessionId, 'activity-main');
    }
    assert.equal(JSON.stringify(observer.frames).includes('private'), false);
    assert.deepEqual(otherUser.frames, []); assert.deepEqual(unknownUser.frames, []);
    assert.equal(active.frames.filter(frame => frame.kind === 'complete').length, 1);
    assert.equal(secondView.frames.length, 1);
    assert.equal(secondView.frames[0]?.kind, 'complete');
  });
});

test('an error and terminal completion carry distinct running states and a new run gets a fresh identity', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('activity-error', 'claude', '/workspace/demo');
    const active = new FakeConnection(); const observer = new FakeConnection();
    connectedClients.add(observer as never); chatRunRegistry.registerActivityObserver(observer, 1);
    const input = { appSessionId: 'activity-error', provider: 'claude' as const, providerSessionId: null, connection: active, userId: 1 };
    const first = chatRunRegistry.startRun(input); assert.ok(first);
    first.writer.send({ kind: 'error', provider: 'claude', content: 'Private diagnostic' });
    first.writer.sendComplete({ exitCode: 1 });
    first.writer.sendComplete({ exitCode: 1 });
    assert.deepEqual(observer.frames.map(frame => frame.status), ['running', 'error', 'error']);
    assert.deepEqual(observer.frames.map(frame => frame.isProcessing), [true, true, false]);
    const oldRunId = observer.frames[0]?.runId;
    const second = chatRunRegistry.startRun(input); assert.ok(second);
    assert.notEqual(observer.frames.at(-1)?.runId, oldRunId);
    // An old runtime winding down cannot publish activity for the replacement.
    first.writer.send({ kind: 'error', provider: 'claude', content: 'Late old failure' });
    assert.equal(observer.frames.length, 4);
    second.writer.sendComplete({ exitCode: 2 });
    assert.deepEqual(observer.frames.map(frame => frame.status), ['running', 'error', 'error', 'running', 'error']);
    assert.deepEqual(observer.frames.map(frame => frame.isProcessing), [true, true, false, true, false]);
    assert.equal(JSON.stringify(observer.frames).includes('diagnostic'), false);
  });
});

test('a recoverable error preserves the active run and queued receipts until a later successful completion', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('activity-recovered', 'claude', '/workspace/demo');
    const observer = new FakeConnection();
    connectedClients.add(observer as never);
    chatRunRegistry.registerActivityObserver(observer, 1);
    const run = chatRunRegistry.startRun({ appSessionId: 'activity-recovered', provider: 'claude', providerSessionId: null, connection: null, userId: 1 });
    assert.ok(run);
    run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: 'queued-after-error', content: 'Follow up', delivery: 'queued' });
    run.writer.send({ kind: 'error', provider: 'claude', content: 'Temporary API failure' });
    assert.equal(run.status, 'running');
    assert.equal(chatRunRegistry.isProcessing('activity-recovered'), true);
    assert.equal(run.messageReceipts.get('queued-after-error')?.delivery, 'queued');
    assert.deepEqual(observer.frames.map(frame => [frame.status, frame.isProcessing]), [['running', true], ['error', true]]);
    run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: 'queued-after-error', content: 'Follow up', delivery: 'processed' });
    run.writer.sendComplete({ exitCode: 0 });
    run.writer.sendComplete({ exitCode: 0 });
    assert.equal(run.status, 'completed');
    assert.equal(chatRunRegistry.isProcessing('activity-recovered'), false);
    assert.equal(run.messageReceipts.get('queued-after-error')?.delivery, 'processed');
    assert.deepEqual(observer.frames.map(frame => [frame.status, frame.isProcessing]), [['running', true], ['error', true], ['complete', false]]);
    assert.equal(JSON.stringify(observer.frames).includes('Temporary API failure'), false);
  });
});

test('unidentified runs cannot broadcast activity to authenticated observers', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('activity-unknown', 'claude', '/workspace/demo');
    const observer = new FakeConnection(); connectedClients.add(observer as never);
    chatRunRegistry.registerActivityObserver(observer, 1);
    const run = chatRunRegistry.startRun({ appSessionId: 'activity-unknown', provider: 'claude', providerSessionId: null, connection: new FakeConnection(), userId: null });
    assert.ok(run); run.writer.sendComplete({ exitCode: 0 });
    assert.deepEqual(observer.frames, []);
  });
});

test('pending delivery receipts survive stream-buffer eviction and replay in sequence order', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('receipt-retained', 'claude', '/workspace/demo');
    const run = chatRunRegistry.startRun({ appSessionId: 'receipt-retained', provider: 'claude', providerSessionId: null, connection: null, userId: 1 });
    assert.ok(run);
    run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: 'pending-input', content: 'Follow up', delivery: 'queued' });
    for (let index = 0; index < 5_005; index += 1) run.writer.send({ kind: 'text', provider: 'claude', content: `stream ${index}` });
    assert.equal(run.events.length, 5_000);
    assert.equal(run.events.some(event => event.clientMessageId === 'pending-input'), false);
    const replay = chatRunRegistry.replayEvents('receipt-retained', 0);
    assert.equal(replay.length, 5_001);
    assert.equal(replay[0]?.clientMessageId, 'pending-input');
    assert.equal(replay[0]?.delivery, 'queued');
    assert.deepEqual(replay.map(event => event.seq), [...replay.map(event => event.seq)].sort((a, b) => a! - b!));
    assert.equal(new Set(replay.map(event => event.seq)).size, replay.length);
    assert.equal(chatRunRegistry.replayEvents('receipt-retained', 1).some(event => event.clientMessageId === 'pending-input'), false);
  });
});

test('receipt replay keeps the latest delivery outside the buffer and does not duplicate buffered receipts', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('receipt-latest', 'claude', '/workspace/demo');
    const run = chatRunRegistry.startRun({ appSessionId: 'receipt-latest', provider: 'claude', providerSessionId: null, connection: null, userId: 1 });
    assert.ok(run);
    for (const delivery of ['queued', 'delivered', 'queued']) run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: 'old-input', content: 'Original', delivery });
    for (let index = 0; index < 5_001; index += 1) run.writer.send({ kind: 'text', provider: 'claude', content: `stream ${index}` });
    run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: 'new-input', content: 'New', delivery: 'queued' });
    run.writer.sendComplete({ exitCode: 0 });
    const replay = chatRunRegistry.replayEvents('receipt-latest', 0);
    assert.equal(run.status, 'completed');
    assert.deepEqual(replay.filter(event => event.clientMessageId === 'old-input').map(event => event.delivery), ['delivered']);
    assert.deepEqual(replay.filter(event => event.clientMessageId === 'new-input').map(event => event.delivery), ['queued', 'failed']);
    assert.equal(replay.at(-1)?.kind, 'complete');
    assert.equal(new Set(replay.map(event => event.seq)).size, replay.length);
  });
});

test('receipt history evicts settled inputs before queued inputs at its retention limit', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('receipt-limit', 'claude', '/workspace/demo');
    const run = chatRunRegistry.startRun({ appSessionId: 'receipt-limit', provider: 'claude', providerSessionId: null, connection: null, userId: 1 });
    assert.ok(run);
    run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: 'still-pending', content: 'Pending', delivery: 'queued' });
    for (let index = 0; index < 130; index += 1) run.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: `settled-${index}`, content: `Message ${index}`, delivery: 'processed' });
    assert.equal(run.messageReceipts.size, 128);
    assert.equal(run.messageReceipts.has('still-pending'), true);
    assert.equal(run.messageReceipts.has('settled-0'), false);
    assert.equal(run.messageReceipts.has('settled-2'), false);
    assert.equal(run.messageReceipts.has('settled-3'), true);
    assert.equal(run.messageReceipts.has('settled-129'), true);
  });
});

test('starting a replacement run does not reuse a completed run receipt history', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('receipt-replacement', 'claude', '/workspace/demo');
    const input = { appSessionId: 'receipt-replacement', provider: 'claude' as const, providerSessionId: null, connection: null, userId: 1 };
    const first = chatRunRegistry.startRun(input);
    assert.ok(first);
    first.writer.send({ kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: 'old-input', content: 'Old', delivery: 'processed' });
    first.writer.sendComplete({ exitCode: 0 });
    const second = chatRunRegistry.startRun(input);
    assert.ok(second);
    assert.equal(second.messageReceipts.size, 0);
    assert.deepEqual(chatRunRegistry.replayEvents('receipt-replacement', 0), []);
    assert.equal(first.messageReceipts.get('old-input')?.delivery, 'processed');
  });
});

test('completion fails unconfirmed input while preserving delivered receipts and replay content', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('receipt-exit', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({ appSessionId: 'receipt-exit', provider: 'claude', providerSessionId: null, connection, userId: 'user-1' })!;
    for (const delivery of ['queued', 'delivered'] as const) run.writer.send({ kind: 'status', text: 'message_delivery', provider: 'claude', clientMessageId: delivery, content: delivery+' prompt', delivery });
    run.writer.sendComplete({ exitCode: 1 });
    assert.equal(run.messageReceipts.get('queued')?.delivery, 'failed');
    assert.equal(run.messageReceipts.get('delivered')?.delivery, 'delivered');
    assert.equal(run.messageReceipts.get('queued')?.content, 'queued prompt');
    assert.deepEqual(connection.frames.slice(-2).map(frame => frame.kind === 'complete' ? 'complete' : frame.delivery), ['failed', 'complete']);
    assert.equal(chatRunRegistry.replayEvents('receipt-exit', 0).filter(frame => frame.delivery === 'failed').length, 1);
  });
});


test('an older completion eviction timer cannot remove a newer run or its delivery receipts', async context => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('eviction-owner', 'claude', '/workspace/demo');
    const callbacks: Array<() => void> = [];
    context.mock.method(globalThis, 'setTimeout', (callback: () => void) => { callbacks.push(callback); return { unref() {} }; });
    const first = chatRunRegistry.startRun({ appSessionId: 'eviction-owner', provider: 'claude', providerSessionId: null, connection: null, userId: 1 })!;
    first.writer.sendComplete({ exitCode: 0 });
    const next = chatRunRegistry.startRun({ appSessionId: 'eviction-owner', provider: 'claude', providerSessionId: null, connection: null, userId: 1 })!;
    next.writer.send({ kind: 'status', text: 'message_delivery', provider: 'claude', clientMessageId: 'new-send', delivery: 'queued', content: 'Fixture' });
    next.writer.sendComplete({ exitCode: 0 });
    callbacks[0]();
    assert.equal(chatRunRegistry.getRun('eviction-owner'), next);
    assert.equal(next.messageReceipts.get('new-send')?.delivery, 'failed');
    callbacks[1]();
    assert.equal(chatRunRegistry.getRun('eviction-owner'), undefined);
    context.mock.restoreAll();
  });
});

test('late admission receipts preserve exact native and response bindings and terminal explanation', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('receipt-binding', 'claude', '/workspace/demo');
    const run = chatRunRegistry.startRun({ appSessionId: 'receipt-binding', provider: 'claude', providerSessionId: null, connection: null, userId: 1 })!;
    const base = { kind: 'status', provider: 'claude', text: 'message_delivery', clientMessageId: 'client-send', content: 'Fixture' };
    run.writer.send({ ...base, delivery: 'delivered', transcriptAnchorId: 'native-id', responseMessageId: 'api-id' });
    run.writer.send({ ...base, delivery: 'queued' });
    const retained = run.messageReceipts.get('client-send')!;
    assert.equal(retained.delivery, 'delivered');
    assert.equal(retained.transcriptAnchorId, 'native-id');
    assert.equal(retained.responseMessageId, 'api-id');
    run.writer.send({ ...base, clientMessageId: 'failed-send', delivery: 'failed', error: 'Input stream closed' });
    run.writer.send({ ...base, clientMessageId: 'failed-send', delivery: 'queued' });
    assert.equal(run.messageReceipts.get('failed-send')?.error, 'Input stream closed');
  });
});


test('a forgotten or replaced run cannot publish late delivery into the replacement context', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('stale-writer', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({ appSessionId: 'stale-writer', provider: 'claude', providerSessionId: 'native-old', connection, userId: 1 })!;
    first.writer.sendComplete({ exitCode: 0 });
    chatRunRegistry.forgetCompletedRun('stale-writer');
    const before = connection.frames.length;
    const late = { kind: 'status', text: 'message_delivery', provider: 'claude', clientMessageId: 'old-send', delivery: 'delivered', content: 'Fixture' };
    first.writer.send(late);
    assert.equal(connection.frames.length, before);
    const next = chatRunRegistry.startRun({ appSessionId: 'stale-writer', provider: 'claude', providerSessionId: 'native-new', connection, userId: 1 })!;
    const afterStart = connection.frames.length;
    first.writer.send(late);
    assert.equal(connection.frames.length, afterStart);
    assert.equal(next.lastSeq, 0);
    assert.equal(next.messageReceipts.size, 0);
    next.writer.send({ ...late, clientMessageId: 'new-send' });
    assert.equal(next.messageReceipts.get('new-send')?.delivery, 'delivered');
    next.writer.setSessionId('native-current');
    first.writer.setSessionId('native-late-old');
    assert.equal(sessionsDb.getSessionById('stale-writer')?.provider_session_id, 'native-current');
  });
});
