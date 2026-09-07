/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - SDK-managed remote Claude Code processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { claudeSettingsFlags, resolveClaudeExecutionSettings } from '@/modules/providers/services/claude-execution-settings.js';
import { claudeExecutionRecords } from '@/modules/providers/services/claude-execution-records.js';
import { shellConfigurationObservation } from '@/modules/providers/services/claude-shell-observer.js';
import { claudeUsageService } from '@/modules/claude-usage/index.js';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AnyRecord, IProviderRuntime, ProviderModelsDefinition, ProviderPermissionDecision, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';
import { createClaudeTextStream } from '@/modules/providers/list/claude/claude-text-stream.js';
import { createClaudeInputQueue } from '@/modules/providers/list/claude/claude-input-queue.js';
import { createClaudeBackgroundWorkTracker } from '@/modules/providers/list/claude/claude-background-work.js';
import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors,
  resolveClaudeCodeExecutablePath,
  createCompleteMessage,
  createNormalizedMessage,
  resolveClaudePermissionSelection
} from '@/shared/index.js';
import {
  CLAUDE_PREDEFINED_MODELS
} from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';

import { rememberClaudeSupportedModels } from './claude-model-catalog.js';
import { claudeCommandCatalog } from './claude-command-catalog.js';

type ActiveSession = {
  instance: Query;
  startTime: number;
  status: 'active' | 'aborted';
  writer: ProviderRuntimeWriter | null;
  releaseInput: (() => void) | null;
  enqueue?: (command: string, options: AnyRecord) => Promise<boolean>;
};
type ApprovalDecision = Partial<ProviderPermissionDecision> & { cancelled?: boolean };
type ApprovalMetadata = {
  _sessionId?: string | null;
  _toolName?: string;
  _input?: unknown;
  _context?: unknown;
  _receivedAt?: Date;
};
type ApprovalResolver = ((decision: ApprovalDecision | null) => void) & ApprovalMetadata;
type RuntimeDependencies = {
  query: typeof query;
  loadMcpConfig: typeof loadMcpConfig;
  waitCeilingMs: number;
  usage: typeof claudeUsageService | null;
};

const activeSessions = new Map<string, ActiveSession>();
const startingSessions = new Set<string>();
const pendingToolApprovals = new Map<string, ApprovalResolver>();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set<string>();
const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS || '', 10) || 55000;

// Grace period for legacy background tools without explicit task lifetimes.
// A known Workflow keeps stdin open until native completion or the user's explicit stop.
// The native CLI also receives this ceiling for its own post-EOF agent cleanup.
const BG_WAIT_CEILING_MS = 30 * 60 * 1000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId: string, options: {
  timeoutMs?: number;
  signal?: AbortSignal;
  onCancel?: (reason: string) => void;
  metadata?: ApprovalMetadata;
} = {}): Promise<ApprovalDecision | null> {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise<ApprovalDecision | null>(resolve => {
    let settled = false;

    const finalize = (decision: ApprovalDecision | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver: ApprovalResolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId: string, decision: ProviderPermissionDecision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry: string, toolName: string, input: unknown) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && 'command' in input && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/** Used by Claude runtime setup and provider tests to validate per-invocation SDK options. */
export function mapCliOptionsToSDK(options: AnyRecord = {}): Options {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions: Options = {};
  sdkOptions.includePartialMessages = true;
  sdkOptions.forwardSubagentText = true;
  sdkOptions.enableFileCheckpointing = true;
  sdkOptions.extraArgs = { 'replay-user-messages': null };

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS) };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  const permissionSelection = resolveClaudePermissionSelection({ permissionMode, toolsSettings });
  sdkOptions.permissionMode = permissionSelection.mode;
  sdkOptions.allowedTools = permissionSelection.allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = permissionSelection.disallowedTools;

  const requestedModel = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;
  // Omit the override so the remote CLI can resolve its own environment/settings.
  if (requestedModel !== 'default') sdkOptions.model = requestedModel;

  if (effort !== undefined) {
    Object.assign(sdkOptions, claudeSettingsFlags(resolveClaudeExecutionSettings(
      { model: requestedModel, effort }, options.effortModels || CLAUDE_PREDEFINED_MODELS,
    )));
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 */
function addSession(sessionId: string, queryInstance: Query, writer: ProviderRuntimeWriter | null = null, releaseInput: (() => void) | null = null) {
  const existing = activeSessions.get(sessionId);
  if (existing?.status === 'active' && existing.instance !== queryInstance) {
    throw new Error('Claude already owns this session. Its running process must not be replaced.');
  }
  const carried = existing;
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands; keep the closer.
    releaseInput: releaseInput || carried?.releaseInput || null,
    enqueue: carried?.enqueue
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId: string) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId: string) {
  return activeSessions.get(sessionId);
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage: AnyRecord) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * Used by runtime output and provider tests to hide duplicated subagent prompt echoes.
 * The Agent tool already displays these prompts; the main transcript does not retain them.
 */
export function isSubagentPromptEcho(message: AnyRecord) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage: AnyRecord) {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW || '', 10) || 160000;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Used by the runtime and provider tests to extract the session's context-window usage.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
export function extractTokenBudget(sdkMessage: AnyRecord) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent usage describes its own context window, not the main session.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage);
}

