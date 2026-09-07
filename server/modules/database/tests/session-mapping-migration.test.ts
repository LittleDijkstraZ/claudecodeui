import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';

type SessionMapping = { session_id: string; provider_session_id: string | null };

test('startup migrations preserve pending drafts and assigned mappings across restarts', () => {
  const db = new Database(':memory:');
  try {
    db.exec(INIT_SCHEMA_SQL);
    runMigrations(db);
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES (1, 'fixture', 'fixture');
      INSERT INTO sessions (session_id, provider, provider_session_id, custom_name)
      VALUES ('draft', 'claude', NULL, NULL), ('assigned', 'claude', 'native-assigned', 'Existing');
      INSERT INTO conversation_groups (id, user_id, name) VALUES ('group', 1, 'Group');
      INSERT INTO conversation_group_memberships (user_id, session_id, group_id) VALUES (1, 'draft', 'group');
    `);
    runMigrations(db);
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT session_id, provider_session_id FROM sessions ORDER BY session_id').all(), [
      { session_id: 'assigned', provider_session_id: 'native-assigned' },
      { session_id: 'draft', provider_session_id: null },
    ]);
    assert.equal((db.prepare('SELECT group_id FROM conversation_group_memberships WHERE session_id = ?').get('draft') as { group_id: string }).group_id, 'group');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('introducing the mapping column backfills legacy provider ids exactly once', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        project_path TEXT,
        custom_name TEXT
      );
      INSERT INTO sessions (session_id, provider, custom_name) VALUES ('native-legacy', 'claude', 'Keep legacy title');
    `);
    // Mirrors initializeDatabase: CREATE IF NOT EXISTS does not upgrade the
    // existing sessions table; runMigrations must introduce the column.
    db.exec(INIT_SCHEMA_SQL);
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT session_id, provider_session_id FROM sessions').all(), [
      { session_id: 'native-legacy', provider_session_id: 'native-legacy' },
    ]);
    db.exec("INSERT INTO sessions (session_id, provider, provider_session_id) VALUES ('new-draft', 'claude', NULL)");
    runMigrations(db);
    assert.equal((db.prepare('SELECT session_id, provider_session_id FROM sessions WHERE session_id = ?').get('new-draft') as SessionMapping).provider_session_id, null);
    assert.equal((db.prepare('SELECT custom_name FROM sessions WHERE session_id = ?').get('native-legacy') as { custom_name: string }).custom_name, 'Keep legacy title');
  } finally {
    db.close();
  }
});

test('importing legacy session names into a modern schema maps only imported legacy rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec(INIT_SCHEMA_SQL);
    db.exec(`
      INSERT INTO sessions (session_id, provider, provider_session_id) VALUES ('draft', 'claude', NULL);
      CREATE TABLE session_names (
        session_id TEXT PRIMARY KEY,
        provider TEXT,
        custom_name TEXT,
        created_at DATETIME,
        updated_at DATETIME
      );
      INSERT INTO session_names (session_id, provider, custom_name) VALUES ('legacy-name', 'claude', 'Legacy title');
    `);
    runMigrations(db);
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT session_id, provider_session_id FROM sessions ORDER BY session_id').all(), [
      { session_id: 'draft', provider_session_id: null },
      { session_id: 'legacy-name', provider_session_id: 'legacy-name' },
    ]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_names'").get(), undefined);
  } finally {
    db.close();
  }
});
