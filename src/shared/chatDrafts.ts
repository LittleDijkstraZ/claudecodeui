import { api } from '@/shared/api';
import type { QueuedSendOptions } from '@/shared/types';

/**
 * Unsent composer text and queued messages, stored in `auth.db` rather than in
 * the browser.
 *
 * This is what lets a message half-typed on a laptop be finished on a phone —
 * the case the composer previously could not serve at all, because a draft only
 * existed on the machine it was typed on. As with the preference store, a
 * localStorage mirror is kept purely so a reload shows the draft on the first
 * paint instead of a blank composer that fills in a moment later.
 *
 * A scope is a session id, or `project:<projectId>` for a chat that has not
 * been sent yet and so has no session. Drafts used to be keyed by project
 * alone, which meant every session in a project shared one draft.
 */

/** A queued message as it is stored: text plus the send options it was composed under. */
export type StoredQueuedMessage = {
  /** Native context to which a deferred Claude send belongs; the server pauses stale or unbound inputs. */
  providerSessionId?: string;
  /** A rewind backup retains this draft for review and must never dispatch it automatically. */
  rewindPaused?: boolean;
  content: string;
  options?: QueuedSendOptions;
  /** Legacy image-only descriptors retained for queued draft compatibility. */
  images?: unknown[];
  /**
   * JSON-safe descriptors returned by POST /api/assets/files. Unlike browser
   * File objects, they can follow a queued message across session switches.
   */
  attachments?: unknown[];
};

type DraftRecord = {
  text: string;
  queuedMessage: StoredQueuedMessage | null;
};

/** Fired after any draft changes, from a local write or from a hydrate. */
export const CHAT_DRAFTS_CHANGED_EVENT = 'chat-drafts:changed';

const MIRROR_STORAGE_KEY = 'chat-drafts';

/**
 * Longer than the preference debounce: this fires on every keystroke, and a
 * draft is only ever read back on a reload or a device switch, so trading a
 * little latency for far fewer requests is the right side of the trade.
 */
const SERVER_WRITE_DEBOUNCE_MS = 1_000;

const EMPTY_DRAFT: DraftRecord = { text: '', queuedMessage: null };

const listeners = new Set<() => void>();

let drafts = new Map<string, DraftRecord>();
const pendingScopes = new Set<string>();
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;
// Local edit versions protect both changed drafts and deliberate deletions from older reads.
const localRevisions = new Map<string, number>();
// Serialize writes within a scope so an older save cannot arrive after a newer edit or cancellation.
const writesInFlight = new Map<string, number>();
// Failed queued writes must not be retried by a flush triggered in an unrelated conversation.
const failedScopes = new Set<string>();
// Discard asynchronous work from an account whose cached drafts have been reset.
let storeGeneration = 0;
// Only the newest inventory request may adopt another device's draft state.
let latestHydration = 0;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessage === null
);

function readMirror(): Map<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Map();
    }

    const restored = new Map<string, DraftRecord>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      restored.set(scope, {
        text: typeof value.text === 'string' ? value.text : '',
        queuedMessage: isRecord(value.queuedMessage)
          ? (value.queuedMessage as StoredQueuedMessage)
          : null,
      });
    }
    return restored;
  } catch {
    return new Map();
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // A full localStorage costs the first-paint restore, not the draft: the
    // server copy is authoritative and arrives on hydrate.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED_EVENT));
  }
}

function flushServerWrites(): void {
  serverWriteTimer = null;
  const scopes = [...pendingScopes];

  for (const scope of scopes) {
    if (writesInFlight.has(scope) || failedScopes.has(scope)) continue;
    pendingScopes.delete(scope);
    const draft = drafts.get(scope);
    const revision = localRevisions.get(scope) ?? 0;
    const generation = storeGeneration;
    writesInFlight.set(scope, revision);
    void (async () => {
      let failed = false;
      try {
        const response = !draft || isEmptyDraft(draft)
          ? await api.user.deleteDraft(scope)
          : await api.user.saveDraft(scope, { text: draft.text, queuedMessage: draft.queuedMessage });
        if (!response.ok) throw new Error(`Draft write failed (${response.status})`);
      } catch (error) {
        if (storeGeneration !== generation) return;
        failed = true;
        // Keep the local copy dirty until another explicit write retries it.
        // A queued PUT may have reached the dispatcher before its response was
        // lost, so blindly retrying could submit that question twice.
        pendingScopes.add(scope);
        failedScopes.add(scope);
        console.error('Failed to save chat draft:', error);
      } finally {
        if (storeGeneration === generation && writesInFlight.get(scope) === revision) {
          writesInFlight.delete(scope);
          // An immediate queue edit may have flushed while its previous save
          // was pending. Send that edit as soon as the preceding write settles.
          if (!failed && pendingScopes.has(scope) && serverWriteTimer === null) flushServerWrites();
        }
      }
    })();
  }
}

