import { addClaudeUsageModels } from '@/shared/index.js';
import type { ClaudeUsageBuckets as Buckets, ClaudeUsageModelCounters as ModelCounters, ClaudeUsageContext as Context, ClaudeUsageTurn as Turn } from '@/shared/index.js';

type RecordValue = Record<string, unknown>;
type RequestCounters = {
  model: string;
  parentToolUseId: string | null;
  counters: Buckets;
  contextCounters: Buckets | null;
  contextIterationCount: number;
  settled: boolean;
};
type AccumulatorState = {
  version: 1;
  executionId: string;
  startedAt: string;
  pipelineCoveredThrough: string | null;
  mainCoveredThrough: string | null;
  context: Context;
  requests: Record<string, RequestCounters>;
  streamRequests: Record<string, string>;
  checkpointModels: Record<string, ModelCounters>;
  checkpointCost: number | null;
  settledModels: Record<string, ModelCounters>;
  settledCost: number;
  unknownCost: boolean;
  turns: Turn[];
  resultIds: string[];
  warnings: string[];
  closed: boolean;
};

const bucketKeys = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const zero = (): Buckets => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
const total = (counters: Buckets): number => bucketKeys.reduce((sum, key) => sum + counters[key], 0);
const unknownModel = (counters: Buckets): ModelCounters => ({ ...counters, estimatedCostUsd: null, costBasis: 'unknown' });

