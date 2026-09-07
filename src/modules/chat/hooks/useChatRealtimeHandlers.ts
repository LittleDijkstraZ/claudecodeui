import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type {
  ServerEvent,
  MarkSessionIdle,
  MarkSessionProcessing,
  PendingPermissionRequest,
  ProjectSession,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types';
import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound, readSessionRuntimeState } from '@/shared/utils';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { createSessionStreamBuffer } from '@/modules/chat/utils/sessionStreamBuffer';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  sessionStore: SessionStore;
};

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // Replaying a foreground boundary refreshes history at most once per run/seq;
  // it must never replay whole-run completion effects or clear the Workflow.
  const foregroundCompletionKeys = useRef(new Set<string>());

  // Buffer callbacks use the current store without recreating per-session timers.
  const sessionStoreRef = useRef(sessionStore);
  sessionStoreRef.current = sessionStore;
  // Retain independent text prefixes across selected-session and listener changes.
  const streamBufferRef = useRef<ReturnType<typeof createSessionStreamBuffer> | null>(null);
  if (!streamBufferRef.current) {
    streamBufferRef.current = createSessionStreamBuffer({
      updateStreaming: (...args) => sessionStoreRef.current.updateStreaming(...args),
      finalizeStreaming: (sessionId) => sessionStoreRef.current.finalizeStreaming(sessionId),
    });
  }
  const streamBuffer = streamBufferRef.current;

  // Selection changes rebind the listener, but must not discard another
  // session's pending prefix. Only component teardown clears all buffers.
  useEffect(() => () => streamBuffer.clear(), [streamBuffer]);

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const applyMessageReceipt = (msg: ServerEvent, sid: string) => {
      if (typeof msg.clientMessageId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(msg.clientMessageId)
        || !['queued', 'delivered', 'failed'].includes(String(msg.delivery))) return;
      const delivery = msg.delivery as 'queued' | 'delivered' | 'failed';
      // Receipts carry the user text so a reconnect can reconstruct a
      // pending prompt that has not reached the native transcript yet.
      if (typeof msg.content === 'string') {
        sessionStore.appendRealtime(sid, {
          id: `client_${msg.clientMessageId}`,
          sessionId: sid,
          provider: msg.provider === 'claude' ? 'claude' : provider,
          kind: 'text', role: 'user',
          timestamp: typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString(),
          clientMessageId: msg.clientMessageId,
          transcriptAnchorId: typeof msg.transcriptAnchorId === 'string' ? msg.transcriptAnchorId : undefined,
          content: msg.content,
          images: Array.isArray(msg.images) ? msg.images as NormalizedMessage['images'] : undefined,
          files: Array.isArray(msg.files) ? msg.files as NormalizedMessage['files'] : undefined,
          delivery,
          deliveryError: typeof msg.error === 'string' ? msg.error : undefined,
        });
      }
      sessionStore.updateMessageDelivery(sid, msg.clientMessageId, delivery, typeof msg.error === 'string' ? msg.error : undefined);
    };
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // Record replay progress for every sequenced live event.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'history_truncated': {
          // An already-sent message was replaced. Every client watching this
          // session drops the superseded turns before the replacement streams
          // in, so a second tab does not end up showing the question twice.
          if (sid && typeof msg.anchorId === 'string') {
            sessionStore.truncateAt(sid, msg.anchorId);
          }
          return;
        }

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;
          // The server retains the latest delivery receipt even for a completed
          // run. Consume only receipt-shaped entries for this exact session.
          if (Array.isArray(msg.messageReceipts)) {
            for (const candidate of msg.messageReceipts) {
              if (!candidate || typeof candidate !== 'object') continue;
              const receipt = candidate as ServerEvent;
              if (receipt.kind === 'status' && receipt.text === 'message_delivery' && receipt.sessionId === sid) applyMessageReceipt(receipt, sid);
            }
          }

          if (msg.isProcessing) {
            onSessionProcessing?.(sid, readSessionRuntimeState(msg));
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            if (typeof msg.clientMessageId === 'string') {
              sessionStore.updateMessageDelivery(sid, msg.clientMessageId, 'failed', String(msg.error || 'Request failed'));
              if (msg.isProcessing === false) onSessionIdle?.(sid);
            } else {
              onSessionIdle?.(sid);
            }
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_activity': // Metadata-only observer event; never a transcript message.
        case 'session_context_reset': // History replacement is owned by ChatInterface.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // Buffer text independently for every session. Completion flushes its
      // buffer and falls through to the existing terminal UI side effects.
      if (streamBuffer.handleEvent(msg, sid, provider)) {
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_resolved'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void requestLatestMessages(sid, isActiveRef.current);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        // `permission_resolved` arrives when any client answers the prompt: it
        // retracts a replayed `permission_request` after a mid-run refresh and
        // clears the prompt in other tabs watching the same run.
        case 'permission_resolved':
        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'foreground_complete') {
            if (!sid) break;
            const key = `${sid}:${String(msg.runId ?? msg.executionId ?? '')}:${String(msg.seq ?? msg.id ?? '')}`;
            if (foregroundCompletionKeys.current.has(key)) break;
            foregroundCompletionKeys.current.add(key);
            if (foregroundCompletionKeys.current.size > 1000) foregroundCompletionKeys.current.delete(foregroundCompletionKeys.current.values().next().value!);
            if (sid === activeViewSessionId) void requestLatestMessages(sid, isActiveRef.current);
          } else if (msg.text === 'message_delivery') {
            if (sid) applyMessageReceipt(msg, sid);
          } else if (msg.text === 'claude_runtime_state') {
            if (sid) onSessionProcessing?.(sid, { ...readSessionRuntimeState(msg), statusText: null });
          } else if (msg.text === 'token_budget' && msg.tokenBudget) {
            // The counter shows the viewed session's context; budgets from
            // other concurrently running sessions must not overwrite it.
            if (sid === activeViewSessionId) {
              setTokenBudget(msg.tokenBudget as Record<string, unknown>);
            }
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamBuffer,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  ]);
}
