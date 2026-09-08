import type { ChatMessage, ConversationChangeTurn, ConversationFileChange, ToolResult } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';

type RecordValue = Record<string, unknown>;
type RecordedChange = Pick<ConversationFileChange, 'filePath' | 'operation' | 'oldContent' | 'newContent' | 'patch' | 'contextLabel' | 'lineCountUnavailable'>;
type ToolRecord = {
  identity: string;
  turn: ConversationChangeTurn;
  toolName: string;
  input: unknown;
  result: ToolResult | null | undefined;
  status: unknown;
  streaming: boolean;
  sourceMessageKey: string;
  sourceToolId?: string;
  timestamp: ChatMessage['timestamp'];
  contextLabel?: string;
};

function parseValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): RecordValue {
  const parsed = parseValue(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RecordValue : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value !== 'unknown' && !/[\u0000\r\n]/.test(value);
}

function filePath(input: RecordValue): string | undefined {
  return [input.file_path, input.filePath, input.path].find(validPath);
}

function isUnfinished(status: unknown): boolean {
  return typeof status === 'string' && /^(?:pending|running|in[_ -]?progress|queued|started|streaming|waiting(?:_for_approval)?|cancelled|canceled|denied|rejected|failed|error|aborted|interrupted)$/i.test(status);
}

function hasResultSignal(result: ToolRecord['result']): result is ToolResult {
  return Boolean(result && typeof result === 'object'
    && ('content' in result || 'toolUseResult' in result || typeof result.isError === 'boolean'));
}

function isPending(tool: Omit<ToolRecord, 'turn'>): boolean {
  const pendingStatus = (status: unknown) => typeof status === 'string' && /^(?:pending|running|in[_ -]?progress|queued|started|streaming|waiting(?:_for_approval)?)$/i.test(status);
  return !hasResultSignal(tool.result) || tool.streaming || pendingStatus(tool.status) || pendingStatus(tool.result.status)
    || pendingStatus(asRecord(tool.result.toolUseResult).status);
}

function isSuccessful(tool: ToolRecord): boolean {
  const result = tool.result;
  if (!hasResultSignal(result) || tool.streaming || isUnfinished(tool.status)) return false;
  const metadata = asRecord(result.toolUseResult);
  if (result.isError || result.is_error || result.success === false || metadata.isError || metadata.is_error || metadata.success === false) return false;
  if (isUnfinished(result.status) || isUnfinished(metadata.status)) return false;
  // Some providers return permission failures as plain text without an error flag.
  const content = typeof result.content === 'string' ? result.content.trimStart() : '';
  return !/^(?:<tool_use_error>|(?:error:\s*)?(?:user denied tool use|tool disallowed by settings|permission request (?:timed out|cancelled)|permission denied)|\[request interrupted)/i.test(content);
}

function recordedPatch(metadata: RecordValue): string | undefined {
  const gitDiff = asRecord(metadata.gitDiff);
  if (typeof gitDiff.patch === 'string' && gitDiff.patch.length > 0) return gitDiff.patch;
  if (!Array.isArray(metadata.structuredPatch) || metadata.structuredPatch.length === 0) return undefined;
  const hunks: string[] = [];
  for (const value of metadata.structuredPatch) {
    const hunk = asRecord(value);
    if (![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every((number) => Number.isInteger(number) && Number(number) >= 0)
      || !Array.isArray(hunk.lines) || !hunk.lines.every((line) => typeof line === 'string')) return undefined;
    hunks.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`);
  }
  return hunks.join('\n');
}

/** Parse only complete apply_patch envelopes; retain hunks instead of inventing full file contents. */
function parseApplyPatch(value: unknown): RecordedChange[] {
  if (typeof value !== 'string') return [];
  const lines = value.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') return [];
  const changes: RecordedChange[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[index]);
    if (!header || !validPath(header[2])) return [];
    const start = index++;
    const [, action, path] = header;
    let destination: string | undefined;
    if (lines[index]?.startsWith('*** Move to: ')) {
      destination = lines[index++].slice('*** Move to: '.length);
      if (action !== 'Update' || !validPath(destination)) return [];
    }
    const body: string[] = [];
    while (index < lines.length - 1 && !/^\*\*\* (?:Add|Update|Delete) File: /.test(lines[index])) {
      body.push(lines[index++]);
    }
    if (action === 'Delete' && body.length > 0) return [];
    if (action === 'Add' && !body.every((line) => line.startsWith('+'))) return [];
    if (action === 'Update' && (!body.every((line) => /^(?:[ +\-]|@@|\*\*\* End of File$|$)/.test(line))
      || (!destination && !body.some((line) => /^[+\-]/.test(line))))) return [];
    const patch = ['*** Begin Patch', ...lines.slice(start, index), '*** End Patch'].join('\n');
    if (destination && destination !== path) {
      changes.push({ filePath: path, operation: 'delete', patch, contextLabel: `Moved to ${destination}` });
      changes.push({ filePath: destination, operation: 'patch', patch, contextLabel: `Moved from ${path}` });
    } else {
      changes.push({ filePath: path, operation: action === 'Add' ? 'write' : action === 'Delete' ? 'delete' : 'patch', patch });
    }
  }
  return changes;
}

function extractChanges(tool: ToolRecord): RecordedChange[] {
  if (!isSuccessful(tool)) return [];
  const input = asRecord(tool.input);
  const metadata = asRecord(tool.result?.toolUseResult);
  const name = tool.toolName.toLowerCase();
  const path = filePath(metadata) ?? filePath(input);
  const patchInput = firstString(input.patch, input.patchText, input.input, typeof parseValue(tool.input) === 'string' ? parseValue(tool.input) : undefined);
  if (metadata.userModified !== true && (name === 'apply_patch' || name === 'applypatch' || name === 'edit')) {
    const patches = parseApplyPatch(patchInput);
    if (patches.length > 0) return patches;
  }
  if (!path) return [];
  const patch = recordedPatch(metadata);
  if (name === 'write') {
    // Successful SDK outputs may contain user-adjusted content; those take precedence.
    const newContent = firstString(metadata.content, metadata.userModified === true ? undefined : input.content);
    const oldContent = firstString(metadata.originalFile, metadata.type === 'create' ? '' : undefined);
    if (oldContent !== undefined && oldContent === newContent) return [];
    // A successful Write at a known path is still a recorded file change when
    // compacted/truncated history no longer contains enough content to count it.
    return [{ filePath: path, operation: 'write', oldContent, newContent, patch,
      lineCountUnavailable: oldContent === undefined || newContent === undefined }];
  }
  if (name === 'multiedit') {
    const edits = Array.isArray(metadata.edits) ? metadata.edits : metadata.userModified === true ? undefined : input.edits;
    if (!Array.isArray(edits)) return [{ filePath: path, operation: 'edit', patch, lineCountUnavailable: true }];
    return edits.flatMap((value): RecordedChange[] => {
      const edit = asRecord(value);
      const oldContent = firstString(edit.old_string, edit.oldString);
      const newContent = firstString(edit.new_string, edit.newString);
      if (oldContent === undefined || newContent === undefined) return [{ filePath: path, operation: 'edit', patch, lineCountUnavailable: true }];
      return oldContent !== undefined && newContent !== undefined && oldContent !== newContent
        ? [{ filePath: path, operation: 'edit', oldContent, newContent, lineCountUnavailable: edit.replace_all === true || edit.replaceAll === true }]
        : [];
    });
  }
  if (name === 'edit' || name === 'applypatch' || name === 'apply_patch') {
    const oldContent = firstString(metadata.oldString, metadata.old_string, metadata.userModified === true ? undefined : input.old_string, metadata.userModified === true ? undefined : input.oldString);
    const newContent = firstString(metadata.newString, metadata.new_string, metadata.userModified === true ? undefined : input.new_string, metadata.userModified === true ? undefined : input.newString);
    if (oldContent !== undefined && oldContent === newContent) return [];
    return [{ filePath: path, operation: name === 'edit' ? 'edit' : 'patch', oldContent, newContent, patch,
      lineCountUnavailable: oldContent === undefined || newContent === undefined
        || input.replace_all === true || input.replaceAll === true || metadata.replaceAll === true || metadata.replace_all === true,
    }];
  }
  return [];
}

function isRealUserTurn(message: ChatMessage): boolean {
  return message.type === 'user' && !message.isLocalCommand && !message.isLocalCommandStdout
    && !message.isCompactSummary && !message.isTaskNotification
    && (!message.delivery || message.delivery === 'delivered')
    && !/^\s*<task-notification(?:\s|>)/.test(message.content ?? '');
}

function userTurnIdentities(message: ChatMessage): string[] {
  // Exact native/client identities join an optimistic receipt to its saved
  // echo. Identical text and timestamps alone must never collapse real prompts.
  return [message.transcriptAnchorId, message.clientMessageId, message.id, message.messageId]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

function mergeToolRecord(previous: ToolRecord, incoming: Omit<ToolRecord, 'turn'>): ToolRecord {
  const previousInput = asRecord(previous.input), incomingInput = asRecord(incoming.input);
  const input = Object.keys(previousInput).length || Object.keys(incomingInput).length
    ? { ...previousInput, ...incomingInput }
    : incoming.input ?? previous.input;
  const previousMetadata = asRecord(previous.result?.toolUseResult), incomingMetadata = asRecord(incoming.result?.toolUseResult);
  // A final result can be enriched by a later saved snapshot. Sparse snapshots
  // must not discard the exact arguments and checkpoint metadata already seen.
  const result = incoming.result ? { ...previous.result, ...incoming.result,
    ...(Object.keys(previousMetadata).length || Object.keys(incomingMetadata).length
      ? { toolUseResult: { ...previousMetadata, ...incomingMetadata } } : {}),
  } : previous.result;
  return { ...previous, ...incoming, input, result, turn: previous.turn };
}

function explicitMessageIdentity(message: ChatMessage): string | undefined {
  for (const value of [message.id, message.messageId, message.blobId, message.rowid, message.sequence]) {
    if ((typeof value === 'string' && value.trim()) || typeof value === 'number') return String(value);
  }
  return undefined;
}

/** ChatInterface uses recorded tool results to summarize edits without reading files or interpreting shell commands. */
export function deriveConversationChanges(messages: ChatMessage[]): ConversationChangeTurn[] {
  const turns: ConversationChangeTurn[] = [];
  const tools = new Map<string, ToolRecord>();
  const turnOccurrences = new Map<string, number>();
  const userTurns = new Map<string, ConversationChangeTurn>();
  let currentTurn: ConversationChangeTurn | undefined;
  let earlierTurn: ConversationChangeTurn | undefined;

  messages.forEach((message, messageIndex) => {
    const sourceMessageKey = getIntrinsicMessageKey(message);
    if (isRealUserTurn(message)) {
      const identities = userTurnIdentities(message);
      const existingTurn = identities.map(identity => userTurns.get(identity)).find(Boolean);
      if (existingTurn) {
        identities.forEach(identity => userTurns.set(identity, existingTurn));
        // A late echo of an older prompt does not select that older turn again.
        return;
      }
      const key = identities[0] ?? sourceMessageKey ?? `unidentified-${messageIndex}`;
      const occurrence = turnOccurrences.get(key) ?? 0;
      turnOccurrences.set(key, occurrence + 1);
      const prompt = (message.displayText || message.content || '').replace(/\s+/g, ' ').trim();
      currentTurn = { id: `turn-${key}-${occurrence}`, label: prompt.slice(0, 100) || 'Conversation turn', timestamp: message.timestamp, changes: [] };
      turns.push(currentTurn);
      identities.forEach(identity => userTurns.set(identity, currentTurn!));
    }
    // A missing key cannot be linked truthfully to the rendered conversation.
    if (!sourceMessageKey) return;

    const addTool = (record: Omit<ToolRecord, 'turn'>) => {
      if (!/^(?:edit|write|multiedit|applypatch|apply_patch)$/i.test(record.toolName)) return;
      const previous = tools.get(record.identity);
      if (previous) {
        // Replayed pending arguments must not erase a known result. A later final
        // result can enrich/replace an earlier event without moving its user turn.
        if (!isPending(record) || isPending(previous)) tools.set(record.identity, mergeToolRecord(previous, record));
        return;
      }
      if (!currentTurn) {
        earlierTurn ??= { id: 'turn-earlier-history', label: 'Earlier history', timestamp: record.timestamp, changes: [] };
      }
      tools.set(record.identity, { ...record, turn: currentTurn ?? earlierTurn! });
    };

    const toolId = firstString(message.toolId, message.toolCallId);
    if (message.isToolUse && message.toolName) {
      const messageId = explicitMessageIdentity(message);
      addTool({
        identity: toolId ? `tool-${toolId}` : messageId ? `message-${messageId}` : `occurrence-${messageIndex}`,
        toolName: message.toolName, input: message.toolInput, result: message.toolResult,
        status: message.toolStatus ?? message.status, streaming: Boolean(message.isStreaming), sourceMessageKey,
        sourceToolId: toolId, timestamp: message.timestamp,
      });
    }
    if (message.subagentActivity) {
      const parentInput = asRecord(message.toolInput);
      const contextLabel = firstString(message.subagent?.description, parentInput.description, parentInput.subagent_type) || message.toolName;
      message.subagentActivity.forEach((child, childIndex) => {
        // The unified timeline interleaves prose, reasoning, and tools. Only
        // completed tool records can establish a recorded file modification.
        if (child.kind !== 'tool' || !child.toolName) return;
        addTool({
          identity: child.toolId ? `tool-${child.toolId}` : `child-${messageIndex}-${childIndex}`,
          toolName: child.toolName, input: child.toolInput, result: child.toolResult,
          status: undefined, streaming: false, sourceMessageKey, sourceToolId: child.toolId,
          timestamp: child.timestamp ?? message.timestamp, contextLabel,
        });
      });
    }
  });

  for (const tool of tools.values()) {
    extractChanges(tool).forEach((change, index) => tool.turn.changes.push({
      ...change, id: `change-${tool.identity}-${index}`, sourceMessageKey: tool.sourceMessageKey,
      sourceToolId: tool.sourceToolId, timestamp: tool.timestamp,
      contextLabel: [tool.contextLabel, change.contextLabel].filter(Boolean).join(' · ') || undefined,
    }));
  }
  return earlierTurn?.changes.length ? [earlierTurn, ...turns] : turns;
}
