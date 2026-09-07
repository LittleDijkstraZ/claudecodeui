import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeSessionActionsService } from '@/modules/claude-session-actions/claude-session-actions.service.js';
import { claudeSessionActionsDb, closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/index.js';

const userId = '11111111-1111-4111-8111-111111111111';
const assistantId = '22222222-2222-4222-8222-222222222222';
const history: SessionMessage[] = [
  { type: 'user', uuid: userId, session_id: 'native-original', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: [{ type: 'text', text: 'Original question' }] } },
  { type: 'assistant', uuid: assistantId, session_id: 'native-original', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Later context' }] } },
];

async function fixture(run: (value: {
  make: (overrides?: Parameters<typeof createClaudeSessionActionsService>[0]) => ReturnType<typeof createClaudeSessionActionsService>;
  events: string[]; project: string;
}) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-actions-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'fixture.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const project = path.join(directory, 'project');
  sessionsDb.createSession('native-original', 'claude', project, 'Original title', undefined, undefined, path.join(directory, 'native-original.jsonl'));
  getConnection().prepare('UPDATE sessions SET session_id = ? WHERE session_id = ?').run('app-original', 'native-original');
  sessionsDb.setSessionModel('app-original', 'opus');
  sessionsDb.setSessionEffort('app-original', 'high');
  const events: string[] = [];
  let forkNumber = 0;
  const make = (overrides: Parameters<typeof createClaudeSessionActionsService>[0] = {}) => createClaudeSessionActionsService({
    messages: async () => history,
    discardFork: async () => {},
    fork: async (providerId, options) => { events.push(`fork:${providerId}:${options?.upToMessageId ?? 'all'}`); return { sessionId: `native-fork-${++forkNumber}` }; },
    rewind: async (session, message, dryRun) => { events.push(`files:${session.provider_session_id}:${message}:${dryRun}`); return { canRewind: true, filesChanged: ['src/example.ts'], insertions: 2, deletions: 4 }; },
    transcriptFingerprint: async () => 'transcript-v1', filesFingerprint: async () => 'files-v1',
    ensureFork: async (_session, id) => path.join(directory, `${id}.jsonl`), active: () => false, now: () => 1000,
    ...overrides,
  });
  try { await run({ make, events, project }); } finally {
    chatRunRegistry.clearAll(); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
function errorCode(code: string) { return (error: unknown) => error instanceof AppError && error.code === code; }

test('side chat copies saved context using disk-only SDK fork and keeps source mapping/model/project', async () => fixture(async ({ make, events, project }) => {
  const result = await make().fork('app-original', { messageId: `${assistantId}_text_0` });
  assert.equal(result.projectPath, project);
  assert.equal(result.parentSessionId, 'app-original');
  assert.equal(result.inheritedFileCheckpoints, false);
  assert.equal(sessionsDb.getSessionById('app-original')?.provider_session_id, 'native-original');
  assert.equal(sessionsDb.getSessionById(result.sessionId)?.provider_session_id, 'native-fork-1');
  assert.equal(sessionsDb.getSessionById(result.sessionId)?.model, 'opus');
  assert.equal(sessionsDb.getSessionById(result.sessionId)?.effort, 'high');
  assert.equal(sessionsDb.getSessionById(result.sessionId)?.forked_from_session_id, 'app-original');
  assert.deepEqual(events, [`fork:native-original:${assistantId}`]);
  assert.equal(claudeSessionActionsDb.relationship(result.sessionId)?.kind, 'side_chat');
}));

test('conversation rewind changes the real provider mapping, keeps selected message, and retains archived recovery across restart/watcher', async () => fixture(async ({ make, events, project }) => {
  sessionsDb.createAppSession('ancestor-app', 'claude', project);
  getConnection().prepare('UPDATE sessions SET forked_from_session_id = ? WHERE session_id = ?').run('ancestor-app', 'app-original');
  const service = make();
  const preview = await service.preview(1, 'app-original', { messageId: `${userId}_text_0`, mode: 'conversation' });
  assert.deepEqual(preview.filesChanged, []);
  const result = await service.rewind(1, 'app-original', { messageId: userId, mode: 'conversation', previewToken: preview.previewToken });
  assert.equal(result.sessionId, 'app-original');
  assert.equal(result.contextChanged, true);
  assert.equal(sessionsDb.getSessionById('app-original')?.provider_session_id, 'native-fork-1');
  assert.equal(sessionsDb.getSessionById('app-original')?.jsonl_path?.endsWith('native-fork-1.jsonl'), true);
  assert.ok(result.backupSessionId);
  assert.equal(sessionsDb.getSessionById(result.backupSessionId!)?.provider_session_id, 'native-original');
  assert.equal(sessionsDb.getSessionById(result.backupSessionId!)?.isArchived, 1);
  assert.equal(sessionsDb.getSessionById(result.backupSessionId!)?.forked_from_session_id, 'ancestor-app');
  assert.equal(sessionsDb.getSessionById('app-original')?.forked_from_session_id, 'ancestor-app');
  assert.deepEqual(events, [`fork:native-original:${userId}`]);
  closeConnection(); await initializeDatabase();
  sessionsDb.createSession('native-original', 'claude', project, 'Watcher title');
  assert.equal(sessionsDb.getSessionById(result.backupSessionId!)?.isArchived, 1);
  assert.equal(sessionsDb.getSessionById('app-original')?.provider_session_id, 'native-fork-1');
  assert.deepEqual(getConnection().pragma('foreign_key_check'), []);
}));

test('file-only preview and restore use original checkpoint and leave conversation mapping unchanged', async () => fixture(async ({ make, events }) => {
  const service = make();
  const preview = await service.preview(1, 'app-original', { messageId: userId, mode: 'files' });
  assert.deepEqual(preview.filesChanged, ['src/example.ts']);
  const result = await service.rewind(1, 'app-original', { messageId: userId, mode: 'files', previewToken: preview.previewToken });
  assert.equal(result.contextChanged, false); assert.equal(result.backupSessionId, null);
  assert.equal(sessionsDb.getSessionById('app-original')?.provider_session_id, 'native-original');
  assert.deepEqual(events, [`files:native-original:${userId}:true`, `files:native-original:${userId}:false`]);
}));

test('combined rewind prepares new transcript, restores original checkpoint, then switches context', async () => fixture(async ({ make, events }) => {
  const service = make();
  const preview = await service.preview(1, 'app-original', { messageId: userId, mode: 'both' });
  const result = await service.rewind(1, 'app-original', { messageId: userId, mode: 'both', previewToken: preview.previewToken });
  assert.equal(result.contextChanged, true);
  assert.deepEqual(events, [`files:native-original:${userId}:true`, `fork:native-original:${userId}`, `files:native-original:${userId}:false`]);
}));

test('old history without checkpoints cannot restore files and never forks or changes context', async () => fixture(async ({ make, events }) => {
  const service = make({ rewind: async () => ({ canRewind: false, error: 'No checkpoint exists' }) });
  const preview = await service.preview(1, 'app-original', { messageId: userId, mode: 'both' });
  assert.equal(preview.canRewind, false);
  await assert.rejects(service.rewind(1, 'app-original', { messageId: userId, mode: 'both', previewToken: preview.previewToken }), errorCode('CLAUDE_CHECKPOINT_UNAVAILABLE'));
  assert.deepEqual(events, []);
}));

test('preview is bound to user, message, mode, session revision, and expiry', async () => fixture(async ({ make, events }) => {
  let revision = 'v1'; let time = 1000;
  const service = make({ transcriptFingerprint: async () => revision, now: () => time });
  const preview = await service.preview(1, 'app-original', { messageId: userId, mode: 'conversation' });
  for (const input of [
    { user: 2, mode: 'conversation' as const, message: userId },
    { user: 1, mode: 'both' as const, message: userId },
    { user: 1, mode: 'conversation' as const, message: assistantId },
  ]) await assert.rejects(service.rewind(input.user, 'app-original', { messageId: input.message, mode: input.mode, previewToken: preview.previewToken }), errorCode('REWIND_PREVIEW_STALE'));
  revision = 'v2';
  await assert.rejects(service.rewind(1, 'app-original', { messageId: userId, mode: 'conversation', previewToken: preview.previewToken }), errorCode('REWIND_PREVIEW_STALE'));
  revision = 'v1'; time = preview.expiresAt;
  await assert.rejects(service.rewind(1, 'app-original', { messageId: userId, mode: 'conversation', previewToken: preview.previewToken }), errorCode('REWIND_PREVIEW_STALE'));
  assert.deepEqual(events, []);
}));

test('a file changed after preview prevents both filesystem and transcript changes', async () => fixture(async ({ make, events }) => {
  let stamp = 'one'; const service = make({ filesFingerprint: async () => stamp });
  const preview = await service.preview(1, 'app-original', { messageId: userId, mode: 'both' });
  stamp = 'two';
  await assert.rejects(service.rewind(1, 'app-original', { messageId: userId, mode: 'both', previewToken: preview.previewToken }), errorCode('REWIND_PREVIEW_STALE'));
  assert.equal(events.length, 1);
}));

test('partial file restore reports its result and keeps original context', async () => fixture(async ({ make }) => {
  const service = make({ rewind: async (_session, _message, dryRun) => ({ canRewind: true, filesChanged: ['one.ts'], skippedLinks: dryRun ? undefined : 1 }) });
  const preview = await service.preview(1, 'app-original', { messageId: userId, mode: 'both' });
  await assert.rejects(service.rewind(1, 'app-original', { messageId: userId, mode: 'both', previewToken: preview.previewToken }), errorCode('CLAUDE_FILE_REWIND_INCOMPLETE'));
  assert.equal(sessionsDb.getSessionById('app-original')?.provider_session_id, 'native-original');
  await assert.rejects(service.rewind(1, 'app-original', { messageId: userId, mode: 'both', previewToken: preview.previewToken }), errorCode('REWIND_PREVIEW_STALE'));
}));

test('failed fork does not restore files or change the current context', async () => fixture(async ({ make, events }) => {
  const service = make({ fork: async () => { throw new Error('Fixture fork failure'); } });
  const preview = await service.preview(1, 'app-original', { messageId: userId, mode: 'both' });
  await assert.rejects(service.rewind(1, 'app-original', { messageId: userId, mode: 'both', previewToken: preview.previewToken }), /Fixture fork failure/);
  assert.equal(events.length, 1);
  assert.equal(sessionsDb.getSessionById('app-original')?.provider_session_id, 'native-original');
}));

test('active/background sessions reject actions before any SDK mutation', async () => fixture(async ({ make, events }) => {
  const service = make({ active: id => id === 'native-original' });
  await assert.rejects(service.fork('app-original', {}), errorCode('CLAUDE_SESSION_BUSY'));
  await assert.rejects(service.preview(1, 'app-original', { messageId: userId, mode: 'files' }), errorCode('CLAUDE_PROJECT_BUSY'));
  assert.deepEqual(events, []);
}));

test('idle reservation prevents concurrent sends and is released after a failed operation', async () => fixture(async ({ make }) => {
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const service = make({ messages: async () => { await gate; throw new Error('Fixture read failure'); } });
  const pending = service.fork('app-original', {});
  assert.equal(chatRunRegistry.reserveSessionMutation('app-original'), null);
  assert.equal(chatRunRegistry.startRun({ appSessionId: 'app-original', provider: 'claude', providerSessionId: 'native-original', connection: {} as never, userId: 1 }), null);
  unblock(); await assert.rejects(pending, /Fixture read failure/);
  const release = chatRunRegistry.reserveSessionMutation('app-original'); assert.ok(release); release();
}));

test('rewind only accepts saved user messages, excluding tool-result carriers and assistant rows', async () => fixture(async ({ make, events }) => {
  const service = make();
  await assert.rejects(service.preview(1, 'app-original', { messageId: assistantId, mode: 'conversation' }), errorCode('CLAUDE_MESSAGE_NOT_FOUND'));
  await assert.rejects(service.fork('app-original', { messageId: 'unknown' }), errorCode('CLAUDE_MESSAGE_NOT_FOUND'));
  assert.deepEqual(events, []);
  const capabilities = await service.capabilities('app-original');
  assert.deepEqual(capabilities.userMessageIds, [userId]);
  assert.equal(capabilities.fileRewind, 'preview-required');
}));

test('file rewind reserves the entire project while unrelated projects can still run', async () => fixture(async ({ make, project }) => {
  sessionsDb.createAppSession('same-project', 'claude', project);
  sessionsDb.createAppSession('other-project', 'claude', `${project}-other`);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = make({ rewind: async () => { await gate; return { canRewind: true, filesChanged: [] }; } });
  const pending = service.preview(1, 'app-original', { messageId: userId, mode: 'files' });
  await Promise.resolve();
  const connection = { readyState: 1, send: () => {} } as never;
  assert.equal(chatRunRegistry.startRun({ appSessionId: 'same-project', provider: 'claude', providerSessionId: null, connection, userId: 1 }), null);
  const other = chatRunRegistry.startRun({ appSessionId: 'other-project', provider: 'claude', providerSessionId: null, connection, userId: 1 });
  assert.ok(other);
  release(); await pending;
  assert.ok(chatRunRegistry.reserveProjectMutation(project));
}));

test('context reset clears completed replay and broadcasts the response revision to other windows', async () => fixture(async ({ make }) => {
  const { connectedClients } = await import('@/modules/websocket/index.js');
  const frames: Array<Record<string, unknown>> = [];
  const connection = { readyState: 1, send: (frame: string) => frames.push(JSON.parse(frame)) };
  connectedClients.add(connection as never);
  try {
    const run = chatRunRegistry.startRun({ appSessionId: 'app-original', provider: 'claude', providerSessionId: 'native-original', connection: connection as never, userId: 1 });
    assert.ok(run);
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'native-original', content: 'Old discarded reply' });
    run.writer.sendComplete({ exitCode: 0 });
    assert.ok(chatRunRegistry.replayEvents('app-original', 0).length);
    const service = make();
    const preview = await service.preview(1, 'app-original', { messageId: userId, mode: 'conversation' });
    const result = await service.rewind(1, 'app-original', { messageId: userId, mode: 'conversation', previewToken: preview.previewToken });
    assert.deepEqual(chatRunRegistry.replayEvents('app-original', 0), []);
    const reset = frames.find(frame => frame.kind === 'session_context_reset');
    assert.equal(reset?.contextRevision, result.contextRevision);
    assert.equal(reset?.sessionId, 'app-original');
  } finally { connectedClients.delete(connection as never); }
}));

test('failed combined restore cleans only its new unclaimed prepared fork, never source or recovery history', async () => fixture(async ({ make }) => {
  const deleted: string[] = [];
  const service = make({
    discardFork: async id => { deleted.push(id); },
    rewind: async (_session, _message, dryRun) => ({ canRewind: dryRun, error: dryRun ? undefined : 'Fixture restore failure' }),
  });
  const preview = await service.preview(1, 'app-original', { messageId: userId, mode: 'both' });
  await assert.rejects(service.rewind(1, 'app-original', { messageId: userId, mode: 'both', previewToken: preview.previewToken }), errorCode('CLAUDE_FILE_REWIND_INCOMPLETE'));
  assert.deepEqual(deleted, ['native-fork-1']);
  assert.equal(sessionsDb.getSessionById('app-original')?.provider_session_id, 'native-original');
  assert.equal(claudeSessionActionsDb.relationship('app-original'), undefined);
}));

test('failed restore retains a prepared fork another caller has already continued', async () => fixture(async ({ make }) => {
  let forkStamp = 'initial'; const deleted: string[] = [];
  const service = make({
    discardFork: async id => { deleted.push(id); },
    transcriptFingerprint: async session => session.provider_session_id.startsWith('native-fork') ? forkStamp : 'original',
    rewind: async (_session, _message, dryRun) => {
      if (!dryRun) forkStamp = 'continued-in-another-window';
      return { canRewind: dryRun, error: dryRun ? undefined : 'Fixture restore failure' };
    },
  });
  const preview = await service.preview(1, 'app-original', { messageId: userId, mode: 'both' });
  await assert.rejects(service.rewind(1, 'app-original', { messageId: userId, mode: 'both', previewToken: preview.previewToken }), errorCode('CLAUDE_FILE_REWIND_INCOMPLETE'));
  assert.deepEqual(deleted, []);
}));

test('explicit saved-message side chat leaves the running parent active and unchanged', async () => fixture(async ({ make, events }) => {
  const connection = { readyState: 1, send: () => {} } as never;
  const run = chatRunRegistry.startRun({ appSessionId: 'app-original', provider: 'claude', providerSessionId: 'native-original', connection, userId: 1 });
  assert.ok(run);
  const service = make({ active: id => id === 'native-original' });
  const branch = await service.fork('app-original', { messageId: userId });
  assert.ok(branch.sessionId);
  assert.equal(chatRunRegistry.isProcessing('app-original'), true);
  assert.equal(chatRunRegistry.getRun('app-original'), run);
  assert.equal(sessionsDb.getSessionById('app-original')?.provider_session_id, 'native-original');
  assert.deepEqual(events, [`fork:native-original:${userId}`]);
  await assert.rejects(service.fork('app-original', {}), errorCode('CLAUDE_SESSION_BUSY'));
  await assert.rejects(service.preview(1, 'app-original', { messageId: userId, mode: 'conversation' }), errorCode('CLAUDE_SESSION_BUSY'));
}));
