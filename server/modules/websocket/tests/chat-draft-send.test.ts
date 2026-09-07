import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

import { chatRunRegistry } from '../services/chat-run-registry.service.js';
import { handleChatConnection } from '../services/chat-websocket.service.js';
import { connectedClients } from '../services/websocket-state.service.js';

type RuntimeGateway = Parameters<typeof handleChatConnection>[2]['runtime'];

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, (data: string) => unknown>();

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  on(event: string, listener: (data: string) => unknown): this {
    this.listeners.set(event, listener);
    return this;
  }

  async receive(message: Record<string, unknown>): Promise<void> {
    await this.listeners.get('message')?.(JSON.stringify(message));
  }
}

function connect(runtime: RuntimeGateway): FakeConnection {
  const connection = new FakeConnection();
  handleChatConnection(
    connection as unknown as WebSocket,
    { user: { id: 'test-user' } } as unknown as AuthenticatedWebSocketRequest,
    { runtime },
  );
  return connection;
}

function createRuntime(run: RuntimeGateway['run']): RuntimeGateway {
  return {
    hasRuntime: () => true,
    run,
    abort: async () => false,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  };
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-draft-send-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

test('first draft send names the existing app row and starts its stored provider without resuming another history', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const draft = sessionsService.createAppSession('claude', '/tmp/group-chat-project');
    let runCount = 0;
    const connection = connect(createRuntime(async (provider, command, options, writer) => {
      runCount += 1;
      assert.equal(provider, 'claude');
      assert.equal(command, 'Fix the missing save button now');
      assert.equal(options.sessionId, draft.sessionId);
      assert.equal(options.projectPath, '/tmp/group-chat-project');
      assert.equal(sessionsService.resolveProviderSessionId(draft.sessionId), null);
      assert.equal(sessionsDb.getSessionById(draft.sessionId)?.custom_name, 'Fix the missing save');
      writer.send({ kind: 'session_created', provider, sessionId: 'native-created-1', newSessionId: 'native-created-1' });
      writer.send({ kind: 'complete', provider, sessionId: 'native-created-1', exitCode: 0 });
    }));

    await connection.receive({
      type: 'chat.send',
      sessionId: draft.sessionId,
      provider: 'codex',
      content: 'Fix the missing save button now',
    });

    assert.equal(runCount, 1);
    assert.equal(sessionsDb.getAllSessions().length, 1);
    assert.equal(sessionsDb.getSessionById(draft.sessionId)?.provider_session_id, 'native-created-1');
    const upsert = connection.frames.find((frame) => frame.kind === 'session_upserted');
    assert.equal(upsert?.sessionId, draft.sessionId);
    assert.equal((upsert?.session as { summary: string } | undefined)?.summary, 'Fix the missing save');
  });
});

test('sending an explicitly renamed empty draft keeps its chosen name', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const draft = sessionsService.createAppSession('claude', '/tmp/group-chat-project');
    sessionsDb.updateSessionCustomName(draft.sessionId, 'My chosen conversation');
    const connection = connect(createRuntime(async () => {
      assert.equal(sessionsDb.getSessionById(draft.sessionId)?.custom_name, 'My chosen conversation');
    }));

    await connection.receive({ type: 'chat.send', sessionId: draft.sessionId, content: 'First prompt' });
    assert.equal(sessionsDb.getSessionById(draft.sessionId)?.custom_name, 'My chosen conversation');
  });
});

test('a rejected competing send cannot initialize an unnamed draft', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const draft = sessionsService.createAppSession('claude', '/tmp/group-chat-project');
    const connection = connect(createRuntime(async () => {
      assert.fail('a rejected send must not start a runtime');
    }));
    chatRunRegistry.startRun({
      appSessionId: draft.sessionId,
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });

    await connection.receive({ type: 'chat.send', sessionId: draft.sessionId, content: 'Rejected prompt' });
    assert.equal(sessionsDb.getSessionById(draft.sessionId)?.custom_name, null);
    assert.ok(connection.frames.some((frame) => frame.code === 'RUN_IN_PROGRESS'));
  });
});


test('configuration preparation failures reach the chat and release the reserved run', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const draft = sessionsService.createAppSession('claude', '/tmp/configuration-failure-fixture');
    const connection = connect(createRuntime(async () => { throw new Error('This remote does not support the selected effort'); }));
    await connection.receive({ type: 'chat.send', sessionId: draft.sessionId, content: 'Fixture only' });
    const errors = connection.frames.filter((frame) => frame.kind === 'error');
    assert.equal(errors.length, 1);
    assert.match(JSON.stringify(errors[0]), /does not support the selected effort/);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
    assert.equal(chatRunRegistry.isProcessing(draft.sessionId), false);
  });
});
