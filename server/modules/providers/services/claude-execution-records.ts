import { claudeExecutionsDb } from '@/modules/database/index.js';
import type { ClaudeExecutionRecord } from '@/shared/types.js';

const activeExecutions = new Map<string, ClaudeExecutionRecord>();

/** Used by runtime, Shell, and provider routes to correlate requested settings with one real remote execution. */
export const claudeExecutionRecords = {
  begin(record: ClaudeExecutionRecord): void {
    if ([...activeExecutions.values()].some((entry) => (entry.appSessionId === record.appSessionId && entry.surface !== record.surface) || ((record.surface === 'shell' || entry.surface === 'shell') && entry.providerSessionId && entry.providerSessionId === record.providerSessionId))) {
      throw new Error('This Claude conversation is already open in the other execution surface. Stop that execution before resuming here.');
    }
    claudeExecutionsDb.save(record);
    activeExecutions.set(record.executionId, record);
  },
  isActive(sessionId: string, surface: 'chat' | 'shell'): boolean {
    return [...activeExecutions.values()].some((entry) => entry.appSessionId === sessionId && entry.surface === surface);
  },
  isExecutionActive(executionId: string): boolean { return activeExecutions.has(executionId); },
  get: claudeExecutionsDb.get,
  latest: claudeExecutionsDb.latest,
  bind(executionId: string, providerSessionId: string): void {
    const bound = claudeExecutionsDb.update(executionId, (record) => {
      if (record.providerSessionId && record.providerSessionId !== providerSessionId) throw new Error('Claude reported a different session identity for this execution.');
      return { ...record, providerSessionId };
    });
    if (bound && activeExecutions.has(executionId)) activeExecutions.set(executionId, bound);
  },
  observe(executionId: string, observation: ClaudeExecutionRecord['observed'], expectedConfiguration?: Pick<ClaudeExecutionRecord['observed'], 'model' | 'effort'>): void {
    // Whitelist again at the persistence boundary: runtime hooks can carry tool
    // contents and full settings can carry credentials. Neither belongs here.
    const safe: ClaudeExecutionRecord['observed'] = {};
    if (typeof observation.model === 'string' && observation.model.length <= 256 && /^[a-zA-Z0-9_./:[\]-]+$/.test(observation.model)) safe.model = observation.model;
    if (observation.effort === null || ['low', 'medium', 'high', 'xhigh', 'max'].includes(observation.effort || '')) safe.effort = observation.effort;
    if (typeof observation.ultracode === 'boolean') safe.ultracode = observation.ultracode;
    if (['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan', 'dontAsk'].includes(observation.permissionMode || '')) safe.permissionMode = observation.permissionMode;
    if (typeof observation.promptId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(observation.promptId)) safe.promptId = observation.promptId;
    if (['response', 'initialization', 'chat-hook', 'shell-hook', 'runtime-applied-settings'].includes(observation.source || '')) safe.source = observation.source;
    if (!('model' in safe) && !('effort' in safe) && !('ultracode' in safe) && !('permissionMode' in safe)) return;
    claudeExecutionsDb.update(executionId, (record) => {
      if (expectedConfiguration && (record.observed.model !== expectedConfiguration.model || record.observed.effort !== expectedConfiguration.effort)) return record;
      const changedConfiguration = ('model' in safe && safe.model !== record.observed.model)
        || ('effort' in safe && safe.effort !== record.observed.effort);
      const observed = { ...record.observed, ...safe, observedAt: new Date().toISOString() };
      // A previous true/false report is not evidence after the model or effort changes.
      if (changedConfiguration && !('ultracode' in safe)) delete observed.ultracode;
      return { ...record, observed };
    });
  },
  finish(executionId: string, failed = false): void {
    activeExecutions.delete(executionId);
    claudeExecutionsDb.update(executionId, (record) => record.endedAt ? record : { ...record, status: failed ? 'failed' : 'completed', endedAt: new Date().toISOString() });
  },
};
