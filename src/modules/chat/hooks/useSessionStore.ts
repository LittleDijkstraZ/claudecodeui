/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * Backend JSONL owns confirmed history; only unconfirmed user copies survive browser reloads.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { acceptClaudeUsageSnapshot, isClaudeUsageSnapshot } from '@/modules/chat/utils/claudeUsageSnapshot';
import { api } from '@/shared/api';
import { hasSameUserMessageIdentity } from '@/shared/utils';
import type { ChatMessageDelivery, LLMProvider, NormalizedMessage } from '@/shared/types';
import { createPendingUserMessages } from '@/modules/chat/utils/pendingUserMessages';
import { removeOptimisticUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';
import {
  hasReachedCachedTailTimeBoundary,
  mergeLatestServerPage,
  mergeOlderServerPage,
  planLatestPageBridge,
  resolveLatestPagePagination,
  SESSION_MESSAGES_PAGE_SIZE,
} from '@/modules/chat/utils/sessionMessagePagination';
import type { SessionMessagesRequestOptions } from '@/modules/chat/utils/sessionMessagePagination';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────


// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export type SessionSlot = {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  /**
   * @internal Serializes history reads for this session so an older-page
   * request calculates its offset after any latest-page refresh completes.
   */
  _historyMutationQueue: Promise<void>;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
  /** Last committed context reset prevents duplicate HTTP/WS notifications moving newer inputs. */
  contextRevision?: string;
};

const EMPTY: NormalizedMessage[] = [];
const SESSION_HISTORY_REQUEST_TIMEOUT_MS = 30_000;

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    // `undefined` means "no page has reported usage for this session yet", and
    // every consumer distinguishes that from a reported `null`. Initialising it
    // to `null` made the two indistinguishable, so a provider whose history
    // payload carries no usage looked like one reporting zero — and every
    // history refresh overwrote the value fetched from the token-usage
    // endpoint with it.
    tokenUsage: undefined,
    _historyMutationQueue: Promise.resolve(),
  };
}

type SessionHistoryPage = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  tokenUsage?: unknown;
};

