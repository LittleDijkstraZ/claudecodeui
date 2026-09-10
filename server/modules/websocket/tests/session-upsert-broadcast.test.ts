import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { sessionsService } from '@/modules/providers/index.js';
import type { FetchHistoryResult } from '@/shared/types.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  broadcastSessionUpserted,
  broadcastSessionUpsertedBatch,
} from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-upsert-broadcast-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('an upsert always carries the provider session id', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-1', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-1', 'native-1');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('app-1');

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].kind, 'session_upserted');
    assert.equal(connection.frames[0].sessionId, 'app-1');
    assert.equal(connection.frames[0].providerSessionId, 'native-1');
  });
});

test('the watcher path resolves a provider-native id to the same canonical event', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-2', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-2', 'native-2');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    // The sessions watcher only ever knows the id written in the transcript.
    await broadcastSessionUpsertedBatch(['native-2']);

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].sessionId, 'app-2');
    assert.equal(connection.frames[0].providerSessionId, 'native-2');
  });
});

test('a session with no provider id yet reports null rather than omitting the field', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-3', 'claude', '/workspace/demo');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('app-3');

    assert.equal(connection.frames.length, 1);
    assert.ok('providerSessionId' in connection.frames[0]);
    assert.equal(connection.frames[0].providerSessionId, null);
  });
});

test('an unresolvable id broadcasts nothing', async () => {
  await withIsolatedDatabase(async () => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('does-not-exist');
    await broadcastSessionUpsertedBatch(['also-missing']);

    assert.deepEqual(connection.frames, []);
  });
});

test('a batch delivers every resolvable session and skips the rest', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-4', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-5', 'claude', '/workspace/demo');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpsertedBatch(['app-4', 'missing', 'app-5']);

    assert.deepEqual(
      connection.frames.map((frame) => frame.sessionId),
      ['app-4', 'app-5'],
    );
  });
});

test('a closed socket is skipped', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-6', 'claude', '/workspace/demo');

    const open = new FakeConnection();
    const closing = new FakeConnection();
    closing.readyState = 3;
    connectedClients.add(open as never);
    connectedClients.add(closing as never);

    await broadcastSessionUpserted('app-6');

    assert.equal(open.frames.length, 1);
    assert.deepEqual(closing.frames, []);
  });
});


test('watcher updates carry stable content versions and real counts; metadata updates do not', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-content', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-content', 'native-content');
    let text = 'A new reply';
    let reads = 0;
    const history = mock.method(sessionsService, 'fetchHistory', async (): Promise<FetchHistoryResult> => ({
      messages: [{ id: `display-${++reads}`, sessionId: 'app-content', provider: 'claude', kind: 'text',
        role: 'assistant', text, timestamp: '2026-09-09T00:00:00Z' }],
      total: 4, hasMore: true, offset: 0, limit: 1,
    }));
    try {
      const connection = new FakeConnection();
      connectedClients.add(connection as never);
      await broadcastSessionUpserted('app-content');
      assert.equal(connection.frames[0].transcriptVersion, undefined);
      assert.equal(history.mock.callCount(), 0);
      await broadcastSessionUpsertedBatch(['native-content']);
      const first = connection.frames[1];
      assert.match(String(first.transcriptVersion), /^[a-f0-9]{64}$/);
      assert.equal((first.session as { messageCount: number }).messageCount, 4);
      await broadcastSessionUpsertedBatch(['native-content']);
      assert.equal(connection.frames[2].transcriptVersion, first.transcriptVersion);
      text = 'Another reply with the same message count';
      await broadcastSessionUpsertedBatch(['native-content']);
      assert.notEqual(connection.frames[3].transcriptVersion, first.transcriptVersion);
      assert.equal(JSON.stringify(connection.frames).includes(text), false);
    } finally { history.mock.restore(); }
  });
});

test('unread detection failure does not prevent other watcher metadata updates', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-missing-history', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-missing-history', 'native-missing-history');
    const history = mock.method(sessionsService, 'fetchHistory', async () => { throw new Error('partial transcript'); });
    try {
      const connection = new FakeConnection();
      connectedClients.add(connection as never);
      await broadcastSessionUpsertedBatch(['native-missing-history']);
      assert.equal(connection.frames.length, 1);
      assert.equal(connection.frames[0].transcriptVersion, undefined);
    } finally { history.mock.restore(); }
  });
});
