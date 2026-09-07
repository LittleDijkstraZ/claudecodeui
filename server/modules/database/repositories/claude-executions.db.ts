import { getConnection } from '@/modules/database/connection.js';
import type { ClaudeExecutionRecord } from '@/shared/types.js';

/** Used by provider Chat/Shell execution tracking to persist only whitelisted configuration evidence. */
export const claudeExecutionsDb = {
  save(record: ClaudeExecutionRecord): void {
    getConnection().prepare(`INSERT INTO claude_executions (execution_id, session_id, record_json, started_at)
      VALUES (?, ?, ?, ?)`)
      .run(record.executionId, record.appSessionId, JSON.stringify(record), record.startedAt);
  },
  /** Serialize parent runtime and independent CLI hook updates before either reads the current JSON. */
  update(executionId: string, merge: (current: ClaudeExecutionRecord) => ClaudeExecutionRecord): ClaudeExecutionRecord | null {
    const connection = getConnection();
    return connection.transaction(() => {
      const row = connection.prepare('SELECT record_json FROM claude_executions WHERE execution_id = ?').get(executionId) as { record_json: string } | undefined;
      if (!row) return null;
      const updated = merge(JSON.parse(row.record_json) as ClaudeExecutionRecord);
      connection.prepare('UPDATE claude_executions SET record_json = ? WHERE execution_id = ?').run(JSON.stringify(updated), executionId);
      return updated;
    }).immediate();
  },
  get(executionId: string): ClaudeExecutionRecord | null {
    const row = getConnection().prepare('SELECT record_json FROM claude_executions WHERE execution_id = ?').get(executionId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ClaudeExecutionRecord : null;
  },
  latest(sessionId: string, surface?: string): ClaudeExecutionRecord | null {
    const rows = getConnection().prepare('SELECT record_json FROM claude_executions WHERE session_id = ? ORDER BY started_at DESC LIMIT 100').all(sessionId) as Array<{ record_json: string }>;
    for (const row of rows) {
      const record = JSON.parse(row.record_json) as ClaudeExecutionRecord;
      if (!surface || record.surface === surface) return record;
    }
    return null;
  },
};
