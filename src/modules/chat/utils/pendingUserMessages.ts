import type { NormalizedMessage } from '@/shared/types';

type StoredInput = { message: NormalizedMessage } | { dismissed: true };

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
  return {
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
    isDismissed(sessionId: string, id: string) { const entry = read(key(sessionId, id)); return Boolean(entry && 'dismissed' in entry); },
    remember(sessionId: string, message: NormalizedMessage) {
      if (message.provider !== 'claude' || message.kind !== 'text' || message.role !== 'user' || !message.clientMessageId || !message.delivery) return;
      const storageKey = key(sessionId, message.clientMessageId);
      const previous = read(storageKey);
      if (previous && 'dismissed' in previous) return;
      const prior = previous && 'message' in previous ? previous.message : null;
      const keepDelivery = prior?.delivery === 'delivered' || (prior?.delivery === 'failed' && message.delivery === 'queued');
      write(storageKey, { message: { ...message,
        delivery: keepDelivery ? prior.delivery : message.delivery,
        deliveryError: keepDelivery ? prior.deliveryError : message.deliveryError,
      } });
    },
    confirm(sessionId: string, history: NormalizedMessage[]) {
      for (const message of history) {
        if (message.kind !== 'text' || message.role !== 'user') continue;
        for (const id of [message.id, message.clientMessageId, message.transcriptAnchorId]) {
          if (!id) continue;
          const storageKey = key(sessionId, id);
          const entry = read(storageKey);
          if (entry && 'message' in entry) write(storageKey, null);
        }
      }
    },
    dismiss(sessionId: string, id: string) { write(key(sessionId, id), { dismissed: true }); },
  };
}
