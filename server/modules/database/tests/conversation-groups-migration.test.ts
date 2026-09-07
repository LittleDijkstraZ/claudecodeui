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

test('ordering upgrade seeds each existing group from recency once and retains manual order on later starts', () => {
  const db = new Database(':memory:');
  try {
    db.exec(INIT_SCHEMA_SQL);
    // The deployed pre-ordering schema intentionally lacks both new columns.
    db.exec(`
      CREATE TABLE conversation_groups (
        id TEXT PRIMARY KEY NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (id, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE conversation_group_memberships (
        user_id INTEGER NOT NULL, session_id TEXT NOT NULL, group_id TEXT NOT NULL,
        PRIMARY KEY (user_id, session_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (group_id, user_id) REFERENCES conversation_groups(id, user_id) ON DELETE CASCADE
      );
      INSERT INTO users (id, username, password_hash) VALUES (1, 'one', 'fixture'), (2, 'two', 'fixture');
      INSERT INTO conversation_groups (id, user_id, name) VALUES ('one', 1, 'One'), ('two', 2, 'Two');
      INSERT INTO sessions (session_id, provider, created_at, updated_at) VALUES
        ('a', 'claude', '2026-01-01', '2026-01-01'),
        ('b', 'claude', '2026-01-02', '2026-01-02'),
        ('c', 'claude', '2026-01-02', '2026-01-02');
      INSERT INTO conversation_group_memberships (user_id, session_id, group_id) VALUES
        (1, 'a', 'one'), (1, 'c', 'one'), (1, 'b', 'one'), (2, 'a', 'two'), (2, 'b', 'two');
    `);
    runMigrations(db);
    const order = (id: string) => db.prepare('SELECT session_id FROM conversation_group_memberships WHERE group_id = ? ORDER BY sort_order, session_id')
      .all(id).map(row => (row as { session_id: string }).session_id);
    assert.deepEqual(order('one'), ['b', 'c', 'a']);
    assert.deepEqual(order('two'), ['b', 'a']);
    assert.deepEqual(db.prepare('SELECT is_pinned FROM conversation_groups').all(), [{ is_pinned: 0 }, { is_pinned: 0 }]);
    db.exec(`
      UPDATE conversation_group_memberships SET sort_order = CASE session_id WHEN 'a' THEN 0 WHEN 'b' THEN 1 ELSE 2 END WHERE group_id = 'one';
      UPDATE conversation_groups SET is_pinned = 1 WHERE id = 'one';
      UPDATE sessions SET updated_at = '2099-01-01' WHERE session_id = 'c';
    `);
    runMigrations(db);
    runMigrations(db);
    assert.deepEqual(order('one'), ['a', 'b', 'c']);
    assert.deepEqual(order('two'), ['b', 'a']);
    assert.equal((db.prepare("SELECT is_pinned FROM conversation_groups WHERE id = 'one'").get() as { is_pinned: number }).is_pinned, 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_conversation_group_member_order'").get());
  } finally {
    db.close();
  }
});
