import type { TFunction } from 'i18next';
import type { NavigateFunction } from 'react-router-dom';

//----------------- LLM PROVIDER MODEL CATALOG ------------

/** Identifies which coding-agent CLI backs a session, project selection or model list. */
export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'opencode';

/** One selectable model in a provider's model menu, including its optional reasoning-effort choices. */
export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  recordId?: number;
  isCustom?: boolean;
  /** Distinguishes mutable aliases from exact IDs; capacity is independent. */
  selectionKind?: 'alias' | 'version' | 'custom';
  /** Evidence source, never inferred from a friendly model label. */
  catalogSource?: 'remote-api' | 'remote-sdk' | 'remote-config' | 'built-in' | 'manual';
  /** Remote-reported alias resolution, not proof of an actual model response. */
  resolvedModel?: string;
  /** Requested context mode; absence never implies a guessed token limit. */
  contextMode?: 'default' | '1m';
  /** Maximum input tokens reported by the remote Models API, when available. */
  maxInputTokens?: number;

  /** Missing means unreported capabilities; an empty values list explicitly disallows effort overrides. */
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

/** The full model catalog for one provider: every option plus the value used when the user has not chosen one. */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

/** User-supplied fields for creating or editing a custom provider model entry. */
export type CustomProviderModelInput = {
  model: string;
  id: string;
};

/** Mutation callbacks a model menu calls to persist custom provider models. */
export type ProviderModelActions = {
  create(provider: LLMProvider, input: CustomProviderModelInput): Promise<void>;
  update(
    provider: LLMProvider,
    existing: ProviderModelOption,
    input: CustomProviderModelInput,
  ): Promise<void>;
  remove(provider: LLMProvider, existing: ProviderModelOption): Promise<void>;
};

// ---------------------------

//----------------- PROJECTS AND SESSIONS ------------

/** Identifies the workspace pane the user is looking at; plugin panes are namespaced by plugin id. */
export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'browser' | `plugin:${string}`;

/** A message queued to be sent to a session at a future time. */
export type ScheduledMessage = {
  id: string;
  sessionId: string;
  content: string;
  options: Record<string, unknown>;
  /** ISO instant, so the schedule does not move when the user changes time zone. */
  scheduledFor: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  /** Why it did not go, when `status` is `failed`. */
  failureReason: string | null;
  createdAt: string;
};

/** A single conversation inside a project, as returned by the sessions API and rendered in the sidebar and chat. */
export type ProjectSession = {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  provider?: LLMProvider;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
};

/** Pagination metadata returned alongside a project's session page. */
type ProjectSessionMeta = {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
};

/** Task Master provisioning state for a project, used to decide whether the tasks tab is available. */
type ProjectTaskmasterInfo = {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
/** A workspace project as the UI knows it: identity, path, star state and its loaded sessions. */
export type Project = {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  [key: string]: unknown;
};

/** Progress payload streamed while the backend enumerates projects, used to drive the sidebar loading bar. */
export type LoadingProgress = {
  kind?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
};

// ---------------------------

//----------------- RELEASES ------------

/** The latest GitHub release for the app, rendered by the update prompt and the About tab. */
export type ReleaseInfo = {
  title: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
};

/** How this CloudCLI install was obtained; decides whether the UI offers a self-update action. */
export type InstallMode = 'git' | 'npm';

// ---------------------------

//----------------- SESSION PROCESSING STATE ------------

/** Identity of the run owning a websocket sequence cursor; session IDs remain stable across many runs. */
export type ChatRunCursor = { runId: string; startedAt?: number };

/** Claude sends wait for the current reply by default; interrupt explicitly redirects the same native process. */
export type ClaudeInputMode = 'queue' | 'interrupt';

/** Authoritative state of a live Claude execution; background work keeps the run alive without blocking its input stream. */
export type SessionRuntimeState = {
  /** One foreground reply within a longer native execution. Absent while only background work remains. */
  foregroundTurnId?: string;
  foregroundStartedAt?: string;
  phase?: 'foreground' | 'background';
  acceptsInput?: boolean;
  /** Only modes explicitly advertised by this remote execution may be offered as supported. */
  inputModes?: ClaudeInputMode[];
  backgroundTasks?: number;
  executionId?: string;
};

/** What a live session is doing; presence protects its execution even while only background tasks remain. */
export type SessionActivity = SessionRuntimeState & {
  /** Provider-supplied status line; null renders the default activity label. */
  statusText: string | null;
  canInterrupt: boolean;
  /**
   * When this request was first marked as processing (client clock). Drives
   * the elapsed-time display and the stale `chat_subscribed` idle-ack guard.
   */
  startedAt: number;
};

/** Every session currently producing a response, keyed by session id. Read it to tell whether a session is busy. */
export type SessionActivityMap = ReadonlyMap<string, SessionActivity>;

/** Marks a session as producing a response; call it as soon as a send is dispatched so the UI reacts immediately. */
export type MarkSessionProcessing = (
  sessionId?: string | null,
  activity?: SessionRuntimeState & { statusText?: string | null; canInterrupt?: boolean },
) => void;

/** Marks a session as finished; `ifStartedBefore` lets a late acknowledgement clear only a stale run. */
export type MarkSessionIdle = (
  sessionId?: string | null,
  opts?: { ifStartedBefore?: number },
) => void;

/** Replaces the whole processing map with the server's view, used by the periodic running-sessions poll. */
export type SyncProcessingSessions = (
  sessions: readonly SessionActivitySnapshot[],
) => void;

/** Reports whether one session is currently producing a response. */
export type IsSessionProcessing = (sessionId?: string | null) => boolean;

/** One running session as reported by the server, before it is folded into the client-side activity map. */
export type SessionActivitySnapshot = SessionRuntimeState & {
  sessionId: string;
  statusText?: string | null;
  canInterrupt?: boolean;
  startedAt?: number;
};

// ---------------------------

//----------------- REALTIME TRANSPORT ------------

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};


// ---------------------------

//----------------- SHARED UI PRIMITIVES ------------

/** Progress state of a single queue row, driving the indicator the Queue primitive renders. */
export type QueueItemStatus = 'completed' | 'in_progress' | 'pending';

// ---------------------------

//----------------- AUTH ------------


// ---------------------------

//----------------- CHAT MESSAGES AND PERMISSIONS ------------

/** Permission preset a provider runs a turn under ('default', 'acceptEdits', 'auto', 'bypassPermissions' or 'plan'), chosen in the composer and sent with each message; the backend capability matrix decides which values a given provider accepts. */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';

/** A non-image file attached to a chat message, described by its path in the server-managed attachment store plus display metadata so it can be listed and downloaded. */
export type ChatAttachment = {
  /** Absolute path inside the server-managed chat attachment store. */
  path?: string;
  name?: string;
  mimeType?: string;
  size?: number;
};

/** A chat attachment that is an image, extending ChatAttachment with the inline base64 data URL that Claude history uses when no stored path is available. */
export type ChatImage = {
  /** Inline data URL (Claude history stores image attachments as base64). */
  data?: string;
} & ChatAttachment;

/** One stored memory an assistant reply drew on, naming the file and line range read plus what was taken from it, shown as a footnote under the reply so a memory-derived claim stays traceable. */
export type MemoryCitation = {
  /** File and line range that was read, e.g. `MEMORY.md:137-142`. */
  source: string;
  /** What the reply took from that range, when the provider states it. */
  note?: string;
};

/** One entry in a subagent's recorded timeline, normalized by the backend from either provider's transcript; `kind` decides whether the tool fields or `content` carry the entry, so read only the set that matches. */
export type SubagentActivity = {
  kind: 'tool' | 'text' | 'thinking';
  timestamp?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  content?: string;
};

/** Identity and lifecycle of one spawned subagent as the backend reports it; present on the tool call that spawned the agent and used to draw its container header. */
export type SubagentInfo = {
  id: string;
  name?: string;
  type?: string;
  description?: string;
  status: 'running' | 'completed' | 'failed';
  model?: string;
  /** Total entries the agent recorded, which exceeds the received timeline when a long run was truncated for transport. */
  activityCount?: number;
};

/** Delivery of a client-addressed user message; only a remote Claude acknowledgement can mark it delivered. */
export type ChatMessageDelivery = 'queued' | 'delivered' | 'failed';

