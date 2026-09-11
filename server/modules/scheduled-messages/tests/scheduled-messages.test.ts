import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeSessionActionsDb, closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { closeScheduledMessageDispatcher, dispatchDueScheduledMessages, dispatchQueuedMessages, initializeScheduledMessageDispatcher } from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

const SESSION_ID = 'scheduled-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  // An explicit empty fixture file prevents legacy-install DB migration.
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  try {
    const user = userDb.createUser('scheduler', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Scheduled session');
    await runTest(Number(user.id));
  } finally {
    closeScheduledMessageDispatcher();
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

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

function createRuntime(runs: RunCall[], behaviour: 'ok' | 'throw' = 'ok', aborts: string[] = [], interrupt?: () => Promise<boolean>) {
  return {
    hasRuntime: () => true,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      if (behaviour === 'throw') {
        throw new Error('provider exploded');
      }
      runs.push({ provider, command, options });
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return interrupt ? await interrupt() : true;
    },
  } as never;
}

test('a message due in the past is sent on the next pass, not skipped', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The server was down when this came due.
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'run the nightly checks',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const sent = await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(sent, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'run the nightly checks');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('saved queues poll every second independently from schedules and both timers are released on close', async t => {
  await withIsolatedDatabase(async userId => {
    const timers: Array<{ callback: () => void; interval: number; unrefCount: number; unref(): void }> = [];
    const cleared: unknown[] = [];
    t.mock.method(globalThis, 'setInterval', (callback: () => void, interval: number) => {
      const timer = { callback, interval, unrefCount: 0, unref() { this.unrefCount++; } };
      timers.push(timer); return timer as unknown as ReturnType<typeof setInterval>;
    });
    t.mock.method(globalThis, 'clearInterval', (timer: unknown) => { cleared.push(timer); });
    const runs: RunCall[] = [];
    initializeScheduledMessageDispatcher(createRuntime(runs));
    initializeScheduledMessageDispatcher(createRuntime(runs));
    assert.deepEqual(timers.map(timer => timer.interval).sort((a, b) => a - b), [1000, 30_000]);
    assert.deepEqual(timers.map(timer => timer.unrefCount), [1, 1]);
    sessionsDb.assignProviderSessionId(SESSION_ID, 'queue-native');
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'Ready queued input', providerSessionId: 'queue-native' } });
    const scheduled = scheduledMessagesDb.create({ userId, sessionId: SESSION_ID, content: 'Due scheduled input', options: {}, scheduledFor: new Date(0) });
    timers.find(timer => timer.interval === 1000)!.callback();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(runs.map(run => run.command), ['Ready queued input']);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID).find(row => row.id === scheduled.id)?.status, 'pending');
    timers.find(timer => timer.interval === 30_000)!.callback();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(runs.map(run => run.command), ['Ready queued input', 'Due scheduled input']);
    closeScheduledMessageDispatcher();
    closeScheduledMessageDispatcher();
    assert.deepEqual(cleared, timers);
  });
});

test('a queued message is sent by the server without a browser connection', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionsDb.assignProviderSessionId(SESSION_ID, 'queued-native-fixture');
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: {
        content: 'continue on the VPS',
        providerSessionId: 'queued-native-fixture',
        options: { model: 'claude-opus-5' },
        attachments: [{ path: '/tmp/upload.png' }],
      },
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'continue on the VPS');
    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.deepEqual(runs[0].options.attachments, []);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a run reservation race restores the queued turn and sends it exactly once on the next pass', async t => {
  await withIsolatedDatabase(async userId => {
    sessionsDb.assignProviderSessionId(SESSION_ID, 'race-native');
    const queuedMessage = {
      content: 'Keep this queued turn', providerSessionId: 'race-native',
      options: { model: 'existing-choice' }, attachments: [{ path: '/tmp/retained-until-dispatch.png' }],
    };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage });
    const runs: RunCall[] = [];
    // Another sender can reserve after the dispatcher's idle check. This must
    // use the admission code, not the different wording of its two busy checks.
    const reservation = t.mock.method(chatRunRegistry, 'startRun', () => null);
    try {
      assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
      assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, queuedMessage);
      assert.equal(runs.length, 0);
    } finally {
      reservation.mock.restore();
    }
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, queuedMessage.content);
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
  });
});

test('a queued message stays pending while its session is busy', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionsDb.assignProviderSessionId(SESSION_ID, 'queued-native-fixture');
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after this run', providerSessionId: 'queued-native-fixture' },
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after this run',
      providerSessionId: 'queued-native-fixture',
    });
  });
});

