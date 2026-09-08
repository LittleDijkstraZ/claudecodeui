import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { readClaudeTaskNotification } from '@/modules/providers/list/claude/claude-task-notifications.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
  SubagentActivity,
  SubagentInfo,
} from '@/shared/types.js';
import { parseFilesInputTag } from '@/shared/image-attachments.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
import {
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  sliceTailPage,
  truncateSubagentActivity,
} from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';
import { claudeUsageService } from '@/modules/claude-usage/index.js';

const PROVIDER = 'claude';

/**
 * Upper bound on how much of a subagent's timeline is sent to the client. A
 * long-running agent can record hundreds of tool calls, and the transcript only
 * ever shows them behind a collapsed header, so shipping the whole history on
 * every load costs far more than it shows.
 */
const MAX_TRANSMITTED_SUBAGENT_ACTIVITIES = 200;

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: SubagentActivity[];
  subagent?: SubagentInfo;
  toolUseResult?: unknown;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
  };

type ClaudeHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

type ClaudeSubagentTranscript = {
  activity: SubagentActivity[];
  model?: string;
  /**
   * True when the transcript's last tool call never received a result, which
   * is the only evidence in the file that the agent stopped mid-flight.
   */
  endedMidToolCall: boolean;
};

/**
 * Flattens one subagent transcript into the shared activity timeline.
 *
 * Assistant prose and reasoning are kept alongside the tool calls so the
 * transcript can replay what the agent actually did rather than listing tool
 * names with no narrative.
 */
async function readClaudeSubagentTranscript(filePath: string): Promise<ClaudeSubagentTranscript> {
  const activity: SubagentActivity[] = [];
  const transcript: ClaudeSubagentTranscript = { activity, endedMidToolCall: false };
  const toolsById = new Map<string, SubagentActivity>();

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;
        const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;

        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          if (typeof entry.message.model === 'string') {
            transcript.model = entry.message.model;
          }

          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type === 'tool_use') {
              const tool: SubagentActivity = {
                kind: 'tool',
                toolId: String(part.id ?? ''),
                toolName: String(part.name ?? 'Tool'),
                toolInput: part.input,
                timestamp,
              };
              activity.push(tool);
              if (tool.toolId) {
                toolsById.set(tool.toolId, tool);
              }
              continue;
            }
            if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
              activity.push({ kind: 'text', content: part.text, timestamp });
              continue;
            }
            if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
              activity.push({ kind: 'thinking', content: part.thinking, timestamp });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = toolsById.get(String(part.tool_use_id ?? ''));
            if (!tool) {
              continue;
            }

            tool.toolResult = {
              content: typeof part.content === 'string'
                ? part.content
                : Array.isArray(part.content)
                  ? part.content
                    .map((contentPart: AnyRecord) => contentPart?.text || '')
                    .join('\n')
                  : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
            };
          }
        }
      } catch {
        // Skip malformed lines that can happen during concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }

  const lastActivity = activity[activity.length - 1];
  transcript.endedMidToolCall = lastActivity?.kind === 'tool' && !lastActivity.toolResult;

  return transcript;
}

type ClaudeSubagentMeta = {
  agentType?: string;
  description?: string;
};

