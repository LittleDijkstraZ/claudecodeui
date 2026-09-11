import { useCallback, useRef, useState } from 'react';

import type { IsSessionProcessing, MarkSessionIdle, MarkSessionProcessing, SessionActivity, SessionActivityMap, SessionActivitySnapshot, SyncProcessingSessions } from '@/shared/types';




const LOCAL_ACTIVITY_GRACE_MS = 10_000;

const sessionActivityMapsMatch = (
  left: ReadonlyMap<string, SessionActivity>,
  right: ReadonlyMap<string, SessionActivity>,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [sessionId, leftActivity] of left) {
    const rightActivity = right.get(sessionId);
    if (
      !rightActivity
      || leftActivity.statusText !== rightActivity.statusText
      || leftActivity.canInterrupt !== rightActivity.canInterrupt
      || leftActivity.startedAt !== rightActivity.startedAt
      || leftActivity.phase !== rightActivity.phase
      || leftActivity.acceptsInput !== rightActivity.acceptsInput
      || leftActivity.canInterruptQueuedMessages !== rightActivity.canInterruptQueuedMessages
      || leftActivity.canStopTask !== rightActivity.canStopTask
      || leftActivity.inputModes?.join(',') !== rightActivity.inputModes?.join(',')
      || leftActivity.backgroundTasks !== rightActivity.backgroundTasks
      || leftActivity.executionId !== rightActivity.executionId
      || leftActivity.foregroundTurnId !== rightActivity.foregroundTurnId
      || leftActivity.foregroundStartedAt !== rightActivity.foregroundStartedAt
    ) {
      return false;
    }
  }

  return true;
};

/**
 * Single source of truth for which sessions are actively processing a
 * request. Everything the chat UI shows (activity indicator, abort
 * availability, status text) is derived from this map; terminal events
 * (`complete`, abort, an authoritative idle subscribe ack) delete the entry
 * atomically. Session ids are always concrete (allocated before the first
 * send), so entries are keyed by real session ids only.
 */
