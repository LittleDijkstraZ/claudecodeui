import path from 'node:path';

import type { WebSocket } from 'ws';

import { sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/index.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from '@/shared/index.js';
import { parseIncomingJsonObject, createNormalizedMessage } from '@/shared/index.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/** Application boundary for dispatching provider runs and approvals. */
export type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  enqueue?(provider: LLMProvider, sessionId: string, command: string, options: AnyRecord): Promise<boolean>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
};

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string,
  clientMessageId?: string,
  definitelyNotSubmitted = false,
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(definitelyNotSubmitted ? { definitelyNotSubmitted: true } : {}),
    sessionId: sessionId ?? null,
    ...(sessionId ? chatRunRegistry.getRuntimeSnapshot(sessionId) : { isProcessing: false, acceptsInput: false }),
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.send');
  if (!resolved) {
    return;
  }

  await dispatchRun(ws, userId, resolved.sessionId, resolved.session, data, dependencies);
}

type ResolvedSendTarget = {
  sessionId: string;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  provider: LLMProvider;
};

/**
 * Shared front half of `chat.send` and `chat.edit-send`: the session row and
 * provider come from the database, never from the client.
 */
function resolveSendTarget(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  frameName: string,
): ResolvedSendTarget | null {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${frameName} requires a sessionId.`, undefined, data.clientMessageId);
    return null;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId, data.clientMessageId
    );
    return null;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId, data.clientMessageId);
    return null;
  }

  return { sessionId, session, provider };
}

/**
 * Registers the run and hands the turn to the provider runtime.
 *
 * `extraRuntimeOptions` is how an edited message asks the provider to resume
 * partway instead of continuing from the tip; a normal send passes nothing.
 */
async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>) => void | Promise<void>,
): Promise<{ started: boolean; error: string | null }> {
  const provider = session.provider as LLMProvider;

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';
  const deliveryMode = clientOptions.deliveryMode ?? 'queue';
  if (clientOptions.deliveryMode !== undefined && clientOptions.deliveryMode !== 'queue' && clientOptions.deliveryMode !== 'interrupt') {
    if (ws) sendProtocolError(ws, 'INVALID_DELIVERY_MODE', 'Delivery mode must be queue or interrupt.', sessionId, data.clientMessageId);
    return { started: false, error: 'Invalid delivery mode.' };
  }

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    ...extraRuntimeOptions,
    clientMessageId: data.clientMessageId,
    deliveryMode,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    cwd: session.project_path ?? clientOptions.cwd ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
  };

  const clientMessageId = typeof data.clientMessageId === 'string' ? data.clientMessageId : undefined;
  if (data.clientMessageId !== undefined && (!clientMessageId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientMessageId))) {
    if (ws) sendProtocolError(ws, 'INVALID_MESSAGE_ID', 'A valid client message UUID is required.', sessionId, clientMessageId);
    return { started: false, error: 'Invalid client message identifier.' };
  }
  if (deliveryMode === 'interrupt' && (provider !== 'claude' || beforeRun || Object.keys(extraRuntimeOptions).length > 0 || !clientMessageId || !command.trim() && uniqueAttachments.length === 0)) {
    if (ws) sendProtocolError(ws, 'INTERRUPT_NOT_SUPPORTED', 'Interrupt and send requires a regular Claude message with content and a message UUID.', sessionId, clientMessageId);
    return { started: false, error: 'Interrupt and send is not supported for this request.' };
  }
  const existing = chatRunRegistry.getRun(sessionId);
  const previousReceipt = clientMessageId ? existing?.messageReceipts.get(clientMessageId) : undefined;
  if (existing && previousReceipt) {
    if (String(existing.writer.userId) !== String(userId) || previousReceipt.content !== command || (previousReceipt.deliveryMode ?? 'queue') !== deliveryMode
      || JSON.stringify([previousReceipt.images ?? [], previousReceipt.files ?? []]) !== JSON.stringify([runtimeOptions.images ?? [], runtimeOptions.files ?? []])) {
      if (ws) sendProtocolError(ws, 'MESSAGE_ID_CONFLICT', 'This message identifier cannot be reused for another send.', sessionId, clientMessageId);
      return { started: false, error: 'Message identifier conflict.' };
    }
    if (existing.status === 'completed') {
      // A retry after completion may repeat its receipt, never launch the same prompt again.
      if (ws) sendJson(ws, previousReceipt);
      return { started: true, error: null };
    }
  }
  if (deliveryMode === 'interrupt' && (existing?.status !== 'running' || !existing.runtimeState?.inputModes?.includes('interrupt'))) {
    if (ws) sendProtocolError(ws, 'INPUT_NOT_ACCEPTED', 'The current Claude process has not advertised interrupt-and-send support. No replacement process was started.', sessionId, clientMessageId);
    return { started: false, error: 'The existing Claude input stream cannot accept interrupt and send.' };
  }
  if (existing?.status === 'running' && provider === 'claude' && dependencies.runtime.enqueue && !beforeRun && Object.keys(extraRuntimeOptions).length === 0 && clientMessageId) {
    if (String(existing.writer.userId) !== String(userId)) {
      if (ws) sendProtocolError(ws, 'RUN_OWNER_MISMATCH', 'This process belongs to a different authenticated user.', sessionId, clientMessageId);
      return { started: false, error: 'Run owner mismatch.' };
    }
    if (ws) chatRunRegistry.attachConnection(sessionId, ws);
    try {
      if (!await dependencies.runtime.enqueue(provider, sessionId, command, runtimeOptions)) {
        const reason = previousReceipt
          ? 'The existing Claude input stream is not ready. Review the original message delivery status before sending another copy.'
          : 'The existing Claude input stream is not ready. This message was not submitted; send the saved copy after its state updates.';
        // False occurs before the runtime reserves input. A prior receipt still
        // owns its delivery outcome, so a UUID retry must never be relabeled unsent.
        if (ws) sendProtocolError(ws, 'INPUT_NOT_ACCEPTED', reason, sessionId, clientMessageId, !previousReceipt);
        return { started: false, error: reason };
      }
      return { started: true, error: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (ws) sendProtocolError(ws, 'INPUT_NOT_ACCEPTED', reason, sessionId, clientMessageId);
      return { started: false, error: reason };
    }
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });

  if (!run) {
    if (ws) {
      sendProtocolError(
        ws,
        'RUN_IN_PROGRESS',
        `Session "${sessionId}" already has a run in progress.`,
        sessionId,
        clientMessageId
      );
    }
    return { started: false, error: 'A run is already in progress for this session.' };
  }

  // Admission is not delivery to Claude. Record the prompt before launch preparation
  // so a model/settings/ownership failure cannot leave an orphaned optimistic send.
  if (provider === 'claude' && clientMessageId) run.writer.send(createNormalizedMessage({
    kind: 'status', text: 'message_delivery', sessionId, provider, clientMessageId,
    delivery: 'queued', deliveryMode, content: command, images: runtimeOptions.images, files: runtimeOptions.files,
    timestamp: new Date().toISOString(),
  }));

  let failure: string | null = null;
  try {
    // Group-created drafts have no initial message at allocation time. Name only
    // accepted sends so a rejected competing send cannot rename the conversation.
    sessionsService.initializeAppSessionName(sessionId, command);

    // Initialize draft choices once. Claude launches reread the canonical session
    // selection, so a stale browser cannot overwrite a newer saved choice here.
    if ((provider !== 'claude' || !session.model) && typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
      providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
    }
    if ((provider !== 'claude' || !session.effort) && typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
      providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
    }

    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    await beforeRun?.(run);
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure });
    if (provider === 'claude' && clientMessageId && run.messageReceipts.get(clientMessageId)?.delivery !== 'delivered') run.writer.send(createNormalizedMessage({
      kind: 'status', text: 'message_delivery', sessionId, provider, clientMessageId,
      delivery: 'failed', deliveryMode, content: command, images: runtimeOptions.images, files: runtimeOptions.files,
      timestamp: new Date().toISOString(), error: failure,
    }));
    run.writer.send(createNormalizedMessage({ kind: 'error', content: failure, sessionId, provider }));
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }

  return { started: true, error: failure };
}

/**
 * Handles `chat.edit-send`: replaces an already-sent message and everything
 * after it with a new turn.
 *
 * Nothing is deleted. The provider resumes the conversation partway and
 * appends the replacement, so the abandoned attempt stays in the transcript
 * file and is simply no longer part of the live conversation — the same shape
 * Claude Code's rewind and Codex's fork-with-cut-point produce.
 */
async function handleChatEditSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.edit-send');
  if (!resolved) {
    return;
  }

  const { sessionId, session, provider } = resolved;
  if (data.options?.deliveryMode === 'interrupt') {
    sendProtocolError(ws, 'INTERRUPT_NOT_SUPPORTED', 'Interrupt and send cannot edit or rewind a previous message.', sessionId, data.clientMessageId);
    return;
  }
  const anchorId = typeof data.anchorId === 'string' ? data.anchorId.trim() : '';
  if (!anchorId) {
    sendProtocolError(ws, 'ANCHOR_REQUIRED', 'chat.edit-send requires the anchorId of the message being replaced.', sessionId, data.clientMessageId);
    return;
  }

  let resumeThroughId: string | null;
  try {
    const anchor = await sessionsService.resolveEditAnchor(sessionId, anchorId);
    if (!anchor) {
      sendProtocolError(
        ws,
        'EDIT_NOT_SUPPORTED',
        `Provider "${provider}" cannot replace an already-sent message.`,
        sessionId, data.clientMessageId
      );
      return;
    }
    if (!anchor.found) {
      sendProtocolError(ws, 'ANCHOR_NOT_FOUND', 'That message is no longer in the transcript.', sessionId, data.clientMessageId);
      return;
    }
    resumeThroughId = anchor.resumeThroughId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'ANCHOR_LOOKUP_FAILED', `Could not read the transcript: ${message}`, sessionId, data.clientMessageId);
    return;
  }

  // Providers split here on what their runtime can do. Claude resumes its
  // transcript partway, so the anchor rides along as a run option. Codex
  // cannot — a thread only grows — so the conversation is rewound on disk and
  // the run that follows is an ordinary resume of whatever the session then
  // points at. Which of the two applies is decided here; the rewind itself
  // waits until the run has actually been admitted.
  const rewinds = sessionsService.providerRewindsForEdit(sessionId);

  await dispatchRun(
    ws,
    userId,
    sessionId,
    session,
    data,
    dependencies,
    // `null` is meaningful: the edited turn was the first prompt, so the
    // conversation starts over instead of resuming.
    rewinds
      ? {}
      : { resumeAnchorId: resumeThroughId ?? undefined, resumeFromScratch: resumeThroughId === null },
    async (run) => {
      // Emitted through the run's writer so it is sequenced and replayed like
      // any other event — a second tab watching this session has to truncate
      // too.
      //
      // Before the rewind, not after it. A rewind that has to branch spawns a
      // process and waits on a JSON-RPC round trip, and holding the frame
      // until that came back left the message the user had just edited away
      // sitting on screen for about a second — the very flicker this feature
      // exists to avoid. Announcing first is safe because a rewind that fails
      // still ends the run, and the terminal `complete` makes every client
      // re-read the transcript, which puts back anything that turned out not
      // to have been replaced after all.
      run.writer.send({
        kind: 'history_truncated',
        provider,
        sessionId,
        anchorId,
      });

      if (rewinds) {
        try {
          await sessionsService.rewindSessionForEdit(sessionId, resumeThroughId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not rewind the conversation: ${message}`, sessionId, data.clientMessageId);
          // Ends the run before the provider is asked to continue a
          // conversation that was not rewound after all.
          throw error;
        }
      }
    },
  );
}