/** One rendered entry in a chat transcript — user turn, assistant turn, tool call and result, local command output, or subagent container — and the shape the chat message list and message components consume. */
export type ChatMessage = {
  type: string;
  clientMessageId?: string;
  /** New input UUID created by an explicit retry of this retained copy; prevents retrying the same copy twice. */
  retriedAsClientMessageId?: string;
  /** Websocket run owning this receipt; used to close unconfirmed copies when a later execution starts. */
  runId?: string;
  /** Exact API response linked by native consumption receipt; history uses the same response ID and parent ancestry. */
  responseMessageId?: string;
  responseMessageIds?: string[];
  /** Remote execution identity from the admission/consumption receipt; never inferred from prompt text. */
  executionId?: string;
  providerSessionId?: string;
  delivery?: ChatMessageDelivery;
  /** The remote explicitly refused this UUID before input admission; this retained copy can be sent deliberately without guessing delivery. */
  definitelyNotSubmitted?: boolean;
  /** Browser-retained input whose position has not been matched to loaded native history; display separately. */
  isUnlocatedLocalCopy?: boolean;
  deliveryError?: string;
  content?: string;
  displayText?: string;
  timestamp: string | number | Date;
  images?: ChatImage[];
  files?: ChatAttachment[];
  reasoning?: string;
  /**
   * The provider's identifier for the transcript row behind this message, when
   * the provider has stable per-row identity. Present on user turns from
   * Claude; it is the anchor "edit this message" and "fork from here" send back.
   */
  transcriptAnchorId?: string;
  /**
   * Set on the optimistic echo of a message being sent as a replacement for an
   * already-sent one, naming the anchor it replaces. Local to this client.
   */
  replacesAnchorId?: string;
  isThinking?: boolean;
  isStreaming?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  toolId?: string;
  toolCallId?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  isSubagentContainer?: boolean;
  /** The agent this row spawned, when it spawned one. Its presence is what makes a row a subagent container. */
  subagent?: SubagentInfo;
  /** What that agent did, in order. Empty while the agent is still starting up. */
  subagentActivity?: SubagentActivity[];
  /** Stored memory this reply drew on, shown as a footnote beneath it. */
  memoryCitations?: MemoryCitation[];
  /** Lifecycle the provider reported for this tool call, when it reports one; otherwise the status is inferred from whether a result has arrived. */
  toolStatus?: string;
  [key: string]: unknown;
};

/** The user's locally persisted Claude preferences (allowed and disallowed tool lists, permission skipping and project sort order) read from and written back to browser storage. */
export type ClaudeSettings = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: string;
  lastUpdated?: string;
  [key: string]: unknown;
};

/** A proposed Claude tool-permission rule derived from a denied tool call, offered to the user so that tool can be added to the stored allow list in one click. */
export type ClaudePermissionSuggestion = {
  toolName: string;
  entry: string;
  isAllowed: boolean;
};

/** Outcome of writing a tool-permission rule into the stored Claude settings, reporting whether it succeeded, whether the rule was already allowed, and the resulting settings. */
export type PermissionGrantResult = {
  success: boolean;
  alreadyAllowed?: boolean;
  updatedSettings?: ClaudeSettings;
};

/** A tool-permission request awaiting the user's decision, identified by its requestId and carrying the tool name, input and context needed to render the prompt and reply to the backend. */
export type PendingPermissionRequest = {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
};

/** One question asked by the AskUserQuestion tool, with its answer options and whether more than one option may be selected. */
export type Question = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

/** Options for a programmatic session navigation, currently only whether the route change should replace the current history entry instead of pushing a new one. */
export type SessionNavigationOptions = {
  replace?: boolean;
};

/** Context handed to the workspace when a chat run creates a session, naming the provider that created it, the owning project and the session summary, so the session can be selected and labelled. */
export type SessionEstablishedContext = {
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

/** The result returned for a tool call, carrying its content, error flag, timestamp and any provider-specific extras that the tool renderers read. */
export type ToolResult = {
  content?: unknown;
  isError?: boolean;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  [key: string]: unknown;
};

/** One selectable answer for a Question, with the label shown to the user and an optional explanatory description. */
type QuestionOption = {
  label: string;
  description?: string;
};

// ---------------------------

//----------------- CHAT SESSION STORE ------------

/** Exact provider text-block identity retained from streaming through saved history. */
export type AssistantStreamIdentity = {
  responseMessageId?: string;
  transcriptAnchorId?: string;
  contentBlockIndex?: number;
};

/** A provider-agnostic transcript event as normalized by the backend adapters, with all kind-specific fields kept flat; it is the shape the session store holds and that chat converts into ChatMessage for rendering, so treat it as the wire contract rather than a view model. */
export type NormalizedMessage = {
  /** Native index within an assistant API response; the response alone can contain several text blocks. */
  contentBlockIndex?: number;
  /** Client-observed neighbors keep unconfirmed live output in place when user IDs hydrate. */
  livePreviousMessageId?: string;
  liveNextMessageId?: string;
  /** Recorded provider tool-result metadata, including Write creation evidence and exact edited content. */
  toolUseResult?: unknown;
  id: string;
  clientMessageId?: string;
  /** Persisted local retry relationship; delivery receipts must not reopen the source copy's retry action. */
  retriedAsClientMessageId?: string;
  /** Websocket run owning this receipt; used to close unconfirmed copies when a later execution starts. */
  runId?: string;
  /** Exact API response linked by native consumption receipt; history uses the same response ID and parent ancestry. */
  responseMessageId?: string;
  responseMessageIds?: string[];
  /** Remote execution identity from the admission/consumption receipt; never inferred from prompt text. */
  executionId?: string;
  providerSessionId?: string;
  delivery?: ChatMessageDelivery;
  /** True only for a remote-confirmed rejection before input admission, never inferred from disconnects or timeouts. */
  definitelyNotSubmitted?: boolean;
  /** Browser-retained input whose position has not been matched to loaded native history; display separately. */
  isUnlocatedLocalCopy?: boolean;
  deliveryError?: string;
  /**
   * The provider's own id for the transcript row behind this message, when the
   * provider has stable per-row identity (today: Claude). Sent back as the
   * anchor for "edit this message" and "fork from here".
   */
  transcriptAnchorId?: string;
  /**
   * Set only on the client-side optimistic echo of an edited message, naming
   * the anchor that echo replaces. Never sent by the backend.
   *
   * The truncation that follows an edit clears every live row, because they
   * belonged to the turn being replaced. This tag is what tells the store the
   * replacement itself is not one of them.
   */
  replacesAnchorId?: string;
  /**
   * How many persisted rows survived the cut this echo was sent for, stamped
   * when the truncation is applied.
   *
   * The echo is retired once the provider persists it, and that is decided by
   * matching text and attachments inside a time window. That is enough until a
   * rewind re-stamps the surviving turns — a provider that has to branch
   * writes the copy with the timestamps of the copy — because an earlier turn
   * with the same words then sits inside the window and retires the message
   * the user just sent. The replacement can only be a row that was not there
   * when the cut was made, so this is where those rows begin.
   */
  replacesAfterRowCount?: number;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Per-run monotonic sequence number assigned by the backend to live
   * websocket events. Used to compute `lastSeq` for `chat.subscribe` replay;
   * REST history messages do not carry it.
   */
  seq?: number;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: Array<{ path?: string; data?: string; name?: string }>;
  files?: Array<{ path?: string; name?: string; mimeType?: string; size?: number }>;
  workflow?: boolean;
  taskId?: string;
  toolUseId?: string;
  usage?: unknown;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown; timestamp?: ToolResult['timestamp'] } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  /** Timeline of a spawned subagent's work, attached by the backend to the tool call that spawned it. */
  subagentTools?: SubagentActivity[];
  /** Identity and lifecycle of that subagent. */
  subagent?: SubagentInfo;
  /** Stored memory this reply drew on, when the provider reports it. */
  memoryCitations?: MemoryCitation[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
};

/** Discriminator on NormalizedMessage naming which kind of transcript event it carries — plain text, tool use or result, thinking, stream delta or end, error, completion, status, permission request/resolution/cancellation, session creation, interactive prompt, or task notification. */
type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_resolved'
  | 'permission_cancelled'
  | 'session_created'
  | 'history_truncated'
  | 'task_notification';

// ---------------------------

//----------------- CHAT COMPOSER ------------

/** Result payload of the chat `/model` slash command, describing the session's current provider and model plus the model catalog it may switch to, used to populate the command modal's model picker. */
export type ModelCommandData = {
  current?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
  };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: ProviderModelOption[];
  defaultModel?: string;
};