test('a message saved during startup joins the same Workflow input stream as soon as it accepts input', async () => {
  await withIsolatedDatabase(async userId => {
    sessionsDb.assignProviderSessionId(SESSION_ID, 'workflow-native');
    const queuedMessage = { content: 'Continue discussing with the main model', providerSessionId: 'workflow-native' };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage });
    const run = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: 'workflow-native', connection: null, userId })!;
    run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'foreground', acceptsInput: false, backgroundTasks: 0 });
    const inputs: Array<{ command: string; options: Record<string, unknown> }> = [];
    const runtime: ProviderRuntimeGateway = {
      hasRuntime: () => true,
      run: async () => assert.fail('A saved queue must not spawn another process beside Workflow'),
      abort: async () => assert.fail('Sending a saved queue must preserve Workflow'),
      resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [],
      enqueue: async (provider, sessionId, command, options) => {
        assert.equal(provider, 'claude'); assert.equal(sessionId, SESSION_ID);
        inputs.push({ command, options });
        run.writer.send({ kind: 'status', text: 'message_delivery', provider, clientMessageId: options.clientMessageId, content: command, delivery: 'queued' });
        return true;
      },
    };
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'background', acceptsInput: true, backgroundTasks: 1 });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].command, queuedMessage.content);
    assert.match(String(inputs[0].options.clientMessageId), /^[0-9a-f-]{36}$/);
    assert.equal(inputs[0].options.deliveryMode, 'queue');
    assert.equal(chatRunRegistry.getRun(SESSION_ID), run);
    assert.equal(run.status, 'running');
    assert.equal(run.runtimeState?.backgroundTasks, 1);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    assert.equal(await dispatchQueuedMessages(runtime), 0);
  });
});

test('a saved queue survives a stream-closing race before admission and is not replayed after an admitted failure', async () => {
  await withIsolatedDatabase(async userId => {
    sessionsDb.assignProviderSessionId(SESSION_ID, 'workflow-native');
    const queuedMessage = { content: 'Keep this message', providerSessionId: 'workflow-native' };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage });
    const run = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: 'workflow-native', connection: null, userId })!;
    run.writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'background', acceptsInput: true, backgroundTasks: 1 });
    let attempts = 0;
    const runtime: ProviderRuntimeGateway = {
      hasRuntime: () => true, run: async () => assert.fail('Never replace the current Workflow'), abort: async () => assert.fail('Never stop the Workflow'),
      resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [],
      enqueue: async (provider, _sessionId, content, options) => {
        if (++attempts === 1) return false;
        run.writer.send({ kind: 'status', text: 'message_delivery', provider, clientMessageId: options.clientMessageId, content, delivery: 'queued' });
        run.writer.send({ kind: 'status', text: 'message_delivery', provider, clientMessageId: options.clientMessageId, content, delivery: 'failed', error: 'Attachment preparation failed' });
        throw new Error('Attachment preparation failed');
      },
    };
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, queuedMessage);
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    assert.equal([...run.messageReceipts.values()].at(-1)?.delivery, 'failed');
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(attempts, 2);
  });
});

test('a retained scheduled Workflow does not lock out a later saved main-conversation message', async () => {
  await withIsolatedDatabase(async userId => {
    sessionsDb.assignProviderSessionId(SESSION_ID, 'workflow-native');
    scheduledMessagesDb.create({ userId, sessionId: SESSION_ID, content: 'Scheduled Workflow', options: {}, scheduledFor: new Date(0) });
    let started!: () => void, finish!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const queued: string[] = [];
    const runtime: ProviderRuntimeGateway = {
      hasRuntime: () => true,
      run: async (_provider, _command, _options, writer) => {
        writer.send({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', phase: 'background', acceptsInput: true, backgroundTasks: 1 });
        started(); await finished;
      },
      enqueue: async (_provider, _sessionId, command) => { queued.push(command); return true; },
      abort: async () => assert.fail('The scheduled Workflow must continue'),
      resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [],
    };
    const scheduled = dispatchDueScheduledMessages(runtime);
    try {
      await ready;
      sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'Main conversation follow-up', providerSessionId: 'workflow-native' } });
      assert.equal(await dispatchQueuedMessages(runtime), 1);
      assert.deepEqual(queued, ['Main conversation follow-up']);
      assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);
    } finally { finish(); await scheduled; }
  });
});