/** Reads the sidecar `.meta.json` Claude writes next to a subagent transcript. */
async function readClaudeSubagentMeta(metaPath: string): Promise<ClaudeSubagentMeta> {
  try {
    const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as AnyRecord;
    return {
      agentType: typeof parsed.agentType === 'string' ? parsed.agentType : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Resolves where a subagent's transcript lives.
 *
 * Current Claude versions write it to
 * `<projectDir>/<providerSessionId>/subagents/agent-<agentId>.jsonl`; older
 * ones dropped it next to the parent transcript. Both are checked, newest
 * layout first, because a project directory usually holds sessions from
 * several CLI versions.
 */
async function findClaudeSubagentTranscript(
  projectDirectory: string,
  providerSessionId: string,
  agentId: string,
): Promise<{ transcriptPath: string; metaPath: string } | null> {
  const candidates = [
    path.join(projectDirectory, providerSessionId, 'subagents', `agent-${agentId}.jsonl`),
    path.join(projectDirectory, `agent-${agentId}.jsonl`),
  ];

  for (const transcriptPath of candidates) {
    try {
      await fsp.access(transcriptPath);
      return { transcriptPath, metaPath: transcriptPath.replace(/\.jsonl$/, '.meta.json') };
    } catch {
      // Try the next layout.
    }
  }

  return null;
}

type ClaudeTaskNotification = {
  /** `uuid` of the transcript row the notification came from, so it can be dropped. */
  sourceUuid: string;
  toolUseId: string;
  status: string;
  summary: string;
  result: string;
};

function readTaggedValue(content: string, tagName: string): string {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`).exec(content);
  return match ? match[1].trim() : '';
}

/**
 * Collects every `<task-notification>` turn keyed by the tool call that
 * spawned the agent it reports on.
 *
 * Only notifications that name a tool-use id are collected: without one there
 * is no card to fold them into, and they must keep rendering on their own.
 */
function collectTaskNotifications(messages: AnyRecord[]): Map<string, ClaudeTaskNotification> {
  const notifications = new Map<string, ClaudeTaskNotification>();

  for (const message of messages) {
    if (message.message?.role !== 'user') {
      continue;
    }

    const content = message.message.content;
    const texts: string[] = typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.filter((part: AnyRecord) => part?.type === 'text').map((part: AnyRecord) => String(part.text ?? ''))
        : [];

    for (const text of texts) {
      if (!text.trimStart().startsWith('<task-notification>')) {
        continue;
      }

      const toolUseId = readTaggedValue(text, 'tool-use-id');
      if (!toolUseId) {
        continue;
      }

      // A resumed agent notifies more than once; the last word wins.
      notifications.set(toolUseId, {
        sourceUuid: String(message.uuid ?? ''),
        toolUseId,
        status: readTaggedValue(text, 'status') || 'completed',
        summary: readTaggedValue(text, 'summary'),
        result: readTaggedValue(text, 'result'),
      });
    }
  }

  return notifications;
}

/** Reads the `tool_use_id` off the tool-result row that launched an agent. */
function readAgentToolUseId(message: AnyRecord): string | null {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
      return part.tool_use_id;
    }
  }

  return null;
}

/** Swaps an agent launch acknowledgement for the agent's actual answer. */
function replaceAgentToolResultContent(message: AnyRecord, replacement: string): void {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return;
  }

  for (const part of content) {
    if (part?.type === 'tool_result') {
      part.content = replacement;
    }
  }
}

/**
 * Reads a Claude transcript's rows as a graph keyed by `uuid`.
 *
 * The file is append-only and every row names its predecessor in `parentUuid`,
 * so a conversation is a path through it rather than the whole file. Editing a
 * sent message makes a second path appear alongside the first.
 */
async function readTranscriptRows(jsonlPath: string, providerSessionId: string): Promise<AnyRecord[]> {
  const rows: AnyRecord[] = [];
  const fileStream = fs.createReadStream(jsonlPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as AnyRecord;
      if (entry.sessionId === providerSessionId) {
        rows.push(entry);
      }
    } catch {
      // A row can be half-written while the CLI is streaming into the file.
    }
  }

  return rows;
}

/** True for a row the user typed, as opposed to a tool result or an injected note. */
function isUserPromptRow(row: AnyRecord): boolean {
  if (row.type !== 'user' || row.isMeta === true || row.isCompactSummary === true || row.isSynthetic === true
    || row.isSidechain === true || row.parent_tool_use_id || row.parentToolUseId) return false;
  const isPromptText = (text: unknown) => typeof text === 'string' && text.trim().length > 0
    && !isInternalContent(text.trimStart()) && !/^<(?:task-notification|local-command-stdout)>/.test(text.trimStart());
  const content = row.message?.content;
  if (Array.isArray(content)) {
    // A tool-result row can carry additional text, but is still not a new user prompt.
    return !content.some((part: AnyRecord) => part?.type === 'tool_result')
      && content.some((part: AnyRecord) => part?.type === 'image' || part?.type === 'text' && isPromptText(part.text));
  }
  return isPromptText(content);
}

/** Attach API response IDs to the exact native user ancestor, without inspecting prompt content for equality.
 * The SDK consumption receipt carries the same API message.id as JSONL assistant rows. Ambiguous
 * or incomplete graphs deliberately provide no binding; a sibling/child response cannot claim a send.
 * This annotates freshly read objects only, never the transcript on disk or its branch selection.
 */
function attachUserResponseIdentities(rows: AnyRecord[]): void {
  const byId = new Map<string, AnyRecord>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (typeof row.uuid !== 'string') continue;
    const prior = byId.get(row.uuid);
    if (prior && (prior.parentUuid !== row.parentUuid || prior.type !== row.type)) ambiguous.add(row.uuid);
    byId.set(row.uuid, row);
  }
  const owners = new Map<string, string | null>();
  const ancestorCache = new Map<string, string | null>();
  const ancestor = (id: string): string | null => {
    const visited = new Set<string>();
    let cursor: unknown = id;
    let owner: string | null = null;
    while (typeof cursor === 'string' && !visited.has(cursor) && !ambiguous.has(cursor)) {
      if (ancestorCache.has(cursor)) { owner = ancestorCache.get(cursor)!; break; }
      visited.add(cursor);
      const row = byId.get(cursor);
      if (!row || row.isSidechain || row.parent_tool_use_id || row.parentToolUseId) break;
      if (isUserPromptRow(row)) { owner = cursor; break; }
      cursor = row.parentUuid;
    }
    for (const visitedId of visited) ancestorCache.set(visitedId, owner);
    return owner;
  };
  for (const row of rows) {
    const responseId = row.type === 'assistant' ? row.message?.id : undefined;
    if (typeof responseId !== 'string' || row.isSidechain || row.parent_tool_use_id || row.parentToolUseId || typeof row.parentUuid !== 'string') continue;
    const owner = ancestor(row.parentUuid);
    if (!owner) continue;
    if (owners.has(responseId) && owners.get(responseId) !== owner) owners.set(responseId, null);
    else if (!owners.has(responseId)) owners.set(responseId, owner);
  }
  const responses = new Map<string, string[]>();
  for (const [responseId, owner] of owners) if (owner) {
    const ids = responses.get(owner) || [];
    if (ids.length < 256) ids.push(responseId);
    responses.set(owner, ids);
  }
  for (const row of rows) if (typeof row.uuid === 'string' && responses.has(row.uuid)) row.cloudcliResponseMessageIds = responses.get(row.uuid);
}

/**
 * Selects edited prompt branches without hiding a later return to an older branch.
 * A new main user prompt is evidence of which saved ancestry the user continued;
 * a late assistant/tool/background row alone must not revive a replaced prompt.
 * No provider transcript or resume mapping is modified: this is a display projection.
 */
function dropSupersededPromptBranches(rows: AnyRecord[]): AnyRecord[] {
  const promptSiblings = new Map<string, Map<string, AnyRecord>>();
  const byUuid = new Map<string, AnyRecord>();
  const children = new Map<string, Set<string>>();
  const ambiguous = new Set<string>();
  let latestPrompt: AnyRecord | undefined;
  for (const row of rows) {
    if (typeof row.uuid !== 'string' || !row.uuid) continue;
    const previous = byUuid.get(row.uuid);
    if (previous && previous.parentUuid !== row.parentUuid) ambiguous.add(row.uuid);
    byUuid.set(row.uuid, row);
    if (typeof row.parentUuid === 'string') {
      if (!children.has(row.parentUuid)) children.set(row.parentUuid, new Set());
      children.get(row.parentUuid)!.add(row.uuid);
    }
    if (!isUserPromptRow(row)) continue;
    // Replayed copies of the same UUID are not new user actions or new siblings.
    if (!previous) latestPrompt = row;
    if (typeof row.parentUuid !== 'string') continue;
    if (!promptSiblings.has(row.parentUuid)) promptSiblings.set(row.parentUuid, new Map());
    promptSiblings.get(row.parentUuid)!.set(row.uuid, row);
  }

  const activeAncestors = new Set<string>();
  let cursor = latestPrompt;
  while (cursor && typeof cursor.uuid === 'string' && !activeAncestors.has(cursor.uuid)) {
    if (ambiguous.has(cursor.uuid)) break;
    activeAncestors.add(cursor.uuid);
    cursor = typeof cursor.parentUuid === 'string' ? byUuid.get(cursor.parentUuid) : undefined;
  }

  const abandoned = new Set<string>();
  for (const group of promptSiblings.values()) {
    const siblings = [...group.values()];
    if (siblings.length < 2 || siblings.some(row => ambiguous.has(row.uuid))) continue;
    const retained = siblings.find(row => activeAncestors.has(row.uuid)) ?? siblings.at(-1)!;
    for (const row of siblings) if (row.uuid !== retained.uuid) abandoned.add(row.uuid);
  }
  // Follow explicit parent links even when a preserved/replayed segment is out of file order.
  const pending = [...abandoned];
  for (let index = 0; index < pending.length; index++) {
    for (const child of children.get(pending[index]) || []) {
      if (!abandoned.has(child) && !activeAncestors.has(child) && !ambiguous.has(child)) {
        abandoned.add(child); pending.push(child);
      }
    }
  }
  return rows.filter(row => typeof row.uuid !== 'string' || !abandoned.has(row.uuid));
}

async function getSessionMessages(
  sessionId: string,
  providerSessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    // The DB row is keyed by the app-facing session id, while the JSONL rows
    // on disk carry the provider-native id — both ids are needed here.
    const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!jsonLPath) {
      return { messages: [], total: 0, hasMore: false };
    }

    const messages = dropSupersededPromptBranches(
      await readTranscriptRows(jsonLPath, providerSessionId),
    );

    attachUserResponseIdentities(messages);

    // An async agent's launch result is internal bookkeeping ("Async agent
    // launched successfully…"); its real answer arrives later as a separate
    // `<task-notification>` turn. Folding the notification back onto the tool
    // call that started the agent keeps one card per agent instead of a card,
    // an unrelated status line, and a stray markdown reply.
    const notificationsByToolUseId = collectTaskNotifications(messages);
    const foldedNotificationUuids = new Set<string>();

    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (!agentId) {
        continue;
      }

      const toolUseId = readAgentToolUseId(message);
      const notification = toolUseId ? notificationsByToolUseId.get(toolUseId) : undefined;
      // This cached projection contains only evidence from the main file.
      // Agent transcript I/O is deferred until its tool call is on the page.
      message.subagent = {
        id: String(agentId),
        description: typeof message.toolUseResult?.description === 'string' ? message.toolUseResult.description : undefined,
        model: typeof message.toolUseResult?.resolvedModel === 'string' ? message.toolUseResult.resolvedModel : undefined,
        status: notification
          ? notification.status === 'completed' ? 'completed' : 'failed'
          : message.toolUseResult?.isAsync === true ? 'running' : 'completed',
      };

      if (notification) {
        replaceAgentToolResultContent(message, notification.result || notification.summary);
        foldedNotificationUuids.add(notification.sourceUuid);
      } else if (message.toolUseResult?.isAsync === true) {
        // Without a notification there is no answer to show, and the launch
        // acknowledgement is internal bookkeeping the user must never read.
        replaceAgentToolResultContent(message, '');
      }
    }

    // readTranscriptRows and the branch filter preserve native append order.
    // Queued prompts retain their creation timestamp even when Claude consumes
    // them after a later-timestamped answer. Sorting by time would move the
    // prompt ahead of its saved parent and change turn boundaries on reload.
    const orderedMessages = messages
      .filter((message) => !foldedNotificationUuids.has(String(message.uuid ?? '')));
    const total = orderedMessages.length;

    if (limit === null) {
      return orderedMessages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = orderedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit,
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 *
 * Skill bodies belong in the first group. When a skill is invoked, Claude
 * injects the entire SKILL.md as a synthetic user turn. Persisted transcripts
 * tag it `isMeta: true`, but the live SDK stream does not, so without a
 * content-level check the same payload renders as a huge user bubble during the
 * run and then vanishes on reload. The skill is already represented by the
 * `Skill` tool call, so it is never user-visible content.
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
  'Base directory for this skill:',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * Claude local-command stdout may contain ANSI styling codes because it was
 * captured from the terminal. The web chat should receive readable plain text.
 */
function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   *
   * Every user turn it produces is stamped with the transcript row's `uuid`,
   * which is the anchor "edit this message" and "fork from here" address. It is
   * applied here rather than at each `createNormalizedMessage` call because the
   * row-shape branches below have several exits, and an anchor missing from one
   * of them would show up as a message the user silently cannot edit.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const messages = this.normalizeMessageRows(rawMessage, sessionId);
    // A synthesized id is useless as an anchor — it changes on every read — so
    // a row without its own uuid produces messages with no anchor at all.
    const raw = readObjectRecord(rawMessage);
    const anchorId = typeof raw?.uuid === 'string' && raw.uuid ? raw.uuid : null;
    if (anchorId) {
      for (const message of messages) {
        if (message.role === 'user') {
          message.transcriptAnchorId = anchorId;
          if (Array.isArray(raw?.cloudcliResponseMessageIds)) message.responseMessageIds = raw.cloudcliResponseMessageIds;
        }
      }
    }

    return messages;
  }

  private normalizeMessageRows(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.type === 'content_block_delta' && raw.delta?.text) {
      return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
    }
    if (raw.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    const taskNotification = readClaudeTaskNotification(raw);
    if (taskNotification) return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
      kind: 'task_notification', ...taskNotification })];
    // The native boundary is the authoritative completion signal, also retained in JSONL history.
    if (raw.type === 'system' && raw.subtype === 'compact_boundary' && !raw.parent_tool_use_id && !raw.isSidechain) {
      return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER,
        kind: 'task_notification', status: 'info', summary: 'Claude compacted this conversation’s context.',
        compactMetadata: raw.compact_metadata ?? raw.compactMetadata })];
    }
    if (raw.type === 'system' && raw.subtype === 'status' && !raw.parent_tool_use_id && !raw.isSidechain) {
      if (raw.status === 'compacting') return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'status', text: 'Compacting context…' })];
      if (raw.compact_result === 'failed') return [createNormalizedMessage({ id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'error', content: typeof raw.compact_error === 'string' ? raw.compact_error : 'Claude could not compact this conversation.' })];
    }

    if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
      if (Array.isArray(raw.message.content)) {
        // Image attachments sent through the SDK are persisted as base64
        // `image` blocks next to the prompt text. Collect them so the UI can
        // render them on the user bubble.
        const imageAttachments: Array<{ data: string }> = [];
        for (const part of raw.message.content) {
          if (part?.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
            const mediaType = typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png';
            imageAttachments.push({ data: `data:${mediaType};base64,${part.source.data}` });
          }
        }
        let imagesAttached = false;
        let filesAttached = false;

        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            const parsedFiles = parseFilesInputTag(text);
            if (
              (parsedFiles.text || parsedFiles.attachments.length > 0)
              && !isInternalContent(parsedFiles.text)
            ) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: parsedFiles.text,
                images: !imagesAttached && imageAttachments.length > 0 ? imageAttachments : undefined,
                files: !filesAttached && parsedFiles.attachments.length > 0
                  ? parsedFiles.attachments
                  : undefined,
              }));
              imagesAttached = true;
              filesAttached = filesAttached || parsedFiles.attachments.length > 0;
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          if (textParts && !isInternalContent(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
              images: imageAttachments.length > 0 ? imageAttachments : undefined,
            }));
            imagesAttached = true;
          }
        }

        // Image-only turns still deserve a user bubble even without text.
        if (!imagesAttached && imageAttachments.length > 0) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_images`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: '',
            images: imageAttachments,
          }));
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return messages;
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          if (displayText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return messages;
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return messages;
        }

        const parsedFiles = parseFilesInputTag(text);
        if (
          (parsedFiles.text || parsedFiles.attachments.length > 0)
          && !isInternalContent(parsedFiles.text)
        ) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: parsedFiles.text,
            files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
          }));
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return messages;
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return messages;
    }

    return messages;
  }

  /**
   * Finds the row to resume *through* so that `anchorId`'s turn is replaced.
   *
   * Walks up the `parentUuid` chain to the nearest assistant row, because the
   * SDK's `resumeSessionAt` is documented against assistant message ids — the
   * user row's immediate parent can be an attachment or an injected note.
   * Returns `null` when nothing precedes the edited prompt, which means the
   * conversation should start over rather than resume.
   */
  async resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null }> {
    const session = sessionsDb.getSessionById(sessionId);
    const jsonlPath = session?.jsonl_path;
    const providerSessionId = session?.provider_session_id;
    if (!jsonlPath || !providerSessionId) {
      return { found: false, resumeThroughId: null };
    }

    const rows = await readTranscriptRows(jsonlPath, providerSessionId);
    const byUuid = new Map<string, AnyRecord>();
    for (const row of rows) {
      if (typeof row.uuid === 'string') {
        byUuid.set(row.uuid, row);
      }
    }

    const target = byUuid.get(anchorId);
    if (!target) {
      return { found: false, resumeThroughId: null };
    }

    const visited = new Set<string>([anchorId]);
    let parentUuid: unknown = target.parentUuid;
    while (typeof parentUuid === 'string' && !visited.has(parentUuid)) {
      visited.add(parentUuid);
      const parent = byUuid.get(parentUuid);
      if (!parent) {
        break;
      }
      if (parent.type === 'assistant') {
        return { found: true, resumeThroughId: parentUuid };
      }
      parentUuid = parent.parentUuid;
    }

    return { found: true, resumeThroughId: null };
  }

  /** Sessions service calls this after pagination; direct history reads use it
   * too. Read only agents actually present on the requested page, with bounded
   * I/O concurrency. Never store child-file activity inside the parent-file cache. */
  async enrichHistoryPage(sessionId: string, messages: NormalizedMessage[], expectedProviderSessionId?: string): Promise<NormalizedMessage[]> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session?.jsonl_path || !session.provider_session_id
      || expectedProviderSessionId && session.provider_session_id !== expectedProviderSessionId) return messages;
    const projectDirectory = path.dirname(session.jsonl_path);
    const providerSessionId = session.provider_session_id;
    const agentIds = [...new Set(messages.flatMap(message => message.subagent?.id ? [message.subagent.id] : []))];
    if (!agentIds.length) return messages;
    const agents = new Map<string, { transcript: ClaudeSubagentTranscript; meta: ClaudeSubagentMeta }>();
    let nextAgent = 0;
    const readNext = async () => {
      while (nextAgent < agentIds.length) {
        const agentId = agentIds[nextAgent++];
        const located = await findClaudeSubagentTranscript(projectDirectory, providerSessionId, agentId);
        if (!located) continue;
        const [transcript, meta] = await Promise.all([
          readClaudeSubagentTranscript(located.transcriptPath),
          readClaudeSubagentMeta(located.metaPath),
        ]);
        agents.set(agentId, { transcript, meta });
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, agentIds.length) }, readNext));
    return messages.map(message => {
      const agent = message.subagent && agents.get(message.subagent.id);
      if (!agent || !message.subagent) return message;
      const { transcript, meta } = agent;
      return {
        ...message,
        subagentTools: transcript.activity.length
          ? transcript.activity.slice(0, MAX_TRANSMITTED_SUBAGENT_ACTIVITIES).map(truncateSubagentActivity)
          : undefined,
        subagent: {
          ...message.subagent,
          name: meta.agentType,
          type: meta.agentType,
          description: meta.description ?? message.subagent.description,
          model: transcript.model ?? message.subagent.model,
          activityCount: transcript.activity.length,
          // A launch acknowledgement alone does not prove completion. A
          // notification or a child transcript ending cleanly does.
          status: message.subagent.status === 'running' && !transcript.endedMidToolCall
            ? 'completed'
            : message.subagent.status,
        },
      };
    });
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

    let result: ClaudeHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getSessionMessages(sessionId, providerSessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              subagent: raw.subagent,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
        msg.subagent = toolResult.subagent;
      }
    }

    // Everything the transcript draws, and nothing else — so a page of N rows
    // is N rows the user sees, and `total` counts the same thing.
    const transcript = prepareTranscriptMessages(normalized);
    const total = transcript.length;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(transcript, normalizedLimit, normalizedOffset);

    return {
      messages: options.deferEnrichment ? page : await this.enrichHistoryPage(sessionId, page, providerSessionId),
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      // Carried on every page, like the Codex and OpenCode readers do, so the
      // composer's counter tracks the conversation instead of being frozen at
      // whatever it was when the session was opened.
      tokenUsage: await claudeUsageService.getSnapshot(sessionId),
    };
  }
}