function enqueueHistoryMutation<T>(
  slot: SessionSlot,
  operation: () => Promise<T>,
): Promise<T> {
  const result = slot._historyMutationQueue.then(operation);
  slot._historyMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function requestSessionHistoryPage(
  sessionId: string,
  options: SessionMessagesRequestOptions,
): Promise<SessionHistoryPage> {
  const response = await api.providers.sessionMessages(sessionId, options, {
    signal: AbortSignal.timeout(SESSION_HISTORY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = await response.json();
  const data = body?.data ?? body;
  const messages: NormalizedMessage[] = Array.isArray(data.messages) ? data.messages : [];

  return {
    messages,
    total: typeof data.total === 'number' ? data.total : messages.length,
    hasMore: Boolean(data.hasMore),
    ...(
      data && typeof data === 'object' && 'tokenUsage' in data
        ? { tokenUsage: data.tokenUsage }
        : {}
    ),
  };
}

/**
 * Compute merged messages: server + realtime, deduped by id and adjacent
 * assistant echo (same trimmed text), so finalized stream rows do not stack
 * on top of the persisted copy before realtime is cleared.
 */
function readMessageTime(m: NormalizedMessage): number | null {
  const time = Date.parse(m.timestamp);
  return Number.isFinite(time) ? time : null;
}

function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

/**
 * Resolve a synthetic live reply to its saved user turn. Claude requires an
 * exact observed identity; legacy providers retain their chronological fallback.
 */
function getUserTurnOrdinalBefore(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): number | null {
  if (message.provider === 'claude') {
    // Native append order wins over clocks. Only a shared user/native identity
    // can place a synthetic stream in a saved turn; equal prose is not enough.
    const messageIndex = realtimeMessages.findIndex(candidate => candidate.id === message.id);
    const preceding = realtimeMessages.slice(0, messageIndex < 0 ? 0 : messageIndex);
    const user = [...preceding].reverse().find(candidate => candidate.kind === 'text' && candidate.role === 'user' && !candidate.isUnlocatedLocalCopy);
    const anchorIndex = user
      ? serverMessages.findIndex(candidate => hasSameUserMessageIdentity(user, candidate))
      : serverMessages.findIndex(candidate => candidate.id === preceding.at(-1)?.id);
    if (anchorIndex < 0) return null;
    return serverMessages.slice(0, anchorIndex + 1).filter(candidate => candidate.kind === 'text' && candidate.role === 'user').length - 1;
  }
  const messageTime = readMessageTime(message);
  let userCount = 0;

  for (const candidate of [...serverMessages, ...realtimeMessages].sort(compareMessagesChronologically)) {
    if (candidate.id === message.id) {
      break;
    }

    const candidateTime = readMessageTime(candidate);
    if (
      messageTime !== null
      && candidateTime !== null
      && candidateTime > messageTime
    ) {
      break;
    }

    if (candidate.kind === 'text' && candidate.role === 'user') {
      userCount++;
    }
  }

  return Math.max(0, userCount - 1);
}

function findServerTurnRangeByOrdinal(
  serverMessages: NormalizedMessage[],
  turnOrdinal: number,
): { start: number; end: number } | null {
  let userCount = -1;
  let start = -1;

  for (let index = 0; index < serverMessages.length; index++) {
    const message = serverMessages[index];
    if (message.kind === 'text' && message.role === 'user') {
      userCount++;
      if (userCount === turnOrdinal) {
        start = index;
        break;
      }
    }
  }

  if (start < 0) {
    return null;
  }

  let end = serverMessages.length;
  for (let index = start + 1; index < serverMessages.length; index++) {
    if (serverMessages[index].kind === 'text' && serverMessages[index].role === 'user') {
      end = index;
      break;
    }
  }

  return { start, end };
}

function isAssistantTextEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): boolean {
  // Native UUIDs already distinguish independent recorded answers, including
  // repeated words. Only synthetic Claude stream rows need a prose fallback.
  if (message.provider === 'claude' && message.kind !== 'stream_delta' && !message.id.startsWith('text_')) return false;
  const assistantText = (message.content || '').trim();
  if (!assistantText) {
    return false;
  }

  const turnOrdinal = getUserTurnOrdinalBefore(message, serverMessages, realtimeMessages);
  const turnRange = turnOrdinal === null ? null : findServerTurnRangeByOrdinal(serverMessages, turnOrdinal);
  if (!turnRange) {
    return false;
  }

  return serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .some((serverMessage) =>
      serverMessage.kind === 'text'
      && serverMessage.role === 'assistant'
      && (serverMessage.content || '').trim() === assistantText,
    );
}

/**
 * After `finalizeStreaming`, the client holds a synthetic assistant `text` row
 * while the sessions API soon returns the same reply with a different id.
 * Those sit back-to-back in merged order and look like duplicate bubbles until
 * A persisted-tail refresh reconciles realtime. Collapse same-text assistant rows and
 * stream_placeholder → text when content matches.
 */
function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[], serverIds: ReadonlySet<string> = new Set()): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of merged) {
    const prev = out[out.length - 1];
    if (prev) {
      const isSynthetic = (row: NormalizedMessage) => row.kind === 'stream_delta' || row.id.startsWith('text_');
      if ((serverIds.has(prev.id) && serverIds.has(m.id))
        || (prev.provider === 'claude' && m.provider === 'claude' && !isSynthetic(prev) && !isSynthetic(m))) {
        out.push(m);
        continue;
      }
      if (prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[out.length - 1] = m;
          continue;
        }
      }
      if (
        prev.kind === 'text'
        && m.kind === 'text'
        && prev.role === 'assistant'
        && m.role === 'assistant'
      ) {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) {
          continue;
        }
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * After a server refresh, drop only the realtime rows the persisted transcript
 * already owns. Anything not yet on disk (common right after `complete`, while
 * JSONL indexing lags) stays in `realtimeMessages` so the chat pane never
 * flashes the empty "Continue your conversation" state.
 */
function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  realtimeAtRequestStart?: ReadonlySet<NormalizedMessage>,
): NormalizedMessage[] {
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const reconciledRealtimeMessages = new Set(removeOptimisticUserEchoes(serverMessages, realtimeMessages));

  return realtimeMessages.filter((message) => {
    // An exact persisted user identity retires its copy even when a newer
    // receipt arrived during this read; receipt replay cannot undo confirmation.
    if (!reconciledRealtimeMessages.has(message)) return false;
    // A REST response reflects an earlier point in time. New or replaced WS
    // output received during its request must survive even with the same ID.
    if (realtimeAtRequestStart && !realtimeAtRequestStart.has(message)) return true;
    if (serverIds.has(message.id)) {
      return false;
    }

    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return true;
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });
}

function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[], previous: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return server;
  }
  if (server.length === 0) {
    return dedupeAdjacentAssistantEchoes(realtime);
  }

  const serverIds = new Set(server.map((message) => message.id));
  const reconciledRealtime = removeOptimisticUserEchoes(server, realtime);
  // Rows surviving history reconciliation are newer than that snapshot (or
  // not yet persisted). A same-ID live update must win over stale REST data.
  const realtimeById = new Map(reconciledRealtime.map(message => [message.id, message]));
  const serverWithLiveUpdates = server.map(message => realtimeById.get(message.id) ?? message);
  const extra = reconciledRealtime.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }
    return true;
  });

  if (extra.length === 0) {
    return dedupeAdjacentAssistantEchoes(serverWithLiveUpdates, serverIds);
  }

  // The API owns transcript order. Browser/receipt clocks can be hours apart,
  // and even native timestamps can move backwards after a resume or copy.
  // Place live rows before the next exact saved row already observed alongside
  // them. Otherwise they remain at the live tail; never re-sort saved history.
  const serverIndex = new Map(server.map((message, index) => [message.id, index]));
  const extraById = new Map(extra.map(message => [message.id, message]));
  const observed = [...previous, ...reconciledRealtime];
  const observedIds = new Set<string>();
  const sequence = observed.filter(message => {
    if (observedIds.has(message.id)) return false;
    observedIds.add(message.id);
    return serverIndex.has(message.id) || extraById.has(message.id);
  });
  const beforeServer = new Map<number, NormalizedMessage[]>();
  const retainedCopies: NormalizedMessage[] = [];
  let nextServerIndex = server.length;
  for (let index = sequence.length - 1; index >= 0; index--) {
    const message = sequence[index];
    const savedIndex = serverIndex.get(message.id);
    if (savedIndex !== undefined) {
      nextServerIndex = savedIndex;
      continue;
    }
    const live = extraById.get(message.id)!;
    if (live.isUnlocatedLocalCopy) {
      retainedCopies.unshift(live);
      continue;
    }
    const bucket = beforeServer.get(nextServerIndex) ?? [];
    bucket.unshift(live);
    beforeServer.set(nextServerIndex, bucket);
  }
  const ordered = serverWithLiveUpdates.flatMap((message, index) => [
    ...(beforeServer.get(index) ?? []), message,
  ]);
  ordered.push(...(beforeServer.get(server.length) ?? []));
  // Retained copies remain available to the UI in their own labelled section,
  // without acting as transcript turns or changing the order of native rows.
  return [...dedupeAdjacentAssistantEchoes(ordered, serverIds), ...retainedCopies];
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages, slot.merged);
  return true;
}

