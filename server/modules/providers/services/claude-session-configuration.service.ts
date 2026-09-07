import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { getDatabasePath, sessionsDb } from '@/modules/database/index.js';
import { AppError, resolveClaudeCodeExecutablePath, resolveClaudePermissionSelection } from '@/shared/index.js';
import type { ClaudeExecutionRecord, ClaudePermissionSelection } from '@/shared/types.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { claudeExecutionRecords } from '@/modules/providers/services/claude-execution-records.js';
import { claudeSettingsFlags, resolveClaudeExecutionSettings } from '@/modules/providers/services/claude-execution-settings.js';

function sessionRow(sessionId: string) {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row || row.provider !== 'claude' || !row.project_path) throw new AppError('This Claude session is unavailable on this remote.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  return row;
}

/** Used by provider routes and both launch surfaces; no CLI is started to read or validate choices. */
export const claudeSessionConfiguration = {
  async read(sessionId: string, executionId?: string) {
    const row = sessionRow(sessionId);
    const record = executionId ? claudeExecutionRecords.get(executionId) : claudeExecutionRecords.latest(sessionId);
    if (record && record.appSessionId !== sessionId) throw new AppError('Execution does not belong to this session.', { code: 'EXECUTION_MISMATCH', statusCode: 409 });
    return { sessionId, providerSessionId: row.provider_session_id, projectPath: row.project_path,
      next: resolveClaudeExecutionSettings(row), execution: record ? { ...record, isLive: claudeExecutionRecords.isExecutionActive(record.executionId) } : null };
  },
  async update(sessionId: string, input: { model: string; effort: string; ultracode: boolean; revision: string }) {
    const row = sessionRow(sessionId);
    const current = resolveClaudeExecutionSettings(row);
    if (input.revision !== current.revision) throw new AppError('The session selection changed. Reload it before saving.', { code: 'SETTINGS_STALE', statusCode: 409 });
    const effort = input.ultracode ? 'ultracode' : input.effort;
    resolveClaudeExecutionSettings({ model: input.model, effort }, await providerModelsService.getProviderModels('claude'));
    if (resolveClaudeExecutionSettings(sessionRow(sessionId)).revision !== input.revision) throw new AppError('The session selection changed. Reload it before saving.', { code: 'SETTINGS_STALE', statusCode: 409 });
    providerModelsService.setSessionModel('claude', sessionId, input.model);
    providerModelsService.setSessionEffort('claude', sessionId, effort);
    return this.read(sessionId);
  },
  async prepare(sessionId: string) {
    const before = sessionRow(sessionId);
    const revision = resolveClaudeExecutionSettings(before).revision;
    const catalog = await providerModelsService.getProviderModels('claude');
    const row = sessionRow(sessionId);
    if (row.provider_session_id !== before.provider_session_id || row.project_path !== before.project_path || resolveClaudeExecutionSettings(row).revision !== revision) {
      throw new AppError('The conversation or settings changed while preparing this execution. Retry from its current state.', { code: 'EXECUTION_PREPARATION_STALE', statusCode: 409 });
    }
    const settings = resolveClaudeExecutionSettings(row, catalog);
    return { row, settings };
  },
  async prepareShell(sessionId: string, provider: string, requestedPath: string, permissions: ClaudePermissionSelection = resolveClaudePermissionSelection()) {
    if (provider !== 'claude') throw new AppError('Session provider mismatch.', { code: 'SESSION_PROVIDER_MISMATCH', statusCode: 409 });
    const { row, settings } = await this.prepare(sessionId);
    if (path.resolve(requestedPath) !== path.resolve(row.project_path!)) throw new AppError('The terminal folder does not match this session.', { code: 'SESSION_PROJECT_MISMATCH', statusCode: 409 });
    if (!row.provider_session_id || !/^[a-zA-Z0-9_.:-]+$/.test(row.provider_session_id)) throw new AppError('This conversation has no resumable Claude session yet. Send its first message in Chat before opening the session terminal.', { code: 'SESSION_NOT_READY', statusCode: 409 });
    const flags = claudeSettingsFlags(settings);
    const executable = resolveClaudeCodeExecutablePath();
    if (!executable) throw new AppError('Configure a Claude CLI executable on this remote before opening its terminal.', { code: 'CLAUDE_CLI_UNAVAILABLE', statusCode: 409 });
    const record: ClaudeExecutionRecord = {
      executionId: randomUUID(), appSessionId: sessionId, providerSessionId: row.provider_session_id,
      surface: 'shell', projectPath: row.project_path!, requested: settings, startedAt: new Date().toISOString(), endedAt: null,
      status: 'running', observed: {},
      permissionRequest: { mode: permissions.mode, allowedRuleCount: permissions.allowedTools.length, deniedRuleCount: permissions.disallowedTools.length },
    };
    if (claudeExecutionRecords.isActive(sessionId, 'chat')) throw new AppError('Claude is still running in Chat. Stop that execution before opening the session terminal.', { code: 'SESSION_BUSY', statusCode: 409 });
    const args = ['--resume', row.provider_session_id];
    if (settings.model !== 'default') args.push('--model', settings.model);
    if (flags.effort) args.push('--effort', flags.effort);
    args.push('--permission-mode', permissions.mode);
    // Session deny flags remain effective even when managed policy ignores all
    // non-managed settings rules. Refuse a rule the CLI tokenizer would split.
    for (const [index, rule] of permissions.disallowedTools.entries()) {
      let inside = false;
      const parts: string[] = [];
      let part = '';
      for (const character of rule) {
        if (character === '(') inside = true;
        else if (character === ')') inside = false;
        if (!inside && (character === ',' || character === ' ')) {
          if (part.trim()) parts.push(part.trim());
          part = '';
        } else part += character;
      }
      if (part.trim()) parts.push(part.trim());
      if (parts.length !== 1 || parts[0] !== rule) throw new AppError(`Saved deny rule ${index + 1} cannot be passed intact to the native Claude terminal. Edit that rule before opening this terminal.`, { code: 'UNSUPPORTED_NATIVE_DENY_RULE', statusCode: 409 });
    }
    if (permissions.disallowedTools.length) args.push('--disallowedTools', ...permissions.disallowedTools);
    const observerPath = fileURLToPath(new URL('./claude-shell-observer.js', import.meta.url));
    const quote = (value: string) => process.platform === 'win32' ? '"' + value.replaceAll('"', '\\"') + '"' : "'" + value.replaceAll("'", "'\\''") + "'";
    const observerCommand = `${quote(process.execPath)} ${quote(observerPath)} ${record.executionId} ${quote(path.resolve(getDatabasePath()))}`;
    const hooks = Object.fromEntries(['SessionStart', 'PostModelSwitch', 'PostToolUse', 'Stop'].map((event) => [event, [{ hooks: [{ type: 'command', command: observerCommand, timeout: 5 }] }]]));
    args.push('--settings', JSON.stringify({ ...flags.settings, hooks, permissions: { allow: permissions.allowedTools, deny: permissions.disallowedTools } }));
    return /\.(?:cjs|mjs|js)$/i.test(executable) ? { executable: process.execPath, args: [executable, ...args], record } : { executable, args, record };
  },
};