/**
 * Used by the runtime and provider tests as a last-resort budget from a turn's `result`.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
export function extractCumulativeTokenBudget(sdkMessage: AnyRecord) {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW || '', 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command: string, images: unknown, files: unknown, cwd?: string): Promise<SDKUserMessage[]> {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content: content as SDKUserMessage['message']['content']
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd?: string): Promise<Record<string, McpServerConfig> | null> {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error instanceof Error ? error.message : String(error));
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command: string, options: AnyRecord, ws: ProviderRuntimeWriter, context: ProviderRuntimeContext, dependencies: RuntimeDependencies) {
  const { sessionId, sessionSummary } = options;
  const executionId = options.executionId || crypto.randomUUID();
  const initialMessageId = options.clientMessageId || crypto.randomUUID();
  let usageRun: Awaited<ReturnType<typeof claudeUsageService.beginRun>> | null = null;
  const publishUsage = (snapshot: unknown) => {
    if (snapshot) ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: snapshot, sessionId: sessionId || capturedSessionId || null, provider: 'claude' }));
  };
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = options.resumeFromScratch ? null : providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event: AnyRecord) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream = () => {};
  let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  // Runtime completion is separate from each foreground reply.
  let turnCompleteSent = false;
  let lastResultFailed = false;
  const backgroundWork = createClaudeBackgroundWorkTracker();
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;

  if (sessionKey() && getSession(sessionKey()!)?.status === 'active') throw new Error('Claude already owns this session. Send through its existing input stream.');
  let foreground = true;
  let streamStarted = false;
  let streamGeneration = 0;
  let commandCatalogGeneration = 0;
  const pendingUsageSummaries = new Set<Promise<void>>();
  const inputQueue = createClaudeInputQueue((entry, error) => {
    ws.send(createNormalizedMessage({ kind: 'status', text: 'message_delivery', provider: 'claude', sessionId: sessionKey(),
      clientMessageId: entry.id, transcriptAnchorId: entry.delivery === 'delivered' ? entry.id : undefined,
      delivery: entry.delivery, content: entry.command, images: entry.images, files: entry.files, timestamp: entry.timestamp, executionId, ...(error ? { error } : {}) }));
  });
  releasePromptStream = inputQueue.release;
  const emitRuntimeState = () => ws.send(createNormalizedMessage({ kind: 'status', text: 'claude_runtime_state', provider: 'claude', sessionId: sessionKey(),
    phase: foreground ? 'foreground' : 'background', acceptsInput: streamStarted && inputQueue.isOpen(), backgroundTasks: backgroundWork.pendingCount(), executionId }));
  const enqueueInput = async (command: string, next: AnyRecord): Promise<boolean> => {
    if (!streamStarted || !inputQueue.isOpen()) return false;
    claudeCommandCatalog.assertAllowed(command, capturedSessionId);
    if (next.cwd && path.resolve(next.cwd) !== path.resolve(options.cwd)) throw new Error('The queued message must use this Claude process’s project folder.');
    if (typeof next.clientMessageId !== 'string') throw new Error('A message identifier is required for the existing input stream.');
    const slot = inputQueue.begin(next.clientMessageId, command, false, { images: next.images, files: next.files });
    if (!slot) return true;
    if (idleReleaseTimer) { clearTimeout(idleReleaseTimer); idleReleaseTimer = null; }
    try {
      const messages = await buildPromptMessages(command, next.images, next.files, options.cwd);
      slot.commit(messages);
      publishUsage(usageRun?.noteUserMessage?.(next.clientMessageId));
      emitRuntimeState();
      return true;
    } catch (error) { slot.fail(error instanceof Error ? error.message : String(error)); throw error; }
  };
  const registerInput = () => {
    if (!sessionKey() || !queryInstance) return;
    addSession(sessionKey()!, queryInstance, ws, releasePromptStream);
    getSession(sessionKey()!)!.enqueue = enqueueInput;
  };

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      // An active Workflow or a submitted message is not an idle process. Never kill either to free the composer.
      if (backgroundWork.hasPendingWorkflow() || inputQueue.hasPending() || foreground) return;
      releasePromptStream();
      emitRuntimeState();
    }, dependencies.waitCeilingMs);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer.unref?.();
  };

  // Cleanup removes only the entry owned by this query.
  let queryInstance: Query | null = null;
  let executionRecorded = false;
  const textStream = createClaudeTextStream((message, sid) => context.normalizeMessage(transformMessage(message as AnyRecord), sid));

  try {
    claudeCommandCatalog.assertAllowed(command, capturedSessionId);
    if ('expectedProviderSessionId' in options && options.expectedProviderSessionId !== providerSessionId) throw new Error('The conversation changed before Claude started. Retry using its current state.');
    if (options.executionSettings && sessionId) {
      const permissionSelection = resolveClaudePermissionSelection(options);
      claudeExecutionRecords.begin({ executionId, appSessionId: sessionId, providerSessionId: capturedSessionId || null,
        surface: 'chat', projectPath: options.cwd, requested: options.executionSettings,
        permissionRequest: { mode: permissionSelection.mode, allowedRuleCount: permissionSelection.allowedTools.length, deniedRuleCount: permissionSelection.disallowedTools.length },
        startedAt: new Date().toISOString(), endedAt: null, status: 'running', observed: {} });
      executionRecorded = true;
    }
    if (dependencies.usage && sessionId) {
      usageRun = await dependencies.usage.beginRun({ sessionId, executionId, providerSessionId: capturedSessionId || null });
      publishUsage(usageRun.noteUserMessage?.(initialMessageId));
      publishUsage(usageRun.snapshot());
    }
    const resolvedModel = options.executionSettings?.model ?? await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await dependencies.loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // One continuous input stream belongs to this native process, including follow-up messages.
    const initialSlot = inputQueue.begin(initialMessageId, command, true, { images: options.images, files: options.files })!;
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);
    initialSlot.commit(promptMessages);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = 'message' in input && typeof input.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification((createNotificationEvent as unknown as (input: AnyRecord) => AnyRecord)({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    if (executionRecorded) {
      const observeHook = async (input: Record<string, unknown>) => {
        if (input.agent_id || input.parent_tool_use_id) return {};
        const observation = shellConfigurationObservation(input);
        if (observation) claudeExecutionRecords.observe(executionId, { ...observation, source: 'chat-hook' });
        return {};
      };
      sdkOptions.hooks.SessionStart = [{ hooks: [observeHook] }];
      sdkOptions.hooks.PostModelSwitch = [{ hooks: [observeHook] }];
      sdkOptions.hooks.PostToolUse = [{ hooks: [observeHook] }];
      sdkOptions.hooks.Stop = [{ hooks: [observeHook] }];
    }

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification((createNotificationEvent as unknown as (input: AnyRecord) => AnyRecord)({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          sdkOptions.allowedTools ??= [];
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput && typeof decision.updatedInput === 'object' ? decision.updatedInput as Record<string, unknown> : input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    queryInstance = dependencies.query({ prompt: inputQueue.stream, options: sdkOptions });
    streamStarted = true;
    registerInput();
    emitRuntimeState();

    // Read metadata only from the query the user already requested.
    if (typeof queryInstance.supportedModels === 'function') {
      void queryInstance.supportedModels().then(rememberClaudeSupportedModels).catch(() => {});
    }

    // Command discovery is metadata on this same query, never a discovery prompt.
    if (typeof queryInstance.supportedCommands === 'function') {
      const generation = commandCatalogGeneration;
      const commandQuery = queryInstance;
      void Promise.resolve().then(() => commandQuery.supportedCommands()).then(commands => {
        if (generation === commandCatalogGeneration && getSession(sessionKey()!)?.instance === commandQuery && sessionKey()) {
          claudeCommandCatalog.remember(sessionKey()!, capturedSessionId, options.cwd || '', commands);
          ws.send(createNormalizedMessage({ kind: 'status', text: 'native_commands_changed', sessionId: sessionKey(), provider: 'claude' }));
        }
      }).catch(() => {});
    }

    // Metadata comes only from the query the user already requested. It does
    // not generate a prompt. Guard its response against intervening config changes.
    const refreshAppliedSettings = async () => {
      const settingsQuery = queryInstance as Query & { getSettings?: () => Promise<unknown> };
      if (!executionRecorded || typeof settingsQuery?.getSettings !== 'function') return;
      const expected = claudeExecutionRecords.get(executionId)?.observed || {};
      const generation = streamGeneration;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          settingsQuery.getSettings(),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1500); timer.unref?.(); }),
        ]);
        const applied = (result as { applied?: Record<string, unknown> } | null)?.applied;
        if (!applied || streamGeneration !== generation || getSession(sessionKey()!)?.instance !== queryInstance) return;
        const observed: { effort?: string | null; ultracode?: boolean; source: string } = { source: 'runtime-applied-settings' };
        if (typeof applied.effort === 'string' || applied.effort === null) observed.effort = applied.effort;
        if (typeof applied.ultracode === 'boolean') observed.ultracode = applied.ultracode;
        if ('effort' in observed || 'ultracode' in observed) claudeExecutionRecords.observe(executionId, observed, expected);
      } catch { /* Older hosts leave effective settings unconfirmed. */ }
      finally { if (timer) clearTimeout(timer); }
    };

    // Track the query instance for abort capability
    if (sessionKey()) {
      registerInput();
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const sdkMessage of queryInstance) {
      // SDK messages are validated by the SDK; its newer additive event fields
      // are intentionally accepted here while the normalizer guards their shape.
      const message: AnyRecord = sdkMessage;
      // Scope only command metadata/compaction feedback; preserve the existing general stream behavior.
      if (message.type === 'system' && (message.subtype === 'commands_changed' || message.subtype === 'compact_boundary' || message.subtype === 'status' && (message.status === 'compacting' || message.compact_result))
        && message.session_id && capturedSessionId && message.session_id !== capturedSessionId && !message.parent_tool_use_id) continue;
      streamGeneration++;
      inputQueue.observe(message);
      if (!message.parent_tool_use_id && !message.isSidechain && (message.type === 'assistant' || message.type === 'stream_event' && message.event?.type === 'message_start')) {
        if (!foreground) { foreground = true; emitRuntimeState(); }
      }
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        registerInput();

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId!);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      if (!message.parent_tool_use_id && (!message.session_id || message.session_id === capturedSessionId)) {
        const commands = message.type === 'system' && message.subtype === 'init' ? message.slash_commands
          : message.type === 'system' && message.subtype === 'commands_changed' ? message.commands : undefined;
        if (Array.isArray(commands) && sessionKey()) {
          commandCatalogGeneration++;
          claudeCommandCatalog.remember(sessionKey()!, capturedSessionId, options.cwd || '', commands);
          ws.send(createNormalizedMessage({ kind: 'status', text: 'native_commands_changed', sessionId: sessionKey(), provider: 'claude' }));
        }
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      // Delivery receipts already render our submitted prompt (including its attachments).
      // Native user replay confirms delivery; forwarding it again would duplicate that bubble.
      const normalized = inputQueue.ownsUserEcho(message) ? [] : textStream.normalize(message, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        if (isSubagentPromptEcho(msg)) {
          continue;
        }
        ws.send(msg);
      }

      if (executionRecorded && !message.parent_tool_use_id && !message.isSidechain) {
        if (message.session_id) claudeExecutionRecords.bind(executionId, message.session_id);
        if (message.type === 'system' && message.subtype === 'init' && typeof message.permissionMode === 'string') {
          claudeExecutionRecords.observe(executionId, { permissionMode: message.permissionMode, source: 'initialization' });
        }
        const model = message.type === 'assistant' ? message.message?.model : message.type === 'system' && message.subtype === 'init' ? message.model : undefined;
        if (typeof model === 'string' && model && model !== '<synthetic>' && model !== 'synthetic') {
          claudeExecutionRecords.observe(executionId, { model, source: message.type === 'assistant' ? 'response' : 'initialization' });
        }
      }
      if (!message.parent_tool_use_id && !message.isSidechain && ((message.type === 'system' && message.subtype === 'init') || message.type === 'result')) void refreshAppliedSettings();
      if (usageRun) {
        if (capturedSessionId) usageRun.bindProviderSessionId(capturedSessionId);
        publishUsage(usageRun.observe(message));
        // Explicit summary mode uses the existing process's local estimate;
        // the SDK's default full report may invoke the token-count API.
        if (message.type === 'result' && typeof queryInstance.getContextUsage === 'function') {
          const currentUsage = usageRun;
          const revision = currentUsage.snapshot()?.revision;
          const generation = streamGeneration;
          let timer: ReturnType<typeof setTimeout> | undefined;
          // A slow optional control reply must never block subsequent text or task events.
          const summaryRequest = Promise.race([queryInstance.getContextUsage({ detail: 'summary' }), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); timer.unref?.(); })])
            .then(summary => { if (summary && streamGeneration === generation && currentUsage.snapshot()?.revision === revision && getSession(sessionKey()!)?.instance === queryInstance) publishUsage(currentUsage.observeContextSummary(summary)); })
            .catch(() => {}).finally(() => { if (timer) clearTimeout(timer); pendingUsageSummaries.delete(summaryRequest); });
          pendingUsageSummaries.add(summaryRequest);
        }
      } else {
        // Injected transports/legacy callers can report per-request context,
        // but a cumulative result bill is never a context-window fallback.
        const budget = extractTokenBudget(message);
        if (budget) publishUsage(budget);
      }

      const workflowProgress = backgroundWork.observe(message);
      if (workflowProgress) {
        emitRuntimeState();
        ws.send(createNormalizedMessage({
          kind: 'status', provider: 'claude', sessionId: sid, workflow: true,
          canInterrupt: true, ...workflowProgress,
        }));
      }

      if (message.type === 'result') {
        const nativeReports = inputQueue.commandsForResult(message).map(command => command.match(/^\/(compact|context|usage)(?:\s|$)/)?.[1]).filter(Boolean);
        if (message.session_id === capturedSessionId && !message.is_error && nativeReports.length && typeof message.result === 'string' && message.result.trim()) {
          ws.send(createNormalizedMessage({ kind: 'task_notification', status: 'info', provider: 'claude', sessionId: sid,
            id: `native-result-${message.uuid || message.user_message_uuid}`, summary: `Claude /${nativeReports.join(', /')}: ${message.result}` }));
        }
        lastResultFailed = message.is_error === true;
        const turn = backgroundWork.finishTurn(lastResultFailed);
        const abortPending = sessionKey() ? abortedSessionIds.has(sessionKey()!) : false;
        if (lastResultFailed && !abortPending) {
          const errors = Array.isArray(message.errors) ? message.errors.filter((error: unknown) => typeof error === 'string') : [];
          const errorContent = errors.join('\n') || (typeof message.result === 'string' ? message.result : '') || `Claude ended this turn with ${message.subtype || 'an error'}.`;
          ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: sid, provider: 'claude' }));
          notifyRunFailed({
            userId: ws.userId || null, provider: 'claude', sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary, error: errorContent,
          });
        }
        foreground = false;
        if (!abortPending) {
          // A foreground result does not end the native runtime or its Workflow.
          for (const msg of textStream.finish(sid)) ws.send(msg);
          emitRuntimeState();
          if (!lastResultFailed) ws.send(createNormalizedMessage({ kind: 'status', text: 'foreground_complete', provider: 'claude', sessionId: sid, executionId }));
          if (heldForBackgroundWork && !backgroundWork.hasPendingWorkflow() && !lastResultFailed) notifyBackgroundWorkCompleted({
            userId: ws.userId || null, provider: 'claude', sessionId: sessionKey(), sessionName: sessionSummary,
          });
        }
        if (!abortPending && (backgroundWork.hasPendingWorkflow() || inputQueue.hasPending() || turn.holdInput)) {
          heldForBackgroundWork = true;
          // Workflow lifetimes are explicit; silence is not permission to stop them.
          if (!backgroundWork.hasPendingWorkflow() && !inputQueue.hasPending()) scheduleRelease();
        } else {
          heldForBackgroundWork = false;
          releasePromptStream();
          emitRuntimeState();
        }
      } else if (idleReleaseTimer) {
        // Background activity after the turn — push the countdown back out.
        scheduleRelease();
      }
    }

    releasePromptStream();
    emitRuntimeState();
    // Finalize bounded metadata requests after all stream events have been forwarded.
    await Promise.allSettled(pendingUsageSummaries);

    // Remove only the process entry owned by this execution.
    if (sessionKey() && getSession(sessionKey()!)?.instance === queryInstance) {
      removeSession(sessionKey()!);
    }

    // Abort owns its terminal event; a normal native exit completes this runtime once.
    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()!) : false;
    if (!turnCompleteSent) {
      turnCompleteSent = true;
      const workflowInterrupted = !lastResultFailed && backgroundWork.hasPendingWorkflow();
      if (!wasAborted) {
        for (const msg of textStream.finish(capturedSessionId || sessionId || null)) ws.send(msg);
        if (workflowInterrupted) {
          const errorContent = 'Claude ended before the Workflow reported completion. Resume the conversation to inspect its state.';
          ws.send(createNormalizedMessage({
            kind: 'error', provider: 'claude', sessionId: capturedSessionId || sessionId || null,
            content: errorContent,
          }));
          notifyRunFailed({
            userId: ws.userId || null, provider: 'claude', sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary, error: errorContent,
          });
        }
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: lastResultFailed || workflowInterrupted ? 1 : 0 }));
      }
      if (wasAborted || (!workflowInterrupted && !lastResultFailed)) notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    lastResultFailed = true;
    releasePromptStream();
    emitRuntimeState();
    console.error('SDK query error:', error);

    // An error must not remove an entry owned by another execution.
    if (sessionKey() && getSession(sessionKey()!)?.instance === queryInstance) {
      removeSession(sessionKey()!);
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()!) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error instanceof Error ? error.message : String(error);

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    for (const msg of textStream.finish(capturedSessionId || sessionId || null)) ws.send(msg);
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    if (executionRecorded) claudeExecutionRecords.finish(executionId, lastResultFailed);
    publishUsage(usageRun?.finish());
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    releasePromptStream();
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId: string) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Release the held stdin stream; without this the CLI stays up for the rest
    // of the post-turn hold even though the user cancelled.
    session.releaseInput?.();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId: string) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/** Used by the Claude provider and provider tests to construct the SDK runtime with a replaceable model transport. */
