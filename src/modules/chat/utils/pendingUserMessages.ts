import type { NormalizedMessage } from '@/shared/types';
import { hasSameUserMessageIdentity } from '@/shared/utils';

type StoredInput = { message: NormalizedMessage; observedAt?: number } | { dismissed: true };

/** Used by the chat store to retain user copies until native history confirms them, never to resend. */
export function createPendingUserMessages(scope: string, onStorageFailure: () => void = () => {}) {
  // Each UUID owns its own key: two windows submitting different messages
  // cannot overwrite one another's whole session snapshot.
  const prefix = (sessionId: string) => `cloudcli-pending-user-v1:${encodeURIComponent(scope)}:${encodeURIComponent(sessionId)}:`;
  const key = (sessionId: string, id: string) => prefix(sessionId) + encodeURIComponent(id);
  const unsaved = new Map<string, StoredInput | null>();
  const read = (storageKey: string): StoredInput | null => {
    if (unsaved.has(storageKey)) return unsaved.get(storageKey)!;
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) || 'null');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StoredInput : null;
    }
    catch { return null; }
  };
  const write = (storageKey: string, state: StoredInput | null) => {
    try {
      if (state === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(state));
      unsaved.delete(storageKey);
    } catch { unsaved.set(storageKey, state); onStorageFailure(); }
  };
  const outbox = {
    restore(sessionId: string): NormalizedMessage[] {
      const keys = new Set(unsaved.keys());
      try {
        for (let index = 0; index < localStorage.length; index++) {
          const storageKey = localStorage.key(index);
          if (storageKey?.startsWith(prefix(sessionId))) keys.add(storageKey);
        }
      } catch { /* The current in-memory fallback remains available. */ }
      const restored: NormalizedMessage[] = [];
      for (const storageKey of keys) {
        if (!storageKey.startsWith(prefix(sessionId))) continue;
        const entry = read(storageKey);
        if (!entry || !('message' in entry)) continue;
        const message = entry.message;
        if (message && message.sessionId === sessionId && message.provider === 'claude' && message.kind === 'text' && message.role === 'user'
          && message.clientMessageId && key(sessionId, message.clientMessageId) === storageKey
          && ['queued', 'delivered', 'failed'].includes(message.delivery || '')) restored.push(message);
      }
      return restored.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    },
    // Only this browser clock can be compared with its subscribe request time.
    // Pre-upgrade copies have no observation metadata and conservatively count as old.
    observedAt(sessionId: string, id: string): number {
      const entry = read(key(sessionId, id));
      return entry && 'message' in entry && Number.isFinite(entry.observedAt) ? entry.observedAt! : 0;
    },
    isDismissed(sessionId: string, id: string) { const entry = read(key(sessionId, id)); return Boolean(entry && 'dismissed' in entry); },
    remember(sessionId: string, message: NormalizedMessage) {
      if (message.provider !== 'claude' || message.kind !== 'text' || message.role !== 'user' || !message.clientMessageId || !message.delivery) return;
      const storageKey = key(sessionId, message.clientMessageId);
      const previous = read(storageKey);
      if (previous && 'dismissed' in previous) return;
      const prior = previous && 'message' in previous ? previous.message : null;
      const keepDelivery = prior?.delivery === 'delivered' || (prior?.delivery === 'failed' && message.delivery === 'queued');
      const observedAt = previous && 'message' in previous ? previous.observedAt ?? 0 : Date.now();
      write(storageKey, { observedAt, message: { ...message,
        delivery: keepDelivery ? prior.delivery : message.delivery,
        deliveryError: keepDelivery ? prior.deliveryError : message.deliveryError,
        transcriptAnchorId: message.transcriptAnchorId || prior?.transcriptAnchorId,
        responseMessageId: message.responseMessageId || prior?.responseMessageId,
        runId: message.runId || prior?.runId,
        retriedAsClientMessageId: prior?.retriedAsClientMessageId || message.retriedAsClientMessageId,
      } });
    },
    confirm(sessionId: string, history: NormalizedMessage[]) {
      for (const local of outbox.restore(sessionId)) {
        if (history.some(message => hasSameUserMessageIdentity(local, message))) {
          // A confirmed UUID cannot be resurrected by a late receipt, even if
          // the next browser load has not fetched its native history page yet.
          write(key(sessionId, local.clientMessageId!), { dismissed: true });
        }
      }
    },
    dismiss(sessionId: string, id: string) { write(key(sessionId, id), { dismissed: true }); },
  };
  return outbox;
}
