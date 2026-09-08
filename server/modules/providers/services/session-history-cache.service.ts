import fsp from 'node:fs/promises';

import type { FetchHistoryResult } from '@/shared/types.js';

/**
 * Full-transcript cache for session history reads.
 *
 * Every provider history reader materializes the complete normalized
 * transcript and then slices out the requested page, so serving a 20-row page
 * of a large session re-read and re-parsed the whole transcript file on every
 * request — opening a session, each older page while scrolling up, and every
 * post-turn refresh. For a multi-megabyte JSONL that is most of a second of
 * CPU per request.
 *
 * Entries are keyed by app session id and validated with one `stat` per
 * request against the transcript file's identity (path + device/inode + change time + mtime + size), so
 * only the first read after the file changes pays the parse. Anything that
 * rewrites history (a new turn, an edit, a rewind, a fork) touches the file
 * and invalidates naturally; no explicit invalidation hooks exist or are
 * needed.
 *
 * Only history readers that read `jsonl_path` itself may use this cache —
 * callers pass `transcriptPath: null` for providers whose messages live
 * elsewhere (Cursor's store.db, OpenCode's shared SQLite), which bypasses
 * caching entirely.
 */

type CacheEntry = {
  transcriptPath: string;
  mtimeMs: number;
  /** Identity/change metadata also catches same-length rewrites preserving mtime. */
  ctimeMs: number;
  ino: number;
  dev: number;
  /** File size in bytes; doubles as the entry's cost against the byte budget. */
  size: number;
  full: FetchHistoryResult;
};

type GetFullHistoryArgs = {
  sessionId: string;
  /** Path of the file the provider's history reader actually parses, or null to bypass. */
  transcriptPath: string | null | undefined;
  /** Loads the complete transcript (`limit: null, offset: 0`) from the provider. */
  loadFull: () => Promise<FetchHistoryResult>;
};

type PendingHistoryLoad = Pick<CacheEntry, 'transcriptPath' | 'mtimeMs' | 'ctimeMs' | 'ino' | 'dev' | 'size'> & {
  result: Promise<FetchHistoryResult>;
};

/**
 * A transcript entry's heap cost is roughly the file it was parsed from, so
 * the budget is expressed in file bytes. The newest entry is always retained
 * even when it alone exceeds the budget — evicting it would just re-parse the
 * same file on the next request.
 */
const MAX_CACHED_TRANSCRIPT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;

/** Providers sessions service uses a bounded cache; focused tests create isolated instances. */
export function createSessionHistoryCache(
  maxTotalFileBytes = MAX_CACHED_TRANSCRIPT_FILE_BYTES,
  maxEntries = MAX_CACHE_ENTRIES,
) {
  const entries = new Map<string, CacheEntry>();
  const pendingLoads = new Map<string, PendingHistoryLoad>();

  function evictOverBudget(): void {
    let totalBytes = 0;
    for (const entry of entries.values()) {
      totalBytes += entry.size;
    }
    for (const key of entries.keys()) {
      if (entries.size <= 1 || (totalBytes <= maxTotalFileBytes && entries.size <= maxEntries)) {
        break;
      }
      totalBytes -= entries.get(key)!.size;
      entries.delete(key);
    }
  }

  return {
    /**
     * Returns the session's full transcript through the cache, or null when
     * the session is not cacheable (no transcript path, or the file cannot be
     * stat'ed) — the caller then falls back to a plain provider read.
     */
    async getFullHistory({ sessionId, transcriptPath, loadFull }: GetFullHistoryArgs): Promise<FetchHistoryResult | null> {
      if (!transcriptPath) {
        return null;
      }

      let stat;
      try {
        stat = await fsp.stat(transcriptPath);
      } catch {
        entries.delete(sessionId);
        return null;
      }
      if (!stat.isFile()) {
        entries.delete(sessionId);
        return null;
      }

      const cached = entries.get(sessionId);
      if (
        cached
        && cached.transcriptPath === transcriptPath
        && cached.mtimeMs === stat.mtimeMs
        && cached.ctimeMs === stat.ctimeMs && cached.ino === stat.ino && cached.dev === stat.dev
        && cached.size === stat.size
      ) {
        // Re-insert to mark as most recently used.
        entries.delete(sessionId);
        entries.set(sessionId, cached);
        return cached.full;
      }

      // Share only the same transcript snapshot. Shell may append new rows
      // (or rewind may remap the native path) while an older parse is pending.
      const pending = pendingLoads.get(sessionId);
      if (pending && pending.transcriptPath === transcriptPath
        && pending.mtimeMs === stat.mtimeMs && pending.ctimeMs === stat.ctimeMs
        && pending.ino === stat.ino && pending.dev === stat.dev && pending.size === stat.size) {
        return pending.result;
      }

      const load = loadFull().then((full) => {
        // A slow parse of an old snapshot must not overwrite the cache after
        // a newer request has already loaded the changed transcript.
        if (pendingLoads.get(sessionId)?.result === load) {
          entries.delete(sessionId);
          entries.set(sessionId, { transcriptPath, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev, size: stat.size, full });
          evictOverBudget();
        }
        return full;
      });
      pendingLoads.set(sessionId, { transcriptPath, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev, size: stat.size, result: load });
      try {
        return await load;
      } finally {
        if (pendingLoads.get(sessionId)?.result === load) pendingLoads.delete(sessionId);
      }
    },
  };
}

/** Shared bounded transcript cache used by providers sessions service. */
export const sessionHistoryCache = createSessionHistoryCache();