type LatestHistoryRefreshResult = {
  applied: boolean;
  changed: boolean;
  deferred: boolean;
};

type CanRequestHistory = () => boolean;

// Token usage is JSON response data, so compare its serialized value instead
// of treating each freshly parsed response object as a state change.
function hasEquivalentTokenUsage(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function olderPagePrecedesCachedHistory(
  olderMessages: NormalizedMessage[],
  cachedMessages: NormalizedMessage[],
): boolean {
  const olderNewest = olderMessages[olderMessages.length - 1];
  const cachedOldest = cachedMessages[0];
  if (!olderNewest || !cachedOldest) return true;
  // Claude pages already have authoritative append order; a clock adjustment
  // must not make an otherwise contiguous preceding page impossible to load.
  if (olderNewest.provider === 'claude' && cachedOldest.provider === 'claude') return true;

  const olderTime = readMessageTime(olderNewest);
  const cachedTime = readMessageTime(cachedOldest);
  return olderTime === null || cachedTime === null || olderTime <= cachedTime;
}

/**
 * Fetches and atomically applies a bounded persisted-tail reconciliation.
 * Every request is finite. Claude/Codex bridge discovery may use more than one
 * bounded chunk because their response `total` omits paginated tool results.
 */
async function refreshLatestSlotFromServer(
  sessionId: string,
  slot: SessionSlot,
  limit: number,
  canRequest: CanRequestHistory = () => true,
): Promise<LatestHistoryRefreshResult> {
  if (!canRequest()) {
    return { applied: false, changed: false, deferred: true };
  }

  const previousServerMessages = slot.serverMessages;
  const previousTotal = slot.total;
  const previousHasMore = slot.hasMore;
  const realtimeAtRequestStart = new Set(slot.realtimeMessages);
  const latestPage = await requestSessionHistoryPage(sessionId, {
    limit,
    offset: 0,
  });

  let nextServerMessages: NormalizedMessage[] | null = null;
  let nextHasMore = previousHasMore;

  // A page with no older rows is the complete authoritative transcript. This
  // also removes cached rows after a provider-side truncation.
  if (!latestPage.hasMore) {
    nextServerMessages = latestPage.messages;
    nextHasMore = false;
  } else if (previousServerMessages.length === 0) {
    nextServerMessages = latestPage.messages;
    nextHasMore = true;
  } else {
    let fetchedWindow = latestPage.messages;
    let oldestFetchedPage = latestPage;
    let bridgeRowsFetched = 0;
    let reachedStartOfHistory = false;
    let mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

    while (
      mergedPage.overlapLength === 0
      && !hasReachedCachedTailTimeBoundary(previousServerMessages, fetchedWindow)
    ) {
      const bridgeRequest = planLatestPageBridge(
        previousServerMessages,
        latestPage.messages,
        previousTotal,
        latestPage.total,
        bridgeRowsFetched,
      );
      if (!bridgeRequest) break;
      if (!canRequest()) {
        return { applied: false, changed: false, deferred: true };
      }

      const bridgePage = await requestSessionHistoryPage(sessionId, bridgeRequest);
      if (bridgePage.total !== latestPage.total) {
        console.warn(`[SessionStore] History changed while bridging ${sessionId}; retaining cached suffix.`);
        return { applied: false, changed: false, deferred: false };
      }
      if (bridgePage.messages.length === 0) break;

      const bridgeMerge = mergeOlderServerPage(fetchedWindow, bridgePage.messages);
      if (
        bridgeMerge.overlapLength > 0
        || !olderPagePrecedesCachedHistory(bridgePage.messages, fetchedWindow)
      ) {
        console.warn(`[SessionStore] History shifted while bridging ${sessionId}; retaining cached suffix.`);
        return { applied: false, changed: false, deferred: false };
      }

      fetchedWindow = bridgeMerge.messages;
      oldestFetchedPage = bridgePage;
      bridgeRowsFetched += bridgePage.messages.length;
      mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

      if (!bridgePage.hasMore) {
        reachedStartOfHistory = true;
        break;
      }
    }

    if (reachedStartOfHistory) {
      nextServerMessages = fetchedWindow;
      nextHasMore = false;
    } else if (mergedPage.overlapLength > 0) {
      nextServerMessages = mergedPage.messages;
      nextHasMore = resolveLatestPagePagination(
        previousServerMessages.length,
        nextServerMessages.length,
        previousHasMore,
        oldestFetchedPage.hasMore,
      ).hasMore;
    }
  }

  let changed = false;
  if (
    latestPage.tokenUsage !== undefined
    && !hasEquivalentTokenUsage(latestPage.tokenUsage, slot.tokenUsage)
  ) {
    slot.tokenUsage = acceptClaudeUsageSnapshot(slot.tokenUsage, latestPage.tokenUsage, sessionId, window.__REMOTE_ID__ || window.location.origin);
    changed = true;
  }

  if (!nextServerMessages) {
    console.warn(`[SessionStore] Could not bridge latest history for ${sessionId}; retaining cached suffix.`);
    return { applied: false, changed, deferred: false };
  }

  slot.serverMessages = nextServerMessages;
  slot.total = latestPage.total;
  slot.offset = nextServerMessages.length;
  slot.hasMore = nextHasMore;
  slot.fetchedAt = Date.now();
  slot.realtimeMessages = pruneRealtimeSupersededByServer(
    slot.serverMessages,
    slot.realtimeMessages,
    realtimeAtRequestStart,
  );
  recomputeMergedIfNeeded(slot);

  return { applied: true, changed: true, deferred: false };
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore(userId?: string | number | null) {
  const scope = JSON.stringify([window.__REMOTE_ID__ || window.location.origin, userId ?? null]);
  // A changed account owns a fresh cache; old async callbacks retain their old map.
  const storeRef = useMemo(() => ({ scope, current: new Map<string, SessionSlot>() }), [scope]);
  // Storage failure must be visible while the in-memory input copy stays intact.
  const [pendingMessageStorageFailed, setPendingMessageStorageFailed] = useState(false);
  // Unconfirmed sends survive reloads under this machine scope; they never auto-resend.
  const pendingUsers = useMemo(() => createPendingUserMessages(scope, () => setPendingMessageStorageFailed(true)), [scope]);
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly with
  // no alias/redirect indirection.
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      const slot = createEmptySlot();
      slot.realtimeMessages = pendingUsers.restore(sessionId);
      recomputeMergedIfNeeded(slot);
      store.set(sessionId, slot);
    }
    return store.get(sessionId)!;
  }, [pendingUsers, storeRef]);

  /**
   * Fetch messages from the provider sessions endpoint and populate serverMessages.
   *
   * Provider and project metadata are resolved server-side from `sessionId`.
   * The endpoint returns the standard `{ success, data }` envelope.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    slot.status = 'loading';
    notify(sessionId);

    return enqueueHistoryMutation(slot, async () => {
      const { canRequest = () => true, ...requestOptions } = opts;
      if (!canRequest()) {
        slot.status = 'idle';
        notify(sessionId);
        return null;
      }

      try {
        const realtimeAtRequestStart = new Set(slot.realtimeMessages);
        const data = await requestSessionHistoryPage(sessionId, requestOptions);
        slot.serverMessages = data.messages;
        pendingUsers.confirm(sessionId, data.messages);
        slot.total = data.total;
        slot.hasMore = data.hasMore;
        slot.offset = (requestOptions.offset ?? 0) + data.messages.length;
        slot.fetchedAt = Date.now();
        slot.status = 'idle';
        slot.realtimeMessages = pruneRealtimeSupersededByServer(
          slot.serverMessages,
          slot.realtimeMessages,
          realtimeAtRequestStart,
        );
        recomputeMergedIfNeeded(slot);
        if (data.tokenUsage !== undefined) {
          slot.tokenUsage = acceptClaudeUsageSnapshot(slot.tokenUsage, data.tokenUsage, sessionId, window.__REMOTE_ID__ || window.location.origin);
        }

        notify(sessionId);
        return slot;
      } catch (error) {
        console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
        slot.status = 'error';
        notify(sessionId);
        return slot;
      }
    });
  }, [getSlot, notify, pendingUsers]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    return enqueueHistoryMutation(slot, async () => {
      let prependedCount = 0;
      let changed = false;
      const canRequest = opts.canRequest ?? (() => true);
      if (!slot.hasMore || !canRequest()) return { slot, prependedCount };

      try {
        // A tail-relative offset can shift while JSONL is still growing. One
        // bounded latest-page reconciliation realigns the cache, after which
        // the older-page request is retried once with the new raw-row offset.
        for (let attempt = 0; attempt < 2 && slot.hasMore; attempt++) {
          if (!canRequest()) break;

          const cachedMessages = slot.serverMessages;
          const expectedTotal = slot.total;
          const data = await requestSessionHistoryPage(sessionId, {
            limit: opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
            offset: slot.offset,
          });
          const olderMerge = mergeOlderServerPage(cachedMessages, data.messages);
          const shiftedWhileFetching = (
            data.total !== expectedTotal
            || olderMerge.overlapLength > 0
            || !olderPagePrecedesCachedHistory(data.messages, cachedMessages)
          );

          if (shiftedWhileFetching) {
            if (attempt > 0 || !canRequest()) break;
            const latestResult = await refreshLatestSlotFromServer(
              sessionId,
              slot,
              SESSION_MESSAGES_PAGE_SIZE,
              canRequest,
            );
            changed = changed || latestResult.changed;
            if (!latestResult.applied) break;
            pendingUsers.confirm(sessionId, slot.serverMessages);
            continue;
          }

          slot.serverMessages = olderMerge.messages;
          pendingUsers.confirm(sessionId, data.messages);
          // Retire the in-memory copy as well as its storage entry. Otherwise
          // reopening the latest page hides the older native match and makes
          // this already-confirmed copy reappear in the retained section.
          slot.realtimeMessages = removeOptimisticUserEchoes(slot.serverMessages, slot.realtimeMessages);
          slot.hasMore = data.hasMore;
          slot.total = data.total;
          slot.offset = slot.serverMessages.length;
          prependedCount = olderMerge.prependedCount;
          if (data.tokenUsage !== undefined) {
            slot.tokenUsage = acceptClaudeUsageSnapshot(slot.tokenUsage, data.tokenUsage, sessionId, window.__REMOTE_ID__ || window.location.origin);
          }
          recomputeMergedIfNeeded(slot);
          changed = true;
          break;
        }

        if (changed) notify(sessionId);
        return { slot, prependedCount };
      } catch (error) {
        console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
        if (changed) notify(sessionId);
        return { slot, prependedCount };
      }
    });
  }, [getSlot, notify, pendingUsers]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  /**
   * Drops the message carrying `anchorId` and everything after it.
   *
   * Sent when an already-sent message is edited: the replacement streams in
   * from the provider, so the rows it supersedes have to go first or the
   * transcript shows the question twice. Runs on every subscribed client, not
   * just the one that made the edit.
   */
  const truncateAt = useCallback((sessionId: string, anchorId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;

    const cutIndex = slot.serverMessages.findIndex(
      (message) => message.transcriptAnchorId === anchorId,
    );
    if (cutIndex < 0) return;

    slot.serverMessages = slot.serverMessages.slice(0, cutIndex);
    // Anything already streamed belonged to the turn being replaced — except
    // the replacement itself. The client that made the edit appends its
    // optimistic echo before the server acknowledges, so clearing live rows
    // outright took the message the user had just sent with it, and it only
    // came back when the run finished and the transcript was re-read.
    // Only the last one: a send that was refused leaves its echo behind, so a
    // second attempt at the same message would otherwise survive the cut
    // alongside the abandoned first and show the user both.
    const replacements = slot.realtimeMessages.filter(
      (message) => message.replacesAnchorId === anchorId,
    );
    slot.realtimeMessages = replacements.length > 0
      // Stamped here because this is the only place that knows how much of the
      // conversation survived, which is what tells the echo apart from the
      // turns it now sits after.
      ? [{ ...replacements[replacements.length - 1], replacesAfterRowCount: cutIndex }]
      : EMPTY;
    // `total` counts what the server would serve; it is about to be re-fetched
    // anyway, but leaving it high makes the pager offer pages that do not exist.
    slot.total = slot.serverMessages.length;
    slot.offset = slot.serverMessages.length;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [notify, storeRef]);

  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    if (msg.delivery && msg.clientMessageId && pendingUsers.isDismissed(sessionId, msg.clientMessageId)) return;
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };
    // A delivery receipt can replay after navigation/reconnect. Client identity
    // replaces its optimistic bubble instead of adding a second copy.
    const existingIndex = normalizedMessage.clientMessageId
      ? slot.realtimeMessages.findIndex(message => message.clientMessageId === normalizedMessage.clientMessageId)
      : slot.realtimeMessages.findIndex(message => Boolean(message.delivery) && hasSameUserMessageIdentity(message, normalizedMessage));
    let updated = [...slot.realtimeMessages];
    if (existingIndex >= 0) {
      const previous = updated[existingIndex];
      const keepDelivery = previous.delivery === 'delivered' || (previous.delivery === 'failed' && normalizedMessage.delivery === 'queued');
      updated[existingIndex] = {
        ...previous, ...normalizedMessage, id: normalizedMessage.delivery ? previous.id : normalizedMessage.id,
        transcriptAnchorId: normalizedMessage.transcriptAnchorId || previous.transcriptAnchorId,
        responseMessageId: normalizedMessage.responseMessageId || previous.responseMessageId,
        runId: normalizedMessage.runId || previous.runId,
        retriedAsClientMessageId: previous.retriedAsClientMessageId || normalizedMessage.retriedAsClientMessageId,
        isUnlocatedLocalCopy: normalizedMessage.delivery ? previous.isUnlocatedLocalCopy : undefined,
        delivery: normalizedMessage.delivery ? (keepDelivery ? previous.delivery : normalizedMessage.delivery) : undefined,
        deliveryError: normalizedMessage.delivery ? (keepDelivery ? previous.deliveryError : normalizedMessage.deliveryError) : undefined,
      };
    } else {
      updated.push(normalizedMessage);
    }
    if (updated.length > MAX_REALTIME_MESSAGES) {
      // Long Workflow tool streams must not evict user input that history has
      // not confirmed yet. Only replayable output participates in this cap.
      const outputTail = new Set(updated.filter(message => !(message.kind === 'text' && message.role === 'user')).slice(-MAX_REALTIME_MESSAGES));
      updated = updated.filter(message => message.kind === 'text' && message.role === 'user' || outputTail.has(message));
    }
    if (normalizedMessage.clientMessageId) {
      const saved = updated.find(message => message.clientMessageId === normalizedMessage.clientMessageId);
      if (saved) pendingUsers.remember(sessionId, saved);
      pendingUsers.confirm(sessionId, slot.serverMessages);
    }
    if (!normalizedMessage.delivery && normalizedMessage.role === 'user') pendingUsers.confirm(sessionId, [normalizedMessage]);
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify, pendingUsers]);

  /** Applies only server-confirmed delivery and never lets an older replay undo consumption. */
  const updateMessageDelivery = useCallback((sessionId: string, clientMessageId: string, delivery: ChatMessageDelivery, error?: string) => {
    const slot = getSlot(sessionId);
    let changed = false;
    slot.realtimeMessages = slot.realtimeMessages.map(message => {
      if (message.clientMessageId !== clientMessageId || message.delivery === 'delivered') return message;
      if (message.delivery === 'failed' && delivery === 'queued') return message;
      changed = true;
      const updated = { ...message, delivery, deliveryError: error };
      pendingUsers.remember(sessionId, updated);
      return updated;
    });
    if (changed) { pendingUsers.confirm(sessionId, slot.serverMessages); recomputeMergedIfNeeded(slot); notify(sessionId); }
  }, [getSlot, notify, pendingUsers]);

  /** An authoritative idle snapshot closes only copies submitted before that snapshot was requested.
   * This covers process restarts and expired server receipt buffers without timing out a live queue.
   */
  const settleUnconfirmedMessages = useCallback((sessionId: string, before: number, reason: string, executionId?: string) => {
    if (!Number.isFinite(before)) return;
    const slot = getSlot(sessionId);
    for (const message of [...slot.realtimeMessages]) {
      if (message.delivery !== 'queued' || !message.clientMessageId || pendingUsers.observedAt(sessionId, message.clientMessageId) > before) continue;
      if (executionId && message.executionId !== executionId) continue;
      updateMessageDelivery(sessionId, message.clientMessageId, 'failed', reason);
    }
  }, [getSlot, pendingUsers, updateMessageDelivery]);

  /** Rewind moves retained copies with their old branch; this changes local storage only, never sends input. */
  const quarantineContextInputs = useCallback((sessionId: string, backupSessionId?: string, contextRevision?: string) => {
    const slot = getSlot(sessionId);
    if (contextRevision && slot.contextRevision === contextRevision) return;
    if (contextRevision) slot.contextRevision = contextRevision;
    const copies = pendingUsers.restore(sessionId);
    for (const copy of copies) {
      const retained = { ...copy, sessionId: backupSessionId || sessionId,
        delivery: copy.delivery === 'delivered' ? 'delivered' as const : 'failed' as const,
        deliveryError: 'This input belongs to the previous conversation context. It will not be resent automatically.' };
      if (backupSessionId) {
        pendingUsers.remember(backupSessionId, retained);
        pendingUsers.dismiss(sessionId, copy.clientMessageId!);
        const backup = getSlot(backupSessionId);
        if (!backup.realtimeMessages.some(message => message.clientMessageId === copy.clientMessageId)) backup.realtimeMessages = [...backup.realtimeMessages, retained];
        recomputeMergedIfNeeded(backup); notify(backupSessionId);
      } else pendingUsers.remember(sessionId, retained);
    }
    slot.realtimeMessages = slot.realtimeMessages.filter(message => !message.delivery || !message.clientMessageId);
    if (!backupSessionId) slot.realtimeMessages = [...slot.realtimeMessages, ...pendingUsers.restore(sessionId)];
    recomputeMergedIfNeeded(slot); notify(sessionId);
  }, [getSlot, notify, pendingUsers]);

  /** Removes only this browser's retained copy, never the provider transcript or execution. */
  const dismissPendingUserMessage = useCallback((sessionId: string, clientMessageId: string) => {
    pendingUsers.dismiss(sessionId, clientMessageId);
    const slot = getSlot(sessionId);
    slot.realtimeMessages = slot.realtimeMessages.filter(message => !message.delivery || message.clientMessageId !== clientMessageId);
    recomputeMergedIfNeeded(slot); notify(sessionId);
  }, [getSlot, notify, pendingUsers]);

  /**
   * Refreshes only the persisted tail and stitches it onto the contiguous
   * cached suffix. Large turns request a small offset bridge rather than the
   * whole transcript, and the final state is applied atomically.
   */
  const refreshLatestFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const slot = getSlot(sessionId);

    return enqueueHistoryMutation(slot, async () => {
      try {
        const result = await refreshLatestSlotFromServer(
          sessionId,
          slot,
          opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
          opts.canRequest,
        );
        if (result.applied) pendingUsers.confirm(sessionId, slot.serverMessages);
        if (result.changed) notify(sessionId);
        return { slot, ...result };
      } catch (error) {
        console.error(`[SessionStore] latest refresh failed for ${sessionId}:`, error);
        return { slot, applied: false, changed: false, deferred: false };
      }
    });
  }, [getSlot, notify, pendingUsers]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, [storeRef]);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const slot = getSlot(sessionId);
    const streamId = `__streaming_${sessionId}`;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__streaming_${sessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'text',
        role: 'assistant',
      };
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify, storeRef]);

  /** Invalidate an old conversation chain after a server-confirmed rewind. */
  const resetHistory = useCallback(async (sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    await enqueueHistoryMutation(slot, async () => {
      // Keep the mutation queue itself: an older in-flight page must settle
      // before this reset, and the authoritative replacement follows it.
      slot.serverMessages = [];
      slot.realtimeMessages = pendingUsers.restore(sessionId);
      slot.offset = 0;
      slot.total = 0;
      slot.hasMore = false;
      slot.fetchedAt = 0;
      // Keep the ledger revision watermark. Rewind changes context, never spent usage;
      // its authoritative replacement carries the next durable revision.
      if (!isClaudeUsageSnapshot(slot.tokenUsage)) slot.tokenUsage = undefined;
      slot.status = 'idle';
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    });
  }, [notify, storeRef, pendingUsers]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return getSlot(sessionId).merged;
  }, [getSlot]);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, [storeRef]);

  return useMemo(() => ({
    pendingMessageStorageFailed,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    updateMessageDelivery,
    settleUnconfirmedMessages,
    quarantineContextInputs,
    dismissPendingUserMessage,
    truncateAt,
    refreshLatestFromServer,
    setActiveSession,
    isStale,
    updateStreaming,
    finalizeStreaming,
    resetHistory,
    getMessages,
    getSessionSlot,
  }), [
    pendingMessageStorageFailed, fetchFromServer, fetchMore, appendRealtime, updateMessageDelivery, settleUnconfirmedMessages, quarantineContextInputs, dismissPendingUserMessage, truncateAt, refreshLatestFromServer,
    setActiveSession, isStale, updateStreaming, finalizeStreaming,
    resetHistory, getMessages, getSessionSlot,
  ]);
}

/** Full store API returned by useSessionStore; chat hooks take it as a parameter. */
export type SessionStore = ReturnType<typeof useSessionStore>;
