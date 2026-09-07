import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { ClaudeUsageAccumulator } from '@/modules/claude-usage/claude-usage-accumulator.js';
import { claudeUsageDb, sessionsDb } from '@/modules/database/index.js';
import { addClaudeUsageModels, AppError } from '@/shared/index.js';
import type { ClaudeUsageBuckets, ClaudeUsageContext, ClaudeUsageModelCounters, ClaudeUsageSnapshot } from '@/shared/index.js';

type HistorySource = { id: string; fingerprint: string; events: AsyncIterable<unknown> };
type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
type Dependencies = { history: (session: SessionRow) => Promise<HistorySource[]>; now: () => number };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const emptyContext = (observedAt = new Date().toISOString()): ClaudeUsageContext => ({ usedTokens: null, model: null, capacityTokens: null, compactionWindowTokens: null, measurement: 'unavailable', observedAt });
const emptyBuckets = (): ClaudeUsageBuckets => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
const bucketKeys = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;

async function* readHistory(filePath: string, subagent: boolean): AsyncIterable<unknown> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let event: Record<string, unknown>;
      try { event = record(JSON.parse(line)); } catch { continue; }
      if (event.type === 'assistant') {
        const message = record(event.message);
        // Only numerical usage and public/opaque identities cross the reader boundary.
        yield { type: 'assistant', timestamp: event.timestamp, parent_tool_use_id: subagent || event.isSidechain ? '<history-subagent>' : event.parent_tool_use_id,
          message: { id: message.id, model: message.model, usage: message.usage } };
      } else if (!subagent && event.type === 'system' && event.subtype === 'compact_boundary') {
        yield { type: 'system', subtype: 'compact_boundary', timestamp: event.timestamp, compact_metadata: event.compactMetadata ?? event.compact_metadata };
      }
    }
  } finally { lines.close(); input.destroy(); }
}

