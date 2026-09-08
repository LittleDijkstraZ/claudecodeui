import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { AppError } from '@/shared/index.js';

/** Used by Claude session actions to persist branch ancestry and atomically replace rewind context. */
export const claudeSessionActionsDb = {
  relationship(sessionId: string) {
    return getConnection().prepare(`SELECT parent_session_id AS parentSessionId,
      source_message_id AS sourceMessageId, kind FROM claude_session_branches WHERE session_id = ?`)
      .get(sessionId) as { parentSessionId: string | null; sourceMessageId: string | null; kind: 'side_chat' | 'rewind_backup' } | undefined;
  },

  createBranch(sourceSessionId: string, providerSessionId: string, jsonlPath: string, title: string, messageId?: string) {
    return getConnection().transaction(() => {
      const source = sessionsDb.getSessionById(sourceSessionId);
      if (!source?.project_path) throw new AppError('Source session was removed.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      const sessionId = randomUUID();
      sessionsDb.createAppSession(sessionId, 'claude', source.project_path, title);
      sessionsDb.assignProviderSessionId(sessionId, providerSessionId);
      getConnection().prepare('UPDATE sessions SET jsonl_path = ?, model = ?, effort = ?, forked_from_session_id = ? WHERE session_id = ?')
        .run(jsonlPath, source.model, source.effort, sourceSessionId, sessionId);
      getConnection().prepare(`INSERT INTO claude_session_branches (session_id, parent_session_id, source_message_id, kind)
        VALUES (?, ?, ?, 'side_chat')`).run(sessionId, sourceSessionId, messageId ?? null);
      return sessionId;
    })();
  },

  canDiscardPreparedBranch(providerSessionId: string): boolean {
    const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
    if (!row) return true;
    // Keep any branch another caller already adopted or organized.
    return row.session_id === providerSessionId && !getConnection().prepare(
      'SELECT 1 FROM conversation_group_memberships WHERE session_id = ? LIMIT 1',
    ).get(row.session_id) && !this.relationship(row.session_id);
  },

  discardPreparedBranchRow(providerSessionId: string): void {
    const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
    if (row?.session_id === providerSessionId && this.canDiscardPreparedBranch(providerSessionId)) {
      sessionsDb.deleteSessionById(row.session_id);
    }
  },

  replaceContext(sessionId: string, expectedProviderId: string, providerSessionId: string, jsonlPath: string, messageId: string) {
    return getConnection().transaction(() => {
      const db = getConnection();
      const source = sessionsDb.getSessionById(sessionId);
      if (source?.provider_session_id !== expectedProviderId) {
        throw new AppError('The conversation changed. Preview the rewind again.', { code: 'REWIND_PREVIEW_STALE', statusCode: 409 });
      }
      // Keep the original native transcript addressable before switching the stable app id.
      const backupSessionId = randomUUID();
      db.prepare(`INSERT INTO sessions (session_id, provider, provider_session_id, project_path, jsonl_path,
        custom_name, model, effort, forked_from_session_id, isArchived, created_at, updated_at)
        SELECT ?, provider, provider_session_id, project_path, jsonl_path, ?, model, effort, forked_from_session_id, 1, created_at, updated_at
        FROM sessions WHERE session_id = ?`).run(backupSessionId, `${source.custom_name || 'Conversation'} — before rewind`, sessionId);
      db.prepare(`INSERT INTO claude_session_branches (session_id, parent_session_id, source_message_id, kind)
        VALUES (?, ?, ?, 'rewind_backup')`).run(backupSessionId, sessionId, messageId);
      // Unsent input belongs to the original native context. Retain it with
      // that branch, but never let a timer submit it into the replacement.
      const drafts = db.prepare('SELECT user_id, queued_message FROM session_drafts WHERE draft_scope = ?')
        .all(sessionId) as Array<{ user_id: number; queued_message: string | null }>;
      for (const draft of drafts) {
        let queued = draft.queued_message;
        try {
          const value: unknown = queued ? JSON.parse(queued) : null;
          if (value && typeof value === 'object' && !Array.isArray(value)) queued = JSON.stringify({ ...value, rewindPaused: true });
        } catch { /* Keep unparseable saved content addressable on the original branch. */ }
        db.prepare('UPDATE session_drafts SET draft_scope = ?, queued_message = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND draft_scope = ?')
          .run(backupSessionId, queued, draft.user_id, sessionId);
      }
      db.prepare(`UPDATE scheduled_messages SET session_id = ?,
        failure_reason = CASE WHEN status = 'pending' THEN 'Conversation was rewound; this message is retained on the original branch and will not be sent automatically.' ELSE failure_reason END,
        status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END, updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?`).run(backupSessionId, sessionId);
      sessionsDb.assignProviderSessionId(sessionId, providerSessionId);
      db.prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run(jsonlPath, sessionId);
      return backupSessionId;
    })();
  },
};
