import type { ClaudeUsageSnapshot } from '@/shared/types';

/** Transport payload guard used by the reducer and usage UI; no missing number is treated as zero. */
export function isClaudeUsageSnapshot(value: unknown): value is ClaudeUsageSnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ClaudeUsageSnapshot>;
  return record.schemaVersion === 2 && record.provider === 'claude' && typeof record.sessionId === 'string'
    && Number.isSafeInteger(record.revision) && Number(record.revision) >= 0
    && Boolean(record.context && record.session && record.session.tokens && record.session.models);
}

/** Every REST/history/live source shares the same per-remote, per-session monotonic reducer. */
export function acceptClaudeUsageSnapshot(previous: unknown, incoming: unknown, sessionId: string, scope: string, incomingScope = scope): unknown {
  if (incomingScope !== scope) return previous;
  if (isClaudeUsageSnapshot(incoming)) {
    if (incoming.sessionId !== sessionId) return previous;
    if (isClaudeUsageSnapshot(previous) && previous.sessionId === sessionId && previous.revision >= incoming.revision) return previous;
    return incoming;
  }
  // An older server/history response cannot overwrite a versioned ledger with
  // a legacy cumulative number (nor replace a known snapshot with null).
  return isClaudeUsageSnapshot(previous) ? previous : incoming;
}