/** Result payload of the chat `/cost` slash command, carrying the session's token usage totals and input/output breakdown for the command modal's usage view. */
export type CostCommandData = {
  tokenUsage?: ClaudeUsageSnapshot | {
    used?: number;
    total?: number;
  };
  tokenBreakdown?: {
    input?: number;
    output?: number;
  };
  provider?: string;
  model?: string;
};

/** Result payload of the chat `/status` slash command, carrying server version, uptime, provider/model and process telemetry for the command modal's status view. */
export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
  };
};

/** Result payload of the chat `/help` slash command, carrying either pre-rendered help content or the list of available commands for the command modal's help view. */
export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{
    name: string;
    description?: string;
    namespace?: string;
  }>;
};

/** Wrapper pairing a CommandModalKind with its matching command result data; pass it as the single payload prop that tells the chat command modal which slash-command result to render, or null to close it. */
export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

/** A composer message queued while its session is still busy, holding the text, the in-memory and already-uploaded attachments and the send options snapshotted at queue time so it can be auto-sent unchanged once the session goes idle. */
export type QueuedDraft = {
  /** Native Claude context captured before queue persistence; prevents a later rewind from sending this input into another branch. */
  providerSessionId?: string;
  /** Retained with the old context after rewind; explicit review is required before another send. */
  rewindPaused?: boolean;
  content: string;
  /** Browser files retained while this composer stays mounted, for editing. */
  attachments: File[];
  /** JSON-safe descriptors uploaded when the message is queued. */
  uploadedAttachments?: unknown[];
  /**
   * Send options snapshotted at queue time. Persisted with the draft so the
   * app-level auto-send can dispatch the message with the right model and
   * permission settings while another session is being viewed.
   */
  options?: QueuedSendOptions;
};

/** Viewport-relative placement box (right/bottom offsets plus max height and width) computed for a composer popover so the model and permission menus stay inside the window. */
export type ComposerMenuAnchor = {
  right: number;
  bottom: number;
  maxHeight: number;
  maxWidth: number;
};

/** One selectable slash command — built-in, user-defined or skill-backed — as listed in the chat composer's command menu and executed when the user picks it. */
export type SlashCommand = {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: 'built-in' | 'custom' | 'skill' | string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Discriminator naming which slash-command result the chat command modal is showing: 'help', 'models', 'cost' or 'status'. */
type CommandModalKind = 'help' | 'models' | 'cost' | 'status';

// ---------------------------

//----------------- CHAT VOICE ------------

/** Lifecycle state of the composer's push-to-talk microphone: 'idle', 'recording' or 'transcribing'. */
export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

/** Immutable snapshot of the app-level text-to-speech player for one utterance — its play state plus any error message — read by components so read-aloud state survives re-renders and chat switches. */
export type VoiceSnapshot = { state: VoicePlayState; error: string | null };

/** Playback state of a text-to-speech utterance: 'idle', 'loading' or 'playing'. */
export type VoicePlayState = 'idle' | 'loading' | 'playing';

// ---------------------------

//----------------- CHAT STORAGE ------------

/**
 * Composer options captured when a message is queued, so the message can be
 * sent later with the exact settings (model, permission mode, tools) the
 * session's composer had at queue time — even from outside the composer,
 * e.g. the app-level auto-send that fires while another session is viewed.
 */
export type QueuedSendOptions = Record<string, unknown>;

// ---------------------------

//----------------- CHAT MESSAGE RENDERING ------------

/** Function that turns an old/new string pair into rendered diff lines; the chat session state supplies one memoized, caching instance so each file diff is computed only once. */
export type DiffCalculator = (oldStr: string, newStr: string) => DiffLine[];

/** A synthetic transcript entry standing for a run of consecutive calls to the same tool, produced by the message grouping pass and identified by its `_isGroup` flag so the message list can collapse the run into one expandable block. */
export type ToolGroupItem = {
  _isGroup: true;
  toolName: string;
  messages: ChatMessage[];
  timestamp: ChatMessage['timestamp'];
  /**
   * Summary line for the collapsed group, built while grouping so the tool-input
   * JSON parsing it needs never runs during render.
   */
  preview: string;
};

/** One line of a rendered file diff, marked 'added' or 'removed', with its text and line number. */
export type DiffLine = {
  type: 'added' | 'removed';
  content: string;
  lineNum: number;
};

/** How many lines one file edit added and removed, for the `+12 -3` badge on a diff's header. */
export type DiffStats = {
  added: number;
  removed: number;
};

// ---------------------------

//----------------- CHAT TOOL RENDERING ------------

/** One entry of an agent todo list as produced by the TodoWrite/TodoRead tools, rendered as a single status row in the tool todo-list view. */
export type TodoItem = {
  id?: string;
  content: string;
  status: string;
  priority?: string;
  activeForm?: string;
};

/** Display state of a tool call — 'running', 'completed', 'error' or 'denied' — used to choose the status badge and styling shown beside it in the transcript. */
export type ToolStatus = 'running' | 'completed' | 'error' | 'denied';

/** Props contract that every interactive permission panel implements, giving the panel the pending request and the callback it calls to allow or deny that request; use it when registering a panel in the permission panel registry. */
export type PermissionPanelProps = {
  request: PendingPermissionRequest;
  onDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; updatedInput?: unknown },
  ) => void;
};

// ---------------------------

//----------------- CODE EDITOR ------------

/** The before/after strings of a pending edit attached to a file opened in the code editor, used to drive the editor's inline merge/diff view; extra keys are tolerated because it comes straight from tool payloads. */
export type CodeEditorDiffInfo = {
  old_string?: string;
  new_string?: string;
  [key: string]: unknown;
};

/** A file handed to the code editor for viewing or editing, carrying its display name, workspace-relative path, owning DB projectId for read/save requests and any diff to highlight. */
export type CodeEditorFile = {
  name: string;
  path: string;
  // DB projectId; used by the editor to build `/api/file-tree/projects/:projectId/file`
  // URLs for reading and saving content.
  projectId?: string;
  diffInfo?: CodeEditorDiffInfo | null;
  [key: string]: unknown;
};

/** The category of browser-renderable media a file maps to, used by the code editor to decide whether to show an inline image, PDF, video or audio preview instead of a text buffer. */
export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio';

// ---------------------------

//----------------- FILE TREE ------------

/** Progress, completion or failure state of one in-flight file-tree upload, produced by the upload hook and rendered by the file tree's progress banner. */
export type FileTreeUploadProgressState = {
  status: 'uploading' | 'complete' | 'error';
  progress: number;
  fileCount: number;
  uploadedCount?: number;
  fileName?: string;
  targetPath?: string;
  error?: string;
};

/** Which density the file tree renders its rows at (simple, compact or detailed), chosen in the file tree header and persisted in local storage. */
export type FileTreeViewMode = 'simple' | 'compact' | 'detailed';

/** One file or directory entry in a project's file listing, with directories carrying their loaded `children`; used across the file tree for rendering, searching and filtering. */
export type FileTreeNode = {
  name: string;
  type: FileTreeItemType;
  path: string;
  size?: number;
  modified?: string;
  permissionsRwx?: string;
  children?: FileTreeNode[];
  [key: string]: unknown;
};

/** The image the file tree asked to preview, carrying the path plus the DB `projectId` the image viewer needs to build its raw content URL. */
export type FileTreeImageSelection = {
  name: string;
  path: string;
  projectPath?: string;
  // DB projectId; used by ImageViewer to build the raw content URL.
  projectId: string;
};


/** Whether a file tree entry is a file or a directory; use it instead of repeating the string union wherever `FileTreeNode`-shaped data is handled. */
type FileTreeItemType = 'file' | 'directory';

// ---------------------------

//----------------- GIT PANEL ------------