function usageBuckets(value: unknown): Buckets | null {
  const usage = record(value);
  if (!['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].some((key) => finite(usage[key]) !== null)) return null;
  const thinkingTokens = finite(record(usage.output_tokens_details).thinking_tokens);
  return {
    inputTokens: finite(usage.input_tokens) ?? 0,
    cacheReadTokens: finite(usage.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: finite(usage.cache_creation_input_tokens) ?? 0,
    outputTokens: finite(usage.output_tokens) ?? 0,
    ...(thinkingTokens === null ? {} : { thinkingTokens }),
  };
}

function lastContextBuckets(value: unknown): Buckets | null {
  const usage = record(value);
  if (Array.isArray(usage.iterations) && usage.iterations.length) {
    // A server-side loop accumulates its bill at the top level. The final
    // main sampling iteration is the window; advisor/compaction rows are not.
    const lastMainIteration = [...usage.iterations].reverse().find((iteration) => record(iteration).type === 'message');
    return lastMainIteration ? usageBuckets(lastMainIteration) : null;
  }
  return usageBuckets(usage);
}

function readModels(value: unknown): Record<string, ModelCounters> {
  const models: Record<string, ModelCounters> = {};
  for (const [name, raw] of Object.entries(record(value))) {
    const model = record(raw);
    if (!['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].some((key) => finite(model[key]) !== null)) continue;
    // SDK compatibility contract: absent on older builds means list pricing;
    // explicit unknown means the runtime guessed and must not be shown as known.
    const basis = model.costBasis === 'unknown' ? 'unknown' : model.costBasis === 'managed' ? 'managed' : 'list';
    models[name] = {
      inputTokens: finite(model.inputTokens) ?? 0,
      cacheReadTokens: finite(model.cacheReadInputTokens) ?? 0,
      cacheWriteTokens: finite(model.cacheCreationInputTokens) ?? 0,
      outputTokens: finite(model.outputTokens) ?? 0,
      ...(finite(model.thinkingTokens) === null ? {} : { thinkingTokens: finite(model.thinkingTokens)! }),
      estimatedCostUsd: basis === 'unknown' ? null : finite(model.costUSD),
      costBasis: basis,
      ...(finite(model.contextWindow) ? { contextWindow: finite(model.contextWindow)! } : {}),
      ...(text(model.canonicalModel) ? { canonicalModel: text(model.canonicalModel)! } : {}),
    };
  }
  return models;
}


/** Usage service persists this component's state; tests exercise SDK accounting without running Claude. */
export class ClaudeUsageAccumulator {
  private readonly state: AccumulatorState;

  constructor(executionId: string, restored?: unknown, private readonly now: () => string = () => new Date().toISOString()) {
    if (restored !== undefined) {
      const saved = record(restored);
      if (saved.version !== 1 || saved.executionId !== executionId) throw new Error('Unsupported accounting state or execution identity');
      this.state = structuredClone(saved) as AccumulatorState;
      return;
    }
    this.state = {
      version: 1, executionId, startedAt: now(), pipelineCoveredThrough: null, mainCoveredThrough: null,
      context: { usedTokens: null, model: null, capacityTokens: null, compactionWindowTokens: null, measurement: 'unavailable', observedAt: now() },
      requests: {}, streamRequests: {}, checkpointModels: {}, checkpointCost: null,
      settledModels: {}, settledCost: 0, unknownCost: false,
      turns: [], resultIds: [], warnings: [], closed: false,
    };
  }

  private warn(message: string): void {
    if (!this.state.warnings.includes(message)) this.state.warnings.push(message);
  }

  private pendingModels(): Record<string, ModelCounters> {
    const models: Record<string, ModelCounters> = {};
    for (const request of Object.values(this.state.requests)) {
      if (!request.settled) addClaudeUsageModels(models, { [request.model]: unknownModel(request.counters) });
    }
    return models;
  }

  private addTurn(turn: Omit<Turn, 'id'>): void {
    addClaudeUsageModels(this.state.settledModels, turn.models);
    if (turn.estimatedCostUsd === null) {
      this.state.unknownCost = true;
      this.state.settledCost += Object.values(turn.models).reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0);
    } else this.state.settledCost += turn.estimatedCostUsd;
    this.state.turns.push({ id: `${this.state.executionId}:${this.state.turns.length + 1}`, ...turn });
    for (const request of Object.values(this.state.requests)) request.settled = true;
  }

  private acceptRequest(id: string, model: string, parentToolUseId: string | null, rawUsage: unknown): boolean {
    const counters = usageBuckets(rawUsage);
    if (!counters || total(counters) === 0) return false;
    const previous = this.state.requests[id];
    if (previous && (previous.model !== model || previous.parentToolUseId !== parentToolUseId)) {
      this.warn('request-identity-conflict');
      return false;
    }
    const merged = { ...counters };
    if (previous) {
      for (const key of bucketKeys) merged[key] = Math.max(merged[key], previous.counters[key]);
      if (previous.counters.thinkingTokens !== undefined || counters.thinkingTokens !== undefined) merged.thinkingTokens = Math.max(previous.counters.thinkingTokens ?? 0, counters.thinkingTokens ?? 0);
    }
    const iterations = record(rawUsage).iterations;
    const iterationCount = Array.isArray(iterations) ? iterations.length : 0;
    const contextIterationCount = Math.max(iterationCount, previous?.contextIterationCount ?? 0);
    const contextCounters = contextIterationCount === 0 ? merged
      : iterationCount >= contextIterationCount ? lastContextBuckets(rawUsage) : previous?.contextCounters ?? null;
    this.state.requests[id] = { model, parentToolUseId, counters: merged, contextCounters, contextIterationCount, settled: previous?.settled ?? false };
    if (!parentToolUseId && !previous?.settled) {
      const context = contextCounters;
      if (context && total(context) > 0) this.state.context = {
        ...this.state.context, usedTokens: total(context), model,
        ...(this.state.context.model !== model ? { capacityTokens: null, compactionWindowTokens: null } : {}),
        measurement: 'last-request', observedAt: this.now(),
      };
    }
    if (Array.isArray(iterations)) iterations.forEach((iteration, index) => {
      const advisor = record(iteration);
      const advisorModel = text(advisor.model);
      // Advisor tokens are explicitly excluded from top-level API usage.
      // Their stable iteration position deduplicates repeated content frames.
      if (advisor.type === 'advisor_message' && advisorModel) this.acceptRequest(`${id}:advisor:${index}`, advisorModel, `advisor:${id}`, advisor);
    });
    return true;
  }

  /** Runtime reads summary from its existing query; no new process or model/API request is made here. */
  observeContextSummary(value: unknown): boolean {
    const summary = record(value);
    const usedTokens = finite(summary.totalTokens);
    const model = text(summary.model);
    if (usedTokens === null || !model || this.state.closed) return false;
    const actual = Object.entries(this.state.checkpointModels).find(([name, counters]) => name === model || counters.canonicalModel === model)?.[1];
    this.state.context = {
      usedTokens, model,
      capacityTokens: actual?.contextWindow ?? (this.state.context.model === model ? this.state.context.capacityTokens : null),
      compactionWindowTokens: finite(summary.rawMaxTokens),
      measurement: 'sdk-local-estimate', observedAt: this.now(),
    };
    return true;
  }

  /** Runtime hands raw SDK usage events to this reducer before normalization discards provider metadata. */
  observe(value: unknown): boolean {
    if (this.state.closed) return false;
    const event = record(value);
    if (event.type === 'conversation_reset') {
      const pending = this.pendingModels();
      if (Object.keys(pending).length) this.addTurn({ status: 'interrupted', models: pending, estimatedCostUsd: null, coverage: 'observed-requests' });
      this.state.checkpointModels = {};
      this.state.checkpointCost = null;
      this.state.context = { ...this.state.context, usedTokens: null, measurement: 'unavailable', observedAt: this.now() };
      this.state.streamRequests = {};
      return true;
    }
    if (event.type === 'system' && event.subtype === 'compact_boundary') {
      this.state.context = { ...this.state.context, usedTokens: finite(record(event.compact_metadata).post_tokens ?? record(event.compact_metadata).postTokens), measurement: 'post-compact', observedAt: this.now() };
      return true;
    }
    if (event.type === 'result') return this.acceptResult(event);
    const parentToolUseId = text(event.parent_tool_use_id);
    if (event.type === 'assistant') {
      const message = record(event.message);
      const id = text(message.id);
      const model = text(message.model);
      if (!id || !model || model === '<synthetic>') {
        if (usageBuckets(message.usage) && total(usageBuckets(message.usage)!) > 0) this.warn('missing-request-identity');
        return false;
      }
      return this.acceptRequest(id, model, parentToolUseId, message.usage);
    }
    if (event.type !== 'stream_event') return false;
    const stream = record(event.event);
    const streamKey = parentToolUseId ?? '<main>';
    if (stream.type === 'message_start') {
      const message = record(stream.message);
      const id = text(message.id);
      const model = text(message.model);
      if (!id || !model || model === '<synthetic>') return false;
      this.state.streamRequests[streamKey] = id;
      return this.acceptRequest(id, model, parentToolUseId, message.usage);
    }
    if (stream.type === 'message_delta') {
      const id = this.state.streamRequests[streamKey];
      const request = id && this.state.requests[id];
      if (!request) return false;
      const incoming = record(stream.usage);
      // Streaming delta usage may carry only output. Fill omitted fields from
      // this request, never from another agent or from cumulative run totals.
      const merged = { ...incoming,
        input_tokens: finite(incoming.input_tokens) ?? request.counters.inputTokens,
        cache_read_input_tokens: finite(incoming.cache_read_input_tokens) ?? request.counters.cacheReadTokens,
        cache_creation_input_tokens: finite(incoming.cache_creation_input_tokens) ?? request.counters.cacheWriteTokens,
      };
      return this.acceptRequest(id, request.model, request.parentToolUseId, merged);
    }
    return false;
  }

  private acceptResult(event: RecordValue): boolean {
    const id = text(event.uuid);
    if (!id) { this.warn('missing-result-identity'); return false; }
    if (this.state.resultIds.includes(id)) return false;
    this.state.resultIds.push(id);
    const current = readModels(event.modelUsage);
    const status = event.is_error === true ? 'error' : 'complete';
    if (!Object.keys(current).length) {
      const observed = this.pendingModels();
      const mainUsage = usageBuckets(event.usage);
      if (mainUsage && total(mainUsage) > 0) {
        this.state.mainCoveredThrough = this.now();
        // result.usage is main-loop only. Keep child usage already observed,
        // but replace overlapping main requests instead of counting both.
        const mainModels = new Set(Object.values(this.state.requests).filter((request) => !request.settled && !request.parentToolUseId).map((request) => request.model));
        for (const name of Object.keys(observed)) delete observed[name];
        for (const request of Object.values(this.state.requests)) if (!request.settled && request.parentToolUseId) addClaudeUsageModels(observed, { [request.model]: unknownModel(request.counters) });
        const mainModel = mainModels.size === 1 ? [...mainModels][0] : '<unattributed-main>';
        addClaudeUsageModels(observed, { [mainModel]: unknownModel(mainUsage) });
      }
      this.addTurn({ status, models: observed, estimatedCostUsd: null, coverage: 'observed-requests' });
      this.warn('result-model-usage-unavailable');
      return true;
    }
    const regression = Object.entries(current).some(([name, counters]) => {
      const previous = this.state.checkpointModels[name];
      return previous && bucketKeys.some((key) => counters[key] < previous[key]);
    });
    if (regression) {
      // Crash/startup results can be zeroed. An unannounced reset is likewise
      // not evidence that previously spent tokens or money should disappear.
      const observed = this.pendingModels();
      this.addTurn({ status, models: observed, estimatedCostUsd: null, coverage: 'observed-requests' });
      this.warn('query-counter-regressed');
      return true;
    }
    const difference: Record<string, ModelCounters> = {};
    for (const [name, counters] of Object.entries(current)) {
      const previous = this.state.checkpointModels[name];
      const row: ModelCounters = { ...counters };
      for (const key of bucketKeys) row[key] -= previous?.[key] ?? 0;
      if (counters.thinkingTokens !== undefined) row.thinkingTokens = Math.max(0, counters.thinkingTokens - (previous?.thinkingTokens ?? 0));
      row.estimatedCostUsd = counters.estimatedCostUsd === null || previous?.estimatedCostUsd === null
        ? null : Math.max(0, counters.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0));
      difference[name] = row;
      this.state.checkpointModels[name] = counters;
      if (this.state.context.model && (name === this.state.context.model || counters.canonicalModel === this.state.context.model)) {
        this.state.context.capacityTokens = counters.contextWindow ?? this.state.context.capacityTokens;
      }
    }
    const cumulativeCost = finite(event.total_cost_usd);
    const unknownPrice = Object.values(current).some((row) => row.estimatedCostUsd === null);
    const cost = unknownPrice || cumulativeCost === null || (this.state.checkpointCost !== null && cumulativeCost < this.state.checkpointCost)
      ? null : cumulativeCost - (this.state.checkpointCost ?? 0);
    if (cumulativeCost !== null) this.state.checkpointCost = Math.max(this.state.checkpointCost ?? 0, cumulativeCost);
    this.state.pipelineCoveredThrough = this.now();
    this.addTurn({ status, models: difference, estimatedCostUsd: cost, coverage: 'sdk-query-pipeline' });
    return true;
  }

  /** Called from query finalization; a process exit cannot erase partial observed spend. */
  finish(): void {
    if (this.state.closed) return;
    const pending = this.pendingModels();
    if (Object.keys(pending).length) {
      this.addTurn({ status: 'interrupted', models: pending, estimatedCostUsd: null, coverage: 'observed-requests' });
      this.warn('interrupted-usage-partial');
    }
    this.state.closed = true;
  }

  /** Service persists only this numeric/identity state, never raw SDK content or prompts. */
  serialize(): unknown { return structuredClone(this.state); }

  /** Service deduplicates transcript backfill against requests already covered by SDK totals. */
  requestIds(): string[] { return Object.keys(this.state.requests); }

  /** Persisted query coverage reconciles child transcript requests never forwarded to the live SDK client. */
  coveredInterval(subagent: boolean): { start: number; end: number } | null {
    const through = subagent ? this.state.pipelineCoveredThrough : this.state.pipelineCoveredThrough || this.state.mainCoveredThrough;
    const start = Date.parse(this.state.startedAt);
    const end = through ? Date.parse(through) : NaN;
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
  }

  /** History importer stores deduplicated counters without retaining message or tool content. */
  requestUsage() { return Object.entries(this.state.requests).map(([id, request]) => ({ id, model: request.model, counters: { ...request.counters } })); }

  /** Service derives live and REST snapshots from the same state rather than recounting event frames. */
  snapshot() {
    const pending = this.pendingModels();
    const models = structuredClone(this.state.settledModels);
    addClaudeUsageModels(models, pending);
    const hasPending = Object.keys(pending).length > 0;
    const turn: Turn | null = hasPending
      ? { id: `${this.state.executionId}:${this.state.turns.length + 1}`, status: 'running', models: pending, estimatedCostUsd: null, coverage: 'observed-requests' }
      : this.state.turns.at(-1) ?? null;
    return structuredClone({
      executionId: this.state.executionId, context: this.state.context, turn,
      coverage: !hasPending && this.state.turns.length > 0 && this.state.turns.every(item => item.coverage === 'sdk-query-pipeline') ? 'sdk-query-pipeline' as const : 'observed-requests' as const,
      models, estimatedCostUsd: hasPending || this.state.unknownCost ? null : this.state.settledCost,
      knownEstimatedCostUsd: this.state.settledCost,
      provisional: hasPending, warnings: this.state.warnings, closed: this.state.closed,
    });
  }
}
