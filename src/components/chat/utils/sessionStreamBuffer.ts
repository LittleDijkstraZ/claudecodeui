import type { LLMProvider } from '../../../types/app';
import type { SessionStore } from '../../../stores/useSessionStore';

type StreamingStore = Pick<SessionStore, 'updateStreaming' | 'finalizeStreaming'>;

interface StreamTimers {
  schedule(callback: () => void, delayMs: number): number;
  cancel(timer: number): void;
}

interface SessionStream {
  content: string;
  provider: LLMProvider;
  timer: number | null;
}

interface StreamEvent {
  kind?: unknown;
  content?: unknown;
  provider?: unknown;
}

const browserTimers: StreamTimers = {
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancel: (timer) => window.clearTimeout(timer),
};

/**
 * A socket can receive several running sessions at once, even after the view
 * switches. Keep their full text and render timers independent of selection.
 */
export function createSessionStreamBuffer(store: StreamingStore, timers = browserTimers) {
  const streams = new Map<string, SessionStream>();

  function append(sessionId: string, text: string, provider: LLMProvider) {
    if (!sessionId || !text) return;

    let stream = streams.get(sessionId);
    if (!stream) {
      stream = { content: '', provider, timer: null };
      streams.set(sessionId, stream);
    }
    stream.content += text;

    if (stream.timer === null) {
      const pending = stream;
      pending.timer = timers.schedule(() => {
        pending.timer = null;
        if (streams.get(sessionId) === pending) {
          store.updateStreaming(sessionId, pending.content, pending.provider);
        }
      }, 100);
    }
  }

  function finish(sessionId: string | null) {
    if (!sessionId) return;
    const stream = streams.get(sessionId);
    if (!stream) return;

    if (stream.timer !== null) timers.cancel(stream.timer);
    store.updateStreaming(sessionId, stream.content, stream.provider);
    store.finalizeStreaming(sessionId);
    streams.delete(sessionId);
  }

  function clear() {
    for (const stream of streams.values()) {
      if (stream.timer !== null) timers.cancel(stream.timer);
    }
    streams.clear();
  }

  /** Return true only for events fully handled here; completion still needs UI side effects. */
  function handleEvent(event: StreamEvent, sessionId: string | null, fallbackProvider: LLMProvider) {
    if (event.kind === 'stream_delta') {
      if (sessionId && typeof event.content === 'string') {
        const provider = event.provider === 'claude' || event.provider === 'cursor'
          || event.provider === 'codex' || event.provider === 'opencode' ? event.provider : fallbackProvider;
        append(sessionId, event.content, provider);
      }
      return true;
    }
    if (event.kind === 'stream_end' || event.kind === 'complete') {
      finish(sessionId);
      return event.kind === 'stream_end';
    }
    return false;
  }

  return { handleEvent, clear };
}