/**
 * Handles an explicit cancellation. Claude retains ownership until its native
 * query exits; a rejected interrupt must not make a live run appear completed.
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  let success = false;
  try {
    success = await dependencies.runtime.abort(run.provider, sessionId);
  } catch { /* Rejected interrupts leave the existing run and queue intact. */ }
  if (!success) {
    sendProtocolError(ws, 'ABORT_FAILED', 'The provider did not confirm the stop request. The existing process may still be running; its session has not been released.', sessionId);
    return;
  }
  // Claude itself publishes completion only once its input and query have
  // closed. Other providers retain their existing gateway completion contract.
  if (run.provider !== 'claude') chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true });
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      ...chatRunRegistry.getRuntimeSnapshot(sessionId),
      pendingPermissions,
      messageReceipts: run && String(run.writer.userId) === String(userId) ? [...run.messageReceipts.values()] : [],
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, (target as AnyRecord).runId === run?.runId ? lastSeq : 0)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
/**
 * Runs a turn for a session with no client attached.
 *
 * Used by scheduled messages, which fire from a timer: there is no socket to
 * report errors to and no audience to stream to. The run is registered exactly
 * like an interactive one, so anyone who opens the session while it is going
 * subscribes and replays it from the start, and the session shows as busy
 * everywhere in the meantime.
 *
 * Resolves when the provider run settles. Returns false when the session has
 * gone away or is busy without `interruptActiveRun`, which the caller reports
 * on the schedule.
 */