/** The old/new text of a single edit, handed to the code editor so it can open a file focused on that change. */
type FileDiffInfo = {
  old_string: string;
  new_string: string;
};

/** Callback the git panel calls to open a file in the code editor, optionally focused on one edit. */
export type FileOpenHandler = (filePath: string, diffInfo?: FileDiffInfo) => void;


/** Which tab the git panel is showing (changes, history, branches or worktrees), driving both the tab bar and which data its controller loads. */
export type GitPanelView = 'changes' | 'history' | 'branches' | 'worktrees';

/** Single-letter git status of a changed file (M, A, D or U), used to pick its label, badge styling and change group. */
export type FileStatusCode = 'M' | 'A' | 'D' | 'U';

/** The git action a confirmation dialog is guarding, selecting that dialog's title, action label and colour scheme. */
export type ConfirmActionType = 'discard' | 'delete' | 'commit' | 'pull' | 'push' | 'publish' | 'revertLocalCommit' | 'deleteBranch';

/** Payload of the git status endpoint: the current branch plus working-tree paths grouped by status, or the error and `notGitRepository` fields when the project has no usable repository. */
export type GitStatusResponse = {
  branch?: string;
  hasCommits?: boolean;
  modified?: string[];
  added?: string[];
  deleted?: string[];
  untracked?: string[];
  /** Paths with index-side changes — mirrors the real git index. */
  staged?: string[];
  error?: string;
  details?: string;
  /** True when the project directory is not a git repository — the UI offers `git init`. */
  notGitRepository?: boolean;
};

/** Upstream state of the current branch (remote name, ahead/behind counts, up-to-date flag) that the git panel header and branches view use to enable fetch, pull, push and publish. */
export type GitRemoteStatus = {
  hasRemote?: boolean;
  hasUpstream?: boolean;
  branch?: string;
  remoteBranch?: string;
  remoteName?: string | null;
  ahead?: number;
  behind?: number;
  isUpToDate?: boolean;
  message?: string;
  error?: string;
};

/** One commit in the history list, including the parent hashes and ref decorations the commit graph needs to lay out lanes. */
export type GitCommitSummary = {
  hash: string;
  author: string;
  email?: string;
  date: string;
  message: string;
  stats?: string;
  /** Parent commit hashes — drives the History view commit graph. */
  parents?: string[];
  /** Ref decorations, e.g. "HEAD -> main", "origin/main", "tag: v1.0". */
  refs?: string[];
};

/** Unified diff text keyed by file path, used both for working-tree diffs and for the per-file diffs of an expanded commit. */
export type GitDiffMap = Record<string, string>;

/** A pending confirmation dialog — its message, confirm handler and optional escalated alternative — raised by git panel actions and rendered by the shared Confirmation UI. */
export type ConfirmationRequest = {
  type: ConfirmActionType;
  message: string;
  onConfirm: () => Promise<void> | void;
  alternateConfirmation?: {
    label: string;
    description: string;
    actionLabel: string;
    onConfirm: () => Promise<void> | void;
  };
};

/** The `error` and `details` fields any git API response may carry; intersect it with a route's own payload type instead of redeclaring them. */
export type GitApiErrorResponse = {
  error?: string;
  details?: string;
};

/** Response of a git write endpoint such as commit, pull, push or revert: the shared error fields plus `success` and the raw git `output`. */
export type GitOperationResponse = GitApiErrorResponse & {
  success?: boolean;
  output?: string;
};

/** One git worktree as reported by the worktrees API, including its branch, ahead/behind counts and the linked project used to open it. */
export type WorktreeInfo = {
  path: string;
  branch: string | null;
  headSha: string | null;
  isMain: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  isDetached: boolean;
  changedFileCount: number;
  ahead: number;
  behind: number;
  lastCommitSubject: string | null;
  lastCommitDate: string | null;
  linkedProjectId: string | null;
  linkedProjectArchived: boolean;
};

/** Choices made in the merge-worktree dialog (squash, commit message and whether to remove the worktree afterwards), passed straight to the merge request. */
export type MergeWorktreeOptions = {
  squash: boolean;
  message: string;
  removeAfterMerge: boolean;
};

/** Choices made in the remove-worktree dialog (force removal and whether to delete the worktree's branch), passed straight to the remove request. */
export type RemoveWorktreeOptions = {
  force: boolean;
  deleteBranch: boolean;
};

/** Pre-computed lane geometry for one row of the history commit graph, telling the graph strip which rails to draw above, through and below that commit's dot. */
export type CommitGraphRow = {
  /** Lane the commit dot sits in. */
  nodeLane: number;
  /** Total lanes visible in this row — determines the strip width. */
  laneCount: number;
  /** A line arrives at the node from the row above (some child expects this commit). */
  hasTopContinuation: boolean;
  /** The node's own lane continues below toward its first parent. */
  hasParentContinuation: boolean;
  /** Extra top lanes that merge into the node (multiple children / branch tips joining). */
  inbound: number[];
  /** Bottom lanes branching out of the node toward its extra parents (merge commits). */
  outbound: number[];
  /** Lanes whose lines pass straight through this row untouched. */
  passThrough: number[];
  /** Every lane still active below this row — rails continue through expanded content. */
  bottomLanes: number[];
};

// ---------------------------

//----------------- MCP SERVERS ------------

/** The LLM provider whose MCP server configuration is being read or written; use it to key provider-specific MCP capabilities such as supported scopes and transports. */
export type McpProvider = LLMProvider;

/** Where an MCP server definition is stored - the user's global provider config, Claude's project-local config, or a project workspace config - and therefore which config file a read or write targets. */
export type McpScope = 'user' | 'local' | 'project';

/** How a client connects to an MCP server (a stdio subprocess, streamable HTTP, or SSE); use it to decide which connection fields of a server or form apply. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/** A plain string-to-string map used for the MCP environment variables and HTTP headers that are edited as `KEY=value` lines and sent as objects. */
export type KeyValueMap = Record<string, string>;

// Internal MCP shape; `projectId` replaces the legacy `name` field from the
// projectName → projectId migration.
export type McpProject = {
  projectId: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

/** One MCP server as it is currently configured for a provider, as returned by the MCP API and rendered in the settings server list. */
export type ProviderMcpServer = {
  provider: McpProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  cwd?: string;
  url?: string;
  headers?: KeyValueMap;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: KeyValueMap;
  workspacePath?: string;
  projectName?: string;
  projectDisplayName?: string;
};

/** The complete editable state of the MCP server form, covering the structured connection fields and the raw JSON import text; convert it with createMcpPayloadFromForm before sending it to the API. */
export type McpFormState = {
  name: string;
  scope: McpScope;
  workspacePath: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: KeyValueMap;
  cwd: string;
  url: string;
  headers: KeyValueMap;
  envVars: string[];
  bearerTokenEnvVar: string;
  envHttpHeaders: KeyValueMap;
  importMode: McpImportMode;
  jsonInput: string;
};

/** The request body sent when creating or updating a provider's MCP server, built from McpFormState so only the fields valid for the chosen transport are included. */
export type UpsertProviderMcpServerPayload = {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  cwd?: string;
  url?: string;
  headers?: KeyValueMap;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: KeyValueMap;
};

/** Whether the MCP server form is being filled in field by field or pasted in as raw JSON, which selects the form's input mode. */
type McpImportMode = 'form' | 'json';

// ---------------------------

//----------------- REMOTE MCP AUTHORIZATION ------------

/** A short-lived remote-native MCP sign-in. Connected means the remote CLI passed its MCP health check. */
export type McpAuthAttempt = {
  id: string; name: string; scope: 'user' | 'local' | 'project'; workspacePath?: string; expiresAt: number;
  status: 'starting' | 'awaiting-browser' | 'verifying' | 'connected' | 'failed' | 'expired' | 'cancelled';
  authorizationUrl: string | null; error: string | null;
};

// ---------------------------

//----------------- PLUGINS ------------

/** An installed CloudCLI plugin's manifest and runtime status (entry point, slot, permissions, enabled and server-running flags); always import this type explicitly from `@/shared/types`, because `Plugin` is also a DOM global and an unimported reference silently resolves to that instead. */
export type Plugin = {
  name: string;
  displayName: string;
  version: string;
  /** Changes when the installed entry artifact changes, including same-version updates. */
  assetRevision?: string;
  description: string;
  author: string;
  icon: string;
  type: 'react' | 'module';
  slot: 'tab';
  entry: string;
  server: string | null;
  permissions: string[];
  enabled: boolean;
  serverRunning: boolean;
  dirName: string;
  repoUrl: string | null;
  /** A backend failure does not remove an installed plugin's settings entry. */
  serverError?: string | null;
};

/** Result of a remote plugin mutation; an installed plugin can still need a backend retry. */
export type PluginActionResult = { success: boolean; error?: string | null; pluginName?: string; warning?: string | null };

// ---------------------------

//----------------- PRD EDITOR ------------

/** The PRD document the PRD editor should open, describing either an existing file to load (by path or inline content) or a blank draft to start from. */
export type PrdEditorFile = {
  name?: string;
  path?: string;
  // DB projectId used to resolve the project path when fetching file content.
  projectId?: string;
  content?: string;
  isExisting?: boolean;
};

/** A PRD already stored in a project's TaskMaster docs folder, used to detect filename collisions before saving and to load a previously written PRD. */
export type ExistingPrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  [key: string]: unknown;
};

