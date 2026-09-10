import type { ProviderRuntimeWriter } from '@/shared/index.js';
import { readObjectRecord } from '@/shared/index.js';

type EventRecord = Record<string, unknown>;
type TokenSummary = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
};
type StreamedText = { index: number; message: EventRecord; matched: boolean };

// Keep the shared reader's legacy `any` fields behind an unknown-valued boundary.
const record: (value: unknown) => EventRecord | null = readObjectRecord;

function parseEvent(value: unknown): EventRecord | null {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { return null; }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function tokens(input: number, output: number, cacheRead = 0, cacheCreation = 0): TokenSummary {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation, totalTokens: input + output };
}

function errorText(event: EventRecord): string | null {
  for (const value of [event.content, event.error, event.message, event.result]) {
    if (typeof value === 'string' && value.trim()) return value;
    const nested = record(value);
    if (typeof nested?.message === 'string' && nested.message.trim()) return nested.message;
  }
  return null;
}

/** Used by Agent routes to collect JSON results and observe SSE outcomes without changing wire events. */
export class AgentResponseCollector implements ProviderRuntimeWriter {
  private sessionId: string | null = null;
  private messages: EventRecord[] = [];
  private normalizedPositions = new Map<string, number>();
  private streamed: StreamedText[] = [];
  private activeStream: StreamedText | null = null;
  private failure: string | null = null;
  private terminalFailed = false;
  private legacyTokens = tokens(0, 0);
  private observedTokens: TokenSummary | null = null;

  constructor(public userId: string | number | null = null, private collectMessages = true) {}

  send(data: unknown): void {
    const event = parseEvent(data);
    if (!event) return;
    const sessionId = event.kind === 'session_created' ? event.newSessionId : event.sessionId;
    if (typeof sessionId === 'string' && sessionId) this.sessionId = sessionId;

    if (event.kind === 'complete' || /^(claude|cursor|codex|opencode)-complete$/.test(String(event.type))) {
      this.complete(event);
    } else if (event.kind === 'error' || event.type === 'error'
      || /^(claude|cursor|codex|opencode)-error$/.test(String(event.type))) {
      this.failure = errorText(event) ?? 'The agent run failed.';
    }

    if (event.type === 'claude-response') {
      const native = record(event.data);
      if (native?.type === 'result') {
        this.complete({ ...native, success: native.subtype === 'success' && native.is_error !== true });
      }
      if (native?.type === 'assistant') {
        if (this.collectMessages) this.messages.push(native);
        const usage = record(record(native.message)?.usage);
        if (usage) {
          const cacheRead = count(usage.cache_read_input_tokens);
          const cacheCreation = count(usage.cache_creation_input_tokens);
          this.legacyTokens = tokens(
            this.legacyTokens.inputTokens + count(usage.input_tokens) + cacheRead + cacheCreation,
            this.legacyTokens.outputTokens + count(usage.output_tokens),
            this.legacyTokens.cacheReadTokens + cacheRead,
            this.legacyTokens.cacheCreationTokens + cacheCreation,
          );
        }
      }
      return;
    }

    if (event.kind === 'status' && event.text === 'token_budget') this.observeTokens(event.tokenBudget);
    if (!this.collectMessages || event.role === 'user') return;
    if (event.kind === 'stream_delta' && typeof event.content === 'string') {
      this.appendText(event);
    } else if (event.kind === 'stream_end') {
      this.activeStream = null;
    } else if (event.kind === 'text' && event.role === 'assistant') {
      this.activeStream = null;
      // Claude can send both a streamed block and its durable transcript row.
      // Match within the same native response; identical text in another reply is distinct.
      const candidates = typeof event.responseMessageId === 'string'
        ? this.streamed.filter(stream => !stream.matched
          && stream.message.responseMessageId === event.responseMessageId
          && (typeof event.contentBlockIndex === 'number'
            ? stream.message.contentBlockIndex === event.contentBlockIndex
            : stream.message.content === event.content)) : [];
      if (candidates.length === 1) {
        const stream = candidates[0];
        stream.matched = true;
        this.upsertMessage(event, stream.index);
      } else {
        this.upsertMessage(event);
      }
    } else if (event.kind === 'thinking' || event.kind === 'tool_use') {
      this.activeStream = null;
      this.upsertMessage(event);
    }
  }

  private upsertMessage(event: EventRecord, streamedIndex?: number): void {
    // Codex progress and final snapshots reuse their normalized row id. Replace
    // that row in place; delta ids describe chunks and never enter this index.
    const key = typeof event.id === 'string' && event.id
      ? JSON.stringify([event.provider ?? null, event.sessionId ?? null, event.kind, event.id]) : null;
    const index = (key ? this.normalizedPositions.get(key) : undefined) ?? streamedIndex ?? this.messages.length;
    this.messages[index] = event;
    if (key) this.normalizedPositions.set(key, index);
  }

  private complete(event: EventRecord): void {
    const failed = event.aborted === true || event.success === false || event.is_error === true
      || (typeof event.exitCode === 'number' && event.exitCode !== 0);
    if (failed) {
      this.terminalFailed = true;
      this.failure = errorText(event) ?? this.failure
        ?? (event.aborted === true ? 'The agent run was cancelled.' : 'The agent run failed.');
    } else if (!this.terminalFailed && (event.success === true || event.exitCode === 0)) {
      // Recoverable provider errors may precede a successful terminal result.
      this.failure = null;
    }
    this.activeStream = null;
  }

  private appendText(event: EventRecord): void {
    if (this.activeStream && (this.activeStream.message.responseMessageId !== event.responseMessageId
      || this.activeStream.message.contentBlockIndex !== event.contentBlockIndex)) this.activeStream = null;
    if (!this.activeStream) {
      const message = { ...event, kind: 'text', role: 'assistant', content: '' };
      this.activeStream = { index: this.messages.length, message, matched: false };
      this.messages.push(message);
      this.streamed.push(this.activeStream);
    }
    this.activeStream.message.content = String(this.activeStream.message.content) + event.content;
  }

  private observeTokens(value: unknown): void {
    const budget = record(value);
    if (!budget) return;
    if (budget.schemaVersion === 2 && budget.provider === 'claude') {
      // Session totals include previous runs. Only this execution's model buckets belong here.
      const models = record(record(budget.turn)?.models);
      if (!models) return;
      let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
      for (const model of Object.values(models)) {
        const usage = record(model);
        if (!usage) continue;
        input += count(usage.inputTokens);
        output += count(usage.outputTokens);
        cacheRead += count(usage.cacheReadTokens);
        cacheWrite += count(usage.cacheWriteTokens);
      }
      this.observedTokens = tokens(input + cacheRead + cacheWrite, output, cacheRead, cacheWrite);
    } else if (typeof budget.inputTokens === 'number' || typeof budget.outputTokens === 'number') {
      const breakdown = record(budget.breakdown);
      this.observedTokens = tokens(count(budget.inputTokens), count(budget.outputTokens),
        count(breakdown?.cacheRead), count(breakdown?.cacheCreation));
    }
  }

  setSessionId(sessionId: string): void { this.sessionId = sessionId; }
  getSessionId(): string | null { return this.sessionId; }
  getAssistantMessages(): EventRecord[] { return this.messages; }
  getTotalTokens(): TokenSummary { return this.observedTokens ?? this.legacyTokens; }
  getError(): string | null { return this.failure; }
}
