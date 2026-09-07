import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { runMigrations } from '@/modules/database/migrations.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';

test('group migration upgrades an existing database idempotently and keeps session/user deletion cascades scoped', () => {
  const db = new Database(':memory:');
  try {
    // INIT_SCHEMA_SQL is the pre-group baseline: group FKs are installed only
    // after legacy session/project repairs in runMigrations.
    db.exec(INIT_SCHEMA_SQL);
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('fixture', 'fixture');
    db.prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)').run('project', '/fixture');
    db.prepare('INSERT INTO sessions (session_id, provider, project_path, custom_name) VALUES (?, ?, ?, ?)').run('session', 'claude', '/fixture', 'Keep me');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_groups'").get(), undefined);
    runMigrations(db);
    db.prepare('INSERT INTO conversation_groups (id, user_id, name) VALUES (?, 1, ?)').run('group', 'Group');
    db.prepare('INSERT INTO conversation_group_memberships (user_id, session_id, group_id) VALUES (1, ?, ?)').run('session', 'group');
    runMigrations(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM conversation_group_memberships').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT custom_name FROM sessions WHERE session_id = ?').get('session') as { custom_name: string }).custom_name, 'Keep me');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.prepare('DELETE FROM users WHERE id = 1').run();
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM conversation_groups').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM conversation_group_memberships').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count, 1);
  } finally { db.close(); }
});
