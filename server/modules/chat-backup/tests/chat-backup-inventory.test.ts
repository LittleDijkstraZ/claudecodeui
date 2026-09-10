import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';

import { createChatBackupInventoryService } from '../chat-backup-inventory.service.js';

const NATIVE = '10000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000001';

async function fixture(run: (input: { directory: string; home: string; main: string; project: string }) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backup-inventory-')));
  const home = path.join(directory, 'provider');
  const main = path.join(home, `${NATIVE}.jsonl`);
  const project = path.join(directory, 'project');
  await fs.mkdir(home); await fs.mkdir(project);
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'app.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try { await run({ directory, home, main, project }); } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('inventory observes fresh metadata and running state without reading or validating conversation contents', async context => fixture(async ({ home, main, project }) => {
  await fs.writeFile(main, 'Synthetic content intentionally not parsed as native JSONL.');
  sessionsDb.createSession(NATIVE, 'claude', project, 'Initial title', undefined, '2026-09-09T00:00:00Z', main);
  sessionsDb.createAppSession('empty', 'claude', project);
  sessionsDb.createAppSession('unsupported', 'cursor', project);
  sessionsDb.createSession(OTHER, 'codex', project, 'Missing file', undefined, undefined, path.join(home, 'missing.jsonl'));
  projectsDb.updateProjectIsArchived(project, true);
  let running = [NATIVE];
  const inventory = createChatBackupInventoryService(() => home, { runningSessionIds: () => running });
  const read = context.mock.method(fs, 'readFile', async () => { throw new Error('Inventory must not read contents'); });
  const first = await inventory({ sessionIds: [NATIVE, OTHER, 'empty', 'unsupported', 'missing'] });
  assert.deepEqual(first.missingSessionIds, ['missing']);
  assert.equal(first.sessions.find(row => row.sessionId === NATIVE)?.history, 'native');
  assert.equal(first.sessions.find(row => row.sessionId === NATIVE)?.runtimeStatus, 'running');
  assert.equal(first.sessions.find(row => row.sessionId === 'empty')?.history, 'empty');
  assert.equal(first.sessions.find(row => row.sessionId === 'unsupported')?.history, 'unsupported');
  assert.equal(first.sessions.find(row => row.sessionId === OTHER)?.history, 'unavailable');
  const before = first.sessions.find(row => row.sessionId === NATIVE)!;
  sessionsDb.updateSessionCustomName(NATIVE, 'Latest title');
  sessionsDb.updateSessionIsArchived(NATIVE, true);
  sessionsDb.setSessionModel(NATIVE, 'fixture-model');
  sessionsDb.setSessionEffort(NATIVE, 'high');
  running = [];
  const after = (await inventory({ sessionIds: [NATIVE] })).sessions[0];
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.contentVersion, before.contentVersion);
  assert.equal(after.title, 'Latest title');
  assert.equal(after.model, 'fixture-model');
  assert.equal(after.effort, 'high');
  assert.equal(after.isArchived, true);
  assert.equal(after.runtimeStatus, 'idle');
  assert.equal(read.mock.callCount(), 0);
  read.mock.restore();
}));

test('main and supported sidecar metadata change contentVersion even when DB activity is unchanged', async () => fixture(async ({ home, main, project }) => {
  await fs.writeFile(main, 'first');
  sessionsDb.createSession(NATIVE, 'claude', project, 'Native', undefined, '2026-09-09T00:00:00Z', main);
  const inventory = createChatBackupInventoryService(() => home, { runningSessionIds: () => [] });
  const snapshot = async () => (await inventory({ sessionIds: [NATIVE] })).sessions[0];
  const first = await snapshot();
  assert.match(first.contentVersion!, /^[a-f0-9]{64}$/);
  await fs.writeFile(main, 'second version');
  const second = await snapshot();
  assert.notEqual(second.contentVersion, first.contentVersion);
  const sidecar = path.join(home, NATIVE, 'tool-results', 'result.jsonl');
  await fs.mkdir(path.dirname(sidecar), { recursive: true });
  await fs.writeFile(sidecar, 'arbitrary tool data');
  const third = await snapshot();
  assert.notEqual(third.contentVersion, second.contentVersion);
  await fs.writeFile(sidecar, 'changed tool data');
  const fourth = await snapshot();
  assert.notEqual(fourth.contentVersion, third.contentVersion);
  await fs.writeFile(path.join(path.dirname(sidecar), 'ignored.bin'), 'outside the export allowlist');
  assert.equal((await snapshot()).contentVersion, fourth.contentVersion);
  await fs.rm(sidecar);
  assert.notEqual((await snapshot()).contentVersion, fourth.contentVersion);
  assert.equal((await snapshot()).updatedAt, first.updatedAt);
}));