// ---------------------------

//----------------- PROJECT CREATION WIZARD ------------

/** The one-based index of the step currently shown by the project-creation wizard: 1 configures the workspace, 2 reviews it before creation. */
export type WizardStep = 1 | 2;

/** How the project-creation wizard authenticates a GitHub clone: reuse a 'stored' credential, enter a 'new' token, or use 'none' and rely on public access or an SSH key. */
export type TokenMode = 'stored' | 'new' | 'none';

/** One filesystem directory returned by the browse-filesystem endpoint, used to populate workspace-path autocomplete and the folder browser. */
export type FolderSuggestion = {
  name: string;
  path: string;
  type?: string;
};

/** A stored GitHub token credential as returned by the credentials endpoint, listed so the user can pick which token authenticates a clone. */
export type GithubTokenCredential = {
  id: number;
  credential_name: string;
  is_active: boolean;
};

/** The full set of user-entered values carried across the project-creation wizard's steps, owned by ProjectCreationWizard and passed down to each step. */
export type WizardFormState = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};

// ---------------------------

//----------------- PROJECT WORKSPACE ------------

/** The shared WebSocket connection and its send function, threaded through the workspace tree so descendants can exchange live session messages. */
export type RealtimeProps = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
};

/** Everything the project workspace shell and its regions need from the route: the realtime connection plus the current viewport mode and the router's navigate function. */
export type ProjectWorkspaceShellProps = RealtimeProps & {
  isMobile: boolean;
  navigate: NavigateFunction;
};

// ---------------------------

//----------------- PROVIDER AUTHENTICATION ------------

/** Sign-in state of one LLM provider CLI - whether it is authenticated, the account email and method, plus in-flight loading and error state - polled by the provider-auth module and rendered by the settings and onboarding account views. */
export type ProviderAuthStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
};

/** The authentication state of every CLI provider at once, keyed by LLMProvider, so onboarding and settings can render each provider's connected, loading and error state from one object returned by useProviderAuthStatus. */
export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

// ---------------------------

//----------------- QUICK SETTINGS PANEL ------------

/** Identifier of a boolean user preference exposed in the quick settings panel; use it as the key when reading or writing one preference. */
export type PreferenceToggleKey =
  | 'showRawParameters'
  | 'showThinking'
  | 'sendByCtrlEnter'
  | 'voiceEnabled';

/** The full set of quick settings booleans keyed by PreferenceToggleKey, held together so the panel can read every toggle from one object. */
export type QuickSettingsPreferences = Record<PreferenceToggleKey, boolean>;


// ---------------------------

//----------------- SETTINGS ------------

/** The per-provider agent context the agents settings tab builds once and hands to each of its sections. */
export type AgentContextByProvider = Record<AgentProvider, AgentContext>;

/** The per-provider data the agents settings tab hands to its sections: that provider's auth status and the callback that starts its login flow. */
export type AgentContext = {
  authStatus: ProviderAuthStatus;
  onLogin: () => void;
};

/** Identifier of a top-level section in the settings dialog; use it whenever a tab is stored, compared or requested so deep links, the sidebar and the command palette all agree on the same set of names. */
export type SettingsMainTab = 'agents' | 'appearance' | 'git' | 'api' | 'voice' | 'tasks' | 'browser' | 'notifications' | 'plugins' | 'about';

/** The coding-agent CLI a settings screen is configuring, aliasing LLMProvider so agent-scoped settings read as being about an agent rather than a chat model. */
export type AgentProvider = LLMProvider;

/** One category of per-agent configuration in the agents settings tab (account, permissions, MCP servers or skills); use it to key which panel the tab renders. */
export type AgentCategory = 'account' | 'permissions' | 'mcp' | 'skills';

/** How much Codex may do without asking, from prompting on every edit to bypassing permission checks entirely; persisted as the Codex agent's permission setting. */
export type CodexPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/** A project as the settings dialog needs it - a required identifier in `name` plus optional display name and paths - passed down to the MCP and skills panels so they can scope configuration to a project. */
export type AgentSettingsProject = {
  name: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

/** Claude's persisted permission settings: the allowed and disallowed tool patterns and whether permission prompts are skipped; read and written as one unit by the settings controller. */
export type ClaudePermissionsState = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
};

/** The user's notification settings, grouped into delivery channels (in-app, web push, desktop, sound) and the events that trigger them; mirrors the payload of the notification preferences API. */
export type NotificationPreferencesState = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    desktop: boolean;
    sound: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    error: boolean;
  };
};

/** Cursor's persisted permission settings: the allowed and disallowed command patterns and whether permission prompts are skipped; read and written as one unit by the settings controller. */
export type CursorPermissionsState = {
  allowedCommands: string[];
  disallowedCommands: string[];
  skipPermissions: boolean;
};