export function useSessionProtection() {
  const [processingSessions, setProcessingSessions] = useState<Map<string, SessionActivity>>(
    new Map(),
  );
  const processingSessionsRef = useRef<SessionActivityMap>(processingSessions);
  processingSessionsRef.current = processingSessions;

  const markSessionProcessing = useCallback<MarkSessionProcessing>((sessionId, activity) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      const previous = activity?.executionId && existing?.executionId !== activity.executionId ? undefined : existing;
      const next: SessionActivity = {
        phase: activity?.phase ?? previous?.phase,
        foregroundTurnId: activity?.phase === 'background' ? undefined : activity?.foregroundTurnId ?? previous?.foregroundTurnId,
        foregroundStartedAt: activity?.phase === 'background' ? undefined : activity?.foregroundStartedAt ?? previous?.foregroundStartedAt,
        acceptsInput: activity?.acceptsInput ?? previous?.acceptsInput,
        canInterruptQueuedMessages: activity?.canInterruptQueuedMessages ?? previous?.canInterruptQueuedMessages,
        canStopTask: activity?.canStopTask ?? previous?.canStopTask,
        inputModes: activity?.inputModes ?? previous?.inputModes,
        backgroundTasks: activity?.backgroundTasks ?? previous?.backgroundTasks,
        executionId: activity?.executionId ?? previous?.executionId,
        statusText:
          activity?.statusText !== undefined ? activity.statusText : previous?.statusText ?? null,
        canInterrupt: activity?.canInterrupt ?? previous?.canInterrupt ?? true,
        startedAt: previous?.startedAt ?? Date.now(),
      };

      if (
        existing
        && existing.statusText === next.statusText
        && existing.canInterrupt === next.canInterrupt
        && existing.phase === next.phase
        && existing.acceptsInput === next.acceptsInput
        && existing.canInterruptQueuedMessages === next.canInterruptQueuedMessages
        && existing.canStopTask === next.canStopTask
        && existing.inputModes?.join(',') === next.inputModes?.join(',')
        && existing.backgroundTasks === next.backgroundTasks
        && existing.executionId === next.executionId
        && existing.foregroundTurnId === next.foregroundTurnId
        && existing.foregroundStartedAt === next.foregroundStartedAt
      ) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(sessionId, next);
      return updated;
    });
  }, []);

  const markSessionIdle = useCallback<MarkSessionIdle>((sessionId, opts) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      if (!existing) {
        return prev;
      }

      // Guard against stale `chat_subscribed` idle acks: if a new request
      // started after the subscribe was sent, the idle ack describes the
      // older request and must not clear the newer one.
      if (opts?.ifStartedBefore !== undefined && existing.startedAt >= opts.ifStartedBefore) {
        return prev;
      }

      const updated = new Map(prev);
      updated.delete(sessionId);
      return updated;
    });
  }, []);

  const syncProcessingSessions = useCallback<SyncProcessingSessions>((sessions) => {
    const now = Date.now();

    setProcessingSessions((prev) => {
      const incoming = new Map<string, SessionActivitySnapshot>();
      for (const session of sessions) {
        if (!session.sessionId) {
          continue;
        }
        incoming.set(session.sessionId, session);
      }

      const updated = new Map<string, SessionActivity>();

      for (const [sessionId, snapshot] of incoming) {
        const existing = prev.get(sessionId);
        // A partial snapshot can retain capabilities only when it confirms the
        // same execution. A replacement or unidentified process must advertise
        // its own stream instead of inheriting the previous process's input.
        const sameExecution = Boolean(snapshot.executionId && snapshot.executionId === existing?.executionId);
        const previousRuntime = sameExecution ? existing : undefined;
        const previousActivity = sameExecution || (!snapshot.executionId && !existing?.executionId) ? existing : undefined;
        const phase = snapshot.phase ?? previousRuntime?.phase;

        updated.set(sessionId, {
          phase,
          foregroundTurnId: phase === 'background' ? undefined : snapshot.foregroundTurnId ?? previousRuntime?.foregroundTurnId,
          foregroundStartedAt: phase === 'background' ? undefined : snapshot.foregroundStartedAt ?? previousRuntime?.foregroundStartedAt,
          acceptsInput: snapshot.acceptsInput ?? previousRuntime?.acceptsInput,
          canInterruptQueuedMessages: snapshot.canInterruptQueuedMessages ?? previousRuntime?.canInterruptQueuedMessages,
          canStopTask: snapshot.canStopTask ?? previousRuntime?.canStopTask,
          inputModes: snapshot.inputModes ?? previousRuntime?.inputModes,
          backgroundTasks: snapshot.backgroundTasks ?? previousRuntime?.backgroundTasks,
          executionId: snapshot.executionId,
          statusText:
            snapshot.statusText !== undefined ? snapshot.statusText : previousActivity?.statusText ?? null,
          canInterrupt: snapshot.canInterrupt ?? previousActivity?.canInterrupt ?? true,
          // startedAt is a client-clock guard for late idle replies and absent
          // polls. Remote timestamps can run ahead or behind this browser; the
          // provider's foregroundStartedAt remains available for display.
          startedAt: previousActivity?.startedAt ?? now,
        });
      }

      for (const [sessionId, activity] of prev) {
        if (!incoming.has(sessionId) && now - activity.startedAt < LOCAL_ACTIVITY_GRACE_MS) {
          updated.set(sessionId, activity);
        }
      }

      return sessionActivityMapsMatch(prev, updated) ? prev : updated;
    });
  }, []);

  const isSessionProcessing = useCallback<IsSessionProcessing>(
    (sessionId) => Boolean(sessionId && processingSessionsRef.current.has(sessionId)),
    [],
  );

  return {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
    isSessionProcessing,
  };
}