export function createClaudeRuntime(overrides: Partial<RuntimeDependencies> = {}): IProviderRuntime {
  const dependencies: RuntimeDependencies = { query, loadMcpConfig, waitCeilingMs: BG_WAIT_CEILING_MS,
    // A test transport never opens an install database unless its fixture injects usage explicitly.
    usage: overrides.query ? null : claudeUsageService, ...overrides };
  return {
    run: async (command, options, writer, context) => {
      const key = options.sessionId || context.resolveProviderSessionId(options.sessionId);
      if (key && (startingSessions.has(key) || activeSessions.get(key)?.status === 'active')) {
        throw new Error('Claude already owns this session. Send through its existing input stream.');
      }
      if (key) startingSessions.add(key);
      try { await queryClaudeSDK(command, options, writer, context, dependencies); }
      finally { if (key) startingSessions.delete(key); }
    },
    enqueue: async (sessionId, command, options) => await getSession(sessionId)?.enqueue?.(command, options) ?? false,
    abort: abortClaudeSDKSession,
    permissions: { resolve: resolveToolApproval, listPending: getPendingApprovalsForSession },
  };
}

/** Used by ClaudeProvider to expose SDK execution through the provider runtime contract. */
export const claudeRuntime = createClaudeRuntime();

/** Used by session actions to reject rewinds while Claude still owns a live or background query. */
export function isClaudeSessionActive(sessionId: string): boolean {
  return startingSessions.has(sessionId) || activeSessions.get(sessionId)?.status === 'active';
}
