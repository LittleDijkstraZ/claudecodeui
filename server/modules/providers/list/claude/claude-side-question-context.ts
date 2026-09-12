import type { NormalizedMessage } from '@/shared/index.js';

type ContextRow = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  streaming?: boolean;
  toolName?: string;
  input?: string;
  status?: 'running' | 'completed' | 'error';
};

const MAX_CONTEXT_CHARS = 48_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_TOOL_CHARS = 8000;
const MAX_ROWS = 40;
const OMITTED = '[Earlier content omitted]\n';

function boundedText(value: string, limit: number): string {
  return value.length > limit ? OMITTED + value.slice(-(limit - OMITTED.length)) : value;
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return ''; }
}

/** Claude runtime supplements native /btw's cached turn with bounded, visible activity from this same live query. */
export function createClaudeSideQuestionContext(nativeSessionId: () => string | null) {
  const rows: ContextRow[] = [];
  let sequence = 0;

  function trim() {
    while (rows.length > MAX_ROWS || rows.length > 1 && JSON.stringify(rows).length > MAX_CONTEXT_CHARS) rows.shift();
    // JSON escaping can make a single text excerpt larger than its source.
    while (rows.length === 1 && JSON.stringify(rows).length > MAX_CONTEXT_CHARS) {
      rows[0].content = boundedText(rows[0].content, Math.max(256, rows[0].content.length - 1024));
    }
  }

  function observe(message: NormalizedMessage) {
    const expectedSession = nativeSessionId();
    if (message.parentToolUseId || message.subagent || message.isSidechain || message.isSynthetic
      || message.sessionId && expectedSession && message.sessionId !== expectedSession) return;
    const isDeliveredUser = message.kind === 'status' && message.text === 'message_delivery' && message.delivery === 'delivered' && Boolean(message.clientMessageId);
    const isText = message.kind === 'text' && (message.role === 'assistant' || message.role === 'user');
    const isStream = message.kind === 'stream_delta' || message.kind === 'stream_end';
    const isTool = message.kind === 'tool_use' || message.kind === 'tool_result';
    if (!isDeliveredUser && !isText && !isStream && !isTool) return;
    const blockKey = message.responseMessageId && typeof message.contentBlockIndex === 'number'
      ? `assistant:${message.responseMessageId}:${message.contentBlockIndex}` : null;
    const id = (isDeliveredUser ? `user:${message.clientMessageId}` : isTool ? `tool:${message.toolId || message.id}`
      : blockKey ?? message.id ?? `visible-${++sequence}`).slice(0, 500);
    let row = rows.find(item => item.id === id);
    if (message.kind === 'stream_end') {
      if (row) row.streaming = false;
      return;
    }
    const content = textValue(message.content);
    if (!row) {
      row = { id, role: isDeliveredUser ? 'user' : isTool ? 'tool' : message.role === 'user' ? 'user' : 'assistant', content: '' };
      rows.push(row);
    }
    if (isTool) {
      if (message.kind === 'tool_result') {
        // A long tool may finish after newer model text. Its completed output
        // is new activity and must survive eviction of the oldest context.
        rows.splice(rows.indexOf(row), 1); rows.push(row);
      }
      row.toolName = message.toolName?.slice(0, 200) || row.toolName;
      row.status = message.kind === 'tool_use' ? 'running' : message.isError ? 'error' : 'completed';
      if (message.kind === 'tool_use') row.input = boundedText(textValue(message.toolInput), 2000);
      else row.content = boundedText(content, MAX_TOOL_CHARS);
    } else {
      row.content = boundedText(message.kind === 'stream_delta' ? row.content + content : content, MAX_TEXT_CHARS);
      row.streaming = message.kind === 'stream_delta';
    }
    trim();
  }

  return { observe, snapshot: () => rows.length ? JSON.stringify(rows) : '' };
}