test('a scheduled candidate claimed before rewind cannot later start in the replacement context', async () => {
  await withIsolatedDatabase(async userId => {
    sessionsDb.assignProviderSessionId(SESSION_ID, 'scheduled-original-native');
    scheduledMessagesDb.create({ userId, sessionId: SESSION_ID, content: 'First scheduled run', options: {}, scheduledFor: new Date(0) });
    const pending = scheduledMessagesDb.create({ userId, sessionId: SESSION_ID, content: 'Old-context scheduled question', options: {}, scheduledFor: new Date(1) });
    let started!: () => void, finish!: () => void;
    const startedGate = new Promise<void>(resolve => { started = resolve; });
    const finishGate = new Promise<void>(resolve => { finish = resolve; });
    const commands: string[] = [], aborts: string[] = [];
    const runtime = { hasRuntime: () => true, run: async (_provider: string, command: string) => {
      commands.push(command); started(); await finishGate;
    }, abort: async (_provider: string, session: string) => { aborts.push(session); return true; } } as never;
    const dispatch = dispatchDueScheduledMessages(runtime);
    await startedGate;
    const backup = claudeSessionActionsDb.replaceContext(SESSION_ID, 'scheduled-original-native', 'scheduled-restored-native', '/fixture/scheduled-restored.jsonl', 'target');
    finish(); await dispatch;
    assert.deepEqual(commands, ['First scheduled run']);
    assert.deepEqual(aborts, []);
    const retained = scheduledMessagesDb.listForSession(userId, backup).find(row => row.id === pending.id);
    assert.equal(retained?.status, 'failed');
    assert.match(retained?.failure_reason ?? '', /context changed/i);
  });
});

for (const firstKind of ['queued', 'scheduled'] as const) {
  test(`a long-lived ${firstKind} run cannot block another idle session's later queued or scheduled messages`, async t => {
    await withIsolatedDatabase(async userId => {
      const idleSession = 'independent-idle-session';
      const scheduledSession = 'independent-scheduled-session';
      sessionsDb.createAppSession(idleSession, 'claude', '/fixture/idle', 'Idle');
      sessionsDb.createAppSession(scheduledSession, 'claude', '/fixture/scheduled', 'Scheduled');
      sessionsDb.assignProviderSessionId(SESSION_ID, 'workflow-native');
      sessionsDb.assignProviderSessionId(idleSession, 'idle-native');
      const firstContent = 'Long-lived workflow A';
      if (firstKind === 'queued') {
        sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: firstContent, providerSessionId: 'workflow-native' } });
      } else {
        scheduledMessagesDb.create({ userId, sessionId: SESSION_ID, content: firstContent, options: {}, scheduledFor: new Date(0) });
      }
      const polls: Array<() => void> = [];
      const poll = () => { for (const callback of polls) callback(); };
      t.mock.method(globalThis, 'setInterval', (callback: () => void) => { polls.push(callback); return { unref() {} } as unknown as ReturnType<typeof setInterval>; });
      t.mock.method(globalThis, 'clearInterval', () => {});
      let finishWorkflow!: () => void;
      const workflow = new Promise<void>(resolve => { finishWorkflow = resolve; });
      const commands: string[] = [], aborts: string[] = [];
      const runtime = {
        hasRuntime: () => true,
        run: async (_provider: string, command: string) => { commands.push(command); if (command === firstContent) await workflow; },
        abort: async (_provider: string, sessionId: string) => { aborts.push(sessionId); return false; },
      } as never;
      try {
        initializeScheduledMessageDispatcher(runtime);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(commands, [firstContent]);
        sessionDraftsDb.saveDraft(userId, idleSession, { text: '', queuedMessage: { content: 'Later queued turn B', providerSessionId: 'idle-native' } });
        scheduledMessagesDb.create({ userId, sessionId: scheduledSession, content: 'Later scheduled turn C', options: {}, scheduledFor: new Date(0) });
        poll();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true, 'Workflow A is still pending while the other sessions start.');
        assert.equal(commands.filter(command => command === 'Later queued turn B').length, 1);
        assert.equal(commands.filter(command => command === 'Later scheduled turn C').length, 1);
        assert.deepEqual(aborts, [], 'No independent run is interrupted.');
        poll();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(commands.length, 3, 'Repeated polls cannot replay claimed work.');
        assert.equal(sessionDraftsDb.getDrafts(userId).some(draft => draft.scope === idleSession), false);
      } finally {
        closeScheduledMessageDispatcher();
        finishWorkflow();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    });
  });
}