export async function runDetachedChatTurn(
  input: {
    sessionId: string;
    userId: string | number | null;
    content: string;
    options?: AnyRecord;
    /**
     * Aborts a run already in progress instead of refusing to start. A
     * scheduled message sets this: the user picked the time knowing it might
     * land mid-run, so the timer outranks whatever is running.
     */
    interruptActiveRun?: boolean;
    /** Dispatcher snapshot prevents an already claimed input from crossing a context replacement. */
    expectedProviderSessionId?: string | null;
  },
  dependencies: ChatWebSocketDependencies,
): Promise<{ started: boolean; error: string | null }> {
  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) {
    return { started: false, error: 'The session no longer exists.' };
  }

  const contextMatches = () => input.expectedProviderSessionId === undefined || sessionsDb.getSessionById(input.sessionId)?.provider_session_id === input.expectedProviderSessionId;
  const changedContext = { started: false, error: 'Conversation context changed before this queued message could start.' };
  if (!contextMatches()) return changedContext;
  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    return { started: false, error: `Provider "${provider}" is not available.` };
  }

  const activeRun = chatRunRegistry.getRun(input.sessionId);
  if (activeRun && activeRun.status === 'running') {
    if (!input.interruptActiveRun) {
      return { started: false, error: 'A run was already in progress for this session.' };
    }
    let aborted = false;
    try { aborted = await dependencies.runtime.abort(activeRun.provider, input.sessionId); }
    catch { /* The scheduled row records the rejection for a manual retry. */ }
    if (!contextMatches()) return changedContext;
    if (!aborted) return { started: false, error: 'The provider did not confirm stopping the existing run. This message was not sent; retry manually after checking the session.' };
    if (activeRun.provider !== 'claude') chatRunRegistry.completeRunIfCurrent(activeRun, { exitCode: 0, aborted: true });
    // Claude owns completion until its query exits. Keep the scheduled row as
    // failed/reviewable instead of starting a replacement during stdin close.
    if (chatRunRegistry.isProcessing(input.sessionId)) return { started: false, error: 'The previous process is still closing or another run started. This message was not sent; retry manually after checking the session.' };
  }

  if (!contextMatches()) return changedContext;
  return dispatchRun(
    null,
    input.userId,
    input.sessionId,
    session,
    { sessionId: input.sessionId, content: input.content, options: input.options ?? {} },
    dependencies,
  );
}

export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);
  chatRunRegistry.registerActivityObserver(ws, userId);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.edit-send':
          await handleChatEditSend(ws, userId, data, dependencies);
          return;
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, userId, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