function queueServerWrite(scope: string): void {
  pendingScopes.add(scope);
  failedScopes.delete(scope);

  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
  }
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

function flushServerWritesNow(): void {
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  flushServerWrites();
}

function updateDraft(scope: string, update: Partial<DraftRecord>): void {
  const current = drafts.get(scope) ?? EMPTY_DRAFT;
  const next: DraftRecord = { ...current, ...update };

  if (next.text === current.text && next.queuedMessage === current.queuedMessage) {
    return;
  }

  const nextDrafts = new Map(drafts);
  if (isEmptyDraft(next)) {
    nextDrafts.delete(scope);
  } else {
    nextDrafts.set(scope, next);
  }
  drafts = nextDrafts;
  localRevisions.set(scope, (localRevisions.get(scope) ?? 0) + 1);

  writeMirror();
  queueServerWrite(scope);
  notifyListeners();
}

/** Reads one scope's composer text, synchronously, for the first render. */
export function readDraftText(scope: string): string {
  return drafts.get(scope)?.text ?? '';
}

export function writeDraftText(scope: string, text: string): void {
  updateDraft(scope, { text });
}

export function readQueuedMessage(scope: string): StoredQueuedMessage | null {
  const queued = drafts.get(scope)?.queuedMessage ?? null;
  if (!queued) {
    return null;
  }

  const attachments = Array.isArray(queued.attachments)
    ? queued.attachments
    : Array.isArray(queued.images)
      ? queued.images
      : [];

  // A queued message with neither text nor attachments has nothing to send.
  return queued.content.trim() || attachments.length > 0
    ? { ...queued, attachments }
    : null;
}

export function writeQueuedMessage(scope: string, message: StoredQueuedMessage): void {
  updateDraft(scope, { queuedMessage: message });
  // Queueing is a send-like action, so persist it before the tab can close.
  flushServerWritesNow();
}

export function clearQueuedMessage(scope: string): void {
  updateDraft(scope, { queuedMessage: null });
  // Editing or cancelling must beat the server's next dispatcher poll.
  flushServerWritesNow();
}

/** Subscribes to any draft change; returns the unsubscribe function. */
export function subscribeToChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the server's drafts and adopts them as the source of truth.
 *
 * Pending writes and edits made during this request win over its older server
 * snapshot. Once a save is acknowledged, a later request can adopt remote edits
 * or the server's removal of a dispatched queued message.
 */
export async function hydrateChatDrafts(): Promise<void> {
  const generation = storeGeneration;
  const requestId = ++latestHydration;
  const revisionsAtStart = new Map(localRevisions);
  const protectedScopes = new Set([...pendingScopes, ...writesInFlight.keys()]);
  let serverDrafts: Array<{ scope?: unknown; text?: unknown; queuedMessage?: unknown }> = [];

  try {
    const response = await api.user.drafts();
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { drafts?: unknown };
    if (!Array.isArray(payload.drafts)) {
      return;
    }
    serverDrafts = payload.drafts as typeof serverDrafts;
  } catch (error) {
    // Keep the mirror: an offline load must still show what was typed here.
    console.error('Failed to load chat drafts:', error);
    return;
  }

  if (generation !== storeGeneration || requestId !== latestHydration) return;
  for (const scope of pendingScopes) protectedScopes.add(scope);
  for (const scope of writesInFlight.keys()) protectedScopes.add(scope);
  for (const [scope, revision] of localRevisions) {
    if (revisionsAtStart.get(scope) !== revision) protectedScopes.add(scope);
  }

  const merged = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    const scope = typeof draft.scope === 'string' ? draft.scope : '';
    if (!scope || protectedScopes.has(scope)) {
      continue;
    }

    merged.set(scope, {
      text: typeof draft.text === 'string' ? draft.text : '',
      queuedMessage: isRecord(draft.queuedMessage)
        ? (draft.queuedMessage as StoredQueuedMessage)
        : null,
    });
  }

  // Missing protected records are local deletions, so an older response must
  // not resurrect them. Other missing scopes were removed by the server.
  for (const scope of protectedScopes) {
    const pending = drafts.get(scope);
    if (pending) {
      merged.set(scope, pending);
    }
  }

  drafts = merged;
  writeMirror();
  notifyListeners();
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  storeGeneration += 1;
  drafts = new Map();
  pendingScopes.clear();
  localRevisions.clear();
  writesInFlight.clear();
  failedScopes.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // The in-memory copy is already cleared, which is what readers use.
  }
  notifyListeners();
}

// Read at module load rather than on first use, because the composer's initial
// input value is a `useState` initializer that runs before any effect.
if (typeof localStorage !== 'undefined') {
  drafts = readMirror();
}
