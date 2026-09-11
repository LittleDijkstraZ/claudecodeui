import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
type ChatRun = {
  appSessionId: string;
  runId: string;
  runtimeState?: { phase: 'foreground' | 'background'; acceptsInput: boolean; inputModes?: Array<'queue' | 'interrupt'>; canInterruptQueuedMessages?: boolean; canStopTask?: boolean; backgroundTasks: number; executionId?: string; foregroundTurnId?: string; foregroundStartedAt?: string };
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  messageReceipts: Map<string, NormalizedMessage>;
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();
const sessionMutations = new Set<string>();
const projectMutations = new Set<string>();
const activityObservers = new WeakMap<RealtimeClientConnection, string | number | null>();

function broadcastSessionActivity(run: ChatRun, status: 'running' | 'complete' | 'error' | 'permission' | 'response_complete'): void {
  // Never let a superseded run update the activity of a newer run under the same app id.
  if (runs.get(run.appSessionId) !== run) return;
  const owner = run.writer.userId;
  if (owner === null) return;
  const payload = JSON.stringify({
    kind: 'session_activity', sessionId: run.appSessionId, provider: run.provider,
    status, isProcessing: run.status === 'running', ...(run.runtimeState ?? {}), runId: run.runId, seq: run.lastSeq, eventId: `${run.runId}:${status}:${run.lastSeq}`,
  });
  for (const client of connectedClients) {
    const observer = activityObservers.get(client);
    // Subscribed viewers already receive the full stream. Observers receive
    // metadata only and never attach themselves to the run's live audience.
    if (run.writer.hasConnection(client) || client.readyState !== WS_OPEN_STATE || observer === undefined || observer === null || String(observer) !== String(owner)) continue;
    try { client.send(payload); } catch { /* A closed observer cannot fail the user's active run. */ }
  }
}

function evictRunLater(appSessionId: string): void {
  const completedRun = runs.get(appSessionId);
  const timer = setTimeout(() => {
    const run = runs.get(appSessionId);
    if (run && run === completedRun && run.status === 'completed') {
      runs.delete(appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // A forgotten or replaced run may still have asynchronous callbacks. Its old
  // writer must not publish into the conversation's replacement context.
  if (runs.get(run.appSessionId) !== run) return null;
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }
  if (run.status === 'completed' && message.kind === 'status' && message.text === 'claude_runtime_state') return null;

  if (message.kind === 'complete') {
    // A process may fail before the provider creates its stdin queue. Never leave
    // admitted prompts permanently waiting or claim that unacknowledged input arrived.
    for (const receipt of [...run.messageReceipts.values()]) {
      if (receipt.delivery !== 'queued') continue;
      run.writer.send({ ...receipt, delivery: 'failed',
        error: 'Claude ended without confirming receipt. Review the transcript before retrying.',
        timestamp: new Date().toISOString() });
    }
  }

  if (message.kind === 'status' && message.text === 'message_delivery' && message.clientMessageId) {
    const prior = run.messageReceipts.get(message.clientMessageId);
    if (prior) {
      const keepDelivery = prior.delivery === 'delivered' || prior.delivery === 'failed' && message.delivery === 'queued';
      message = { ...message,
        delivery: keepDelivery ? prior.delivery : message.delivery,
        error: keepDelivery ? prior.error : message.error,
        definitelyNotSubmitted: prior.delivery === 'delivered' || message.delivery === 'delivered'
          ? undefined : keepDelivery ? prior.definitelyNotSubmitted : message.definitelyNotSubmitted,
        transcriptAnchorId: message.transcriptAnchorId || prior.transcriptAnchorId,
        responseMessageId: message.responseMessageId || prior.responseMessageId,
        executionId: message.executionId || prior.executionId,
      };
    }
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    runId: run.runId,
    runStartedAt: run.startedAt,
    seq: run.lastSeq,
  };

  const runtimeStateChanged = message.kind === 'status' && message.text === 'claude_runtime_state'
    && (message.phase === 'foreground' || message.phase === 'background') && typeof message.acceptsInput === 'boolean';
  if (runtimeStateChanged) run.runtimeState = { phase: message.phase!, acceptsInput: message.acceptsInput!,
    inputModes: Array.isArray(message.inputModes) ? message.inputModes.filter((mode): mode is 'queue' | 'interrupt' => mode === 'queue' || mode === 'interrupt') : undefined,
    canInterruptQueuedMessages: message.canInterruptQueuedMessages === true, canStopTask: message.canStopTask === true,
    backgroundTasks: Math.max(0, Number(message.backgroundTasks) || 0), executionId: message.executionId, foregroundTurnId: typeof message.foregroundTurnId === 'string' ? message.foregroundTurnId : undefined, foregroundStartedAt: typeof message.foregroundStartedAt === 'string' ? message.foregroundStartedAt : undefined };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    if (run.runtimeState) run.runtimeState = { ...run.runtimeState, acceptsInput: false };
    run.completedAt = Date.now();
    evictRunLater(run.appSessionId);
  }

  if (message.kind === 'status' && message.text === 'message_delivery' && message.clientMessageId) {
    run.messageReceipts.set(message.clientMessageId, outbound);
    // Keep waiting receipts even after a long Workflow exceeds the stream replay buffer.
    if (run.messageReceipts.size > 128) {
      const oldest = [...run.messageReceipts].find(([, receipt]) => receipt.delivery !== 'queued');
      if (oldest) run.messageReceipts.delete(oldest[0]);
    }
  }
  if (outbound.workflowProgress !== undefined) {
    // Each native snapshot replaces the same task's phase/agent state. Replay
    // retains every lifecycle/text event, but only the newest large snapshot.
    run.events = run.events.map(event => {
      const sameTask = typeof outbound.taskId === 'string' && outbound.taskId.length > 0 && typeof event.taskId === 'string'
        ? outbound.taskId === event.taskId
        : typeof outbound.toolUseId === 'string' && outbound.toolUseId.length > 0 && outbound.toolUseId === event.toolUseId;
      if (!sameTask || event.provider !== outbound.provider || event.workflowProgress === undefined) return event;
      const retained = { ...event };
      delete retained.workflowProgress;
      delete retained.workflowProgressTruncated;
      return retained;
    });
  }
  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  if (runtimeStateChanged) broadcastSessionActivity(run, 'running');
  if (message.kind === 'status' && message.text === 'foreground_complete') broadcastSessionActivity(run, 'response_complete');
  if (message.kind === 'permission_request') {
    broadcastSessionActivity(run, 'permission');
  } else if (message.kind === 'error') {
    broadcastSessionActivity(run, 'error');
  } else if (message.kind === 'complete') {
    broadcastSessionActivity(run, typeof message.exitCode === 'number' && message.exitCode !== 0 ? 'error' : 'complete');
  }

  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (runs.get(run.appSessionId) !== run || !providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastSessionUpserted(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /** The authenticated websocket handler registers metadata observers without subscribing to any chat stream. */
  registerActivityObserver(connection: RealtimeClientConnection, userId: string | number | null): void {
    activityObservers.set(connection, userId);
  },

  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    /**
     * The socket that asked for this run, or `null` for one nobody is watching
     * — a scheduled message fires with no browser attached. The writer's event
     * buffer still records everything, so a client that subscribes later
     * replays the run from its start.
     */
    connection: RealtimeClientConnection | null;
    userId: string | number | null;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (sessionMutations.has(input.appSessionId) || projectMutations.has(sessionsDb.getSessionById(input.appSessionId)?.project_path ?? '') || (existing && existing.status === 'running')) {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      runId: randomUUID(),
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      events: [],
      messageReceipts: new Map(),
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    runs.set(input.appSessionId, run);
    broadcastSessionActivity(run, 'running');
    return run;
  },

  /** Used by Claude session actions to make idle checks and send exclusion atomic. */
  reserveSessionMutation(appSessionId: string): (() => void) | null {
    if (sessionMutations.has(appSessionId) || runs.get(appSessionId)?.status === 'running') return null;
    sessionMutations.add(appSessionId);
    return () => { sessionMutations.delete(appSessionId); };
  },

  /** Scheduled dispatch uses this read-only guard to leave queued input untouched while a rewind owns the context. */
  isSessionMutating(appSessionId: string): boolean {
    return sessionMutations.has(appSessionId);
  },

  /** Used by file rewind to exclude concurrent edits from any CloudCLI conversation in the project. */
  reserveProjectMutation(projectPath: string): (() => void) | null {
    if (projectMutations.has(projectPath) || Array.from(runs.values()).some(run =>
      run.status === 'running' && sessionsDb.getSessionById(run.appSessionId)?.project_path === projectPath)) return null;
    projectMutations.add(projectPath);
    return () => { projectMutations.delete(projectPath); };
  },

  /** Used after a rewind so reconnect never replays the discarded conversation tail. */
  forgetCompletedRun(appSessionId: string): void {
    if (runs.get(appSessionId)?.status !== 'running') runs.delete(appSessionId);
  },

  /** Used by rewind to replace stale history in every window after the database mapping commits. */
  notifyContextReset(appSessionId: string, contextRevision: string, ancestry?: { backupSessionId: string | null; previousProviderSessionId: string; providerSessionId: string }): void {
    const payload = JSON.stringify({ kind: 'session_context_reset', sessionId: appSessionId, contextRevision, ...ancestry, timestamp: new Date().toISOString() });
    for (const client of connectedClients) {
      if (client.readyState === WS_OPEN_STATE) {
        try { client.send(payload); } catch { /* A disconnected window refreshes authoritative history on reconnect. */ }
      }
    }
    void broadcastSessionUpserted(appSessionId).catch(() => {});
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  /** The chat gateway uses this current-run snapshot for subscriptions and rejected sends. */
  getRuntimeSnapshot(appSessionId: string) {
    const run = runs.get(appSessionId);
    const isProcessing = run?.status === 'running';
    return {
      isProcessing,
      runId: run?.runId,
      runStartedAt: run?.startedAt,
      lastSeq: run?.lastSeq ?? 0,
      ...(run?.runtimeState ?? {}),
      // Admission precedes initialization. Neither a starting query nor a
      // retained completed run advertises a writable native input stream.
      acceptsInput: isProcessing && run?.runtimeState?.acceptsInput === true,
    };
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
    phase?: 'foreground' | 'background'; acceptsInput?: boolean; inputModes?: Array<'queue' | 'interrupt'>; canInterruptQueuedMessages?: boolean; canStopTask?: boolean; backgroundTasks?: number; executionId?: string;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
        ...(run.runtimeState ?? {}),
      }));
  },

  /**
   * Adds a websocket connection to a run's live audience.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   *
   * Subscribing does not take the stream away from sockets that were already
   * watching — a session open in two places stays live in both, and the
   * refreshed tab's abandoned socket is dropped when the next event finds it
   * closed. Replay stays per-connection because each client sends its own
   * `lastSeq` with `chat.subscribe`.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    const frames = new Map([...run.messageReceipts.values(), ...run.events].map(event => [event.seq, event]));
    return [...frames.values()].filter(event => typeof event.seq === 'number' && event.seq > afterSeq).sort((a, b) => a.seq! - b.seq!);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run.
   */
  clearAll(): void {
    runs.clear();
    sessionMutations.clear();
    projectMutations.clear();
  },
};
