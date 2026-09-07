import { getConnection } from '@/modules/database/connection.js';
import type { ClaudeUsageContext } from '@/shared/index.js';

type UsageRow = { session_id: string; revision: number; native_context_id: string | null; context_json: string | null; latest_execution_id: string | null; history_json: string; history_coverage: 'new-session' | 'observed-requests' | 'inherited-context'; updated_at: string };
type ExecutionRow = { execution_id: string; provider_session_id: string | null; state_json: string; started_at: string; updated_at: string };
type RequestRow = { request_id: string; kind: 'managed' | 'external' | 'inherited' | 'unattributed'; model: string | null; counters_json: string | null };

/** Used only by Claude usage accounting to persist operational counters and identities, never message content. */
export const claudeUsageDb = {
  get(sessionId: string): UsageRow | undefined {
    return getConnection().prepare('SELECT * FROM claude_usage_sessions WHERE session_id = ?').get(sessionId) as UsageRow | undefined;
  },
  recoveryContexts(sessionId: string): Array<{ provider_session_id: string; jsonl_path: string }> {
    return getConnection().prepare(`SELECT s.provider_session_id, s.jsonl_path FROM sessions s
      JOIN claude_session_branches b ON b.session_id = s.session_id
      WHERE b.parent_session_id = ? AND b.kind = 'rewind_backup' AND s.provider_session_id IS NOT NULL AND s.jsonl_path IS NOT NULL`)
      .all(sessionId) as Array<{ provider_session_id: string; jsonl_path: string }>;
  },
  ensure(sessionId: string, nativeId: string | null): void {
    getConnection().prepare('INSERT OR IGNORE INTO claude_usage_sessions (session_id, native_context_id) VALUES (?, ?)').run(sessionId, nativeId);
  },
  executions(sessionId: string): ExecutionRow[] {
    return getConnection().prepare('SELECT execution_id, provider_session_id, state_json, started_at, updated_at FROM claude_usage_executions WHERE session_id = ? ORDER BY started_at, rowid').all(sessionId) as ExecutionRow[];
  },
  requests(sessionId: string): RequestRow[] {
    return getConnection().prepare('SELECT request_id, kind, model, counters_json FROM claude_usage_requests WHERE session_id = ?').all(sessionId) as RequestRow[];
  },
  begin(sessionId: string, executionId: string, nativeId: string | null, state: unknown): void {
    getConnection().transaction(() => {
      this.ensure(sessionId, nativeId);
      getConnection().prepare('INSERT INTO claude_usage_executions (execution_id, session_id, provider_session_id, state_json) VALUES (?, ?, ?, ?)').run(executionId, sessionId, nativeId, JSON.stringify(state));
      getConnection().prepare("UPDATE claude_usage_sessions SET latest_execution_id = ?, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id = ?").run(executionId, sessionId);
    })();
  },
  save(sessionId: string, executionId: string, nativeId: string | null, state: unknown, requestIds: string[], context: ClaudeUsageContext | null): void {
    getConnection().transaction(() => {
      const db = getConnection();
      db.prepare("UPDATE claude_usage_executions SET provider_session_id = ?, state_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE execution_id = ? AND session_id = ?").run(nativeId, JSON.stringify(state), executionId, sessionId);
      const claim = db.prepare("INSERT INTO claude_usage_requests (session_id, request_id, kind) VALUES (?, ?, 'managed') ON CONFLICT(session_id, request_id) DO UPDATE SET kind = CASE WHEN kind = 'inherited' THEN kind ELSE 'managed' END");
      for (const id of requestIds) claim.run(sessionId, id);
      // Spend from a superseded run remains valid; only the current run may replace context.
      if (context) db.prepare('UPDATE claude_usage_sessions SET context_json = ?, native_context_id = ? WHERE session_id = ? AND latest_execution_id = ?').run(JSON.stringify(context), nativeId, sessionId, executionId);
      db.prepare("UPDATE claude_usage_sessions SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id = ?").run(sessionId);
    })();
  },
  history(sessionId: string, nativeId: string | null, fingerprints: Record<string, string>, requests: Array<{ id: string; model: string; counters: unknown; kind?: 'external' | 'managed' | 'unattributed' }>, context: ClaudeUsageContext | null, hadHistory: boolean): void {
    getConnection().transaction(() => {
      const db = getConnection();
      const insert = db.prepare("INSERT INTO claude_usage_requests (session_id, request_id, kind, model, counters_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, request_id) DO UPDATE SET kind = CASE WHEN kind IN ('inherited', 'managed') THEN kind ELSE excluded.kind END, counters_json = CASE WHEN kind IN ('external', 'unattributed') THEN excluded.counters_json ELSE counters_json END");
      for (const request of requests) insert.run(sessionId, request.id, request.kind ?? 'external', request.model, JSON.stringify(request.counters));
      db.prepare("UPDATE claude_usage_sessions SET history_json = ?, native_context_id = ?, context_json = COALESCE(?, context_json), history_coverage = CASE WHEN history_coverage = 'new-session' AND ? THEN 'observed-requests' ELSE history_coverage END, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id = ?")
        .run(JSON.stringify(fingerprints), nativeId, context ? JSON.stringify(context) : null, hadHistory ? 1 : 0, sessionId);
    })();
  },
  inherit(sourceSessionId: string, childSessionId: string, nativeId: string | null): void {
    getConnection().transaction(() => {
      this.ensure(childSessionId, nativeId);
      getConnection().prepare("INSERT OR IGNORE INTO claude_usage_requests (session_id, request_id, kind) SELECT ?, request_id, 'inherited' FROM claude_usage_requests WHERE session_id = ?").run(childSessionId, sourceSessionId);
      getConnection().prepare("UPDATE claude_usage_sessions SET history_coverage = 'inherited-context', revision = revision + 1 WHERE session_id = ?").run(childSessionId);
    })();
  },
};