async function historySources(session: SessionRow): Promise<HistorySource[]> {
  if (!session.jsonl_path || !session.provider_session_id) return [];
  const sources: HistorySource[] = [];
  const add = async (file: string, subagent: boolean, nativeId = session.provider_session_id, relativeKey = path.basename(file)) => {
    try {
      const info = await stat(file);
      if (!info.isFile()) return;
      sources.push({ id: `${nativeId}:${subagent ? relativeKey : 'main'}`, fingerprint: `${info.size}:${info.mtimeMs}`, events: readHistory(file, subagent) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  await add(session.jsonl_path, false);
  const addChildren = async (root: string, nativeId: string) => {
    const visit = async (directory: string): Promise<void> => {
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await visit(file);
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) await add(file, true, nativeId, path.relative(root, file));
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
    await visit(root);
  };
  await addChildren(path.join(path.dirname(session.jsonl_path), path.basename(session.jsonl_path, '.jsonl'), 'subagents'), session.provider_session_id);
  // Pre-ledger rewinds can retain the old tail as an archived recovery
  // transcript. Count its distinct requests, but never use it as current context.
  for (const recovery of claudeUsageDb.recoveryContexts(session.session_id)) {
    await add(recovery.jsonl_path, true, recovery.provider_session_id);
    await addChildren(path.join(path.dirname(recovery.jsonl_path), path.basename(recovery.jsonl_path, '.jsonl'), 'subagents'), recovery.provider_session_id);
  }
  return sources;
}


/** Providers use one durable source for SDK events, history and REST; session actions preserve it before fork/rewind. */
export function createClaudeUsageService(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = { history: historySources, now: Date.now, ...overrides };
  const active = new Map<string, string>();
  const activeFlushes = new Map<string, { executionId: string; flush: () => void }>();
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(sessionId: string, action: () => Promise<T>): Promise<T> => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    queues.set(sessionId, result);
    void result.finally(() => { if (queues.get(sessionId) === result) queues.delete(sessionId); }).catch(() => {});
    return result;
  };
  function session(sessionId: string): SessionRow {
    const row = sessionsDb.getSessionById(sessionId);
    if (!row || row.provider !== 'claude') throw new AppError('Claude session was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    return row;
  }

  async function importHistory(sessionId: string): Promise<void> {
    const owner = session(sessionId);
    claudeUsageDb.ensure(sessionId, owner.provider_session_id);
    if (active.has(sessionId)) return;
    // A server restart ends only the live estimate; already recorded spend remains.
    for (const execution of claudeUsageDb.executions(sessionId)) {
      const accumulator = new ClaudeUsageAccumulator(execution.execution_id, JSON.parse(execution.state_json));
      if (!accumulator.snapshot().closed) {
        accumulator.finish();
        claudeUsageDb.save(sessionId, execution.execution_id, execution.provider_session_id, accumulator.serialize(), accumulator.requestIds(), null);
      }
    }
    const saved = claudeUsageDb.get(sessionId)!;
    const fingerprints = JSON.parse(saved.history_json) as Record<string, string>;
    const existingRequests = claudeUsageDb.requests(sessionId);
    const known = new Set(existingRequests.map(row => row.request_id));
    const requests: Array<ReturnType<ClaudeUsageAccumulator['requestUsage']>[number] & { kind?: 'external' | 'managed' | 'unattributed' }> = [];
    const existingKinds = new Map(existingRequests.map(row => [row.request_id, row.kind]));
    const settledRuns = claudeUsageDb.executions(sessionId).map(row => ({ nativeId: row.provider_session_id, accumulator: new ClaudeUsageAccumulator(row.execution_id, JSON.parse(row.state_json)) }));
    let context: ClaudeUsageContext | null = saved.native_context_id !== owner.provider_session_id ? emptyContext() : null;
    let changed = context !== null;
    let unavailableHistory = false;
    try {
      const sources = await dependencies.history(owner);
      if (sources.length === 0 && owner.provider_session_id && claudeUsageDb.executions(sessionId).length === 0 && saved.history_coverage !== 'inherited-context') {
        unavailableHistory = true;
        if (!fingerprints.__untracked_history_missing__) changed = true;
        fingerprints.__untracked_history_missing__ = 'unknown';
      }
      for (const source of sources) {
        if (fingerprints[source.id] === source.fingerprint) continue;
        let historyObservedAt = new Date(dependencies.now()).toISOString();
        const accumulator = new ClaudeUsageAccumulator(`history:${source.id}`, undefined, () => historyObservedAt);
        const eventMetadata = new Map<string, { at: number; subagent: boolean }>();
        let lastCompactAt = NaN;
        for await (const event of source.events) {
          const row = record(event); const message = record(row.message);
          if (typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp))) historyObservedAt = row.timestamp;
          if (row.type === 'system' && row.subtype === 'compact_boundary' && typeof row.timestamp === 'string') lastCompactAt = Date.parse(row.timestamp);
          if (row.type === 'assistant' && typeof message.id === 'string') eventMetadata.set(message.id, {
            at: typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN, subagent: Boolean(row.parent_tool_use_id),
          });
          accumulator.observe(event);
        }
        const observed = accumulator.requestUsage();
        const nativeId = source.id.split(':')[0];
        for (const request of observed) {
          let kind: 'external' | 'managed' | 'unattributed' = 'external';
          if (!known.has(request.id) || existingKinds.get(request.id) === 'unattributed') {
            const metadata = eventMetadata.get(request.id) ?? eventMetadata.get(request.id.split(':advisor:')[0]);
            const intervals = settledRuns.filter(run => run.nativeId === nativeId).flatMap(run => {
              const interval = run.accumulator.coveredInterval(Boolean(metadata?.subagent) || request.id.includes(':advisor:'));
              return interval ? [interval] : [];
            });
            if (metadata && Number.isFinite(metadata.at)) {
              if (intervals.some(interval => metadata.at >= interval.start && metadata.at <= interval.end)) kind = 'managed';
            } else if (intervals.length) kind = 'unattributed';
          }
          requests.push({ ...request, kind });
        }
        const latestContext = accumulator.snapshot().context;
        const previousObservedAt = saved.context_json ? Date.parse((JSON.parse(saved.context_json) as ClaudeUsageContext).observedAt) : NaN;
        const newMainRequest = observed.some(request => {
          const metadata = eventMetadata.get(request.id);
          return metadata && !metadata.subagent && !known.has(request.id)
            && (!Number.isFinite(metadata.at) || !Number.isFinite(previousObservedAt) || metadata.at > previousObservedAt);
        });
        // A newly discovered child request cannot replace the main query's
        // newer local summary with an older main sampling row from history.
        if (latestContext.measurement !== 'unavailable' && (!saved.context_json || context !== null || newMainRequest || (Number.isFinite(lastCompactAt) && lastCompactAt > previousObservedAt))) context = latestContext;
        fingerprints[source.id] = source.fingerprint;
        changed = true;
      }
      if (fingerprints.__history_read_unavailable__) { delete fingerprints.__history_read_unavailable__; changed = true; }
    } catch {
      // Optional historical accounting must not make a readable conversation
      // unusable. Keep durable spend and explicitly label missing coverage.
      unavailableHistory = true;
      if (!fingerprints.__history_read_unavailable__) changed = true;
      fingerprints.__history_read_unavailable__ = 'unknown';
    }
    // Nothing above may update a new execution or a newly remapped context after an async read.
    if (active.has(sessionId) || session(sessionId).provider_session_id !== owner.provider_session_id) return;
    if (changed) {
      // The same request can appear in parent and subagent logs; retain maxima
      // across files and prior imports instead of counting each copy.
      const combined = new Map<string, (typeof requests)[number]>();
      for (const row of existingRequests) if (row.kind === 'external' && row.model && row.counters_json) combined.set(row.request_id, { id: row.request_id, model: row.model, counters: JSON.parse(row.counters_json) });
      for (const request of requests) {
        const previous = combined.get(request.id);
        const counters = { ...request.counters };
        if (previous) for (const key of bucketKeys) counters[key] = Math.max(counters[key], previous.counters[key]);
        combined.set(request.id, { ...request, counters });
      }
      claudeUsageDb.history(sessionId, owner.provider_session_id, fingerprints, [...combined.values()], context, unavailableHistory || requests.some(row => !known.has(row.id) && row.kind !== 'managed'));
    }
  }

  function snapshot(sessionId: string): ClaudeUsageSnapshot {
    const owner = session(sessionId);
    const saved = claudeUsageDb.get(sessionId)!;
    const models: Record<string, ClaudeUsageModelCounters> = {};
    const warnings = new Set<string>();
    let knownCost = 0; let unknownCost = false; let provisional = false;
    const historicalState = JSON.parse(saved.history_json) as Record<string, string>;
    if (historicalState.__untracked_history_missing__ || historicalState.__history_read_unavailable__) {
      unknownCost = true; warnings.add('historical-usage-unavailable');
    }
    let turn: ClaudeUsageSnapshot['turn'] = null;
    for (const row of claudeUsageDb.requests(sessionId)) {
      if (row.kind === 'unattributed') { warnings.add('history-request-may-overlap-settled-query'); unknownCost = true; }
      if (row.kind === 'external' && row.model && row.counters_json) {
      addClaudeUsageModels(models, { [row.model]: { ...JSON.parse(row.counters_json) as ClaudeUsageBuckets, estimatedCostUsd: null, costBasis: 'unknown' } });
      unknownCost = true;
      }
    }
    for (const execution of claudeUsageDb.executions(sessionId)) {
      const value = new ClaudeUsageAccumulator(execution.execution_id, JSON.parse(execution.state_json)).snapshot();
      addClaudeUsageModels(models, value.models);
      knownCost += value.knownEstimatedCostUsd;
      unknownCost ||= value.estimatedCostUsd === null;
      provisional ||= !value.closed || value.provisional;
      for (const warning of value.warnings) warnings.add(warning);
      if (execution.execution_id === saved.latest_execution_id) turn = {
        id: execution.execution_id, executionId: execution.execution_id,
        status: value.closed ? value.turn?.status ?? 'interrupted' : 'running',
        models: value.models, estimatedCostUsd: value.estimatedCostUsd, coverage: value.coverage, userMessageCount: value.userMessageCount,
      };
    }
    const tokens = emptyBuckets();
    for (const counters of Object.values(models)) for (const key of bucketKeys) tokens[key] += counters[key];
    if (saved.history_coverage === 'observed-requests') warnings.add('historical-usage-partial-cost-unknown');
    const context = saved.native_context_id === owner.provider_session_id && saved.context_json ? JSON.parse(saved.context_json) as ClaudeUsageContext : emptyContext(saved.updated_at);
    return { schemaVersion: 2, provider: 'claude', sessionId, nativeContextId: owner.provider_session_id,
      revision: saved.revision, updatedAt: saved.updated_at, context, turn,
      session: { models, tokens, estimatedCostUsd: unknownCost ? null : knownCost, knownEstimatedCostUsd: knownCost, provisional, historicalCoverage: saved.history_coverage, warnings: [...warnings] } };
  }

  return {
    async getSnapshot(sessionId: string): Promise<ClaudeUsageSnapshot> {
      return serialize(sessionId, async () => { activeFlushes.get(sessionId)?.flush(); await importHistory(sessionId); return snapshot(sessionId); });
    },
    async beginRun(input: { sessionId: string; executionId: string; providerSessionId: string | null }) {
      return serialize(input.sessionId, async () => {
        await importHistory(input.sessionId);
        const accumulator = new ClaudeUsageAccumulator(input.executionId, undefined, () => new Date(dependencies.now()).toISOString());
        const alreadyCounted = new Set(claudeUsageDb.requests(input.sessionId).map(row => row.request_id));
        let nativeId = input.providerSessionId;
        active.set(input.sessionId, input.executionId);
        claudeUsageDb.begin(input.sessionId, input.executionId, nativeId, accumulator.serialize());
        let lastPersisted = 0;
        let dirty = false;
        let savedContext = JSON.stringify(accumulator.snapshot().context);
        let finished = false;
        const persist = (force: boolean): ClaudeUsageSnapshot | null => {
          if (!force && dependencies.now() - lastPersisted < 200) return null;
          lastPersisted = dependencies.now();
          const context = accumulator.snapshot().context;
          const owner = session(input.sessionId);
          const contextJson = JSON.stringify(context);
          const contextChanged = contextJson !== savedContext;
          claudeUsageDb.save(input.sessionId, input.executionId, nativeId, accumulator.serialize(), accumulator.requestIds(),
            active.get(input.sessionId) === input.executionId && owner.provider_session_id === nativeId && contextChanged ? context : null);
          savedContext = contextJson;
          dirty = false;
          return snapshot(input.sessionId);
        };
        activeFlushes.set(input.sessionId, { executionId: input.executionId, flush: () => { if (dirty) persist(true); } });
        return {
          executionId: input.executionId,
          noteUserMessage(id: string): ClaudeUsageSnapshot | null {
            if (finished || !accumulator.noteUserMessage(id)) return null;
            dirty = true;
            return persist(true);
          },
          bindProviderSessionId(id: string): void {
            if (!nativeId) { nativeId = id; dirty = true; }
            else if (nativeId !== id) throw new Error('Claude usage execution received conflicting native session identities');
          },
          observe(event: unknown): ClaudeUsageSnapshot | null {
            if (finished) return null;
            const envelope = record(event);
            const message = envelope.type === 'assistant' ? record(envelope.message)
              : record(envelope.event).type === 'message_start' ? record(record(envelope.event).message) : {};
            if (typeof message.id === 'string' && alreadyCounted.has(message.id)) return null;
            if (!accumulator.observe(event)) return null;
            dirty = true;
            return persist(record(event).type === 'result' || record(event).type === 'conversation_reset' || record(event).subtype === 'compact_boundary');
          },
          observeContextSummary(summary: unknown): ClaudeUsageSnapshot | null {
            if (finished || !accumulator.observeContextSummary(summary)) return null;
            dirty = true;
            return persist(true);
          },
          snapshot: () => snapshot(input.sessionId),
          finish(): ClaudeUsageSnapshot | null {
            if (finished) return null;
            finished = true; accumulator.finish(); dirty = true;
            const result = persist(true);
            if (active.get(input.sessionId) === input.executionId) active.delete(input.sessionId);
            if (activeFlushes.get(input.sessionId)?.executionId === input.executionId) activeFlushes.delete(input.sessionId);
            return result;
          },
        };
      });
    },
    /** A fork inherits context, not a second bill for its copied prefix. Must follow source accounting capture. */
    async inheritContext(sourceId: string, childId: string): Promise<void> {
      // A saved prefix may include a request still inside the live write throttle.
      // Flush before copying ownership so the child never charges inherited work.
      activeFlushes.get(sourceId)?.flush();
      claudeUsageDb.inherit(sourceId, childId, session(childId).provider_session_id);
      // The next read imports only the new context. No post-fork file read can
      // turn an already-successful branch creation into an ambiguous error.
    },
  };
}

/** Shared by provider live/runtime/history paths and Claude context mutation actions. */
export const claudeUsageService = createClaudeUsageService();