test('unsafe links, outside paths and missing storage are unavailable without leaking paths', async () => fixture(async ({ directory, home, main, project }) => {
  const outside = path.join(directory, 'private.jsonl');
  await fs.writeFile(outside, 'not a conversation');
  await fs.symlink(outside, main);
  sessionsDb.createSession(NATIVE, 'claude', project, 'Title', undefined, undefined, main);
  const inventory = createChatBackupInventoryService(() => home, { runningSessionIds: () => [] });
  const snapshot = async () => (await inventory({ sessionIds: [NATIVE] })).sessions[0];
  assert.equal((await snapshot()).history, 'unavailable');
  await fs.rm(main);
  await fs.writeFile(main, 'fixture');
  await fs.mkdir(path.join(home, NATIVE), { recursive: true });
  await fs.symlink(directory, path.join(home, NATIVE, 'subagents'));
  assert.equal((await snapshot()).history, 'unavailable');
  await fs.rm(path.join(home, NATIVE, 'subagents'));
  getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run(outside, NATIVE);
  assert.equal((await snapshot()).history, 'unavailable');
  const payload = JSON.stringify(await inventory({ sessionIds: [NATIVE] }));
  assert.equal(payload.includes('private.jsonl'), false);
  assert.equal(payload.includes('not a conversation'), false);
  await fs.rm(home, { recursive: true });
  assert.equal((await snapshot()).contentVersion, null);
}));

test('native identity changes during inspection cannot reuse the previous content version', async () => fixture(async ({ home, main, project }) => {
  await fs.writeFile(main, 'fixture');
  sessionsDb.createSession(NATIVE, 'claude', project, 'Before', undefined, undefined, main);
  let calls = 0;
  const inventory = createChatBackupInventoryService(() => home, {
    runningSessionIds: () => [],
    sessions: { getBackupSessionsPage(input) {
      if (++calls === 2) getConnection().prepare('UPDATE sessions SET provider_session_id = ?, custom_name = ? WHERE session_id = ?').run(OTHER, 'Fresh title', NATIVE);
      return sessionsDb.getBackupSessionsPage(input);
    } },
  });
  const row = (await inventory({ sessionIds: [NATIVE] })).sessions[0];
  assert.equal(row.title, 'Fresh title');
  assert.equal(row.history, 'unavailable');
  assert.equal(row.contentVersion, null);
  const stable = createChatBackupInventoryService(() => home, { runningSessionIds: () => [] });
  const first = (await stable({ sessionIds: [NATIVE] })).sessions[0];
  getConnection().prepare('UPDATE sessions SET provider_session_id = ? WHERE session_id = ?').run(NATIVE, NATIVE);
  assert.notEqual((await stable({ sessionIds: [NATIVE] })).sessions[0].contentVersion, first.contentVersion);
}));

test('sessions deleted while metadata is inspected are reported missing for explicit selection only', async () => fixture(async ({ home, project }) => {
  sessionsDb.createAppSession('disappearing', 'claude', project);
  let calls = 0;
  const inventory = createChatBackupInventoryService(() => home, {
    runningSessionIds: () => [],
    sessions: { getBackupSessionsPage(input) {
      if (++calls === 2) sessionsDb.deleteSessionById('disappearing');
      return sessionsDb.getBackupSessionsPage(input);
    } },
  });
  assert.deepEqual(await inventory({ sessionIds: ['disappearing'] }), { sessions: [], nextCursor: null, missingSessionIds: ['disappearing'] });
}));

test('excess sidecars defer only the oversized conversation and keep other inventory rows available', async () => fixture(async ({ home, main, project }) => {
  await fs.writeFile(main, 'fixture');
  const directory = path.join(home, NATIVE, 'tool-results');
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: 512 }, (_, index) => fs.writeFile(path.join(directory, `${index}.txt`), 'fixture')));
  sessionsDb.createSession(NATIVE, 'claude', project, 'Many files', undefined, undefined, main);
  sessionsDb.createAppSession('empty', 'claude', project);
  const inventory = createChatBackupInventoryService(() => home, { runningSessionIds: () => [] });
  const result = await inventory({});
  assert.equal(result.sessions.find(row => row.sessionId === NATIVE)?.history, 'unavailable');
  assert.equal(result.sessions.find(row => row.sessionId === 'empty')?.history, 'empty');
}));
