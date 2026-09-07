import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { ConversationGroupPageOptions } from '@/shared/index.js';

/** A user-owned sidebar group; counts include existing archived member sessions. */
type ConversationGroup = { id: string; name: string; sessionCount: number };

/** Persisted group listing for one authenticated user; membership keys are stable app session IDs. */
type ConversationGroupsSnapshot = {
  groups: ConversationGroup[];
  memberships: Record<string, string>;
};

const GROUP_SELECT = `SELECT g.id, g.name, COUNT(s.session_id) AS sessionCount
  FROM conversation_groups g
  LEFT JOIN conversation_group_memberships m ON m.group_id = g.id AND m.user_id = g.user_id
  LEFT JOIN sessions s ON s.session_id = m.session_id`;

/** Used by Conversation Groups to persist ownership and membership independently of project directories. */
export const conversationGroupsDb = {
  atomic<T>(operation: () => T): T {
    return getConnection().transaction(operation)();
  },

  getGroup(userId: number, id: string): ConversationGroup | null {
    return getConnection().prepare(`${GROUP_SELECT} WHERE g.user_id = ? AND g.id = ? GROUP BY g.id`)
      .get(userId, id) as ConversationGroup | undefined ?? null;
  },

  list(userId: number): ConversationGroupsSnapshot {
    const db = getConnection();
    const groups = db.prepare(`${GROUP_SELECT} WHERE g.user_id = ? GROUP BY g.id ORDER BY g.created_at, g.rowid`)
      .all(userId) as ConversationGroup[];
    const memberships = db.prepare(`SELECT m.session_id, m.group_id FROM conversation_group_memberships m
      JOIN sessions s ON s.session_id = m.session_id WHERE m.user_id = ?`)
      .all(userId) as Array<{ session_id: string; group_id: string }>;
    return { groups, memberships: Object.fromEntries(memberships.map(row => [row.session_id, row.group_id])) };
  },

  create(userId: number, name: string): ConversationGroup {
    const id = randomUUID();
    getConnection().prepare('INSERT INTO conversation_groups (id, user_id, name) VALUES (?, ?, ?)').run(id, userId, name);
    return { id, name, sessionCount: 0 };
  },

  rename(userId: number, id: string, name: string): boolean {
    return getConnection().prepare('UPDATE conversation_groups SET name = ? WHERE id = ? AND user_id = ?')
      .run(name, id, userId).changes > 0;
  },

  delete(userId: number, id: string): boolean {
    return getConnection().prepare('DELETE FROM conversation_groups WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  },

  setMembership(userId: number, sessionId: string, groupId: string | null): void {
    const db = getConnection();
    if (groupId === null) {
      db.prepare('DELETE FROM conversation_group_memberships WHERE user_id = ? AND session_id = ?').run(userId, sessionId);
      return;
    }
    // Composite FK checks both ownership and existence even for a caller that
    // bypasses the service. Each user can independently group the same session.
    db.prepare(`INSERT INTO conversation_group_memberships (user_id, session_id, group_id) VALUES (?, ?, ?)
      ON CONFLICT(user_id, session_id) DO UPDATE SET group_id = excluded.group_id`).run(userId, sessionId, groupId);
  },

  memberPage(userId: number, groupId: string, options: ConversationGroupPageOptions): { sessionIds: string[]; total: number } {
    const db = getConnection();
    const query = `%${options.query.replace(/[\\%_]/g, '\\$&')}%`;
    const from = `FROM conversation_group_memberships m
      JOIN sessions s ON s.session_id = m.session_id
      LEFT JOIN projects p ON p.project_path = s.project_path
      WHERE m.user_id = ? AND m.group_id = ?
      AND (? = '' OR COALESCE(NULLIF(trim(s.custom_name), ''), 'Untitled Session') LIKE ? ESCAPE '\\'
        OR s.session_id LIKE ? ESCAPE '\\' OR s.provider LIKE ? ESCAPE '\\'
        OR COALESCE(p.custom_project_name, '') LIKE ? ESCAPE '\\'
        OR COALESCE(s.project_path, '') LIKE ? ESCAPE '\\')`;
    const args = [userId, groupId, options.query, query, query, query, query, query];
    const { total } = db.prepare(`SELECT COUNT(*) AS total ${from}`).get(...args) as { total: number };
    const rows = db.prepare(`SELECT s.session_id ${from}
      ORDER BY julianday(COALESCE(s.updated_at, s.created_at)) DESC, s.session_id ASC LIMIT ? OFFSET ?`)
      .all(...args, options.limit, options.offset) as Array<{ session_id: string }>;
    return { sessionIds: rows.map(row => row.session_id), total };
  },
};
