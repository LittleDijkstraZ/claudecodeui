import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';

async function fixture(run: () => void) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'backup-inventory-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'app.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try { run(); } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('backup keyset pages include archived sessions/projects and ignore activity ordering', async () => fixture(() => {
  for (const id of ['d', 'a', 'c', 'b']) sessionsDb.createAppSession(id, 'claude', '/fixture/project', id);
  sessionsDb.updateSessionIsArchived('b', true);
  projectsDb.updateProjectIsArchived('/fixture/project', true);
  const first = sessionsDb.getBackupSessionsPage({ limit: 2 });
  assert.deepEqual(first.sessions.map(row => row.session_id), ['a', 'b']);
  assert.equal(first.nextCursor, 'b');
  assert.equal(first.sessions[1].isArchived, 1);
  assert.equal(first.sessions[0].project_id, projectsDb.getProjectPath('/fixture/project')!.project_id);
  sessionsDb.updateSessionCustomName('a', 'Renamed after the first page');
  sessionsDb.deleteSessionById('a');
  sessionsDb.createAppSession('e', 'codex', '/fixture/project');
  const second = sessionsDb.getBackupSessionsPage({ cursor: first.nextCursor!, limit: 2 });
  assert.deepEqual(second.sessions.map(row => row.session_id), ['c', 'd']);
  const third = sessionsDb.getBackupSessionsPage({ cursor: second.nextCursor!, limit: 2 });
  assert.deepEqual(third.sessions.map(row => row.session_id), ['e']);
  assert.equal(third.nextCursor, null);
}));

test('explicit inventory returns the complete deduplicated selection and missing IDs', async () => fixture(() => {
  for (let index = 0; index < 121; index++) sessionsDb.createAppSession(`session-${String(index).padStart(3, '0')}`, 'claude', '/fixture/project');
  const ids = sessionsDb.getBackupSessionsPage({ limit: 500 }).sessions.map(row => row.session_id);
  const batch = sessionsDb.getBackupSessionsPage({ sessionIds: [...ids, ids[0], 'missing', 'missing'] });
  assert.equal(batch.sessions.length, 121);
  assert.deepEqual(batch.missingSessionIds, ['missing']);
  assert.equal(batch.nextCursor, null);
  assert.equal(sessionsDb.getBackupSessionsPage({}).sessions.length, 100);
  assert.deepEqual(sessionsDb.getBackupSessionsPage({ sessionIds: [] }), { sessions: [], nextCursor: null, missingSessionIds: [] });
  assert.throws(() => sessionsDb.getBackupSessionsPage({ limit: 501 }), RangeError);
  assert.throws(() => sessionsDb.getBackupSessionsPage({ sessionIds: ids, cursor: 'a' }), RangeError);
  assert.throws(() => sessionsDb.getBackupSessionsPage({ sessionIds: Array(501).fill('id') }), RangeError);
}));