test('scheduled turns remain ordered per session while other sessions run independently', async () => {
  await withIsolatedDatabase(async userId => {
    const independent = 'parallel-scheduled';
    sessionsDb.createAppSession(independent, 'claude', '/fixture/parallel', 'Independent');
    for (const [sessionId, content, time] of [[SESSION_ID, 'first A', 0], [SESSION_ID, 'second A', 1], [independent, 'first B', 2]] as const) {
      scheduledMessagesDb.create({ userId, sessionId, content, options: {}, scheduledFor: new Date(time) });
    }
    let finishFirst!: () => void;
    const gate = new Promise<void>(resolve => { finishFirst = resolve; });
    const commands: string[] = [];
    const runtime = { hasRuntime: () => true, run: async (_provider: string, command: string) => { commands.push(command); if (command === 'first A') await gate; }, abort: async () => true } as never;
    const pass = dispatchDueScheduledMessages(runtime);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(commands, ['first A', 'first B']);
      scheduledMessagesDb.create({ userId, sessionId: SESSION_ID, content: 'third A', options: {}, scheduledFor: new Date(3) });
      assert.equal(await dispatchDueScheduledMessages(runtime), 0, 'Later same-session schedules stay pending until its worker is free.');
      assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID).find(row => row.content === 'third A')?.status, 'pending');
    } finally { finishFirst(); await pass; }
    assert.deepEqual(commands, ['first A', 'first B', 'second A']);
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.deepEqual(commands, ['first A', 'first B', 'second A', 'third A']);
  });
});

test('a due message starts after the interrupted native query actually completes', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'the schedule wins',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    const active = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    const aborts: string[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs, 'ok', aborts, async () => {
      active!.writer.sendComplete({ exitCode: 0, aborted: true });
      return true;
    })), 1);

    assert.deepEqual(aborts, [SESSION_ID]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'the schedule wins');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

for (const stop of ['rejected', 'throw', 'closing'] as const) {
  test(`a scheduled send with ${stop} stop keeps its content as failed and never replaces or completes the active query`, async () => {
    await withIsolatedDatabase(async userId => {
      scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'Keep this scheduled prompt',
        scheduledFor: new Date(Date.now() - 1000).toISOString() });
      const active = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId });
      const runs: RunCall[] = [], aborts: string[] = [];
      const runtime = createRuntime(runs, 'ok', aborts, async () => {
        if (stop === 'throw') throw new Error('Fixture interrupt rejected');
        return stop === 'closing';
      });
      assert.equal(await dispatchDueScheduledMessages(runtime), 1);
      const retained = scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
      assert.equal(retained.status, 'failed');
      assert.equal(retained.content, 'Keep this scheduled prompt');
      assert.match(retained.failure_reason ?? '', /not sent; retry manually/);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), active);
      assert.equal(active?.status, 'running');
      assert.equal(runs.length, 0);
      assert.deepEqual(aborts, [SESSION_ID]);
      assert.equal(await dispatchDueScheduledMessages(runtime), 0, 'Failed sends are never automatically retried.');
    });
  });
}

test('a message that is not due yet is left alone', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'later',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('a due message is claimed once, so overlapping passes cannot double-send it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'only once',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await Promise.all([
      dispatchDueScheduledMessages(runtime),
      dispatchDueScheduledMessages(runtime),
    ]);

    assert.equal(runs.length, 1);
  });
});

test('the composer settings it was scheduled with travel with it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'with options',
      options: { model: 'claude-opus-5', permissionMode: 'plan' },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.equal(runs[0].options.permissionMode, 'plan');
  });
});

test('a provider failure is recorded on the message instead of vanishing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    await dispatchDueScheduledMessages(createRuntime([], 'throw'));

    const row = scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason ?? '', /provider exploded/);
  });
});

test('a cancelled message never fires', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'never mind',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    scheduledMessagesService.cancel(userId, scheduled.id);

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
  });
});

test('a failed message can be dismissed, and stays dismissed', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([], 'throw'));
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'failed');

    scheduledMessagesService.cancel(userId, scheduled.id);

    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'cancelled');
  });
});

test('cancelling something that already fired is refused', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'gone',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([]));

    assert.throws(
      () => scheduledMessagesService.cancel(userId, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
  });
});

test('one user cannot cancel another user\'s scheduled message', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'mine',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    assert.throws(
      () => scheduledMessagesService.cancel(userId + 1, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('scheduling validates its input', async () => {
  await withIsolatedDatabase(async (userId) => {
    const base = { userId, sessionId: SESSION_ID, scheduledFor: new Date(Date.now() + 1000).toISOString() };

    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: '   ' }),
      (error: Error & { code?: string }) => error.code === 'CONTENT_REQUIRED',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: 'hi', scheduledFor: 'not a date' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULE_TIME',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({
        ...base,
        content: 'hi',
        scheduledFor: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString(),
      }),
      (error: Error & { code?: string }) => error.code === 'SCHEDULE_TOO_FAR_AHEAD',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, sessionId: 'nope', content: 'hi' }),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
  });
});