/** The code editor display preferences shown in the appearance tab (word wrap, minimap, line numbers and font size), stored together as one server-backed `codeEditorSettings` preference. */
export type CodeEditorSettingsState = {
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

// ---------------------------

//----------------- SETTINGS CREDENTIALS ------------

/** One stored CloudCLI API key as the server returns it, in snake_case, including its masked key, creation and last-used timestamps and active flag; render it, do not rebuild it. */
export type ApiKeyItem = {
  id: string;
  key_name: string;
  api_key: string;
  created_at: string;
  last_used?: string | null;
  is_active: boolean;
};

/** A freshly issued API key in camelCase, the only time the full secret is available; show it once and then fall back to the stored ApiKeyItem. */
export type CreatedApiKey = {
  id: string;
  keyName: string;
  apiKey: string;
  createdAt?: string;
};

/** One stored GitHub credential as the server returns it, in snake_case, carrying its name, optional description, creation timestamp and active flag - never the token itself. */
export type GithubCredentialItem = {
  id: string;
  credential_name: string;
  description?: string | null;
  created_at: string;
  is_active: boolean;
};

// ---------------------------

//----------------- SHELL ------------

/** Handle returned when touch text-selection is installed on an xterm terminal; call updateHandles after the terminal reflows and dispose when tearing the terminal down. */
export type MobileTerminalSelectionManager = {
  dispose: () => void;
  updateHandles: () => void;
};

// ---------------------------

//----------------- SIDEBAR ------------

/** The complete project-list state and callback bundle the sidebar assembles once and threads down through its project list, project rows and session rows. */
export type SidebarProjectListProps = {
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  expandedProjects: Set<string>;
  activeRename: ActiveSidebarRename | null;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  deletingProjects: Set<string>;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  onLoadMoreSessions: (projectId: string) => void;
  loadingMoreProjects: Set<string>;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  /** Restores the unread indicator from a sidebar conversation menu. */
  onMarkSessionUnread?: (sessionId: string) => void;
  forceExpanded?: boolean;
  isProjectStarred: (projectName: string) => boolean;
  onRenameDraftChange: (draft: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Branches a session into an independent one. Rows hide it for providers that cannot. */
  onForkSession?: (session: SessionWithProvider) => void;
  onNewSession: (project: Project) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

/** The ordering applied to the project list, either alphabetically by name or by most recent activity, persisted alongside the user's appearance settings. */
export type ProjectSortOrder = 'name' | 'date';

/** Which list the sidebar is currently showing: projects, conversation search results, running sessions or archived items. */
export type SidebarSearchMode = 'projects' | 'conversations' | 'groups' | 'running' | 'archived';

/** A Project narrowed to the archived state so archived entries can be listed and restored without being mistaken for active projects. */
export type ArchivedProjectListItem = Project & { isArchived: true };

/** A ProjectSession whose LLM provider has been resolved into the required __provider field, so list rendering never has to re-derive it. */
export type SessionWithProvider = ProjectSession & {
  __provider: LLMProvider;
};

/** One archived session as returned by the archive API, carrying its own project identity because the owning project may itself be archived. */
export type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

/** The subset of archived-session fields needed to render a recent-conversations row and reopen the session it points at. */
export type RecentConversationListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity'
>;

/**
 * The rename the sidebar currently has open, if any.
 *
 * One value rather than two id/draft pairs, so a project and a session cannot
 * both be mid-rename, and rows can be handed a resolved `isEditing` instead of
 * the raw id — a keystroke then only invalidates the row being renamed.
 *
 * A session rename carries the project that owns it so SidebarProjectList can
 * decide in O(1) which project row the draft belongs to. Without it every row
 * has to be handed the whole value and a keystroke invalidates all of them.
 */
export type ActiveSidebarRename =
  | { target: 'project'; id: string; draft: string }
  | { target: 'session'; id: string; projectId: string; draft: string };

/**
 * The sidebar's pending delete confirmation. One value rather than a pair of
 * nullable states, so a project dialog and a session dialog cannot both be
 * open — they are portalled at the same z-index and would stack. The project
 * variant carries the session count the dialog warns with.
 */
export type PendingSidebarDeletion =
  | { kind: 'project'; project: Project; sessionCount: number }
  | { kind: 'session'; sessionId: string; sessionTitle: string; isArchived: boolean };

/** Whether a TaskMaster MCP server is present and configured for a project, or null while that status is still unknown. */
export type MCPServerStatus = {
  hasMCPServer?: boolean;
  isConfigured?: boolean;
} | null;

// Retained as `name` for backwards compatibility with existing settings
// consumers; the value is populated from `projectId` by normalizeProjectForSettings.
export type SettingsProject = {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
};

// ---------------------------

//----------------- SIDEBAR SEARCH ------------

/** Full result set of a conversation search, combining per-project message matches, session-title matches, the total match count and the query that produced them. */
export type ConversationSearchResults = {
  results: ConversationProjectResult[];
  titleResults: SessionTitleSearchResult[];
  totalMatches: number;
  query: string;
};

/** Progress of an in-flight conversation search, reported as the number of projects scanned out of the total so the UI can show how far the scan has got. */
export type SearchProgress = {
  scannedProjects: number;
  totalProjects: number;
};

/** One session whose title matched a conversation search, carrying enough project and session identity to open that session directly. */
export type SessionTitleSearchResult = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
};

/** All conversation matches found inside a single project during a search, grouped so the results can be rendered under one project heading. */
export type ConversationProjectResult = {
  // Emitted by the provider search service so the sidebar can map a
  // match back to the Project in its current state by projectId.
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: ConversationSession[];
};

/** One session within a ConversationProjectResult, pairing the session's summary with the individual message matches found in it. */
type ConversationSession = {
  sessionId: string;
  sessionSummary: string;
  provider?: string;
  matches: ConversationMatch[];
};

/** A single matching message from a conversation search, holding the author role, the surrounding snippet and the ranges to highlight inside that snippet. */
type ConversationMatch = {
  role: string;
  snippet: string;
  highlights: SnippetHighlight[];
  timestamp: string | null;
  provider?: string;
  messageUuid?: string | null;
};

/** A start/end character range within a search-result snippet that should be visually marked as the matched text. */
type SnippetHighlight = {
  start: number;
  end: number;
};

// ---------------------------

//----------------- PROVIDER SKILLS ------------

/** The LLM provider whose skills are being listed, uploaded or deleted; use it to target the provider-specific skills endpoints. */
export type SkillsProvider = LLMProvider;

/** Where a skill was discovered - the user's home directory, a project, a plugin, the repository, an admin location, or the built-in system set - used to group, order and label skills and to decide whether one can be deleted. */
export type SkillsScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/** A project workspace whose skills can be listed or added to, identified by `projectId` with optional display name and path; passed into the skills settings UI as the list of selectable project scopes. */
export type SkillsProject = {
  projectId: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

/** One skill available to a provider, carrying its slash command, description, originating scope and source path plus the owning plugin or project when it came from one. */
export type ProviderSkill = {
  provider: SkillsProvider;
  name: string;
  description: string;
  command: string;
  scope: SkillsScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
  projectDisplayName?: string;
  projectPath?: string;
};

/** One skill to upload, holding its SKILL.md content, the directory and file names to write it under, and any accompanying base64-encoded support files. */
export type ProviderSkillCreateEntryPayload = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: Array<{
    relativePath: string;
    content: string;
    encoding: 'base64';
  }>;
};

// ---------------------------

//----------------- TASK MASTER ------------

/** Identifier of a TaskMaster task or subtask, which TaskMaster may emit as either a number or a string. */
export type TaskId = string | number;

/** One task as returned by TaskMaster, including its status, priority, dependencies, implementation details and nested subtasks. */
export type TaskMasterTask = {
  id: TaskId;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  details?: string;
  testStrategy?: string;
  parentId?: TaskId;
  dependencies?: TaskId[];
  subtasks?: TaskMasterTask[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

/** A minimal pointer to a task, used by callbacks that only need its id and title rather than the full task record. */
export type TaskReference = {
  id: TaskId;
  title?: string;
  [key: string]: unknown;
};

/** A task handed to a click handler, which may be either a complete TaskMasterTask or a lightweight TaskReference. */
export type TaskSelection = TaskMasterTask | TaskReference;

/** A product-requirements document in a project's TaskMaster directory, used both for listing PRDs and for editing their content. */
export type PrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  modified?: string;
  created?: string;
  path?: string;
  size?: number;
  [key: string]: unknown;
};

/** The TaskMaster section of a project record, describing whether the project has been initialised and the status metadata TaskMaster reports for it. */
export type TaskMasterProjectInfo = {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/** A Project augmented with the flattened TaskMaster fields (configured flag, status and task counts) that the task board and its callers read directly. */
export type TaskMasterProject = Project & {
  taskMasterConfigured?: boolean;
  taskMasterStatus?: string;
  taskCount?: number;
  completedCount?: number;
  taskmaster?: TaskMasterProjectInfo;
};




/** The layout the task board is currently rendering: kanban columns, a flat list, or a grid. */
export type TaskBoardView = 'kanban' | 'list' | 'grid';

/** The task field the board is currently sorted by. */
export type TaskBoardSortField = 'id' | 'title' | 'status' | 'priority' | 'updated';

/** The direction of the task board's current sort, ascending or descending. */
export type TaskBoardSortOrder = 'asc' | 'desc';

/** One column of the kanban board, pairing its status and display colours with the tasks that belong to it. */
export type TaskKanbanColumn = {
  id: string;
  title: string;
  status: string;
  color: string;
  headerColor: string;
  tasks: TaskMasterTask[];
};

/** A TaskMaster task's lifecycle state; the known values are enumerated and the string fallback tolerates statuses added by newer TaskMaster releases. */
type TaskStatus =
  | 'pending'
  | 'in-progress'
  | 'done'
  | 'review'
  | 'blocked'
  | 'deferred'
  | 'cancelled'
  | string;

/** A TaskMaster task's priority; high, medium and low are the known values and the string fallback tolerates anything else TaskMaster emits. */
type TaskPriority = 'high' | 'medium' | 'low' | string;

//----------------- CONVERSATION GROUPS ------------

/** Personal organization metadata; a group never changes a session's working folder. */
export type ConversationGroup = {
  isPinned: boolean;
  id: string;
  name: string;
  sessionCount: number;
};

export type ConversationGroupsSnapshot = {
  groups: ConversationGroup[];
  memberships: Record<string, string>;
};

export type GroupConversation = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
  isArchived: boolean;
};

export type GroupConversationsPage = {
  conversations: GroupConversation[];
  total: number;
  hasMore: boolean;
};

export type CreatedGroupConversation = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  projectId: string;
  sessionName: string;
};

//----------------- TRANSCRIPT REVEAL ------------
/** Exact tool-record destination; requestId makes repeated jumps reopen collapsed content. */
export type MessageRevealTarget = {
  messageKey: string;
  toolId?: string;
  requestId: number;
};

// ---------------------------
//----------------- RECORDED CONVERSATION CHANGES ------------

/** Completed edit recorded by a chat tool, used by the change summary and its exact transcript jump. */
export type ConversationFileChange = {
  id: string;
  filePath: string;
  operation: 'edit' | 'write' | 'patch' | 'delete';
  oldContent?: string;
  newContent?: string;
  patch?: string;
  /** A replacement may have affected an unknown number of occurrences; its fragments cannot prove line totals. */
  lineCountUnavailable?: boolean;
  sourceMessageKey: string;
  sourceToolId?: string;
  timestamp: ChatMessage['timestamp'];
  contextLabel?: string;
};

/** Real user turn and its recorded changes; empty turns remain visible instead of inheriting earlier edits. */
export type ConversationChangeTurn = {
  id: string;
  label: string;
  timestamp: ChatMessage['timestamp'];
  changes: ConversationFileChange[];
};

export type GroupDragSource = { groupId: string; sessionId: string };
export type GroupDropTarget = GroupDragSource & { position: 'before' | 'after' };
export type GroupDragPoint = { x: number; y: number };

//----------------- REMOTE HUB ------------

/** An SSH tunnel registered in the local hub. */
export type HubRemote = {
  id: string;
  name: string;
  port: number;
};
/** A project returned by its owning remote. */
export type HubProject = {
  projectId: string;
  displayName: string;
  fullPath: string;
  sessions?: Array<{
    id: string;
    summary?: string;
    __provider?: string;
  }>;
  sessionMeta?: {
    total?: number;
    hasMore?: boolean;
  };
};
/** A conversation identity scoped to a machine. */
export type HubConversation = {
  remoteId: string;
  sessionId: string;
  title: string;
  projectId: string;
  projectPath: string;
  provider: string;
  lastActivity?: string | null;
  isArchived?: boolean;
};
/** A local group whose members can belong to different machines. */
export type HubGroup = {
  id: string;
  name: string;
  isPinned: boolean;
  members: HubConversation[];
};
/** Versioned group metadata for conflict-safe multiwindow updates. */
export type HubGroupState = {
  revision: number;
  groups: HubGroup[];
  imported: string[];
};
/** A remote-bound row mutation shown by the Hub conversation dialog. */
export type HubConversationAction = { kind: 'fork' | 'delete' | 'rename'; member: HubConversation; groupId?: string };

/** User action shown in the unified Hub group or new-conversation dialog. */
export type HubDialogState = {
  kind: 'group';
  group?: HubGroup;
} | {
  kind: 'remove';
  group: HubGroup;
} | {
  kind: 'assign';
  member: HubConversation;
} | {
  kind: 'new';
  groupId?: string;
  remoteId?: string;
  projectId?: string;
};

/** Existing directories reported by a selected remote, with its canonical current path. */
export type HubDirectoryListing = { path: string; suggestions: FolderSuggestion[] };

/** Independent connection and session snapshot for one machine. */
export type HubRemoteState = {
  status: 'loading' | 'online' | 'offline' | 'login';
  projects: HubProject[];
  conversations: HubConversation[];
  total: number;
  running: string[];
  error?: string;
  /** Unread completion, failure, or permission notices for this remote only. */
  attention: string[];
};

//----------------- LOCAL CHAT BACKUPS ------------

/** Portable native conversation archive; imported paths are relative archive entries, never destination paths. */
export type ChatBackupBundle = {
  format: 'cloudcli-chat-backup';
  version: 1;
  createdAt: string;
  session: {
    id: string;
    provider: 'claude' | 'codex';
    title: string;
    projectPath: string;
    providerSessionId: string;
    model: string | null;
    effort: string | null;
  };
  files: Array<{ path: string; content: string }>;
};


/** Chooses whether automatic content sync follows Hub group membership or every conversation. */
export type ChatBackupScope = 'grouped' | 'all';

/** Read-only remote inventory metadata. Runtime status is an observation, never a request to restart work. */
export type ChatBackupSessionSnapshot = {
  sessionId: string;
  provider: LLMProvider;
  title: string;
  projectId: string | null;
  projectPath: string | null;
  model: string | null;
  effort: string | null;
  isArchived: boolean;
  updatedAt: string | null;
  history: 'native' | 'empty' | 'unsupported' | 'unavailable';
  contentVersion: string | null;
  runtimeStatus: 'running' | 'idle';
};

/** A stable inventory page, or one complete explicit-ID batch; absent IDs are reported separately. */
export type ChatBackupInventoryPage = {
  sessions: ChatBackupSessionSnapshot[];
  nextCursor: string | null;
  missingSessionIds: string[];
};

/** A Hub-scoped observation retained independently of transcript writes, including empty conversations. */
export type ChatBackupObservation = ChatBackupSessionSnapshot & {
  remoteId: string;
  remoteName: string;
  observedAt: string;
  attention: boolean | null;
};

/** Portable Hub organization record. Array order is significant; source identities are never destination IDs. */
export type ChatBackupGroupSnapshot = {
  format: 'cloudcli-chat-groups';
  version: 1;
  sourceId: string;
  capturedAt: string;
  revision: number;
  groups: Array<{
    id: string;
    name: string;
    isPinned: boolean;
    members: Array<{ remoteId: string; sessionId: string }>;
  }>;
  observations: ChatBackupObservation[];
};

/** A portable single-chat export with the companion group record needed to restore its original placement. */
export type LocalChatBackupExport = {
  format: 'cloudcli-local-chat-backup';
  version: 1;
  sourceRemoteId: string;
  bundle: ChatBackupBundle;
  groups: ChatBackupGroupSnapshot | null;
};


/** Local archive inventory entry used by the Hub sync worker and backup dialog without loading chat contents. */
export type LocalChatBackupSummary = {
  id: string;
  remoteId: string;
  remoteName: string;
  sessionId: string;
  title: string;
  provider: 'claude' | 'codex';
  projectPath: string;
  savedAt: string;
  sourceUpdatedAt: string | null;
  bytes: number;
  /** Native content watermark; absence in older archives requires a fresh content read. */
  contentVersion?: string | null;
};

/** This Hub computer's opt-in switch and disk inventory; remote user settings never enable it. */
export type LocalChatBackupStatus = {
  enabled: boolean;
  scope: ChatBackupScope;
  settingsRevision: number;
  sourceId: string | null;
  snapshots: ChatBackupGroupSnapshot[];
  directory: string;
  backups: LocalChatBackupSummary[];
  warnings?: string[];
};

/** Independent destination session created when restoring a native chat archive. */
export type RestoredChatBackup = {
  sessionId: string;
  provider: 'claude' | 'codex';
  projectPath: string;
  sessionName: string;
};

// ---------------------------
//----------------- CLAUDE SESSION ACTIONS ------------

/** The context and/or checkpoint scope requested by the user. */
export type RewindMode = 'conversation' | 'files' | 'both';
/** Remote-verified actions and native message boundaries for a Claude session. */
export type ClaudeSessionCapabilities = {
  /** Current remote native context identity; the app session ID may survive a rewind. */
  providerSessionId?: string;
  sideChat: boolean;
  sideChatWhileRunning?: boolean;
  conversationRewind: boolean;
  fileRewind: 'preview-required';
  isBusy: boolean;
  messageIds: string[];
  userMessageIds: string[];
  relationship: { parentSessionId: string; sourceMessageId: string | null; kind: 'side_chat' | 'rewind_backup' } | null;
  fileScope: string;
  conversationBoundary: 'includes-selected-message';
};

/** A remote fork with independent context and a shared project folder. */
export type ForkedClaudeSession = {
  sessionId: string;
  parentSessionId: string;
  provider: 'claude';
  projectId: string;
  projectPath: string;
  sessionName: string;
  sharesProjectFiles: boolean;
  inheritedFileCheckpoints: boolean;
};

/** An expiring preview required before restoring context or checkpointed files. */
export type RewindPreview = {
  previewToken: string;
  expiresAt: number;
  messageId: string;
  mode: RewindMode;
  canRewind: boolean;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  error: string | null;
  fileScope: string;
  conversationBoundary: 'includes-selected-message';
};

/** The authoritative context revision after a remote rewind. */
export type RewindResult = {
  sessionId: string;
  provider: 'claude';
  projectId: string;
  projectPath: string;
  sessionName: string;
  mode: RewindMode;
  contextChanged: boolean;
  contextRevision: string;
  backupSessionId: string | null;
  /** Present on updated remotes so pending input stays bound to its original native context. */
  previousProviderSessionId?: string;
  providerSessionId?: string;
};

/** Synchronous local rewind lifecycle used to freeze and quarantine context-bound pending input before history refresh. */
export type ClaudeSessionMutationEvent = {
  sessionId: string;
  requestId: string;
  messageId: string;
  mode: RewindMode;
  phase: 'started' | 'committed' | 'failed';
  result?: RewindResult;
  /** Failure may mean transport uncertainty; it is never proof that a pending input was not consumed. */
  error?: string;
};


//----------------- MERMAID VIEWPORT ------------

/** Measured diagram or viewport dimensions. */
export type DiagramSize = { width: number; height: number };
/** A pointer or viewport offset. */
export type DiagramPoint = { x: number; y: number };
/** Diagram translation and scale in the zoom viewer. */
export type DiagramTransform = DiagramPoint & { scale: number };

//----------------- CLAUDE USAGE ACCOUNTING ------------
/** Non-overlapping billed token buckets. Thinking is an optional subset of output and must never be added to the total. */
export type ClaudeUsageBuckets = {
  inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; thinkingTokens?: number;
};
/** SDK-reported model consumption. Missing or unknown pricing stays null; costs are estimates, never invoices. */
export type ClaudeUsageModelCounters = ClaudeUsageBuckets & {
  estimatedCostUsd: number | null; costBasis: 'list' | 'managed' | 'unknown'; contextWindow?: number; canonicalModel?: string;
};
/** Latest main sampling window, distinct from cumulative billed work. Capacity is SDK-observed, not inferred from an alias. */
export type ClaudeUsageContext = {
  usedTokens: number | null; model: string | null; capacityTokens: number | null; compactionWindowTokens: number | null;
  measurement: 'last-request' | 'sdk-local-estimate' | 'post-compact' | 'unavailable'; observedAt: string;
};
/** Consumption of a turn. The public snapshot aggregates the whole user-started execution, including Workflow follow-ups; the internal reducer also uses this shape for result deltas. Request-only coverage is explicitly partial. */
export type ClaudeUsageTurn = {
  id: string; status: 'running' | 'complete' | 'error' | 'interrupted'; models: Record<string, ClaudeUsageModelCounters>;
  estimatedCostUsd: number | null; coverage: 'sdk-query-pipeline' | 'observed-requests';
  userMessageCount?: number;
};
/** Shared REST/history/live snapshot. Revision is durable and monotonic per stable app session on one remote. */
export type ClaudeUsageSnapshot = {
  schemaVersion: 2; provider: 'claude'; sessionId: string; nativeContextId: string | null; revision: number; updatedAt: string;
  context: ClaudeUsageContext; turn: (ClaudeUsageTurn & { executionId: string }) | null;
  session: { models: Record<string, ClaudeUsageModelCounters>; tokens: ClaudeUsageBuckets; estimatedCostUsd: number | null;
    knownEstimatedCostUsd: number; provisional: boolean; historicalCoverage: 'observed-requests' | 'new-session' | 'inherited-context';
    warnings: string[]; };
};

// ---------------------------

//----------------- RIGHT WORKSPACE PANELS ------------

/** Browser-wide display choice shared by toolbars and Appearance settings across retained remote frames. */
export type WorkspaceToolTabAppearance = 'icons' | 'icons-and-text';

/** A retained workspace view shown beside the primary conversation. */
export type WorkspacePanelTab = Exclude<AppTab, 'chat'> | 'agents' | 'sideChat' | 'preferences' | `btw:${string}`;

/** An ephemeral BTW tab stays bound to the Claude conversation that created it. */
export type WorkspaceBtwTab = { id: `btw:${string}`; sessionId: string; sourceLabel: string; label: string };

/** One completed ephemeral BTW exchange, passed only as context for that tab's next side question. */
export type ClaudeBtwHistoryTurn = { question: string; response: string };

/** The normalized agents in the viewed conversation and callbacks back to that conversation. */
export type WorkspaceAgentsSnapshot = {
  records?: NormalizedMessage[];
  activity?: SessionActivity | null;
  sessionId: string | null;
  project: Project | null;
  messages: ChatMessage[];
  hasEarlierMessages: boolean;
  isLoadingEarlierMessages: boolean;
  loadEarlierMessages: () => void;
  historyError?: string | null;
  revealOrigin: (messageKey: string) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
};

/** An explicit request to inspect an agent or one recorded tool in its timeline. */
export type WorkspaceAgentReveal = { messageKey: string; toolId?: string; requestId: number };

//----------------- CLAUDE EXECUTION SETTINGS ------------
/** Next-launch choices shared by remote Chat and the bound Claude terminal; revision prevents stale updates. */
export type ClaudeSessionSettings = { model: string; effort: string; ultracode: boolean; revision: string };
/** Explicit server binding for a terminal; never reconstructed from the currently selected sidebar conversation. */
export type ShellExecutionBinding = { executionId: string; appSessionId: string; providerSessionId: string | null; projectPath: string; surface: 'shell' };
/** Requested versus reported settings from one execution, independent of next-launch choices. */
export type ClaudeSessionExecutionSnapshot = {
  sessionId: string; providerSessionId: string | null; projectPath: string; next: ClaudeSessionSettings;
  execution: null | { executionId: string; appSessionId: string; providerSessionId: string | null; surface: 'chat'|'shell'; isLive?: boolean; requested: ClaudeSessionSettings; permissionRequest?: { mode: string; allowedRuleCount: number; deniedRuleCount: number }; status: string; startedAt: string; endedAt: string | null; observed: { model?: string; effort?: string | null; ultracode?: boolean; permissionMode?: string; source?: string; observedAt?: string } };
};
// ---------------------------

//----------------- RETAINED TERMINAL CONTROLS ------------

/** Registers an explicit PTY termination action with the owning retained workspace terminal. */
export type ShellTerminationRegistrar = (terminate: (() => Promise<boolean>) | null) => void;

// ---------------------------

//----------------- EMBEDDED WORKSPACE NAVIGATION ------------

/** Actual views available in one remote app, mirrored by its owning Hub header for this selected session. */
export type WorkspaceNavigationState = {
  sessionId: string | null;
  activeTab: AppTab | WorkspacePanelTab;
  tabs: Array<{ id: AppTab | WorkspacePanelTab; label: string }>;
};


//----------------- CLAUDE TERMINAL PERMISSIONS ------------
/** Explicit saved Chat permission selection to carry into one native terminal launch.
 * One-time approval answers are deliberately absent and never reused. */
export type ClaudeShellPermissionSelection = {
  permissionMode: PermissionMode;
  toolsSettings: Pick<ClaudeSettings, 'allowedTools' | 'disallowedTools' | 'skipPermissions'>;
};
// ---------------------------

/** Explicitly reported names and IDs; CloudCLI’s preserved name can differ from Claude’s titles. */
export type ClaudeSessionIdentity = {
  sessionId: string; providerSessionId: string | null; projectPath: string | null;
  cloudcliName: string | null; automaticTitle: string | null; renamedTitle: string | null;
  titleCoverage: 'complete' | 'recent' | 'unavailable';
};

//----------------- SCROLL POSITION RESTORATION ------------

/** Keeps a visible transcript row at its viewport offset across history and lazy-row commits. */
export type ScrollRestoreState = {
  height: number;
  top: number;
  anchor: HTMLElement | null;
  anchorOffset: number | null;
};

// ---------------------------
